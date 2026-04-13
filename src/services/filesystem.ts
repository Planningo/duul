import { readFile, readdir, lstat, realpath } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, relative, isAbsolute } from 'path';

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 100_000; // 100KB per file read

// Additional blocked paths/patterns beyond .env and node_modules
const BLOCKED_PATHS = ['.git', 'build', 'dist'];
const BLOCKED_EXTENSIONS = ['.log'];

/**
 * Validates that project_root is a reasonable absolute path,
 * not the filesystem root or a system directory.
 */
export function validateProjectRoot(projectRoot: string): void {
  if (!isAbsolute(projectRoot)) {
    throw new Error(`project_root must be an absolute path: ${projectRoot}`);
  }
  // Block overly broad roots
  const blocked = ['/', '/etc', '/usr', '/var', '/tmp', '/bin', '/sbin', '/lib', '/opt'];
  const homeDirs = ['/Users', '/home', '/root'];
  if (blocked.includes(projectRoot)) {
    throw new Error(`project_root too broad: ${projectRoot}`);
  }
  // Block bare home directories (allow subdirectories like /Users/foo/project)
  if (homeDirs.includes(projectRoot)) {
    throw new Error(`project_root too broad: ${projectRoot}`);
  }
  // Must be at least 3 levels deep (e.g., /Users/foo/project, not /Users/foo)
  const segments = projectRoot.split('/').filter(Boolean);
  if (segments.length < 3) {
    throw new Error(`project_root too broad (must be at least 3 levels deep, e.g. /Users/foo/project): ${projectRoot}`);
  }
}

/**
 * Resolves requested path, validates it stays within project root
 * (following symlinks with realpath), and blocks sensitive files.
 */
async function safePath(
  projectRoot: string,
  requestedPath: string,
  workingDirectories?: string[] | null,
): Promise<string> {
  // Block absolute paths in requests
  if (isAbsolute(requestedPath)) {
    throw new Error(`Path must be relative to project root: ${requestedPath}`);
  }

  const resolved = resolve(projectRoot, requestedPath);

  // Pre-check: logical path must stay within root
  const rel = relative(projectRoot, resolved);
  if (rel.startsWith('..') || resolve(projectRoot, rel) !== resolved) {
    throw new Error(`Path outside project root: ${requestedPath}`);
  }

  // Working directories allowlist check
  if (workingDirectories && workingDirectories.length > 0) {
    const inAllowedDir = workingDirectories.some((dir) => {
      const normalizedDir = dir.endsWith('/') ? dir : `${dir}/`;
      return rel === dir || rel.startsWith(normalizedDir) || rel === '.';
    });
    if (!inAllowedDir && rel !== '.') {
      throw new Error(
        `Path outside working directories: ${requestedPath}. ` +
          `Allowed: ${workingDirectories.join(', ')}`,
      );
    }
  }

  // Post-check: real path (after resolving symlinks) must also stay within root
  const realProjectRoot = await realpath(projectRoot);
  let realResolved: string;
  try {
    realResolved = await realpath(resolved);
  } catch {
    // File might not exist yet for stat, let it fail naturally later
    realResolved = resolved;
  }
  const realRel = relative(realProjectRoot, realResolved);
  if (realRel.startsWith('..')) {
    throw new Error(`Symlink escape detected: ${requestedPath} resolves outside project root`);
  }

  // Block sensitive files
  const lower = rel.toLowerCase();
  if (lower.includes('.env') && !lower.endsWith('.example')) {
    throw new Error(`Access denied (sensitive file): ${requestedPath}`);
  }
  if (rel === 'node_modules' || rel.startsWith('node_modules/') || rel.startsWith('node_modules\\')) {
    throw new Error('Access denied: node_modules');
  }

  // Block additional paths (.git, build, dist)
  const topSegment = rel.split('/')[0].split('\\')[0];
  if (BLOCKED_PATHS.includes(topSegment)) {
    throw new Error(`Access denied: ${topSegment}`);
  }

  // Block large file extensions (.log)
  if (BLOCKED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new Error(`Access denied (blocked extension): ${requestedPath}`);
  }

  return realResolved;
}

