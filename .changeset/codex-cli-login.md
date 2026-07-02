---
"@planningo/duul": minor
---

Support Codex CLI login for the `openai` provider — no `OPENAI_API_KEY` required.

When no `OPENAI_API_KEY` (or per-request `api_key`) is set, DUUL now falls back to the OpenAI Codex CLI credentials in `~/.codex/auth.json` (override with `CODEX_HOME`):

- **Sign in with ChatGPT:** uses the OAuth access token against the ChatGPT backend Responses endpoint (`https://chatgpt.com/backend-api/codex`), billed to your ChatGPT plan. Tokens are refreshed automatically via the OAuth endpoint (on expiry and on a mid-review 401).
- **API-key login:** uses the `OPENAI_API_KEY` stored in `auth.json`.

The ChatGPT backend is stateless (`store: false`): DUUL streams the request, aggregates output items from the stream, resends the full input (echoing encrypted reasoning) across tool rounds, and drops unsupported params (`temperature`, `top_p`, `max_output_tokens`, `previous_response_id`). Cross-round context is preserved by replaying prior rounds' turns (new `conversationReplay` provider capability, same mechanism as the Anthropic provider), so `previous_review_id` continuity works. Add `DUUL_REASONING_EFFORT` (default `medium`) to tune reasoning effort. An explicit env/request key always takes precedence over the CLI login.
