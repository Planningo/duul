#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerPlanReviewTool } from './tools/plan-review.js';
import { registerCodeReviewTool } from './tools/code-review.js';
import { registerExecutionPartitionTool } from './tools/execution-partition.js';

const SERVER_INSTRUCTIONS = `
## Peer Review Workflow

The request_plan_review and request_code_review tools implement a FULLY AUTONOMOUS review-then-implement loop. Once triggered, you MUST run the entire loop to completion without stopping to ask for permission between phases.

### When to activate

Only activate when the user explicitly asks for a peer review:
- "피어 리뷰 해줘", "사수 리뷰 받자", "Codex 리뷰 돌려", "리뷰 루프 시작"
- "peer review this", "run the review loop", "get a peer review"
- Any clear request that specifically mentions "peer review" or "리뷰 루프"

Do NOT activate for casual requests like "review my code", "check this", or "look over my plan". Those are normal review requests that you should handle yourself.

### How the loop works

CRITICAL: This is a continuous, uninterrupted sequence. Do NOT pause between phases to ask the user "should I proceed?" or "should I implement?". The user already authorized the full loop when they requested the peer review.

Phase 1 - Plan Ping-Pong:
1. Write a detailed implementation plan based on the user's requirements.
2. Call request_plan_review with the plan.
3. If review_status === "incomplete": check missing_context and retry with narrower scope.
4. If blocking_issues.length > 0 or verdict === "REVISE": fix the plan and call again.
5. If requires_human_review === true: pause and ask the user.
6. Repeat until verdict === "APPROVE" with no blocking issues.

Phase 2 - Code Ping-Pong (start IMMEDIATELY after Phase 1 approval — do NOT ask for confirmation):
7. Write the actual code to the project files based on the approved plan. Use your edit/write tools to make real changes.
8. Call request_code_review with the code and the approved plan.
9. If review_status === "incomplete": check missing_context and retry with narrower scope.
10. If blocking_issues.length > 0 or verdict === "REVISE": fix the code in the actual files and call again.
11. If requires_human_review === true: pause and ask the user.
12. Repeat until verdict === "APPROVE" with no blocking issues.

Completion:
13. Report to the user: "Plan approved and code review passed." with a summary of changes made.

### Giving the reviewer workspace visibility
- ALWAYS pass workspace_root (preferred) or project_root (deprecated) when calling review tools. This gives the reviewer 7 file exploration tools: read_file, list_directory, search_in_files, read_file_range, stat_file, read_json, list_tracked_files.
- For monorepos, pass working_directories to restrict the reviewer's scope to relevant subdirectories.
- Pass linked_roots for read-only access to related external workspaces (max 5).
- Pass changed_files, entrypoints, and artifact_refs to guide the reviewer's focus.
- Set tracked_only: true to restrict file access to git-tracked files only.
- If the reviewer still raises an incorrect concern despite having codebase access, use notes_to_reviewer to rebut it.

### Scope precedence
- workspace_root takes priority over project_root (deprecated).
- working_directories restricts access to listed subdirectories.
- linked_roots provides separate read-only scopes.

### Maintaining reviewer context across rounds
- Every review response includes a review_id. ALWAYS pass this as previous_review_id on the next call.
- Also pass git_head_sha on each call, and previous_git_head_sha from the last round, to enable stale-context detection.

### Persisting review state across conversation breaks
- After every review call, write the current state to .peer-review-state.json in the project root:
  { "review_id": "resp_xyz", "phase": "plan"|"code", "verdict": "REVISE"|"APPROVE", "approved_plan": "...", "iteration": 3, "git_head_sha": "abc123" }
- At the start of a new conversation, if the user asks to continue a peer review, check for .peer-review-state.json and resume. Pass git_head_sha from the saved state as previous_git_head_sha.
- Delete .peer-review-state.json when the full loop completes.

### Handling incomplete reviews
- If review_status === "incomplete", the reviewer ran out of context budget or tool rounds.
- Check tool_exhaustion_reason and missing_context to understand why.
- Retry with: narrower scope (fewer artifact_refs), or more specific changed_files.
- Do NOT treat an incomplete review as a pass — always retry or escalate.

### Important rules
- NEVER stop between Phase 1 and Phase 2 to ask "should I implement?" — just do it.
- "Implement the code" means writing/editing actual project files, not just showing code in chat.
- confidence is advisory only. Never use it as a sole trigger for retries.
- Always pass the full approved plan text as approved_plan in Phase 2.
- Do not skip Phase 1. Even if the user provides code directly, write a plan first.
- Do NOT stop early just because you've iterated a few times. If the reviewer says REVISE, you MUST fix and resubmit. The loop ends ONLY when the reviewer returns APPROVE, not when you feel "enough" iterations have passed.
- If the loop exceeds 7 iterations on either phase, pause and ask the user whether to continue.
`.trim();

const server = new McpServer(
  { name: 'peer-reviewer', version: '1.0.0' },
  { instructions: SERVER_INSTRUCTIONS },
);

registerPlanReviewTool(server);
registerCodeReviewTool(server);
registerExecutionPartitionTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error('[peer-reviewer] Server started on stdio');
