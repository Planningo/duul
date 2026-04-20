import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectScopePunting,
  detectTestOnlyChanges,
  detectDiagnosisHandoff,
  detectRenderingSymptom,
  enforceSymptomImpact,
  applyGates,
} from './review-gates.js';

describe('detectScopePunting', () => {
  it('fires on English scope-punt phrase', () => {
    const r = detectScopePunting('The lint error is pre-existing, ignore it.');
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'scope-punting');
    assert.equal(r[0].severity, 'revise');
  });

  it('fires on Korean scope-punt phrase', () => {
    const r = detectScopePunting('이 에러는 관련 없는 이슈이니 무시해도 됩니다.');
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'scope-punting');
  });

  it('does not fire on clean notes', () => {
    const r = detectScopePunting(
      'The helper used here lives in src/utils/format.ts, which the reviewer cannot see.',
    );
    assert.deepEqual(r, []);
  });

  it('does not fire on empty or missing notes', () => {
    assert.deepEqual(detectScopePunting(undefined), []);
    assert.deepEqual(detectScopePunting(null), []);
    assert.deepEqual(detectScopePunting(''), []);
    assert.deepEqual(detectScopePunting('   '), []);
  });
});

describe('detectTestOnlyChanges', () => {
  it('fires when every changed file is a test file', () => {
    const r = detectTestOnlyChanges(
      ['tests/foo.test.ts', 'src/bar.spec.ts'],
      undefined,
      'Fix the bug where the button stays gray.',
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'test-only');
    assert.equal(r[0].severity, 'human');
  });

  it('does not fire when non-test files are also changed', () => {
    const r = detectTestOnlyChanges(
      ['tests/foo.test.ts', 'src/bar.ts'],
      undefined,
      'Fix the bug.',
    );
    assert.deepEqual(r, []);
  });

  it('is suppressed when the request is explicitly about tests', () => {
    const r = detectTestOnlyChanges(
      ['tests/foo.test.ts'],
      undefined,
      'Please add test coverage for the button component.',
    );
    assert.deepEqual(r, []);
  });

  it('is suppressed when the Korean request is about tests', () => {
    const r = detectTestOnlyChanges(
      ['tests/foo.test.ts'],
      undefined,
      '버튼 컴포넌트에 대한 테스트를 추가해주세요.',
    );
    assert.deepEqual(r, []);
  });

  it('is suppressed when the request is to fix failing tests', () => {
    const r = detectTestOnlyChanges(
      ['src/foo.test.ts'],
      undefined,
      'fix the failing tests',
    );
    assert.deepEqual(r, []);
  });

  it('is suppressed for repair/update/refactor-test phrasings', () => {
    assert.deepEqual(
      detectTestOnlyChanges(['src/foo.test.ts'], undefined, 'repair broken tests'),
      [],
    );
    assert.deepEqual(
      detectTestOnlyChanges(['src/foo.test.ts'], undefined, 'Refactor the flaky specs'),
      [],
    );
    assert.deepEqual(
      detectTestOnlyChanges(['src/foo.test.ts'], undefined, 'Update snapshots'),
      [],
    );
  });

  it('is suppressed when the Korean request is to fix tests', () => {
    assert.deepEqual(
      detectTestOnlyChanges(['src/foo.test.ts'], undefined, '실패하는 테스트 수정해줘'),
      [],
    );
    assert.deepEqual(
      detectTestOnlyChanges(['src/foo.test.ts'], undefined, '깨진 테스트를 고쳐주세요'),
      [],
    );
  });

  it('detects test-only diffs when changedFiles is empty', () => {
    const diff = [
      'diff --git a/tests/a.test.ts b/tests/a.test.ts',
      'index 111..222 100644',
      '--- a/tests/a.test.ts',
      '+++ b/tests/a.test.ts',
      '@@ -1 +1,2 @@',
      ' a',
      '+b',
    ].join('\n');
    const r = detectTestOnlyChanges(undefined, diff, 'Fix the bug.');
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'test-only');
  });

  it('does not fire when both changedFiles and diff are missing', () => {
    const r = detectTestOnlyChanges(undefined, undefined, 'Fix the bug.');
    assert.deepEqual(r, []);
  });
});

describe('detectDiagnosisHandoff', () => {
  it('fires when caller notes are >5x longer than a short user request', () => {
    const req = 'Button doesn\'t work.';
    const notes = 'A '.repeat(400).trim();
    const r = detectDiagnosisHandoff(req, notes);
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'diagnosis-handoff');
    assert.equal(r[0].severity, 'human');
  });

  it('does not fire when lengths are balanced', () => {
    const req = 'Button on the settings page does not respond when clicked.';
    const notes = 'The click handler is wired in components/Settings.tsx.';
    const r = detectDiagnosisHandoff(req, notes);
    assert.deepEqual(r, []);
  });

  it('does not fire when the user request itself is long', () => {
    const req = 'x'.repeat(400);
    const notes = 'y'.repeat(3000);
    const r = detectDiagnosisHandoff(req, notes);
    assert.deepEqual(r, []);
  });

  it('does not fire when either input is missing', () => {
    assert.deepEqual(detectDiagnosisHandoff(undefined, 'notes'), []);
    assert.deepEqual(detectDiagnosisHandoff('req', undefined), []);
  });
});

