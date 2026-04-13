import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { validateProjectRoot } from '../filesystem.js';
import { executeFilesystemTool } from '../filesystem-tools.js';
import type {
  ReviewerProvider,
  ReviewCallOptions,
  ReviewCallResult,
  ProviderCapabilities,
  ExhaustionReason,
  TokenUsage,
} from './types.js';
import { estimateCost } from '../pricing.js';

const MAX_INPUT_CHARS = 400_000;
const MAX_TOOL_ROUNDS = 10;
const MAX_RETRIES = 3;
const MAX_REPEAT_CALLS = 3;

const LINKED_PATH_HINT = ' To access a linked root, prefix with "linked:<index>:<path>" (e.g. "linked:0:src/types.ts").';

const FILESYSTEM_TOOLS = [
  {
    type: 'function' as const,
    name: 'read_file',
    description:
      'Read a file from the project being reviewed. Use this to examine type definitions, ' +
      'data models, interfaces, utility functions, and any code you need for thorough review context. ' +
      'Returns file contents as text.' + LINKED_PATH_HINT,
    parameters: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string' as const,
          description: 'Relative path from project root (e.g. "src/types.ts"), or "linked:<index>:<path>" for linked roots',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function' as const,
    name: 'list_directory',
    description:
      'List files and directories at a path in the project. Use this to understand project structure.' + LINKED_PATH_HINT,
    parameters: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string' as const,
          description: 'Relative path from project root. Use "." for project root, or "linked:<index>:<path>" for linked roots.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function' as const,
    name: 'search_in_files',
    description:
      'Search for a pattern across project files. Uses ripgrep when available, falls back to git grep. ' +
      'PREFER this over read_file when you need to find specific symbols, keywords, or patterns. ' +
      'Returns matching lines with file paths and line numbers. ' +
      'Search is restricted to allowed working directories when configured.',
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: 'Search pattern (literal string or regex)' },
        paths: { type: ['array', 'null'] as const, items: { type: 'string' as const }, description: 'Optional: restrict search to these relative paths/directories' },
        glob: { type: ['string', 'null'] as const, description: 'Optional: glob pattern to filter files (e.g. "*.ts", "src/**/*.js")' },
      },
      required: ['query', 'paths', 'glob'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function' as const,
    name: 'read_file_range',
    description: 'Read a specific line range from a file. PREFER this over read_file for large files. Returns numbered lines. Max 200 lines per call.' + LINKED_PATH_HINT,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'Relative path from project root, or "linked:<index>:<path>" for linked roots' },
        start_line: { type: 'number' as const, description: 'First line to read (1-based)' },
        end_line: { type: 'number' as const, description: 'Last line to read (1-based, inclusive)' },
      },
      required: ['path', 'start_line', 'end_line'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function' as const,
    name: 'stat_file',
    description: 'Get file metadata: size, type, and modification time. Use this before read_file to check if a file is too large.' + LINKED_PATH_HINT,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'Relative path from project root, or "linked:<index>:<path>" for linked roots' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function' as const,
    name: 'read_json',
    description: 'Read a JSON file, optionally extracting a value at a JSON pointer path. Use this for package.json, tsconfig.json, etc.' + LINKED_PATH_HINT,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'Relative path to a JSON file, or "linked:<index>:<path>" for linked roots' },
        json_pointer: { type: ['string', 'null'] as const, description: 'Optional: JSON pointer (e.g. "/dependencies", "/scripts/build")' },
      },
      required: ['path', 'json_pointer'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function' as const,
    name: 'list_tracked_files',
    description: 'List git-tracked files, optionally filtered by a directory prefix. Only shows files committed to git.',
    parameters: {
      type: 'object' as const,
      properties: {
        prefix: { type: ['string', 'null'] as const, description: 'Optional: directory prefix to filter (e.g. "src/")' },
      },
      required: ['prefix'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function' as const,
    name: 'get_git_diff',
    description:
      'Get git diff output for the workspace. Use this to see exactly what changed — ' +
      'PREFER this over reading full files when reviewing modifications. ' +
      'Returns unified diff format. Defaults to comparing against HEAD (current workspace changes). Also includes untracked new files.',
    parameters: {
      type: 'object' as const,
      properties: {
        base: { type: ['string', 'null'] as const, description: 'Base ref to diff against (e.g. "HEAD~1", "main", a commit SHA). Defaults to HEAD.' },
        paths: { type: ['array', 'null'] as const, items: { type: 'string' as const }, description: 'Optional: restrict diff to these relative paths' },
      },
      required: ['base', 'paths'],
      additionalProperties: false,
    },
    strict: true,
  },
];

// Guard: strict: true requires every property key to be in required.
// Catches the mistake at module load time, not at OpenAI call time.
for (const tool of FILESYSTEM_TOOLS) {
  if (!('strict' in tool) || !tool.strict) continue;
  const props = Object.keys(tool.parameters.properties);
  const req = new Set(tool.parameters.required);
  const missing = props.filter((k) => !req.has(k));
  if (missing.length > 0) {
    throw new Error(
      `[duul] Tool "${tool.name}" has strict: true but properties [${missing.join(', ')}] are not in required. ` +
      `Use type union with null for optional params.`,
    );
  }
}


function validateInputLength(systemPrompt: string, userMessage: string): void {
  const totalChars = systemPrompt.length + userMessage.length;
  if (totalChars > MAX_INPUT_CHARS) {
    const estimatedTokens = Math.ceil(totalChars / 4);
    const maxTokens = Math.ceil(MAX_INPUT_CHARS / 4);
    throw new Error(
      `Input too large (~${estimatedTokens} estimated tokens, max ~${maxTokens}). ` +
        `Total input: ${totalChars} chars (system: ${systemPrompt.length}, user: ${userMessage.length}). ` +
        `Reduce the size of your input fields — try trimming file_tree, plan, or code content.`,
    );
  }
}

export class OpenAIProvider implements ReviewerProvider {
  readonly name = 'openai';
  readonly capabilities: ProviderCapabilities = {
    structuredOutputs: true,
    toolCalling: true,
    previousResponseId: true,
    jsonSchemaStrict: true,
  };

  private client: OpenAI;
  private model: string;
  private temperature: number;
  private topP: number;

  constructor(config?: { apiKey?: string; baseUrl?: string; model?: string; temperature?: number; topP?: number }) {
    const apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    this.client = new OpenAI({
      apiKey,
      ...(config?.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.model = config?.model ?? process.env.REVIEW_MODEL ?? 'gpt-5.4';
    this.temperature = config?.temperature ?? 0.2;
    this.topP = config?.topP ?? 0.1;
  }

  async review<T extends z.ZodType>(
    options: ReviewCallOptions<T>,
  ): Promise<ReviewCallResult<z.infer<T>>> {
    const { systemPrompt, userMessage, schemaName, outputSchema, workspaceScope, previousReviewId } = options;

    validateInputLength(systemPrompt, userMessage);

    const effectiveRoot = workspaceScope?.root ?? null;
    if (effectiveRoot && !workspaceScope) {
      validateProjectRoot(effectiveRoot);
    }

    const tools = effectiveRoot ? FILESYSTEM_TOOLS : undefined;
    let allUsedTools: string[] = [];

    // Accumulate token usage across all API calls
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let apiCallCount = 0;

    const accumulateUsage = (response: OpenAI.Responses.Response) => {
      apiCallCount++;
      const u = response.usage;
      if (u) {
        totalInputTokens += u.input_tokens ?? 0;
        totalOutputTokens += u.output_tokens ?? 0;
      }
    };

    const buildUsage = (): TokenUsage => ({
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
      api_calls: apiCallCount,
      provider: 'openai',
      model: this.model,
      estimated_cost_usd: estimateCost(this.model, totalInputTokens, totalOutputTokens),
    });

    const baseParams: Record<string, unknown> = {
      model: this.model,
      instructions: systemPrompt,
      temperature: this.temperature,
      top_p: this.topP,
      max_output_tokens: 16384,
      text: { format: zodTextFormat(outputSchema, schemaName) },
      ...(tools ? { tools } : {}),
    };

    let response = await this.apiCallWithRetry({
      ...baseParams,
      input: [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: userMessage }] }],
      ...(previousReviewId ? { previous_response_id: previousReviewId } : {}),
    });

    accumulateUsage(response);
    console.error(`[duul] response.id=${response.id} model=${this.model} provider=openai`);

    // Agentic tool-calling loop
    if (effectiveRoot) {
      const toolReadBudget = MAX_INPUT_CHARS - (systemPrompt.length + userMessage.length);
      let accumulatedToolChars = 0;

      const FULL_READ_TOOLS = new Set(['read_file', 'get_git_diff']);
      const SEARCH_ONLY_TOOLS = new Set(['search_in_files', 'list_tracked_files', 'stat_file']);

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
        const functionCalls = this.getFunctionCalls(response);
        if (functionCalls.length === 0) break;

        const strategyLevel = getStrategyLevel();
        console.error(`[duul] Tool round ${round + 1}: ${functionCalls.length} call(s), budget ${accumulatedToolChars}/${toolReadBudget} (level ${strategyLevel})`);

        const toolResults: Array<{ type: 'function_call_output'; call_id: string; output: string }> = [];

        for (const call of functionCalls) {
          if (call.type !== 'function_call') continue;
          const args = JSON.parse(call.arguments);
          const cacheKey = `${call.name}:${call.arguments}`;
          const argSummary = args.path ?? args.query ?? args.prefix ?? '';

          const count = (callCounts.get(cacheKey) ?? 0) + 1;
          callCounts.set(cacheKey, count);

          if (count > MAX_REPEAT_CALLS) {
            toolResults.push({ type: 'function_call_output' as const, call_id: call.call_id, output: 'You have already read this content multiple times. Use the context you already have to complete your review.' });
            continue;
          }

          if (toolCache.has(cacheKey)) {
            toolResults.push({ type: 'function_call_output' as const, call_id: call.call_id, output: toolCache.get(cacheKey)! });
            continue;
          }

          const currentLevel = getStrategyLevel();
          if (!isToolAllowed(call.name, currentLevel)) {
            toolResults.push({ type: 'function_call_output' as const, call_id: call.call_id, output: budgetMessage(call.name, currentLevel) });
            continue;
          }

          const result = await executeFilesystemTool(effectiveRoot, call.name, args, workspaceScope);
          toolCache.set(cacheKey, result);
          allUsedTools.push(`${call.name}(${argSummary})`);
          accumulatedToolChars += result.length;

          console.error(`[duul]   ${call.name}(${argSummary}) -> ${result.length} chars (total: ${accumulatedToolChars}/${toolReadBudget}, level ${getStrategyLevel()})`);
          toolResults.push({ type: 'function_call_output' as const, call_id: call.call_id, output: result });
        }

        response = await this.apiCallWithRetry({ ...baseParams, previous_response_id: response.id, input: toolResults });
        accumulateUsage(response);
        console.error(`[duul] response.id=${response.id} (after tool round ${round + 1})`);

        if (getStrategyLevel() >= 3 && this.hasPendingFunctionCalls(response)) {
          const stopResults = this.getFunctionCalls(response).filter((c) => c.type === 'function_call').map((c) => ({
            type: 'function_call_output' as const, call_id: c.call_id,
            output: 'No more file reads allowed. You must produce your final review verdict now.',
          }));
          response = await this.apiCallWithRetry({ ...baseParams, previous_response_id: response.id, input: stopResults });
          accumulateUsage(response);
          break;
        }
        if (getStrategyLevel() >= 3) break;
      }

      if (this.hasPendingFunctionCalls(response)) {
        const stopResults = this.getFunctionCalls(response).filter((c) => c.type === 'function_call').map((c) => ({
          type: 'function_call_output' as const, call_id: c.call_id,
          output: 'Tool call limit reached. You must produce your final review verdict now.',
        }));
        response = await this.apiCallWithRetry({ ...baseParams, previous_response_id: response.id, input: stopResults });
        accumulateUsage(response);
      }
    }

    const usage = buildUsage();
    const costStr = usage.estimated_cost_usd !== null ? ` (~$${usage.estimated_cost_usd.toFixed(4)})` : '';
    console.error(`[duul] Token usage: ${usage.input_tokens} in + ${usage.output_tokens} out = ${usage.total_tokens} total (${usage.api_calls} API calls)${costStr}`);

    // Extract structured output
    const parsed = this.extractStructuredOutput(response, outputSchema);
    if (parsed !== null) {
      return { parsed, reviewId: response.id, usage };
    }

    if (options.createFallback) {
      const reason: ExhaustionReason = this.hasPendingFunctionCalls(response) ? 'round_limit' : 'budget';
      const fallback = options.createFallback(reason, allUsedTools);
      console.error(`[duul] Returning structured fallback (reason: ${reason}).`);
      return { parsed: fallback, reviewId: response.id, usage };
    }

    throw new Error('Review failed: could not obtain structured verdict after tool loop.');
  }

  private async apiCallWithRetry(params: Record<string, unknown>): Promise<OpenAI.Responses.Response> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      try {
        const response = await this.client.responses.create(
          { ...params, stream: false } as Parameters<typeof this.client.responses.create>[0],
          { signal: controller.signal },
        ) as OpenAI.Responses.Response;
        clearTimeout(timeout);
        return response;
      } catch (error: unknown) {
        clearTimeout(timeout);
        const isRetryable = error instanceof Error && ('status' in error ? ((error as { status: number }).status === 429 || (error as { status: number }).status >= 500) : error.name === 'AbortError');
        if (isRetryable && attempt < MAX_RETRIES - 1) {
          const delay = 1000 * Math.pow(2, attempt);
          console.error(`[duul] Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw new Error('Unreachable: exhausted retries');
  }

  private extractStructuredOutput<T extends z.ZodType>(response: OpenAI.Responses.Response, outputSchema: T): z.infer<T> | null {
    for (const item of response.output) {
      if (item.type === 'message' && 'content' in item) {
        const msg = item as { type: 'message'; content: Array<{ type: string; text?: string }> };
        for (const content of msg.content) {
          if (content.type === 'output_text' && content.text) {
            return outputSchema.parse(JSON.parse(content.text));
          }
        }
      }
    }
    return null;
  }

  private hasPendingFunctionCalls(response: OpenAI.Responses.Response): boolean {
    return response.output.some((item) => item.type === 'function_call');
  }

  private getFunctionCalls(response: OpenAI.Responses.Response) {
    return response.output.filter((item) => item.type === 'function_call');
  }
}
