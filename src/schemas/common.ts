import { z } from 'zod';

export const ArtifactRefSchema = z.object({
  path: z.string().describe('File path relative to workspace root'),
  reason: z.string().describe('Why this file is relevant to the review'),
  priority: z.enum(['high', 'medium', 'low']).describe('Review priority level'),
});

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/**
 * Reviewer config schema — shared across all review tools.
 * Allows per-request override of provider, model, and generation parameters.
 */
export const ReviewerConfigSchema = z.object({
  provider: z
    .enum(['openai', 'anthropic', 'google', 'openrouter', 'compatible'])
    .optional()
    .describe('Review provider. Default: env REVIEW_PROVIDER or "openai".'),
  model: z
    .string()
    .optional()
    .describe('Model to use. Default: env REVIEW_MODEL or provider default.'),
  base_url: z
    .string()
    .optional()
    .describe('Custom API base URL (for compatible/self-hosted providers).'),
  api_key: z
    .string()
    .optional()
    .describe('Per-request API key. Overrides env-based key resolution. Useful for compatible/self-hosted providers.'),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe('Sampling temperature override. Default: 0.2.'),
  top_p: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Top-p override. Default: 0.1.'),
}).describe('Per-request reviewer configuration override.');

export type ReviewerConfig = z.infer<typeof ReviewerConfigSchema>;

/**
 * Iteration tracking fields — added to MCP output (not sent to the reviewer model).
 */
export const IterationMetaOutputSchema = z.object({
  iteration_count: z.number().describe('Current iteration number (1-based) as reported by the caller.'),
  iteration_limit: z.number().describe('Maximum iterations allowed for this phase.'),
  iteration_limit_reached: z.boolean().describe('Whether the iteration limit has been reached.'),
});
