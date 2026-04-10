#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerPlanReviewTool } from './tools/plan-review.js';
import { registerCodeReviewTool } from './tools/code-review.js';
import { registerExecutionPartitionTool } from './tools/execution-partition.js';

const SERVER_INSTRUCTIONS = `
DUUL — Dual-phase Upfront-plan & Unit-verify Loop.
Activate ONLY when user says "DUUL" or "두울". See project CLAUDE.md for full protocol.
Key rules: pass workspace_root, pass previous_review_id on each round, never stop between phases.
`.trim();

const server = new McpServer(
  { name: 'duul', version: '1.0.0' },
  { instructions: SERVER_INSTRUCTIONS },
);

registerPlanReviewTool(server);
registerCodeReviewTool(server);
registerExecutionPartitionTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error('[duul] Server started on stdio');
