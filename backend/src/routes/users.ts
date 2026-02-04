// backend/src/routes/users.ts
import express from 'express';
import { weknoraUserService } from '../services/weknoraUserService.js';
import { projectUserStorage } from '../services/projectUserStorage.js';

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

export default router;
