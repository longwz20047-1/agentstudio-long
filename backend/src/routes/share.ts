// backend/src/routes/share.ts
// 参考: backend/src/routes/users.ts 的路由结构模式

import express from 'express';
import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import { ShareService } from '../services/shareService.js';
import { ShareContentService } from '../services/shareContentService.js';
import { weknoraUserService } from '../services/weknoraUserService.js';
import { getMinioFileStream } from '../services/minioService.js';

const router: express.Router = express.Router();

// 服务实例（在 initShareRoutes 中初始化）
let shareService: ShareService;
let contentService: ShareContentService;

export function initShareRoutes() {
  const pool = weknoraUserService.getDbPool();
  if (!pool) {
    console.warn('[ShareRoutes] WeKnora database not available, share routes will not function');
    return;
  }
  shareService = new ShareService(pool);
  contentService = new ShareContentService(pool, shareService);
  console.log('[ShareRoutes] Share services initialized');
}

export function getShareServices() {
  return { shareService, contentService };
}

// ========== 辅助函数 ==========

/**
 * 服务可用性检查中间件
 */
function requireShareService(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!shareService || !contentService) {
    res.status(503).json({ success: false, error: 'Share service not available' });
    return;
  }
  next();
}

// 应用到所有路由
router.use(requireShareService);

/**
 * 从请求中提取 userId（查询参数或请求体）
 */
function getUserId(req: express.Request): string | undefined {
  return (req.query.userId as string) || req.body?.userId;
}

function getTenantId(req: express.Request): number | undefined {
  const raw = (req.query.tenantId as string) || req.body?.tenantId;
  if (!raw) return undefined;
  const parsed = parseInt(String(raw), 10);
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * 解析分页参数（同时支持 page_size 和 pageSize）
 */
function getPageSize(req: express.Request, defaultVal = 20): number {
  return parseInt((req.query.page_size || req.query.pageSize) as string) || defaultVal;
}

/**
 * 所有权验证：检查当前用户是否为分享的创建者
 */
async function verifyOwnership(
  req: express.Request,
  res: express.Response,
  shareId: string
): Promise<{ share: any } | null> {
  const share = await shareService.getShareById(shareId);
  if (!share) {
    res.status(404).json({ success: false, error: 'SHARE_NOT_FOUND' });
    return null;
  }
  const userId = getUserId(req);
  if (share.owner_user_id !== userId) {
    res.status(403).json({ success: false, error: 'NOT_OWNER' });
    return null;
  }
  return { share };
}

/**
 * 访问权限验证：检查当前用户是否有权访问分享内容
 * - public 模式：所有已认证用户可访问
 * - user 模式：仅 share_targets 中的用户 + owner 可访问
 * - link 模式：仅 owner 可通过 JWT 路由访问（其他人走链接分享公开路由）
 */
async function verifyAccess(
  req: express.Request,
  res: express.Response,
  shareId: string
): Promise<{ share: any } | null> {
  const share = await shareService.getShareById(shareId);
  if (!share) {
    res.status(404).json({ success: false, error: 'SHARE_NOT_FOUND' });
    return null;
  }

  // 检查过期
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    res.status(410).json({ success: false, error: 'SHARE_EXPIRED' });
    return null;
  }

  // owner 始终有权访问
  const userId = getUserId(req);
  if (share.owner_user_id === userId) {
    return { share };
  }

  // public 模式：所有已认证用户可访问
  if (share.share_mode === 'public') {
    return { share };
  }

  // user 模式：检查是否在目标用户列表中
  if (share.share_mode === 'user' && userId) {
    const targets = await shareService.getShareTargets(shareId);
    if (targets.some(t => t.target_user_id === userId)) {
      return { share };
    }
  }

  res.status(403).json({ success: false, error: 'NO_PERMISSION' });
  return null;
}

// ========== 重要：路由定义顺序 ==========
// 固定路径路由必须在参数路由之前定义，否则会被 /:id 匹配

// ========== 分享列表（固定路径，优先匹配） ==========

