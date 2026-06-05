---
"@planningo/duul": minor
---

Fix the recurring `-32602: plan required` (and `code`/`approved_plan` equivalents) failure where a caller's tool call collapsed to an empty `{}` and looped.

Two-part fix:

- **Reachable guards.** The large required string fields (`plan`, `code`, `approved_plan`) are now `optional` at the schema level, so an empty/partial call reaches the handler instead of being rejected pre-handler by the MCP SDK. Callers now get actionable retry guidance instead of an opaque `-32602` zod error. (Partition's short `workspace_root` was also relaxed to `optional` for the same reachability reason — the handler still hard-requires it.)
- **File escape hatch.** Added `plan_file` (plan review), `code_file` + `approved_plan_file` (code review), and `approved_plan_file` (execution partition). Callers can write large content to a file with a normal Write call and pass a short relative path; the server reads it (scoped, symlink-guarded, `tracked_only` bypassed for the caller's own artifact). This avoids the large-argument serialization failure that made models emit `{}`.

The reviewer system prompts now emit free-text fields in compressed style to reduce output tokens. Exactly one of the inline field or its `*_file` companion is required.
