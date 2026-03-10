import express, { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { a2aAuth, type A2ARequest } from '../middleware/a2aAuth.js';
import { a2aRateLimiter } from '../middleware/rateLimiting.js';
import { resolveUserWorkspacePath, isPathSafe } from '../utils/workspaceUtils.js';
import path from 'path';
import fs from 'fs/promises';

const router: Router = express.Router({ mergeParams: true });

router.use(a2aAuth);
router.use(a2aRateLimiter);

const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB
const MAX_READ_SIZE = 10 * 1024 * 1024; // 10MB

async function resolveWorkspacePath(req: A2ARequest): Promise<string> {
  const { workingDirectory } = req.a2aContext!;
  const userId = req.query.userId as string | undefined;
  return resolveUserWorkspacePath(workingDirectory, userId);
}

// GET /browse?path=.&showHidden=false
router.get('/browse', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const requestedPath = (req.query.path as string) || '.';
    const showHidden = req.query.showHidden === 'true';

    if (!isPathSafe(requestedPath, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }

    const fullPath = path.resolve(cwdPath, requestedPath);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });

    const items = await Promise.all(
      entries
        .filter((e) => showHidden || !e.name.startsWith('.'))
        .map(async (entry) => {
          const entryPath = path.join(requestedPath === '.' ? '' : requestedPath, entry.name);
          try {
            const stat = await fs.stat(path.join(fullPath, entry.name));
            return {
              name: entry.name,
              path: entryPath,
              isDirectory: entry.isDirectory(),
              size: entry.isDirectory() ? undefined : stat.size,
              modifiedAt: stat.mtime.toISOString(),
            };
          } catch {
            return {
              name: entry.name,
              path: entryPath,
              isDirectory: entry.isDirectory(),
            };
          }
        }),
    );

    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const relativePath = path.relative(cwdPath, fullPath) || '.';
    const parentPath = relativePath === '.' ? null : path.dirname(relativePath) || '.';

    res.json({ currentPath: relativePath, parentPath, items });
  } catch (err: any) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Directory not found' });
    if (err.code === 'ENOTDIR') return res.status(400).json({ error: 'Not a directory' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /read?path=file.txt
router.get('/read', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: 'path is required' });

    if (!isPathSafe(filePath, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }

    const fullPath = path.resolve(cwdPath, filePath);
    const stat = await fs.stat(fullPath);

    if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });
    if (stat.size > MAX_READ_SIZE) {
      return res.status(413).json({ error: `File too large (${stat.size} bytes). Use download instead.` });
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ content, size: stat.size, modifiedAt: stat.mtime.toISOString() });
  } catch (err: any) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /write  body: { path, content }
router.put('/write', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: 'path and content are required' });
    }

    if (!isPathSafe(filePath, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }

    const fullPath = path.resolve(cwdPath, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    res.json({ success: true, path: filePath });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /mkdir  body: { path }
router.post('/mkdir', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'path is required' });

    if (!isPathSafe(dirPath, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }

    const fullPath = path.resolve(cwdPath, dirPath);
    await fs.mkdir(fullPath, { recursive: true });
    res.json({ success: true, path: dirPath });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /delete?path=file.txt
router.delete('/delete', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    if (filePath === '.' || filePath === '') {
      return res.status(403).json({ error: 'Cannot delete workspace root' });
    }

    if (!isPathSafe(filePath, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }

    const fullPath = path.resolve(cwdPath, filePath);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      await fs.rmdir(fullPath);
    } else {
      await fs.unlink(fullPath);
    }
    res.json({ success: true, path: filePath });
  } catch (err: any) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    if (err.code === 'ENOTEMPTY') return res.status(400).json({ error: 'Directory not empty' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /upload?path=.  multipart/form-data
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const dirPath = (req.query.path as string) || '.';

    if (!isPathSafe(dirPath, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }

    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const targetDir = path.resolve(cwdPath, dirPath);
    await fs.mkdir(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, req.file.originalname);
    await fs.writeFile(targetPath, req.file.buffer);

    const relativePath = path.relative(cwdPath, targetPath);
    res.json({ success: true, path: relativePath, size: req.file.size });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /download?path=file.txt
router.get('/download', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: 'path is required' });

    if (!isPathSafe(filePath, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }

    const fullPath = path.resolve(cwdPath, filePath);
    await fs.access(fullPath);
    const fileName = path.basename(fullPath);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.sendFile(fullPath);
  } catch (err: any) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
