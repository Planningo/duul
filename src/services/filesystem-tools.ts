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

export async function executeFilesystemTool(
  projectRoot: string,
  toolName: string,
  args: Record<string, unknown>,
  scope?: WorkspaceScope | null,
): Promise<string> {
  try {
    switch (toolName) {
      case 'read_file': {
        const result = await readProjectFile(projectRoot, args.path as string, scope);
        if (result.length > 50_000) {
          return `\u26a0\ufe0f This file is large (${result.length} chars). Consider using read_file_range or search_in_files instead.\n\n${result}`;
        }
        return result;
      }
      case 'list_directory':
        return await listProjectDirectory(projectRoot, args.path as string, scope);
      case 'search_in_files':
        return await searchInFiles(projectRoot, args.query as string, args.paths as string[] | undefined, args.glob as string | undefined, scope?.trackedOnly, scope?.workingDirectories, scope);
      case 'read_file_range':
        return await readProjectFileRange(projectRoot, args.path as string, args.start_line as number, args.end_line as number, scope);
      case 'stat_file':
        return await statProjectFile(projectRoot, args.path as string, scope);
      case 'read_json':
        return await readJsonValue(projectRoot, args.path as string, args.json_pointer as string | undefined, scope);
      case 'list_tracked_files': {
        const files = await listTrackedFiles(projectRoot, args.prefix as string | undefined, scope);
        return files.join('\n') || 'No tracked files found.';
      }
      case 'get_git_diff':
        return await getGitDiff(projectRoot, args.base as string | undefined, args.paths as string[] | undefined, scope);
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
