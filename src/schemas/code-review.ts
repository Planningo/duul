import { z } from 'zod';
import { ArtifactRefSchema, ReviewerConfigSchema, IterationMetaOutputSchema, TokenUsageOutputSchema } from './common.js';

export const DependenciesSchema = z.object({
  runtime: z
    .record(z.string(), z.string())
    .optional()
    .describe('Runtime package versions, e.g. { "express": "4.18.2" }'),
  dev: z
    .record(z.string(), z.string())
    .optional()
    .describe('Dev dependency versions, e.g. { "typescript": "5.8.0" }'),
});

export const CodeReviewInputSchema = z.object({
  code: z
    .string()
    .min(1, 'code must not be empty')
    .describe(
      'REQUIRED. The full code being reviewed (markdown code block or raw source). Must NOT be omitted or empty. ' +
        'For multi-file diffs, concatenate all changed code with file headers. ' +
        'Pass actual code content here — never call this tool with an empty object.',
    ),
  approved_plan: z
    .string()
    .min(1, 'approved_plan must not be empty')
    .describe(
      'REQUIRED. Full text of the plan approved in Phase 1. Must NOT be omitted. ' +
        'Pass the entire approved plan content (markdown) so the reviewer can verify the code matches it.',
    ),
  file_path: z.string().optional().describe('File path for contextual feedback'),
  dependencies: DependenciesSchema.optional().describe('Related library version info'),
  relevant_code: z
    .array(
      z.object({
        file_path: z.string().describe('File path'),
        code: z.string().describe('Relevant code snippet (types, interfaces, functions, classes)'),
      }),
    )
    .optional()
    .describe(
      'Related code snippets the reviewer should see for full context. ' +
        'Include type definitions, data models, and surrounding code that the reviewed code depends on.',
    ),
  notes_to_reviewer: z
    .string()
    .optional()
    .describe(
      'Context or rebuttals from the caller to the reviewer. ' +
        'Use this to explain codebase-specific facts the reviewer cannot see, ' +
        'or to respond to blocking issues from a previous round.',
    ),
  user_original_request: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "The user's original, unedited problem statement (not paraphrased by the caller). " +
        'Used by the reviewer to verify the code actually makes the reported symptom go away.',
    ),
  // --- Workspace-aware scope fields ---
  workspace_root: z
    .string()
    .optional()
    .describe(
      'Absolute path to the workspace root directory. Preferred over project_root. ' +
        'When provided, the reviewer gains file exploration tools scoped to this workspace.',
    ),
  project_root: z
    .string()
    .optional()
    .describe(
      '[DEPRECATED — use workspace_root] Absolute path to the project root directory. ' +
        'Used as fallback when workspace_root is not provided.',
    ),
  working_directories: z
    .array(z.string())
    .optional()
    .describe(
      'Subdirectories within workspace_root to restrict file access to. ' +
        'Acts as a sparse-checkout-like allowlist. If omitted, entire workspace_root is accessible.',
    ),
  linked_roots: z
    .array(z.string())
    .max(5)
    .optional()
    .describe(
      'Additional read-only workspace roots the reviewer can access. ' +
        'Each must be a valid absolute path (3+ depth). Max 5.',
    ),
  changed_files: z
    .array(z.string())
    .optional()
    .describe('Files changed in this review scope (top-level, separate from project_context)'),
  entrypoints: z
    .array(z.string())
    .optional()
    .describe('Entry point files the reviewer should start from'),
  artifact_refs: z
    .array(ArtifactRefSchema)
    .max(30)
    .optional()
    .describe('References to important files with reason and priority. Max 30.'),
  tracked_only: z
    .boolean()
    .optional()
    .describe('When true, only git-tracked files are accessible to the reviewer.'),
  // --- Git metadata ---
  git_head_sha: z.string().optional().describe('Current git HEAD SHA for this review'),
  previous_git_head_sha: z.string().optional().describe(
    'Git HEAD SHA from the previous review round. Used with git_head_sha to detect stale context.',
  ),
  workspace_name: z.string().optional().describe('Name of the workspace (for logging/identification)'),
  // --- Setup/Run metadata ---
  setup_script_present: z.boolean().optional().describe('Whether a setup script exists in the workspace'),
  run_script_present: z.boolean().optional().describe('Whether a run/start script exists in the workspace'),
  environment_files_expected: z.array(z.string()).optional().describe(
    'Environment files expected but not tracked (e.g. [".env", ".env.local"]). Prevents false positives.',
  ),
  // --- Git diff ---
  git_diff: z
    .string()
    .optional()
    .describe(
      'Pre-computed git diff to include in review context. If omitted and workspace_root + changed_files are provided, ' +
        'the diff is auto-generated.',
    ),
  git_diff_base: z
    .string()
    .optional()
    .describe('Base ref for auto-generated git diff (e.g. "HEAD", "main"). Default: "HEAD".'),
  previous_review_id: z
    .string()
    .optional()
    .describe(
      'Response ID from a previous review call. Pass this to maintain reviewer context ' +
        'across rounds and across phases — the reviewer will remember the plan review ' +
        'conversation when doing code review.',
    ),
  // --- Iteration tracking ---
  iteration_count: z
    .number()
    .min(1)
    .optional()
    .describe(
      'Current iteration number (1-based). The caller MUST increment this on each call. ' +
        'When this reaches the iteration limit, the server returns requires_human_review: true.',
    ),
  max_review_iterations: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe(
      'Override the maximum iterations for this phase. Default: env MAX_CODE_REVIEW_ITERATIONS or 7.',
    ),
  // --- Reviewer config ---
  reviewer_config: ReviewerConfigSchema.optional().describe(
    'Per-request reviewer configuration. Overrides env defaults.',
  ),
});

