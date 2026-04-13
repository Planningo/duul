import type { z } from 'zod';
import type {
  ReviewerProvider,
  ReviewCallOptions,
  ReviewCallResult,
  ProviderCapabilities,
  TokenUsage,
} from './types.js';
import { estimateCost } from '../pricing.js';

const MAX_RETRIES = 3;

/**
 * Anthropic provider — uses Claude models via the Anthropic Messages API.
 *
 * Capabilities:
 * - No native structured outputs (uses JSON prompt + zod validation)
 * - No previous_response_id (conversation history injected manually if needed)
 * - No tool calling (reviewer works from provided context only)
 */
export class AnthropicProvider implements ReviewerProvider {
  readonly name = 'anthropic';
  readonly capabilities: ProviderCapabilities = {
    structuredOutputs: false,
    toolCalling: false,
    previousResponseId: false,
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
    const { systemPrompt, userMessage, outputSchema } = options;

    // Append JSON schema instruction to system prompt since Anthropic doesn't enforce schemas
    const schemaJson = JSON.stringify(zodToJsonSchema(outputSchema), null, 2);
    const enhancedSystem = `${systemPrompt}\n\n## Output Format\nYou MUST respond with ONLY a valid JSON object matching this schema. No markdown, no explanation, no code blocks — only the JSON object.\n\n${schemaJson}`;

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
            system: enhancedSystem,
            messages: [{ role: 'user', content: userMessage }],
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

        const body = await response.json() as {
          id: string;
          model: string;
          content: Array<{ type: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        const text = body.content?.find((c: { type: string }) => c.type === 'text')?.text;
        if (!text) {
          throw new Error('Anthropic returned no text content');
        }

        // Extract JSON from response (may be wrapped in markdown code blocks)
        const jsonStr = extractJson(text);
        const parsed = outputSchema.parse(JSON.parse(jsonStr));

        const inputTokens = body.usage?.input_tokens ?? 0;
        const outputTokens = body.usage?.output_tokens ?? 0;
        const modelUsed = body.model ?? this.model;
        const usage: TokenUsage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          api_calls: 1,
          provider: 'anthropic',
          model: modelUsed,
          estimated_cost_usd: estimateCost(modelUsed, inputTokens, outputTokens),
        };
        const costStr = usage.estimated_cost_usd !== null ? ` (~$${usage.estimated_cost_usd.toFixed(4)})` : '';
        console.error(`[duul] Token usage: ${usage.input_tokens} in + ${usage.output_tokens} out = ${usage.total_tokens} total${costStr}`);

        return { parsed, reviewId: body.id, usage };
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
  // Use zod's built-in JSON schema if available, otherwise describe the shape
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
  // Try to find JSON in code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // Try to find a JSON object directly
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];

  return text.trim();
}
