import express, { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { a2aAuth, type A2ARequest } from '../middleware/a2aAuth.js';
import { a2aRateLimiter } from '../middleware/rateLimiting.js';
import { resolveUserWorkspacePath, isPathSafe } from '../utils/workspaceUtils.js';
import { resolveA2AId } from '../services/a2a/agentMappingService.js';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import { buildOnlyOfficeConfig, verifyFileToken, rewriteCallbackUrl } from '../services/workspace/onlyofficeService.js';

const router: Router = express.Router({ mergeParams: true });

// --- OnlyOffice file/callback: exempt from a2aAuth ---
// Document Server calls these without API key; HMAC token provides authentication
async function resolveWorkspacePathByAgentId(req: Request): Promise<string> {
  const a2aAgentId = req.params.a2aAgentId;
  const mapping = await resolveA2AId(a2aAgentId);
  if (!mapping) throw new Error('Agent not found');
  const userId = req.query.userId as string | undefined;
  return resolveUserWorkspacePath(mapping.workingDirectory, userId);
}

router.get('/onlyoffice/file', async (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    const token = req.query.token as string;
    if (!filePath || !token) return res.status(400).json({ error: 'path and token are required' });
    if (!verifyFileToken(filePath, token)) return res.status(403).json({ error: 'Invalid token' });
    const cwdPath = await resolveWorkspacePathByAgentId(req);
    if (!isPathSafe(filePath, cwdPath)) return res.status(403).json({ error: 'Path outside workspace' });

    const fullPath = path.resolve(cwdPath, filePath);
    res.sendFile(fullPath);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/onlyoffice/callback', async (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    const token = req.query.token as string;
    if (!filePath || !token) return res.status(400).json({ error: 'path and token are required' });
    if (!verifyFileToken(filePath, token)) return res.status(403).json({ error: 'Invalid token' });
    const cwdPath = await resolveWorkspacePathByAgentId(req);
    if (!isPathSafe(filePath, cwdPath)) return res.status(403).json({ error: 'Path outside workspace' });

    const { status, url } = req.body;

    if (status === 2 && url) {
      const downloadUrl = rewriteCallbackUrl(url);
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const fullPath = path.resolve(cwdPath, filePath);
      await fs.writeFile(fullPath, buffer);
    }

    res.json({ error: 0 }); // OnlyOffice expects { error: 0 } for success
  } catch {
    res.json({ error: 0 }); // Must still return success to prevent OnlyOffice retry loop
  }
});

// --- Auth-protected routes below ---
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
      await fs.rm(fullPath, { recursive: true });
    } else {
      await fs.unlink(fullPath);
    }
    res.json({ success: true, path: filePath });
  } catch (err: any) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
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

// POST /rename  body: { oldPath, newPath }
router.post('/rename', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: 'oldPath and newPath are required' });
    }
    if (!isPathSafe(oldPath, cwdPath) || !isPathSafe(newPath, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }
    const fullOld = path.resolve(cwdPath, oldPath);
    const fullNew = path.resolve(cwdPath, newPath);
    try {
      const stat = await fs.stat(fullNew);
      return res.status(409).json({
        error: `Destination already exists: ${newPath}`,
        exists: true,
        existingType: stat.isDirectory() ? 'directory' : 'file',
      });
    } catch { /* target doesn't exist — proceed */ }
    await fs.rename(fullOld, fullNew);
    res.json({ success: true, oldPath, newPath });
  } catch (err: any) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Source not found' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /move  body: { source, destination, force? }
