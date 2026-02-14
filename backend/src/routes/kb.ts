// backend/src/routes/kb.ts
import express from 'express';
import { TagService } from '../services/tagService.js';
import { weknoraUserService } from '../services/weknoraUserService.js';
import type { DeleteStrategy } from '../types/tag.js';

const router: express.Router = express.Router();

let tagService: TagService;

export function initKbRoutes() {
  const pool = weknoraUserService.getDbPool();
  if (!pool) {
    console.warn('[KbRoutes] WeKnora database not available, kb routes will not function');
    return;
  }
  tagService = new TagService(pool);
  console.log('[KbRoutes] KB routes initialized');
}

// 服务可用性检查
function requireTagService(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!tagService) {
    res.status(503).json({ success: false, error: 'KB service not available' });
    return;
  }
  next();
}

router.use(requireTagService);

// GET /api/kb/:kbId/tag-tree
router.get('/:kbId/tag-tree', async (req, res) => {
  try {
    const [tags, counts] = await Promise.all([
      tagService.getTagsByKbId(req.params.kbId),
      tagService.getDocumentCounts(req.params.kbId),
    ]);
    const tree = TagService.buildTagTree(tags);
    res.json({ success: true, data: { items: tree, total: tags.length, total_count: counts.total_count, untagged_count: counts.untagged_count } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/kb/:kbId/tags
router.post('/:kbId/tags', async (req, res) => {
  try {
    const tag = await tagService.createTag(req.params.kbId, req.body);
    res.status(201).json({ success: true, data: tag });
  } catch (error: any) {
    console.error('[KbRoutes] createTag error:', error.message, error.stack);
    const statusMap: Record<string, number> = {
      TAG_NAME_REQUIRED: 400,
      TAG_NAME_DUPLICATE: 400,
      PARENT_NOT_IN_KB: 400,
      KB_NOT_FOUND: 404,
    };
    const status = statusMap[error.message] || 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// PUT /api/kb/:kbId/tags/:tagId
router.put('/:kbId/tags/:tagId', async (req, res) => {
  try {
    const tag = await tagService.updateTag(req.params.tagId, req.params.kbId, req.body);
    res.json({ success: true, data: tag });
  } catch (error: any) {
    const statusMap: Record<string, number> = {
      TAG_NOT_FOUND: 404,
      TAG_NAME_REQUIRED: 400,
      TAG_NAME_DUPLICATE: 400,
      CIRCULAR_REFERENCE: 400,
      PARENT_NOT_IN_KB: 400,
    };
    const status = statusMap[error.message] || 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// DELETE /api/kb/:kbId/tags/:tagId
router.delete('/:kbId/tags/:tagId', async (req, res) => {
  try {
    const strategy = (req.query.strategy as DeleteStrategy) || 'promote';
    await tagService.deleteTag(req.params.tagId, req.params.kbId, strategy);
    res.status(204).send();
  } catch (error: any) {
    const statusMap: Record<string, number> = {
      TAG_NOT_FOUND: 404,
      INVALID_STRATEGY: 400,
    };
    const status = statusMap[error.message] || 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// PUT /api/kb/:kbId/tag-reorder
router.put('/:kbId/tag-reorder', async (req, res) => {
  try {
    const updated = await tagService.reorderTags(req.params.kbId, req.body.items);
    res.json({ success: true, data: { updated } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/kb/:kbId/documents/:docId/tag
router.put('/:kbId/documents/:docId/tag', async (req, res) => {
  try {
    await tagService.updateDocumentTag(req.params.docId, req.params.kbId, req.body.tag_id ?? null);
    res.json({ success: true, data: { docId: req.params.docId, tagId: req.body.tag_id ?? null } });
  } catch (error: any) {
    const statusMap: Record<string, number> = {
      DOC_NOT_FOUND: 404,
      TAG_NOT_FOUND: 404,
    };
    const status = statusMap[error.message] || 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

export { router as kbRouter };
