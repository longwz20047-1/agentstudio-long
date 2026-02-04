# 项目用户选择功能实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 AgentStudio 项目列表页面增加用户选择功能，实现项目级别的用户绑定和权限控制

**Architecture:**
- 用户数据通过直连 WeKnora PostgreSQL 数据库获取（需要暴露 5432 端口）
- 项目-用户关联关系存储在独立文件 `~/.claude-agent/project-users.json`
- 支持多用户绑定 + 全部用户访问的特殊标记
- **可选功能设计**：当 WeKnora 数据库不可用时，用户管理功能自动禁用，不影响现有功能

**Tech Stack:** TypeScript (Node.js), React, PostgreSQL (pg 库直连)

**前置条件:**
- WeKnora docker-compose.yml 中 postgres 服务需要添加端口映射 `ports: - "${DB_PORT:-5432}:5432"`
- WeKnora .env 中添加 `DB_PORT=5432`

---

## 独立性设计原则

为避免与远程代码冲突，本功能遵循以下原则：

1. **新建文件优先**：尽量创建新文件，而非修改现有文件
2. **最小修改原则**：必须修改的现有文件，只添加必要的一行代码
3. **可选功能**：数据库不可用时优雅降级，不影响主功能
4. **独立存储**：使用独立的 `project-users.json` 文件，不修改 `projects.json`

### 文件影响分析

| 类型 | 文件 | 影响程度 |
|------|------|----------|
| 新建 | `backend/src/types/users.ts` | 无冲突 |
| 新建 | `backend/src/services/weknoraUserService.ts` | 无冲突 |
| 新建 | `backend/src/services/projectUserStorage.ts` | 无冲突 |
| 新建 | `backend/src/routes/users.ts` | 无冲突 |
| 新建 | `frontend/src/types/users.ts` | 无冲突 |
| 新建 | `frontend/src/components/ProjectUserSelector.tsx` | 无冲突 |
| **修改** | `backend/src/index.ts` | **+1行**（路由注册） |
| **修改** | `backend/src/routes/projects.ts` | **+1导入 +过滤逻辑**（Task 8） |
| **修改** | `frontend/src/components/ProjectTable.tsx` | **+1列**（操作按钮） |
| **修改** | `frontend/src/pages/ProjectsPage.tsx` | **+模态框状态** |
| **修改** | `frontend/src/i18n/locales/*/pages.json` | **+翻译字段** |

---

## 数据模型设计

### 1. WeKnora 数据库表结构 (PostgreSQL)

**数据库名:** `WeKnora` （注意大小写，与 .env 中 WEKNORA_DB_NAME 一致）
**表名:** `users` (GORM 自动从 User 结构体生成)

| 字段名 | 类型 | 约束 | 说明 |
|--------|------|------|------|
| `id` | varchar(36) | PRIMARY KEY | 用户 UUID |
| `username` | varchar(100) | UNIQUE, NOT NULL | 用户名 |
| `email` | varchar(255) | UNIQUE, NOT NULL | 邮箱 |
| `password_hash` | varchar(255) | NOT NULL | 密码哈希（不查询） |
| `avatar` | varchar(500) | | 头像 URL |
| `tenant_id` | bigint | INDEX | 租户 ID |
| `is_active` | boolean | DEFAULT true | 是否激活 |
| `can_access_all_tenants` | boolean | DEFAULT false | 是否可跨租户访问 |
| `created_at` | timestamp | | 创建时间 |
| `updated_at` | timestamp | | 更新时间 |
| `deleted_at` | timestamp | INDEX | 软删除时间 |

**查询 SQL:**
```sql
SELECT id, username, email, avatar, tenant_id, is_active
FROM users
WHERE deleted_at IS NULL AND is_active = true
ORDER BY username
```

### 2. 用户类型定义 (AgentStudio)

