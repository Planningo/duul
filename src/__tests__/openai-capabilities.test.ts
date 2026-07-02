import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../services/providers/openai.js';

// Constructors do not hit the network, so these assert the capability contract
// without any API calls.

test('openai api-key mode: native chaining, no replay', () => {
  const p = new OpenAIProvider({ apiKey: 'sk-test' });
  assert.equal(p.capabilities.previousResponseId, true);
  assert.equal(p.capabilities.conversationReplay, false);
  assert.equal(p.capabilities.toolCalling, true);
  assert.equal(p.capabilities.structuredOutputs, true);
});

test('openai ChatGPT-login mode: replay continuity, no native chaining', () => {
  const p = new OpenAIProvider({ chatgpt: { accessToken: 'tok', accountId: 'acct' } });
  assert.equal(p.capabilities.previousResponseId, false);
  assert.equal(p.capabilities.conversationReplay, true);
  assert.equal(p.capabilities.toolCalling, true);
  assert.equal(p.capabilities.structuredOutputs, true);
});

test('openai constructor without any credential throws', () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => new OpenAIProvider({}), /No OpenAI credential/);
  } finally {
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  }
});
