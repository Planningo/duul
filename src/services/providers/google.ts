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
 * Google provider — uses Gemini models via the Generative Language API.
 *
 * Capabilities:
 * - Supports JSON mode (responseType: "application/json")
 * - No tool calling in this implementation
 * - No previous_response_id
 */
export class GoogleProvider implements ReviewerProvider {
  readonly name = 'google';
  readonly capabilities: ProviderCapabilities = {
    structuredOutputs: false, // JSON mode but not strict schema enforcement
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
    const { systemPrompt, userMessage, outputSchema } = options;

    const enhancedSystem = `${systemPrompt}\n\n## Output Format\nYou MUST respond with ONLY a valid JSON object. No markdown, no explanation, no code blocks — only the JSON object.`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);

      try {
        const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: enhancedSystem }] },
            contents: [{ parts: [{ text: userMessage }] }],
            generationConfig: {
              temperature: this.temperature,
              topP: this.topP,
              maxOutputTokens: 16384,
              responseMimeType: 'application/json',
            },
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

        const body = await response.json() as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            totalTokenCount?: number;
          };
        };

        const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          throw new Error('Google returned no text content');
        }

        // Extract JSON from response
        const jsonStr = extractJson(text);
        const parsed = outputSchema.parse(JSON.parse(jsonStr));

        const inputTokens = body.usageMetadata?.promptTokenCount ?? 0;
        const outputTokens = body.usageMetadata?.candidatesTokenCount ?? 0;
        const usage: TokenUsage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: body.usageMetadata?.totalTokenCount ?? (inputTokens + outputTokens),
          api_calls: 1,
          provider: 'google',
          model: this.model,
          estimated_cost_usd: estimateCost(this.model, inputTokens, outputTokens),
        };
        const costStr = usage.estimated_cost_usd !== null ? ` (~$${usage.estimated_cost_usd.toFixed(4)})` : '';
        console.error(`[duul] Token usage: ${usage.input_tokens} in + ${usage.output_tokens} out = ${usage.total_tokens} total${costStr}`);

        // Google doesn't return a conversation ID, generate a synthetic one
        const reviewId = `google-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return { parsed, reviewId, usage };
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