router.post('/move', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const { source, destination, force } = req.body;
    if (!source || !destination) {
      return res.status(400).json({ error: 'source and destination are required' });
    }
    if (!isPathSafe(source, cwdPath) || !isPathSafe(destination, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }
    const fullSource = path.resolve(cwdPath, source);
    const fullDest = path.resolve(cwdPath, destination);
    if (fullDest.startsWith(fullSource + path.sep) || fullDest === fullSource) {
      return res.status(400).json({ error: 'Cannot move directory into itself' });
    }
    const sourceName = path.basename(fullSource);
    await fs.mkdir(fullDest, { recursive: true });
    const targetPath = path.join(fullDest, sourceName);
    if (!force) {
      try {
        const stat = await fs.stat(targetPath);
        return res.status(409).json({
          error: `Destination already exists: ${path.relative(cwdPath, targetPath)}`,
          exists: true,
          existingType: stat.isDirectory() ? 'directory' : 'file',
        });
      } catch { /* OK */ }
    } else {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
    }
    await fs.rename(fullSource, targetPath);
    res.json({ success: true, path: path.relative(cwdPath, targetPath) });
  } catch (err: any) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Source not found' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /copy  body: { source, destination, force? }
router.post('/copy', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const { source, destination, force } = req.body;
    if (!source || !destination) {
      return res.status(400).json({ error: 'source and destination are required' });
    }
    if (!isPathSafe(source, cwdPath) || !isPathSafe(destination, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }
    const fullSource = path.resolve(cwdPath, source);
    const fullDest = path.resolve(cwdPath, destination);
    const sourceName = path.basename(fullSource);
    await fs.mkdir(fullDest, { recursive: true });
    const targetPath = path.join(fullDest, sourceName);
    if (!force) {
      try {
        const stat = await fs.stat(targetPath);
        return res.status(409).json({
          error: `Destination already exists: ${path.relative(cwdPath, targetPath)}`,
          exists: true,
          existingType: stat.isDirectory() ? 'directory' : 'file',
        });
      } catch { /* OK */ }
    } else {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
    }
    const stat = await fs.stat(fullSource);
    if (stat.isDirectory()) {
      await fs.cp(fullSource, targetPath, { recursive: true });
    } else {
      await fs.copyFile(fullSource, targetPath);
    }
    res.json({ success: true, path: path.relative(cwdPath, targetPath) });
  } catch (err: any) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Source not found' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

const SEARCH_EXCLUDE = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.nuxt', 'coverage', '.workspaces']);
const MAX_CONTENT_FILE_SIZE = 1 * 1024 * 1024; // 1MB

async function walkDir(dir: string, basePath: string, results: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SEARCH_EXCLUDE.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(basePath, fullPath);
    if (entry.isDirectory()) {
      await walkDir(fullPath, basePath, results);
    } else {
      results.push(relPath);
    }
  }
}

// GET /search?type=filename|content|filetype&query=...&path=.&limit=50
router.get('/search', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const type = (req.query.type as string) || 'filename';
    const query = req.query.query as string;
    const searchBase = (req.query.path as string) || '.';
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    if (!query) return res.status(400).json({ error: 'query is required' });
    if (!isPathSafe(searchBase, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }

    const searchDir = path.resolve(cwdPath, searchBase);
    const allFiles: string[] = [];
    await walkDir(searchDir, cwdPath, allFiles);

    if (type === 'filename') {
      const lowerQuery = query.toLowerCase();
      const results = allFiles
        .filter(f => path.basename(f).toLowerCase().includes(lowerQuery))
        .slice(0, limit)
        .map(f => ({ name: path.basename(f), path: f, isDirectory: false }));
      return res.json({ results });
    }

    if (type === 'filetype') {
      const exts = query.split(',').map(e => e.trim().toLowerCase()).map(e => e.startsWith('.') ? e : '.' + e);
      const results = allFiles
        .filter(f => exts.includes(path.extname(f).toLowerCase()))
        .slice(0, limit)
        .map(f => ({ name: path.basename(f), path: f, isDirectory: false }));
      return res.json({ results });
    }

    if (type === 'content') {
      const results: Array<{ path: string; matches: Array<{ line: string; lineNumber: number }> }> = [];
      let truncated = false;
      const startTime = Date.now();
      for (const filePath of allFiles) {
        if (Date.now() - startTime > 5000) { truncated = true; break; }
        if (results.length >= limit) break;
        const fullPath = path.resolve(cwdPath, filePath);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > MAX_CONTENT_FILE_SIZE) continue;
          const content = await fs.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          const matches: Array<{ line: string; lineNumber: number }> = [];
          const lowerQuery = query.toLowerCase();
          for (let i = 0; i < lines.length && matches.length < 5; i++) {
            if (lines[i].toLowerCase().includes(lowerQuery)) {
              matches.push({ line: lines[i].slice(0, 200), lineNumber: i + 1 });
            }
          }
          if (matches.length > 0) results.push({ path: filePath, matches });
        } catch { /* skip unreadable files */ }
      }
      return res.json({ results, truncated });
    }

    res.status(400).json({ error: 'Invalid type. Use: filename, content, filetype' });
  } catch (err: any) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Search directory not found' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

