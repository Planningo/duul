import type { z } from 'zod';
import type { WorkspaceScope } from '../filesystem.js';

export type ExhaustionReason = 'budget' | 'repeat' | 'round_limit';

/**
 * Token usage from a single review call.
 * Accumulated across all API calls (including tool loop rounds).
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Number of API calls made (1 + tool loop rounds) */
  api_calls: number;
  provider: string;
  model: string;
  /** Estimated cost in USD (null if pricing unknown for this model) */
  estimated_cost_usd: number | null;
}

export interface ReviewCallOptions<T extends z.ZodType> {
  systemPrompt: string;
  userMessage: string;
  schemaName: string;
  outputSchema: T;
  workspaceScope?: WorkspaceScope | null;
  previousReviewId?: string;
  /** Factory to create a structured fallback when the tool loop is exhausted */
  createFallback?: (reason: ExhaustionReason, usedTools: string[]) => z.infer<T>;
}

export interface ReviewCallResult<T> {
  parsed: T;
  reviewId: string;
  usage: TokenUsage;
}

/**
 * Describes what a provider supports.
 * Used for capability-aware degradation.
 */
export interface ProviderCapabilities {
  /** Supports structured output (JSON schema enforcement) */
  structuredOutputs: boolean;
  /** Supports tool/function calling */
  toolCalling: boolean;
  /** Supports previous_response_id for conversation continuity */
  previousResponseId: boolean;
  /** Supports strict JSON schema mode */
  jsonSchemaStrict: boolean;
}

/**
 * Common interface for all reviewer providers.
 */
export interface ReviewerProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  review<T extends z.ZodType>(
    options: ReviewCallOptions<T>,
  ): Promise<ReviewCallResult<z.infer<T>>>;
}

/**
 * Configuration for creating a provider instance.
 */
export interface ProviderConfig {
  provider: 'openai' | 'anthropic' | 'google' | 'openrouter' | 'compatible';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  topP?: number;
}