/**
 * Safe path resolution for linked roots (read-only external workspaces).
 * Same as safePath but scoped to a linked root.
 */
async function safeLinkedPath(linkedRoot: string, requestedPath: string): Promise<string> {
  return safePath(linkedRoot, requestedPath);
}

/**
 * List git-tracked files under a given prefix.
 * Respects working_directories and supports linked roots via "linked:<index>:<prefix>" syntax.
 */
export async function listTrackedFiles(
  root: string,
  prefix?: string,
  scope?: WorkspaceScope | null,
): Promise<string[]> {
  // Check for linked root prefix
  if (prefix && scope) {
    const parsed = parseLinkedPath(prefix, scope);
    if (parsed) {
      const idx = scope.linkedRoots.indexOf(parsed.root);
      const files = await listTrackedFilesForRoot(parsed.root, parsed.relativePath || undefined);
      return files.map((f) => `linked:${idx}:${f}`);
    }
  }

  // Primary root
  let files = await listTrackedFilesForRoot(root, prefix);

  // If no explicit prefix and working_directories set, filter to those directories
  if (!prefix && scope?.workingDirectories?.length) {
    files = files.filter((f) =>
      scope.workingDirectories!.some((dir) => {
        const normalizedDir = dir.endsWith('/') ? dir : `${dir}/`;
        return f === dir || f.startsWith(normalizedDir);
      }),
    );
  }

  return files;
}

async function listTrackedFilesForRoot(root: string, prefix?: string): Promise<string[]> {
  const args = ['ls-files'];
  if (prefix) args.push(prefix);
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, maxBuffer: 1024 * 1024 });
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if a file is git-tracked.
 */
export async function isTrackedFile(root: string, filePath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', filePath], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

/**
 * Workspace scope resolution result.
 */
export interface WorkspaceScope {
  root: string;
  workingDirectories: string[] | null; // null = entire root allowed
  linkedRoots: string[];
  trackedOnly: boolean;
}

/**
 * Resolves workspace scope from input fields following precedence rules:
 * 1. workspace_root (preferred)
 * 2. project_root (deprecated fallback)
 * 3. working_directories (allowlist intersection)
 * 4. linked_roots (separate read-only scopes)
 */
export function resolveWorkspaceScope(input: {
  workspace_root?: string;
  project_root?: string;
  working_directories?: string[];
  linked_roots?: string[];
  tracked_only?: boolean;
}): WorkspaceScope | null {
  const root = input.workspace_root ?? input.project_root;
  if (!root) return null;

  if (input.workspace_root && input.project_root) {
    console.error(
      '[duul] Warning: both workspace_root and project_root provided. ' +
        'Using workspace_root. project_root is deprecated.',
    );
  } else if (!input.workspace_root && input.project_root) {
    console.error(
      '[duul] Deprecation: project_root is deprecated, use workspace_root instead.',
    );
  }

  validateProjectRoot(root);

  // Validate linked_roots
  const linkedRoots: string[] = [];
  if (input.linked_roots) {
    for (const lr of input.linked_roots) {
      validateProjectRoot(lr);
      linkedRoots.push(lr);
    }
  }

  return {
    root,
    workingDirectories: input.working_directories ?? null,
    linkedRoots,
    trackedOnly: input.tracked_only ?? false,
  };
}

/**
 * Resolve a path that may target the primary root or a linked root.
 * Format for linked root: "linked:<index>:<relative_path>" or just a plain relative path (primary root).
 */
function parseLinkedPath(
  path: string,
  scope: WorkspaceScope | null,
): { root: string; relativePath: string; isLinked: boolean } | null {
  if (!path.startsWith('linked:')) {
    return null; // use primary root
  }

  if (!scope || scope.linkedRoots.length === 0) {
    throw new Error('No linked roots configured. Use a relative path for the primary workspace.');
  }

  const parts = path.slice('linked:'.length);
  const colonIdx = parts.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(
      `Invalid linked path format: "${path}". Expected "linked:<index>:<relative_path>".`,
    );
  }

  const indexStr = parts.slice(0, colonIdx);
  const relativePath = parts.slice(colonIdx + 1);
  const index = parseInt(indexStr, 10);

  if (isNaN(index) || index < 0 || index >= scope.linkedRoots.length) {
    throw new Error(
      `Invalid linked root index: ${indexStr}. Available: 0-${scope.linkedRoots.length - 1}.`,
    );
  }

  return { root: scope.linkedRoots[index], relativePath, isLinked: true };
}

