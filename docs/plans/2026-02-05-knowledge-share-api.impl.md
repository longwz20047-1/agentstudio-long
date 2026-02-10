# 知识库分享 API 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 AgentStudio 后端实现知识库分享功能的完整 API（分享管理、链接分享、内容获取、用户搜索）

**Architecture:** Express 路由分层架构——类型定义 → 服务层（ShareService + ShareContentService）→ 路由层（受保护路由 + 公开路由）→ 注册到 index.ts。复用 WeKnora 数据库连接池，JWT 认证保护管理路由，Cookie 验证保护链接分享内容路由。

**Tech Stack:** TypeScript, Express, PostgreSQL (pg), bcryptjs, cookie-parser, uuid

---

## 设计规格参考

**完整设计文档：** `docs/plans/2026-02-05-knowledge-share-api.md` — 包含完整的数据库设计、API 设计、请求/响应结构、代码实现和审查修订记录。实现时遇到不明确的地方，请查阅该文档。

---

### Task 1: 创建类型定义

**Files:**
- Create: `backend/src/types/share.ts`

**Step 1: 编写类型定义文件**

风格参考：`backend/src/types/users.ts`（Interface-based，optional 字段用 `?`）

```typescript
// backend/src/types/share.ts

export type ShareType = 'knowledge_base' | 'knowledge';
export type ShareMode = 'public' | 'user' | 'link';
export type ShareStatus = 'active' | 'disabled';
export type SharePermission = 'read';  // 当前阶段仅支持 read

export interface Share {
  id: string;
  share_type: ShareType;
  target_id: string;
  target_name?: string;
  target_kb_id?: string;

  share_mode: ShareMode;
  share_link_token?: string;
  link_password?: string;

  permissions: SharePermission;
  status: ShareStatus;

  owner_tenant_id: number;
  owner_user_id: string;
  owner_username?: string;

  view_count: number;
  last_accessed_at?: Date;
  expires_at?: Date;

  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export interface ShareTarget {
  id: string;
  share_id: string;
  target_user_id: string;
  target_username?: string;
  target_email?: string;
  target_tenant_id?: number;
  accepted_at?: Date;
  created_at: Date;
}

export interface ShareAccessLog {
  id: string;
  share_id: string;
  accessor_user_id?: string;
  accessor_ip?: string;
  access_type: 'view' | 'download' | 'copy';
  created_at: Date;
}

// API Request/Response types
export interface CreateShareRequest {
  userId: string;             // 分享创建者（从请求体获取）
  tenantId: number;
  username?: string;
  shareType: ShareType;
  targetId: string;
  shareMode: ShareMode;
  permissions?: SharePermission;
  expiresAt?: string;
  linkPassword?: string;
  targetUsers?: Array<{
    userId?: string;
    username?: string;
    email?: string;
  }>;
}

export interface ShareItem {
  shareId: string;
  shareType: ShareType;
  targetId: string;
  targetName: string;
  targetKbId?: string;
  targetKbName?: string;
  shareMode: ShareMode;
  permissions: SharePermission;
  status: ShareStatus | 'expired';
  ownerUserId: string;
  ownerUsername: string;
  viewCount: number;
  createdAt: string;
  expiresAt?: string;
}
```

**Step 2: 验证类型定义编译通过**

Run: `cd backend && npx tsc --noEmit`
Expected: 无新增错误（share.ts 无外部依赖，纯类型定义）

---

### Task 2: 创建数据库迁移脚本

**Files:**
- Create: `docs/sql/001_create_share_tables.sql`

> 项目中不存在 `docs/sql/` 目录且无自动迁移机制。SQL 脚本放在 `docs/sql/` 下作为参考，需手动在 WeKnora 数据库执行。

**Step 1: 创建目录**

Run: `mkdir -p docs/sql`

**Step 2: 编写迁移脚本**

