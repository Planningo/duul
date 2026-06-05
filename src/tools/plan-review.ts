import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  PlanReviewInputSchema,
  PlanReviewOutputSchema,
  PlanReviewMcpOutputSchema,
  type PlanReviewInput,
} from '../schemas/plan-review.js';
import { getPlanReviewSystemPrompt, formatPlanReviewUserMessage } from '../prompts/plan-review-system.js';
import { callReview } from '../services/reviewer.js';
import type { TokenUsage } from '../services/reviewer.js';
import { resolveWorkspaceScope, getGitDiff, resolveInlineOrFile } from '../services/filesystem.js';
import { computeIterationMeta, isIterationLimitExceeded, computeCostWarning } from '../services/review-limits.js';
import { logUsage } from '../services/usage-logger.js';
import { applyGates } from '../services/review-gates.js';

const MAX_INLINE_DIFF_CHARS = 50_000;

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, api_calls: 0, provider: 'none', model: 'none', estimated_cost_usd: null };

export function registerPlanReviewTool(server: McpServer): void {
  server.registerTool(
    'request_plan_review',
    {
      title: 'DUUL Plan Review (Senior Architect)',
      description:
        'DUUL Phase 1: Submit an implementation plan for senior-architect review. ' +
        'Provide the plan EITHER inline via `plan` OR (preferred for large plans) by writing it to a file ' +
        'and passing `plan_file` (relative path, e.g. ".duul/plan.md") plus `workspace_root`. ' +
        'Exactly one of plan/plan_file is required. ' +
        'Optional: project_context, changed_files, artifact_refs, user_original_request, previous_review_id, iteration_count. ' +
        'Returns blocking issues, edge cases, implementation checklist, or APPROVE verdict.',
      inputSchema: PlanReviewInputSchema,
      outputSchema: PlanReviewMcpOutputSchema,
    },
    async (input) => {
      try {
        const args = input as PlanReviewInput;

        const scope = resolveWorkspaceScope(args);

        // Resolve the plan from inline `plan` or from `plan_file` (large-plan escape hatch).
        let planText: string | undefined;
        try {
          planText = await resolveInlineOrFile({ inline: args.plan, file: args.plan_file, scope, label: 'plan' });
        } catch (readErr: unknown) {
          const reason = readErr instanceof Error ? readErr.message : String(readErr);
          console.error(`[duul] plan-review plan_file read failed: ${reason}`);
          return {
            content: [{ type: 'text' as const, text: `ERROR: could not read plan_file. ${reason}` }],
            isError: true,
          };
        }

        if (typeof planText !== 'string' || planText.trim().length < 20) {
          const message =
            'ERROR: a plan is required and must contain the full plan markdown (at least 20 chars). ' +
            'You called request_plan_review without usable plan content. ' +
            'Either inline it — { "plan": "<your complete plan text>", ... } — or, for a large plan, ' +
            'write it to a file first and pass { "plan_file": ".duul/plan.md", "workspace_root": "<absolute path>" }. ' +
            'Always include workspace_root and user_original_request. Do NOT call this tool again with an empty input.';
          console.error(`[duul] plan-review rejected: missing/empty plan content`);
          return {
            content: [{ type: 'text' as const, text: message }],
            isError: true,
          };
        }
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
            user_original_request_echo: null,
            symptom_impact: null,
            symptom_match_notes: null,
            gates_tripped: null,
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

        // Auto-generate git diff if not provided
        let gitDiff = args.git_diff;
        if (!gitDiff && scope?.root && args.changed_files?.length) {
          try {
            const diffResult = await getGitDiff(scope.root, args.git_diff_base ?? 'HEAD', args.changed_files, scope);
            if (diffResult && !diffResult.startsWith('Error') && !diffResult.startsWith('No differences')) {
              gitDiff = diffResult.length > MAX_INLINE_DIFF_CHARS
                ? diffResult.slice(0, MAX_INLINE_DIFF_CHARS) + `\n\n[truncated — diff exceeded ${MAX_INLINE_DIFF_CHARS} chars]`
                : diffResult;
            }
          } catch {
            // Diff generation is best-effort, continue without it
          }
        }

        const systemPrompt = getPlanReviewSystemPrompt();
        const userMessage = formatPlanReviewUserMessage(
          planText,
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
            gitDiff,
          },
          args.user_original_request,
        );

        const { parsed, reviewId, usage } = await callReview({
          systemPrompt,
          userMessage,
          schemaName: 'plan_review_output',
          outputSchema: PlanReviewOutputSchema,
          workspaceScope: scope,
          previousReviewId: args.previous_review_id,
          toolName: 'plan',
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
            user_original_request_echo: null,
            symptom_impact: null,
            symptom_match_notes: null,
            gates_tripped: null,
          }),
        });

        // Invariant: APPROVE with blocking_issues is always wrong — override to REVISE
        let verdict =
          parsed.verdict === 'APPROVE' && parsed.blocking_issues?.length > 0
            ? ('REVISE' as const)
            : parsed.verdict;
        if (verdict !== parsed.verdict) {
          console.error(`[duul] Verdict overridden: APPROVE → REVISE (${parsed.blocking_issues.length} blocking issues)`);
        }

        // Post-LLM gates
        const gates = applyGates({
          phase: 'plan',
          userOriginalRequest: args.user_original_request,
          notesToReviewer: args.notes_to_reviewer,
          changedFiles: args.changed_files,
          gitDiff,
          artifactRefs: args.artifact_refs,
          symptomImpact: parsed.symptom_impact,
        });
        let requires_human_review = parsed.requires_human_review;
        let blocking_issues = parsed.blocking_issues;
        if (gates.tripped.length > 0) {
          if (gates.forcedVerdict === 'REVISE') verdict = 'REVISE';
          if (gates.forcedHumanReview) requires_human_review = true;
          blocking_issues = [...blocking_issues, ...gates.extraBlockingIssues];
          console.error(`[duul] Plan gates tripped: ${gates.tripped.join(', ')}`);
        }

        const result = {
          ...parsed,
          verdict,
          requires_human_review,
          blocking_issues,
          gates_tripped: gates.tripped.length > 0 ? gates.tripped : null,
          review_id: reviewId,
          ...iterMeta,
          cost_warning: computeCostWarning(iterMeta, usage.estimated_cost_usd),
          token_usage: usage,
        };

        logUsage('plan_review', result.token_usage, {
          verdict,
          review_id: reviewId,
          iteration_count: iterMeta.iteration_count,
          workspace_name: args.workspace_name,
          gates_tripped: result.gates_tripped,
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
        console.error(`[duul] plan-review error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Plan review failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