/**
 * Guard: if trackedOnly is enabled, verify the file is git-tracked.
 */
async function enforceTrackedOnly(
  root: string,
  filePath: string,
  trackedOnly: boolean,
): Promise<void> {
  if (!trackedOnly) return;
  const tracked = await isTrackedFile(root, filePath);
  if (!tracked) {
    throw new Error(`Access denied: "${filePath}" is not a git-tracked file (tracked_only mode).`);
  }
}

/**
 * Resolve the effective root and path, handling linked roots, working directories, and tracked-only.
 */
async function resolveToolPath(
  primaryRoot: string,
  requestedPath: string,
  scope: WorkspaceScope | null,
): Promise<string> {
  const linked = parseLinkedPath(requestedPath, scope);
  if (linked) {
    // Linked root: no working_directories restriction, but read-only (caller enforces)
    const resolved = await safeLinkedPath(linked.root, linked.relativePath);
    if (scope?.trackedOnly) {
      await enforceTrackedOnly(linked.root, linked.relativePath, true);
    }
    return resolved;
  }

  // Primary root
  const wdirs = scope?.workingDirectories ?? null;
  const resolved = await safePath(primaryRoot, requestedPath, wdirs);
  if (scope?.trackedOnly) {
    await enforceTrackedOnly(primaryRoot, requestedPath, scope.trackedOnly);
  }
  return resolved;
}

export async function readProjectFile(
  projectRoot: string,
  filePath: string,
  scope?: WorkspaceScope | null,
): Promise<string> {
  const resolved = await resolveToolPath(projectRoot, filePath, scope ?? null);
  const stats = await lstat(resolved);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }
  if (stats.size > MAX_FILE_SIZE) {
    throw new Error(
      `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE}). Try a more specific file.`,
    );
  }
  return readFile(resolved, 'utf-8');
}

