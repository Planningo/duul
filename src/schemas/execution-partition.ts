import { z } from 'zod';
import { ArtifactRefSchema, ReviewerConfigSchema, IterationMetaOutputSchema, TokenUsageOutputSchema } from './common.js';

export const ExecutionPartitionInputSchema = z.object({
  approved_plan: z
    .string()
    .min(1, 'approved_plan must not be empty')
    .describe(
      'REQUIRED. Full text of the approved plan to partition into subtasks. Must NOT be omitted or empty. ' +
        'Pass the entire approved plan markdown so the partitioner can analyze dependencies and split work.',
    ),
  workspace_root: z
    .string()
    .min(1, 'workspace_root must not be empty')
    .describe(
      'REQUIRED. Absolute path to the workspace root directory. Must NOT be omitted. ' +
        'Example: "/Users/me/project". The partitioner uses this to verify file paths exist.',
    ),
  working_directories: z
    .array(z.string())
    .optional()
    .describe('Subdirectories within workspace_root to restrict scope to'),
  changed_files: z
    .array(z.string())
    .optional()
    .describe('Files changed in this scope'),
  entrypoints: z
    .array(z.string())
    .optional()
    .describe('Entry point files'),
  artifact_refs: z
    .array(ArtifactRefSchema)
    .max(30)
    .optional()
    .describe('References to important files with reason and priority. Max 30.'),
  constraints: z
    .array(z.string())
    .optional()
    .describe('Special constraints for partitioning'),
  max_parallelism: z
    .number()
    .min(1)
    .max(10)
    .optional()
    .describe('Maximum number of parallel subtasks. Default 3.'),
  previous_review_id: z
    .string()
    .optional()
    .describe(
      'Response ID from the plan review. Pass this to give the partitioner ' +
        'context from the plan review conversation.',
    ),
  // --- Iteration tracking ---
  iteration_count: z
    .number()
    .min(1)
    .optional()
    .describe('Current iteration number (1-based). Caller tracks and increments.'),
  max_review_iterations: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe('Override the default iteration limit for this request.'),
  // --- Reviewer config ---
  reviewer_config: ReviewerConfigSchema.optional().describe(
    'Per-request reviewer configuration. Overrides env defaults.',
  ),
});

const SubtaskScopeSchema = z.object({
  working_directories: z.array(z.string()).optional().describe('Subdirectories for this subtask'),
  changed_files: z.array(z.string()).optional().describe('Files this subtask will change'),
  entrypoints: z.array(z.string()).optional().describe('Entry points for this subtask'),
  artifact_refs: z.array(ArtifactRefSchema).optional().describe('Relevant files for this subtask'),
  linked_roots: z.array(z.string()).optional().describe('Read-only external roots this subtask needs'),
});

const SubtaskSchema = z.object({
  id: z.string().describe('Unique subtask identifier'),
  title: z.string().describe('Short title for the subtask'),
  goal: z.string().describe('What this subtask accomplishes'),
  can_run_in_parallel: z.boolean().describe('Whether this subtask can run concurrently with other parallel-eligible subtasks'),
  depends_on: z.array(z.string()).describe('IDs of subtasks that must complete before this one'),
  workspace_name_hint: z.string().describe('Suggested workspace name for this subtask'),
  spawn_strategy: z.enum(['new_workspace', 'reuse_workspace']).describe(
    'Whether to create a new isolated workspace or reuse the existing one. ' +
      'new_workspace for parallel tasks, reuse_workspace for serial/small changes.',
  ),
  scope: SubtaskScopeSchema.describe('File scope for this subtask'),
  handoff_contract: z.array(z.string()).describe(
    'Contracts this subtask must fulfill for downstream subtasks (e.g. "API endpoint /foo uses this schema")',
  ),
  completion_criteria: z.array(z.string()).describe('Conditions that must be met for this subtask to be complete'),
  review_focus: z.array(z.string()).describe('What the code reviewer should focus on for this subtask'),
  risk_level: z.enum(['high', 'medium', 'low']).describe('Risk level of this subtask'),
});

const RetryPolicySchema = z.object({
  max_retries: z.number().describe('Maximum retry attempts per subtask. Default 2.'),
  on_review_revise: z.literal('retry_subtask').describe('Action when review returns REVISE'),
  on_tool_exhaustion: z.literal('retry_with_narrower_scope').describe('Action when tool loop is exhausted'),
  on_conflict: z.literal('serialize_and_retry').describe('Action when two subtasks conflict on the same files'),
  on_blocker: z.literal('escalate_to_human').describe('Action when a blocking issue cannot be auto-resolved'),
  on_max_retries_exceeded: z.literal('abort_subtask_and_report').describe('Action when max retries exceeded'),
});

export const ExecutionPartitionOutputSchema = z.object({
  execution_mode: z.enum(['serial', 'parallel', 'hybrid']).describe(
    'Overall execution mode. serial = all subtasks sequential, parallel = all concurrent, hybrid = mixed.',
  ),
  rationale: z.string().describe('Why this execution mode and partitioning was chosen'),
  requires_human_checkpoint: z.boolean().describe(
    'Whether a human must confirm before execution begins (shared contracts, security, etc.)',
  ),
  human_checkpoint_reasons: z
    .array(z.string())
    .nullable()
    .describe('Why a human checkpoint is required'),
  spawn_strategy: z.enum(['new_workspace', 'reuse_workspace']).describe(
    'Default spawn strategy for subtasks. Individual subtasks can override.',
  ),
  handoff_artifact_pattern: z.string().describe(
    'File pattern for subtask results, e.g. ".context/subtasks/{subtask_id}.json"',
  ),
  subtask_result_schema_version: z.literal('1.0').describe('Version of the subtask result schema'),
  subtasks: z.array(SubtaskSchema).describe('Ordered list of subtasks'),
  global_checkpoints: z.array(z.string()).describe(
    'Points where all prior subtasks must complete before continuing',
  ),
  merge_order: z.array(z.string()).describe(
    'Order in which subtask branches should be merged',
  ),
  retry_policy: RetryPolicySchema.describe('Policy for handling failures during execution'),
});

export const ExecutionPartitionMcpOutputSchema = ExecutionPartitionOutputSchema
  .extend({ review_id: z.string().describe('Response ID for context continuity') })
  .merge(IterationMetaOutputSchema)
  .merge(TokenUsageOutputSchema);

export type ExecutionPartitionInput = z.infer<typeof ExecutionPartitionInputSchema>;
export type ExecutionPartitionOutput = z.infer<typeof ExecutionPartitionOutputSchema>;
export type ExecutionPartitionMcpOutput = z.infer<typeof ExecutionPartitionMcpOutputSchema>;
