/**
 * Main reviewer entry point.
 * Resolves the appropriate provider and delegates the review call.
 */
import type { z } from 'zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { WorkspaceScope } from './filesystem.js';
import type { ReviewerProvider, ReviewCallResult, ExhaustionReason, TokenUsage, ConversationTurn } from './providers/types.js';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GoogleProvider } from './providers/google.js';

export type { ReviewerProvider, ReviewCallResult, ExhaustionReason, TokenUsage };

type ProviderName = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'compatible';

export type ReviewToolName = 'plan' | 'code' | 'partition';

type ReviewerModel = string | { plan?: string; code?: string; partition?: string };

export interface ReviewOptions<T extends z.ZodType> {
  systemPrompt: string;
  userMessage: string;
  schemaName: string;
  outputSchema: T;
  workspaceScope?: WorkspaceScope | null;
  previousReviewId?: string;
  toolName?: ReviewToolName;
  reviewerConfig?: {
    provider?: string;
    model?: ReviewerModel;
    base_url?: string;
    api_key?: string;
    temperature?: number;
    top_p?: number;
  };
  createFallback?: (reason: ExhaustionReason, usedTools: string[]) => z.infer<T>;
}

/**
 * Resolve a concrete model string from either the flat string form or
 * the per-tool object form. Returns undefined when nothing is set so the
 * provider falls back to env/default.
 */
export function resolveModelForTool(
  model: ReviewerModel | undefined,
  toolName: ReviewToolName | undefined,
): string | undefined {
  if (model === undefined) return undefined;
  if (typeof model === 'string') return model;
  if (!toolName) return undefined;
  return model[toolName];
}

/**
 * Resolve the effective provider name from config and env vars.
 * Priority: per-request config > env REVIEW_PROVIDER > "openai"
 */
function resolveProviderName(configProvider?: string): ProviderName {
  const name = configProvider ?? process.env.REVIEW_PROVIDER ?? 'openai';
  const valid: ProviderName[] = ['openai', 'anthropic', 'google', 'openrouter', 'compatible'];
  if (!valid.includes(name as ProviderName)) {
    console.error(`[duul] Unknown provider "${name}", falling back to openai`);
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

function getProviderCacheKey(
  provider: ProviderName,
  resolvedModel: string | undefined,
  config?: ReviewOptions<z.ZodType>['reviewerConfig'],
): string {
  const apiKey = config?.api_key ?? resolveApiKey(provider);
  return JSON.stringify({
    provider,
    model: resolvedModel,
    base_url: config?.base_url,
    temperature: config?.temperature,
    top_p: config?.top_p,
    key_fp: apiKeyFingerprint(apiKey),
  });
}

/**
 * Create or retrieve a cached provider instance.
 *
 * `toolName` lets callers use the per-tool model override form:
 * `{ plan: "...", code: "...", partition: "..." }`. The resolved model
 * participates in the cache key so per-tool models don't collide.
 */
function getProvider(
  reviewerConfig?: ReviewOptions<z.ZodType>['reviewerConfig'],
  toolName?: ReviewToolName,
): ReviewerProvider {
  const providerName = resolveProviderName(reviewerConfig?.provider);
  const hasEphemeralKey = !!reviewerConfig?.api_key;
  const resolvedModel = resolveModelForTool(reviewerConfig?.model, toolName);

  // Per-request api_key → skip cache (ephemeral credential, don't leak into shared cache)
  if (!hasEphemeralKey) {
    const cacheKey = getProviderCacheKey(providerName, resolvedModel, reviewerConfig);
    if (providerCache.has(cacheKey)) {
      return providerCache.get(cacheKey)!;
    }
  }

  const apiKey = reviewerConfig?.api_key ?? resolveApiKey(providerName);
  const constructorConfig = {
    apiKey,
    baseUrl: reviewerConfig?.base_url,
    model: resolvedModel,
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
      console.error(`[duul] Provider cache full, evicted oldest entry`);
    }
    const cacheKey = getProviderCacheKey(providerName, resolvedModel, reviewerConfig);
    providerCache.set(cacheKey, provider);
  }

  console.error(`[duul] Created ${providerName} provider (model: ${resolvedModel ?? 'default'}${toolName ? `, tool: ${toolName}` : ''}${hasEphemeralKey ? ', ephemeral key' : ''})`);
  return provider;
}

// --- Conversation history store (disk-persisted per workspace) ---

const MAX_CONVERSATION_ENTRIES = 20;
const CONVERSATIONS_DIR = '.duul';
const CONVERSATIONS_FILE = 'conversations.json';

interface StoredConversation {
  turns: ConversationTurn[];
  lastAccessed: number;
}

/**
 * In-memory cache backed by disk. Keyed by reviewId.
 * On every write, the full store is flushed to <workspace_root>/.duul/conversations.json.
 * On read-miss, attempts to load from disk first.
 */
const memoryCache = new Map<string, StoredConversation>();
let diskLoaded = false;
let lastWorkspaceRoot: string | null = null;

function conversationsPath(workspaceRoot: string): string {
  return join(workspaceRoot, CONVERSATIONS_DIR, CONVERSATIONS_FILE);
}

async function loadFromDisk(workspaceRoot: string): Promise<void> {
  if (diskLoaded && lastWorkspaceRoot === workspaceRoot) return;
  lastWorkspaceRoot = workspaceRoot;
  diskLoaded = true;

  try {
    const raw = await readFile(conversationsPath(workspaceRoot), 'utf-8');
    const data = JSON.parse(raw) as Record<string, StoredConversation>;
    for (const [key, entry] of Object.entries(data)) {
      if (!memoryCache.has(key)) {
        memoryCache.set(key, entry);
      }
    }
    console.error(`[duul] Loaded ${Object.keys(data).length} conversation(s) from disk`);
  } catch {
    // File doesn't exist yet or is corrupt — start fresh
  }
}

async function flushToDisk(workspaceRoot: string): Promise<void> {
  const filePath = conversationsPath(workspaceRoot);
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const data: Record<string, StoredConversation> = {};
    for (const [key, entry] of memoryCache) {
      data[key] = entry;
    }
    await writeFile(filePath, JSON.stringify(data), 'utf-8');
    console.error(`[duul] Flushed ${memoryCache.size} conversation(s) to ${filePath}`);
  } catch (error) {
    console.error(`[duul] Warning: Failed to flush conversations to disk: ${error instanceof Error ? error.message : error}`);
  }
}