```sql
-- docs/sql/001_create_share_tables.sql
-- 知识库分享功能数据库迁移脚本
-- 在 WeKnora 数据库中执行

-- 1. 分享记录表
CREATE TABLE shares (
    id VARCHAR(36) PRIMARY KEY,
    share_type VARCHAR(20) NOT NULL,        -- 'knowledge_base' | 'knowledge'
    target_id VARCHAR(36) NOT NULL,         -- 知识库ID 或 文档ID
    target_name VARCHAR(255),               -- 冗余名称便于展示
    target_kb_id VARCHAR(36),               -- 文档分享时记录所属知识库ID

    share_mode VARCHAR(20) NOT NULL,        -- 'public' | 'user' | 'link'
    share_link_token VARCHAR(64) UNIQUE,    -- 链接分享 token
    link_password VARCHAR(255),             -- 链接密码（可选，哈希存储）

    permissions VARCHAR(20) DEFAULT 'read', -- 当前阶段仅支持 'read'
    status VARCHAR(20) DEFAULT 'active',    -- 'active' | 'disabled'

    owner_tenant_id BIGINT NOT NULL,        -- 分享者租户ID
    owner_user_id VARCHAR(36) NOT NULL,     -- 分享者用户ID
    owner_username VARCHAR(100),            -- 分享者用户名（冗余）

    view_count INT DEFAULT 0,               -- 访问次数
    last_accessed_at TIMESTAMP,             -- 最后访问时间
    expires_at TIMESTAMP,                   -- 过期时间

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP                    -- 软删除
);

CREATE INDEX idx_shares_type_target ON shares(share_type, target_id);
CREATE INDEX idx_shares_mode_status ON shares(share_mode, status);
CREATE INDEX idx_shares_link_token ON shares(share_link_token);
CREATE INDEX idx_shares_owner ON shares(owner_user_id);
CREATE INDEX idx_shares_deleted ON shares(deleted_at);

ALTER TABLE shares ADD CONSTRAINT chk_link_token
  CHECK (share_mode != 'link' OR share_link_token IS NOT NULL);

-- 2. 分享目标用户表
CREATE TABLE share_targets (
    id VARCHAR(36) PRIMARY KEY,
    share_id VARCHAR(36) NOT NULL,
    target_user_id VARCHAR(36) NOT NULL,
    target_username VARCHAR(100),
    target_email VARCHAR(255),
    target_tenant_id BIGINT,

    accepted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),

    FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
    UNIQUE(share_id, target_user_id)
);

CREATE INDEX idx_share_targets_user ON share_targets(target_user_id);

-- 3. 分享访问日志表
CREATE TABLE share_access_logs (
    id VARCHAR(36) PRIMARY KEY,
    share_id VARCHAR(36) NOT NULL,
    accessor_user_id VARCHAR(36),
    accessor_ip VARCHAR(45),
    access_type VARCHAR(20),                -- 'view' | 'download' | 'copy'
    created_at TIMESTAMP DEFAULT NOW(),

    FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);

CREATE INDEX idx_share_access_logs_share ON share_access_logs(share_id);
```

---

### Task 3: 暴露 WeKnora 数据库连接池

**Files:**
- Modify: `backend/src/services/weknoraUserService.ts`

**Step 1: 在 close() 方法之后添加 getDbPool 方法**

在 `weknoraUserService.ts` 的 `close()` 方法之后（约 line 121 之后，`}` 闭合花括号前），添加：

```typescript
  /**
   * 获取数据库连接池（供其他服务复用）
   */
  getDbPool(): Pool | null {
    return this.getPool();
  }
```

**Step 2: 验证编译通过**

Run: `cd backend && npx tsc --noEmit`
Expected: 无新增错误

---

### Task 4: 创建分享服务

**Files:**
- Create: `backend/src/services/shareService.ts`

**Step 1: 编写 ShareService 完整代码**

参照 `docs/plans/2026-02-05-knowledge-share-api.md` Task 4 中的完整代码，创建 `backend/src/services/shareService.ts`。

核心方法清单（**所有方法的完整代码均在设计文档 line 669-1192 中**）：
- `createShare(request)` — 创建分享（含事务、防重复、密码哈希、链接 token 生成、目标用户批量添加）
- `getShareById(shareId)` — 获取分享详情
- `getShareByToken(token)` — 通过链接 token 获取分享
- `verifyLinkPassword(token, password)` — 验证链接密码（无密码返回 true）
- `getMyShares(userId, page, pageSize, shareType?)` — 我创建的分享（含 LEFT JOIN knowledge_bases）
- `getSharedToMe(userId, page, pageSize, shareType?)` — 分享给我的
- `getPublicShares(page, pageSize, shareType?)` — 公开分享
- `updateShare(shareId, updates)` — 更新分享（事务，含模式切换副作用）
- `deleteShare(shareId)` — 软删除
- `incrementViewCount(shareId)` — 增加访问计数
- `getShareTargets(shareId)` — 获取目标用户列表
- `addShareTarget(shareId, userId)` — 添加目标用户
- `removeShareTarget(shareId, userId)` — 移除目标用户
- `checkShareExists(shareType, targetId, ownerUserId, shareMode?)` — 防重复检查
- `logAccess(shareId, accessType, accessorUserId?, accessorIp?)` — 记录访问日志
- `findUserByEmail(email)` — 通过邮箱查找用户（公开方法）

