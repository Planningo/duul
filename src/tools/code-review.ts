import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CodeReviewInputSchema,
  CodeReviewOutputSchema,
  CodeReviewMcpOutputSchema,
  type CodeReviewInput,
} from '../schemas/code-review.js';
import { getCodeReviewSystemPrompt, formatCodeReviewUserMessage } from '../prompts/code-review-system.js';
import { callCodexReview } from '../services/openai.js';

export function registerCodeReviewTool(server: McpServer): void {
  server.registerTool(
    'request_code_review',
    {
      title: 'Code Review (Codex Strict QA)',
      description:
        'Submit code for peer review by Codex acting as a Strict QA Engineer. ' +
        'Requires the approved plan for context. Returns blocking issues, vulnerabilities, ' +
        'and optionally an optimized code snippet, or approval.',
      inputSchema: CodeReviewInputSchema,
      outputSchema: CodeReviewMcpOutputSchema,
    },
    async (input) => {
      try {
        const args = input as CodeReviewInput;
        const systemPrompt = getCodeReviewSystemPrompt();
        const userMessage = formatCodeReviewUserMessage(
          args.code,
          args.approved_plan,
          args.file_path,
          args.dependencies,
          args.relevant_code,
          args.notes_to_reviewer,
        );

        const { parsed, reviewId } = await callCodexReview({
          systemPrompt,
          userMessage,
          schemaName: 'code_review_output',
          outputSchema: CodeReviewOutputSchema,
          projectRoot: args.project_root,
          previousReviewId: args.previous_review_id,
        });

        const result = { ...parsed, review_id: reviewId };
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
        console.error(`[peer-reviewer] code-review error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Code review failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
