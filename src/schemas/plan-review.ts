import { z } from 'zod';

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
  project_root: z
    .string()
    .optional()
    .describe(
      'Absolute path to the project root directory. When provided, the reviewer gains ' +
        'read_file and list_directory tools to freely explore the codebase during review.',
    ),
  previous_review_id: z
    .string()
    .optional()
    .describe(
      'Response ID from a previous review call. Pass this to maintain reviewer context ' +
        'across rounds — the reviewer will remember all files it read, previous feedback, ' +
        'and the full conversation history.',
    ),
});

const BlockingIssueSchema = z.object({
  description: z.string().describe('What the issue is'),
  suggestion: z.string().describe('How to fix it'),
});

export const PlanReviewOutputSchema = z.object({
  verdict: z.enum(['APPROVE', 'REVISE']).describe('Final verdict'),
  confidence: z.number().min(0).max(1).describe('Confidence in the verdict (0-1), advisory only'),
  requires_human_review: z.boolean().describe('Whether a human should review this'),
  architectural_analysis: z.string().describe('Structural pros/cons analysis'),
  blocking_issues: z
    .array(BlockingIssueSchema)
    .describe('Issues that must be fixed before proceeding'),
  non_blocking_suggestions: z
    .array(z.string())
    .describe('Optional improvement suggestions'),
  edge_cases: z.array(z.string()).describe('Unconsidered edge cases'),
  checklist_for_implementation: z
    .array(z.string())
    .describe('Must-follow checklist for implementation'),
});

// Extended output with server-added review_id (not sent to OpenAI, used for MCP response)
export const PlanReviewMcpOutputSchema = PlanReviewOutputSchema.extend({
  review_id: z.string().describe('Response ID for maintaining reviewer context across rounds. Pass as previous_review_id on the next call.'),
});

export type PlanReviewInput = z.infer<typeof PlanReviewInputSchema>;
export type PlanReviewOutput = z.infer<typeof PlanReviewOutputSchema>;
export type PlanReviewMcpOutput = z.infer<typeof PlanReviewMcpOutputSchema>;
