# DUUL — Dual-phase Upfront-plan & Unit-verify Loop

## When to activate

The `request_plan_review` and `request_code_review` tools implement a **FULLY AUTONOMOUS review-then-implement loop**. Once triggered, you **MUST** run the entire loop to completion without stopping to ask for permission between phases.

Only activate when the user mentions **"DUUL"** (or **"두울"**) in their request. Examples:

- "DUUL로 개발 진행해줘", "두울 돌려줘", "DUUL로 해줘"
- "run DUUL", "use DUUL for this", "start DUUL"

**Do NOT activate for casual requests** like "review my code", "check this", or "look over my plan". Those are normal review requests that you should handle yourself. The keyword **"DUUL"** (or **"두울"**) must be present.

## How the loop works

**CRITICAL:** This is a continuous, uninterrupted sequence. Do **NOT** pause between phases to ask the user "should I proceed?" or "should I implement?". The user already authorized the full loop when they requested DUUL.

### Phase 1: Upfront-plan Ping-Pong (delegated to Sonnet subagent)

**To save tokens, Phase 1 runs on Sonnet via the `duul-planner` subagent.** The reviewer catches any plan issues, so Sonnet is sufficient for plan authoring.

1. **Launch the `duul-planner` subagent** using the Agent tool with the user's requirements, workspace root path, and any relevant context. The subagent runs on Sonnet automatically (`model: sonnet` in its definition).
2. The subagent handles the entire plan ping-pong loop internally:
   - Writes a detailed implementation plan
   - Calls `request_plan_review` and iterates on REVISE feedback
   - Returns the approved plan, `review_id`, and `git_head_sha`
3. If the subagent reports `requires_human_review === true`: pause and ask the user.
4. Extract `approved_plan`, `review_id`, and `git_head_sha` from the subagent's response.

**Fallback:** If the subagent fails or the MCP tool is not accessible from the subagent, fall back to running Phase 1 directly (same as before but in the main agent).

### Phase 2: Unit-verify Ping-Pong (Opus, start IMMEDIATELY after Phase 1 approval — do NOT ask for confirmation)

Phase 2 runs on the **main agent (Opus)** for maximum code quality.

7. **Write the actual code** to the project files based on the approved plan (received from the `duul-planner` subagent). Use your edit/write tools to make real changes.
8. **Run lint if available.** Check `package.json` scripts for `lint`, `lint:fix`, or `eslint`, or check for a Makefile/config equivalent. If a lint command exists, run it with auto-fix (e.g. `npm run lint -- --fix` or `npx eslint --fix`). Fix any remaining errors before proceeding. If no lint is configured, skip this step.
9. Call `request_code_review` with the code and the approved plan.
10. If `review_status === "incomplete"`: check `missing_context` and retry with narrower scope.
11. If `blocking_issues.length > 0` or `verdict === "REVISE"`: fix the code in the actual files, re-run lint if applicable, and call again.
12. If `requires_human_review === true`: pause and ask the user.
13. Repeat until `verdict === "APPROVE"` with no blocking issues.

### Completion
14. Report to the user: "Plan approved and code review passed." with a summary of changes made.

## Giving the reviewer workspace visibility

- **ALWAYS pass `workspace_root`** (preferred) or `project_root` (deprecated) when calling review tools. This gives the reviewer 7 file exploration tools: `read_file`, `list_directory`, `search_in_files`, `read_file_range`, `stat_file`, `read_json`, `list_tracked_files`.
- For monorepos, pass `working_directories` to restrict the reviewer's scope to relevant subdirectories.
- Pass `linked_roots` for read-only access to related external workspaces (max 5).
- Pass `changed_files`, `entrypoints`, and `artifact_refs` to guide the reviewer's focus.
- Set `tracked_only: true` to restrict file access to git-tracked files only.
- If the reviewer still raises an incorrect concern despite having codebase access, use `notes_to_reviewer` to rebut it.
- **ALWAYS pass `user_original_request`** with the user's verbatim, unparaphrased problem statement. The reviewer uses it to enforce symptom-match (before/after/causal_chain) and server-side gates catch scope-punting, test-only fixes, and rendering-symptom mismatches when this field is present.