```typescript
// backend/src/types/users.ts

export interface WeKnoraUser {
  id: string;
  username: string;
  email: string;
  avatar?: string;
  tenant_id?: number;
  is_active: boolean;
}

export interface ProjectUserMapping {
  projectId: string;          // AgentStudio 项目 ID
  allowAllUsers: boolean;     // 特殊标记：允许所有用户访问
  allowedUserIds: string[];   // 允许访问的用户 ID 列表
  updatedAt: string;
}

export interface ProjectUserStore {
  [projectId: string]: ProjectUserMapping;
}
```

### 3. 存储文件结构

```json
// ~/.claude-agent/project-users.json
{
  "project-uuid-1": {
    "projectId": "project-uuid-1",
    "allowAllUsers": false,
    "allowedUserIds": ["user-uuid-1", "user-uuid-2"],
    "updatedAt": "2026-02-03T10:00:00Z"
  },
  "project-uuid-2": {
    "projectId": "project-uuid-2",
    "allowAllUsers": true,
    "allowedUserIds": [],
    "updatedAt": "2026-02-03T10:00:00Z"
  }
}
```

---

## 实现任务

### Task 1: 创建用户类型定义

**Files:**
- Create: `backend/src/types/users.ts`
- Create: `frontend/src/types/users.ts`

**Step 1: 创建后端用户类型**

```typescript
// backend/src/types/users.ts
export interface WeKnoraUser {
  id: string;
  username: string;
  email: string;
  avatar?: string;
  tenant_id?: number;
  is_active: boolean;
}

export interface ProjectUserMapping {
  projectId: string;
  allowAllUsers: boolean;
  allowedUserIds: string[];
  updatedAt: string;
}

export interface ProjectUserStore {
  [projectId: string]: ProjectUserMapping;
}
```

**Step 2: 创建前端用户类型**

```typescript
// frontend/src/types/users.ts
export interface WeKnoraUser {
  id: string;
  username: string;
  email: string;
  avatar?: string;
  tenant_id?: number;
  is_active: boolean;
}

export interface ProjectUserMapping {
  projectId: string;
  allowAllUsers: boolean;
  allowedUserIds: string[];
  updatedAt: string;
}
```

**Step 3: Commit**

```bash
git add backend/src/types/users.ts frontend/src/types/users.ts
git commit -m "feat: add user types for project-user mapping"
```

---

### Task 2: 创建 WeKnora 用户服务

**Files:**
- Create: `backend/src/services/weknoraUserService.ts`

**功能：**
1. 通过 PostgreSQL 直连 WeKnora 数据库获取用户列表
2. 缓存用户列表避免频繁查询
3. **可选功能**：未配置数据库时返回空数组，不抛出错误

**Step 1: 实现用户服务**

