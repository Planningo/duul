import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  continuityPlan,
  storeConversation,
  getConversationHistory,
  __resetConversationStoreForTest,
} from '../services/reviewer.js';

const caps = (previousResponseId: boolean, conversationReplay: boolean) => ({
  previousResponseId,
  conversationReplay,
});

// --- continuityPlan (pure) ---

test('continuityPlan: no previousReviewId → nothing to do', () => {
  assert.deepEqual(continuityPlan(caps(false, false), false), { shouldLoad: false, shouldWarn: false });
  assert.deepEqual(continuityPlan(caps(true, false), false), { shouldLoad: false, shouldWarn: false });
});

test('continuityPlan: native chaining (OpenAI api-key) → no load, no warn', () => {
  assert.deepEqual(continuityPlan(caps(true, false), true), { shouldLoad: false, shouldWarn: false });
});

test('continuityPlan: replay provider (Anthropic / ChatGPT login) → load, no warn', () => {
  assert.deepEqual(continuityPlan(caps(false, true), true), { shouldLoad: true, shouldWarn: false });
});

test('continuityPlan: no continuity support (Google) → warn only', () => {
  assert.deepEqual(continuityPlan(caps(false, false), true), { shouldLoad: false, shouldWarn: true });
});

// --- conversation store roundtrip + workspace isolation ---

const turn = (text: string) => [{ role: 'user' as const, content: [{ type: 'input_text', text }] }];

test('store/load conversation roundtrip within a workspace', async () => {
  __resetConversationStoreForTest();
  const ws = mkdtempSync(join(tmpdir(), 'duul-ws-'));
  try {
    await storeConversation('rev-1', turn('hello'), ws);
    const loaded = await getConversationHistory('rev-1', ws);
    assert.equal(loaded?.length, 1);
    // Flushed to disk under <ws>/.duul/conversations.json
    assert.ok(existsSync(join(ws, '.duul', 'conversations.json')));
  } finally {
    __resetConversationStoreForTest();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('workspace switch does not leak conversations across workspaces', async () => {
  __resetConversationStoreForTest();
  const wsA = mkdtempSync(join(tmpdir(), 'duul-wsA-'));
  const wsB = mkdtempSync(join(tmpdir(), 'duul-wsB-'));
  try {
    // Populate workspace A and read it (sets the store's active workspace to A).
    await storeConversation('a-1', turn('secret-A'), wsA);
    await getConversationHistory('a-1', wsA);

    // Switch to workspace B: a read must clear A's entries before touching B.
    await getConversationHistory('missing', wsB);
    await storeConversation('b-1', turn('data-B'), wsB);

    const bFile = JSON.parse(readFileSync(join(wsB, '.duul', 'conversations.json'), 'utf-8'));
    assert.ok('b-1' in bFile, "B's own entry is present");
    assert.ok(!('a-1' in bFile), "A's entry must NOT bleed into B's file");
  } finally {
    __resetConversationStoreForTest();
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  }
});