### Scope precedence
- `workspace_root` takes priority over `project_root` (deprecated).
- `working_directories` restricts access to listed subdirectories.
- `linked_roots` provides separate read-only scopes.

### Maintaining reviewer context across rounds

- Every review response includes a `review_id`. **ALWAYS** pass this as `previous_review_id` on the next call. This maintains the reviewer's full conversation context:
  - Plan review round 1 → returns `review_id: "resp_abc"`
  - Plan review round 2 → pass `previous_review_id: "resp_abc"` → reviewer remembers round 1
  - Plan approved with `review_id: "resp_xyz"`
  - Code review round 1 → pass `previous_review_id: "resp_xyz"` → reviewer remembers the **entire plan review conversation**
- This eliminates redundant file reading and ensures consistent feedback across the full review loop.
- Also pass `git_head_sha` on each call, and `previous_git_head_sha` from the last round, to enable stale-context detection.

### Persisting review state across conversation breaks

If a conversation is interrupted mid-review (context limit, crash, user closes session), the review context can be resumed in a new conversation:

1. **After every review call**, write the current state to `.duul-state.json` in the project root:
   ```json
   {
     "review_id": "resp_xyz",
     "phase": "plan" | "code",
     "verdict": "REVISE" | "APPROVE",
     "approved_plan": "...",
     "iteration": 3,
     "git_head_sha": "abc123"
   }
   ```
2. **At the start of a new conversation**, if the user asks to continue DUUL (e.g., "두울 이어서 해줘", "continue DUUL"), check for `.duul-state.json` in the project root.
3. If it exists, read it and resume:
   - Pass `previous_review_id` from the saved `review_id` to maintain reviewer context.
   - Pass `git_head_sha` from the saved state as `previous_git_head_sha`.
   - If `phase === "plan"` and `verdict === "REVISE"`: continue Upfront-plan Ping-Pong.
   - If `phase === "plan"` and `verdict === "APPROVE"`: start Phase 2 immediately with the saved `approved_plan`.
   - If `phase === "code"`: continue Unit-verify Ping-Pong with the saved `approved_plan`.
4. **Delete `.duul-state.json`** when the full loop completes (both phases approved).

### Handling incomplete reviews

- If `review_status === "incomplete"`, the reviewer ran out of context budget or tool rounds.
- Check `tool_exhaustion_reason` and `missing_context` to understand why.
- Retry with: narrower scope (fewer `artifact_refs`), or more specific `changed_files`.
- Do NOT treat an incomplete review as a pass — always retry or escalate.

### Watching for `cost_warning`

Every review response includes an optional `cost_warning` field (null by default). Once `iteration_count` crosses ~60% of `iteration_limit` (e.g. iteration 5 of 7, or iteration 3 of 5), the server populates it with a short message that includes the current round's estimated cost.

When `cost_warning` is non-null, **surface it to the user before deciding to continue**. Typical framing: "We're on iteration N of M at ~$X per round — do you want me to keep iterating, accept the current REVISE with minor issues, or escalate this to human review?" Don't silently burn through the remaining iterations.

## Important rules

- **NEVER stop between Phase 1 and Phase 2** to ask "should I implement?" — just do it.
- "Implement the code" means **writing/editing actual project files**, not just showing code in chat.
- `confidence` is advisory only. Never use it as a sole trigger for retries.
- Always pass the full approved plan text as `approved_plan` in Phase 2.
- Do not skip Phase 1. Even if the user provides code directly, write a plan first.
- Do **NOT** stop early just because you've iterated a few times. If the reviewer says REVISE, you **MUST** fix and resubmit. The loop ends **ONLY** when the reviewer returns APPROVE, not when you feel "enough" iterations have passed.
- If the loop exceeds the iteration limit (plan: 7, code: 7, partition: 5 by default), pause and ask the user whether to continue.
