import type { z } from 'zod';
import { validateProjectRoot } from '../filesystem.js';
import { executeFilesystemTool } from '../filesystem-tools.js';
import type {
  ReviewerProvider,
  ReviewCallOptions,
  ReviewCallResult,
  ProviderCapabilities,
  ConversationTurn,
  TokenUsage,
} from './types.js';
import { estimateCost } from '../pricing.js';

const MAX_INPUT_CHARS = 400_000;
const MAX_TOOL_ROUNDS = 10;
const MAX_RETRIES = 3;
const MAX_REPEAT_CALLS = 3;

const LINKED_PATH_HINT = ' To access a linked root, prefix with "linked:<index>:<path>" (e.g. "linked:0:src/types.ts").';

/**
 * Anthropic tool definitions in Claude Messages API format.
 */
const ANTHROPIC_TOOLS = [
  {
    name: 'read_file',
    description:
      'Read a file from the project being reviewed. Use this to examine type definitions, ' +
      'data models, interfaces, utility functions, and any code you need for thorough review context. ' +
      'Returns file contents as text.' + LINKED_PATH_HINT,
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'Relative path from project root, or "linked:<index>:<path>" for linked roots' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at a path in the project. Use this to understand project structure.' + LINKED_PATH_HINT,
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'Relative path from project root. Use "." for project root, or "linked:<index>:<path>" for linked roots.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_in_files',
    description:
      'Search for a pattern across project files. Uses ripgrep when available, falls back to git grep. ' +
      'PREFER this over read_file when you need to find specific symbols, keywords, or patterns. ' +
      'Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: 'Search pattern (literal string or regex)' },
        paths: { type: 'array' as const, items: { type: 'string' as const }, description: 'Optional: restrict search to these relative paths/directories' },
        glob: { type: 'string' as const, description: 'Optional: glob pattern to filter files (e.g. "*.ts", "src/**/*.js")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file_range',
    description: 'Read a specific line range from a file. PREFER this over read_file for large files. Returns numbered lines. Max 200 lines per call.' + LINKED_PATH_HINT,
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'Relative path from project root, or "linked:<index>:<path>" for linked roots' },
        start_line: { type: 'number' as const, description: 'First line to read (1-based)' },
        end_line: { type: 'number' as const, description: 'Last line to read (1-based, inclusive)' },
      },
      required: ['path', 'start_line', 'end_line'],
    },
  },
  {
    name: 'stat_file',
    description: 'Get file metadata: size, type, and modification time. Use this before read_file to check if a file is too large.' + LINKED_PATH_HINT,
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'Relative path from project root, or "linked:<index>:<path>" for linked roots' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_json',
    description: 'Read a JSON file, optionally extracting a value at a JSON pointer path. Use this for package.json, tsconfig.json, etc.' + LINKED_PATH_HINT,
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'Relative path to a JSON file, or "linked:<index>:<path>" for linked roots' },
        json_pointer: { type: 'string' as const, description: 'Optional: JSON pointer (e.g. "/dependencies", "/scripts/build")' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_tracked_files',
    description: 'List git-tracked files, optionally filtered by a directory prefix. Only shows files committed to git.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prefix: { type: 'string' as const, description: 'Optional: directory prefix to filter (e.g. "src/")' },
      },
      required: [],
    },
  },
  {
    name: 'get_git_diff',
    description:
      'Get git diff output for the workspace. Use this to see exactly what changed — ' +
      'PREFER this over reading full files when reviewing modifications. ' +
      'Returns unified diff format. Defaults to comparing against HEAD (current workspace changes). Also includes untracked new files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        base: { type: 'string' as const, description: 'Base ref to diff against (e.g. "HEAD~1", "main", a commit SHA). Defaults to HEAD.' },
        paths: { type: 'array' as const, items: { type: 'string' as const }, description: 'Optional: restrict diff to these relative paths' },
      },
      required: [],
    },
  },
];

const FULL_READ_TOOLS = new Set(['read_file', 'get_git_diff']);
const SEARCH_ONLY_TOOLS = new Set(['search_in_files', 'list_tracked_files', 'stat_file']);

