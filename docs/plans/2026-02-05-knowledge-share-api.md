# 知识库分享 API 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 AgentStudio 后端实现知识库分享功能的 API，供 weknora-ui 前端调用

**前端设计文档:** [weknora-ui 知识库分享功能设计](../../../weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md)

**Architecture:**
- 复用 AgentStudio 现有的 WeKnora PostgreSQL 数据库连接
- 分享元数据存储在 WeKnora 数据库的新建扩展表中
- 内容查询直接读取 WeKnora 现有表（knowledge_bases, knowledges, chunks, users）

**Tech Stack:** TypeScript (Node.js), Express, PostgreSQL (pg 库)

**前置条件:**
- AgentStudio 已配置 WeKnora 数据库连接（WEKNORA_DB_* 环境变量）
- WeKnora 数据库可访问

---

## 前端功能支撑

本 API 支撑以下前端功能（详见前端设计文档）：

| API 分类 | 支撑的前端功能 | 前端文档章节 |
|---------|--------------|-------------|
| **分享管理** | 分享弹窗创建/编辑/删除分享 | [4.3 分享弹窗](../../../weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#43-分享弹窗) |
| **分享列表** | 知识库列表页标签切换（我的/分享给我的/公开的） | [4.1 知识库列表页扩展](../../../weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#41-知识库列表页扩展) |
| **目标用户管理** | 分享弹窗中的用户选择器 | [5.1 新增组件 - UserSelector](../../../weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#51-新增组件) |
| **链接分享** | 链接分享访问页（密码验证、内容展示） | [4.5 链接分享访问页](../../../weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#45-链接分享访问页) |
| **内容获取** | 分享预览页（知识库/文档详情展示） | [4.6 分享预览页详细设计](../../../weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#46-分享预览页详细设计) |
| **用户搜索** | 分享弹窗中搜索用户 | [5.1 新增组件 - UserSelector](../../../weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#51-新增组件) |
| **我的分享管理** | 我的分享管理页面 | [4.4 我的分享管理页面](../../../weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#44-我的分享管理页面) |

---

## 认证机制

### 认证方式

weknora-ui 调用 AgentStudio 分享 API 时，使用 **API Key + Header** 认证：

```typescript
// weknora-ui 调用示例
const response = await fetch(`${serverUrl}/api/share`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,       // API Key 认证（复用现有机制）
    'X-User-ID': userId,                       // WeKnora 用户 ID
    'X-Tenant-ID': String(tenantId),           // WeKnora 租户 ID
    'X-Username': username,                    // 用户名（可选，用于冗余存储）
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(shareData)
})
```

### 认证中间件

创建 `weknoraAuth` 中间件，从 Header 提取用户信息：

| Header | 说明 | 必填 |
|--------|------|------|
| `Authorization` | `Bearer <API Key>` | 是 |
| `X-User-ID` | WeKnora 用户 ID | 是（需认证的 API） |
| `X-Tenant-ID` | WeKnora 租户 ID | 是（需认证的 API） |
| `X-Username` | 用户名 | 否 |

### 请求上下文

认证通过后，用户信息附加到 `req.weknoraAuth`：

```typescript
interface WeknoraAuthContext {
  userId: string;
  tenantId: number;
  username?: string;
}

// 在路由中使用
router.post('/', async (req: WeknoraAuthRequest, res) => {
  const { userId, tenantId, username } = req.weknoraAuth!;
  // ...
});
```

---

## 数据库设计

### 1. 分享记录表 (shares)

```sql
CREATE TABLE shares (
    id VARCHAR(36) PRIMARY KEY,
    share_type VARCHAR(20) NOT NULL,        -- 'knowledge_base' | 'knowledge'
    target_id VARCHAR(36) NOT NULL,         -- 知识库ID 或 文档ID
    target_name VARCHAR(255),               -- 冗余名称便于展示
    target_kb_id VARCHAR(36),               -- 文档分享时记录所属知识库ID

    share_mode VARCHAR(20) NOT NULL,        -- 'public' | 'user' | 'link'
    share_link_token VARCHAR(64) UNIQUE,    -- 链接分享 token
    link_password VARCHAR(255),             -- 链接密码（可选，哈希存储）

    permissions VARCHAR(20) DEFAULT 'read', -- 'read' | 'write'
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
```

### 2. 分享目标用户表 (share_targets)

```sql
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
```

### 3. 分享访问日志表 (share_access_logs)

```sql
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

## API 设计

### 路由前缀

所有分享相关 API 使用 `/api/share` 前缀，用户搜索 API 复用现有 `/api/users`。

### 1. 分享管理 API

| 方法 | 路径 | 功能 | 认证 |
|-----|------|------|------|
| POST | `/api/share` | 创建分享 | Header |
| GET | `/api/share/:id` | 获取分享详情 | Header |
| PUT | `/api/share/:id` | 更新分享设置 | Header |
| DELETE | `/api/share/:id` | 删除分享（软删除） | Header |

### 2. 分享列表 API

| 方法 | 路径 | 功能 | 认证 |
|-----|------|------|------|
| GET | `/api/share/my-shares` | 我创建的分享 | Header |
| GET | `/api/share/shared-to-me` | 分享给我的 | Header |
| GET | `/api/share/public` | 公开的内容 | 无 |

### 3. 分享目标用户 API

| 方法 | 路径 | 功能 | 认证 |
|-----|------|------|------|
| GET | `/api/share/:id/targets` | 获取分享目标用户列表 | Header |
| POST | `/api/share/:id/targets` | 添加分享目标用户 | Header |
| DELETE | `/api/share/:id/targets/:userId` | 移除分享目标用户 | Header |

### 4. 链接分享 API

| 方法 | 路径 | 功能 | 认证 |
|-----|------|------|------|
| GET | `/api/share/link/:token` | 获取分享基本信息 | 无需 |
| POST | `/api/share/link/:token/verify` | 验证链接密码 | 无需 |
| GET | `/api/share/link/:token/kb` | 获取知识库详情 | Cookie |
| GET | `/api/share/link/:token/kb/documents` | 获取文档列表 | Cookie |
| GET | `/api/share/link/:token/doc` | 获取文档详情 | Cookie |
| GET | `/api/share/link/:token/doc/chunks` | 获取分块内容 | Cookie |
| GET | `/api/share/link/:token/doc/download` | 下载文档 | Cookie |

### 5. 内容获取 API（需认证）

| 方法 | 路径 | 功能 | 认证 |
|-----|------|------|------|
| GET | `/api/share/:shareId/kb` | 获取分享的知识库详情 | Header |
| GET | `/api/share/:shareId/kb/documents` | 获取知识库的文档列表 | Header |
| GET | `/api/share/:shareId/doc` | 获取分享的文档详情 | Header |
| GET | `/api/share/:shareId/doc/chunks` | 获取文档分块内容 | Header |
| GET | `/api/share/:shareId/doc/download` | 下载文档文件 | Header |

### 6. 用户搜索 API（扩展现有）

| 方法 | 路径 | 功能 | 认证 |
|-----|------|------|------|
| GET | `/api/users/search?q=xxx` | 搜索用户（用户名/邮箱） | Header |
| GET | `/api/users/tenant/:tenantId` | 获取指定租户的用户列表 | Header |

### 7. 辅助 API

| 方法 | 路径 | 功能 | 认证 |
|-----|------|------|------|
| GET | `/api/share/check/:type/:targetId` | 检查资源是否已被分享 | Header |

---

## 请求/响应结构

### 创建分享

```typescript
// POST /api/share
interface CreateShareRequest {
  shareType: 'knowledge_base' | 'knowledge';
  targetId: string;
  shareMode: 'public' | 'user' | 'link';
  permissions?: 'read';
  expiresAt?: string;           // ISO8601
  linkPassword?: string;        // 仅 link 模式
  targetUsers?: Array<{         // 仅 user 模式
    userId?: string;
    email?: string;
  }>;
}

interface CreateShareResponse {
  success: boolean;
  data: {
    shareId: string;
    shareLinkToken?: string;
    shareUrl?: string;
  };
}
```

### 分享列表

```typescript
// GET /api/share/my-shares, /api/share/shared-to-me, /api/share/public
interface ShareListResponse {
  success: boolean;
  data: {
    items: ShareItem[];
    total: number;
    page: number;
    pageSize: number;
  };
}

interface ShareItem {
  shareId: string;
  shareType: 'knowledge_base' | 'knowledge';
  targetId: string;
  targetName: string;
  targetKbId?: string;
  targetKbName?: string;
  shareMode: 'public' | 'user' | 'link';
  permissions: 'read';
  status: 'active' | 'disabled' | 'expired';
  ownerUserId: string;
  ownerUsername: string;
  viewCount: number;
  createdAt: string;
  expiresAt?: string;
}
```

### 分享目标用户

```typescript
// GET /api/share/:id/targets
interface ShareTargetsResponse {
  success: boolean;
  data: Array<{
    userId: string;
    username: string;
    email: string;
    tenantId?: number;
    acceptedAt?: string;
    createdAt: string;
  }>;
}

// POST /api/share/:id/targets
interface AddShareTargetRequest {
  userId?: string;
  email?: string;
}

// DELETE /api/share/:id/targets/:userId - 无请求体
```

### 知识库详情

```typescript
// GET /api/share/:shareId/kb
interface KnowledgeBaseResponse {
  success: boolean;
  data: {
    id: string;
    name: string;
    type: 'document' | 'faq';
    description: string;
    documentCount: number;
    createdAt: string;
    updatedAt: string;
  };
}
```

### 文档列表

```typescript
// GET /api/share/:shareId/kb/documents
interface DocumentListResponse {
  success: boolean;
  data: {
    items: Array<{
      id: string;
      title: string;
      fileName: string;
      fileType: string;
      fileSize: number;
      parseStatus: string;
      createdAt: string;
    }>;
    total: number;
    page: number;
    pageSize: number;
  };
}
```

### 文档详情

```typescript
// GET /api/share/:shareId/doc
interface DocumentDetailResponse {
  success: boolean;
  data: {
    id: string;
    title: string;
    description: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    content?: string;
    kbId: string;
    kbName: string;
    createdAt: string;
    updatedAt: string;
  };
}
```

### 分块列表

```typescript
// GET /api/share/:shareId/doc/chunks
interface ChunkListResponse {
  success: boolean;
  data: {
    items: Array<{
      id: string;
      content: string;
      chunkIndex: number;
      chunkType: string;
      metadata?: any;
    }>;
    total: number;
    page: number;
    pageSize: number;
  };
}
```

### 用户搜索

```typescript
// GET /api/users/search?q=xxx
interface UserSearchResponse {
  success: boolean;
  data: Array<{
    id: string;
    username: string;
    email: string;
    avatar?: string;
    tenantId: number;
  }>;
}
```

---

## 实现任务

### Task 1: 创建类型定义

**Files:**
- Create: `backend/src/types/share.ts`

```typescript
// backend/src/types/share.ts

export type ShareType = 'knowledge_base' | 'knowledge';
export type ShareMode = 'public' | 'user' | 'link';
export type ShareStatus = 'active' | 'disabled';
export type SharePermission = 'read' | 'write';

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
  shareType: ShareType;
  targetId: string;
  shareMode: ShareMode;
  permissions?: SharePermission;
  expiresAt?: string;
  linkPassword?: string;
  targetUsers?: Array<{
    userId?: string;
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

**Commit:**
```bash
git add backend/src/types/share.ts
git commit -m "feat: add share types for knowledge sharing"
```

---

### Task 2: 创建数据库迁移脚本

**Files:**
- Create: `backend/src/db/migrations/001_create_share_tables.sql`

将上面数据库设计部分的 SQL 写入文件（包含 `idx_shares_deleted` 索引）。

**Commit:**
```bash
git add backend/src/db/migrations/001_create_share_tables.sql
git commit -m "feat: add share tables migration script"
```

---

### Task 3: 创建 WeKnora 认证中间件

**Files:**
- Create: `backend/src/middleware/weknoraAuth.ts`

```typescript
// backend/src/middleware/weknoraAuth.ts
/**
 * WeKnora Authentication Middleware
 *
 * 从请求 Header 中提取 WeKnora 用户信息：
 * - X-User-ID: WeKnora 用户 ID
 * - X-Tenant-ID: WeKnora 租户 ID
 * - X-Username: 用户名（可选）
 *
 * 用于分享 API 等需要知道调用者身份的场景。
 * 注意：此中间件不验证 API Key，API Key 验证由 a2aAuth 中间件处理。
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * WeKnora 认证上下文
 */
export interface WeknoraAuthContext {
  userId: string;
  tenantId: number;
  username?: string;
}

/**
 * 扩展 Express Request
 */
export interface WeknoraAuthRequest extends Request {
  weknoraAuth?: WeknoraAuthContext;
}

/**
 * WeKnora 认证中间件（必须）
 *
 * 从 Header 提取用户信息，缺少必填字段返回 401
 */
export function weknoraAuth(req: WeknoraAuthRequest, res: Response, next: NextFunction): void {
  const userId = req.headers['x-user-id'] as string | undefined;
  const tenantIdStr = req.headers['x-tenant-id'] as string | undefined;
  const username = req.headers['x-username'] as string | undefined;

  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Missing X-User-ID header',
      code: 'MISSING_USER_ID',
    });
    return;
  }

  if (!tenantIdStr) {
    res.status(401).json({
      success: false,
      error: 'Missing X-Tenant-ID header',
      code: 'MISSING_TENANT_ID',
    });
    return;
  }

  const tenantId = parseInt(tenantIdStr, 10);
  if (isNaN(tenantId)) {
    res.status(400).json({
      success: false,
      error: 'Invalid X-Tenant-ID header',
      code: 'INVALID_TENANT_ID',
    });
    return;
  }

  req.weknoraAuth = {
    userId,
    tenantId,
    username,
  };

  next();
}

/**
 * WeKnora 认证中间件（可选）
 *
 * 从 Header 提取用户信息，缺少字段时不报错，继续处理
 */
export function optionalWeknoraAuth(req: WeknoraAuthRequest, res: Response, next: NextFunction): void {
  const userId = req.headers['x-user-id'] as string | undefined;
  const tenantIdStr = req.headers['x-tenant-id'] as string | undefined;
  const username = req.headers['x-username'] as string | undefined;

  if (userId && tenantIdStr) {
    const tenantId = parseInt(tenantIdStr, 10);
    if (!isNaN(tenantId)) {
      req.weknoraAuth = {
        userId,
        tenantId,
        username,
      };
    }
  }

  next();
}
```

**Commit:**
```bash
git add backend/src/middleware/weknoraAuth.ts
git commit -m "feat: add WeKnora authentication middleware"
```

---

### Task 4: 创建分享服务

**Files:**
- Create: `backend/src/services/shareService.ts`

```typescript
// backend/src/services/shareService.ts
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';
import {
  Share,
  ShareTarget,
  ShareType,
  ShareMode,
  CreateShareRequest,
  ShareItem,
} from '../types/share.js';

export class ShareService {
  constructor(private pool: Pool) {}

  /**
   * 创建分享
   */
  async createShare(
    request: CreateShareRequest,
    ownerUserId: string,
    ownerTenantId: number,
    ownerUsername?: string
  ): Promise<{ shareId: string; shareLinkToken?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const shareId = uuidv4();
      let shareLinkToken: string | undefined;
      let linkPasswordHash: string | undefined;

      // 生成链接 token
      if (request.shareMode === 'link') {
        shareLinkToken = uuidv4().replace(/-/g, '');
      }

      // 哈希密码
      if (request.linkPassword) {
        linkPasswordHash = await bcrypt.hash(request.linkPassword, 10);
      }

      // 获取目标名称和所属知识库ID
      const { targetName, targetKbId } = await this.getTargetInfo(
        request.shareType,
        request.targetId
      );

      // 插入分享记录
      await client.query(
        `INSERT INTO shares (
          id, share_type, target_id, target_name, target_kb_id,
          share_mode, share_link_token, link_password,
          permissions, status,
          owner_tenant_id, owner_user_id, owner_username,
          expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())`,
        [
          shareId,
          request.shareType,
          request.targetId,
          targetName,
          targetKbId,
          request.shareMode,
          shareLinkToken,
          linkPasswordHash,
          request.permissions || 'read',
          'active',
          ownerTenantId,
          ownerUserId,
          ownerUsername,
          request.expiresAt || null,
        ]
      );

      // 添加目标用户
      if (request.shareMode === 'user' && request.targetUsers) {
        for (const user of request.targetUsers) {
          if (user.userId) {
            await this.addShareTargetInternal(client, shareId, user.userId);
          } else if (user.email) {
            const foundUser = await this.findUserByEmail(user.email);
            if (foundUser) {
              await this.addShareTargetInternal(client, shareId, foundUser.id);
            }
          }
        }
      }

      await client.query('COMMIT');
      return { shareId, shareLinkToken };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取分享详情
   */
  async getShareById(shareId: string): Promise<Share | null> {
    const result = await this.pool.query(
      `SELECT * FROM shares WHERE id = $1 AND deleted_at IS NULL`,
      [shareId]
    );
    return result.rows[0] || null;
  }

  /**
   * 通过 token 获取分享
   */
  async getShareByToken(token: string): Promise<Share | null> {
    const result = await this.pool.query(
      `SELECT * FROM shares WHERE share_link_token = $1 AND deleted_at IS NULL`,
      [token]
    );
    return result.rows[0] || null;
  }

  /**
   * 验证链接密码
   */
  async verifyLinkPassword(token: string, password: string): Promise<boolean> {
    const share = await this.getShareByToken(token);
    if (!share || !share.link_password) {
      return false;
    }
    return bcrypt.compare(password, share.link_password);
  }

  /**
   * 获取我创建的分享
   */
  async getMyShares(
    userId: string,
    page = 1,
    pageSize = 20,
    shareType?: ShareType
  ): Promise<{ items: ShareItem[]; total: number }> {
    const offset = (page - 1) * pageSize;
    let whereClause = 'owner_user_id = $1 AND deleted_at IS NULL';
    const params: any[] = [userId];

    if (shareType) {
      whereClause += ' AND share_type = $2';
      params.push(shareType);
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM shares WHERE ${whereClause}`,
      params
    );

    const result = await this.pool.query(
      `SELECT * FROM shares WHERE ${whereClause}
       ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );

    return {
      items: result.rows.map(this.mapToShareItem),
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * 获取分享给我的
   */
  async getSharedToMe(
    userId: string,
    page = 1,
    pageSize = 20
  ): Promise<{ items: ShareItem[]; total: number }> {
    const offset = (page - 1) * pageSize;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM share_targets st
       JOIN shares s ON st.share_id = s.id
       WHERE st.target_user_id = $1 AND s.deleted_at IS NULL AND s.status = 'active'`,
      [userId]
    );

    const result = await this.pool.query(
      `SELECT s.* FROM share_targets st
       JOIN shares s ON st.share_id = s.id
       WHERE st.target_user_id = $1 AND s.deleted_at IS NULL AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`,
      [userId, pageSize, offset]
    );

    return {
      items: result.rows.map(this.mapToShareItem),
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * 获取公开的分享
   */
  async getPublicShares(
    page = 1,
    pageSize = 20
  ): Promise<{ items: ShareItem[]; total: number }> {
    const offset = (page - 1) * pageSize;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM shares
       WHERE share_mode = 'public' AND deleted_at IS NULL AND status = 'active'`
    );

    const result = await this.pool.query(
      `SELECT * FROM shares
       WHERE share_mode = 'public' AND deleted_at IS NULL AND status = 'active'
       ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    return {
      items: result.rows.map(this.mapToShareItem),
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * 更新分享
   */
  async updateShare(
    shareId: string,
    updates: { status?: string; expiresAt?: string }
  ): Promise<void> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.status) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }
    if (updates.expiresAt !== undefined) {
      setClauses.push(`expires_at = $${paramIndex++}`);
      params.push(updates.expiresAt || null);
    }

    params.push(shareId);

    await this.pool.query(
      `UPDATE shares SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      params
    );
  }

  /**
   * 删除分享（软删除）
   */
  async deleteShare(shareId: string): Promise<void> {
    await this.pool.query(
      `UPDATE shares SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [shareId]
    );
  }

  /**
   * 增加访问计数
   */
  async incrementViewCount(shareId: string): Promise<void> {
    await this.pool.query(
      `UPDATE shares SET view_count = view_count + 1, last_accessed_at = NOW() WHERE id = $1`,
      [shareId]
    );
  }

  // ========== 分享目标用户管理 ==========

  /**
   * 获取分享目标用户列表
   */
  async getShareTargets(shareId: string): Promise<ShareTarget[]> {
    const result = await this.pool.query(
      `SELECT * FROM share_targets WHERE share_id = $1 ORDER BY created_at`,
      [shareId]
    );
    return result.rows;
  }

  /**
   * 添加分享目标用户
   */
  async addShareTarget(shareId: string, userId: string): Promise<ShareTarget | null> {
    const user = await this.findUserById(userId);
    if (!user) return null;

    const id = uuidv4();
    await this.pool.query(
      `INSERT INTO share_targets (id, share_id, target_user_id, target_username, target_email, target_tenant_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (share_id, target_user_id) DO NOTHING`,
      [id, shareId, userId, user.username, user.email, user.tenant_id]
    );

    return {
      id,
      share_id: shareId,
      target_user_id: userId,
      target_username: user.username,
      target_email: user.email,
      target_tenant_id: user.tenant_id,
      created_at: new Date(),
    };
  }

  /**
   * 移除分享目标用户
   */
  async removeShareTarget(shareId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM share_targets WHERE share_id = $1 AND target_user_id = $2`,
      [shareId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * 检查用户是否有权访问分享
   */
  async canUserAccessShare(shareId: string, userId?: string): Promise<boolean> {
    const share = await this.getShareById(shareId);
    if (!share) return false;
    if (share.status !== 'active') return false;
    if (share.expires_at && new Date(share.expires_at) < new Date()) return false;

    // 公开分享
    if (share.share_mode === 'public') return true;

    // 链接分享（通过 token 验证，此处返回 true）
    if (share.share_mode === 'link') return true;

    // 用户分享
    if (share.share_mode === 'user' && userId) {
      // 是创建者
      if (share.owner_user_id === userId) return true;

      // 在目标用户列表中
      const result = await this.pool.query(
        `SELECT 1 FROM share_targets WHERE share_id = $1 AND target_user_id = $2`,
        [shareId, userId]
      );
      return result.rows.length > 0;
    }

    return false;
  }

  /**
   * 检查资源是否已被分享
   */
  async checkShareExists(
    shareType: ShareType,
    targetId: string,
    ownerUserId: string
  ): Promise<{ shared: boolean; shareId?: string }> {
    const result = await this.pool.query(
      `SELECT id FROM shares
       WHERE share_type = $1 AND target_id = $2 AND owner_user_id = $3
         AND deleted_at IS NULL AND status = 'active'
       LIMIT 1`,
      [shareType, targetId, ownerUserId]
    );

    if (result.rows.length > 0) {
      return { shared: true, shareId: result.rows[0].id };
    }
    return { shared: false };
  }

  /**
   * 记录访问日志
   */
  async logAccess(
    shareId: string,
    accessType: 'view' | 'download' | 'copy',
    accessorUserId?: string,
    accessorIp?: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO share_access_logs (id, share_id, accessor_user_id, accessor_ip, access_type, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [uuidv4(), shareId, accessorUserId, accessorIp, accessType]
    );
  }

  /**
   * 通过邮箱查找用户（公开方法，供路由层使用）
   */
  async findUserByEmail(email: string) {
    const result = await this.pool.query(
      `SELECT id, username, email, tenant_id FROM users WHERE email = $1`,
      [email]
    );
    return result.rows[0] || null;
  }

  // ========== Private helpers ==========

  private async addShareTargetInternal(
    client: PoolClient,
    shareId: string,
    userId: string
  ): Promise<void> {
    const user = await this.findUserById(userId);
    await client.query(
      `INSERT INTO share_targets (id, share_id, target_user_id, target_username, target_email, target_tenant_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (share_id, target_user_id) DO NOTHING`,
      [uuidv4(), shareId, userId, user?.username, user?.email, user?.tenant_id]
    );
  }

  private async getTargetInfo(
    shareType: ShareType,
    targetId: string
  ): Promise<{ targetName: string; targetKbId?: string }> {
    if (shareType === 'knowledge_base') {
      const result = await this.pool.query(
        `SELECT name FROM knowledge_bases WHERE id = $1`,
        [targetId]
      );
      return { targetName: result.rows[0]?.name || '' };
    } else {
      const result = await this.pool.query(
        `SELECT title, knowledge_base_id FROM knowledges WHERE id = $1`,
        [targetId]
      );
      return {
        targetName: result.rows[0]?.title || '',
        targetKbId: result.rows[0]?.knowledge_base_id,
      };
    }
  }

  private async findUserById(userId: string) {
    const result = await this.pool.query(
      `SELECT id, username, email, tenant_id FROM users WHERE id = $1`,
      [userId]
    );
    return result.rows[0] || null;
  }

  // 注意：findUserByEmail 已作为公开方法定义（第 1064-1070 行），
  // 私有版本已删除，内部调用统一使用公开方法

  private mapToShareItem(row: any): ShareItem {
    return {
      shareId: row.id,
      shareType: row.share_type,
      targetId: row.target_id,
      targetName: row.target_name || '',
      targetKbId: row.target_kb_id,
      shareMode: row.share_mode,
      permissions: row.permissions,
      status: row.expires_at && new Date(row.expires_at) < new Date() ? 'expired' : row.status,
      ownerUserId: row.owner_user_id,
      ownerUsername: row.owner_username || '',
      viewCount: row.view_count || 0,
      createdAt: row.created_at?.toISOString(),
      expiresAt: row.expires_at?.toISOString(),
    };
  }
}
```

**Commit:**
```bash
git add backend/src/services/shareService.ts
git commit -m "feat: add share service for knowledge sharing"
```

---

### Task 5: 创建内容代理服务

**Files:**
- Create: `backend/src/services/shareContentService.ts`

```typescript
// backend/src/services/shareContentService.ts
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { ShareService } from './shareService.js';

export class ShareContentService {
  constructor(
    private pool: Pool,
    private shareService: ShareService
  ) {}

  /**
   * 验证分享权限
   */
  private async validateShare(
    shareId: string,
    expectedType?: 'knowledge_base' | 'knowledge'
  ) {
    const share = await this.shareService.getShareById(shareId);

    if (!share) {
      throw new Error('SHARE_NOT_FOUND');
    }
    if (expectedType && share.share_type !== expectedType) {
      throw new Error('SHARE_TYPE_MISMATCH');
    }
    if (share.status !== 'active') {
      throw new Error('SHARE_DISABLED');
    }
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      throw new Error('SHARE_EXPIRED');
    }

    return share;
  }

  /**
   * 获取分享的知识库详情
   */
  async getKnowledgeBase(shareId: string) {
    const share = await this.validateShare(shareId, 'knowledge_base');

    const result = await this.pool.query(
      `SELECT id, name, description, type, created_at, updated_at
       FROM knowledge_bases
       WHERE id = $1 AND deleted_at IS NULL`,
      [share.target_id]
    );

    if (result.rows.length === 0) {
      throw new Error('TARGET_NOT_FOUND');
    }

    // 获取文档数量
    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM knowledges WHERE knowledge_base_id = $1 AND deleted_at IS NULL`,
      [share.target_id]
    );

    const kb = result.rows[0];
    return {
      id: kb.id,
      name: kb.name,
      description: kb.description,
      type: kb.type,
      documentCount: parseInt(countResult.rows[0].count),
      createdAt: kb.created_at?.toISOString(),
      updatedAt: kb.updated_at?.toISOString(),
    };
  }

  /**
   * 获取分享知识库的文档列表
   */
  async getKnowledgeBaseDocuments(shareId: string, page = 1, pageSize = 20) {
    const share = await this.validateShare(shareId, 'knowledge_base');
    const offset = (page - 1) * pageSize;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM knowledges WHERE knowledge_base_id = $1 AND deleted_at IS NULL`,
      [share.target_id]
    );

    const result = await this.pool.query(
      `SELECT id, title, file_name, file_type, file_size, parse_status, created_at
       FROM knowledges
       WHERE knowledge_base_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [share.target_id, pageSize, offset]
    );

    return {
      items: result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        fileName: row.file_name,
        fileType: row.file_type,
        fileSize: row.file_size,
        parseStatus: row.parse_status,
        createdAt: row.created_at?.toISOString(),
      })),
      total: parseInt(countResult.rows[0].count),
      page,
      pageSize,
    };
  }

  /**
   * 获取分享的文档详情
   */
  async getDocument(shareId: string) {
    const share = await this.validateShare(shareId, 'knowledge');

    const result = await this.pool.query(
      `SELECT k.id, k.title, k.description, k.file_name, k.file_type, k.file_size,
              k.metadata, k.knowledge_base_id, k.created_at, k.updated_at,
              kb.name as kb_name
       FROM knowledges k
       LEFT JOIN knowledge_bases kb ON k.knowledge_base_id = kb.id
       WHERE k.id = $1 AND k.deleted_at IS NULL`,
      [share.target_id]
    );

    if (result.rows.length === 0) {
      throw new Error('TARGET_NOT_FOUND');
    }

    const doc = result.rows[0];
    return {
      id: doc.id,
      title: doc.title,
      description: doc.description,
      fileName: doc.file_name,
      fileType: doc.file_type,
      fileSize: doc.file_size,
      content: doc.metadata?.content,
      kbId: doc.knowledge_base_id,
      kbName: doc.kb_name,
      createdAt: doc.created_at?.toISOString(),
      updatedAt: doc.updated_at?.toISOString(),
    };
  }

  /**
   * 获取文档分块
   */
  async getDocumentChunks(shareId: string, page = 1, pageSize = 25) {
    const share = await this.validateShare(shareId, 'knowledge');
    const offset = (page - 1) * pageSize;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM chunks WHERE knowledge_id = $1 AND is_enabled = true`,
      [share.target_id]
    );

    const result = await this.pool.query(
      `SELECT id, content, chunk_index, chunk_type, metadata
       FROM chunks
       WHERE knowledge_id = $1 AND is_enabled = true
       ORDER BY chunk_index
       LIMIT $2 OFFSET $3`,
      [share.target_id, pageSize, offset]
    );

    return {
      items: result.rows.map((row) => ({
        id: row.id,
        content: row.content,
        chunkIndex: row.chunk_index,
        chunkType: row.chunk_type,
        metadata: row.metadata,
      })),
      total: parseInt(countResult.rows[0].count),
      page,
      pageSize,
    };
  }

  /**
   * 获取下载信息
   */
  async getDownloadInfo(shareId: string) {
    const share = await this.validateShare(shareId, 'knowledge');

    const result = await this.pool.query(
      `SELECT title, file_name, file_type, file_path, file_size
       FROM knowledges
       WHERE id = $1 AND deleted_at IS NULL`,
      [share.target_id]
    );

    if (result.rows.length === 0) {
      throw new Error('TARGET_NOT_FOUND');
    }

    const doc = result.rows[0];
    if (!doc.file_path || !fs.existsSync(doc.file_path)) {
      throw new Error('FILE_NOT_FOUND');
    }

    return {
      fileName: doc.file_name || doc.title,
      filePath: doc.file_path,
      fileType: doc.file_type,
      fileSize: doc.file_size,
    };
  }
}
```

**Commit:**
```bash
git add backend/src/services/shareContentService.ts
git commit -m "feat: add share content service for reading WeKnora data"
```

---

### Task 6: 扩展用户服务

**Files:**
- Modify: `backend/src/services/weknoraUserService.ts`

在现有 `weknoraUserService.ts` 中添加用户搜索方法：

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
    const params: any[] = [`%${keyword}%`];

    if (tenantId) {
      query += ' AND tenant_id = $2';
      params.push(tenantId);
    }

    query += ` ORDER BY username LIMIT ${limit}`;

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

**Commit:**
```bash
git add backend/src/services/weknoraUserService.ts
git commit -m "feat: add user search methods to weknoraUserService"
```

---

### Task 7: 创建分享路由

**Files:**
- Create: `backend/src/routes/share.ts`

```typescript
// backend/src/routes/share.ts
import { Router, Response } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { Pool } from 'pg';
import { ShareService } from '../services/shareService.js';
import { ShareContentService } from '../services/shareContentService.js';
import { weknoraAuth, optionalWeknoraAuth, WeknoraAuthRequest } from '../middleware/weknoraAuth.js';

const router = Router();

// 服务实例（需要在应用启动时初始化）
let shareService: ShareService;
let contentService: ShareContentService;

export function initShareRoutes(pool: Pool) {
  shareService = new ShareService(pool);
  contentService = new ShareContentService(pool, shareService);
}

// ========== 重要：路由定义顺序 ==========
// 固定路径路由必须在参数路由之前定义，否则会被 /:id 匹配

// ========== 分享列表（固定路径，优先匹配） ==========

// 我创建的分享
router.get('/list/my-shares', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const { userId } = req.weknoraAuth!;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const shareType = req.query.share_type as any;

    const result = await shareService.getMyShares(userId, page, pageSize, shareType);
    res.json({ success: true, data: { ...result, page, pageSize } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 分享给我的
router.get('/list/shared-to-me', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const { userId } = req.weknoraAuth!;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;

    const result = await shareService.getSharedToMe(userId, page, pageSize);
    res.json({ success: true, data: { ...result, page, pageSize } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 公开的分享
router.get('/list/public', async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;

    const result = await shareService.getPublicShares(page, pageSize);
    res.json({ success: true, data: { ...result, page, pageSize } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 检查分享状态（固定路径）
router.get('/check/:type/:targetId', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const { userId } = req.weknoraAuth!;
    const { type, targetId } = req.params;

    const result = await shareService.checkShareExists(type as any, targetId, userId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== 链接分享（固定路径，优先匹配） ==========

// 获取链接分享信息（无需认证）
router.get('/link/:token', async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const share = await shareService.getShareByToken(req.params.token);
    if (!share) {
      res.status(404).json({ success: false, error: 'Share not found' });
      return;
    }

    // 检查是否过期
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
router.post('/link/:token/verify', async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const { password } = req.body;
    const valid = await shareService.verifyLinkPassword(req.params.token, password);

    if (!valid) {
      res.status(401).json({ success: false, error: 'Invalid password' });
      return;
    }

    // 设置验证 Cookie
    const timestamp = Date.now();
    const signature = crypto
      .createHmac('sha256', process.env.JWT_SECRET || 'secret')
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

// 链接分享内容获取中间件
async function validateLinkCookie(req: WeknoraAuthRequest, res: Response, next: Function) {
  const share = await shareService.getShareByToken(req.params.token);

  // 无密码保护，直接放行
  if (!share?.link_password) {
    return next();
  }

  const cookie = req.cookies?.share_verified;
  if (!cookie) {
    res.status(401).json({ success: false, error: 'Password verification required' });
    return;
  }

  const [cookieToken, timestampStr, signature] = cookie.split(':');
  const timestamp = parseInt(timestampStr, 10);

  // 验证 token 匹配
  if (cookieToken !== req.params.token) {
    res.status(401).json({ success: false, error: 'Invalid verification' });
    return;
  }

  // 验证签名
  const expectedSignature = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'secret')
    .update(`${req.params.token}:${timestamp}`)
    .digest('hex');

  if (signature !== expectedSignature) {
    res.status(401).json({ success: false, error: 'Invalid signature' });
    return;
  }

  // 验证有效期
  if (Date.now() - timestamp > 24 * 60 * 60 * 1000) {
    res.status(401).json({ success: false, error: 'Verification expired' });
    return;
  }

  next();
}

// 链接分享 - 知识库详情
router.get('/link/:token/kb', validateLinkCookie, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const share = await shareService.getShareByToken(req.params.token);
    if (!share) {
      res.status(404).json({ success: false, error: 'Share not found' });
      return;
    }

    const data = await contentService.getKnowledgeBase(share.id);
    await shareService.incrementViewCount(share.id);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享 - 文档列表
router.get('/link/:token/kb/documents', validateLinkCookie, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const share = await shareService.getShareByToken(req.params.token);
    if (!share) {
      res.status(404).json({ success: false, error: 'Share not found' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;

    const data = await contentService.getKnowledgeBaseDocuments(share.id, page, pageSize);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享 - 文档详情
router.get('/link/:token/doc', validateLinkCookie, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const share = await shareService.getShareByToken(req.params.token);
    if (!share) {
      res.status(404).json({ success: false, error: 'Share not found' });
      return;
    }

    const data = await contentService.getDocument(share.id);
    await shareService.incrementViewCount(share.id);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享 - 分块内容
router.get('/link/:token/doc/chunks', validateLinkCookie, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const share = await shareService.getShareByToken(req.params.token);
    if (!share) {
      res.status(404).json({ success: false, error: 'Share not found' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 25;

    const data = await contentService.getDocumentChunks(share.id, page, pageSize);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享 - 下载文档
router.get('/link/:token/doc/download', validateLinkCookie, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const share = await shareService.getShareByToken(req.params.token);
    if (!share) {
      res.status(404).json({ success: false, error: 'Share not found' });
      return;
    }

    const downloadInfo = await contentService.getDownloadInfo(share.id);

    res.setHeader('Content-Type', downloadInfo.fileType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadInfo.fileName)}"`);
    res.setHeader('Content-Length', downloadInfo.fileSize);

    const fileStream = fs.createReadStream(downloadInfo.filePath);
    fileStream.pipe(res);
  } catch (error: any) {
    const status = error.message === 'FILE_NOT_FOUND' ? 404 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// ========== 分享管理（参数路由，放在固定路径之后） ==========

// 创建分享
router.post('/', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const { userId, tenantId, username } = req.weknoraAuth!;
    const result = await shareService.createShare(req.body, userId, tenantId, username);

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
router.get('/:id', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const share = await shareService.getShareById(req.params.id);
    if (!share) {
      res.status(404).json({ success: false, error: 'Share not found' });
      return;
    }
    res.json({ success: true, data: share });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 更新分享
router.put('/:id', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    await shareService.updateShare(req.params.id, req.body);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除分享
router.delete('/:id', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    await shareService.deleteShare(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== 分享目标用户管理 ==========

// 获取分享目标用户列表
router.get('/:id/targets', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
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

// 添加分享目标用户
router.post('/:id/targets', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const { userId, email } = req.body;
    if (!userId && !email) {
      res.status(400).json({ success: false, error: 'userId or email is required' });
      return;
    }

    // 如果提供的是 email，先查找用户
    let targetUserId = userId;
    if (!targetUserId && email) {
      const user = await shareService.findUserByEmail(email);
      if (!user) {
        res.status(404).json({ success: false, error: 'User not found with this email' });
        return;
      }
      targetUserId = user.id;
    }

    const target = await shareService.addShareTarget(req.params.id, targetUserId);
    if (!target) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    res.json({ success: true, data: target });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 移除分享目标用户
router.delete('/:id/targets/:userId', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const removed = await shareService.removeShareTarget(req.params.id, req.params.userId);
    if (!removed) {
      res.status(404).json({ success: false, error: 'Target not found' });
      return;
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== 内容获取（需认证） ==========

router.get('/:shareId/kb', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const data = await contentService.getKnowledgeBase(req.params.shareId);
    await shareService.incrementViewCount(req.params.shareId);
    res.json({ success: true, data });
  } catch (error: any) {
    const status = error.message === 'SHARE_NOT_FOUND' ? 404 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

router.get('/:shareId/kb/documents', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;

    const data = await contentService.getKnowledgeBaseDocuments(req.params.shareId, page, pageSize);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:shareId/doc', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const data = await contentService.getDocument(req.params.shareId);
    await shareService.incrementViewCount(req.params.shareId);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:shareId/doc/chunks', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 25;

    const data = await contentService.getDocumentChunks(req.params.shareId, page, pageSize);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:shareId/doc/download', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const downloadInfo = await contentService.getDownloadInfo(req.params.shareId);

    res.setHeader('Content-Type', downloadInfo.fileType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadInfo.fileName)}"`);
    res.setHeader('Content-Length', downloadInfo.fileSize);

    const fileStream = fs.createReadStream(downloadInfo.filePath);
    fileStream.pipe(res);
  } catch (error: any) {
    const status = error.message === 'FILE_NOT_FOUND' ? 404 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

export default router;
```

**Commit:**
```bash
git add backend/src/routes/share.ts
git commit -m "feat: add share routes for knowledge sharing API"
```

---

### Task 8: 扩展用户路由

**Files:**
- Modify: `backend/src/routes/users.ts`

添加用户搜索和租户用户列表 API：

```typescript
import { weknoraAuth, WeknoraAuthRequest } from '../middleware/weknoraAuth.js';

// 搜索用户
router.get('/search', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const keyword = req.query.q as string;
    const tenantOnly = req.query.tenant_only === 'true';
    const tenantId = tenantOnly ? req.weknoraAuth!.tenantId : undefined;

    if (!keyword || keyword.length < 2) {
      res.json({ success: true, data: [] });
      return;
    }

    const users = await weknoraUserService.searchUsers(keyword, tenantId);
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to search users' });
  }
});

// 获取指定租户的用户列表
router.get('/tenant/:tenantId', weknoraAuth, async (req: WeknoraAuthRequest, res: Response) => {
  try {
    const tenantId = parseInt(req.params.tenantId);
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 50;

    const result = await weknoraUserService.getTenantUsers(tenantId, page, pageSize);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get tenant users' });
  }
});
```

**Commit:**
```bash
git add backend/src/routes/users.ts
git commit -m "feat: add user search and tenant users API"
```

---

### Task 9: 注册路由

**Files:**
- Modify: `backend/src/index.ts`

添加路由注册：

```typescript
import shareRouter, { initShareRoutes } from './routes/share.js';
import { getWeknoraPool } from './services/weknoraUserService.js';
import cookieParser from 'cookie-parser';

// 添加 cookie-parser 中间件（用于链接分享密码验证）
app.use(cookieParser());

// 在数据库连接成功后初始化分享服务
const pool = getWeknoraPool();
if (pool) {
  initShareRoutes(pool);
}

// 注册路由
app.use('/api/share', shareRouter);
```

**依赖：**
```bash
pnpm add cookie-parser
pnpm add -D @types/cookie-parser
```

**Commit:**
```bash
git add backend/src/index.ts backend/package.json
git commit -m "feat: register share routes in main app"
```

---

## API 汇总

| 方法 | 路径 | 功能 | 认证 |
|-----|------|------|------|
| POST | `/api/share` | 创建分享 | Header |
| GET | `/api/share/:id` | 获取分享详情 | Header |
| PUT | `/api/share/:id` | 更新分享 | Header |
| DELETE | `/api/share/:id` | 删除分享 | Header |
| GET | `/api/share/list/my-shares` | 我创建的分享 | Header |
| GET | `/api/share/list/shared-to-me` | 分享给我的 | Header |
| GET | `/api/share/list/public` | 公开的分享 | 无 |
| GET | `/api/share/:id/targets` | 获取目标用户列表 | Header |
| POST | `/api/share/:id/targets` | 添加目标用户 | Header |
| DELETE | `/api/share/:id/targets/:userId` | 移除目标用户 | Header |
| GET | `/api/share/link/:token` | 链接分享信息 | 无 |
| POST | `/api/share/link/:token/verify` | 验证密码 | 无 |
| GET | `/api/share/link/:token/kb` | 链接-知识库详情 | Cookie |
| GET | `/api/share/link/:token/kb/documents` | 链接-文档列表 | Cookie |
| GET | `/api/share/link/:token/doc` | 链接-文档详情 | Cookie |
| GET | `/api/share/link/:token/doc/chunks` | 链接-分块内容 | Cookie |
| GET | `/api/share/link/:token/doc/download` | 链接-下载文档 | Cookie |
| GET | `/api/share/:shareId/kb` | 知识库详情 | Header |
| GET | `/api/share/:shareId/kb/documents` | 文档列表 | Header |
| GET | `/api/share/:shareId/doc` | 文档详情 | Header |
| GET | `/api/share/:shareId/doc/chunks` | 分块内容 | Header |
| GET | `/api/share/:shareId/doc/download` | 下载文档 | Header |
| GET | `/api/users/search?q=xxx` | 搜索用户 | Header |
| GET | `/api/users/tenant/:tenantId` | 租户用户列表 | Header |
| GET | `/api/share/check/:type/:targetId` | 检查分享状态 | Header |

---

## 环境变量

复用现有 WeKnora 数据库配置，新增：

```env
# weknora-ui 前端地址（用于生成分享链接）
WEKNORA_UI_URL=http://localhost:3000

# JWT 密钥（用于 Cookie 签名，需与 WeKnora 一致）
JWT_SECRET=your-jwt-secret
```

---

## 测试清单

- [ ] 数据库迁移脚本执行成功
- [ ] 创建分享 API 正常（携带 X-User-ID, X-Tenant-ID Header）
- [ ] 分享列表 API（my-shares, shared-to-me, public）正常
- [ ] 分享目标用户管理 API（获取/添加/移除）正常
- [ ] 通过 email 添加目标用户正常（先查找用户再添加）
- [ ] 链接分享（无密码）正常访问
- [ ] 链接分享（有密码）验证流程正常
- [ ] 内容获取 API（kb, documents, doc, chunks, download）正常
- [ ] 用户搜索 API 正常
- [ ] 下载文档功能正常
- [ ] 缺少认证 Header 时返回 401
- [ ] 访问日志正确记录到 share_access_logs 表

---

## 审查修订记录

### 2026-02-05 审查修订（第三轮）

12. **删除重复的 `findUserByEmail` 方法**：Task 4 的 shareService 代码中私有 `findUserByEmail` 与公开方法重复，已删除私有版本，内部调用统一使用公开方法

### 2026-02-05 审查修订（第二轮）

8. **修复路由定义顺序**：确保固定路径路由（`/list/*`, `/link/*`, `/check/*`）在参数路由（`/:id`）之前定义，避免路由匹配冲突
9. **修复目标用户添加逻辑**：当传入 email 时，先查找用户再添加，而非直接将 email 当作 userId
10. **添加访问日志记录方法**：在 `shareService` 中添加 `logAccess()` 方法，用于记录访问日志到 `share_access_logs` 表
11. **导出 `findUserByEmail` 方法**：将私有方法改为公开，供路由层在添加目标用户时使用

### 2026-02-05 审查修订（第一轮）

1. **添加认证机制说明**：明确使用 API Key + Header（X-User-ID, X-Tenant-ID, X-Username）认证方式
2. **新增 Task 3**：创建 `weknoraAuth` 中间件，从 Header 提取用户信息
3. **修改路由代码**：将 `req.body._auth` 改为 `req.weknoraAuth`
4. **补充缺失的 API**：
   - `GET /api/share/:id/targets` - 获取分享目标用户列表
   - `POST /api/share/:id/targets` - 添加分享目标用户
   - `DELETE /api/share/:id/targets/:userId` - 移除分享目标用户
   - `GET /api/share/link/:token/doc/download` - 链接分享下载
   - `GET /api/share/:shareId/doc/download` - 认证分享下载
5. **添加 `idx_shares_deleted` 索引**：与原设计一致
6. **修改分享列表路由**：从 `/api/share/my-shares` 改为 `/api/share/list/my-shares`，避免与 `/:id` 冲突
7. **添加 cookie-parser 依赖**：用于链接分享密码验证
