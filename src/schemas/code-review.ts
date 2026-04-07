import { z } from 'zod';

export const DependenciesSchema = z.object({
  runtime: z
    .record(z.string(), z.string())
    .optional()
    .describe('Runtime package versions, e.g. { "express": "4.18.2" }'),
  dev: z
    .record(z.string(), z.string())
    .optional()
    .describe('Dev dependency versions, e.g. { "typescript": "5.8.0" }'),
});

export const CodeReviewInputSchema = z.object({
  code: z.string().min(1, 'code must not be empty').describe('The code to review'),
  approved_plan: z
    .string()
    .min(1, 'approved_plan must not be empty')
    .describe('The previously approved plan this code implements'),
  file_path: z.string().optional().describe('File path for contextual feedback'),
  dependencies: DependenciesSchema.optional().describe('Related library version info'),
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
        'Include type definitions, data models, and surrounding code that the reviewed code depends on.',
    ),
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
        'across rounds and across phases — the reviewer will remember the plan review ' +
        'conversation when doing code review.',
    ),
});

const BlockingIssueSchema = z.object({
  description: z.string().describe('What the issue is'),
  suggestion: z.string().describe('How to fix it'),
});

const VulnerabilitySchema = z.object({
  type: z.string().describe('Vulnerability type, e.g. "SQL Injection", "Race Condition"'),
  description: z.string().describe('Detailed description of the vulnerability'),
  severity: z.enum(['critical', 'high', 'medium']).describe('Severity level'),
});

export const CodeReviewOutputSchema = z.object({
  verdict: z.enum(['APPROVE', 'REVISE']).describe('Final verdict'),
  confidence: z.number().min(0).max(1).describe('Confidence in the verdict (0-1), advisory only'),
  requires_human_review: z.boolean().describe('Whether a human should review this'),
  logic_validation: z.string().describe('How accurately the code implements the approved plan'),
  blocking_issues: z
    .array(BlockingIssueSchema)
    .describe('Issues that must be fixed before proceeding'),
  non_blocking_suggestions: z
    .array(z.string())
    .describe('Optional improvement suggestions'),
  vulnerabilities: z
    .array(VulnerabilitySchema)
    .describe('Security and performance vulnerabilities found'),
  optimized_snippet: z
    .string()
    .nullable()
    .describe('Codex-suggested optimized code block, or null if not needed'),
});

// Extended output with server-added review_id (not sent to OpenAI, used for MCP response)
export const CodeReviewMcpOutputSchema = CodeReviewOutputSchema.extend({
  review_id: z.string().describe('Response ID for maintaining reviewer context across rounds. Pass as previous_review_id on the next call.'),
});

export type CodeReviewInput = z.infer<typeof CodeReviewInputSchema>;
export type CodeReviewOutput = z.infer<typeof CodeReviewOutputSchema>;
export type CodeReviewMcpOutput = z.infer<typeof CodeReviewMcpOutputSchema>;