// Anthropic content block types
interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string }
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface AnthropicResponse {
  id: string;
  model: string;
  stop_reason: string;
  content: ContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic provider — uses Claude models via the Anthropic Messages API.
 *
 * Capabilities:
 * - Tool calling via native Anthropic tools parameter
 * - Conversation history for simulated context persistence across rounds
 * - No native structured outputs (uses JSON prompt + zod validation)
 */
export class AnthropicProvider implements ReviewerProvider {
  readonly name = 'anthropic';
  readonly capabilities: ProviderCapabilities = {
    structuredOutputs: false,
    toolCalling: true,
    previousResponseId: true, // simulated via conversation history
    jsonSchemaStrict: false,
  };

  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private topP: number;

  constructor(config?: { apiKey?: string; baseUrl?: string; model?: string; temperature?: number; topP?: number }) {
    const apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    }
    this.apiKey = apiKey;
    this.baseUrl = config?.baseUrl ?? 'https://api.anthropic.com';
    this.model = config?.model ?? 'claude-opus-4-20250514';
    this.temperature = config?.temperature ?? 0.2;
    this.topP = config?.topP ?? 0.1;
  }

  async review<T extends z.ZodType>(
    options: ReviewCallOptions<T>,
  ): Promise<ReviewCallResult<z.infer<T>>> {
    const { systemPrompt, userMessage, outputSchema, workspaceScope, conversationHistory } = options;

    const effectiveRoot = workspaceScope?.root ?? null;
    if (effectiveRoot && !workspaceScope) {
      validateProjectRoot(effectiveRoot);
    }

    // Append JSON schema instruction to system prompt
    const schemaJson = JSON.stringify(zodToJsonSchema(outputSchema), null, 2);
    const enhancedSystem = `${systemPrompt}\n\n## Output Format\nYou MUST respond with ONLY a valid JSON object matching this schema. No markdown, no explanation, no code blocks — only the JSON object.\n\n${schemaJson}`;

    const tools = effectiveRoot ? ANTHROPIC_TOOLS : undefined;
    let allUsedTools: string[] = [];

    // Accumulate token usage across all API calls
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let apiCallCount = 0;

    const accumulateUsage = (body: AnthropicResponse) => {
      apiCallCount++;
      if (body.usage) {
        totalInputTokens += body.usage.input_tokens ?? 0;
        totalOutputTokens += body.usage.output_tokens ?? 0;
      }
    };

    const buildUsage = (): TokenUsage => ({
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
      api_calls: apiCallCount,
      provider: 'anthropic',
      model: this.model,
      estimated_cost_usd: estimateCost(this.model, totalInputTokens, totalOutputTokens),
    });

    // Build messages array with optional conversation history
    const messages: AnthropicMessage[] = [];
    if (conversationHistory?.length) {
      for (const turn of conversationHistory) {
        messages.push({ role: turn.role, content: turn.content as string | ContentBlock[] });
      }
    }
    messages.push({ role: 'user', content: userMessage });

    // Track conversation turns for storage
    const conversationTurns: ConversationTurn[] = [
      ...(conversationHistory ?? []),
      { role: 'user' as const, content: userMessage },
    ];

    let body = await this.apiCallWithRetry(enhancedSystem, messages, tools);
    accumulateUsage(body);
    console.error(`[duul] response.id=${body.id} model=${this.model} provider=anthropic`);

    // Store assistant response
    conversationTurns.push({ role: 'assistant' as const, content: body.content });

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
        if (level >= 3) return 'Budget exhausted. You must produce your final review verdict now with the context you already have.';
        if (level >= 2) return `[Budget Level 2] Only search/stat tools allowed. "${toolName}" blocked.`;
        if (level >= 1) return `[Budget Level 1] Full file reads blocked. "${toolName}" not allowed. Use read_file_range or search_in_files.`;
        return '';
      };

      const toolCache = new Map<string, string>();
      const callCounts = new Map<string, number>();

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const toolUses = body.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
        if (toolUses.length === 0 || body.stop_reason !== 'tool_use') break;

        const strategyLevel = getStrategyLevel();
        console.error(`[duul] Tool round ${round + 1}: ${toolUses.length} call(s), budget ${accumulatedToolChars}/${toolReadBudget} (level ${strategyLevel})`);

        const toolResults: ToolResultBlock[] = [];

        for (const call of toolUses) {
          const args = call.input;
          const cacheKey = `${call.name}:${JSON.stringify(args)}`;
          const argSummary = (args.path ?? args.query ?? args.prefix ?? '') as string;

          const count = (callCounts.get(cacheKey) ?? 0) + 1;
          callCounts.set(cacheKey, count);

          if (count > MAX_REPEAT_CALLS) {
            toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: 'You have already read this content multiple times. Use the context you already have to complete your review.' });
            continue;
          }

          if (toolCache.has(cacheKey)) {
            toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: toolCache.get(cacheKey)! });
            continue;
          }

          const currentLevel = getStrategyLevel();
          if (!isToolAllowed(call.name, currentLevel)) {
            toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: budgetMessage(call.name, currentLevel) });
            continue;
          }

          const result = await executeFilesystemTool(effectiveRoot, call.name, args, workspaceScope);
          toolCache.set(cacheKey, result);
          allUsedTools.push(`${call.name}(${argSummary})`);
          accumulatedToolChars += result.length;

          console.error(`[duul]   ${call.name}(${argSummary}) -> ${result.length} chars (total: ${accumulatedToolChars}/${toolReadBudget}, level ${getStrategyLevel()})`);
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: result });
        }

        // Append tool results as a user message
        messages.push({ role: 'assistant', content: body.content });
        messages.push({ role: 'user', content: toolResults });
        conversationTurns.push({ role: 'user' as const, content: toolResults });

        body = await this.apiCallWithRetry(enhancedSystem, messages, tools);
        accumulateUsage(body);
        conversationTurns.push({ role: 'assistant' as const, content: body.content });
        console.error(`[duul] response.id=${body.id} (after tool round ${round + 1})`);

        // Force verdict if budget exhausted
        if (getStrategyLevel() >= 3) {
          const pendingTools = body.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
          if (pendingTools.length > 0) {
            const stopResults: ToolResultBlock[] = pendingTools.map((c) => ({
              type: 'tool_result' as const,
              tool_use_id: c.id,
              content: 'No more file reads allowed. You must produce your final review verdict now.',
            }));
            messages.push({ role: 'assistant', content: body.content });
            messages.push({ role: 'user', content: stopResults });
            body = await this.apiCallWithRetry(enhancedSystem, messages, tools);
            accumulateUsage(body);
            conversationTurns.push({ role: 'user' as const, content: stopResults });
            conversationTurns.push({ role: 'assistant' as const, content: body.content });
          }
          break;
        }
      }

      // Handle pending tool calls after loop exhaustion
      const pendingTools = body.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (pendingTools.length > 0 && body.stop_reason === 'tool_use') {
        const stopResults: ToolResultBlock[] = pendingTools.map((c) => ({
          type: 'tool_result' as const,
          tool_use_id: c.id,
          content: 'Tool call limit reached. You must produce your final review verdict now.',
        }));
        messages.push({ role: 'assistant', content: body.content });
        messages.push({ role: 'user', content: stopResults });
        body = await this.apiCallWithRetry(enhancedSystem, messages, tools);
        accumulateUsage(body);
        conversationTurns.push({ role: 'user' as const, content: stopResults });
        conversationTurns.push({ role: 'assistant' as const, content: body.content });
      }
    }

    const usage = buildUsage();
    const costStr = usage.estimated_cost_usd !== null ? ` (~$${usage.estimated_cost_usd.toFixed(4)})` : '';
    console.error(`[duul] Token usage: ${usage.input_tokens} in + ${usage.output_tokens} out = ${usage.total_tokens} total (${usage.api_calls} API calls)${costStr}`);

    // Extract text content and parse JSON
    const text = body.content.find((c): c is TextBlock => c.type === 'text')?.text;
    if (!text) {
      if (options.createFallback) {
        const reason = body.stop_reason === 'tool_use' ? 'round_limit' as const : 'budget' as const;
        const fallback = options.createFallback(reason, allUsedTools);
        console.error(`[duul] Returning structured fallback (reason: ${reason}).`);
        return { parsed: fallback, reviewId: body.id, usage, conversationTurns };
      }
      throw new Error('Anthropic returned no text content');
    }

    const jsonStr = extractJson(text);
    const parsed = outputSchema.parse(JSON.parse(jsonStr));
    return { parsed, reviewId: body.id, usage, conversationTurns };
  }

  private async apiCallWithRetry(
    system: string,
    messages: AnthropicMessage[],
    tools?: typeof ANTHROPIC_TOOLS,
  ): Promise<AnthropicResponse> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);

      try {
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: 16384,
            temperature: this.temperature,
            top_p: this.topP,
            system,
            messages,
            ...(tools ? { tools } : {}),
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const status = response.status;
          if ((status === 429 || status >= 500) && attempt < MAX_RETRIES - 1) {
            const delay = 1000 * Math.pow(2, attempt);
            console.error(`[duul] Anthropic retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (status ${status})`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw new Error(`Anthropic API error: ${status} ${response.statusText}`);
        }

        return await response.json() as AnthropicResponse;
      } catch (error: unknown) {
        clearTimeout(timeout);
        if (attempt < MAX_RETRIES - 1 && error instanceof Error && error.name === 'AbortError') {
          const delay = 1000 * Math.pow(2, attempt);
          console.error(`[duul] Anthropic retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (timeout)`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }

    throw new Error('Unreachable: exhausted retries');
  }
}

/**
 * Minimal zod-to-JSON-schema conversion for the output format instruction.
 */
function zodToJsonSchema(schema: z.ZodType): unknown {
  if ('_def' in schema && typeof schema._def === 'object') {
    const def = schema._def as { typeName?: string; shape?: () => Record<string, unknown> };
    if (def.typeName === 'ZodObject' && def.shape) {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape)) {
        const zodField = value as { _def?: { description?: string; typeName?: string } };
        properties[key] = { description: zodField._def?.description ?? key };
      }
      return { type: 'object', properties };
    }
  }
  return { type: 'object', description: 'See system prompt for schema details' };
}

/**
 * Extract JSON from a string that may contain markdown code blocks.
 */
function extractJson(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  return text.trim();
}
