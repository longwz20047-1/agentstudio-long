import path from 'path';
import { ensureDir } from './fileUtils.js';

export function resolveProjectRoot(workingDirectory: string): string {
  return workingDirectory.replace(/[/\\]\.workspaces[/\\].*$/, '');
}

export async function resolveUserWorkspacePath(
  workingDirectory: string,
  userId?: string,
): Promise<string> {
  const projectRoot = resolveProjectRoot(workingDirectory);
  if (!userId) return projectRoot;
  const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const cwdPath = path.join(projectRoot, '.workspaces', `u_${safeId}`);
  await ensureDir(cwdPath);
  return cwdPath;
}

export function isPathSafe(requestedPath: string, basePath: string): boolean {
  if (requestedPath.includes('\0')) return false;
  const normalizedBase = path.resolve(basePath);
  const resolved = path.resolve(normalizedBase, requestedPath);
  return resolved === normalizedBase || resolved.startsWith(normalizedBase + path.sep);
}