```typescript
// backend/src/services/weknoraUserService.ts
import { Pool } from 'pg';
import { WeKnoraUser } from '../types/users.js';

export class WeKnoraUserService {
  private pool: Pool | null = null;
  private cache: WeKnoraUser[] | null = null;
  private cacheTime: number = 0;
  private cacheTTL: number = 5 * 60 * 1000; // 5 minutes
  private _isAvailable: boolean = false;

  constructor() {
    // 检查是否配置了数据库连接
    this._isAvailable = !!process.env.WEKNORA_DB_HOST;
    if (!this._isAvailable) {
      console.log('[WeKnoraUserService] WEKNORA_DB_HOST not configured, user management disabled');
    }
  }

  /**
   * 检查服务是否可用
   */
  get isAvailable(): boolean {
    return this._isAvailable;
  }

  private getPool(): Pool | null {
    if (!this._isAvailable) {
      return null;
    }

    if (!this.pool) {
      this.pool = new Pool({
        host: process.env.WEKNORA_DB_HOST,
        port: parseInt(process.env.WEKNORA_DB_PORT || '5432'),
        database: process.env.WEKNORA_DB_NAME || 'WeKnora',
        user: process.env.WEKNORA_DB_USER || 'postgres',
        password: process.env.WEKNORA_DB_PASSWORD || '',
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
    }
    return this.pool;
  }

  async listUsers(): Promise<WeKnoraUser[]> {
    // 服务不可用时返回空数组
    if (!this._isAvailable) {
      return [];
    }

    // 检查缓存
    if (this.cache && Date.now() - this.cacheTime < this.cacheTTL) {
      return this.cache;
    }

    try {
      const pool = this.getPool();
      if (!pool) {
        return [];
      }

      const result = await pool.query(`
        SELECT id, username, email, avatar, tenant_id, is_active
        FROM users
        WHERE deleted_at IS NULL AND is_active = true
        ORDER BY username
      `);

      this.cache = result.rows;
      this.cacheTime = Date.now();
      return this.cache;
    } catch (error) {
      console.error('[WeKnoraUserService] Failed to fetch users:', error);
      // 返回过期缓存或空数组，不影响主功能
      return this.cache || [];
    }
  }

  async getUserById(id: string): Promise<WeKnoraUser | null> {
    const users = await this.listUsers();
    return users.find(u => u.id === id) || null;
  }

  /**
   * 测试数据库连接
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    if (!this._isAvailable) {
      return { success: false, error: 'WEKNORA_DB_HOST not configured' };
    }

    try {
      const pool = this.getPool();
      if (!pool) {
        return { success: false, error: 'Failed to create connection pool' };
      }
      await pool.query('SELECT 1');
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  clearCache(): void {
    this.cache = null;
    this.cacheTime = 0;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

export const weknoraUserService = new WeKnoraUserService();
```

**Step 2: Commit**

```bash
git add backend/src/services/weknoraUserService.ts
git commit -m "feat: add WeKnora user service with PostgreSQL direct connection"
```

---

### Task 3: 创建项目用户存储服务

**Files:**
- Create: `backend/src/services/projectUserStorage.ts`

**Step 1: 实现项目用户存储服务**

```typescript
// backend/src/services/projectUserStorage.ts
import * as fs from 'fs';
import * as path from 'path';
import { ProjectUserMapping, ProjectUserStore } from '../types/users.js';
import { CLAUDE_AGENT_DIR } from '../config/paths.js';

const PROJECT_USERS_FILE = path.join(CLAUDE_AGENT_DIR, 'project-users.json');

export class ProjectUserStorage {
  private cache: ProjectUserStore | null = null;

  private loadStore(): ProjectUserStore {
    if (this.cache) {
      return this.cache;
    }

    try {
      if (fs.existsSync(PROJECT_USERS_FILE)) {
        const content = fs.readFileSync(PROJECT_USERS_FILE, 'utf-8');
        this.cache = JSON.parse(content);
        return this.cache!;
      }
    } catch (error) {
      console.error('[ProjectUserStorage] Failed to load project-users.json:', error);
    }

    this.cache = {};
    return this.cache;
  }

  private saveStore(store: ProjectUserStore): void {
    try {
      const dir = path.dirname(PROJECT_USERS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(PROJECT_USERS_FILE, JSON.stringify(store, null, 2));
      this.cache = store;
    } catch (error) {
      console.error('[ProjectUserStorage] Failed to save project-users.json:', error);
      throw error;
    }
  }

  getProjectUsers(projectId: string): ProjectUserMapping | null {
    const store = this.loadStore();
    return store[projectId] || null;
  }

  setProjectUsers(
    projectId: string,
    allowAllUsers: boolean,
    allowedUserIds: string[]
  ): ProjectUserMapping {
    const store = this.loadStore();

    const mapping: ProjectUserMapping = {
      projectId,
      allowAllUsers,
      allowedUserIds: allowAllUsers ? [] : allowedUserIds,
      updatedAt: new Date().toISOString(),
    };

    store[projectId] = mapping;
    this.saveStore(store);

    return mapping;
  }

  removeProjectUsers(projectId: string): void {
    const store = this.loadStore();
    delete store[projectId];
    this.saveStore(store);
  }

  /**
   * 检查用户是否有权访问项目
   * 用于后续权限校验扩展
   */
  canUserAccessProject(projectId: string, userId: string): boolean {
    const mapping = this.getProjectUsers(projectId);

    // 没有配置 = 允许所有人访问（向后兼容）
    if (!mapping) {
      return true;
    }

    // 允许所有用户
    if (mapping.allowAllUsers) {
      return true;
    }

    // 检查用户是否在允许列表中
    return mapping.allowedUserIds.includes(userId);
  }

  getAllMappings(): ProjectUserStore {
    return this.loadStore();
  }

  clearCache(): void {
    this.cache = null;
  }
}

export const projectUserStorage = new ProjectUserStorage();
```

