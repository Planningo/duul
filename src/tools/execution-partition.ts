import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ExecutionPartitionInputSchema,
  ExecutionPartitionOutputSchema,
  ExecutionPartitionMcpOutputSchema,
  type ExecutionPartitionInput,
} from '../schemas/execution-partition.js';
import { getExecutionPartitionSystemPrompt, formatExecutionPartitionUserMessage } from '../prompts/execution-partition-system.js';
import { callReview } from '../services/reviewer.js';
import type { TokenUsage } from '../services/reviewer.js';
import { resolveWorkspaceScope } from '../services/filesystem.js';
import { computeIterationMeta, isIterationLimitExceeded, computeCostWarning } from '../services/review-limits.js';
import { logUsage } from '../services/usage-logger.js';

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, api_calls: 0, provider: 'none', model: 'none', estimated_cost_usd: null };

export function registerExecutionPartitionTool(server: McpServer): void {
  server.registerTool(
    'request_execution_partition',
    {
      title: 'DUUL Execution Partition (Project Manager)',
      description:
        'DUUL optional: Partition an approved plan into executable subtasks. ' +
        'REQUIRED fields: approved_plan (full plan markdown — do NOT leave empty), workspace_root (absolute path). ' +
        'Optional: working_directories, changed_files, entrypoints, artifact_refs, max_parallelism, iteration_count. ' +
        'NEVER call with an empty object — populate approved_plan with actual plan text before invoking. ' +
        'Returns dependency graph, spawn strategy, and handoff contracts.',
      inputSchema: ExecutionPartitionInputSchema,
      outputSchema: ExecutionPartitionMcpOutputSchema,
    },
    async (input) => {
      try {
        const args = input as ExecutionPartitionInput;

        if (
          !args ||
          typeof args.approved_plan !== 'string' ||
          args.approved_plan.trim().length < 20 ||
          typeof args.workspace_root !== 'string' ||
          args.workspace_root.trim().length === 0
        ) {
          const message =
            'ERROR: `approved_plan` and `workspace_root` fields are both required. ' +
            '`approved_plan` must contain the full plan text (min 20 chars). ' +
            '`workspace_root` must be an absolute path. ' +
            'You called request_execution_partition with missing or empty content. ' +
            'Retry with: { "approved_plan": "<plan text>", "workspace_root": "<absolute path>" }. ' +
            'Do NOT call this tool again with an empty input.';
          console.error(`[duul] execution-partition rejected: missing/empty approved_plan or workspace_root`);
          return {
            content: [{ type: 'text' as const, text: message }],
            isError: true,
          };
        }
        const iterMeta = computeIterationMeta('partition', args.iteration_count, args.max_review_iterations);

        // Short-circuit if iteration limit exceeded
        if (isIterationLimitExceeded('partition', args.iteration_count, args.max_review_iterations)) {
          console.error(
            `[duul] Partition iteration limit exceeded: ${args.iteration_count} > ${iterMeta.iteration_limit}`,
          );
          const limitResult = {
            execution_mode: 'serial' as const,
            rationale: `Iteration limit reached (${iterMeta.iteration_count}/${iterMeta.iteration_limit}). Human review required to continue.`,
            requires_human_checkpoint: true,
            human_checkpoint_reasons: [`Iteration limit reached — ${iterMeta.iteration_count}/${iterMeta.iteration_limit} iterations used.`],
            spawn_strategy: 'reuse_workspace' as const,
            handoff_artifact_pattern: '.context/subtasks/{subtask_id}.json',
            subtask_result_schema_version: '1.0' as const,
            subtasks: [{
              id: 'full-plan',
              title: 'Execute full plan serially (limit reached)',
              goal: args.approved_plan.slice(0, 200) + '...',
              can_run_in_parallel: false,
              depends_on: [],
              workspace_name_hint: 'main',
              spawn_strategy: 'reuse_workspace' as const,
              scope: {
                working_directories: args.working_directories,
                changed_files: args.changed_files,
                entrypoints: args.entrypoints,
              },
              handoff_contract: [],
              completion_criteria: ['All items in the approved plan are implemented'],
              review_focus: ['Full plan implementation'],
              risk_level: 'medium' as const,
            }],
            global_checkpoints: [],
            merge_order: ['full-plan'],
            retry_policy: {
              max_retries: 2,
              on_review_revise: 'retry_subtask' as const,
              on_tool_exhaustion: 'retry_with_narrower_scope' as const,
              on_conflict: 'serialize_and_retry' as const,
              on_blocker: 'escalate_to_human' as const,
              on_max_retries_exceeded: 'abort_subtask_and_report' as const,
            },
            review_id: '',
            ...iterMeta,
            cost_warning: null,
            token_usage: ZERO_USAGE,
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(limitResult, null, 2) }],
            structuredContent: limitResult,
          };
        }

        const scope = resolveWorkspaceScope(args);
        const systemPrompt = getExecutionPartitionSystemPrompt();
        const userMessage = formatExecutionPartitionUserMessage(
          args.approved_plan,
          args.constraints,
          {
            changedFiles: args.changed_files,
            entrypoints: args.entrypoints,
            artifactRefs: args.artifact_refs,
            workingDirectories: args.working_directories,
          },
          args.max_parallelism,
        );

        const { parsed, reviewId, usage } = await callReview({
          systemPrompt,
          userMessage,
          schemaName: 'execution_partition_output',
          outputSchema: ExecutionPartitionOutputSchema,
          workspaceScope: scope,
          previousReviewId: args.previous_review_id,
          toolName: 'partition',
          reviewerConfig: args.reviewer_config,
          createFallback: (_reason, _usedTools) => ({
            execution_mode: 'serial' as const,
            rationale: 'Partition could not be completed — tool loop exhausted. Defaulting to serial execution.',
            requires_human_checkpoint: true,
            human_checkpoint_reasons: ['Partition was incomplete — human should verify before proceeding.'],
            spawn_strategy: 'reuse_workspace' as const,
            handoff_artifact_pattern: '.context/subtasks/{subtask_id}.json',
            subtask_result_schema_version: '1.0' as const,
            subtasks: [{
              id: 'full-plan',
              title: 'Execute full plan serially',
              goal: args.approved_plan.slice(0, 200) + '...',
              can_run_in_parallel: false,
              depends_on: [],
              workspace_name_hint: 'main',
              spawn_strategy: 'reuse_workspace' as const,
              scope: {
                working_directories: args.working_directories,
                changed_files: args.changed_files,
                entrypoints: args.entrypoints,
              },
              handoff_contract: [],
              completion_criteria: ['All items in the approved plan are implemented'],
              review_focus: ['Full plan implementation'],
              risk_level: 'medium' as const,
            }],
            global_checkpoints: [],
            merge_order: ['full-plan'],
            retry_policy: {
              max_retries: 2,
              on_review_revise: 'retry_subtask' as const,
              on_tool_exhaustion: 'retry_with_narrower_scope' as const,
              on_conflict: 'serialize_and_retry' as const,
              on_blocker: 'escalate_to_human' as const,
              on_max_retries_exceeded: 'abort_subtask_and_report' as const,
            },
          }),
        });

        const result = {
          ...parsed,
          review_id: reviewId,
          ...iterMeta,
          cost_warning: computeCostWarning(iterMeta, usage.estimated_cost_usd),
          token_usage: usage,
        };

        logUsage('execution_partition', result.token_usage, {
          review_id: reviewId,
          iteration_count: iterMeta.iteration_count,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[duul] execution-partition error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Execution partition failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
