# @planningo/duul

## 1.1.0

### Minor Changes

- 19b5420: Support Codex CLI login for the `openai` provider — no `OPENAI_API_KEY` required.

  When no `OPENAI_API_KEY` (or per-request `api_key`) is set, DUUL now falls back to the OpenAI Codex CLI credentials in `~/.codex/auth.json` (override with `CODEX_HOME`):

  - **Sign in with ChatGPT:** uses the OAuth access token against the ChatGPT backend Responses endpoint (`https://chatgpt.com/backend-api/codex`), billed to your ChatGPT plan. Tokens are refreshed automatically via the OAuth endpoint (on expiry and on a mid-review 401).
  - **API-key login:** uses the `OPENAI_API_KEY` stored in `auth.json`.

  The ChatGPT backend is stateless (`store: false`): DUUL streams the request, aggregates output items from the stream, resends the full input (echoing encrypted reasoning) across tool rounds, and drops unsupported params (`temperature`, `top_p`, `max_output_tokens`, `previous_response_id`). Cross-round context is preserved by replaying prior rounds' turns (new `conversationReplay` provider capability, same mechanism as the Anthropic provider), so `previous_review_id` continuity works. Add `DUUL_REASONING_EFFORT` (default `medium`) to tune reasoning effort. An explicit env/request key always takes precedence over the CLI login.

- 7a6123f: Fix the recurring `-32602: plan required` (and `code`/`approved_plan` equivalents) failure where a caller's tool call collapsed to an empty `{}` and looped.

  Two-part fix:

  - **Reachable guards.** The large required string fields (`plan`, `code`, `approved_plan`) are now `optional` at the schema level, so an empty/partial call reaches the handler instead of being rejected pre-handler by the MCP SDK. Callers now get actionable retry guidance instead of an opaque `-32602` zod error. (Partition's short `workspace_root` was also relaxed to `optional` for the same reachability reason — the handler still hard-requires it.)
  - **File escape hatch.** Added `plan_file` (plan review), `code_file` + `approved_plan_file` (code review), and `approved_plan_file` (execution partition). Callers can write large content to a file with a normal Write call and pass a short relative path; the server reads it (scoped, symlink-guarded, `tracked_only` bypassed for the caller's own artifact). This avoids the large-argument serialization failure that made models emit `{}`.

  The reviewer system prompts now emit free-text fields in compressed style to reduce output tokens. Exactly one of the inline field or its `*_file` companion is required.

## 1.0.1

### Patch Changes

- c0853fa: Guard against empty MCP tool input. Sonnet subagents occasionally emit `request_plan_review` / `request_code_review` / `request_execution_partition` with an empty `{}` input, hitting MCP `-32602` in a retry loop they can't recover from. Now each tool traps empty/short input at handler entry and returns a tool-level error with a concrete retry example, instead of letting zod throw the opaque MCP `-32602`. Also strengthens zod `.describe()` strings and MCP tool descriptions to make the required-vs-optional distinction explicit, and adds a "Tool input rules" section to the `duul-planner` agent prompt.
