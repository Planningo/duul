import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CodeReviewInputSchema,
  CodeReviewOutputSchema,
  CodeReviewMcpOutputSchema,
  type CodeReviewInput,
} from '../schemas/code-review.js';
import { getCodeReviewSystemPrompt, formatCodeReviewUserMessage } from '../prompts/code-review-system.js';
import { callReview } from '../services/reviewer.js';
import { resolveWorkspaceScope } from '../services/filesystem.js';
import { computeIterationMeta, isIterationLimitExceeded } from '../services/review-limits.js';

export function registerCodeReviewTool(server: McpServer): void {
  server.registerTool(
    'request_code_review',
    {
      title: 'DUUL Code Review (Strict QA)',
      description:
        'DUUL Phase 2: Submit code for review by an LLM acting as a Strict QA Engineer. ' +
        'Requires the approved plan for context. Returns blocking issues, vulnerabilities, ' +
        'and optionally an optimized code snippet, or approval.',
      inputSchema: CodeReviewInputSchema,
      outputSchema: CodeReviewMcpOutputSchema,
    },
    async (input) => {
      try {
        const args = input as CodeReviewInput;
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
            review_id: '',
            ...iterMeta,
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(limitResult, null, 2) }],
            structuredContent: limitResult,
          };
        }

        const scope = resolveWorkspaceScope(args);
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
          },
        );

        const { parsed, reviewId } = await callReview({
          systemPrompt,
          userMessage,
          schemaName: 'code_review_output',
          outputSchema: CodeReviewOutputSchema,
          workspaceScope: scope,
          previousReviewId: args.previous_review_id,
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
        console.error(`[duul] code-review error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Code review failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