**Step 2: Commit**

```bash
git add backend/src/services/projectUserStorage.ts
git commit -m "feat: add project user storage service"
```

---

### Task 4: 添加 API 路由

**Files:**
- Create: `backend/src/routes/users.ts`
- Modify: `backend/src/index.ts` （**仅添加1行**）

**Step 1: 创建用户路由**

```typescript
// backend/src/routes/users.ts
import { Router, Request, Response } from 'express';
import { weknoraUserService } from '../services/weknoraUserService.js';
import { projectUserStorage } from '../services/projectUserStorage.js';

const router = Router();

// 获取服务状态
router.get('/status', async (req: Request, res: Response) => {
  const connectionTest = await weknoraUserService.testConnection();
  res.json({
    success: true,
    available: weknoraUserService.isAvailable,
    connection: connectionTest,
  });
});

// 获取所有 WeKnora 用户
router.get('/', async (req: Request, res: Response) => {
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
router.get('/project/:projectId', (req: Request, res: Response) => {
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
router.put('/project/:projectId', (req: Request, res: Response) => {
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
router.delete('/project/:projectId', (req: Request, res: Response) => {
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
```

**Step 2: 在 index.ts 注册路由（最小修改）**

在 `backend/src/index.ts` 中找到其他路由注册的位置，添加**一行**：

```typescript
// 在其他 app.use 路由之后添加（如 app.use('/api/projects', ...) 附近）
import usersRouter from './routes/users';
app.use('/api/users', usersRouter);
```

**完整修改示意：**
```typescript
// backend/src/index.ts
// ... 其他 imports ...
import usersRouter from './routes/users.js';  // 添加此行

// ... 其他代码 ...

// 路由注册区域
app.use('/api/projects', projectsRouter);
app.use('/api/users', usersRouter);  // 添加此行
// ... 其他路由 ...
```

**Step 3: Commit**

```bash
git add backend/src/routes/users.ts backend/src/index.ts
git commit -m "feat: add user management API routes"
```

---

### Task 5: 创建前端用户选择组件

**Files:**
- Create: `frontend/src/components/ProjectUserSelector.tsx`

**Step 1: 实现用户选择组件**

