import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { validateProjectRoot } from '../filesystem.js';
import { CHATGPT_BASE_URL } from './codex-auth.js';
import { executeFilesystemTool, createReviewerByteBudget } from '../filesystem-tools.js';
import type {
  ReviewerProvider,
  ReviewCallOptions,
  ReviewCallResult,
  ProviderCapabilities,
  ExhaustionReason,
  TokenUsage,
  ConversationTurn,
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

/**
 * ChatGPT-login (Codex CLI) credentials. When present the provider talks to the
 * ChatGPT backend Responses endpoint with a bearer token instead of an API key.
 */
export interface ChatgptAuth {
  accessToken: string;
  accountId: string;
  /** Rotate the token (e.g. after a 401). Returns a fresh access token. */
  refresh?: () => Promise<string>;
}

export class OpenAIProvider implements ReviewerProvider {
  readonly name = 'openai';
  readonly capabilities: ProviderCapabilities;

  private client: OpenAI;
  private model: string;
  private temperature: number;
  private topP: number;

  /**
   * ChatGPT-backend mode. The endpoint is stateless (`store: false`): it does
   * not support `previous_response_id`, `temperature`/`top_p`, or
   * `max_output_tokens`, and it streams. We resend the full input each turn.
   */
  private readonly stateless: boolean;
  private readonly baseURL?: string;
  private readonly defaultHeaders?: Record<string, string>;
  private readonly refresh?: () => Promise<string>;
  private readonly reasoningEffort: string;

  constructor(config?: { apiKey?: string; baseUrl?: string; model?: string; temperature?: number; topP?: number; chatgpt?: ChatgptAuth }) {
    const chatgpt = config?.chatgpt;
    this.stateless = !!chatgpt;
    this.refresh = chatgpt?.refresh;
    this.reasoningEffort = process.env.DUUL_REASONING_EFFORT ?? 'medium';

    const apiKey = chatgpt?.accessToken ?? config?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'No OpenAI credential found. Set OPENAI_API_KEY, or sign in with the Codex CLI (`codex login`).',
      );
    }

    this.baseURL = chatgpt ? CHATGPT_BASE_URL : config?.baseUrl;
    this.defaultHeaders = chatgpt
      ? { 'chatgpt-account-id': chatgpt.accountId, originator: 'codex_cli_rs', 'session-id': randomUUID() }
      : undefined;
    this.client = this.buildClient(apiKey);

    this.model = config?.model ?? process.env.REVIEW_MODEL ?? 'gpt-5.4';
    this.temperature = config?.temperature ?? 0.2;
    this.topP = config?.topP ?? 0.1;
    this.capabilities = {
      structuredOutputs: true,
      toolCalling: true,
      // Both modes support cross-round continuity: api-key mode natively via
      // previous_response_id, ChatGPT mode by replaying conversation turns.
      previousResponseId: true,
      // ChatGPT backend is stateless — continuity comes from turn replay.
      conversationReplay: this.stateless,
      jsonSchemaStrict: true,
    };
  }

  private buildClient(apiKey: string): OpenAI {
    return new OpenAI({
      apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      ...(this.defaultHeaders ? { defaultHeaders: this.defaultHeaders } : {}),
    });
  }

  async review<T extends z.ZodType>(
    options: ReviewCallOptions<T>,
  ): Promise<ReviewCallResult<z.infer<T>>> {
    const { systemPrompt, userMessage, schemaName, outputSchema, workspaceScope, previousReviewId, conversationHistory } = options;

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
    let totalCachedInputTokens = 0;
    let apiCallCount = 0;

    const accumulateUsage = (response: OpenAI.Responses.Response) => {
      apiCallCount++;
      const u = response.usage;
      if (u) {
        totalInputTokens += u.input_tokens ?? 0;
        totalOutputTokens += u.output_tokens ?? 0;
        totalCachedInputTokens += u.input_tokens_details?.cached_tokens ?? 0;
      }
    };

    const buildUsage = (): TokenUsage => ({
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
      api_calls: apiCallCount,
      provider: 'openai',
      model: this.model,
      estimated_cost_usd: estimateCost(this.model, totalInputTokens, totalOutputTokens, totalCachedInputTokens),
      ...(totalCachedInputTokens > 0 ? { cached_input_tokens: totalCachedInputTokens } : {}),
    });

    const baseParams: Record<string, unknown> = {
      model: this.model,
      instructions: systemPrompt,
      text: { format: zodTextFormat(outputSchema, schemaName) },
      ...(tools ? { tools } : {}),
      ...(this.stateless
        ? {
            // ChatGPT backend: stateless, reasoning-only sampling, encrypted
            // reasoning must be echoed back on each turn (store: false).
            store: false,
            reasoning: { effort: this.reasoningEffort },
            include: ['reasoning.encrypted_content'],
          }
        : {
            temperature: this.temperature,
            top_p: this.topP,
            max_output_tokens: 16384,
          }),
    };

    // Stateless (ChatGPT backend): accumulate the full input across tool rounds
    // since there is no server-side `previous_response_id` chaining. Prior rounds
    // are replayed as message items (user: input_text, assistant: output_text).
    const inputItems: unknown[] = [];
    if (this.stateless && conversationHistory?.length) {
      inputItems.push(...(conversationHistory as unknown[]));
    }
    inputItems.push({ role: 'user' as const, content: [{ type: 'input_text' as const, text: userMessage }] });

    let response = this.stateless
      ? await this.apiCallWithRetry({ ...baseParams, input: inputItems })
      : await this.apiCallWithRetry({
          ...baseParams,
          input: inputItems,
          ...(previousReviewId ? { previous_response_id: previousReviewId } : {}),
        });

    accumulateUsage(response);
    console.error(`[duul] response.id=${response.id} model=${this.model} provider=openai`);

    // Continue the conversation after a tool round. Stateless mode resends the
    // whole input (prior assistant output items + the new tool outputs); chained
    // mode uses server-side previous_response_id and sends only the new items.
    const continueConversation = async (newItems: unknown[]): Promise<OpenAI.Responses.Response> => {
      if (this.stateless) {
        inputItems.push(...response.output, ...newItems);
        return this.apiCallWithRetry({ ...baseParams, input: inputItems });
      }
      return this.apiCallWithRetry({ ...baseParams, previous_response_id: response.id, input: newItems });
    };

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
      const byteBudget = createReviewerByteBudget();

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

          const result = await executeFilesystemTool(effectiveRoot, call.name, args, workspaceScope, byteBudget);
          toolCache.set(cacheKey, result);
          allUsedTools.push(`${call.name}(${argSummary})`);
          accumulatedToolChars += result.length;

          console.error(`[duul]   ${call.name}(${argSummary}) -> ${result.length} chars (total: ${accumulatedToolChars}/${toolReadBudget}, level ${getStrategyLevel()})`);
          toolResults.push({ type: 'function_call_output' as const, call_id: call.call_id, output: result });
        }

        response = await continueConversation(toolResults);
        accumulateUsage(response);
        console.error(`[duul] response.id=${response.id} (after tool round ${round + 1})`);

        if (getStrategyLevel() >= 3 && this.hasPendingFunctionCalls(response)) {
          const stopResults = this.getFunctionCalls(response).filter((c) => c.type === 'function_call').map((c) => ({
            type: 'function_call_output' as const, call_id: c.call_id,
            output: 'No more file reads allowed. You must produce your final review verdict now.',
          }));
          response = await continueConversation(stopResults);
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
        response = await continueConversation(stopResults);
        accumulateUsage(response);
      }
    }

    const usage = buildUsage();
    const costStr = usage.estimated_cost_usd !== null ? ` (~$${usage.estimated_cost_usd.toFixed(4)})` : '';
    const cachedStr = usage.cached_input_tokens ? ` [cached: ${usage.cached_input_tokens}]` : '';
    console.error(`[duul] Token usage: ${usage.input_tokens} in + ${usage.output_tokens} out = ${usage.total_tokens} total (${usage.api_calls} API calls)${cachedStr}${costStr}`);

    // Stateless mode: record this round's user/assistant turns so the reviewer
    // can replay them next round (the ChatGPT backend has no native chaining).
    // Only the final Q&A is kept — replaying every tool call would bloat tokens
    // and risks stale encrypted-reasoning items across separate responses.
    const buildTurns = (assistantText: string): ConversationTurn[] | undefined =>
      this.stateless
        ? [
            ...(conversationHistory ?? []),
            { role: 'user' as const, content: [{ type: 'input_text', text: userMessage }] },
            { role: 'assistant' as const, content: [{ type: 'output_text', text: assistantText }] },
          ]
        : undefined;

    // Extract structured output
    const outputText = this.getOutputText(response);
    const parsed = this.extractStructuredOutput(response, outputSchema);
    if (parsed !== null) {
      return { parsed, reviewId: response.id, usage, conversationTurns: buildTurns(outputText ?? '') };
    }

    if (options.createFallback) {
      const reason: ExhaustionReason = this.hasPendingFunctionCalls(response) ? 'round_limit' : 'budget';
      const fallback = options.createFallback(reason, allUsedTools);
      console.error(`[duul] Returning structured fallback (reason: ${reason}).`);
      return { parsed: fallback, reviewId: response.id, usage, conversationTurns: buildTurns(outputText ?? JSON.stringify(fallback)) };
    }

    throw new Error('Review failed: could not obtain structured verdict after tool loop.');
  }

  private async apiCallWithRetry(params: Record<string, unknown>): Promise<OpenAI.Responses.Response> {
    let refreshedOnce = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      try {
        let response: OpenAI.Responses.Response;
        if (this.stateless) {
          // ChatGPT backend requires streaming and leaves `response.completed`'s
          // `output` empty — aggregate items from the streamed events instead.
          const stream = this.client.responses.stream(
            params as Parameters<typeof this.client.responses.stream>[0],
            { signal: controller.signal },
          );
          response = await this.aggregateStream(stream);
        } else {
          response = (await this.client.responses.create(
            { ...params, stream: false } as Parameters<typeof this.client.responses.create>[0],
            { signal: controller.signal },
          )) as OpenAI.Responses.Response;
        }
        clearTimeout(timeout);
        return response;
      } catch (error: unknown) {
        clearTimeout(timeout);
        const status = error instanceof Error && 'status' in error ? (error as { status: number }).status : undefined;

        // ChatGPT token expired mid-review: refresh once and retry immediately.
        if (status === 401 && this.refresh && !refreshedOnce) {
          refreshedOnce = true;
          try {
            const token = await this.refresh();
            this.client = this.buildClient(token);
            console.error('[duul] Refreshed Codex token after 401, retrying');
            attempt--; // don't consume a retry for the refresh
            continue;
          } catch (refreshError) {
            console.error(`[duul] Codex token refresh failed: ${refreshError instanceof Error ? refreshError.message : refreshError}`);
          }
        }

        const isRetryable = error instanceof Error && (status !== undefined ? (status === 429 || status >= 500) : error.name === 'AbortError');
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

  /**
   * Aggregate a streamed Responses call into a Response object.
   *
   * The ChatGPT backend delivers completed output items via
   * `response.output_item.done` events and returns an EMPTY `output` array on
   * `response.completed`, so we collect items from the stream ourselves. Usage
   * and id come from `response.completed` (falling back to `response.created`).
   */
  private async aggregateStream(
    stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
  ): Promise<OpenAI.Responses.Response> {
    const output: OpenAI.Responses.ResponseOutputItem[] = [];
    let id = '';
    let usage: OpenAI.Responses.ResponseUsage | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case 'response.created':
          id = event.response.id;
          break;
        case 'response.output_item.done':
          output.push(event.item);
          break;
        case 'response.completed':
          id = event.response.id ?? id;
          usage = event.response.usage;
          break;
        case 'response.failed':
          throw new Error(`ChatGPT backend response failed: ${event.response.error?.message ?? 'unknown error'}`);
        case 'error':
          throw new Error(`ChatGPT backend stream error: ${event.message ?? 'unknown error'}`);
        default:
          break;
      }
    }

    return { id, output, usage } as unknown as OpenAI.Responses.Response;
  }

  /** Return the first output_text string in the response, or null. */
  private getOutputText(response: OpenAI.Responses.Response): string | null {
    for (const item of response.output) {
      if (item.type === 'message' && 'content' in item) {
        const msg = item as { content: Array<{ type: string; text?: string }> };
        for (const content of msg.content) {
          if (content.type === 'output_text' && content.text) return content.text;
        }
      }
    }
    return null;
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
