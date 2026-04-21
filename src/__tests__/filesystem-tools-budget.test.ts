import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeFilesystemTool,
  createReviewerByteBudget,
  getMaxReviewerBytes,
} from '../services/filesystem-tools.js';
import type { WorkspaceScope } from '../services/filesystem.js';

let tempRoot: string;
let scope: WorkspaceScope;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'duul-budget-test-'));
  mkdirSync(join(tempRoot, 'src'), { recursive: true });
  writeFileSync(join(tempRoot, 'a.txt'), 'A'.repeat(400));
  writeFileSync(join(tempRoot, 'b.txt'), 'B'.repeat(400));
  writeFileSync(join(tempRoot, 'c.txt'), 'C'.repeat(400));
  scope = { root: tempRoot, trackedOnly: false, workingDirectories: null, linkedRoots: [] };
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test('budget accumulates bytes across successful calls', async () => {
  const budget = createReviewerByteBudget(10_000);

  const r1 = await executeFilesystemTool(tempRoot, 'read_file', { path: 'a.txt' }, scope, budget);
  assert.ok(r1.includes('AAAA'), 'first read should return file contents');
  assert.equal(budget.used, r1.length);

  const r2 = await executeFilesystemTool(tempRoot, 'read_file', { path: 'b.txt' }, scope, budget);
  assert.ok(r2.includes('BBBB'), 'second read should return file contents');
  assert.equal(budget.used, r1.length + r2.length);
});

test('exceeding budget short-circuits with exhaustion message', async () => {
  // Cap is tight enough that a single read hits it.
  const budget = createReviewerByteBudget(1000);

  const first = await executeFilesystemTool(tempRoot, 'read_file', { path: 'a.txt' }, scope, budget);
  assert.ok(first.includes('AAAA'), 'first read should succeed');
  assert.ok(budget.used >= 400);

  // The second call should short-circuit because used >= cap isn't necessarily
  // true yet — so drive it by setting used over the cap artificially and retry.
  budget.used = budget.cap;
  const second = await executeFilesystemTool(tempRoot, 'read_file', { path: 'b.txt' }, scope, budget);
  assert.match(second, /budget exhausted/i, 'second call must be short-circuited');
  assert.doesNotMatch(second, /BBBB/, 'exhausted call must not return file content');
});

test('third call returns exhausted message with a small cap', async () => {
  const budget = createReviewerByteBudget(500);

  await executeFilesystemTool(tempRoot, 'read_file', { path: 'a.txt' }, scope, budget);
  await executeFilesystemTool(tempRoot, 'read_file', { path: 'b.txt' }, scope, budget);
  const third = await executeFilesystemTool(tempRoot, 'read_file', { path: 'c.txt' }, scope, budget);

  assert.match(third, /budget exhausted/i, 'third call should hit the budget cap');
  assert.ok(budget.used >= budget.cap, 'used must meet or exceed cap after exhaustion');
});

test('no budget passed = no cap enforced', async () => {
  // Backwards-compatible path: existing callers that omit the budget keep working.
  const r1 = await executeFilesystemTool(tempRoot, 'read_file', { path: 'a.txt' }, scope);
  const r2 = await executeFilesystemTool(tempRoot, 'read_file', { path: 'b.txt' }, scope);
  assert.ok(r1.includes('AAAA'));
  assert.ok(r2.includes('BBBB'));
});

test('getMaxReviewerBytes respects DUUL_MAX_REVIEWER_BYTES env var', () => {
  const original = process.env.DUUL_MAX_REVIEWER_BYTES;
  try {
    delete process.env.DUUL_MAX_REVIEWER_BYTES;
    assert.equal(getMaxReviewerBytes(), 200_000, 'default when unset');

    process.env.DUUL_MAX_REVIEWER_BYTES = '12345';
    assert.equal(getMaxReviewerBytes(), 12345);

    process.env.DUUL_MAX_REVIEWER_BYTES = 'not-a-number';
    assert.equal(getMaxReviewerBytes(), 200_000, 'bad value falls back to default');

    process.env.DUUL_MAX_REVIEWER_BYTES = '-50';
    assert.equal(getMaxReviewerBytes(), 200_000, 'negative value falls back to default');
  } finally {
    if (original === undefined) delete process.env.DUUL_MAX_REVIEWER_BYTES;
    else process.env.DUUL_MAX_REVIEWER_BYTES = original;
  }
});
