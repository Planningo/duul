import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ExecutionPartitionInputSchema,
  ExecutionPartitionOutputSchema,
  ExecutionPartitionMcpOutputSchema,
  type ExecutionPartitionInput,
} from '../schemas/execution-partition.js';
import { getExecutionPartitionSystemPrompt, formatExecutionPartitionUserMessage } from '../prompts/execution-partition-system.js';
import { callReview } from '../services/reviewer.js';
import { resolveWorkspaceScope } from '../services/filesystem.js';
import { computeIterationMeta, isIterationLimitExceeded } from '../services/review-limits.js';

export function registerExecutionPartitionTool(server: McpServer): void {
  server.registerTool(
    'request_execution_partition',
    {
      title: 'DUUL Execution Partition (Project Manager)',
      description:
        'DUUL optional: Partition an approved plan into executable subtasks with dependency graph, ' +
        'spawn strategy, and handoff contracts. Use after plan review approval to ' +
        'determine whether work can be parallelized across multiple agents/workspaces.',
      inputSchema: ExecutionPartitionInputSchema,
      outputSchema: ExecutionPartitionMcpOutputSchema,
    },
    async (input) => {
      try {
        const args = input as ExecutionPartitionInput;
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

        const { parsed, reviewId } = await callReview({
          systemPrompt,
          userMessage,
          schemaName: 'execution_partition_output',
          outputSchema: ExecutionPartitionOutputSchema,
          workspaceScope: scope,
          previousReviewId: args.previous_review_id,
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

        const result = { ...parsed, review_id: reviewId, ...iterMeta };
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
