import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  PlanReviewInputSchema,
  PlanReviewOutputSchema,
  PlanReviewMcpOutputSchema,
  type PlanReviewInput,
} from '../schemas/plan-review.js';
import { getPlanReviewSystemPrompt, formatPlanReviewUserMessage } from '../prompts/plan-review-system.js';
import { callCodexReview } from '../services/openai.js';

export function registerPlanReviewTool(server: McpServer): void {
  server.registerTool(
    'request_plan_review',
    {
      title: 'Plan Review (Codex Senior Architect)',
      description:
        'Submit a development plan for peer review by Codex acting as a Senior Architect. ' +
        'Returns structured feedback with blocking issues, edge cases, and implementation checklist, or approval.',
      inputSchema: PlanReviewInputSchema,
      outputSchema: PlanReviewMcpOutputSchema,
    },
    async (input) => {
      try {
        const args = input as PlanReviewInput;
        const systemPrompt = getPlanReviewSystemPrompt();
        const userMessage = formatPlanReviewUserMessage(
          args.plan,
          args.project_context,
          args.constraints,
          args.notes_to_reviewer,
        );

        const { parsed, reviewId } = await callCodexReview({
          systemPrompt,
          userMessage,
          schemaName: 'plan_review_output',
          outputSchema: PlanReviewOutputSchema,
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
        console.error(`[peer-reviewer] plan-review error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Plan review failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
