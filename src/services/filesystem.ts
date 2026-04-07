import { readFile, readdir, lstat, realpath } from 'fs/promises';
import { resolve, relative, isAbsolute } from 'path';

const MAX_FILE_SIZE = 100_000; // 100KB per file read

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
async function safePath(projectRoot: string, requestedPath: string): Promise<string> {
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

  return realResolved;
}

export async function readProjectFile(projectRoot: string, filePath: string): Promise<string> {
  const resolved = await safePath(projectRoot, filePath);
  // Use lstat to not follow symlinks for the type check
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

export async function listProjectDirectory(projectRoot: string, dirPath: string): Promise<string> {
  const resolved = await safePath(projectRoot, dirPath);
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