export async function listProjectDirectory(
  projectRoot: string,
  dirPath: string,
  scope?: WorkspaceScope | null,
): Promise<string> {
  const resolved = await resolveToolPath(projectRoot, dirPath, scope ?? null);
  const stats = await lstat(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
  const entries = await readdir(resolved, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== 'node_modules' && !e.name.startsWith('.env'))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .join('\n');
}

// --- Phase 2: New retrieval tools ---

const MAX_RANGE_LINES = 200;
const MAX_SEARCH_RESULTS = 50;

let _hasRipgrep: boolean | null = null;

async function hasRipgrep(): Promise<boolean> {
  if (_hasRipgrep !== null) return _hasRipgrep;
  try {
    await execFileAsync('rg', ['--version']);
    _hasRipgrep = true;
  } catch {
    _hasRipgrep = false;
  }
  return _hasRipgrep;
}

/**
 * Partition search paths into primary-root paths and linked-root paths.
 * Validates all paths against their respective scope.
 */
async function partitionSearchPaths(
  root: string,
  paths: string[],
  scope: WorkspaceScope | null,
  workingDirectories?: string[] | null,
): Promise<{ primary: string[]; linked: Map<number, { root: string; paths: string[] }> }> {
  const primary: string[] = [];
  const linked = new Map<number, { root: string; paths: string[] }>();

  for (const p of paths) {
    const parsed = parseLinkedPath(p, scope);
    if (parsed) {
      // Validate the linked path
      await safeLinkedPath(parsed.root, parsed.relativePath);
      const idx = scope!.linkedRoots.indexOf(parsed.root);
      if (!linked.has(idx)) {
        linked.set(idx, { root: parsed.root, paths: [] });
      }
      linked.get(idx)!.paths.push(parsed.relativePath);
    } else {
      // Primary root path — validate against working directories
      await safePath(root, p, workingDirectories);
      primary.push(p);
    }
  }

  return { primary, linked };
}

/**
 * Run a search command on a single root directory.
 */
async function runSearch(
  searchRoot: string,
  query: string,
  effectivePaths: string[] | undefined,
  glob: string | undefined,
  trackedOnly: boolean,
  maxLines: number,
): Promise<{ backend: string; lines: string[] }> {
  let backend: string;
  let result: string;

  try {
    if (trackedOnly) {
      backend = 'git_grep';
      const args = ['grep', '-n', '--max-count', String(maxLines), '-e', query];
      if (effectivePaths?.length) args.push('--', ...effectivePaths);
      const { stdout } = await execFileAsync('git', args, { cwd: searchRoot, maxBuffer: 512 * 1024 });
      result = stdout;
    } else if (await hasRipgrep()) {
      backend = 'rg';
      const args = ['--no-heading', '-n', '--max-count', String(maxLines)];
      if (glob) args.push('--glob', glob);
      args.push('--', query);
      if (effectivePaths?.length) args.push(...effectivePaths);
      const { stdout } = await execFileAsync('rg', args, { cwd: searchRoot, maxBuffer: 512 * 1024 });
      result = stdout;
    } else {
      backend = 'git_grep';
      const args = ['grep', '-n', '--max-count', String(maxLines), '-e', query];
      if (effectivePaths?.length) args.push('--', ...effectivePaths);
      const { stdout } = await execFileAsync('git', args, { cwd: searchRoot, maxBuffer: 512 * 1024 });
      result = stdout;
    }
  } catch (error: unknown) {
    const err = error as { code?: number; stdout?: string };
    if (err.code === 1 && (err.stdout === '' || err.stdout === undefined)) {
      return { backend: backend!, lines: [] };
    }
    if (err.stdout) {
      return { backend: backend!, lines: err.stdout.trim().split('\n') };
    }
    throw error;
  }

  return { backend: backend!, lines: result.trim().split('\n').filter(Boolean) };
}

/**
 * Search for a pattern in files using rg (preferred), git grep, or grep fallback.
 * Supports searching across primary root and linked roots.
 */
export async function searchInFiles(
  root: string,
  query: string,
  paths?: string[],
  glob?: string,
  trackedOnly?: boolean,
  workingDirectories?: string[] | null,
  scope?: WorkspaceScope | null,
): Promise<string> {
  const maxLines = MAX_SEARCH_RESULTS;

  // Partition paths into primary vs linked root groups
  const partitioned = paths?.length
    ? await partitionSearchPaths(root, paths, scope ?? null, workingDirectories)
    : { primary: [] as string[], linked: new Map<number, { root: string; paths: string[] }>() };

  // Determine effective primary paths
  const hasPrimaryPaths = partitioned.primary.length > 0;
  const hasLinkedPaths = partitioned.linked.size > 0;
  const hasExplicitPaths = paths && paths.length > 0;

  // If no explicit paths provided, search primary root with working_directories restriction
  const primaryEffectivePaths = hasPrimaryPaths
    ? partitioned.primary
    : (!hasExplicitPaths && workingDirectories?.length)
      ? workingDirectories
      : (!hasExplicitPaths ? undefined : undefined);

  // Collect results from all roots, distributing budget fairly
  const allSections: string[] = [];
  let lastBackend = '';
  const searchPrimary = !hasExplicitPaths || hasPrimaryPaths;
  const rootCount = (searchPrimary ? 1 : 0) + partitioned.linked.size;
  const perRootLimit = rootCount > 1 ? Math.max(10, Math.floor(maxLines / rootCount)) : maxLines;

  // Search primary root (unless all paths are linked)
  if (searchPrimary) {
    const { backend, lines } = await runSearch(
      root, query, primaryEffectivePaths, glob, trackedOnly ?? false, perRootLimit,
    );
    lastBackend = backend;
    if (lines.length > 0) {
      allSections.push(...lines);
    }
  }

  // Search each linked root
  for (const [idx, { root: linkedRoot, paths: linkedPaths }] of partitioned.linked) {
    const { backend, lines } = await runSearch(
      linkedRoot, query, linkedPaths, glob, trackedOnly ?? false, perRootLimit,
    );
    lastBackend = lastBackend || backend;
    if (lines.length > 0) {
      // Prefix linked root results so the reviewer knows which root they came from
      const prefixed = lines.map((l) => `[linked:${idx}] ${l}`);
      allSections.push(...prefixed);
    }
  }

  if (allSections.length === 0) {
    return `[search_backend: ${lastBackend || 'rg'}]\nNo matches found for: ${query}`;
  }

  const trimmed = allSections.slice(0, maxLines);
  return `[search_backend: ${lastBackend}]\n${trimmed.join('\n')}`;
}

/**
 * Read a specific line range from a file.
 */
export async function readProjectFileRange(
  root: string,
  filePath: string,
  startLine: number,
  endLine: number,
  scope?: WorkspaceScope | null,
): Promise<string> {
  const resolved = await resolveToolPath(root, filePath, scope ?? null);
  const stats = await lstat(resolved);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const clampedEnd = Math.min(endLine, startLine + MAX_RANGE_LINES - 1);
  const content = await readFile(resolved, 'utf-8');
  const allLines = content.split('\n');
  const start = Math.max(1, startLine) - 1; // 1-based to 0-based
  const end = Math.min(allLines.length, clampedEnd);
  const selected = allLines.slice(start, end);

  const header = `Lines ${start + 1}-${end} of ${allLines.length} (${filePath})`;
  const numbered = selected.map((line, i) => `${start + i + 1}\t${line}`);
  return `${header}\n${numbered.join('\n')}`;
}

/**
 * Get file metadata (size, type, modified time).
 */
export async function statProjectFile(
  root: string,
  filePath: string,
  scope?: WorkspaceScope | null,
): Promise<string> {
  const resolved = await resolveToolPath(root, filePath, scope ?? null);
  const stats = await lstat(resolved);
  const type = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'other';
  return JSON.stringify({
    path: filePath,
    type,
    size: stats.size,
    modified: stats.mtime.toISOString(),
  });
}

/**
 * Read a JSON file, optionally extracting a value at a JSON pointer path.
 * Pointer format: "/key/subkey/0" (RFC 6901 simplified).
 */
export async function readJsonValue(
  root: string,
  filePath: string,
  pointer?: string,
  scope?: WorkspaceScope | null,
): Promise<string> {
  const content = await readProjectFile(root, filePath, scope);
  const parsed = JSON.parse(content);

  if (!pointer || pointer === '' || pointer === '/') {
    return JSON.stringify(parsed, null, 2);
  }

  // Simple JSON pointer resolution
  const segments = pointer.split('/').filter(Boolean);
  let current: unknown = parsed;
  for (const seg of segments) {
    if (current === null || current === undefined) {
      throw new Error(`JSON pointer "${pointer}" not found: null at "${seg}"`);
    }
    if (typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[seg];
    } else if (Array.isArray(current)) {
      const idx = parseInt(seg, 10);
      if (isNaN(idx)) throw new Error(`JSON pointer "${pointer}": expected array index, got "${seg}"`);
      current = current[idx];
    } else {
      throw new Error(`JSON pointer "${pointer}": cannot traverse into ${typeof current}`);
    }
  }

  return typeof current === 'string' ? current : JSON.stringify(current, null, 2);
}

// --- Git diff tool ---

const MAX_GIT_DIFF_BYTES = 200_000;

/**
 * Run git diff within the workspace scope.
 * Returns the diff output, capped at MAX_GIT_DIFF_BYTES.
 *
 * Defaults to `HEAD` (staged + unstaged vs last commit) rather than `HEAD~1`,
 * so the reviewer sees only the current workspace changes.
 *
 * For untracked (new) files listed in `paths`, appends a synthetic diff
 * generated via `git diff --no-index /dev/null <file>`, so newly added files
 * are visible to the reviewer.
 */
export async function getGitDiff(
  root: string,
  base?: string | null,
  paths?: string[] | null,
  scope?: WorkspaceScope | null,
): Promise<string> {
  const effectiveBase = base ?? 'HEAD';

  // Validate paths if provided
  const validatedPaths: string[] = [];
  if (paths?.length) {
    const wdirs = scope?.workingDirectories ?? null;
    for (const p of paths) {
      if (isAbsolute(p)) {
        return `Error: Path must be relative to project root: ${p}`;
      }
      try {
        await safePath(root, p, wdirs);
        validatedPaths.push(p);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  } else if (scope?.workingDirectories?.length) {
    // Scope to working directories if no explicit paths
    validatedPaths.push(...scope.workingDirectories);
  }

  const sections: string[] = [];

  // 1. Standard git diff for tracked changes
  const diffArgs = ['diff', effectiveBase];
  if (validatedPaths.length > 0) {
    diffArgs.push('--', ...validatedPaths);
  }

  try {
    const tracked = await runGitDiff(root, diffArgs);
    if (tracked) sections.push(tracked);
  } catch (error: unknown) {
    return `Error running git diff: ${error instanceof Error ? error.message : String(error)}`;
  }

  // 2. Detect untracked (new) files and generate synthetic diffs
  const untrackedPaths = validatedPaths.length > 0
    ? validatedPaths
    : await listUntrackedFiles(root, scope?.workingDirectories);
  if (untrackedPaths.length > 0) {
    const untrackedDiffs = await getUntrackedDiffs(root, untrackedPaths);
    if (untrackedDiffs) sections.push(untrackedDiffs);
  }

  if (sections.length === 0) {
    return `No differences found (base: ${effectiveBase}).`;
  }

  let output = sections.join('\n');
  if (output.length > MAX_GIT_DIFF_BYTES) {
    output = output.slice(0, MAX_GIT_DIFF_BYTES) + `\n\n[truncated — diff exceeded ${MAX_GIT_DIFF_BYTES} bytes]`;
  }
  return output;
}

/**
 * Run a git diff command and return stdout, handling exit code 1 (differences found).
 */
async function runGitDiff(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      maxBuffer: MAX_GIT_DIFF_BYTES + 1024,
    });
    return stdout.trim();
  } catch (error: unknown) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    if (err.code === 1 && err.stdout) {
      return err.stdout.trim();
    }
    throw error;
  }
}