const BlockingIssueSchema = z.object({
  description: z.string().describe('What the issue is'),
  suggestion: z.string().describe('How to fix it'),
});

const VulnerabilitySchema = z.object({
  type: z.string().describe('Vulnerability type, e.g. "SQL Injection", "Race Condition"'),
  description: z.string().describe('Detailed description of the vulnerability'),
  severity: z.enum(['critical', 'high', 'medium']).describe('Severity level'),
});

export const CodeReviewOutputSchema = z.object({
  verdict: z.enum(['APPROVE', 'REVISE']).describe('Final verdict'),
  review_status: z.enum(['completed', 'incomplete']).describe(
    'Whether the review was fully completed. "incomplete" means the tool loop was exhausted before the reviewer could finish.',
  ),
  confidence: z.number().min(0).max(1).describe('Confidence in the verdict (0-1), advisory only'),
  requires_human_review: z.boolean().describe('Whether a human should review this'),
  logic_validation: z.string().describe('How accurately the code implements the approved plan'),
  blocking_issues: z
    .array(BlockingIssueSchema)
    .describe('Issues that must be fixed before proceeding'),
  merge_blockers: z
    .array(BlockingIssueSchema)
    .nullable()
    .describe('Subset of blocking_issues that should block merge. Null if same as blocking_issues.'),
  non_blocking_suggestions: z
    .array(z.string())
    .describe('Optional improvement suggestions'),
  vulnerabilities: z
    .array(VulnerabilitySchema)
    .describe('Security and performance vulnerabilities found'),
  optimized_snippet: z
    .string()
    .nullable()
    .describe('Codex-suggested optimized code block, or null if not needed'),
  follow_up_todos: z.array(z.string()).nullable().describe('Follow-up tasks after implementation'),
  missing_context: z.array(z.string()).nullable().describe('Files or context the reviewer could not access'),
  evidence_files: z.array(z.string()).nullable().describe('Files the reviewer examined as evidence'),
  used_tools: z.array(z.string()).nullable().describe('Tool calls made during review'),
  tool_exhaustion_reason: z.enum(['budget', 'repeat', 'round_limit']).nullable().describe(
    'If review_status is incomplete, the reason why the tool loop was exhausted',
  ),
  user_original_request_echo: z.string().nullable().describe(
    'Verbatim echo of user_original_request so the reviewer commits to what it was asked to solve. Null only if the caller omitted user_original_request.',
  ),
  symptom_impact: z
    .object({
      before: z.string().describe('Observable symptom the user reported, in their own terms.'),
      after: z.string().describe('What the user observes now that this code is merged.'),
      causal_chain: z.string().describe("Why the code change causes 'before' → 'after'."),
    })
    .nullable()
    .describe(
      'How the code changes the user-visible symptom. Null only if user_original_request was not supplied.',
    ),
  symptom_match_notes: z.string().nullable().describe(
    'If code does NOT clearly address the reported symptom, explain the gap here. Null if fully addressed.',
  ),
  gates_tripped: z.array(z.string()).nullable().describe(
    'Server-populated list of post-LLM gate names that fired. Reviewer should leave null.',
  ),
});

// Extended output with server-added fields (not sent to the reviewer model, used for MCP response)
export const CodeReviewMcpOutputSchema = CodeReviewOutputSchema
  .extend({
    review_id: z.string().describe('Response ID for maintaining reviewer context across rounds. Pass as previous_review_id on the next call.'),
  })
  .merge(IterationMetaOutputSchema)
  .merge(TokenUsageOutputSchema);

export type CodeReviewInput = z.infer<typeof CodeReviewInputSchema>;
export type CodeReviewOutput = z.infer<typeof CodeReviewOutputSchema>;
export type CodeReviewMcpOutput = z.infer<typeof CodeReviewMcpOutputSchema>;
