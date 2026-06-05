import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInlineOrFile, type WorkspaceScope } from '../services/filesystem.js';

function makeScope(root: string): WorkspaceScope {
  return { root, workingDirectories: null, linkedRoots: [], trackedOnly: false };
}

test('returns inline value when present', async () => {
  const result = await resolveInlineOrFile({ inline: 'hello world', file: undefined, scope: null, label: 'plan' });
  assert.equal(result, 'hello world');
});

test('reads from file when inline is empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duul-inline-'));
  try {
    writeFileSync(join(dir, 'plan.md'), '## Plan\nfull contents from file');
    const result = await resolveInlineOrFile({
      inline: undefined,
      file: 'plan.md',
      scope: makeScope(dir),
      label: 'plan',
    });
    assert.equal(result, '## Plan\nfull contents from file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('whitespace-only inline falls through to file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duul-inline-'));
  try {
    writeFileSync(join(dir, 'plan.md'), 'real content');
    const result = await resolveInlineOrFile({
      inline: '   \n  ',
      file: 'plan.md',
      scope: makeScope(dir),
      label: 'plan',
    });
    assert.equal(result, 'real content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inline takes precedence over file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duul-inline-'));
  try {
    writeFileSync(join(dir, 'plan.md'), 'from file');
    const result = await resolveInlineOrFile({
      inline: 'from inline',
      file: 'plan.md',
      scope: makeScope(dir),
      label: 'plan',
    });
    assert.equal(result, 'from inline');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns undefined when neither inline nor file is provided', async () => {
  const result = await resolveInlineOrFile({ inline: undefined, file: undefined, scope: null, label: 'plan' });
  assert.equal(result, undefined);
});

test('throws when file is given but no workspace scope is set', async () => {
  await assert.rejects(
    () => resolveInlineOrFile({ inline: undefined, file: 'plan.md', scope: null, label: 'plan' }),
    /plan_file was provided.*no workspace_root/s,
  );
});

test('throws when file path escapes the workspace root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duul-inline-'));
  try {
    await assert.rejects(
      () => resolveInlineOrFile({ inline: undefined, file: '../escape.md', scope: makeScope(dir), label: 'plan' }),
      /outside project root/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blocks an in-root symlink that points at a secret (.env)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duul-inline-'));
  try {
    writeFileSync(join(dir, '.env'), 'SECRET=topsecret');
    symlinkSync(join(dir, '.env'), join(dir, 'innocent.md'));
    await assert.rejects(
      () => resolveInlineOrFile({ inline: undefined, file: 'innocent.md', scope: makeScope(dir), label: 'plan' }),
      /Access denied \(sensitive file\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
