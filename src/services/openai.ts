import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { readProjectFile, listProjectDirectory, validateProjectRoot } from './filesystem.js';

const MAX_INPUT_CHARS = 400_000;
const MAX_TOOL_ROUNDS = 10;
const MAX_RETRIES = 3;
const MAX_REPEAT_CALLS = 3; // same tool+args repeated this many times → short-circuit

let clientInstance: OpenAI | null = null;

function getClient(): OpenAI {
  if (!clientInstance) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    clientInstance = new OpenAI({ apiKey });
  }
  return clientInstance;
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

const FILESYSTEM_TOOLS = [
  {
    type: 'function' as const,
    name: 'read_file',
    description:
      'Read a file from the project being reviewed. Use this to examine type definitions, ' +
      'data models, interfaces, utility functions, and any code you need for thorough review context. ' +
      'Returns file contents as text.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string' as const,
          description: 'Relative path from project root (e.g. "src/types.ts", "package.json")',
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
      'List files and directories at a path in the project. Use this to understand project structure.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string' as const,
          description: 'Relative path from project root. Use "." for project root.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  },
];

async function executeFilesystemTool(
  projectRoot: string,
  toolName: string,
  args: Record<string, string>,
): Promise<string> {
  try {
    switch (toolName) {
      case 'read_file':
        return await readProjectFile(projectRoot, args.path);
      case 'list_directory':
        return await listProjectDirectory(projectRoot, args.path);
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function apiCallWithRetry(
  client: OpenAI,
  params: Record<string, unknown>,
): Promise<OpenAI.Responses.Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await client.responses.create(
        { ...params, stream: false } as Parameters<typeof client.responses.create>[0],
        { signal: controller.signal },
      ) as OpenAI.Responses.Response;
      clearTimeout(timeout);
      return response;
    } catch (error: unknown) {
      clearTimeout(timeout);

      const isRetryable =
        error instanceof Error &&
        ('status' in error
          ? (error as { status: number }).status === 429 ||
            (error as { status: number }).status >= 500
          : error.name === 'AbortError');

      if (isRetryable && attempt < MAX_RETRIES - 1) {
        const delay = 1000 * Math.pow(2, attempt);
        console.error(
          `[peer-reviewer] Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }

  throw new Error('Unreachable: exhausted retries');
}

function extractStructuredOutput<T extends z.ZodType>(
  response: OpenAI.Responses.Response,
  outputSchema: T,
): z.infer<T> | null {
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

function hasPendingFunctionCalls(response: OpenAI.Responses.Response): boolean {
  return response.output.some((item) => item.type === 'function_call');
}

function getFunctionCalls(response: OpenAI.Responses.Response) {
  return response.output.filter((item) => item.type === 'function_call');
}

interface CodexReviewOptions<T extends z.ZodType> {
  systemPrompt: string;
  userMessage: string;
  schemaName: string;
  outputSchema: T;
  projectRoot?: string;
  previousReviewId?: string;
}

interface CodexReviewResult<T> {
  parsed: T;
  reviewId: string;
}

export async function callCodexReview<T extends z.ZodType>(
  options: CodexReviewOptions<T>,
): Promise<CodexReviewResult<z.infer<T>>> {
  const { systemPrompt, userMessage, schemaName, outputSchema, projectRoot, previousReviewId } = options;

  validateInputLength(systemPrompt, userMessage);

  if (projectRoot) {
    validateProjectRoot(projectRoot);
  }

  const client = getClient();
  const model = process.env.REVIEW_MODEL ?? 'gpt-5.4';
  const tools = projectRoot ? FILESYSTEM_TOOLS : undefined;

  const baseParams: Record<string, unknown> = {
    model,
    instructions: systemPrompt,
    temperature: 0.2,
    top_p: 0.1,
    max_output_tokens: 16384,
    text: { format: zodTextFormat(outputSchema, schemaName) },
    ...(tools ? { tools } : {}),
  };

  // First call
  let response = await apiCallWithRetry(client, {
    ...baseParams,
    input: [
      {
        role: 'user' as const,
        content: [{ type: 'input_text' as const, text: userMessage }],
      },
    ],
    ...(previousReviewId ? { previous_response_id: previousReviewId } : {}),
  });

  console.error(`[peer-reviewer] response.id=${response.id} model=${model}`);

  // Agentic tool-calling loop
  if (projectRoot) {
    const initialChars = systemPrompt.length + userMessage.length;
    const remainingBudget = MAX_INPUT_CHARS - initialChars;
    let accumulatedToolChars = 0;
    let budgetExceeded = false;

    // Cache: "toolName:argsJson" → result
    const toolCache = new Map<string, string>();
    // Repetition counter: "toolName:argsJson" → call count
    const callCounts = new Map<string, number>();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const functionCalls = getFunctionCalls(response);
      if (functionCalls.length === 0) break;

      console.error(
        `[peer-reviewer] Tool round ${round + 1}: ${functionCalls.length} call(s)`,
      );

      const toolResults: Array<{
        type: 'function_call_output';
        call_id: string;
        output: string;
      }> = [];

      // Process ALL calls in the batch — never skip any call_id
      for (const call of functionCalls) {
        if (call.type !== 'function_call') continue;

        const args = JSON.parse(call.arguments);
        const cacheKey = `${call.name}:${call.arguments}`;

        // Check repetition
        const count = (callCounts.get(cacheKey) ?? 0) + 1;
        callCounts.set(cacheKey, count);

        if (count > MAX_REPEAT_CALLS) {
          console.error(
            `[peer-reviewer]   ${call.name}(${args.path}) -> repeated ${count}x, short-circuiting`,
          );
          toolResults.push({
            type: 'function_call_output' as const,
            call_id: call.call_id,
            output: 'You have already read this content multiple times. Use the context you already have to complete your review.',
          });
          continue;
        }

        // Check cache
        if (toolCache.has(cacheKey)) {
          const cached = toolCache.get(cacheKey)!;
          console.error(
            `[peer-reviewer]   ${call.name}(${args.path}) -> cache hit (${cached.length} chars)`,
          );
          toolResults.push({
            type: 'function_call_output' as const,
            call_id: call.call_id,
            output: cached,
          });
          continue;
        }

        // Check budget BEFORE executing (but still respond to this call_id)
        if (budgetExceeded) {
          toolResults.push({
            type: 'function_call_output' as const,
            call_id: call.call_id,
            output: 'Budget exceeded: too much file content read. Produce your review with the context you already have.',
          });
          continue;
        }

        // Execute
        const result = await executeFilesystemTool(projectRoot, call.name, args);
        toolCache.set(cacheKey, result);

        accumulatedToolChars += result.length;
        console.error(
          `[peer-reviewer]   ${call.name}(${args.path}) -> ${result.length} chars (total: ${accumulatedToolChars}/${remainingBudget})`,
        );

        if (accumulatedToolChars > remainingBudget) {
          console.error(
            `[peer-reviewer] Tool output budget exceeded (${accumulatedToolChars}/${remainingBudget} chars).`,
          );
          budgetExceeded = true;
          // Still include this result — it was already read
        }

        toolResults.push({
          type: 'function_call_output' as const,
          call_id: call.call_id,
          output: result,
        });
      }

      // Send all tool results back
      response = await apiCallWithRetry(client, {
        ...baseParams,
        previous_response_id: response.id,
        input: toolResults,
      });

      console.error(`[peer-reviewer] response.id=${response.id} (after tool round ${round + 1})`);

      // If budget exceeded, check if model produced output or wants more tools
      if (budgetExceeded && hasPendingFunctionCalls(response)) {
        // Model still wants tools after budget exceeded — force one more round
        // with all calls answered as "budget exceeded"
        console.error('[peer-reviewer] Budget exceeded but model still requesting tools. Sending final stop.');
        const remainingCalls = getFunctionCalls(response);
        const stopResults = remainingCalls
          .filter((c) => c.type === 'function_call')
          .map((c) => ({
            type: 'function_call_output' as const,
            call_id: c.call_id,
            output: 'No more file reads allowed. You must produce your final review verdict now with the context you already have.',
          }));

        response = await apiCallWithRetry(client, {
          ...baseParams,
          previous_response_id: response.id,
          input: stopResults,
        });
        console.error(`[peer-reviewer] response.id=${response.id} (forced finalize)`);
        break;
      }

      if (budgetExceeded) break;
    }

    // After loop: if still function_call pending (MAX_TOOL_ROUNDS exhausted),
    // force finalize by responding to all pending calls
    if (hasPendingFunctionCalls(response)) {
      console.error(`[peer-reviewer] Tool loop exhausted (${MAX_TOOL_ROUNDS} rounds). Forcing final verdict.`);
      const remainingCalls = getFunctionCalls(response);
      const stopResults = remainingCalls
        .filter((c) => c.type === 'function_call')
        .map((c) => ({
          type: 'function_call_output' as const,
          call_id: c.call_id,
          output: 'Tool call limit reached. You must produce your final review verdict now with the context you already have.',
        }));

      response = await apiCallWithRetry(client, {
        ...baseParams,
        previous_response_id: response.id,
        input: stopResults,
      });
      console.error(`[peer-reviewer] response.id=${response.id} (forced finalize after loop exhaustion)`);
    }
  }

  // Extract structured output from response
  const parsed = extractStructuredOutput(response, outputSchema);
  if (parsed !== null) {
    return { parsed, reviewId: response.id };
  }

  // Final fallback: if STILL function_call after forced finalize, explicit error
  const outputTypes = response.output.map((item) => item.type).join(', ');
  const pendingCount = response.output.filter((item) => item.type === 'function_call').length;
  throw new Error(
    `Review failed: could not obtain structured verdict after tool loop. ` +
      `Output types: [${outputTypes}], pending function_calls: ${pendingCount}. ` +
      `This may indicate the model is stuck in a tool-calling loop.`,
  );
}
