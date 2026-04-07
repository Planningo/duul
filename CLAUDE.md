# Peer Review Workflow

## When to activate

The `request_plan_review` and `request_code_review` tools implement a **FULLY AUTONOMOUS review-then-implement loop**. Once triggered, you **MUST** run the entire loop to completion without stopping to ask for permission between phases.

Only activate when the user explicitly asks for a peer review:

- "피어 리뷰 해줘", "사수 리뷰 받자", "Codex 리뷰 돌려", "리뷰 루프 시작"
- "peer review this", "run the review loop", "get a peer review"
- Any clear request that specifically mentions "peer review" or "리뷰 루프"

**Do NOT activate for casual requests** like "review my code", "check this", or "look over my plan". Those are normal review requests that you should handle yourself.

## How the loop works

**CRITICAL:** This is a continuous, uninterrupted sequence. Do **NOT** pause between phases to ask the user "should I proceed?" or "should I implement?". The user already authorized the full loop when they requested the peer review.

### Phase 1: Plan Ping-Pong
1. Write a detailed implementation plan based on the user's requirements.
2. Call `request_plan_review` with the plan.
3. If `blocking_issues.length > 0` or `verdict === "REVISE"`: fix the plan and call again.
4. If `requires_human_review === true`: pause and ask the user.
5. Repeat until `verdict === "APPROVE"` with no blocking issues.

### Phase 2: Code Ping-Pong (start IMMEDIATELY after Phase 1 approval — do NOT ask for confirmation)
6. **Write the actual code** to the project files based on the approved plan. Use your edit/write tools to make real changes.
7. Call `request_code_review` with the code and the approved plan.
8. If `blocking_issues.length > 0` or `verdict === "REVISE"`: fix the code in the actual files and call again.
9. If `requires_human_review === true`: pause and ask the user.
10. Repeat until `verdict === "APPROVE"` with no blocking issues.

### Completion
11. Report to the user: "Plan approved and code review passed." with a summary of changes made.

## Giving the reviewer codebase visibility

- **ALWAYS pass `project_root`** (the absolute path to the project's root directory) when calling the review tools. This gives the reviewer `read_file` and `list_directory` tools so it can freely explore the codebase — examining type definitions, data models, imports, and any code it needs to make informed review decisions instead of speculating.
- If the reviewer still raises an incorrect concern despite having codebase access, use `notes_to_reviewer` to rebut it.
- You can also pass `project_context.relevant_code` to pre-load specific files the reviewer should see immediately.

### Maintaining reviewer context across rounds

- Every review response includes a `review_id`. **ALWAYS** pass this as `previous_review_id` on the next call. This maintains the reviewer's full conversation context:
  - Plan review round 1 → returns `review_id: "resp_abc"`
  - Plan review round 2 → pass `previous_review_id: "resp_abc"` → reviewer remembers round 1
  - Plan approved with `review_id: "resp_xyz"`
  - Code review round 1 → pass `previous_review_id: "resp_xyz"` → reviewer remembers the **entire plan review conversation**
- This eliminates redundant file reading and ensures consistent feedback across the full review loop.

### Persisting review state across conversation breaks

If a conversation is interrupted mid-review (context limit, crash, user closes session), the review context can be resumed in a new conversation:

1. **After every review call**, write the current state to `.peer-review-state.json` in the project root:
   ```json
   {
     "review_id": "resp_xyz",
     "phase": "plan" | "code",
     "verdict": "REVISE" | "APPROVE",
     "approved_plan": "...",
     "iteration": 3
   }
   ```
2. **At the start of a new conversation**, if the user asks to continue a peer review (e.g., "리뷰 이어서 해줘", "continue the peer review"), check for `.peer-review-state.json` in the project root.
3. If it exists, read it and resume:
   - Pass `previous_review_id` from the saved `review_id` to maintain reviewer context.
   - If `phase === "plan"` and `verdict === "REVISE"`: continue Plan Ping-Pong.
   - If `phase === "plan"` and `verdict === "APPROVE"`: start Phase 2 immediately with the saved `approved_plan`.
   - If `phase === "code"`: continue Code Ping-Pong with the saved `approved_plan`.
4. **Delete `.peer-review-state.json`** when the full loop completes (both phases approved).

## Important rules

- **NEVER stop between Phase 1 and Phase 2** to ask "should I implement?" — just do it.
- "Implement the code" means **writing/editing actual project files**, not just showing code in chat.
- `confidence` is advisory only. Never use it as a sole trigger for retries.
- Always pass the full approved plan text as `approved_plan` in Phase 2.
- Do not skip Phase 1. Even if the user provides code directly, write a plan first.
- Do **NOT** stop early just because you've iterated a few times. If the reviewer says REVISE, you **MUST** fix and resubmit. The loop ends **ONLY** when the reviewer returns APPROVE, not when you feel "enough" iterations have passed.
- If the loop exceeds 7 iterations on either phase, pause and ask the user whether to continue.
