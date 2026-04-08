import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  PlanReviewInputSchema,
  PlanReviewOutputSchema,
  PlanReviewMcpOutputSchema,
  type PlanReviewInput,
} from '../schemas/plan-review.js';
import { getPlanReviewSystemPrompt, formatPlanReviewUserMessage } from '../prompts/plan-review-system.js';
import { callReview } from '../services/reviewer.js';
import { resolveWorkspaceScope } from '../services/filesystem.js';
import { computeIterationMeta, isIterationLimitExceeded } from '../services/review-limits.js';

export function registerPlanReviewTool(server: McpServer): void {
  server.registerTool(
    'request_plan_review',
    {
      title: 'DUUL Plan Review (Senior Architect)',
      description:
        'DUUL Phase 1: Submit a development plan for review by an LLM acting as a Senior Architect. ' +
        'Returns structured feedback with blocking issues, edge cases, and implementation checklist, or approval.',
      inputSchema: PlanReviewInputSchema,
      outputSchema: PlanReviewMcpOutputSchema,
    },
    async (input) => {
      try {
        const args = input as PlanReviewInput;
        const iterMeta = computeIterationMeta('plan', args.iteration_count, args.max_review_iterations);

        // Short-circuit if iteration limit exceeded
        if (isIterationLimitExceeded('plan', args.iteration_count, args.max_review_iterations)) {
          console.error(
            `[duul] Plan review iteration limit exceeded: ${args.iteration_count} > ${iterMeta.iteration_limit}`,
          );
          const limitResult = {
            verdict: 'REVISE' as const,
            review_status: 'incomplete' as const,
            confidence: 0,
            requires_human_review: true,
            architectural_analysis: `Iteration limit reached (${iterMeta.iteration_count}/${iterMeta.iteration_limit}). Human review required to continue.`,
            blocking_issues: [],
            merge_blockers: null,
            non_blocking_suggestions: [],
            edge_cases: [],
            checklist_for_implementation: [],
            follow_up_todos: null,
            missing_context: null,
            evidence_files: null,
            used_tools: null,
            tool_exhaustion_reason: null,
            parallelization_hint: null,
            coordination_risks: null,
            recommended_subtask_boundaries: null,
            review_id: '',
            ...iterMeta,
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(limitResult, null, 2) }],
            structuredContent: limitResult,
          };
        }

        const scope = resolveWorkspaceScope(args);
        const systemPrompt = getPlanReviewSystemPrompt();
        const userMessage = formatPlanReviewUserMessage(
          args.plan,
          args.project_context,
          args.constraints,
          args.notes_to_reviewer,
          {
            workingDirectories: args.working_directories,
            linkedRoots: args.linked_roots,
            changedFiles: args.changed_files,
            entrypoints: args.entrypoints,
            artifactRefs: args.artifact_refs,
            gitHeadSha: args.git_head_sha,
            previousGitHeadSha: args.previous_git_head_sha,
            workspaceName: args.workspace_name,
            setupScriptPresent: args.setup_script_present,
            runScriptPresent: args.run_script_present,
            environmentFilesExpected: args.environment_files_expected,
          },
        );

        const { parsed, reviewId } = await callReview({
          systemPrompt,
          userMessage,
          schemaName: 'plan_review_output',
          outputSchema: PlanReviewOutputSchema,
          workspaceScope: scope,
          previousReviewId: args.previous_review_id,
          reviewerConfig: args.reviewer_config,
          createFallback: (reason, usedTools) => ({
            verdict: 'REVISE' as const,
            review_status: 'incomplete' as const,
            confidence: 0,
            requires_human_review: true,
            architectural_analysis: `Review could not be completed — tool loop exhausted (${reason}).`,
            blocking_issues: [],
            merge_blockers: null,
            non_blocking_suggestions: [],
            edge_cases: [],
            checklist_for_implementation: [],
            follow_up_todos: null,
            missing_context: usedTools.length > 0 ? usedTools : ['No tools were called'],
            evidence_files: null,
            used_tools: usedTools,
            tool_exhaustion_reason: reason,
            parallelization_hint: null,
            coordination_risks: null,
            recommended_subtask_boundaries: null,
          }),
        });

        // Invariant: APPROVE with blocking_issues is always wrong — override to REVISE
        const verdict =
          parsed.verdict === 'APPROVE' && parsed.blocking_issues?.length > 0
            ? 'REVISE' as const
            : parsed.verdict;
        if (verdict !== parsed.verdict) {
          console.error(`[duul] Verdict overridden: APPROVE → REVISE (${parsed.blocking_issues.length} blocking issues)`);
        }

        const result = { ...parsed, verdict, review_id: reviewId, ...iterMeta };
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
        console.error(`[duul] plan-review error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Plan review failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