```tsx
// frontend/src/components/ProjectUserSelector.tsx
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, X } from 'lucide-react';
import { API_BASE } from '../lib/config';
import { authFetch } from '../lib/authFetch';
import { WeKnoraUser, ProjectUserMapping } from '../types/users';

interface Props {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  onSave: (mapping: ProjectUserMapping) => void;
}

export const ProjectUserSelector: React.FC<Props> = ({
  projectId,
  isOpen,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation('pages');
  const [users, setUsers] = useState<WeKnoraUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [allowAllUsers, setAllowAllUsers] = useState(true);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [serviceAvailable, setServiceAvailable] = useState(true);

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen, projectId]);

  const loadData = async () => {
    setLoading(true);
    try {
      // 检查服务状态
      const statusRes = await authFetch(`${API_BASE}/api/users/status`);
      const statusData = await statusRes.json();
      setServiceAvailable(statusData.available && statusData.connection?.success);

      // 加载用户列表
      const usersRes = await authFetch(`${API_BASE}/api/users`);
      const usersData = await usersRes.json();
      if (usersData.success) {
        setUsers(usersData.users || []);
      }

      // 加载项目当前配置
      const mappingRes = await authFetch(`${API_BASE}/api/users/project/${projectId}`);
      const mappingData = await mappingRes.json();
      if (mappingData.success && mappingData.mapping) {
        setAllowAllUsers(mappingData.mapping.allowAllUsers);
        setSelectedUserIds(mappingData.mapping.allowedUserIds || []);
      } else {
        setAllowAllUsers(true);
        setSelectedUserIds([]);
      }
    } catch (error) {
      console.error('Failed to load data:', error);
      setServiceAvailable(false);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/api/users/project/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allowAllUsers,
          allowedUserIds: selectedUserIds,
        }),
      });
      const data = await res.json();
      if (data.success) {
        onSave(data.mapping);
        onClose();
      }
    } catch (error) {
      console.error('Failed to save:', error);
    } finally {
      setSaving(false);
    }
  };

  const toggleUser = (userId: string) => {
    setSelectedUserIds(prev =>
      prev.includes(userId)
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            <h2 className="text-lg font-semibold">
              {t('projects.userAccess.title', '用户访问控制')}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          ) : !serviceAvailable ? (
            <div className="text-center py-8 text-gray-500">
              <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>{t('projects.userAccess.serviceUnavailable', '用户服务不可用')}</p>
              <p className="text-sm mt-1">{t('projects.userAccess.checkConfig', '请检查 WeKnora 数据库配置')}</p>
            </div>
          ) : (
            <>
              {/* 全部用户开关 */}
              <label className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowAllUsers}
                  onChange={(e) => setAllowAllUsers(e.target.checked)}
                  className="w-4 h-4 text-blue-600"
                />
                <div>
                  <div className="font-medium">
                    {t('projects.userAccess.allowAll', '允许所有用户访问')}
                  </div>
                  <div className="text-sm text-gray-500">
                    {t('projects.userAccess.allowAllDesc', '不限制用户访问此项目')}
                  </div>
                </div>
              </label>

              {/* 用户列表 */}
              {!allowAllUsers && (
                <div className="space-y-2">
                  <div className="text-sm text-gray-500 mb-2">
                    {t('projects.userAccess.selectUsers', '选择允许访问的用户：')}
                  </div>
                  {users.map(user => (
                    <label
                      key={user.id}
                      className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                        selectedUserIds.includes(user.id)
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                          : 'border-gray-200 dark:border-gray-600 hover:border-gray-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedUserIds.includes(user.id)}
                        onChange={() => toggleUser(user.id)}
                        className="w-4 h-4 text-blue-600"
                      />
                      <div className="flex-1">
                        <div className="font-medium">{user.username}</div>
                        <div className="text-sm text-gray-500">{user.email}</div>
                      </div>
                      {user.avatar && (
                        <img src={user.avatar} alt="" className="w-8 h-8 rounded-full" />
                      )}
                    </label>
                  ))}
                  {users.length === 0 && (
                    <div className="text-center py-4 text-gray-500">
                      {t('projects.userAccess.noUsers', '暂无用户数据')}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !serviceAvailable}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? t('common.saving', '保存中...') : t('common.save', '保存')}
          </button>
        </div>
      </div>
    </div>
  );
};
```

**Step 2: Commit**

```bash
git add frontend/src/components/ProjectUserSelector.tsx
git commit -m "feat: add project user selector component"
```

---

### Task 6: 集成到项目列表页面

**Files:**
- Modify: `frontend/src/pages/ProjectsPage.tsx`
- Modify: `frontend/src/components/ProjectTable.tsx`

**Step 1: 修改 ProjectsPage.tsx**

在文件顶部添加导入：

```typescript
import { ProjectUserSelector } from '../components/ProjectUserSelector';
```

在组件内添加状态（约第263行，在其他 useState 附近）：

```typescript
const [userSelectorProjectId, setUserSelectorProjectId] = useState<string | null>(null);
```

传递回调给 ProjectTable（约第627行）：