Private helpers:
- `addShareTargetInternal(client, shareId, userId)` — 事务内添加目标用户
- `getTargetInfo(shareType, targetId)` — 获取目标名称和所属知识库ID
- `findUserById(userId)` — 通过ID查找用户
- `mapToShareItem(row)` — 数据库行映射为 ShareItem API 响应

依赖：`uuid`（后续 Task 9 会迁移到 dependencies）、`bcryptjs`（已在 dependencies）、`pg`、`../types/share.js`

**Step 2: 验证编译通过**

Run: `cd backend && npx tsc --noEmit`
Expected: 无新增错误

---

### Task 5: 创建内容代理服务

**Files:**
- Create: `backend/src/services/shareContentService.ts`

**Step 1: 编写 ShareContentService 完整代码**

参照 `docs/plans/2026-02-05-knowledge-share-api.md` Task 5 中的完整代码（line 1211-1569），创建 `backend/src/services/shareContentService.ts`。

核心方法清单：
- `getKnowledgeBase(shareId)` — 获取知识库详情 + 文档计数（查 knowledge_bases + COUNT knowledges）
- `getKnowledgeBaseDocuments(shareId, page, pageSize)` — 文档列表（查 knowledges）
- `getDocument(shareId, docId?)` — 文档详情（知识库分享支持 docId 参数 + 归属验证）
- `getDocumentChunks(shareId, page, pageSize, docId?)` — 分块内容（查 chunks）
- `getDownloadInfo(shareId, docId?)` — 下载信息 + 路径安全校验（WEKNORA_FILES_DIR）
- `searchContent(shareId, keyword, page, pageSize)` — 全文搜索 chunks（含 ILIKE 通配符转义 + 高亮摘要生成）

每个方法的模式：先通过 `ShareService.getShareById()` 获取分享记录，再根据 `share_type` 确定查询目标（knowledge_base 还是 knowledge），最后查询 WeKnora 现有表。

