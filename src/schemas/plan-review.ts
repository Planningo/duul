import { z } from 'zod';
import { ArtifactRefSchema, ReviewerConfigSchema, IterationMetaOutputSchema } from './common.js';

export const ProjectContextSchema = z.object({
  file_tree: z
    .string()
    .max(2000, 'file_tree must be at most 2000 characters')
    .optional()
    .describe('Project file tree summary (top-level dirs + changed files only, max 2000 chars)'),
  changed_files: z
    .array(z.string())
    .optional()
    .describe('List of files related to this change'),
  package_versions: z
    .record(z.string(), z.string())
    .optional()
    .describe('Key package versions, e.g. { "express": "4.18.2" }'),
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
        'Include type definitions, interfaces, data models, and surrounding code ' +
        'that are relevant to the plan but not part of the change itself.',
    ),
});

export const PlanReviewInputSchema = z.object({
  plan: z.string().min(1, 'plan must not be empty').describe('Detailed implementation plan'),
  project_context: ProjectContextSchema.optional().describe('Structured project context'),
  constraints: z
    .array(z.string())
    .optional()
    .describe('Special constraints: performance, memory, security, etc.'),
  notes_to_reviewer: z
    .string()
    .optional()
    .describe(
      'Context or rebuttals from the caller to the reviewer. ' +
        'Use this to explain codebase-specific facts the reviewer cannot see, ' +
        'or to respond to blocking issues from a previous round.',
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
  previous_review_id: z
    .string()
    .optional()
    .describe(
      'Response ID from a previous review call. Pass this to maintain reviewer context ' +
        'across rounds — the reviewer will remember all files it read, previous feedback, ' +
        'and the full conversation history.',
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
      'Override the maximum iterations for this phase. Default: env MAX_PLAN_REVIEW_ITERATIONS or 7.',
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

export const PlanReviewOutputSchema = z.object({
  verdict: z.enum(['APPROVE', 'REVISE']).describe('Final verdict'),
  review_status: z.enum(['completed', 'incomplete']).describe(
    'Whether the review was fully completed. "incomplete" means the tool loop was exhausted before the reviewer could finish.',
  ),
  confidence: z.number().min(0).max(1).describe('Confidence in the verdict (0-1), advisory only'),
  requires_human_review: z.boolean().describe('Whether a human should review this'),
  architectural_analysis: z.string().describe('Structural pros/cons analysis'),
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
  edge_cases: z.array(z.string()).describe('Unconsidered edge cases'),
  checklist_for_implementation: z
    .array(z.string())
    .describe('Must-follow checklist for implementation'),
  follow_up_todos: z.array(z.string()).nullable().describe('Follow-up tasks after implementation'),
  missing_context: z.array(z.string()).nullable().describe('Files or context the reviewer could not access'),
  evidence_files: z.array(z.string()).nullable().describe('Files the reviewer examined as evidence'),
  used_tools: z.array(z.string()).nullable().describe('Tool calls made during review'),
  tool_exhaustion_reason: z.enum(['budget', 'repeat', 'round_limit']).nullable().describe(
    'If review_status is incomplete, the reason why the tool loop was exhausted',
  ),
  parallelization_hint: z.enum(['serial', 'parallel', 'hybrid']).nullable().describe(
    'Hint from reviewer: can this plan be parallelized?',
  ),
  coordination_risks: z.array(z.string()).nullable().describe('Coordination risks if parallelized'),
  recommended_subtask_boundaries: z.array(z.string()).nullable().describe('Suggested subtask split boundaries'),
});

// Extended output with server-added fields (not sent to the reviewer model, used for MCP response)
export const PlanReviewMcpOutputSchema = PlanReviewOutputSchema
  .extend({
    review_id: z.string().describe('Response ID for maintaining reviewer context across rounds. Pass as previous_review_id on the next call.'),
  })
  .merge(IterationMetaOutputSchema);

export type PlanReviewInput = z.infer<typeof PlanReviewInputSchema>;
export type PlanReviewOutput = z.infer<typeof PlanReviewOutputSchema>;
export type PlanReviewMcpOutput = z.infer<typeof PlanReviewMcpOutputSchema>;
