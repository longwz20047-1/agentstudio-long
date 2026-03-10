import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { resolveProjectRoot, resolveUserWorkspacePath, isPathSafe } from '../workspaceUtils.js';

describe('workspaceUtils', () => {
  describe('resolveProjectRoot', () => {
    it('should return path unchanged when no .workspaces suffix', () => {
      expect(resolveProjectRoot('/projects/myapp')).toBe('/projects/myapp');
    });

    it('should strip .workspaces suffix and everything after', () => {
      expect(resolveProjectRoot('/projects/myapp/.workspaces/u_123')).toBe('/projects/myapp');
    });

    it('should strip deeply nested .workspaces path', () => {
      expect(resolveProjectRoot('/projects/myapp/.workspaces/u_abc/subdir')).toBe('/projects/myapp');
    });

    it('should handle Windows-style paths', () => {
      expect(resolveProjectRoot('D:\\projects\\myapp\\.workspaces\\u_123')).toBe('D:\\projects\\myapp');
    });
  });

  describe('resolveUserWorkspacePath', () => {
    const tmpDir = path.join(process.env.TEMP || '/tmp', 'ws-utils-test-' + process.pid);

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it('should return project root when no userId', async () => {
      const result = await resolveUserWorkspacePath(tmpDir);
      expect(result).toBe(tmpDir);
    });

    it('should return .workspaces/u_{userId} path and create directory', async () => {
      const result = await resolveUserWorkspacePath(tmpDir, 'user42');
      expect(result).toBe(path.join(tmpDir, '.workspaces', 'u_user42'));
      const stat = await fs.stat(result);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should sanitize userId with special characters', async () => {
      const result = await resolveUserWorkspacePath(tmpDir, 'user@evil/../hack');
      expect(result).toBe(path.join(tmpDir, '.workspaces', 'u_user_evil____hack'));
    });

    it('should strip existing .workspaces suffix to prevent nesting', async () => {
      const nested = path.join(tmpDir, '.workspaces', 'u_old');
      const result = await resolveUserWorkspacePath(nested, 'new');
      expect(result).toBe(path.join(tmpDir, '.workspaces', 'u_new'));
    });
  });

  describe('isPathSafe', () => {
    const base = path.resolve('/workspace/user1');

    it('should allow current directory', () => {
      expect(isPathSafe('.', base)).toBe(true);
    });

    it('should allow subdirectory', () => {
      expect(isPathSafe('docs/report.md', base)).toBe(true);
    });

    it('should reject parent traversal', () => {
      expect(isPathSafe('../../../etc/passwd', base)).toBe(false);
    });

    it('should reject null bytes', () => {
      expect(isPathSafe('file\0.txt', base)).toBe(false);
    });

    it('should reject absolute paths outside base', () => {
      expect(isPathSafe('/etc/passwd', base)).toBe(false);
    });
  });
});
