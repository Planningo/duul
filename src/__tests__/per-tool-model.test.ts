import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelForTool } from '../services/reviewer.js';
import { ReviewerConfigSchema } from '../schemas/common.js';

test('string model form applies to every tool (backwards compat)', () => {
  assert.equal(resolveModelForTool('gpt-5.4', 'plan'), 'gpt-5.4');
  assert.equal(resolveModelForTool('gpt-5.4', 'code'), 'gpt-5.4');
  assert.equal(resolveModelForTool('gpt-5.4', 'partition'), 'gpt-5.4');
});

test('per-tool object resolves the right model per call site', () => {
  const model = { plan: 'gpt-5.4', code: 'claude-opus-4', partition: 'gpt-5.3-mini' };
  assert.equal(resolveModelForTool(model, 'plan'), 'gpt-5.4');
  assert.equal(resolveModelForTool(model, 'code'), 'claude-opus-4');
  assert.equal(resolveModelForTool(model, 'partition'), 'gpt-5.3-mini');
});

test('per-tool object returns undefined for unmapped tool → env/default fallback', () => {
  const model = { code: 'claude-opus-4' };
  assert.equal(resolveModelForTool(model, 'plan'), undefined);
  assert.equal(resolveModelForTool(model, 'code'), 'claude-opus-4');
  assert.equal(resolveModelForTool(model, 'partition'), undefined);
});

test('undefined model returns undefined regardless of tool', () => {
  assert.equal(resolveModelForTool(undefined, 'plan'), undefined);
  assert.equal(resolveModelForTool(undefined, 'code'), undefined);
});

test('object without toolName returns undefined (defensive)', () => {
  const model = { plan: 'x', code: 'y' };
  assert.equal(resolveModelForTool(model, undefined), undefined);
});

test('ReviewerConfigSchema accepts string model form', () => {
  const parsed = ReviewerConfigSchema.parse({ model: 'gpt-5.4' });
  assert.equal(parsed.model, 'gpt-5.4');
});

test('ReviewerConfigSchema accepts per-tool object model form', () => {
  const parsed = ReviewerConfigSchema.parse({
    model: { plan: 'gpt-5.4', code: 'claude-opus-4' },
  });
  assert.deepEqual(parsed.model, { plan: 'gpt-5.4', code: 'claude-opus-4' });
});

test('ReviewerConfigSchema rejects invalid model shape', () => {
  // Numbers or arrays should not parse
  assert.throws(() => ReviewerConfigSchema.parse({ model: 42 }));
  assert.throws(() => ReviewerConfigSchema.parse({ model: ['a', 'b'] }));
});
