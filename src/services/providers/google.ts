import type { z } from 'zod';
import { validateProjectRoot } from '../filesystem.js';
import { executeFilesystemTool } from '../filesystem-tools.js';
import type {
  ReviewerProvider,
  ReviewCallOptions,
  ReviewCallResult,
  ProviderCapabilities,
  TokenUsage,
} from './types.js';
import { estimateCost } from '../pricing.js';

const MAX_INPUT_CHARS = 400_000;
const MAX_TOOL_ROUNDS = 10;
const MAX_RETRIES = 3;
const MAX_REPEAT_CALLS = 3;

const LINKED_PATH_HINT = ' To access a linked root, prefix with "linked:<index>:<path>" (e.g. "linked:0:src/types.ts").';

/**
 * Google/Gemini tool definitions using functionDeclarations format.
 */
const GOOGLE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'read_file',
        description:
          'Read a file from the project being reviewed. Use this to examine type definitions, ' +
          'data models, interfaces, utility functions, and any code you need for thorough review context. ' +
          'Returns file contents as text.' + LINKED_PATH_HINT,
        parameters: {
          type: 'OBJECT' as const,
          properties: { path: { type: 'STRING' as const, description: 'Relative path from project root, or "linked:<index>:<path>" for linked roots' } },
          required: ['path'],
        },
      },
      {
        name: 'list_directory',
        description: 'List files and directories at a path in the project. Use this to understand project structure.' + LINKED_PATH_HINT,
        parameters: {
          type: 'OBJECT' as const,
          properties: { path: { type: 'STRING' as const, description: 'Relative path from project root. Use "." for root.' } },
          required: ['path'],
        },
      },
      {
        name: 'search_in_files',
        description:
          'Search for a pattern across project files. Uses ripgrep when available, falls back to git grep. ' +
          'PREFER this over read_file when you need to find specific symbols, keywords, or patterns.',
        parameters: {
          type: 'OBJECT' as const,
          properties: {
            query: { type: 'STRING' as const, description: 'Search pattern (literal string or regex)' },
            paths: { type: 'ARRAY' as const, items: { type: 'STRING' as const }, description: 'Optional: restrict search to these relative paths' },
            glob: { type: 'STRING' as const, description: 'Optional: glob pattern to filter files' },
          },
          required: ['query'],
        },
      },
      {
        name: 'read_file_range',
        description: 'Read a specific line range from a file. PREFER this over read_file for large files. Max 200 lines per call.' + LINKED_PATH_HINT,
        parameters: {
          type: 'OBJECT' as const,
          properties: {
            path: { type: 'STRING' as const, description: 'Relative path from project root' },
            start_line: { type: 'NUMBER' as const, description: 'First line to read (1-based)' },
            end_line: { type: 'NUMBER' as const, description: 'Last line to read (1-based, inclusive)' },
          },
          required: ['path', 'start_line', 'end_line'],
        },
      },
      {
        name: 'stat_file',
        description: 'Get file metadata: size, type, and modification time.' + LINKED_PATH_HINT,
        parameters: {
          type: 'OBJECT' as const,
          properties: { path: { type: 'STRING' as const, description: 'Relative path from project root' } },
          required: ['path'],
        },
      },
      {
        name: 'read_json',
        description: 'Read a JSON file, optionally extracting a value at a JSON pointer path.' + LINKED_PATH_HINT,
        parameters: {
          type: 'OBJECT' as const,
          properties: {
            path: { type: 'STRING' as const, description: 'Relative path to a JSON file' },
            json_pointer: { type: 'STRING' as const, description: 'Optional: JSON pointer (e.g. "/dependencies")' },
          },
          required: ['path'],
        },
      },
      {
        name: 'list_tracked_files',
        description: 'List git-tracked files, optionally filtered by a directory prefix.',
        parameters: {
          type: 'OBJECT' as const,
          properties: { prefix: { type: 'STRING' as const, description: 'Optional: directory prefix to filter' } },
          required: [],
        },
      },
      {
        name: 'get_git_diff',
        description:
          'Get git diff output for the workspace. Use this to see exactly what changed — ' +
          'PREFER this over reading full files when reviewing modifications. ' +
          'Returns unified diff format. Defaults to comparing against HEAD (current workspace changes). Also includes untracked new files.',
        parameters: {
          type: 'OBJECT' as const,
          properties: {
            base: { type: 'STRING' as const, description: 'Base ref to diff against. Defaults to HEAD.' },
            paths: { type: 'ARRAY' as const, items: { type: 'STRING' as const }, description: 'Optional: restrict diff to these relative paths' },
          },
          required: [],
        },
      },
    ],
  },
];

const FULL_READ_TOOLS = new Set(['read_file', 'get_git_diff']);
const SEARCH_ONLY_TOOLS = new Set(['search_in_files', 'list_tracked_files', 'stat_file']);

// Gemini types
interface FunctionCallPart { functionCall: { name: string; args: Record<string, unknown> | null } }
interface FunctionResponsePart { functionResponse: { name: string; response: { output: string } } }
interface TextPart { text: string }
type GeminiPart = TextPart | FunctionCallPart | FunctionResponsePart;

interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Google provider — uses Gemini models via the Generative Language API.
 *
 * Capabilities:
 * - Tool calling via native functionDeclarations
 * - JSON mode (responseMimeType: "application/json") when no tools active
 * - No previous_response_id
 */
export class GoogleProvider implements ReviewerProvider {
  readonly name = 'google';
  readonly capabilities: ProviderCapabilities = {
    structuredOutputs: false,
    toolCalling: true,
    previousResponseId: false,
    jsonSchemaStrict: false,
  };

  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private topP: number;

  constructor(config?: { apiKey?: string; baseUrl?: string; model?: string; temperature?: number; topP?: number }) {
    const apiKey = config?.apiKey ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY environment variable is not set');
    }
    this.apiKey = apiKey;
    this.baseUrl = config?.baseUrl ?? 'https://generativelanguage.googleapis.com';
    this.model = config?.model ?? 'gemini-3.1-pro-preview';
    this.temperature = config?.temperature ?? 0.2;
    this.topP = config?.topP ?? 0.1;
  }

  async review<T extends z.ZodType>(
    options: ReviewCallOptions<T>,
  ): Promise<ReviewCallResult<z.infer<T>>> {
    const { systemPrompt, userMessage, outputSchema, workspaceScope } = options;

    const effectiveRoot = workspaceScope?.root ?? null;
    if (effectiveRoot && !workspaceScope) {
      validateProjectRoot(effectiveRoot);
    }

    const enhancedSystem = `${systemPrompt}\n\n## Output Format\nYou MUST respond with ONLY a valid JSON object. No markdown, no explanation, no code blocks — only the JSON object.`;

    const tools = effectiveRoot ? GOOGLE_TOOLS : undefined;
    let allUsedTools: string[] = [];

    // Accumulate token usage
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let apiCallCount = 0;

    const accumulateUsage = (body: GeminiResponse) => {
      apiCallCount++;
      if (body.usageMetadata) {
        totalInputTokens += body.usageMetadata.promptTokenCount ?? 0;
        totalOutputTokens += body.usageMetadata.candidatesTokenCount ?? 0;
      }
    };

    const buildUsage = (): TokenUsage => ({
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
      api_calls: apiCallCount,
      provider: 'google',
      model: this.model,
      estimated_cost_usd: estimateCost(this.model, totalInputTokens, totalOutputTokens),
    });

    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: userMessage }] },
    ];

    let body = await this.apiCallWithRetry(enhancedSystem, contents, tools);
    accumulateUsage(body);
    console.error(`[duul] Gemini response received, model=${this.model} provider=google`);

    // Agentic tool-calling loop
    if (effectiveRoot) {
      const toolReadBudget = MAX_INPUT_CHARS - (enhancedSystem.length + userMessage.length);
      let accumulatedToolChars = 0;

      const getStrategyLevel = (): number => {
        const ratio = accumulatedToolChars / toolReadBudget;
        if (ratio < 0.5) return 0;
        if (ratio < 0.8) return 1;
        if (ratio < 1.0) return 2;
        return 3;
      };

      const isToolAllowed = (toolName: string, level: number): boolean => {
        if (level >= 3) return false;
        if (level >= 2) return SEARCH_ONLY_TOOLS.has(toolName);
        if (level >= 1) return !FULL_READ_TOOLS.has(toolName);
        return true;
      };

      const budgetMessage = (toolName: string, level: number): string => {
        if (level >= 3) return 'Budget exhausted. You must produce your final review verdict now.';
        if (level >= 2) return `[Budget Level 2] Only search/stat tools allowed. "${toolName}" blocked.`;
        if (level >= 1) return `[Budget Level 1] Full file reads blocked. "${toolName}" not allowed.`;
        return '';
      };

      const toolCache = new Map<string, string>();
      const callCounts = new Map<string, number>();

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const parts = body.candidates?.[0]?.content?.parts ?? [];
        const functionCalls = parts.filter((p): p is FunctionCallPart => 'functionCall' in p);
        if (functionCalls.length === 0) break;

        const strategyLevel = getStrategyLevel();
        console.error(`[duul] Tool round ${round + 1}: ${functionCalls.length} call(s), budget ${accumulatedToolChars}/${toolReadBudget} (level ${strategyLevel})`);

        // Append model's function call parts
        contents.push({ role: 'model', parts: parts });

        const responseParts: FunctionResponsePart[] = [];

        for (const call of functionCalls) {
          const { name, args: rawArgs } = call.functionCall;
          const args = rawArgs ?? {};
          const cacheKey = `${name}:${JSON.stringify(args)}`;
          const argSummary = (args.path ?? args.query ?? args.prefix ?? '') as string;

          const count = (callCounts.get(cacheKey) ?? 0) + 1;
          callCounts.set(cacheKey, count);

          if (count > MAX_REPEAT_CALLS) {
            responseParts.push({ functionResponse: { name, response: { output: 'You have already read this content multiple times. Use the context you have.' } } });
            continue;
          }

          if (toolCache.has(cacheKey)) {
            responseParts.push({ functionResponse: { name, response: { output: toolCache.get(cacheKey)! } } });
            continue;
          }

          const currentLevel = getStrategyLevel();
          if (!isToolAllowed(name, currentLevel)) {
            responseParts.push({ functionResponse: { name, response: { output: budgetMessage(name, currentLevel) } } });
            continue;
          }

          const result = await executeFilesystemTool(effectiveRoot, name, args, workspaceScope);
          toolCache.set(cacheKey, result);
          allUsedTools.push(`${name}(${argSummary})`);
          accumulatedToolChars += result.length;

          console.error(`[duul]   ${name}(${argSummary}) -> ${result.length} chars (total: ${accumulatedToolChars}/${toolReadBudget}, level ${getStrategyLevel()})`);
          responseParts.push({ functionResponse: { name, response: { output: result } } });
        }

        contents.push({ role: 'user', parts: responseParts });

        body = await this.apiCallWithRetry(enhancedSystem, contents, tools);
        accumulateUsage(body);
        console.error(`[duul] Gemini response (after tool round ${round + 1})`);

        // Force verdict if budget exhausted
        if (getStrategyLevel() >= 3) {
          const pendingParts = (body.candidates?.[0]?.content?.parts ?? []).filter((p): p is FunctionCallPart => 'functionCall' in p);
          if (pendingParts.length > 0) {
            contents.push({ role: 'model', parts: body.candidates?.[0]?.content?.parts ?? [] });
            const stopParts: FunctionResponsePart[] = pendingParts.map((p) => ({
              functionResponse: { name: p.functionCall.name, response: { output: 'No more file reads allowed. Produce your final verdict now.' } },
            }));
            contents.push({ role: 'user', parts: stopParts });
            body = await this.apiCallWithRetry(enhancedSystem, contents, tools);
            accumulateUsage(body);
          }
          break;
        }
      }

      // Handle pending tool calls after loop exhaustion
      const pendingParts = (body.candidates?.[0]?.content?.parts ?? []).filter((p): p is FunctionCallPart => 'functionCall' in p);
      if (pendingParts.length > 0) {
        contents.push({ role: 'model', parts: body.candidates?.[0]?.content?.parts ?? [] });
        const stopParts: FunctionResponsePart[] = pendingParts.map((p) => ({
          functionResponse: { name: p.functionCall.name, response: { output: 'Tool call limit reached. Produce your final verdict now.' } },
        }));
        contents.push({ role: 'user', parts: stopParts });
        body = await this.apiCallWithRetry(enhancedSystem, contents, tools);
        accumulateUsage(body);
      }
    }

    const usage = buildUsage();
    const costStr = usage.estimated_cost_usd !== null ? ` (~$${usage.estimated_cost_usd.toFixed(4)})` : '';
    console.error(`[duul] Token usage: ${usage.input_tokens} in + ${usage.output_tokens} out = ${usage.total_tokens} total (${usage.api_calls} API calls)${costStr}`);

    // Extract text content and parse JSON
    const textPart = (body.candidates?.[0]?.content?.parts ?? []).find((p): p is TextPart => 'text' in p);
    if (!textPart?.text) {
      if (options.createFallback) {
        const reason = 'budget' as const;
        const fallback = options.createFallback(reason, allUsedTools);
        console.error(`[duul] Returning structured fallback (reason: ${reason}).`);
        const reviewId = `google-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return { parsed: fallback, reviewId, usage };
      }
      throw new Error('Google returned no text content');
    }

    const jsonStr = extractJson(textPart.text);
    const parsed = outputSchema.parse(JSON.parse(jsonStr));
    const reviewId = `google-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return { parsed, reviewId, usage };
  }

  private async apiCallWithRetry(
    system: string,
    contents: GeminiContent[],
    tools?: typeof GOOGLE_TOOLS,
  ): Promise<GeminiResponse> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);

      try {
        const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents,
            generationConfig: {
              temperature: this.temperature,
              topP: this.topP,
              maxOutputTokens: 16384,
              // Only use JSON mode when no tools are active (tools produce function calls, not JSON)
              ...(tools ? {} : { responseMimeType: 'application/json' }),
            },
            ...(tools ? { tools } : {}),
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const status = response.status;
          if ((status === 429 || status >= 500) && attempt < MAX_RETRIES - 1) {
            const delay = 1000 * Math.pow(2, attempt);
            console.error(`[duul] Google retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (status ${status})`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw new Error(`Google API error: ${status} ${response.statusText}`);
        }

        return await response.json() as GeminiResponse;
      } catch (error: unknown) {
        clearTimeout(timeout);
        if (attempt < MAX_RETRIES - 1 && error instanceof Error && error.name === 'AbortError') {
          const delay = 1000 * Math.pow(2, attempt);
          console.error(`[duul] Google retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (timeout)`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }

    throw new Error('Unreachable: exhausted retries');
  }
}

function extractJson(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  return text.trim();
}
