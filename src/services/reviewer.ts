/**
 * Main reviewer entry point.
 * Resolves the appropriate provider and delegates the review call.
 */
import type { z } from 'zod';
import type { WorkspaceScope } from './filesystem.js';
import type { ReviewerProvider, ReviewCallResult, ExhaustionReason } from './providers/types.js';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GoogleProvider } from './providers/google.js';

export type { ReviewerProvider, ReviewCallResult, ExhaustionReason };

type ProviderName = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'compatible';

export interface ReviewOptions<T extends z.ZodType> {
  systemPrompt: string;
  userMessage: string;
  schemaName: string;
  outputSchema: T;
  workspaceScope?: WorkspaceScope | null;
  previousReviewId?: string;
  reviewerConfig?: {
    provider?: string;
    model?: string;
    base_url?: string;
    api_key?: string;
    temperature?: number;
    top_p?: number;
  };
  createFallback?: (reason: ExhaustionReason, usedTools: string[]) => z.infer<T>;
}

/**
 * Resolve the effective provider name from config and env vars.
 * Priority: per-request config > env REVIEW_PROVIDER > "openai"
 */
function resolveProviderName(configProvider?: string): ProviderName {
  const name = configProvider ?? process.env.REVIEW_PROVIDER ?? 'openai';
  const valid: ProviderName[] = ['openai', 'anthropic', 'google', 'openrouter', 'compatible'];
  if (!valid.includes(name as ProviderName)) {
    console.error(`[peer-reviewer] Unknown provider "${name}", falling back to openai`);
    return 'openai';
  }
  return name as ProviderName;
}

/**
 * Resolve the API key for a provider from environment variables.
 * For 'compatible', checks REVIEW_API_KEY first, then falls back to OPENAI_API_KEY.
 */
function resolveApiKey(provider: ProviderName): string | undefined {
  switch (provider) {
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'google':
      return process.env.GOOGLE_API_KEY;
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY;
    case 'compatible':
      return process.env.REVIEW_API_KEY ?? process.env.OPENAI_API_KEY;
    default:
      return undefined;
  }
}

// Cache providers by config signature to avoid re-creating clients.
// Capped at MAX_CACHE_SIZE; oldest entries evicted on overflow.
// Per-request api_key bypasses the cache entirely (ephemeral credentials).
const MAX_CACHE_SIZE = 10;
const providerCache = new Map<string, ReviewerProvider>();

/**
 * Short fingerprint of an API key for cache identity.
 * Uses prefix + suffix to detect key changes without storing the full key.
 */
function apiKeyFingerprint(key: string | undefined): string {
  if (!key) return 'none';
  if (key.length <= 8) return key;
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function getProviderCacheKey(provider: ProviderName, config?: ReviewOptions<z.ZodType>['reviewerConfig']): string {
  const apiKey = config?.api_key ?? resolveApiKey(provider);
  return JSON.stringify({
    provider,
    model: config?.model,
    base_url: config?.base_url,
    temperature: config?.temperature,
    top_p: config?.top_p,
    key_fp: apiKeyFingerprint(apiKey),
  });
}

/**
 * Create or retrieve a cached provider instance.
 */
function getProvider(reviewerConfig?: ReviewOptions<z.ZodType>['reviewerConfig']): ReviewerProvider {
  const providerName = resolveProviderName(reviewerConfig?.provider);
  const hasEphemeralKey = !!reviewerConfig?.api_key;

  // Per-request api_key → skip cache (ephemeral credential, don't leak into shared cache)
  if (!hasEphemeralKey) {
    const cacheKey = getProviderCacheKey(providerName, reviewerConfig);
    if (providerCache.has(cacheKey)) {
      return providerCache.get(cacheKey)!;
    }
  }

  const apiKey = reviewerConfig?.api_key ?? resolveApiKey(providerName);
  const constructorConfig = {
    apiKey,
    baseUrl: reviewerConfig?.base_url,
    model: reviewerConfig?.model,
    temperature: reviewerConfig?.temperature,
    topP: reviewerConfig?.top_p,
  };

  let provider: ReviewerProvider;

  switch (providerName) {
    case 'openai':
      provider = new OpenAIProvider(constructorConfig);
      break;
    case 'anthropic':
      provider = new AnthropicProvider(constructorConfig);
      break;
    case 'google':
      provider = new GoogleProvider(constructorConfig);
      break;
    case 'openrouter':
      // OpenRouter is OpenAI-compatible
      provider = new OpenAIProvider({
        ...constructorConfig,
        apiKey: constructorConfig.apiKey ?? process.env.OPENROUTER_API_KEY,
        baseUrl: constructorConfig.baseUrl ?? 'https://openrouter.ai/api/v1',
      });
      break;
    case 'compatible':
      // Generic OpenAI-compatible endpoint
      provider = new OpenAIProvider(constructorConfig);
      break;
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }

  // Only cache env-based providers (not ephemeral per-request keys)
  if (!hasEphemeralKey) {
    // Evict oldest entry if cache is full
    if (providerCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = providerCache.keys().next().value!;
      providerCache.delete(oldestKey);
      console.error(`[peer-reviewer] Provider cache full, evicted oldest entry`);
    }
    const cacheKey = getProviderCacheKey(providerName, reviewerConfig);
    providerCache.set(cacheKey, provider);
  }

  console.error(`[peer-reviewer] Created ${providerName} provider (model: ${reviewerConfig?.model ?? 'default'}${hasEphemeralKey ? ', ephemeral key' : ''})`);
  return provider;
}

/**
 * Main entry point for all review calls.
 * Resolves provider from config, delegates the call.
 */
export async function callReview<T extends z.ZodType>(
  options: ReviewOptions<T>,
): Promise<ReviewCallResult<z.infer<T>>> {
  const provider = getProvider(options.reviewerConfig);

  // Log capability warnings for non-full-featured providers
  if (!provider.capabilities.toolCalling && options.workspaceScope?.root) {
    console.error(
      `[peer-reviewer] Warning: ${provider.name} provider does not support tool calling. ` +
        'Reviewer will not be able to explore the workspace. Consider providing more context via relevant_code/artifact_refs.',
    );
  }
  if (!provider.capabilities.previousResponseId && options.previousReviewId) {
    console.error(
      `[peer-reviewer] Warning: ${provider.name} provider does not support previous_response_id. ` +
        'Reviewer context from previous rounds will not be available.',
    );
  }

  return provider.review(options);
}
