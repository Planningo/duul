/**
 * Appends token usage records to a JSONL log file for historical tracking.
 *
 * Log file location: $DUUL_USAGE_LOG or ~/.duul/usage.jsonl
 * Each line is a JSON object with timestamp, tool, usage, and metadata.
 *
 * This is fire-and-forget — logging failures are silently ignored
 * to avoid disrupting the review flow.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TokenUsage } from './providers/types.js';

interface UsageLogEntry {
  timestamp: string;
  tool: string;
  usage: TokenUsage;
  meta: Record<string, unknown>;
}

function getLogPath(): string {
  if (process.env.DUUL_USAGE_LOG) return process.env.DUUL_USAGE_LOG;
  return join(homedir(), '.duul', 'usage.jsonl');
}

export function logUsage(
  tool: string,
  usage: TokenUsage,
  meta: Record<string, unknown> = {},
): void {
  // Fire-and-forget — don't block the review response
  writeEntry(tool, usage, meta).catch(() => {
    // Silently ignore logging failures
  });
}

async function writeEntry(
  tool: string,
  usage: TokenUsage,
  meta: Record<string, unknown>,
): Promise<void> {
  const logPath = getLogPath();
  await mkdir(dirname(logPath), { recursive: true });

  const entry: UsageLogEntry = {
    timestamp: new Date().toISOString(),
    tool,
    usage,
    meta,
  };

  await appendFile(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  console.error(`[duul] Usage logged to ${logPath}`);
}
