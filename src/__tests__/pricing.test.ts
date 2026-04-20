import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost } from '../services/pricing.js';

// gpt-4o pricing: $2.50 / $10.00 per 1M
const MODEL = 'gpt-4o';

test('returns null for unknown model', () => {
  assert.equal(estimateCost('made-up-model', 1000, 100), null);
});

test('zero tokens returns 0 cost (not null)', () => {
  assert.equal(estimateCost(MODEL, 0, 0), 0);
});

test('input + output without cache uses full input price', () => {
  // 1M input * $2.50 + 1M output * $10.00 = $12.50
  assert.equal(estimateCost(MODEL, 1_000_000, 1_000_000), 12.5);
});

test('cache_read tokens billed at 0.1× input', () => {
  // input bucket = 1M, all of it cache_read.
  // Expected = 1M * $2.50 * 0.1 = $0.25
  const cost = estimateCost(MODEL, 1_000_000, 0, 1_000_000);
  assert.equal(cost, 0.25);
});

test('cache_creation tokens billed at 1.25× input', () => {
  // input bucket = 1M, all cache_write.
  // Expected = 1M * $2.50 * 1.25 = $3.125
  const cost = estimateCost(MODEL, 1_000_000, 0, 0, 1_000_000);
  assert.equal(cost, 3.125);
});

test('cached + non-cached split correctly', () => {
  // 1M total input: 800k non-cached, 200k cache_read
  // = 800k * $2.50 + 200k * $0.25 = $2.00 + $0.05 = $2.05
  const cost = estimateCost(MODEL, 1_000_000, 0, 200_000);
  assert.equal(cost, 2.05);
});

test('cached > inputTokens does not produce negative non-cached', () => {
  // Defensive: if provider reports inconsistent numbers, non-cached must clamp at 0.
  const cost = estimateCost(MODEL, 100, 0, 1000);
  // Expected: 0 non-cached + 1000 * $2.5 * 0.1 / 1e6 = $0.00025
  assert.ok(cost !== null && cost >= 0);
});

test('negative inputs treated as zero', () => {
  const cost = estimateCost(MODEL, 0, 0, -50, -50);
  assert.equal(cost, 0);
});
