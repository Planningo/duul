/**
 * Resolve iteration limits from env vars and per-request overrides.
 */

const DEFAULT_PLAN_LIMIT = 7;
const DEFAULT_CODE_LIMIT = 7;
const DEFAULT_PARTITION_LIMIT = 5;

export type ReviewPhase = 'plan' | 'code' | 'partition';

function envInt(name: string): number | undefined {
  const val = process.env[name];
  if (!val) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

/**
 * Get the effective iteration limit for a phase.
 * Priority: per-request override > env var > default.
 */
export function getIterationLimit(phase: ReviewPhase, requestOverride?: number): number {
  if (requestOverride !== undefined && requestOverride >= 1 && requestOverride <= 20) {
    return requestOverride;
  }

  switch (phase) {
    case 'plan':
      return envInt('MAX_PLAN_REVIEW_ITERATIONS') ?? DEFAULT_PLAN_LIMIT;
    case 'code':
      return envInt('MAX_CODE_REVIEW_ITERATIONS') ?? DEFAULT_CODE_LIMIT;
    case 'partition':
      return envInt('MAX_PARTITION_ITERATIONS') ?? DEFAULT_PARTITION_LIMIT;
  }
}

export interface IterationMeta {
  iteration_count: number;
  iteration_limit: number;
  iteration_limit_reached: boolean;
}

/**
 * Compute iteration metadata for a tool response.
 * Returns the metadata to merge into the MCP output.
 *
 * `iteration_limit_reached` is true when `count > limit`, meaning the current
 * call was short-circuited (not sent to the reviewer). This matches the
 * semantics of `isIterationLimitExceeded`.
 *
 * When `count === limit`, the review still runs (last allowed iteration),
 * and `iteration_limit_reached` is false. The caller should note that the
 * NEXT call will be blocked.
 */
export function computeIterationMeta(
  phase: ReviewPhase,
  callerIterationCount?: number,
  requestMaxOverride?: number,
): IterationMeta {
  const limit = getIterationLimit(phase, requestMaxOverride);
  const count = callerIterationCount ?? 1;
  return {
    iteration_count: count,
    iteration_limit: limit,
    iteration_limit_reached: count > limit,
  };
}

/**
 * Check if iteration limit is exceeded BEFORE calling the reviewer.
 * Returns true when `count > limit` — the call should be short-circuited
 * with `requires_human_review: true`.
 *
 * When `count === limit`, this returns false — the review still runs
 * (last allowed iteration).
 */
export function isIterationLimitExceeded(
  phase: ReviewPhase,
  callerIterationCount?: number,
  requestMaxOverride?: number,
): boolean {
  if (callerIterationCount === undefined) return false;
  const limit = getIterationLimit(phase, requestMaxOverride);
  return callerIterationCount > limit;
}