```tsx
<ProjectTable
  projects={filteredProjects}
  agents={enabledAgents}
  onOpenProject={handleOpenProject}
  onMemoryManagement={handleMemoryManagement}
  onCommandManagement={handleCommandManagement}
  onSubAgentManagement={handleSubAgentManagement}
  onA2AManagement={handleA2AManagement}
  onManageUsers={(project) => setUserSelectorProjectId(project.id)}  // 添加此行
  onSettings={handleSettings}
  onDeleteProject={handleDeleteProject}
  onAgentChanged={handleAgentChanged}
/>
```

在 JSX 中添加模态框（约第814行，在 `{/* FileBrowser for Import */}` 之前）：

```tsx
{/* User Selector Modal */}
{userSelectorProjectId && (
  <ProjectUserSelector
    projectId={userSelectorProjectId}
    isOpen={!!userSelectorProjectId}
    onClose={() => setUserSelectorProjectId(null)}
    onSave={() => {
      setUserSelectorProjectId(null);
    }}
  />
)}
```

**Step 2: 修改 ProjectTable.tsx**

**2.1 添加 import（第1行区域）：**

```typescript
import { Users } from 'lucide-react';  // 添加到现有 lucide-react import
```

**2.2 添加 props 类型（约第48行 ProjectTableProps 接口）：**

```typescript
interface ProjectTableProps {
  projects: Project[];
  agents: Agent[];
  onOpenProject: (project: Project) => void;
  onMemoryManagement: (project: Project) => void;
  onCommandManagement: (project: Project) => void;
  onSubAgentManagement: (project: Project) => void;
  onA2AManagement: (project: Project) => void;
  onManageUsers?: (project: Project) => void;  // 添加此行，参数类型与其他回调一致
  onSettings: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onAgentChanged?: (projectId: string, newAgent: Agent) => void;
  className?: string;
}
```

**2.3 解构 props（约第62行）：**

```typescript
export const ProjectTable: React.FC<ProjectTableProps> = ({
  projects,
  agents,
  onOpenProject,
  onMemoryManagement,
  onCommandManagement,
  onSubAgentManagement,
  onA2AManagement,
  onManageUsers,  // 添加此行
  onSettings,
  onDeleteProject,
  onAgentChanged,
  className = '',
}) => {
```

**2.4 桌面端视图：在 renderActions 函数中添加按钮（约第182行）**

按钮位置：在 A2A 按钮（Shield）之后、设置按钮（Settings）之前：

```tsx
const renderActions = (project: Project) => (
  <div className="flex items-center justify-end space-x-1">
    <button onClick={() => onMemoryManagement(project)} ...>
      <Brain className="w-3.5 h-3.5" />
    </button>
    <button onClick={() => onCommandManagement(project)} ...>
      <Command className="w-3.5 h-3.5" />
    </button>
    <button onClick={() => onSubAgentManagement(project)} ...>
      <Bot className="w-3.5 h-3.5" />
    </button>
    <button onClick={() => onA2AManagement(project)} ...>
      <Shield className="w-3.5 h-3.5" />
    </button>
    {/* 👇 在这里添加用户管理按钮 */}
    {onManageUsers && (
      <button
        onClick={() => onManageUsers(project)}
        className="p-1.5 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/50 rounded-md transition-colors"
        title={t('projects.userAccess.manageUsers', '管理用户')}
      >
        <Users className="w-3.5 h-3.5" />
      </button>
    )}
    <button onClick={() => onSettings(project)} ...>
      <Settings className="w-3.5 h-3.5" />
    </button>
    <button onClick={() => onDeleteProject(project)} ...>
      <Trash2 className="w-3.5 h-3.5" />
    </button>
  </div>
);
```

**2.5 移动端视图：在卡片操作区域添加按钮（约第276-323行）**

在移动端卡片的操作按钮区域，同样在 A2A 按钮之后、设置按钮之前添加：