describe('detectRenderingSymptom', () => {
  it('fires on visual request with no rendering files changed and no screenshot', () => {
    const r = detectRenderingSymptom(
      '버튼이 회색으로 표시돼요.',
      [],
      ['src/api/users.ts'],
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'rendering-symptom');
    assert.equal(r[0].severity, 'human');
  });

  it('does not fire when a rendering-adjacent file is changed', () => {
    const r = detectRenderingSymptom(
      'Button is gray.',
      [],
      ['src/components/Button.tsx'],
    );
    assert.deepEqual(r, []);
  });

  it('does not fire when only the git diff (not changedFiles) touches rendering', () => {
    const diff = [
      'diff --git a/src/ui/Button.tsx b/src/ui/Button.tsx',
      'index 111..222 100644',
      '--- a/src/ui/Button.tsx',
      '+++ b/src/ui/Button.tsx',
      '@@ -1 +1,2 @@',
      ' a',
      '+b',
    ].join('\n');
    const r = detectRenderingSymptom('Button is gray.', [], undefined, diff);
    assert.deepEqual(r, []);
  });

  it('does not fire when the reviewer fully populated symptom_impact', () => {
    const r = detectRenderingSymptom(
      '버튼이 회색으로 표시돼요.',
      [],
      ['src/api/users.ts'],
      undefined,
      {
        before: '버튼이 회색으로 표시돼요.',
        after: '버튼이 파란색으로 표시됩니다.',
        causal_chain:
          'API가 active=true를 반환하도록 수정 → 버튼 렌더러가 primary 스타일을 사용.',
      },
    );
    assert.deepEqual(r, []);
  });

  it('does not fire when a screenshot artifact is provided', () => {
    const r = detectRenderingSymptom(
      'Button is gray.',
      [{ path: 'docs/bug.png', reason: 'screenshot of bug', priority: 'high' }],
      ['src/api/users.ts'],
    );
    assert.deepEqual(r, []);
  });

  it('does not fire on non-visual requests', () => {
    const r = detectRenderingSymptom(
      'The REST endpoint returns 500 when X is empty.',
      [],
      ['src/api/users.ts'],
    );
    assert.deepEqual(r, []);
  });
});

describe('enforceSymptomImpact', () => {
  it('fires when user_original_request is present but symptom_impact is null', () => {
    const r = enforceSymptomImpact('Button is gray.', null);
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'symptom-impact-missing');
    assert.equal(r[0].severity, 'revise');
  });

  it('fires when symptom_impact has empty fields', () => {
    const r = enforceSymptomImpact('Button is gray.', {
      before: 'Button is gray.',
      after: '',
      causal_chain: 'something',
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'symptom-impact-missing');
  });

  it('does not fire when all fields are present', () => {
    const r = enforceSymptomImpact('Button is gray.', {
      before: 'Button is gray.',
      after: 'Button is active-colored.',
      causal_chain: 'We pass isLoading=false to the button.',
    });
    assert.deepEqual(r, []);
  });

  it('does not fire when user_original_request is missing', () => {
    const r = enforceSymptomImpact(undefined, null);
    assert.deepEqual(r, []);
  });
});

describe('applyGates', () => {
  it('returns empty result when no gate fires', () => {
    const r = applyGates({
      phase: 'plan',
      userOriginalRequest: undefined,
      notesToReviewer: undefined,
      changedFiles: ['src/foo.ts'],
      gitDiff: undefined,
      artifactRefs: null,
      symptomImpact: null,
    });
    assert.deepEqual(r, { extraBlockingIssues: [], tripped: [] });
  });

  it('escalates to forcedHumanReview when any human-tier gate fires', () => {
    const r = applyGates({
      phase: 'code',
      userOriginalRequest: 'Fix the bug.',
      notesToReviewer: undefined,
      changedFiles: ['tests/a.test.ts'],
      gitDiff: undefined,
      artifactRefs: null,
      symptomImpact: null,
    });
    assert.ok(r.tripped.includes('test-only'));
    assert.equal(r.forcedVerdict, 'REVISE');
    assert.equal(r.forcedHumanReview, true);
    assert.ok(r.extraBlockingIssues.length > 0);
  });

  it('forces REVISE without human review when only revise-tier gates fire', () => {
    const r = applyGates({
      phase: 'plan',
      userOriginalRequest: 'Fix the parsing.',
      notesToReviewer: 'the failing test is pre-existing, skip it',
      changedFiles: ['src/parser.ts'],
      gitDiff: undefined,
      artifactRefs: null,
      symptomImpact: {
        before: 'parser crashes',
        after: 'parser handles empty input',
        causal_chain: 'add guard clause',
      },
    });
    assert.ok(r.tripped.includes('scope-punting'));
    assert.equal(r.forcedVerdict, 'REVISE');
    assert.equal(r.forcedHumanReview, false);
  });

  it('combines multiple gates when several fire at once', () => {
    const r = applyGates({
      phase: 'code',
      userOriginalRequest: '버튼이 안 보여요.',
      notesToReviewer: undefined,
      changedFiles: ['src/api/data.ts'],
      gitDiff: undefined,
      artifactRefs: null,
      symptomImpact: null,
    });
    assert.ok(r.tripped.includes('rendering-symptom'));
    assert.ok(r.tripped.includes('symptom-impact-missing'));
    assert.equal(r.forcedHumanReview, true);
  });
});