// 我创建的分享
router.get('/list/my-shares', async (req: express.Request, res: express.Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(400).json({ success: false, error: 'userId is required' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = getPageSize(req);
    const shareType = (req.query.share_type || req.query.shareType) as any;

    const result = await shareService.getMyShares(userId, page, pageSize, shareType);
    res.json({ success: true, data: { ...result, page, pageSize } });
  } catch (error: any) {
    console.error('Failed to get my shares:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 分享给我的
router.get('/list/shared-to-me', async (req: express.Request, res: express.Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(400).json({ success: false, error: 'userId is required' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = getPageSize(req);
    const shareType = (req.query.share_type || req.query.shareType) as any;

    const result = await shareService.getSharedToMe(userId, page, pageSize, shareType);
    res.json({ success: true, data: { ...result, page, pageSize } });
  } catch (error: any) {
    console.error('Failed to get shared-to-me:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 公开的分享
router.get('/list/public', async (req: express.Request, res: express.Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = getPageSize(req);
    const shareType = (req.query.share_type || req.query.shareType) as any;

    const result = await shareService.getPublicShares(page, pageSize, shareType);
    res.json({ success: true, data: { ...result, page, pageSize } });
  } catch (error: any) {
    console.error('Failed to get public shares:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 检查分享状态
router.get('/check/:type/:targetId', async (req: express.Request, res: express.Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(400).json({ success: false, error: 'userId is required' });
      return;
    }
    const { type, targetId } = req.params;
    const shareMode = req.query.shareMode as string | undefined;

    const result = await shareService.checkShareExists(type as any, targetId, userId, shareMode);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== 分享管理（参数路由，放在固定路径之后） ==========

// 创建分享 - userId/tenantId/username 从请求体获取
router.post('/', async (req: express.Request, res: express.Response) => {
  try {
    const { userId, tenantId, username, shareType, targetId, shareMode, linkPassword } = req.body;

    // 基础必填校验
    if (!userId || tenantId === undefined) {
      res.status(400).json({ success: false, error: 'userId and tenantId are required' });
      return;
    }

    // 枚举值校验
    if (!['knowledge_base', 'knowledge'].includes(shareType)) {
      res.status(400).json({ success: false, error: 'shareType must be knowledge_base or knowledge' });
      return;
    }
    if (!targetId || typeof targetId !== 'string') {
      res.status(400).json({ success: false, error: 'targetId is required' });
      return;
    }
    if (!['public', 'user', 'link'].includes(shareMode)) {
      res.status(400).json({ success: false, error: 'shareMode must be public, user or link' });
      return;
    }

    // 链接密码长度校验
    if (linkPassword && (linkPassword.length < 4 || linkPassword.length > 32)) {
      res.status(400).json({ success: false, error: 'linkPassword must be 4-32 characters' });
      return;
    }

    const result = await shareService.createShare(req.body);

    const shareUrl = result.shareLinkToken
      ? `${process.env.WEKNORA_UI_URL || ''}/s/${result.shareLinkToken}`
      : undefined;

    res.json({
      success: true,
      data: {
        shareId: result.shareId,
        shareLinkToken: result.shareLinkToken,
        shareUrl,
      },
    });
  } catch (error: any) {
    console.error('Failed to create share:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取分享详情
router.get('/:id', async (req: express.Request, res: express.Response) => {
  try {
    const share = await shareService.getShareById(req.params.id);
    if (!share) {
      res.status(404).json({ success: false, error: 'Share not found' });
      return;
    }
    // 返回前端期望的字段名（兼容 snake_case 和 camelCase）
    res.json({ success: true, data: {
      ...share,
      shareId: share.id,
      shareType: share.share_type,
      targetId: share.target_id,
      targetName: share.target_name,
      targetKbId: share.target_kb_id,
      shareMode: share.share_mode,
      ownerUserId: share.owner_user_id,
      ownerUsername: share.owner_username,
      viewCount: share.view_count,
      createdAt: share.created_at?.toISOString?.() || share.created_at,
      expiresAt: share.expires_at?.toISOString?.() || share.expires_at,
    } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 更新分享（需所有权验证）
router.put('/:id', async (req: express.Request, res: express.Response) => {
  try {
    const result = await verifyOwnership(req, res, req.params.id);
    if (!result) return;

    await shareService.updateShare(req.params.id, req.body);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除分享（需所有权验证）
router.delete('/:id', async (req: express.Request, res: express.Response) => {
  try {
    const result = await verifyOwnership(req, res, req.params.id);
    if (!result) return;

    await shareService.deleteShare(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== 分享目标用户管理（需所有权验证） ==========

router.get('/:id/targets', async (req: express.Request, res: express.Response) => {
  try {
    const result = await verifyOwnership(req, res, req.params.id);
    if (!result) return;

    const targets = await shareService.getShareTargets(req.params.id);
    res.json({
      success: true,
      data: targets.map((t) => ({
        userId: t.target_user_id,
        username: t.target_username,
        email: t.target_email,
        tenantId: t.target_tenant_id,
        acceptedAt: t.accepted_at?.toISOString(),
        createdAt: t.created_at?.toISOString(),
      })),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/targets', async (req: express.Request, res: express.Response) => {
  try {
    const result = await verifyOwnership(req, res, req.params.id);
    if (!result) return;

    const { userId, email } = req.body;
    if (!userId && !email) {
      res.status(400).json({ success: false, error: 'userId or email is required' });
      return;
    }

    let targetUserId = userId;
    if (!targetUserId && email) {
      const user = await shareService.findUserByEmail(email);
      if (!user) {
        res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
        return;
      }
      targetUserId = user.id;
    }

    const target = await shareService.addShareTarget(req.params.id, targetUserId);
    if (!target) {
      res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
      return;
    }

    res.json({ success: true, data: target });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id/targets/:targetUserId', async (req: express.Request, res: express.Response) => {
  try {
    const result = await verifyOwnership(req, res, req.params.id);
    if (!result) return;

    const removed = await shareService.removeShareTarget(req.params.id, req.params.targetUserId);
    if (!removed) {
      res.status(404).json({ success: false, error: 'Target not found' });
      return;
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== 内容获取（需 JWT 认证 + 访问权限验证） ==========

router.get('/:shareId/kb', async (req: express.Request, res: express.Response) => {
  try {
    const access = await verifyAccess(req, res, req.params.shareId);
    if (!access) return;

    const data = await contentService.getKnowledgeBase(req.params.shareId);
    await shareService.incrementViewCount(req.params.shareId);
    await shareService.logAccess(req.params.shareId, 'view', getUserId(req), req.ip);
    res.json({ success: true, data });
  } catch (error: any) {
    const status = error.message === 'SHARE_NOT_FOUND' ? 404 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// 获取知识库的文档分类标签
router.get('/:shareId/kb/tags', async (req: express.Request, res: express.Response) => {
  try {
    const access = await verifyAccess(req, res, req.params.shareId);
    if (!access) return;

    const data = await contentService.getKnowledgeBaseTags(req.params.shareId);
    res.json({ success: true, data });
  } catch (error: any) {
    const status = error.message === 'SHARE_NOT_FOUND' ? 404 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// 获取知识库的树形文档分类标签
router.get('/:shareId/kb/tag-tree', async (req: express.Request, res: express.Response) => {
  try {
    const access = await verifyAccess(req, res, req.params.shareId);
    if (!access) return;

    const data = await contentService.getTagTree(req.params.shareId);
    res.json({ success: true, data });
  } catch (error: any) {
    const status = error.message === 'SHARE_NOT_FOUND' ? 404 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

router.get('/:shareId/kb/documents', async (req: express.Request, res: express.Response) => {
  try {
    const access = await verifyAccess(req, res, req.params.shareId);
    if (!access) return;

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = getPageSize(req);

    const data = await contentService.getKnowledgeBaseDocuments(req.params.shareId, page, pageSize);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 文档详情（知识库分享需传 ?docId=xxx）
router.get('/:shareId/doc', async (req: express.Request, res: express.Response) => {
  try {
    const access = await verifyAccess(req, res, req.params.shareId);
    if (!access) return;

    const docId = req.query.docId as string | undefined;
    const data = await contentService.getDocument(req.params.shareId, docId);
    await shareService.incrementViewCount(req.params.shareId);
    await shareService.logAccess(req.params.shareId, 'view', getUserId(req), req.ip);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 文档分块（知识库分享需传 ?docId=xxx）
router.get('/:shareId/doc/chunks', async (req: express.Request, res: express.Response) => {
  try {
    const access = await verifyAccess(req, res, req.params.shareId);
    if (!access) return;

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = getPageSize(req, 25);
    const docId = req.query.docId as string | undefined;

    const data = await contentService.getDocumentChunks(req.params.shareId, page, pageSize, docId);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 文档下载（知识库分享需传 ?docId=xxx）
router.get('/:shareId/doc/download', async (req: express.Request, res: express.Response) => {
  try {
    const access = await verifyAccess(req, res, req.params.shareId);
    if (!access) return;

    const docId = req.query.docId as string | undefined;
    const downloadInfo = await contentService.getDownloadInfo(req.params.shareId, docId);

    await shareService.logAccess(req.params.shareId, 'download', getUserId(req), req.ip);

    // fileType 可能是 "pdf" 等非标准 MIME，需包含 "/" 才是合法 Content-Type
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

// 在分享内容中搜索
router.get('/:shareId/search', async (req: express.Request, res: express.Response) => {
  try {
    const access = await verifyAccess(req, res, req.params.shareId);
    if (!access) return;

    const keyword = req.query.q as string;
    if (!keyword || keyword.trim().length < 2) {
      res.status(400).json({ success: false, error: 'Search keyword must be at least 2 characters' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = getPageSize(req);

    const data = await contentService.searchContent(req.params.shareId, keyword.trim(), page, pageSize);
    res.json({ success: true, data });
  } catch (error: any) {
    const status = error.message === 'SHARE_NOT_FOUND' ? 404 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

export default router;
