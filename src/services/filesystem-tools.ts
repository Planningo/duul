/**
 * Shared filesystem tool executor used by all provider implementations.
 * Handles all 8 standard tools + get_git_diff.
 */
import {
  readProjectFile,
  listProjectDirectory,
  searchInFiles,
  readProjectFileRange,
  statProjectFile,
  readJsonValue,
  listTrackedFiles,
  getGitDiff,
  type WorkspaceScope,
} from './filesystem.js';

/**
 * Mutable per-review byte counter. Passed by reference into executeFilesystemTool
 * so every successful tool return adds to `used`, and calls short-circuit once
 * `used >= cap`.
 */
export interface ReviewerByteBudget {
  used: number;
  cap: number;
}

/**
 * Resolve the reviewer file-read cap from env. Opt-in: if DUUL_MAX_REVIEWER_BYTES
 * is unset/invalid, returns Infinity (no cap). Measurements showed a 200KB default
 * was too tight — ~1/3 of code reviews hit the cap and spent extra rounds.
 * Cost-conscious users can set DUUL_MAX_REVIEWER_BYTES=200000 (or similar) explicitly.
 */
export function getMaxReviewerBytes(): number {
  const raw = process.env.DUUL_MAX_REVIEWER_BYTES;
  if (!raw) return Infinity;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) return Infinity;
  return parsed;
}

export function createReviewerByteBudget(cap?: number): ReviewerByteBudget {
  return { used: 0, cap: cap ?? getMaxReviewerBytes() };
}

function budgetExhaustedMessage(budget: ReviewerByteBudget): string {
  return `Reviewer file budget exhausted (used ${budget.used} / cap ${budget.cap} bytes). Rely on context already gathered. Do NOT request more files — submit your verdict.`;
}

export async function executeFilesystemTool(
  projectRoot: string,
  toolName: string,
  args: Record<string, unknown>,
  scope?: WorkspaceScope | null,
  budget?: ReviewerByteBudget,
): Promise<string> {
  if (budget && budget.used >= budget.cap) {
    return budgetExhaustedMessage(budget);
  }

  try {
    let result: string;
    switch (toolName) {
      case 'read_file': {
        const content = await readProjectFile(projectRoot, args.path as string, scope);
        result = content.length > 50_000
          ? `\u26a0\ufe0f This file is large (${content.length} chars). Consider using read_file_range or search_in_files instead.\n\n${content}`
          : content;
        break;
      }
      case 'list_directory':
        result = await listProjectDirectory(projectRoot, args.path as string, scope);
        break;
      case 'search_in_files':
        result = await searchInFiles(projectRoot, args.query as string, args.paths as string[] | undefined, args.glob as string | undefined, scope?.trackedOnly, scope?.workingDirectories, scope);
        break;
      case 'read_file_range':
        result = await readProjectFileRange(projectRoot, args.path as string, args.start_line as number, args.end_line as number, scope);
        break;
      case 'stat_file':
        result = await statProjectFile(projectRoot, args.path as string, scope);
        break;
      case 'read_json':
        result = await readJsonValue(projectRoot, args.path as string, args.json_pointer as string | undefined, scope);
        break;
      case 'list_tracked_files': {
        const files = await listTrackedFiles(projectRoot, args.prefix as string | undefined, scope);
        result = files.join('\n') || 'No tracked files found.';
        break;
      }
      case 'get_git_diff':
        result = await getGitDiff(projectRoot, args.base as string | undefined, args.paths as string[] | undefined, scope);
        break;
      default:
        return `Unknown tool: ${toolName}`;
    }

    if (budget) {
      budget.used += Buffer.byteLength(result, 'utf8');
    }
    return result;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