关键实现细节：
- `getDocument` 和 `getDocumentChunks` 和 `getDownloadInfo`：知识库分享模式下需接受可选 `docId` 参数，并验证文档归属于该知识库
- `searchContent`：ILIKE 搜索需转义 `%`、`_`、`\` 字符（`keyword.replace(/[%_\\]/g, '\\$&')`）
- `getDownloadInfo`：路径安全校验确保 `filePath` 在 `WEKNORA_FILES_DIR` 范围内

**Step 2: 验证编译通过**

Run: `cd backend && npx tsc --noEmit`
Expected: 无新增错误

---

### Task 6: 扩展用户服务（添加搜索方法）

**Files:**
- Modify: `backend/src/services/weknoraUserService.ts`

**Step 1: 添加 searchUsers 和 getTenantUsers 方法**

参照 `docs/plans/2026-02-05-knowledge-share-api.md` Task 6 中的完整代码（line 1594-1663），在 `WeKnoraUserService` 类中 `getDbPool()` 方法之后、类闭合花括号 `}` 之前添加两个方法。

两个方法均遵循现有 `listUsers()` 的模式（line 51-83）：检查 `_isAvailable` → 获取 Pool → try/catch 优雅降级。

```typescript
  /**
   * 搜索用户（按用户名或邮箱模糊匹配）
   */
  async searchUsers(keyword: string, tenantId?: number, limit = 20): Promise<WeKnoraUser[]> {
    if (!this._isAvailable) {
      return [];
    }

    try {
      const pool = this.getPool();
      if (!pool) return [];

      let query = `
        SELECT id, username, email, avatar, tenant_id, is_active
        FROM users
        WHERE deleted_at IS NULL AND is_active = true
          AND (LOWER(username) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1))
      `;
      const params: any[] = [`%${keyword.replace(/[%_\\]/g, '\\$&')}%`];

      if (tenantId) {
        query += ' AND tenant_id = $2';
        params.push(tenantId);
      }

      query += ` ORDER BY username LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('[WeKnoraUserService] Failed to search users:', error);
      return [];
    }
  }

  /**
   * 获取指定租户的用户列表
   */
  async getTenantUsers(tenantId: number, page = 1, pageSize = 50): Promise<{ items: WeKnoraUser[]; total: number }> {
    if (!this._isAvailable) {
      return { items: [], total: 0 };
    }

    try {
      const pool = this.getPool();
      if (!pool) return { items: [], total: 0 };

      const offset = (page - 1) * pageSize;

      const countResult = await pool.query(
        'SELECT COUNT(*) FROM users WHERE tenant_id = $1 AND is_active = true AND deleted_at IS NULL',
        [tenantId]
      );

      const result = await pool.query(
        `SELECT id, username, email, avatar, tenant_id, is_active
         FROM users
         WHERE tenant_id = $1 AND is_active = true AND deleted_at IS NULL
         ORDER BY username
         LIMIT $2 OFFSET $3`,
        [tenantId, pageSize, offset]
      );

      return {
        items: result.rows,
        total: parseInt(countResult.rows[0].count),
      };
    } catch (error) {
      console.error('[WeKnoraUserService] Failed to get tenant users:', error);
      return { items: [], total: 0 };
    }
  }
```

**Step 2: 验证编译通过**

Run: `cd backend && npx tsc --noEmit`
Expected: 无新增错误

---

### Task 7: 创建分享管理路由（含链接分享）

**Files:**
- Create: `backend/src/routes/share.ts`

**Step 1: 编写完整路由文件**

参照 `docs/plans/2026-02-05-knowledge-share-api.md` Task 7 中的完整代码（line 1682-2408），创建 `backend/src/routes/share.ts`。

路由文件结构（**路由定义顺序至关重要**——固定路径在前，参数路由在后）：

1. **服务初始化** — `initShareRoutes()` 从 `weknoraUserService.getDbPool()` 获取连接池并创建服务实例
2. **辅助函数**：
   - `requireShareService` — 503 中间件（`router.use(requireShareService)` 应用到所有路由）
   - `getUserId(req)` — 从查询参数或请求体获取 userId
   - `getTenantId(req)` — 从查询参数或请求体获取 tenantId（parseInt 校验）
   - `getPageSize(req, defaultVal)` — 同时支持 `page_size` 和 `pageSize`
   - `verifyOwnership(req, res, shareId)` — 所有权验证（owner_user_id === userId）
   - `verifyAccess(req, res, shareId)` — 访问权限验证（public=所有人，user=目标用户+owner，link=仅owner）
3. **固定路径路由**（优先匹配）：
   - `GET /list/my-shares` — 我创建的分享
   - `GET /list/shared-to-me` — 分享给我的
   - `GET /list/public` — 公开分享
   - `GET /check/:type/:targetId` — 检查分享状态
4. **链接分享路由**（后续 Task 9 会拆分到独立文件）：
   - `GET /link/:token` — 获取链接分享信息（不需要密码）
   - `POST /link/:token/verify` — 验证密码（设置签名 Cookie）
   - `validateLinkCookie` 中间件 — Cookie 验证（timing-safe 签名比较 + 过期检查）
   - `GET /link/:token/kb` — 知识库详情
   - `GET /link/:token/kb/documents` — 文档列表
   - `GET /link/:token/doc` — 文档详情（支持 `?docId=`）
   - `GET /link/:token/doc/chunks` — 分块内容
   - `GET /link/:token/doc/download` — 下载文档（流式传输）
   - `GET /link/:token/search` — 内容搜索
5. **参数路由**（放在固定路径之后）：
   - `POST /` — 创建分享（含输入验证：枚举、必填、密码长度 4-32）
   - `GET /:id` — 获取分享详情
   - `PUT /:id` — 更新分享（需 verifyOwnership）
   - `DELETE /:id` — 删除分享（需 verifyOwnership）
6. **目标用户管理**（需 verifyOwnership）：
   - `GET /:id/targets` — 获取目标用户列表
   - `POST /:id/targets` — 添加目标用户（支持 userId 或 email）
   - `DELETE /:id/targets/:targetUserId` — 移除目标用户
7. **内容获取**（需 verifyAccess）：
   - `GET /:shareId/kb` — 知识库详情
   - `GET /:shareId/kb/documents` — 文档列表
   - `GET /:shareId/doc` — 文档详情（支持 `?docId=`）
   - `GET /:shareId/doc/chunks` — 分块内容
   - `GET /:shareId/doc/download` — 下载文档
   - `GET /:shareId/search` — 内容搜索

**导出：** `default` (router), `initShareRoutes`, `getShareServices`

```typescript
export function getShareServices() {
  return { shareService, contentService };
}
```

**Step 2: 验证编译通过**

Run: `cd backend && npx tsc --noEmit`
Expected: 无新增错误

---

### Task 8: 扩展用户路由

**Files:**
- Modify: `backend/src/routes/users.ts`

**Step 1: 添加搜索和租户用户路由**

在 `backend/src/routes/users.ts` 的 `export default router;`（line 76）之前添加两个路由。

**位置要求：** 放在现有 `GET /`（line 19）路由之后。`/search` 路径不会被 `GET /` 匹配（路径不同），但必须在任何 `/:param` 路由之前定义。当前 users.ts 没有 `/:param` 路由，所以放在 `export default` 之前即可。

```typescript
// 搜索用户
router.get('/search', async (req: express.Request, res: express.Response) => {
  try {
    const keyword = req.query.q as string;
    const tenantId = req.query.tenantId ? parseInt(req.query.tenantId as string) : undefined;

    if (!keyword || keyword.trim().length < 2) {
      res.json({ success: true, data: [] });
      return;
    }

    const users = await weknoraUserService.searchUsers(keyword.trim(), tenantId);
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
    const pageSize = parseInt((req.query.page_size || req.query.pageSize) as string) || 50;

    const result = await weknoraUserService.getTenantUsers(tenantId, page, pageSize);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Failed to get tenant users:', error);
    res.status(500).json({ success: false, error: 'Failed to get tenant users' });
  }
});
```

**Step 2: 验证编译通过**

Run: `cd backend && npx tsc --noEmit`
Expected: 无新增错误

---

### Task 9: 安装依赖 + 拆分链接分享路由 + 注册路由到 index.ts

**Files:**
- Create: `backend/src/routes/shareLink.ts`
- Modify: `backend/src/routes/share.ts`（移除 `/link/*` 路由和 `validateLinkCookie`）
- Modify: `backend/src/index.ts`
- Modify: `backend/package.json`（安装 cookie-parser、迁移 uuid）

**Step 1: 安装 cookie-parser + 迁移 uuid 到 dependencies**

Run:
```bash
cd backend && pnpm add cookie-parser uuid && pnpm add -D @types/cookie-parser
```

> `uuid` 当前在 devDependencies（`backend/package.json:81`）。运行时 `shareService.ts` 依赖 uuid，生产部署 `pnpm install --prod` 不会安装 devDependencies。`pnpm add uuid` 会将其移到 dependencies。`@types/uuid` 保留在 devDependencies 即可。

**Step 2: 创建 shareLink.ts**

将 `share.ts` 中的链接分享部分拆分到 `backend/src/routes/shareLink.ts`：

- `initShareLinkRoutes(ss, cs)` — 接收 ShareService 和 ShareContentService 实例
- `validateLinkCookie` 中间件 — Cookie 验证（含 timing-safe 签名比较、过期检查）
- 路由（注意：前缀在 index.ts 注册为 `/api/share/link`，所以这里用 `/:token` 而非 `/link/:token`）：
  - `GET /:token` — 获取链接分享信息（不需要密码验证）
  - `POST /:token/verify` — 验证密码（设置 Cookie）
  - `GET /:token/kb` — 知识库详情（需 validateLinkCookie）
  - `GET /:token/kb/documents` — 文档列表
  - `GET /:token/doc` — 文档详情（支持 `?docId=`）
  - `GET /:token/doc/chunks` — 分块内容
  - `GET /:token/doc/download` — 下载文档
  - `GET /:token/search` — 内容搜索

参照 `docs/plans/2026-02-05-knowledge-share-api.md` Task 9 的完整描述。代码基本是从 `share.ts` 中剪切过来，只是路由路径从 `/link/:token` 变为 `/:token`（因为前缀已经包含 `/link`）。

**Step 3: 修改 share.ts**

从 `share.ts` 中删除所有 `/link/*` 路由（约 17 个路由处理函数）和 `validateLinkCookie` 函数。保留：
- 服务初始化（`initShareRoutes`）
- 辅助函数（`requireShareService`、`getUserId`、`getTenantId`、`getPageSize`、`verifyOwnership`、`verifyAccess`）
- 分享列表路由（`/list/*`、`/check/*`）
- 分享管理路由（`POST /`、`GET /:id`、`PUT /:id`、`DELETE /:id`）
- 目标用户管理路由（`/:id/targets`）
- 内容获取路由（`/:shareId/*`）

确保导出 `getShareServices()`：
```typescript
export function getShareServices() {
  return { shareService, contentService };
}
```

**Step 4: 修改 index.ts**

在 `backend/src/index.ts` 中添加 5 处修改：

1. **导入**（约 line 38，`usersRouter` import 附近）：
```typescript
import shareRouter, { initShareRoutes, getShareServices } from './routes/share.js';
import shareLinkRouter, { initShareLinkRoutes } from './routes/shareLink.js';
import cookieParser from 'cookie-parser';
```

2. **中间件**（约 line 274，`express.urlencoded` 之后）：
```typescript
app.use(cookieParser());
```

3. **服务初始化**（约 line 340，背景服务初始化区域）：
```typescript
// 初始化分享服务
try {
  initShareRoutes();
  const { shareService, contentService } = getShareServices();
  if (shareService && contentService) {
    initShareLinkRoutes(shareService, contentService);
  }
} catch (error) {
  console.error('[ShareRoutes] Failed to initialize share routes:', error);
}
```

4. **公开路由**（约 line 376，`app.use('/api/auth')` 附近，**必须在 authMiddleware 保护的 `/api/share` 之前**）：
```typescript
app.use('/api/share/link', shareLinkRouter);
```

5. **受保护路由**（约 line 478，`app.use('/api/users')` 附近）：
```typescript
app.use('/api/share', authMiddleware, shareRouter);
```

**Step 5: 验证编译通过**

Run: `cd backend && npx tsc --noEmit`
Expected: 无新增错误

**Step 6: 验证构建成功**

Run: `cd backend && pnpm run build`
Expected: 构建完成无错误

---

### Task 10: 集成验证

**Files:**
- No file changes, verification only

**Step 1: 全项目类型检查**

Run: `pnpm run type-check`
Expected: 无新增错误

**Step 2: 运行现有测试**

Run: `cd backend && pnpm run test:run`
Expected: 现有测试不受影响（注意：`agents.test.ts` 有预存失败用例，不是本次引入的）

**Step 3: 验证开发服务器启动**

Run: `pnpm run dev:backend`（手动验证）
Expected: 控制台输出 `[ShareRoutes] Share services initialized`

---

## 环境变量

复用现有 `WEKNORA_DB_*` 配置，新增以下环境变量到 `backend/.env`：

```env
# weknora-ui 前端地址（用于生成分享链接）
WEKNORA_UI_URL=http://localhost:3000

# 文件存储根目录（用于下载路径安全校验，可选）
WEKNORA_FILES_DIR=/data/weknora/files
```

---

## 测试清单

完成实现后，按照 `docs/plans/2026-02-05-knowledge-share-api.md` 底部的「测试清单」进行手动 API 测试验证。核心验证项：

- [ ] 数据库迁移脚本在 WeKnora 数据库执行成功
- [ ] 创建分享 API 正常（请求体携带 userId/tenantId）
- [ ] 创建分享输入验证（shareType/shareMode 枚举、linkPassword 长度）
- [ ] 公开分享防重复（同模式同资源去重，不同模式允许共存）
- [ ] 分享列表 API（my-shares, shared-to-me, public）正常
- [ ] 链接分享（无密码）正常访问
- [ ] 链接分享（有密码）验证流程正常（Cookie 机制）
- [ ] 内容获取 API（kb, documents, doc, chunks, download）正常
- [ ] 知识库分享模式下通过 `?docId=xxx` 获取单文档详情/分块/下载
- [ ] 用户搜索 API 正常
- [ ] 无 JWT Token 时受保护路由返回 401
- [ ] 链接分享公开路由不需要 JWT Token
