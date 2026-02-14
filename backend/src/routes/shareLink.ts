// backend/src/routes/shareLink.ts
// 链接分享公开路由（无需 JWT 认证）
import express from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import { ShareService } from '../services/shareService.js';
import { ShareContentService } from '../services/shareContentService.js';
import { getMinioFileStream } from '../services/minioService.js';

const router: express.Router = express.Router();

let shareService: ShareService;
let contentService: ShareContentService;

export function initShareLinkRoutes(ss: ShareService, cs: ShareContentService) {
  shareService = ss;
  contentService = cs;
}

/**
 * 解析分页参数（同时支持 page_size 和 pageSize）
 */
function getPageSize(req: express.Request, defaultVal = 20): number {
  return parseInt((req.query.page_size || req.query.pageSize) as string) || defaultVal;
}

// 服务可用性检查
router.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!shareService || !contentService) {
    res.status(503).json({ success: false, error: 'Share service not available' });
    return;
  }
  next();
});

// 获取链接分享信息（无需密码验证）
router.get('/:token', async (req: express.Request, res: express.Response) => {
  try {
    const share = await shareService.getShareByToken(req.params.token);
    if (!share) {
      res.status(404).json({ success: false, error: 'Share not found' });
      return;
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      res.status(410).json({ success: false, error: 'Share expired' });
      return;
    }

    res.json({
      success: true,
      data: {
        shareId: share.id,
        shareType: share.share_type,
        targetName: share.target_name,
        ownerUsername: share.owner_username,
        needPassword: !!share.link_password,
        expiresAt: share.expires_at,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 验证链接密码
router.post('/:token/verify', async (req: express.Request, res: express.Response) => {
  try {
    const { password } = req.body;
    const valid = await shareService.verifyLinkPassword(req.params.token, password);

    if (!valid) {
      res.status(401).json({ success: false, error: 'Invalid password' });
      return;
    }

    // 设置验证 Cookie
    const timestamp = Date.now();
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error('[ShareRoutes] JWT_SECRET not configured for cookie signing');
      res.status(500).json({ success: false, error: 'Server configuration error' });
      return;
    }

    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${req.params.token}:${timestamp}`)
      .digest('hex');

    res.cookie('share_verified', `${req.params.token}:${timestamp}:${signature}`, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享内容获取中间件（Cookie 验证 + share 挂载到 req 避免重复查询）
async function validateLinkCookie(req: express.Request, res: express.Response, next: express.NextFunction) {
  const share = await shareService.getShareByToken(req.params.token);

  if (!share) {
    res.status(404).json({ success: false, error: 'SHARE_NOT_FOUND' });
    return;
  }

  // 检查过期
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    res.status(410).json({ success: false, error: 'SHARE_EXPIRED' });
    return;
  }

  // 将 share 挂载到 req 上，后续路由直接使用
  (req as any).share = share;

  // 无密码保护，直接放行
  if (!share.link_password) {
    return next();
  }

  const cookie = req.cookies?.share_verified;
  if (!cookie) {
    res.status(401).json({ success: false, error: 'Password verification required' });
    return;
  }

  const [cookieToken, timestampStr, signature] = cookie.split(':');
  const timestamp = parseInt(timestampStr, 10);

  if (cookieToken !== req.params.token) {
    res.status(401).json({ success: false, error: 'Invalid verification' });
    return;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(500).json({ success: false, error: 'Server configuration error' });
    return;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${req.params.token}:${timestamp}`)
    .digest('hex');

  // 使用常量时间比较防止 timing attack
  const expected = Buffer.from(expectedSignature, 'hex');
  const actual = Buffer.from(signature, 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    res.status(401).json({ success: false, error: 'Invalid signature' });
    return;
  }

  if (Date.now() - timestamp > 24 * 60 * 60 * 1000) {
    res.status(401).json({ success: false, error: 'Verification expired' });
    return;
  }

  next();
}

// 链接分享 - 知识库详情
router.get('/:token/kb', validateLinkCookie, async (req: express.Request, res: express.Response) => {
  try {
    const share = (req as any).share;
    const data = await contentService.getKnowledgeBase(share.id);
    await shareService.incrementViewCount(share.id);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享 - 文档分类标签
router.get('/:token/kb/tags', validateLinkCookie, async (req: express.Request, res: express.Response) => {
  try {
    const share = (req as any).share;
    const data = await contentService.getKnowledgeBaseTags(share.id);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享 - 树形文档分类标签
router.get('/:token/kb/tag-tree', validateLinkCookie, async (req: express.Request, res: express.Response) => {
  try {
    const share = (req as any).share;
    const data = await contentService.getTagTree(share.id);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享 - 文档列表
router.get('/:token/kb/documents', validateLinkCookie, async (req: express.Request, res: express.Response) => {
  try {
    const share = (req as any).share;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = getPageSize(req);

    const data = await contentService.getKnowledgeBaseDocuments(share.id, page, pageSize);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享 - 文档详情（知识库分享需传 ?docId=xxx）
router.get('/:token/doc', validateLinkCookie, async (req: express.Request, res: express.Response) => {
  try {
    const share = (req as any).share;
    const docId = req.query.docId as string | undefined;
    const data = await contentService.getDocument(share.id, docId);
    await shareService.incrementViewCount(share.id);
    await shareService.logAccess(share.id, 'view', undefined, req.ip);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享 - 分块内容（知识库分享需传 ?docId=xxx）
router.get('/:token/doc/chunks', validateLinkCookie, async (req: express.Request, res: express.Response) => {
  try {
    const share = (req as any).share;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = getPageSize(req, 25);
    const docId = req.query.docId as string | undefined;

    const data = await contentService.getDocumentChunks(share.id, page, pageSize, docId);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享 - 下载文档（知识库分享需传 ?docId=xxx）
router.get('/:token/doc/download', validateLinkCookie, async (req: express.Request, res: express.Response) => {
  try {
    const share = (req as any).share;
    const docId = req.query.docId as string | undefined;
    const downloadInfo = await contentService.getDownloadInfo(share.id, docId);

    const contentType = downloadInfo.fileType && downloadInfo.fileType.includes('/')
      ? downloadInfo.fileType
      : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadInfo.fileName)}"`);
    if (downloadInfo.fileSize) {
      res.setHeader('Content-Length', downloadInfo.fileSize);
    }

    if (downloadInfo.isMinioPath) {
      // MinIO 存储：通过 MinIO SDK 认证下载
      const fileStream = await getMinioFileStream(downloadInfo.filePath);
      await pipeline(fileStream, res);
    } else {
      // 本地文件
      const fileStream = fs.createReadStream(downloadInfo.filePath);
      fileStream.pipe(res);
    }
  } catch (error: any) {
    if (!res.headersSent) {
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Length');
      const status = error.message === 'FILE_NOT_FOUND' ? 404 : 500;
      res.status(status).json({ success: false, error: error.message });
    }
  }
});

// 链接分享 - 内容搜索
router.get('/:token/search', validateLinkCookie, async (req: express.Request, res: express.Response) => {
  try {
    const share = (req as any).share;
    const keyword = req.query.q as string;
    if (!keyword || keyword.trim().length < 2) {
      res.status(400).json({ success: false, error: 'Search keyword must be at least 2 characters' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = getPageSize(req);

    const data = await contentService.searchContent(share.id, keyword.trim(), page, pageSize);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