const MAX_ZIP_SIZE = 50 * 1024 * 1024; // 50MB

// POST /compress  body: { paths[], outputName }
router.post('/compress', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const { paths: inputPaths, outputName } = req.body;
    if (!inputPaths?.length || !outputName) {
      return res.status(400).json({ error: 'paths and outputName are required' });
    }
    for (const p of inputPaths) {
      if (!isPathSafe(p, cwdPath)) return res.status(403).json({ error: 'Path outside workspace' });
    }
    if (!isPathSafe(outputName, cwdPath)) {
      return res.status(403).json({ error: 'Output path outside workspace' });
    }
    const outputPath = path.resolve(cwdPath, outputName);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const fileEntries: Array<{ fullPath: string; name: string; isDir: boolean }> = [];
    for (const p of inputPaths) {
      const fullPath = path.resolve(cwdPath, p);
      const stat = await fs.stat(fullPath);
      fileEntries.push({ fullPath, name: path.basename(p), isDir: stat.isDirectory() });
    }
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      for (const entry of fileEntries) {
        if (entry.isDir) {
          archive.directory(entry.fullPath, entry.name);
        } else {
          archive.file(entry.fullPath, { name: entry.name });
        }
      }
      archive.finalize();
    });
    res.json({ success: true, path: outputName });
  } catch (err: any) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Source not found' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /extract  body: { zipPath, targetDir? }
router.post('/extract', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const { zipPath, targetDir } = req.body;
    if (!zipPath) return res.status(400).json({ error: 'zipPath is required' });
    if (!isPathSafe(zipPath, cwdPath)) {
      return res.status(403).json({ error: 'Path outside workspace' });
    }
    const target = targetDir || path.dirname(zipPath);
    if (!isPathSafe(target, cwdPath)) {
      return res.status(403).json({ error: 'Target path outside workspace' });
    }
    const fullZipPath = path.resolve(cwdPath, zipPath);
    const stat = await fs.stat(fullZipPath);
    if (stat.size > MAX_ZIP_SIZE) {
      return res.status(413).json({ error: `ZIP file too large (max ${MAX_ZIP_SIZE / 1024 / 1024}MB)` });
    }
    const fullTarget = path.resolve(cwdPath, target);
    await fs.mkdir(fullTarget, { recursive: true });
    const zip = new AdmZip(fullZipPath);
    const entries = zip.getEntries();
    for (const entry of entries) {
      const entryTarget = path.resolve(fullTarget, entry.entryName);
      if (!entryTarget.startsWith(fullTarget + path.sep) && entryTarget !== fullTarget) {
        return res.status(400).json({ error: 'ZIP contains path traversal entries' });
      }
    }
    zip.extractAllTo(fullTarget, true);
    res.json({ success: true, path: target });
  } catch (err: any) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'ZIP file not found' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /onlyoffice/config?path=file.docx&mode=edit
router.get('/onlyoffice/config', async (req: Request, res: Response) => {
  try {
    const cwdPath = await resolveWorkspacePath(req as A2ARequest);
    const filePath = req.query.path as string;
    const mode = (req.query.mode as string) === 'edit' ? 'edit' : 'view';
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    if (!isPathSafe(filePath, cwdPath)) return res.status(403).json({ error: 'Path outside workspace' });

    const agentId = (req as A2ARequest).a2aContext!.a2aAgentId;
    const internalUrl = process.env.ONLYOFFICE_INTERNAL_URL || `http://localhost:4936`;
    const result = buildOnlyOfficeConfig(filePath, mode, agentId, internalUrl);
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