```tsx
{/* 直接显示操作按钮 */}
<div className="border-t border-gray-200 dark:border-gray-700 p-4">
  <div className="flex items-center justify-between">
    <span className="text-xs text-gray-500 dark:text-gray-400">{t('projects.table.actions')}</span>
    <div className="flex items-center space-x-2">
      <button onClick={() => onMemoryManagement(project)} ...>
        <Brain className="w-4 h-4" />
      </button>
      <button onClick={() => onCommandManagement(project)} ...>
        <Command className="w-4 h-4" />
      </button>
      <button onClick={() => onSubAgentManagement(project)} ...>
        <Bot className="w-4 h-4" />
      </button>
      <button onClick={() => onA2AManagement(project)} ...>
        <Shield className="w-4 h-4" />
      </button>
      {/* 👇 在这里添加用户管理按钮 */}
      {onManageUsers && (
        <button
          onClick={() => onManageUsers(project)}
          className="p-2 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/50 rounded-md transition-colors"
          title={t('projects.userAccess.manageUsers', '管理用户')}
        >
          <Users className="w-4 h-4" />
        </button>
      )}
      <button onClick={() => onSettings(project)} ...>
        <Settings className="w-4 h-4" />
      </button>
      <button onClick={() => onDeleteProject(project)} ...>
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  </div>
</div>
```

**Step 3: Commit**

```bash
git add frontend/src/pages/ProjectsPage.tsx frontend/src/components/ProjectTable.tsx
git commit -m "feat: integrate user selector into projects page"
```

---

### Task 7: 添加 i18n 翻译

**Files:**
- Modify: `frontend/src/i18n/locales/zh-CN/pages.json`
- Modify: `frontend/src/i18n/locales/en-US/pages.json`

**Step 1: 添加中文翻译**

在 `pages.json` 的 `projects` 对象中添加 `userAccess` 字段：

```json
{
  "projects": {
    // ... 现有字段保持不变 ...
    "userAccess": {
      "title": "用户访问控制",
      "allowAll": "允许所有用户访问",
      "allowAllDesc": "不限制用户访问此项目",
      "selectUsers": "选择允许访问的用户：",
      "noUsers": "暂无用户数据",
      "manageUsers": "管理用户",
      "serviceUnavailable": "用户服务不可用",
      "checkConfig": "请检查 WeKnora 数据库配置"
    }
  }
}
```

**Step 2: 添加英文翻译**

```json
{
  "projects": {
    // ... existing fields unchanged ...
    "userAccess": {
      "title": "User Access Control",
      "allowAll": "Allow all users",
      "allowAllDesc": "No restriction on user access to this project",
      "selectUsers": "Select users who can access:",
      "noUsers": "No users available",
      "manageUsers": "Manage Users",
      "serviceUnavailable": "User service unavailable",
      "checkConfig": "Please check WeKnora database configuration"
    }
  }
}
```

**Step 3: Commit**

```bash
git add frontend/src/i18n/locales/zh-CN/pages.json frontend/src/i18n/locales/en-US/pages.json
git commit -m "feat: add i18n translations for user access control"
```

---

### Task 8: 修改项目列表 API 支持用户过滤

**目的：** WeKnora 调用 `GET /api/projects` 时传入 `userId` 参数，只返回该用户有权访问的项目。

**Files:**
- Modify: `backend/src/routes/projects.ts`

**过滤逻辑：**
1. 如果 `userId` 参数未传入 → 返回所有项目（向后兼容 AgentStudio 前端）
2. 如果 `userId` 参数传入 → 按以下规则过滤：
   - 项目设置了 `allowAllUsers: true` → 返回
   - 项目的 `allowedUserIds` 包含该用户 → 返回
   - 项目未配置用户权限（无 mapping）→ 返回（向后兼容）

**Step 1: 修改 GET /api/projects 路由**

在 `backend/src/routes/projects.ts` 文件顶部添加导入：

```typescript
import { projectUserStorage } from '../services/projectUserStorage.js';
```

