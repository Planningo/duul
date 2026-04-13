/**
 * Model pricing table and cost estimation.
 *
 * Prices are per 1M tokens in USD.
 * Update this table when new models or pricing changes occur.
 * Set env DUUL_PRICING_JSON to a JSON file path to override/extend.
 */
import { readFileSync } from 'node:fs';

interface ModelPricing {
  input: number;   // USD per 1M input tokens
  output: number;  // USD per 1M output tokens
}

// Key: model name or prefix. Longest prefix match wins.
const PRICING_TABLE: Record<string, ModelPricing> = {
  // OpenAI — GPT
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.5-preview': { input: 75.00, output: 150.00 },
  'gpt-5': { input: 2.00, output: 8.00 },
  'gpt-5.4': { input: 2.00, output: 8.00 },

  // OpenAI — o-series (reasoning)
  'o4-mini': { input: 1.10, output: 4.40 },
  'o3': { input: 2.00, output: 8.00 },
  'o3-pro': { input: 20.00, output: 80.00 },
  'o3-mini': { input: 1.10, output: 4.40 },
  'o1': { input: 15.00, output: 60.00 },
  'o1-mini': { input: 1.10, output: 4.40 },
  'o1-preview': { input: 15.00, output: 60.00 },

  // Anthropic — Claude
  'claude-opus-4': { input: 15.00, output: 75.00 },
  'claude-sonnet-4': { input: 3.00, output: 15.00 },
  'claude-haiku-4': { input: 0.80, output: 4.00 },
  'claude-3.5-sonnet': { input: 3.00, output: 15.00 },
  'claude-3.5-haiku': { input: 0.80, output: 4.00 },
  'claude-3-opus': { input: 15.00, output: 75.00 },
  'claude-3-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },

  // Google — Gemini
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-3': { input: 1.25, output: 10.00 },
  'gemini-3.1-pro': { input: 1.25, output: 10.00 },
};

// Custom pricing loaded lazily from DUUL_PRICING_JSON
let customPricing: Record<string, ModelPricing> | null = null;

function loadCustomPricing(): Record<string, ModelPricing> {
  if (customPricing !== null) return customPricing;
  customPricing = {};
  const envPath = process.env.DUUL_PRICING_JSON;
  if (envPath) {
    try {
      const data = JSON.parse(readFileSync(envPath, 'utf-8'));
      if (typeof data === 'object' && data !== null) {
        customPricing = data as Record<string, ModelPricing>;
        console.error(`[duul] Loaded custom pricing from ${envPath} (${Object.keys(customPricing).length} models)`);
      }
    } catch {
      console.error(`[duul] Failed to load custom pricing from ${envPath}, using defaults`);
    }
  }
  return customPricing;
}

function findPricing(model: string): ModelPricing | null {
  const custom = loadCustomPricing();

  // Exact match (custom first, then built-in)
  if (custom[model]) return custom[model];
  if (PRICING_TABLE[model]) return PRICING_TABLE[model];

  // Longest prefix match (e.g. "gpt-4.1-mini-2025-04-14" → "gpt-4.1-mini")
  let bestMatch: ModelPricing | null = null;
  let bestLen = 0;

  const allKeys = [...Object.keys(custom), ...Object.keys(PRICING_TABLE)];
  for (const key of allKeys) {
    if (model.startsWith(key) && key.length > bestLen) {
      bestMatch = custom[key] ?? PRICING_TABLE[key];
      bestLen = key.length;
    }
  }

  return bestMatch;
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const pricing = findPricing(model);
  if (!pricing) return null;

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  // Round to 6 decimal places to avoid floating point noise
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}