/**
 * List untracked files in the workspace, respecting working_directories scope.
 * Uses `git ls-files --others --exclude-standard` to find files not yet tracked by git.
 */
async function listUntrackedFiles(root: string, workingDirectories?: string[] | null): Promise<string[]> {
  const args = ['ls-files', '--others', '--exclude-standard'];
  if (workingDirectories?.length) {
    args.push('--', ...workingDirectories);
  }
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, maxBuffer: 512 * 1024 });
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * For a list of paths, find untracked files and produce synthetic diffs
 * so newly added files appear in the review context.
 */
async function getUntrackedDiffs(root: string, paths: string[]): Promise<string> {
  const diffs: string[] = [];

  for (const p of paths) {
    const tracked = await isTrackedFile(root, p);
    if (tracked) continue;

    // File exists but is untracked — generate synthetic diff
    const resolved = resolve(root, p);
    try {
      const stats = await lstat(resolved);
      if (!stats.isFile()) continue;
      if (stats.size > MAX_FILE_SIZE) {
        diffs.push(`diff --git a/${p} b/${p}\nnew file\n--- /dev/null\n+++ b/${p}\n@@ Binary or large file (${stats.size} bytes) @@`);
        continue;
      }
    } catch {
      continue; // File doesn't exist
    }

    try {
      const { stdout } = await execFileAsync(
        'git', ['diff', '--no-index', '--', '/dev/null', p],
        { cwd: root, maxBuffer: MAX_GIT_DIFF_BYTES },
      );
      if (stdout.trim()) diffs.push(stdout.trim());
    } catch (error: unknown) {
      // git diff --no-index exits with 1 when differences are found
      const err = error as { code?: number; stdout?: string };
      if (err.code === 1 && err.stdout?.trim()) {
        diffs.push(err.stdout.trim());
      }
    }
  }

  return diffs.join('\n');
}
