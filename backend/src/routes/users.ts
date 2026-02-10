// backend/src/routes/users.ts
import express from 'express';
import { weknoraUserService } from '../services/weknoraUserService';
import { projectUserStorage } from '../services/projectUserStorage';

const router: express.Router = express.Router();

// 获取服务状态
router.get('/status', async (req: express.Request, res: express.Response) => {
  const connectionTest = await weknoraUserService.testConnection();
  res.json({
    success: true,
    available: weknoraUserService.isAvailable,
    connection: connectionTest,
  });
});

// 获取所有 WeKnora 用户
router.get('/', async (req: express.Request, res: express.Response) => {
  try {
    if (!weknoraUserService.isAvailable) {
      res.json({ success: true, users: [], message: 'User service not configured' });
      return;
    }
    const users = await weknoraUserService.listUsers();
    res.json({ success: true, users });
  } catch (error) {
    console.error('Failed to fetch users:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// 获取项目的用户配置
router.get('/project/:projectId', (req: express.Request, res: express.Response) => {
  try {
    const { projectId } = req.params;
    const mapping = projectUserStorage.getProjectUsers(projectId);
    res.json({ success: true, mapping });
  } catch (error) {
    console.error('Failed to get project users:', error);
    res.status(500).json({ success: false, error: 'Failed to get project users' });
  }
});

// 设置项目的用户配置
router.put('/project/:projectId', (req: express.Request, res: express.Response) => {
  try {
    const { projectId } = req.params;
    const { allowAllUsers, allowedUserIds } = req.body;

    const mapping = projectUserStorage.setProjectUsers(
      projectId,
      allowAllUsers ?? false,
      allowedUserIds ?? []
    );

    res.json({ success: true, mapping });
  } catch (error) {
    console.error('Failed to set project users:', error);
    res.status(500).json({ success: false, error: 'Failed to set project users' });
  }
});

// 删除项目的用户配置
router.delete('/project/:projectId', (req: express.Request, res: express.Response) => {
  try {
    const { projectId } = req.params;
    projectUserStorage.removeProjectUsers(projectId);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to remove project users:', error);
    res.status(500).json({ success: false, error: 'Failed to remove project users' });
  }
});

// 搜索用户
router.get('/search', async (req: express.Request, res: express.Response) => {
  try {
    const keyword = req.query.q as string;
    const tenantId = req.query.tenantId ? parseInt(req.query.tenantId as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 200;

    if (!keyword || keyword.trim().length < 2) {
      res.json({ success: true, data: [] });
      return;
    }

    const users = await weknoraUserService.searchUsers(keyword.trim(), tenantId, limit);
    res.json({ success: true, data: users });
  } catch (error) {
    console.error('Failed to search users:', error);
    res.status(500).json({ success: false, error: 'Failed to search users' });
  }
});

// 获取指定租户的用户列表
router.get('/tenant/:tenantId', async (req: express.Request, res: express.Response) => {
  try {
    const tenantId = parseInt(req.params.tenantId);
    if (isNaN(tenantId)) {
      res.status(400).json({ success: false, error: 'Invalid tenantId' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt((req.query.page_size || req.query.pageSize) as string) || 200;

    const result = await weknoraUserService.getTenantUsers(tenantId, page, pageSize);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Failed to get tenant users:', error);
    res.status(500).json({ success: false, error: 'Failed to get tenant users' });
  }
});

export default router;