修改 `GET /` 路由（约第39行）：

```typescript
// GET /api/projects - Get all projects
// 支持 ?userId=xxx 参数进行用户权限过滤（向后兼容：不传则返回全部）
router.get('/', async (req, res) => {
  try {
    const userId = req.query.userId as string | undefined;
    let projects = projectStorage.getAllProjects();

    // 如果传入了 userId，进行权限过滤
    if (userId) {
      projects = projects.filter(project => {
        return projectUserStorage.canUserAccessProject(project.id, userId);
      });
    }

    res.json({ projects });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});
```

**Step 2: Commit**

```bash
git add backend/src/routes/projects.ts
git commit -m "feat: add userId filter support to GET /api/projects"
```

---

## 环境变量配置

在 `backend/.env` 中添加（已完成）：

```env
# WeKnora PostgreSQL 数据库连接配置
# 用于获取用户列表，实现项目用户访问控制
# 如果不配置，用户管理功能将自动禁用
WEKNORA_DB_HOST=192.168.100.30
WEKNORA_DB_PORT=5432
WEKNORA_DB_NAME=WeKnora
WEKNORA_DB_USER=postgres
WEKNORA_DB_PASSWORD=postgres123!@#
```

---

## 依赖安装

```bash
# 后端添加 pg 库用于 PostgreSQL 连接
cd backend
pnpm add pg @types/pg
```

---

## API 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/users/status` | 获取服务状态和数据库连接状态 |
| GET | `/api/users` | 获取所有 WeKnora 用户列表 |
| GET | `/api/users/project/:projectId` | 获取项目的用户配置 |
| PUT | `/api/users/project/:projectId` | 设置项目的用户配置 |
| DELETE | `/api/users/project/:projectId` | 删除项目的用户配置 |
| GET | `/api/projects?userId=xxx` | **（已修改）** 获取项目列表，支持用户过滤 |

### GET /api/projects 用户过滤说明

**请求参数：**
- `userId` (可选): WeKnora 用户 ID

**过滤行为：**
| 场景 | 返回结果 |
|------|----------|
| 不传 `userId` | 返回所有项目（向后兼容） |
| 项目 `allowAllUsers: true` | 返回 |
| 项目 `allowedUserIds` 包含该用户 | 返回 |
| 项目未配置用户权限 | 返回（向后兼容） |
| 项目配置了权限但不包含该用户 | 不返回 |

**示例：**
```bash
# 不过滤（AgentStudio 前端使用）
GET /api/projects

# 按用户过滤（WeKnora 使用）
GET /api/projects?userId=user-uuid-123
```

---

## 测试清单

- [ ] WeKnora PostgreSQL 端口已暴露（docker-compose.yml 添加 ports 配置）
- [ ] `GET /api/users/status` 返回 `available: true` 和 `connection.success: true`
- [ ] `GET /api/users` 正确返回用户列表
- [ ] 项目用户配置能够保存到 `~/.claude-agent/project-users.json`
- [ ] "允许所有用户" 开关工作正常
- [ ] 用户多选功能工作正常
- [ ] 配置保存后重新加载正确
- [ ] 未配置数据库时，用户服务优雅禁用，不影响其他功能
- [ ] 前端正确显示"服务不可用"提示
- [ ] **`GET /api/projects` 不传 userId 返回所有项目（向后兼容）**
- [ ] **`GET /api/projects?userId=xxx` 正确过滤项目**
- [ ] **`allowAllUsers: true` 的项目对所有用户可见**
- [ ] **未配置用户权限的项目对所有用户可见**

---

## 后续扩展（可选）

当前实现包含用户配置和项目列表过滤。后续可扩展：

1. **API 权限校验**：在项目相关 API（如 chat、file 操作）中检查用户权限
2. **Graphiti 集成**：根据项目关联的用户查询对应的用户画像
3. **用户组支持**：支持按用户组批量授权

这些扩展需要修改更多现有代码，建议作为独立任务实现。
