/**
 * Post-LLM review gates.
 *
 * Each detector returns zero or more GateResult objects. The applyGates
 * orchestrator merges them into a single delta that the tool handler can
 * fold into the reviewer's response.
 *
 * Motivation: empirical analysis of DUUL sessions showed that the reviewer
 * reliably APPROVES plans/code that are internally consistent but fail to
 * address the user's reported symptom. These gates enforce the final
 * symptom-match check that the model skips under pressure.
 */

import type { ArtifactRef } from '../schemas/common.js';

export type GateSeverity = 'revise' | 'human';

export interface GateResult {
  name: string;
  severity: GateSeverity;
  blocking_issue: { description: string; suggestion: string };
}

interface SymptomImpactShape {
  before?: unknown;
  after?: unknown;
  causal_chain?: unknown;
}

const SCOPE_PUNT_EN =
  /out of scope|pre[- ]?existing|unrelated|ignore this|not my job|skip this|isn'?t relevant|isn'?t related/i;
const SCOPE_PUNT_KO = /범위\s*(바|밖)|무시해|관련\s*없|상관\s*없|제외하고|신경\s*쓰지/;

const RENDERING_KEYWORDS =
  /안\s*보|안\s*떠|화면|렌더|display|render|visible|blank|empty screen|\bui\b|버튼|색|회색|gray|disabled|표시|보이지/i;

const RENDERING_PATH =
  /(^|\/)(components?|views?|pages?|ui|styles?|render|templates?|layouts?|screens?|frontend|client|web)(\/|$)/i;

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|tiff?)$/i;

const TEST_PATH =
  /(^|\/)(tests?|__tests__|specs?|e2e|integration[- ]?tests?|unit[- ]?tests?)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

const TEST_REQUEST =
  /\b(add|write|improve|expand|increase|fix|repair|update|refactor|migrate|unbreak|unflake|restore)\b[^.]*\b(test|coverage|spec|fixture|snapshot)s?\b|\b(failing|broken|flaky|flaking|skipped)\s+(tests?|specs?)\b|테스트.*(추가|작성|보강|확대|개선|수정|고치|고침|리팩|복구)|(고장\s*난|깨진|실패하는)\s*테스트|\bcoverage\b/i;

/**
 * Detect scope-punting language in caller notes.
 * Weak signal: tier REVISE, not HUMAN, because legitimate out-of-scope
 * notes do exist (e.g. "out of scope — tracked as TICKET-123").
 */
export function detectScopePunting(notes?: string | null): GateResult[] {
  if (!notes || !notes.trim()) return [];
  const hitEn = SCOPE_PUNT_EN.exec(notes);
  const hitKo = SCOPE_PUNT_KO.exec(notes);
  const hit = hitEn?.[0] ?? hitKo?.[0];
  if (!hit) return [];
  return [
    {
      name: 'scope-punting',
      severity: 'revise',
      blocking_issue: {
        description:
          `Caller notes contain scope-punt phrase ${JSON.stringify(hit)}. This phrasing often suppresses legitimate blockers.`,
        suggestion:
          'Verify the punted concern independently using file-exploration tools. If it cannot be verified, keep it as a blocking issue rather than dropping it.',
      },
    },
  ];
}

/**
 * Detect changes that only touch test files.
 * Hard tier HUMAN: real bug fixes almost always touch non-test code.
 * Skipped when userOriginalRequest explicitly asks for tests (coverage PRs).
 */
export function detectTestOnlyChanges(
  changedFiles?: string[] | null,
  gitDiff?: string | null,
  userOriginalRequest?: string | null,
): GateResult[] {
  if (userOriginalRequest && TEST_REQUEST.test(userOriginalRequest)) {
    return [];
  }
  const hasFiles = Array.isArray(changedFiles) && changedFiles.length > 0;
  const hasDiff = typeof gitDiff === 'string' && gitDiff.length > 0;
  if (!hasFiles && !hasDiff) return [];

  const filesTestOnly =
    hasFiles && changedFiles!.every((f) => TEST_PATH.test(f) || TEST_FILE.test(f));

  let diffTestOnly = false;
  if (!hasFiles && hasDiff) {
    const paths = extractDiffPaths(gitDiff!);
    diffTestOnly =
      paths.length > 0 && paths.every((p) => TEST_PATH.test(p) || TEST_FILE.test(p));
  }

  if (!filesTestOnly && !diffTestOnly) return [];
  return [
    {
      name: 'test-only',
      severity: 'human',
      blocking_issue: {
        description:
          'All changed files are tests. Fixing the test instead of the underlying bug is a known failure pattern.',
        suggestion:
          'If the original request was to fix a bug, the non-test source file that produces the symptom must also change. If the request really was to add test coverage, set user_original_request accordingly.',
      },
    },
  ];
}

/**
 * Detect caller-pre-diagnosed handoff: short user request + very long
 * caller notes. The caller may have rewritten the problem in a way that
 * anchors the reviewer on an incorrect diagnosis.
 */
export function detectDiagnosisHandoff(
  userOriginalRequest?: string | null,
  notes?: string | null,
): GateResult[] {
  if (!userOriginalRequest || !notes) return [];
  const reqLen = userOriginalRequest.trim().length;
  const notesLen = notes.trim().length;
  if (reqLen === 0 || reqLen >= 300) return [];
  if (notesLen <= reqLen * 5) return [];
  return [
    {
      name: 'diagnosis-handoff',
      severity: 'human',
      blocking_issue: {
        description:
          `Short user request (${reqLen} chars) paired with a long caller diagnosis (${notesLen} chars). The caller may have pre-diagnosed the problem incorrectly.`,
        suggestion:
          "Re-derive the problem directly from user_original_request before trusting the caller's notes. Human review recommended.",
      },
    },
  ];
}