function evictOldest(): void {
  if (memoryCache.size < MAX_CONVERSATION_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of memoryCache) {
    if (entry.lastAccessed < oldestTime) {
      oldestTime = entry.lastAccessed;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    memoryCache.delete(oldestKey);
    console.error(`[duul] Conversation store full, evicted oldest entry`);
  }
}

async function getConversationHistory(reviewId: string, workspaceRoot?: string): Promise<ConversationTurn[] | undefined> {
  if (workspaceRoot) await loadFromDisk(workspaceRoot);
  const entry = memoryCache.get(reviewId);
  if (!entry) return undefined;
  entry.lastAccessed = Date.now();
  return entry.turns;
}

async function storeConversation(reviewId: string, turns: ConversationTurn[], workspaceRoot?: string): Promise<void> {
  evictOldest();
  memoryCache.set(reviewId, { turns, lastAccessed: Date.now() });
  if (workspaceRoot) {
    await flushToDisk(workspaceRoot);
  }
}

/**
 * Main entry point for all review calls.
 * Resolves provider from config, delegates the call.
 */
export async function callReview<T extends z.ZodType>(
  options: ReviewOptions<T>,
): Promise<ReviewCallResult<z.infer<T>>> {
  const provider = getProvider(options.reviewerConfig, options.toolName);

  // Log capability warnings for non-full-featured providers
  if (!provider.capabilities.toolCalling && options.workspaceScope?.root) {
    console.error(
      `[duul] Warning: ${provider.name} provider does not support tool calling. ` +
        'Reviewer will not be able to explore the workspace. Consider providing more context via relevant_code/artifact_refs.',
    );
  }
  if (!provider.capabilities.previousResponseId && options.previousReviewId) {
    console.error(
      `[duul] Warning: ${provider.name} provider does not support previous_response_id. ` +
        'Reviewer context from previous rounds will not be available.',
    );
  }

  const workspaceRoot = options.workspaceScope?.root;

  // Retrieve conversation history for providers that use simulated context
  // OpenAI uses native previous_response_id, so skip for it
  let conversationHistory: ConversationTurn[] | undefined;
  if (options.previousReviewId && provider.capabilities.previousResponseId && provider.name !== 'openai') {
    conversationHistory = await getConversationHistory(options.previousReviewId, workspaceRoot);
    if (conversationHistory) {
      console.error(`[duul] Loaded conversation history for ${options.previousReviewId} (${conversationHistory.length} turns)`);
    } else {
      console.error(`[duul] Warning: No conversation history found for ${options.previousReviewId}`);
    }
  }

  const result = await provider.review({ ...options, conversationHistory });

  // Store conversation turns for future rounds (non-OpenAI providers)
  if (result.conversationTurns?.length && provider.name !== 'openai') {
    await storeConversation(result.reviewId, result.conversationTurns, workspaceRoot);
    console.error(`[duul] Stored conversation (${result.conversationTurns.length} turns) for ${result.reviewId}`);
  }

  return result;
}
