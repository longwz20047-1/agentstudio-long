import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs/promises';

// Mock a2aAuth — pass through and inject a2aContext
vi.mock('../../middleware/a2aAuth.js', () => ({
  a2aAuth: (req: any, _res: any, next: any) => {
    req.a2aContext = {
      a2aAgentId: 'test-agent',
      projectId: 'test-project',
      agentType: 'claude',
      workingDirectory: req.headers['x-test-workdir'] || '/tmp/test-workspace',
      apiKeyId: 'test-key',
    };
    next();
  },
}));

// Mock rate limiter — pass through
vi.mock('../../middleware/rateLimiting.js', () => ({
  a2aRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

describe('a2aWorkspace routes', () => {
  let app: express.Application;
  const testDir = path.join(process.env.TEMP || '/tmp', 'a2a-workspace-test-' + process.pid);

  beforeEach(async () => {
    vi.clearAllMocks();
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(path.join(testDir, 'hello.txt'), 'Hello World');
    await fs.mkdir(path.join(testDir, 'subdir'), { recursive: true });
    await fs.writeFile(path.join(testDir, 'subdir', 'nested.md'), '# Nested');

    const { default: a2aWorkspaceRouter } = await import('../a2aWorkspace.js');
    app = express();
    app.use(express.json());
    app.use('/a2a/:a2aAgentId/workspace', a2aWorkspaceRouter);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  const agentUrl = '/a2a/test-agent/workspace';

  describe('GET /browse', () => {
    it('should list root directory contents', async () => {
      const res = await request(app)
        .get(`${agentUrl}/browse?path=.`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(200);
      expect(res.body.items).toBeInstanceOf(Array);
      const names = res.body.items.map((i: any) => i.name);
      expect(names).toContain('hello.txt');
      expect(names).toContain('subdir');
    });

    it('should list subdirectory', async () => {
      const res = await request(app)
        .get(`${agentUrl}/browse?path=subdir`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(200);
      const names = res.body.items.map((i: any) => i.name);
      expect(names).toContain('nested.md');
    });

    it('should reject path traversal', async () => {
      const res = await request(app)
        .get(`${agentUrl}/browse?path=../../../etc`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(403);
    });

    it('should sort directories first', async () => {
      const res = await request(app)
        .get(`${agentUrl}/browse?path=.`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(200);
      const first = res.body.items[0];
      expect(first.isDirectory).toBe(true);
      expect(first.name).toBe('subdir');
    });
  });

  describe('GET /read', () => {
    it('should read file content', async () => {
      const res = await request(app)
        .get(`${agentUrl}/read?path=hello.txt`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('Hello World');
    });

    it('should return 404 for missing file', async () => {
      const res = await request(app)
        .get(`${agentUrl}/read?path=noexist.txt`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(404);
    });

    it('should reject path traversal', async () => {
      const res = await request(app)
        .get(`${agentUrl}/read?path=../../etc/passwd`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(403);
    });

    it('should read nested file', async () => {
      const res = await request(app)
        .get(`${agentUrl}/read?path=subdir/nested.md`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('# Nested');
    });
  });

  describe('PUT /write', () => {
    it('should write file content', async () => {
      const res = await request(app)
        .put(`${agentUrl}/write`)
        .set('x-test-workdir', testDir)
        .send({ path: 'new-file.txt', content: 'New content' });
      expect(res.status).toBe(200);
      const written = await fs.readFile(path.join(testDir, 'new-file.txt'), 'utf-8');
      expect(written).toBe('New content');
    });

    it('should create parent directories automatically', async () => {
      const res = await request(app)
        .put(`${agentUrl}/write`)
        .set('x-test-workdir', testDir)
        .send({ path: 'deep/nested/file.txt', content: 'Deep' });
      expect(res.status).toBe(200);
      const written = await fs.readFile(path.join(testDir, 'deep', 'nested', 'file.txt'), 'utf-8');
      expect(written).toBe('Deep');
    });

    it('should reject path traversal', async () => {
      const res = await request(app)
        .put(`${agentUrl}/write`)
        .set('x-test-workdir', testDir)
        .send({ path: '../escape.txt', content: 'evil' });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /mkdir', () => {
    it('should create directory', async () => {
      const res = await request(app)
        .post(`${agentUrl}/mkdir`)
        .set('x-test-workdir', testDir)
        .send({ path: 'new-dir' });
      expect(res.status).toBe(200);
      const stat = await fs.stat(path.join(testDir, 'new-dir'));
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('DELETE /delete', () => {
    it('should delete file', async () => {
      const res = await request(app)
        .delete(`${agentUrl}/delete?path=hello.txt`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(200);
      await expect(fs.access(path.join(testDir, 'hello.txt'))).rejects.toThrow();
    });

    it('should reject deleting outside workspace', async () => {
      const res = await request(app)
        .delete(`${agentUrl}/delete?path=../../../important`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(403);
    });

    it('should reject deleting workspace root', async () => {
      const res = await request(app)
        .delete(`${agentUrl}/delete?path=.`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /upload', () => {
    it('should upload file to workspace', async () => {
      const res = await request(app)
        .post(`${agentUrl}/upload?path=.`)
        .set('x-test-workdir', testDir)
        .attach('file', Buffer.from('uploaded content'), 'upload.txt');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const content = await fs.readFile(path.join(testDir, 'upload.txt'), 'utf-8');
      expect(content).toBe('uploaded content');
    });

    it('should reject upload to path outside workspace', async () => {
      const res = await request(app)
        .post(`${agentUrl}/upload?path=../../etc`)
        .set('x-test-workdir', testDir)
        .attach('file', Buffer.from('evil'), 'evil.txt');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /download', () => {
    it('should download file', async () => {
      const res = await request(app)
        .get(`${agentUrl}/download?path=hello.txt`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('hello.txt');
      expect(res.text).toBe('Hello World');
    });

    it('should return 404 for missing file', async () => {
      const res = await request(app)
        .get(`${agentUrl}/download?path=noexist.bin`)
        .set('x-test-workdir', testDir);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /rename', () => {
    it('should rename a file', async () => {
      await fs.writeFile(path.join(testDir, 'old.txt'), 'content');
      const res = await request(app)
        .post(`${agentUrl}/rename`)
        .set('x-test-workdir', testDir)
        .send({ oldPath: 'old.txt', newPath: 'new.txt' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      await expect(fs.access(path.join(testDir, 'new.txt'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(testDir, 'old.txt'))).rejects.toThrow();
    });

    it('should return 409 if target exists', async () => {
      await fs.writeFile(path.join(testDir, 'a.txt'), '1');
      await fs.writeFile(path.join(testDir, 'b.txt'), '2');
      const res = await request(app)
        .post(`${agentUrl}/rename`)
        .set('x-test-workdir', testDir)
        .send({ oldPath: 'a.txt', newPath: 'b.txt' });
      expect(res.status).toBe(409);
      expect(res.body.exists).toBe(true);
    });

    it('should reject path traversal', async () => {
      await fs.writeFile(path.join(testDir, 'file.txt'), 'x');
      const res = await request(app)
        .post(`${agentUrl}/rename`)
        .set('x-test-workdir', testDir)
        .send({ oldPath: 'file.txt', newPath: '../../etc/evil' });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /move', () => {
    it('should move file into directory', async () => {
      await fs.writeFile(path.join(testDir, 'file.txt'), 'data');
      await fs.mkdir(path.join(testDir, 'movedir'));
      const res = await request(app)
        .post(`${agentUrl}/move`)
        .set('x-test-workdir', testDir)
        .send({ source: 'file.txt', destination: 'movedir' });
      expect(res.status).toBe(200);
      await expect(fs.access(path.join(testDir, 'movedir', 'file.txt'))).resolves.toBeUndefined();
    });

    it('should return 409 if target exists without force', async () => {
      await fs.writeFile(path.join(testDir, 'src.txt'), '1');
      await fs.mkdir(path.join(testDir, 'dest'));
      await fs.writeFile(path.join(testDir, 'dest', 'src.txt'), '2');
      const res = await request(app)
        .post(`${agentUrl}/move`)
        .set('x-test-workdir', testDir)
        .send({ source: 'src.txt', destination: 'dest' });
      expect(res.status).toBe(409);
    });

    it('should prevent moving directory into itself', async () => {
      await fs.mkdir(path.join(testDir, 'parent', 'child'), { recursive: true });
      const res = await request(app)
        .post(`${agentUrl}/move`)
        .set('x-test-workdir', testDir)
        .send({ source: 'parent', destination: 'parent/child' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /copy', () => {
    it('should copy file into directory', async () => {
      await fs.writeFile(path.join(testDir, 'orig.txt'), 'data');
      await fs.mkdir(path.join(testDir, 'target'));
      const res = await request(app)
        .post(`${agentUrl}/copy`)
        .set('x-test-workdir', testDir)
        .send({ source: 'orig.txt', destination: 'target' });
      expect(res.status).toBe(200);
      // Original still exists
      await expect(fs.access(path.join(testDir, 'orig.txt'))).resolves.toBeUndefined();
      // Copy exists
      await expect(fs.access(path.join(testDir, 'target', 'orig.txt'))).resolves.toBeUndefined();
    });

    it('should copy directory recursively', async () => {
      await fs.mkdir(path.join(testDir, 'srcdir'));
      await fs.writeFile(path.join(testDir, 'srcdir', 'a.txt'), 'aaa');
      await fs.mkdir(path.join(testDir, 'destdir'));
      const res = await request(app)
        .post(`${agentUrl}/copy`)
        .set('x-test-workdir', testDir)
        .send({ source: 'srcdir', destination: 'destdir' });
      expect(res.status).toBe(200);
      await expect(fs.access(path.join(testDir, 'destdir', 'srcdir', 'a.txt'))).resolves.toBeUndefined();
    });
  });

  describe('GET /search', () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(testDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(testDir, 'src', 'index.ts'), 'export function hello() {}');
      await fs.writeFile(path.join(testDir, 'src', 'utils.ts'), 'export const x = 1;');
      await fs.writeFile(path.join(testDir, 'readme.md'), '# Hello');
    });

    it('should search by filename', async () => {
      const res = await request(app)
        .get(`${agentUrl}/search`)
        .set('x-test-workdir', testDir)
        .query({ type: 'filename', query: 'index' });
      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].name).toContain('index');
    });

    it('should search by content', async () => {
      const res = await request(app)
        .get(`${agentUrl}/search`)
        .set('x-test-workdir', testDir)
        .query({ type: 'content', query: 'hello' });
      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].matches.length).toBeGreaterThan(0);
    });

    it('should search by filetype', async () => {
      const res = await request(app)
        .get(`${agentUrl}/search`)
        .set('x-test-workdir', testDir)
        .query({ type: 'filetype', query: '.ts' });
      expect(res.status).toBe(200);
      expect(res.body.results.length).toBe(2);
    });
  });
});