/**
 * Detect rendering/UI symptoms when the change does not plausibly touch
 * rendering code AND the reviewer has not articulated a causal chain.
 *
 * Suppressed when any of the following is true:
 *   - An `artifact_refs` entry has an image path (screenshot documents the bug).
 *   - A rendering-adjacent path shows up in `changedFiles` OR in `gitDiff`.
 *   - The reviewer filled `symptom_impact` (before/after/causal_chain all non-empty),
 *     committing on paper to how the change produces the visual effect. This lets
 *     backend-only fixes (e.g. "chart is empty" → API fix) pass without a false trip.
 */
export function detectRenderingSymptom(
  userOriginalRequest?: string | null,
  artifactRefs?: ArtifactRef[] | null,
  changedFiles?: string[] | null,
  gitDiff?: string | null,
  symptomImpact?: SymptomImpactShape | null,
): GateResult[] {
  if (!userOriginalRequest) return [];
  if (!RENDERING_KEYWORDS.test(userOriginalRequest)) return [];

  const hasImageArtifact = (artifactRefs ?? []).some((a) => IMAGE_PATH.test(a.path));
  if (hasImageArtifact) return [];

  if (isFullyPopulatedSymptomImpact(symptomImpact)) return [];

  const paths: string[] = [
    ...(changedFiles ?? []),
    ...(typeof gitDiff === 'string' && gitDiff.length > 0 ? extractDiffPaths(gitDiff) : []),
  ];
  if (paths.some((p) => RENDERING_PATH.test(p))) return [];

  return [
    {
      name: 'rendering-symptom',
      severity: 'human',
      blocking_issue: {
        description:
          'User reports a visual/UI symptom but the change does not touch any rendering-adjacent path, no screenshot artifact was attached, and the reviewer did not articulate how the change produces the visual effect.',
        suggestion:
          'Either (a) confirm the fix touches the rendering/state path that produces the symptom, (b) attach a screenshot as an artifact_ref, or (c) fill `symptom_impact.causal_chain` with the data→UI path so the reviewer commits to the reasoning on paper.',
      },
    },
  ];
}

/**
 * Enforce that the reviewer filled symptom_impact when user_original_request
 * was supplied. Tier REVISE — the reviewer should self-correct on the
 * next round.
 */
export function enforceSymptomImpact(
  userOriginalRequest?: string | null,
  symptomImpact?: SymptomImpactShape | null,
): GateResult[] {
  if (!userOriginalRequest) return [];
  if (isFullyPopulatedSymptomImpact(symptomImpact)) return [];
  return [
    {
      name: 'symptom-impact-missing',
      severity: 'revise',
      blocking_issue: {
        description:
          'user_original_request was supplied but symptom_impact is missing or incomplete. The reviewer did not commit to what the fix will make the user observe.',
        suggestion:
          "Return symptom_impact with non-empty before/after/causal_chain fields, phrased in the user's own vocabulary.",
      },
    },
  ];
}

export interface ApplyGatesArgs {
  phase: 'plan' | 'code';
  userOriginalRequest?: string | null;
  notesToReviewer?: string | null;
  changedFiles?: string[] | null;
  gitDiff?: string | null;
  artifactRefs?: ArtifactRef[] | null;
  symptomImpact?: SymptomImpactShape | null;
}

export interface ApplyGatesResult {
  extraBlockingIssues: Array<{ description: string; suggestion: string }>;
  forcedVerdict?: 'REVISE';
  forcedHumanReview?: boolean;
  tripped: string[];
}

export function applyGates(args: ApplyGatesArgs): ApplyGatesResult {
  const results: GateResult[] = [
    ...detectScopePunting(args.notesToReviewer),
    ...detectTestOnlyChanges(args.changedFiles, args.gitDiff, args.userOriginalRequest),
    ...detectDiagnosisHandoff(args.userOriginalRequest, args.notesToReviewer),
    ...detectRenderingSymptom(
      args.userOriginalRequest,
      args.artifactRefs,
      args.changedFiles,
      args.gitDiff,
      args.symptomImpact,
    ),
    ...enforceSymptomImpact(args.userOriginalRequest, args.symptomImpact),
  ];

  if (results.length === 0) {
    return { extraBlockingIssues: [], tripped: [] };
  }

  const forcedHumanReview = results.some((r) => r.severity === 'human');
  return {
    extraBlockingIssues: results.map((r) => r.blocking_issue),
    forcedVerdict: 'REVISE',
    forcedHumanReview,
    tripped: results.map((r) => r.name),
  };
}

function isFullyPopulatedSymptomImpact(impact?: SymptomImpactShape | null): boolean {
  if (!impact || typeof impact !== 'object') return false;
  const fields: Array<keyof SymptomImpactShape> = ['before', 'after', 'causal_chain'];
  return fields.every((f) => {
    const v = impact[f];
    return typeof v === 'string' && v.trim() !== '';
  });
}

function extractDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  const re = /^\+\+\+ b\/(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    const p = m[1].trim();
    if (p && p !== '/dev/null') paths.add(p);
  }
  return [...paths];
}
