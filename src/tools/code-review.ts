import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CodeReviewInputSchema,
  CodeReviewOutputSchema,
  CodeReviewMcpOutputSchema,
  type CodeReviewInput,
} from '../schemas/code-review.js';
import { getCodeReviewSystemPrompt, formatCodeReviewUserMessage } from '../prompts/code-review-system.js';
import { callReview } from '../services/reviewer.js';
import type { TokenUsage } from '../services/reviewer.js';
import { resolveWorkspaceScope, getGitDiff } from '../services/filesystem.js';
import { computeIterationMeta, isIterationLimitExceeded, computeCostWarning } from '../services/review-limits.js';
import { logUsage } from '../services/usage-logger.js';
import { applyGates } from '../services/review-gates.js';

const MAX_INLINE_DIFF_CHARS = 50_000;

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, api_calls: 0, provider: 'none', model: 'none', estimated_cost_usd: null };

export function registerCodeReviewTool(server: McpServer): void {
  server.registerTool(
    'request_code_review',
    {
      title: 'DUUL Code Review (Strict QA)',
      description:
        'DUUL Phase 2: Submit code for strict QA review. ' +
        'REQUIRED fields: code (the full code being reviewed — do NOT leave empty), approved_plan (the Phase 1 approved plan text). ' +
        'Optional: workspace_root, file_path, changed_files, artifact_refs, previous_review_id, iteration_count. ' +
        'NEVER call with an empty object — populate code and approved_plan with actual content before invoking. ' +
        'Returns blocking issues, vulnerabilities, optimized snippet, or APPROVE verdict.',
      inputSchema: CodeReviewInputSchema,
      outputSchema: CodeReviewMcpOutputSchema,
    },
    async (input) => {
      try {
        const args = input as CodeReviewInput;

        if (
          !args ||
          typeof args.code !== 'string' ||
          args.code.trim().length < 5 ||
          typeof args.approved_plan !== 'string' ||
          args.approved_plan.trim().length < 20
        ) {
          const message =
            'ERROR: `code` and `approved_plan` fields are both required. ' +
            '`code` must contain the actual code being reviewed (min 5 chars). ' +
            '`approved_plan` must contain the full plan text approved in Phase 1 (min 20 chars). ' +
            'You called request_code_review with missing or empty content. ' +
            'Retry with: { "code": "<your code>", "approved_plan": "<plan text>", "workspace_root": "<absolute path>", "iteration_count": 1 }. ' +
            'Do NOT call this tool again with an empty input.';
          console.error(`[duul] code-review rejected: missing/empty code or approved_plan field`);
          return {
            content: [{ type: 'text' as const, text: message }],
            isError: true,
          };
        }
        const iterMeta = computeIterationMeta('code', args.iteration_count, args.max_review_iterations);

        // Short-circuit if iteration limit exceeded
        if (isIterationLimitExceeded('code', args.iteration_count, args.max_review_iterations)) {
          console.error(
            `[duul] Code review iteration limit exceeded: ${args.iteration_count} > ${iterMeta.iteration_limit}`,
          );
          const limitResult = {
            verdict: 'REVISE' as const,
            review_status: 'incomplete' as const,
            confidence: 0,
            requires_human_review: true,
            logic_validation: `Iteration limit reached (${iterMeta.iteration_count}/${iterMeta.iteration_limit}). Human review required to continue.`,
            blocking_issues: [],
            merge_blockers: null,
            non_blocking_suggestions: [],
            vulnerabilities: [],
            optimized_snippet: null,
            follow_up_todos: null,
            missing_context: null,
            evidence_files: null,
            used_tools: null,
            tool_exhaustion_reason: null,
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

        const scope = resolveWorkspaceScope(args);

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

        const systemPrompt = getCodeReviewSystemPrompt();
        const userMessage = formatCodeReviewUserMessage(
          args.code,
          args.approved_plan,
          args.file_path,
          args.dependencies,
          args.relevant_code,
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
          schemaName: 'code_review_output',
          outputSchema: CodeReviewOutputSchema,
          workspaceScope: scope,
          previousReviewId: args.previous_review_id,
          toolName: 'code',
          reviewerConfig: args.reviewer_config,
          createFallback: (reason, usedTools) => ({
            verdict: 'REVISE' as const,
            review_status: 'incomplete' as const,
            confidence: 0,
            requires_human_review: true,
            logic_validation: `Review could not be completed — tool loop exhausted (${reason}).`,
            blocking_issues: [],
            merge_blockers: null,
            non_blocking_suggestions: [],
            vulnerabilities: [],
            optimized_snippet: null,
            follow_up_todos: null,
            missing_context: usedTools.length > 0 ? usedTools : ['No tools were called'],
            evidence_files: null,
            used_tools: usedTools,
            tool_exhaustion_reason: reason,
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
          phase: 'code',
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
          console.error(`[duul] Code gates tripped: ${gates.tripped.join(', ')}`);
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

        logUsage('code_review', result.token_usage, {
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
        console.error(`[duul] code-review error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Code review failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
