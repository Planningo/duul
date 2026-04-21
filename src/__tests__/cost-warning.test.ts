import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCostWarning } from '../services/review-limits.js';

const meta = (count: number, limit = 5) => ({
  iteration_count: count,
  iteration_limit: limit,
  iteration_limit_reached: count > limit,
});

test('synthetic 4-round plan ping-pong (limit 5): warning appears from round 3 onward', () => {
  const perRoundCost = 0.065;

  assert.equal(computeCostWarning(meta(1), perRoundCost), null, 'round 1 should be silent');
  assert.equal(computeCostWarning(meta(2), perRoundCost), null, 'round 2 should be silent');

  const r3 = computeCostWarning(meta(3), perRoundCost);
  assert.ok(r3, 'round 3 should emit a warning');
  assert.match(r3!, /iteration 3 of 5/);
  assert.match(r3!, /\$0\.0650/);

  const r4 = computeCostWarning(meta(4), perRoundCost);
  assert.ok(r4, 'round 4 should emit a warning');
  assert.match(r4!, /iteration 4 of 5/);
});

test('trigger uses Math.ceil(limit * 0.6) — with limit 7 fires at iteration 5', () => {
  assert.equal(computeCostWarning(meta(4, 7), 0.1), null);
  assert.ok(computeCostWarning(meta(5, 7), 0.1));
  assert.ok(computeCostWarning(meta(6, 7), 0.1));
});

test('trigger with limit 3 fires at iteration 2 (ceil(1.8)=2)', () => {
  assert.equal(computeCostWarning(meta(1, 3), 0.1), null);
  assert.ok(computeCostWarning(meta(2, 3), 0.1));
});

test('null cost falls back to "unknown amount"', () => {
  const msg = computeCostWarning(meta(4), null);
  assert.ok(msg);
  assert.match(msg!, /unknown amount/);
});

test('zero cost also falls back to "unknown amount" (tolerates missing pricing)', () => {
  const msg = computeCostWarning(meta(4), 0);
  assert.ok(msg);
  assert.match(msg!, /unknown amount/);
});

test('iteration_count 0 returns null (no warning before first call)', () => {
  assert.equal(computeCostWarning(meta(0), 0.5), null);
});

test('warning mentions escalation/accept options so orchestrator has guidance', () => {
  const msg = computeCostWarning(meta(3, 5), 0.1);
  assert.ok(msg);
  assert.match(msg!, /REVISE-with-minor-issues|escalat/i);
});
