/**
 * Codex CLI login support.
 *
 * Lets DUUL reuse the credentials produced by `codex login` (the OpenAI Codex
 * CLI) instead of requiring a raw OPENAI_API_KEY. Two auth modes are handled:
 *
 *   1. "apikey"  — auth.json carries an OPENAI_API_KEY; we just use it.
 *   2. "chatgpt" — Sign in with ChatGPT (Plus/Pro/Team). auth.json carries an
 *                  OAuth access token + account id. Requests go to the ChatGPT
 *                  backend Responses endpoint with a bearer token; the token is
 *                  refreshed via the OpenAI OAuth endpoint when near expiry.
 *
 * Credential file: $CODEX_HOME/auth.json (defaults to ~/.codex/auth.json).
 *
 * Protocol constants mirror the openai/codex `codex-rs` client so DUUL speaks
 * the same dialect the CLI does.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** ChatGPT-login base URL for the Responses API (POST {base}/responses). */
export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/** OAuth token endpoint used to refresh a ChatGPT access token. */
const OAUTH_TOKEN_URL = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? 'https://auth.openai.com/oauth/token';

/** Public OAuth client id the Codex CLI registers under. */
const OAUTH_CLIENT_ID = process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Refresh the access token when it has this many seconds (or fewer) of life left. */
const EXPIRY_SKEW_SECONDS = 5 * 60;

export interface CodexTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

export interface CodexAuth {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens;
  last_refresh?: string;
}

export type CodexCredential =
  | { mode: 'apikey'; apiKey: string }
  | { mode: 'chatgpt'; accessToken: string; accountId: string; refresh: () => Promise<string> };

/** Resolve the Codex home directory ($CODEX_HOME or ~/.codex). */
export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function authPath(): string {
  return join(codexHome(), 'auth.json');
}

/** Read and parse auth.json. Returns null when the file is missing or unparsable. */
export function loadCodexAuth(): CodexAuth | null {
  try {
    const raw = readFileSync(authPath(), 'utf-8');
    return JSON.parse(raw) as CodexAuth;
  } catch {
    return null;
  }
}

/**
 * Decode the `exp` (seconds since epoch) claim from a JWT without verifying it.
 * Returns null when the token is not a decodable JWT.
 */
export function jwtExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as { exp?: number };
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
}

/**
 * True when the token is expired or within EXPIRY_SKEW_SECONDS of expiring.
 * Unknown expiry is treated as "not expired" so we don't refresh needlessly.
 */
export function isTokenExpired(token: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const exp = jwtExp(token);
  if (exp === null) return false;
  return exp - nowSeconds <= EXPIRY_SKEW_SECONDS;
}

interface RefreshResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

/**
 * Exchange the stored refresh_token for a fresh access token via the OpenAI
 * OAuth endpoint, then persist the rotated tokens back to auth.json.
 * Returns the updated CodexAuth. Throws on network/HTTP failure.
 */
export async function refreshCodexToken(auth: CodexAuth): Promise<CodexAuth> {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error('Codex auth has no refresh_token; run `codex login` again.');
  }

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Codex token refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as RefreshResponse;
  const updated: CodexAuth = {
    ...auth,
    tokens: {
      ...auth.tokens,
      ...(data.access_token ? { access_token: data.access_token } : {}),
      ...(data.id_token ? { id_token: data.id_token } : {}),
      // Refresh tokens rotate; keep the old one only if none is returned.
      ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    },
    last_refresh: new Date().toISOString(),
  };

  try {
    writeFileSync(authPath(), JSON.stringify(updated, null, 2), { mode: 0o600 });
  } catch (error) {
    // Non-fatal: we can still use the refreshed token in-memory this run.
    console.error(`[duul] Warning: could not persist refreshed Codex token: ${error instanceof Error ? error.message : error}`);
  }

  return updated;
}

/**
 * Resolve a usable credential from the Codex CLI login, or null when the CLI
 * is not logged in. Refreshes an expired ChatGPT access token up front.
 *
 * The returned `refresh` callback (chatgpt mode) re-reads auth.json and rotates
 * the token, so a provider can recover from a mid-review 401.
 */
export async function resolveCodexCredential(): Promise<CodexCredential | null> {
  const auth = loadCodexAuth();
  if (!auth) return null;

  const tokens = auth.tokens;
  const chatgptCapable = !!(tokens?.access_token && tokens?.account_id);
  const preferChatgpt = auth.auth_mode === 'chatgpt' || (!auth.OPENAI_API_KEY && chatgptCapable);

  if (preferChatgpt && chatgptCapable) {
    let accessToken = tokens!.access_token!;
    if (isTokenExpired(accessToken) && tokens!.refresh_token) {
      const refreshed = await refreshCodexToken(auth);
      accessToken = refreshed.tokens?.access_token ?? accessToken;
    }
    return {
      mode: 'chatgpt',
      accessToken,
      accountId: tokens!.account_id!,
      refresh: async () => {
        const current = loadCodexAuth() ?? auth;
        const refreshed = await refreshCodexToken(current);
        const next = refreshed.tokens?.access_token;
        if (!next) throw new Error('Codex token refresh returned no access_token');
        return next;
      },
    };
  }

  if (auth.OPENAI_API_KEY) {
    return { mode: 'apikey', apiKey: auth.OPENAI_API_KEY };
  }

  return null;
}
