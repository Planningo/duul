import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jwtExp, isTokenExpired, loadCodexAuth, resolveCodexCredential, codexHome } from '../services/providers/codex-auth.js';

/** Build an unsigned JWT (header.payload.sig) with the given payload. */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

function withCodexHome<T>(auth: unknown | null, fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'duul-codex-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    if (auth !== null) writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth));
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('codexHome honors CODEX_HOME override', () => {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/tmp/fake-codex';
  try {
    assert.equal(codexHome(), '/tmp/fake-codex');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test('jwtExp decodes the exp claim', () => {
  assert.equal(jwtExp(makeJwt({ exp: 123456 })), 123456);
});

test('jwtExp returns null for non-JWT strings', () => {
  assert.equal(jwtExp('sk-not-a-jwt'), null);
  assert.equal(jwtExp('a.b'), null); // payload not valid base64 JSON
});

test('isTokenExpired: future token is not expired', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(isTokenExpired(makeJwt({ exp: future })), false);
});

test('isTokenExpired: token within skew window is expired', () => {
  const soon = Math.floor(Date.now() / 1000) + 60; // < 5min skew
  assert.equal(isTokenExpired(makeJwt({ exp: soon })), true);
});

test('isTokenExpired: unknown expiry treated as not expired', () => {
  assert.equal(isTokenExpired('opaque-token'), false);
});

test('loadCodexAuth returns null when file absent', () => {
  withCodexHome(null, () => {
    assert.equal(loadCodexAuth(), null);
  });
});

test('loadCodexAuth parses auth.json', () => {
  withCodexHome({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }, () => {
    assert.deepEqual(loadCodexAuth(), { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' });
  });
});

test('resolveCodexCredential: apikey mode', async () => {
  const cred = await withCodexHome(
    { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-live-abc' },
    () => resolveCodexCredential(),
  );
  assert.deepEqual(cred, { mode: 'apikey', apiKey: 'sk-live-abc' });
});

test('resolveCodexCredential: chatgpt mode with valid token needs no network', async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const cred = await withCodexHome(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: makeJwt({ exp: future }), refresh_token: 'r', account_id: 'acct-1' },
    },
    () => resolveCodexCredential(),
  );
  assert.equal(cred?.mode, 'chatgpt');
  if (cred?.mode === 'chatgpt') {
    assert.equal(cred.accountId, 'acct-1');
    assert.ok(cred.accessToken.length > 0);
  }
});

test('resolveCodexCredential: returns null when logged out', async () => {
  const cred = await withCodexHome(null, () => resolveCodexCredential());
  assert.equal(cred, null);
});

test('resolveCodexCredential: chatgpt preferred even when api key present', async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const cred = await withCodexHome(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'sk-should-be-ignored',
      tokens: { access_token: makeJwt({ exp: future }), refresh_token: 'r', account_id: 'acct-2' },
    },
    () => resolveCodexCredential(),
  );
  assert.equal(cred?.mode, 'chatgpt');
});
