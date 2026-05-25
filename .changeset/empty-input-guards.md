---
'@planningo/duul': patch
---

Guard against empty MCP tool input. Sonnet subagents occasionally emit `request_plan_review` / `request_code_review` / `request_execution_partition` with an empty `{}` input, hitting MCP `-32602` in a retry loop they can't recover from. Now each tool traps empty/short input at handler entry and returns a tool-level error with a concrete retry example, instead of letting zod throw the opaque MCP `-32602`. Also strengthens zod `.describe()` strings and MCP tool descriptions to make the required-vs-optional distinction explicit, and adds a "Tool input rules" section to the `duul-planner` agent prompt.
