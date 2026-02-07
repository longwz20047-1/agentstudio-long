# 知识库分享 API 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 AgentStudio 后端实现知识库分享功能的 API，供 weknora-ui 前端调用

**前端设计文档:** [weknora-ui 知识库分享功能设计](d:/workspace/weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md)

**Architecture:**
- 复用 AgentStudio 现有的 WeKnora PostgreSQL 数据库连接
- 分享元数据存储在 WeKnora 数据库的新建扩展表中
- 内容查询直接读取 WeKnora 现有表（knowledge_bases, knowledges, chunks, users）

**Tech Stack:** TypeScript (Node.js), Express, PostgreSQL (pg 库)

**前置条件:**
- AgentStudio 已配置 WeKnora 数据库连接（WEKNORA_DB_* 环境变量）
- WeKnora 数据库可访问

---

## 已验证的参考实现

本计划复用以下已实现并验证通过的模式：

| 参考 | 文件路径 | 复用内容 |
|------|---------|---------|
| **项目用户选择计划** | `docs/plans/2026-02-03-project-user-selection.md` | 整体架构模式：JWT 认证 + 查询参数传递用户标识 |
| **WeKnora 用户服务** | `backend/src/services/weknoraUserService.ts` | 数据库连接池创建（`:31-49`）、优雅降级模式（`:14-21`）、缓存策略（`:58-60`） |
| **用户路由** | `backend/src/routes/users.ts` | 路由结构模式（`:6`）、服务可用性检查（`:9-16`）、错误处理格式（`:27-30`） |
| **JWT 认证中间件** | `backend/src/middleware/auth.ts` | `authMiddleware` 验证 JWT Token |
| **路由注册** | `backend/src/index.ts:478` | `app.use('/api/users', authMiddleware, usersRouter)` 注册模式 |
| **前端调用** | `frontend/src/lib/authFetch.ts` | `authFetch` 自动携带 JWT Token 调用后端 API |
| **CORS 配置** | `backend/src/index.ts:263` | `allowedHeaders` 当前仅允许标准 Header |
| **用户标识传递** | `backend/src/routes/projects.ts:43` | `req.query.userId` 查询参数模式（已验证可用） |
| **用户类型定义** | `backend/src/types/users.ts` | `WeKnoraUser` 接口定义 |
| **A2A 认证中间件** | `backend/src/middleware/a2aAuth.ts` | 扩展 Request 接口的模式（`:18-26`），可参考但本计划不使用自定义中间件 |

---

## 前端功能支撑

本 API 支撑以下前端功能（详见前端设计文档）：

| API 分类 | 支撑的前端功能 | 前端文档章节 |
|---------|--------------|-------------|
| **分享管理** | 分享弹窗创建/编辑/删除分享 | [4.3 分享弹窗](d:/workspace/weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#43-分享弹窗) |
| **分享列表** | 知识库列表页标签切换（我的/分享给我的/公开的） | [4.1 知识库列表页扩展](d:/workspace/weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#41-知识库列表页扩展) |
| **目标用户管理** | 分享弹窗中的用户选择器 | [5.1 新增组件 - UserSelector](d:/workspace/weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#51-新增组件) |
| **链接分享** | 链接分享访问页（密码验证、内容展示） | [4.5 链接分享访问页](d:/workspace/weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#45-链接分享访问页) |
| **内容获取** | 分享预览页（知识库/文档详情展示） | [4.6 分享预览页详细设计](d:/workspace/weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#46-分享预览页详细设计) |
| **用户搜索** | 分享弹窗中搜索用户 | [5.1 新增组件 - UserSelector](d:/workspace/weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#51-新增组件) |
| **我的分享管理** | 我的分享管理页面 | [4.4 我的分享管理页面](d:/workspace/weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md#44-我的分享管理页面) |

---

## 认证机制

> **复用参考：** 与 `2026-02-03-project-user-selection.md` 完全一致的认证方式

> [!WARNING] **已知局限（#F）— 认证架构矛盾，当前阶段接受此风险**
>
> **问题：** AgentStudio 的 JWT Token 不包含 WeKnora 用户信息（`user_id`/`tenant_id`），而 weknora-ui 前端设计文档（6.3节）中 WeKnora 的 JWT 直接包含这些字段。当前方案通过查询参数/请求体传递 `userId`/`tenantId`，理论上已认证用户可伪造其他人的用户标识。
>
> **影响范围：** 所有通过 `getUserId(req)` 获取用户标识的路由（创建分享、我的分享列表、分享给我的列表、检查分享状态）。
>
> **当前决策：** 暂不处理。此风险在 AgentStudio 内部网络环境下可接受（JWT 已保证请求者是合法的 AgentStudio 用户）。后续如需加强，可选方案：
> 1. 引入验证 WeKnora JWT 的中间件，从 Token 中直接解码用户身份
> 2. 在 AgentStudio JWT 中嵌入 WeKnora 用户信息
> 3. 增加 userId 与 AgentStudio 会话用户的绑定校验
>
> **审查说明：** 此问题已评估并决定暂不修复，后续审查无需重复标记。

### 认证方式

weknora-ui 调用 AgentStudio 分享 API 时，复用现有 **JWT Token + 查询参数/请求体** 认证方式：

- **JWT 认证**：复用 `authMiddleware`（见 `backend/src/middleware/auth.ts`），与现有 `/api/users` 路由一致
- **用户标识**：通过查询参数（GET）或请求体（POST/PUT）传递 `userId` 和 `tenantId`
- **前端调用**：复用 `authFetch`（见 `frontend/src/lib/authFetch.ts`），自动携带 JWT Token

```typescript
// weknora-ui 调用示例 —— 复用 authFetch 模式
// 参考: frontend/src/components/ProjectUserSelector.tsx:623-629 (已验证可用)

// GET 请求 - 用户标识通过查询参数传递
const response = await authFetch(
  `${API_BASE}/api/share/list/my-shares?userId=${userId}&tenantId=${tenantId}&page=1`
);

// POST 请求 - 用户标识通过请求体传递
const response = await authFetch(`${API_BASE}/api/share`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId,           // WeKnora 用户 ID
    tenantId,         // WeKnora 租户 ID
    username,         // 用户名（可选，用于冗余存储）
    shareType: 'knowledge_base',
    targetId: kbId,
    shareMode: 'public',
  })
});
```

### 与旧方案的对比（不再使用自定义 Header）

| 维度 | 旧方案（已废弃） | 新方案（复用现有模式） |
|------|----------------|---------------------|
| JWT 认证 | 无，需自建 `weknoraAuth` 中间件 | 复用 `authMiddleware`（`backend/src/middleware/auth.ts`） |
| 用户标识 | `X-User-ID` / `X-Tenant-ID` 自定义 Header | 查询参数 / 请求体字段 |
| CORS 影响 | 需修改 `allowedHeaders`（`index.ts:263`） | **无需修改** |
| 前端调用 | 需自定义 fetch 手动设 Header | 复用 `authFetch`（自动带 JWT） |

### 路由认证分组

```
受保护路由（authMiddleware）：分享管理、列表、目标用户管理、内容获取
  → 参考: backend/src/index.ts:478 — app.use('/api/users', authMiddleware, usersRouter)

公开路由（无 authMiddleware）：链接分享信息获取、密码验证
  → 参考: backend/src/index.ts:376 — app.use('/api/auth', authRouter)

Cookie 保护路由：链接分享密码验证后的内容获取
  → 本计划新增模式，无现有参考
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

- 分享管理 API：`/api/share`（受保护，`authMiddleware`）
- 链接分享公开 API：`/api/share/link`（公开，无认证）
- 用户搜索 API：扩展现有 `/api/users`（已受 `authMiddleware` 保护）

### 1. 分享管理 API（需 JWT 认证）

| 方法 | 路径 | 功能 | 用户标识来源 |
|-----|------|------|-------------|
| POST | `/api/share` | 创建分享 | 请求体 `userId` / `tenantId` |
| GET | `/api/share/:id` | 获取分享详情 | — |
| PUT | `/api/share/:id` | 更新分享设置 | — |
| DELETE | `/api/share/:id` | 删除分享（软删除） | — |

### 2. 分享列表 API（需 JWT 认证）

| 方法 | 路径 | 功能 | 用户标识来源 |
|-----|------|------|-------------|
| GET | `/api/share/list/my-shares?userId=xxx` | 我创建的分享 | 查询参数 `userId` |
| GET | `/api/share/list/shared-to-me?userId=xxx` | 分享给我的 | 查询参数 `userId` |
| GET | `/api/share/list/public` | 公开的内容 | — |

### 3. 分享目标用户 API（需 JWT 认证）

| 方法 | 路径 | 功能 | 用户标识来源 |
|-----|------|------|-------------|
| GET | `/api/share/:id/targets` | 获取分享目标用户列表 | — |
| POST | `/api/share/:id/targets` | 添加分享目标用户 | — |
| DELETE | `/api/share/:id/targets/:targetUserId` | 移除分享目标用户 | — |

### 4. 链接分享 API（公开，无需 JWT）

| 方法 | 路径 | 功能 | 认证 |
|-----|------|------|------|
| GET | `/api/share/link/:token` | 获取分享基本信息 | 无 |
| POST | `/api/share/link/:token/verify` | 验证链接密码 | 无 |
| GET | `/api/share/link/:token/kb` | 获取知识库详情 | Cookie |
| GET | `/api/share/link/:token/kb/documents` | 获取文档列表 | Cookie |
| GET | `/api/share/link/:token/doc` | 获取文档详情 | Cookie |
| GET | `/api/share/link/:token/doc/chunks` | 获取分块内容 | Cookie |
| GET | `/api/share/link/:token/doc/download` | 下载文档 | Cookie |
| GET | `/api/share/link/:token/search?q=xxx` | 内容搜索 | Cookie |

### 5. 内容获取 API（需 JWT 认证）

| 方法 | 路径 | 功能 |
|-----|------|------|
| GET | `/api/share/:shareId/kb` | 获取分享的知识库详情 |
| GET | `/api/share/:shareId/kb/documents` | 获取知识库的文档列表 |
| GET | `/api/share/:shareId/doc` | 获取分享的文档详情 |
| GET | `/api/share/:shareId/doc/chunks` | 获取文档分块内容 |
| GET | `/api/share/:shareId/doc/download` | 下载文档文件 |
| GET | `/api/share/:shareId/search?q=xxx` | 在分享内容中搜索（全文匹配 chunks） |

### 6. 用户搜索 API（扩展现有，已受 JWT 保护）

> **参考：** 扩展 `backend/src/routes/users.ts`，该路由已注册在 `authMiddleware` 保护下（`index.ts:478`）

| 方法 | 路径 | 功能 |
|-----|------|------|
| GET | `/api/users/search?q=xxx&tenantId=1` | 搜索用户（用户名/邮箱） |
| GET | `/api/users/tenant/:tenantId` | 获取指定租户的用户列表 |

### 7. 辅助 API（需 JWT 认证）

| 方法 | 路径 | 功能 | 用户标识来源 |
|-----|------|------|-------------|
| GET | `/api/share/check/:type/:targetId?userId=xxx` | 检查资源是否已被分享 | 查询参数 `userId` |

---

## 请求/响应结构

### 创建分享

```typescript
// POST /api/share
interface CreateShareRequest {
  userId: string;              // 分享创建者 WeKnora 用户 ID
  tenantId: number;            // 分享创建者租户 ID
  username?: string;           // 用户名（可选，冗余存储）
  shareType: 'knowledge_base' | 'knowledge';
  targetId: string;
  shareMode: 'public' | 'user' | 'link';
  permissions?: 'read';        // 当前阶段仅支持 read
  expiresAt?: string;          // ISO8601
  linkPassword?: string;       // 仅 link 模式
  targetUsers?: Array<{        // 仅 user 模式
    userId?: string;
    username?: string;    // 可选，与前端设计文档对齐
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
// GET /api/share/list/my-shares?userId=xxx&page=1&page_size=20
// GET /api/share/list/shared-to-me?userId=xxx&page=1&page_size=20
// GET /api/share/list/public?page=1&page_size=20
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

### 内容搜索

```typescript
// GET /api/share/:shareId/search?q=xxx&page=1&page_size=20
interface SearchResponse {
  success: boolean;
  data: {
    items: Array<{
      chunkId: string;
      content: string;           // 匹配的分块内容
      chunkIndex: number;
      documentId: string;
      documentTitle: string;
      highlight: string;         // 包含关键词的摘要片段
    }>;
    total: number;
    page: number;
    pageSize: number;
    keyword: string;
  };
}
```

### 用户搜索

```typescript
// GET /api/users/search?q=xxx&tenantId=1
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

> **参考：** 遵循 `backend/src/types/users.ts` 的类型定义风格

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
  userId: string;             // 分享创建者（从请求体获取，非 Header）
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
    username?: string;    // 可选，与前端设计文档对齐
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
- Create: `docs/sql/001_create_share_tables.sql`

> **注意：** 项目中不存在 `backend/src/db/` 目录且无自动迁移机制。SQL 脚本放在 `docs/sql/` 下作为参考，需手动在 WeKnora 数据库执行。

将上面「数据库设计」部分的三张表 SQL（shares, share_targets, share_access_logs）及所有索引写入文件。

**Commit:**
```bash
git add docs/sql/001_create_share_tables.sql
git commit -m "feat: add share tables migration script"
```

---

### Task 3: 暴露 WeKnora 数据库连接池

> **旧方案已废弃：** 不再创建 `weknoraAuth` 中间件。改为在 `weknoraUserService` 中暴露连接池，供 `ShareService` 复用。

**Files:**
- Modify: `backend/src/services/weknoraUserService.ts`

> **参考：** `weknoraUserService.ts:31-49` 的 `getPool()` 方法当前为 private。添加公开访问方法。

在 `WeKnoraUserService` 类中添加：

```typescript
// 在 close() 方法之后（约 :121 行之后）添加：

/**
 * 获取数据库连接池（供其他服务复用）
 *
 * 用于需要直接操作 WeKnora 数据库的服务（如 ShareService）。
 * 复用同一个连接池避免创建重复连接。
 */
getDbPool(): Pool | null {
  return this.getPool();
}
```

**Commit:**
```bash
git add backend/src/services/weknoraUserService.ts
git commit -m "feat: expose WeKnora database pool for share service"
```

---

### Task 4: 创建分享服务

**Files:**
- Create: `backend/src/services/shareService.ts`

> **参考：** 服务类构造模式参考 `weknoraUserService.ts`。使用 `Pool` 参数注入（通过 Task 3 暴露的 `getDbPool()`）。
> **依赖：** `uuid`（已在 `backend/package.json` 中）、`bcryptjs`（已在 `backend/package.json` 中）

```typescript
// backend/src/services/shareService.ts
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';
import {
  Share,
  ShareTarget,
  ShareType,
  CreateShareRequest,
  ShareItem,
} from '../types/share.js';

export class ShareService {
  constructor(private pool: Pool) {}

  /**
   * 创建分享
   */
  async createShare(
    request: CreateShareRequest
  ): Promise<{ shareId: string; shareLinkToken?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const shareId = uuidv4();
      let shareLinkToken: string | undefined;
      let linkPasswordHash: string | undefined;

      // 防重复分享：公开分享同一资源只允许一个有效的（按 share_mode 维度查重）
      if (request.shareMode === 'public') {
        const existing = await this.checkShareExists(
          request.shareType, request.targetId, request.userId, 'public'
        );
        if (existing.shared) {
          await client.query('ROLLBACK');
          return { shareId: existing.shareId! };
        }
      }

      // 生成链接 token
      if (request.shareMode === 'link') {
        shareLinkToken = uuidv4().replace(/-/g, '');
      }

      // 哈希密码（参考: bcryptjs 已在项目中使用，见 backend/package.json）
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
          request.tenantId,
          request.userId,
          request.username,
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
   * 无密码保护的分享直接返回 true（放行）
   */
  async verifyLinkPassword(token: string, password: string): Promise<boolean> {
    const share = await this.getShareByToken(token);
    if (!share) {
      return false;
    }
    // 无密码保护，直接放行
    if (!share.link_password) {
      return true;
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
      `SELECT s.*, kb.name AS target_kb_name
       FROM shares s
       LEFT JOIN knowledge_bases kb ON s.target_kb_id = kb.id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );

    return {
      items: result.rows.map((row: any) => this.mapToShareItem(row)),
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * 获取分享给我的
   */
  async getSharedToMe(
    userId: string,
    page = 1,
    pageSize = 20,
    shareType?: ShareType    // 新增：可选类型过滤
  ): Promise<{ items: ShareItem[]; total: number }> {
    const offset = (page - 1) * pageSize;

    // 动态构建查询条件（参考 getMyShares 的模式）
    let whereClause = 'st.target_user_id = $1 AND s.deleted_at IS NULL AND s.status = \'active\'';
    const countParams: any[] = [userId];
    const queryParams: any[] = [userId];

    if (shareType) {
      countParams.push(shareType);
      queryParams.push(shareType);
      whereClause += ` AND s.share_type = $${countParams.length}`;
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM share_targets st
       JOIN shares s ON st.share_id = s.id
       WHERE ${whereClause}`,
      countParams
    );

    queryParams.push(pageSize, offset);
    const result = await this.pool.query(
      `SELECT s.*, kb.name AS target_kb_name FROM share_targets st
       JOIN shares s ON st.share_id = s.id
       LEFT JOIN knowledge_bases kb ON s.target_kb_id = kb.id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
      queryParams
    );

    return {
      items: result.rows.map((row: any) => this.mapToShareItem(row)),
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * 获取公开的分享
   */
  async getPublicShares(
    page = 1,
    pageSize = 20,
    shareType?: ShareType    // 新增：可选类型过滤
  ): Promise<{ items: ShareItem[]; total: number }> {
    const offset = (page - 1) * pageSize;

    // 动态构建查询条件（参考 getMyShares 的模式）
    let whereClause = 's.share_mode = \'public\' AND s.deleted_at IS NULL AND s.status = \'active\'';
    const countParams: any[] = [];
    const queryParams: any[] = [];

    if (shareType) {
      countParams.push(shareType);
      queryParams.push(shareType);
      whereClause += ` AND s.share_type = $${countParams.length}`;
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM shares s
       WHERE ${whereClause}`,
      countParams
    );

    queryParams.push(pageSize, offset);
    const result = await this.pool.query(
      `SELECT s.*, kb.name AS target_kb_name FROM shares s
       LEFT JOIN knowledge_bases kb ON s.target_kb_id = kb.id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
      queryParams
    );

    return {
      items: result.rows.map((row: any) => this.mapToShareItem(row)),
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * 更新分享
   * 注意：模式切换时会自动清理关联数据（share_targets / link token）
   */
  async updateShare(
    shareId: string,
    updates: {
      status?: string;
      expiresAt?: string;
      shareMode?: string;
      linkPassword?: string;  // 新密码（明文，会被哈希）
    }
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

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
      if (updates.shareMode) {
        setClauses.push(`share_mode = $${paramIndex++}`);
        params.push(updates.shareMode);
        // 切换到 link 模式时自动生成 token
        if (updates.shareMode === 'link') {
          setClauses.push(`share_link_token = $${paramIndex++}`);
          params.push(uuidv4().replace(/-/g, ''));
        }
        // 切换离开 link 模式时清除 token 和密码
        if (updates.shareMode !== 'link') {
          setClauses.push(`share_link_token = NULL`);
          setClauses.push(`link_password = NULL`);
        }
      }
      if (updates.linkPassword !== undefined) {
        if (updates.linkPassword) {
          const hash = await bcrypt.hash(updates.linkPassword, 10);
          setClauses.push(`link_password = $${paramIndex++}`);
          params.push(hash);
        } else {
          setClauses.push(`link_password = NULL`);
        }
      }

      params.push(shareId);

      await client.query(
        `UPDATE shares SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
        params
      );

      // 模式切换副作用：切换离开 user 模式时清理目标用户
      if (updates.shareMode && updates.shareMode !== 'user') {
        await client.query(
          `DELETE FROM share_targets WHERE share_id = $1`,
          [shareId]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

  async getShareTargets(shareId: string): Promise<ShareTarget[]> {
    const result = await this.pool.query(
      `SELECT * FROM share_targets WHERE share_id = $1 ORDER BY created_at`,
      [shareId]
    );
    return result.rows;
  }

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

  async removeShareTarget(shareId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM share_targets WHERE share_id = $1 AND target_user_id = $2`,
      [shareId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async checkShareExists(
    shareType: ShareType,
    targetId: string,
    ownerUserId: string,
    shareMode?: string
  ): Promise<{ shared: boolean; shareId?: string }> {
    let query = `SELECT id FROM shares
       WHERE share_type = $1 AND target_id = $2 AND owner_user_id = $3
         AND deleted_at IS NULL AND status = 'active'`;
    const params: any[] = [shareType, targetId, ownerUserId];

    if (shareMode) {
      query += ' AND share_mode = $4';
      params.push(shareMode);
    }

    query += ' LIMIT 1';

    const result = await this.pool.query(query, params);

    if (result.rows.length > 0) {
      return { shared: true, shareId: result.rows[0].id };
    }
    return { shared: false };
  }

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

  private mapToShareItem(row: any): ShareItem {
    return {
      shareId: row.id,
      shareType: row.share_type,
      targetId: row.target_id,
      targetName: row.target_name || '',
      targetKbId: row.target_kb_id,
      targetKbName: row.target_kb_name || undefined,
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

> **说明：** 此服务负责通过 shareId 查询 WeKnora 现有表（knowledge_bases, knowledges, chunks）的内容。
> 每个方法首先通过 ShareService 获取分享记录的 `target_id`，再查询对应的 WeKnora 表。

```typescript
// backend/src/services/shareContentService.ts
import { Pool } from 'pg';
import { ShareService } from './shareService.js';

export class ShareContentService {
  constructor(
    private pool: Pool,
    private shareService: ShareService
  ) {}

  /**
   * 获取分享的知识库详情
   */
  async getKnowledgeBase(shareId: string) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    // 确定知识库 ID：知识库分享直接用 target_id，文档分享用 target_kb_id
    const kbId = share.share_type === 'knowledge_base'
      ? share.target_id
      : share.target_kb_id;

    if (!kbId) throw new Error('KB_NOT_FOUND');

    const result = await this.pool.query(
      `SELECT id, name, type, description, created_at, updated_at
       FROM knowledge_bases WHERE id = $1 AND deleted_at IS NULL`,
      [kbId]
    );

    if (result.rows.length === 0) throw new Error('KB_NOT_FOUND');

    const kb = result.rows[0];

    // 获取文档计数
    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM knowledges WHERE knowledge_base_id = $1 AND deleted_at IS NULL`,
      [kbId]
    );

    return {
      id: kb.id,
      name: kb.name,
      type: kb.type,
      description: kb.description,
      documentCount: parseInt(countResult.rows[0].count),
      createdAt: kb.created_at?.toISOString(),
      updatedAt: kb.updated_at?.toISOString(),
    };
  }

  /**
   * 获取知识库的文档列表
   */
  async getKnowledgeBaseDocuments(shareId: string, page = 1, pageSize = 20) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    const kbId = share.share_type === 'knowledge_base'
      ? share.target_id
      : share.target_kb_id;

    if (!kbId) throw new Error('KB_NOT_FOUND');

    const offset = (page - 1) * pageSize;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM knowledges WHERE knowledge_base_id = $1 AND deleted_at IS NULL`,
      [kbId]
    );

    const result = await this.pool.query(
      `SELECT id, title, file_name, file_type, file_size, parse_status, created_at
       FROM knowledges
       WHERE knowledge_base_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [kbId, pageSize, offset]
    );

    return {
      items: result.rows.map((row: any) => ({
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
   * @param docId 可选，知识库分享模式下指定文档ID
   */
  async getDocument(shareId: string, docId?: string) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    let targetDocId: string | null;

    if (share.share_type === 'knowledge') {
      // 文档分享：直接用 target_id
      targetDocId = share.target_id;
    } else if (share.share_type === 'knowledge_base' && docId) {
      // 知识库分享 + 指定文档ID：验证文档属于该知识库
      const check = await this.pool.query(
        `SELECT id FROM knowledges WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL`,
        [docId, share.target_id]
      );
      if (check.rows.length === 0) throw new Error('DOC_NOT_FOUND');
      targetDocId = docId;
    } else {
      throw new Error('DOC_NOT_FOUND');
    }

    const result = await this.pool.query(
      `SELECT k.id, k.title, k.description, k.file_name, k.file_type, k.file_size,
              k.content, k.knowledge_base_id, k.created_at, k.updated_at,
              kb.name as kb_name
       FROM knowledges k
       LEFT JOIN knowledge_bases kb ON k.knowledge_base_id = kb.id
       WHERE k.id = $1 AND k.deleted_at IS NULL`,
      [targetDocId]
    );

    if (result.rows.length === 0) throw new Error('DOC_NOT_FOUND');

    const doc = result.rows[0];
    return {
      id: doc.id,
      title: doc.title,
      description: doc.description,
      fileName: doc.file_name,
      fileType: doc.file_type,
      fileSize: doc.file_size,
      content: doc.content,
      kbId: doc.knowledge_base_id,
      kbName: doc.kb_name,
      createdAt: doc.created_at?.toISOString(),
      updatedAt: doc.updated_at?.toISOString(),
    };
  }

  /**
   * 获取文档分块内容
   * @param docId 可选，知识库分享模式下指定文档ID
   */
  async getDocumentChunks(shareId: string, page = 1, pageSize = 25, docId?: string) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    let targetDocId: string | null;

    if (share.share_type === 'knowledge') {
      targetDocId = share.target_id;
    } else if (share.share_type === 'knowledge_base' && docId) {
      // 验证文档属于该知识库
      const check = await this.pool.query(
        `SELECT id FROM knowledges WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL`,
        [docId, share.target_id]
      );
      if (check.rows.length === 0) throw new Error('DOC_NOT_FOUND');
      targetDocId = docId;
    } else {
      throw new Error('DOC_NOT_FOUND');
    }

    const offset = (page - 1) * pageSize;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM chunks WHERE knowledge_id = $1 AND deleted_at IS NULL`,
      [targetDocId]
    );

    const result = await this.pool.query(
      `SELECT id, content, chunk_index, chunk_type, metadata
       FROM chunks
       WHERE knowledge_id = $1 AND deleted_at IS NULL
       ORDER BY chunk_index
       LIMIT $2 OFFSET $3`,
      [targetDocId, pageSize, offset]
    );

    return {
      items: result.rows.map((row: any) => ({
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
   * 获取文档下载信息
   * @param docId 可选，知识库分享模式下指定文档ID
   */
  async getDownloadInfo(shareId: string, docId?: string) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    let targetDocId: string | null;

    if (share.share_type === 'knowledge') {
      targetDocId = share.target_id;
    } else if (share.share_type === 'knowledge_base' && docId) {
      const check = await this.pool.query(
        `SELECT id FROM knowledges WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL`,
        [docId, share.target_id]
      );
      if (check.rows.length === 0) throw new Error('DOC_NOT_FOUND');
      targetDocId = docId;
    } else {
      throw new Error('DOC_NOT_FOUND');
    }

    const result = await this.pool.query(
      `SELECT file_name, file_type, file_size, file_path
       FROM knowledges WHERE id = $1 AND deleted_at IS NULL`,
      [targetDocId]
    );

    if (result.rows.length === 0) throw new Error('DOC_NOT_FOUND');

    const doc = result.rows[0];
    if (!doc.file_path) throw new Error('FILE_NOT_FOUND');

    // 路径安全校验：确保文件路径在允许的目录范围内
    const allowedBase = process.env.WEKNORA_FILES_DIR;
    if (allowedBase) {
      const resolved = require('path').resolve(doc.file_path);
      if (!resolved.startsWith(require('path').resolve(allowedBase))) {
        throw new Error('FILE_NOT_FOUND');
      }
    }

    return {
      fileName: doc.file_name,
      fileType: doc.file_type,
      fileSize: doc.file_size,
      filePath: doc.file_path,
    };
  }

  /**
   * 在分享内容中搜索（全文匹配 chunks）
   * - 知识库分享：搜索该知识库下所有文档的 chunks
   * - 文档分享：搜索该文档的 chunks
   */
  async searchContent(
    shareId: string,
    keyword: string,
    page = 1,
    pageSize = 20
  ) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    const offset = (page - 1) * pageSize;
    let countQuery: string;
    let dataQuery: string;
    let params: any[];

    if (share.share_type === 'knowledge_base') {
      // 知识库分享：搜索该 KB 下所有文档的 chunks
      // 转义 ILIKE 特殊字符（%, _, \）防止用户输入干扰查询
      const escapedKeyword = keyword.replace(/[%_\\]/g, '\\$&');
      const likePattern = `%${escapedKeyword}%`;

      countQuery = `
        SELECT COUNT(*) FROM chunks c
        JOIN knowledges k ON c.knowledge_id = k.id
        WHERE k.knowledge_base_id = $1
          AND c.deleted_at IS NULL AND k.deleted_at IS NULL
          AND c.content ILIKE $2
      `;
      dataQuery = `
        SELECT c.id, c.content, c.chunk_index,
               k.id AS document_id, k.title AS document_title
        FROM chunks c
        JOIN knowledges k ON c.knowledge_id = k.id
        WHERE k.knowledge_base_id = $1
          AND c.deleted_at IS NULL AND k.deleted_at IS NULL
          AND c.content ILIKE $2
        ORDER BY k.title, c.chunk_index
        LIMIT $3 OFFSET $4
      `;
      params = [share.target_id, likePattern, pageSize, offset];
    } else {
      // 文档分享：搜索该文档的 chunks
      const escapedKeyword = keyword.replace(/[%_\\]/g, '\\$&');
      const likePattern = `%${escapedKeyword}%`;

      countQuery = `
        SELECT COUNT(*) FROM chunks c
        JOIN knowledges k ON c.knowledge_id = k.id
        WHERE c.knowledge_id = $1
          AND c.deleted_at IS NULL
          AND c.content ILIKE $2
      `;
      dataQuery = `
        SELECT c.id, c.content, c.chunk_index,
               k.id AS document_id, k.title AS document_title
        FROM chunks c
        JOIN knowledges k ON c.knowledge_id = k.id
        WHERE c.knowledge_id = $1
          AND c.deleted_at IS NULL
          AND c.content ILIKE $2
        ORDER BY c.chunk_index
        LIMIT $3 OFFSET $4
      `;
      params = [share.target_id, likePattern, pageSize, offset];
    }

    const countResult = await this.pool.query(
      countQuery,
      [params[0], params[1]]
    );

    const result = await this.pool.query(dataQuery, params);

    return {
      items: result.rows.map((row: any) => {
        // 生成包含关键词的摘要片段（前后各取 80 字符）
        const content: string = row.content || '';
        const idx = content.toLowerCase().indexOf(keyword.toLowerCase());
        const start = Math.max(0, idx - 80);
        const end = Math.min(content.length, idx + keyword.length + 80);
        const highlight = (start > 0 ? '...' : '')
          + content.slice(start, end)
          + (end < content.length ? '...' : '');

        return {
          chunkId: row.id,
          content: row.content,
          chunkIndex: row.chunk_index,
          documentId: row.document_id,
          documentTitle: row.document_title,
          highlight,
        };
      }),
      total: parseInt(countResult.rows[0].count),
      page,
      pageSize,
      keyword,
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

> **参考：** 新增方法遵循现有 `listUsers()` 的模式（`:51-83`）：检查 `_isAvailable` → 获取 Pool → try/catch 优雅降级

在 `WeKnoraUserService` 类中添加 `searchUsers` 和 `getTenantUsers` 方法。代码与原计划 Task 6 一致，但**移除 tenantOnly/weknoraAuth 相关逻辑**，tenantId 直接从查询参数获取。

```typescript
/**
 * 搜索用户（按用户名或邮箱模糊匹配）
 * 参考: listUsers() 的优雅降级模式 (weknoraUserService.ts:51-83)
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
    const params: any[] = [`%${keyword.replace(/[%_\\]/g, '\\$&')}%`];  // 转义 ILIKE 特殊字符，与 searchContent 保持一致

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

**Commit:**
```bash
git add backend/src/services/weknoraUserService.ts
git commit -m "feat: add user search methods to weknoraUserService"
```

---

### Task 7: 创建分享路由

> **重大变更：** 不再使用 `weknoraAuth` 中间件。用户标识从查询参数/请求体获取。
> **参考：** 路由结构复用 `backend/src/routes/users.ts` 的模式

**Files:**
- Create: `backend/src/routes/share.ts`

```typescript
// backend/src/routes/share.ts
// 参考: backend/src/routes/users.ts 的路由结构模式

import express from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { ShareService } from '../services/shareService.js';
import { ShareContentService } from '../services/shareContentService.js';
import { weknoraUserService } from '../services/weknoraUserService.js';

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

// ========== 辅助函数 ==========

/**
 * 服务可用性检查中间件（审查修订 #R6）
 * 参考: backend/src/routes/users.ts:9-16 — 服务不可用时返回 503
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
 * 参考: backend/src/routes/projects.ts:43 — req.query.userId 模式
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
 * 用于 PUT/DELETE/:id 和目标用户管理路由
 *
 * > [!WARNING] 安全风险（#F 的直接后果）
 * > userId 来自查询参数/请求体，理论上可被已认证用户伪造。
 * > 此处是 #F 认证架构矛盾的最高风险点——伪造 userId=ownerUserId 即可绕过所有权检查。
 * > 后续加强认证时此处应优先修复。
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
// 参考: GET /api/projects?userId=xxx (projects.ts:43)
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

    const result = await shareService.checkShareExists(type as any, targetId, userId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== 链接分享（公开路由，单独注册，不经过 authMiddleware） ==========
// 注意：这些路由在 index.ts 中注册为公开路由

// 获取链接分享信息（无需认证）
router.get('/link/:token', async (req: express.Request, res: express.Response) => {
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
router.post('/link/:token/verify', async (req: express.Request, res: express.Response) => {
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

  // 将 share 挂载到 req 上，后续路由直接使用，不再重复查询
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

  // 使用常量时间比较防止 timing attack（审查修订 #R5）
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

// 链接分享 - 知识库详情（share 已由 validateLinkCookie 挂载到 req 上）
router.get('/link/:token/kb', validateLinkCookie, async (req: express.Request, res: express.Response) => {
  try {
    const share = (req as any).share;
    const data = await contentService.getKnowledgeBase(share.id);
    await shareService.incrementViewCount(share.id);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 链接分享 - 文档列表
router.get('/link/:token/kb/documents', validateLinkCookie, async (req: express.Request, res: express.Response) => {
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
router.get('/link/:token/doc', validateLinkCookie, async (req: express.Request, res: express.Response) => {
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
router.get('/link/:token/doc/chunks', validateLinkCookie, async (req: express.Request, res: express.Response) => {
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
router.get('/link/:token/doc/download', validateLinkCookie, async (req: express.Request, res: express.Response) => {
  try {
    const share = (req as any).share;
    const docId = req.query.docId as string | undefined;
    const downloadInfo = await contentService.getDownloadInfo(share.id, docId);

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

// 链接分享 - 内容搜索
router.get('/link/:token/search', validateLinkCookie, async (req: express.Request, res: express.Response) => {
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
    res.json({ success: true, data: share });
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

> **参考：** 在现有路由文件（`backend/src/routes/users.ts`）末尾添加搜索和租户用户 API。
> 该路由已受 `authMiddleware` 保护（`index.ts:478`），无需额外认证。
> tenantId 从查询参数获取，不使用自定义 Header。

在 `export default router;` 之前添加：

```typescript
// 搜索用户
// 参考: GET /api/users 的模式 (users.ts:19-31)
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

**重要：** `/search` 和 `/tenant/:tenantId` 路由必须放在现有 `GET /` 路由之后（避免被 `/` 匹配），但放在 `/project/:projectId` 之前（因为 `/search` 和 `/tenant/xxx` 不会与 `/project/xxx` 冲突）。

**Commit:**
```bash
git add backend/src/routes/users.ts
git commit -m "feat: add user search and tenant users API"
```

---

### Task 9: 拆分链接分享路由 + 注册路由 + 安装依赖

**Files:**
- Create: `backend/src/routes/shareLink.ts`（从 `share.ts` 中拆出 `/link/*` 公开路由）
- Modify: `backend/src/routes/share.ts`（移除 `/link/*` 路由和 `validateLinkCookie` 中间件）
- Modify: `backend/src/index.ts`

> **参考：** 路由注册模式完全复用现有代码
> - 受保护路由：`app.use('/api/users', authMiddleware, usersRouter)` (`index.ts:478`)
> - 公开路由：`app.use('/api/auth', authRouter)` (`index.ts:376`)

**Step 1: 安装 cookie-parser 依赖 + 迁移 uuid 到 dependencies**

```bash
cd backend && pnpm add cookie-parser && pnpm add -D @types/cookie-parser
```

> **必须（审查修订 #R4，已验证）：** `uuid` 当前在 devDependencies 中，但 `shareService.ts` 运行时依赖。
> 已验证构建流程：`"build": "tsc"`（编译到 `dist/`）+ `"start": "node dist/index.js"`（Node 直接运行，非 bundle）。
> 生产部署 `pnpm install --prod` 不会安装 devDependencies，因此运行时将找不到 uuid，**必须执行迁移**：
> ```bash
> cd backend && pnpm add uuid
> ```
> 此命令会将 uuid 从 devDependencies 移到 dependencies。`@types/uuid` 保留在 devDependencies 即可（仅编译时需要）。

**Step 2: 创建 `backend/src/routes/shareLink.ts`**

将 Task 7 中 `share.ts` 里的以下内容拆分到独立文件：
- `validateLinkCookie` 中间件
- `GET /link/:token`（获取链接分享信息）
- `POST /link/:token/verify`（验证密码）
- `GET /link/:token/kb`、`/link/:token/kb/documents`、`/link/:token/doc`、`/link/:token/doc/chunks`、`/link/:token/doc/download`

```typescript
// backend/src/routes/shareLink.ts
// 链接分享公开路由（无需 JWT 认证）
import express from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { ShareService } from '../services/shareService.js';
import { ShareContentService } from '../services/shareContentService.js';

const router: express.Router = express.Router();

let shareService: ShareService;
let contentService: ShareContentService;

export function initShareLinkRoutes(ss: ShareService, cs: ShareContentService) {
  shareService = ss;
  contentService = cs;
}

// validateLinkCookie 和所有 /link/* 路由从 share.ts 移到此处
// 路由前缀在 index.ts 中注册为 /api/share/link，因此路由定义中使用 /:token 而非 /link/:token

export default router;
```

**Step 3: 修改 `share.ts`**

从 `share.ts` 中删除所有 `/link/*` 路由和 `validateLinkCookie` 函数。保留分享管理、列表、目标用户、内容获取路由。

导出服务实例供 `shareLink.ts` 使用：
```typescript
export function getShareServices() {
  return { shareService, contentService };
}
```

**Step 4: 修改 index.ts**

在 `backend/src/index.ts` 中添加：

```typescript
// === 顶部导入区域（约 :38 行附近，其他 import 之后） ===
import shareRouter, { initShareRoutes, getShareServices } from './routes/share';
import shareLinkRouter, { initShareLinkRoutes } from './routes/shareLink';
import cookieParser from 'cookie-parser';

// === 中间件区域（约 :274 行，express.urlencoded 之后） ===
// cookie-parser 中间件（用于链接分享密码验证 Cookie）
app.use(cookieParser());

// === 背景服务初始化区域（约 :340 行附近） ===
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
// > **注意（审查修订 #R6）：** 如果 WeKnora 数据库启动时不可用，服务将无法初始化。
// > share.ts 中的路由已添加服务可用性检查（类似 users.ts:9-16 的模式），
// > 在 shareService 未初始化时返回 503 Service Unavailable。

// === 公开路由区域（约 :376 行，app.use('/api/auth') 附近） ===
// 链接分享公开路由（无需 JWT 认证）
// 注意：必须在 authMiddleware 保护的 /api/share 之前注册
app.use('/api/share/link', shareLinkRouter);

// === 受保护路由区域（约 :478 行，app.use('/api/users') 附近） ===
// 分享管理路由（需 JWT 认证）
app.use('/api/share', authMiddleware, shareRouter);
```

**Commit:**
```bash
git add backend/src/routes/shareLink.ts backend/src/routes/share.ts backend/src/index.ts backend/package.json pnpm-lock.yaml
git commit -m "feat: register share routes with link routes as public"
```

---

## API 汇总

| 方法 | 路径 | 功能 | 认证 | 用户标识 |
|-----|------|------|------|---------|
| POST | `/api/share` | 创建分享 | JWT | 请求体 |
| GET | `/api/share/:id` | 获取分享详情 | JWT | — |
| PUT | `/api/share/:id` | 更新分享 | JWT | — |
| DELETE | `/api/share/:id` | 删除分享 | JWT | — |
| GET | `/api/share/list/my-shares` | 我创建的分享 | JWT | `?userId=` |
| GET | `/api/share/list/shared-to-me` | 分享给我的 | JWT | `?userId=` |
| GET | `/api/share/list/public` | 公开的分享 | JWT | — |
| GET | `/api/share/:id/targets` | 获取目标用户列表 | JWT | — |
| POST | `/api/share/:id/targets` | 添加目标用户 | JWT | — |
| DELETE | `/api/share/:id/targets/:targetUserId` | 移除目标用户 | JWT | — |
| GET | `/api/share/check/:type/:targetId` | 检查分享状态 | JWT | `?userId=` |
| GET | `/api/share/link/:token` | 链接分享信息 | 无 | — |
| POST | `/api/share/link/:token/verify` | 验证密码 | 无 | — |
| GET | `/api/share/link/:token/kb` | 链接-知识库详情 | Cookie | — |
| GET | `/api/share/link/:token/kb/documents` | 链接-文档列表 | Cookie | — |
| GET | `/api/share/link/:token/doc` | 链接-文档详情 | Cookie | `?docId=` |
| GET | `/api/share/link/:token/doc/chunks` | 链接-分块内容 | Cookie | `?docId=` |
| GET | `/api/share/link/:token/doc/download` | 链接-下载文档 | Cookie | `?docId=` |
| GET | `/api/share/link/:token/search?q=xxx` | 链接-内容搜索 | Cookie | — |
| GET | `/api/share/:shareId/kb` | 知识库详情 | JWT | — |
| GET | `/api/share/:shareId/kb/documents` | 文档列表 | JWT | — |
| GET | `/api/share/:shareId/doc` | 文档详情 | JWT | `?docId=` |
| GET | `/api/share/:shareId/doc/chunks` | 分块内容 | JWT | `?docId=` |
| GET | `/api/share/:shareId/doc/download` | 下载文档 | JWT | `?docId=` |
| GET | `/api/share/:shareId/search?q=xxx` | 内容搜索 | JWT | — |
| GET | `/api/users/search?q=xxx` | 搜索用户 | JWT | `?tenantId=` |
| GET | `/api/users/tenant/:tenantId` | 租户用户列表 | JWT | — |

---

## 环境变量

复用现有 WeKnora 数据库配置（`WEKNORA_DB_*`，见 `backend/.env`），新增：

```env
# weknora-ui 前端地址（用于生成分享链接）
WEKNORA_UI_URL=http://localhost:3000

# JWT 密钥（已有，用于 Cookie 签名）
# JWT_SECRET 应已配置，见 backend/src/utils/jwt.ts

# 文件存储根目录（用于下载路径安全校验，可选）
# 配置后下载功能会校验文件路径必须在此目录下，防止路径遍历攻击
WEKNORA_FILES_DIR=/data/weknora/files
```

> **跨域 Cookie 注意事项：** 链接分享的密码验证使用 `sameSite: 'lax'` Cookie。
> 如果 weknora-ui 和 AgentStudio 部署在不同域名下，需将 `sameSite` 改为 `'none'`（同时需 `secure: true` 即 HTTPS）。
> 同域部署时 `lax` 即可。

---

## 测试清单

- [ ] 数据库迁移脚本在 WeKnora 数据库执行成功
- [ ] 创建分享 API 正常（请求体携带 userId/tenantId）
- [ ] 创建分享输入验证（shareType/shareMode 枚举、linkPassword 长度）
- [ ] 公开分享防重复（同模式同资源去重，不同模式允许共存）
- [ ] 分享列表 API（my-shares, shared-to-me, public）正常，userId 通过查询参数传递
- [ ] 分享目标用户管理 API（获取/添加/移除）正常
- [ ] 通过 email 添加目标用户正常（先查找用户再添加）
- [ ] 链接分享（无密码）正常访问（无需 JWT）
- [ ] 链接分享（有密码）验证流程正常（Cookie 机制）
- [ ] 内容获取 API（kb, documents, doc, chunks, download）正常
- [ ] 知识库分享模式下通过 `?docId=xxx` 获取单文档详情/分块/下载
- [ ] 知识库分享模式下 `?docId=xxx` 验证文档归属（传不属于该 KB 的 docId 应返回 404）
- [ ] 更新分享模式切换副作用（user→public 清理 share_targets，link→public 清理 token）
- [ ] 用户搜索 API 正常（tenantId 通过查询参数传递）
- [ ] 搜索 ILIKE 通配符不被用户输入干扰（输入 `%` `_` 不产生异常结果）
- [ ] 下载文档功能正常（含路径安全校验）
- [ ] 无 JWT Token 时受保护路由返回 401（验证 `authMiddleware` 生效）
- [ ] 链接分享公开路由不需要 JWT Token
- [ ] 分页参数同时支持 `page_size` 和 `pageSize`
- [ ] 访问日志正常记录（view/download 操作写入 share_access_logs）
- [ ] `authFetch` 调用分享 API 正常（验证与现有 API 调用方式一致）

---

## 审查修订记录

### 2026-02-07 审查修订（第七轮 - 前后端交叉审查）

> 对照前端设计文档 + 两个项目实际代码进行四维交叉审查。审查报告详见 `docs/plans/2026-02-07-knowledge-share-review.md`。

59. **Cookie 签名 timing attack 修复**（R5 严重）：`validateLinkCookie` 中 `signature !== expectedSignature` 字符串比较替换为 `crypto.timingSafeEqual()`，防止 timing attack
60. **删除目标用户路由参数重命名**（R8 中等）：`DELETE /:id/targets/:userId` 改为 `DELETE /:id/targets/:targetUserId`，避免与 `getUserId(req)` 返回的 owner userId 查询参数混淆
61. **用户搜索校验统一**（R7 中等）：`/search` 路由的关键词最短长度校验改为 `keyword.trim().length < 2`，与内容搜索保持一致（统一 trim + 返回空结果）
62. **uuid 依赖位置说明**（R4 严重）：Task 9 Step 1 新增说明 — `uuid` 当前在 devDependencies 中，运行时依赖需确认是否迁移到 dependencies
63. **路由服务可用性检查**（R6 中等）：share.ts 添加 `requireShareService` 中间件，数据库不可用时所有分享路由返回 503，避免服务初始化失败后请求 crash。参考 `users.ts:9-16` 模式

### 2026-02-07 审查修订（第六轮 - 严格代码审查修复）

> 对照 weknora-ui 前端设计文档、AgentStudio 现有代码、数据库表定义进行四维审查后的修复。

40. **`checkShareExists` 防重复逻辑修复**（严重）：新增 `shareMode` 参数，防重复查询加上 `AND share_mode = $4` 条件。修复前同一资源不同模式（public/user/link）的分享会被误判为"已存在"
41. **知识库分享模式支持单文档访问**（严重）：`getDocument`、`getDocumentChunks`、`getDownloadInfo` 三个方法新增可选 `docId` 参数。知识库分享模式下通过 `?docId=xxx` 指定文档，并验证文档归属于该知识库。修复前知识库分享无法获取具体文档内容
42. **ILIKE 搜索通配符转义**（严重）：`searchContent` 中对用户输入的 keyword 进行 `%`、`_`、`\` 字符转义（`keyword.replace(/[%_\\]/g, '\\$&')`），防止用户输入干扰 SQL LIKE 模式
43. **`verifyOwnership` 安全风险醒目标注**（建议）：添加 `[!WARNING]` 注释，明确标注此处是 #F 认证架构问题的最高风险点
44. **`updateShare` 模式切换副作用处理**（建议）：改用事务执行。切换离开 `link` 模式时清除 `share_link_token` 和 `link_password`；切换离开 `user` 模式时删除 `share_targets` 记录
45. **`verifyLinkPassword` 语义修正**（建议）：无密码保护的分享返回 `true`（放行），而非 `false`
46. **文件下载路径安全校验**（建议）：`getDownloadInfo` 新增 `WEKNORA_FILES_DIR` 环境变量路径白名单校验，防止路径遍历攻击
47. **创建分享输入参数验证**（建议）：路由层新增 `shareType` 枚举、`targetId` 必填、`shareMode` 枚举、`linkPassword` 长度（4-32 字符）校验
48. **分页参数命名统一**（低）：新增 `getPageSize()` 辅助函数，同时支持 `page_size`（snake_case）和 `pageSize`（camelCase）查询参数
49. **`logAccess()` 调用补全**（低）：内容获取路由（kb 详情、doc 详情、下载）和链接分享 doc 路由中补充 `shareService.logAccess()` 调用
50. **Cookie 跨域兼容性说明**（低）：环境变量章节新增跨域部署时 Cookie `sameSite` 配置说明
51. **链接分享路由 docId 支持**（严重）：链接分享的 `/link/:token/doc`、`/link/:token/doc/chunks`、`/link/:token/doc/download` 路由同样支持 `?docId=xxx` 参数
52. **前端 userId 传递说明**（严重）：所有需要 `verifyOwnership` 的路由（PUT/DELETE /:id、GET/POST/DELETE /:id/targets）要求前端通过查询参数或请求体传递 `userId`，否则所有权验证将始终失败。已同步更新前端设计文档 §5.2 API 模块中相关函数的签名
53. **share_type 参数命名兼容**（中等）：my-shares 路由同时支持 `share_type`（snake_case）和 `shareType`（camelCase），与 `getPageSize` 辅助函数保持一致的兼容模式。前端统一使用 snake_case
54. **getSharedToMe/getPublicShares 添加 shareType 过滤**（中等）：两个方法新增可选 `shareType` 参数，支持前端"分享给我的"和"公开的"标签下按知识库/文档筛选，与 `getMyShares` 保持一致
55. **searchUsers LIKE 通配符转义**（中等）：与 `searchContent` 方法保持一致，转义用户输入中的 `%`、`_`、`\` 字符，防止 ILIKE 模式注入
56. **targetUsers 补充 username 字段**（低）：`CreateShareRequest.targetUsers` 类型定义补充 `username?` 字段，与前端设计文档 §3.8 保持一致
57. **updateShare 代码缩进修复**（低）：修复 `updateShare` 方法体内 if 判断块的缩进不一致问题
58. **前端 API 响应解包说明**（低）：前端设计文档 §5.2 补充 AgentStudio 响应格式 `{ success, data }` 的解包方式说明

### 2026-02-06 审查修订（第五轮 - 全面交叉审查修复）

> 对照 weknora-ui 前端设计文档（`d:/workspace/weknora-ui/docs/plans/2025-02-04-knowledge-share-design.md`）进行全面交叉审查后的修复。

24. **补全 Task 5 `ShareContentService` 完整代码**（#1 严重）：原文仅写"代码与原计划一致，此处不重复"，但从未给出完整实现。已补全 `getKnowledgeBase`、`getKnowledgeBaseDocuments`、`getDocument`、`getDocumentChunks`、`getDownloadInfo` 五个方法的完整代码
25. **添加分享管理路由所有权验证**（#12 严重）：`PUT/DELETE /:id` 和 `/:id/targets` 路由添加 `verifyOwnership()` 检查，确保只有分享创建者能修改/删除分享和管理目标用户
26. **添加内容获取路由访问权限验证**（#13 严重）：`/:shareId/kb`、`/:shareId/doc` 等路由添加 `verifyAccess()` 检查，根据 share_mode 验证当前用户是否有权访问（public=所有人，user=目标用户+owner，link=仅owner通过JWT路由）
27. **对齐前端设计文档 API 路径**（#A 严重）：前端设计文档已同步更新列表路径加 `/list` 前缀
28. **对齐前端响应结构**（#B 严重）：前端设计文档的 `SharedToMeResponse` 已从分组格式更新为扁平分页格式 `{ items, total, page, pageSize }`
29. **对齐前端字段名**（#C 中等）：前端设计文档 `ShareItem.sharedAt` 已更新为 `createdAt`，新增 `status`、`viewCount`、`ownerUserId` 字段
30. **对齐前端 permissions**（#D 中等）：前端设计文档 `permissions` 从 `'read' | 'write'` 简化为 `'read'`（P0 阶段）
31. **链接分享路由拆分落实**（#5 中等）：Task 9 重写为明确的拆分方案——创建 `shareLink.ts` 独立文件，公开注册为 `app.use('/api/share/link', shareLinkRouter)`，受保护路由 `app.use('/api/share', authMiddleware, shareRouter)`
32. **`updateShare` 扩展字段**（#8 中等）：从仅支持 `status/expiresAt` 扩展为支持 `shareMode`（含自动生成 token）和 `linkPassword`（含哈希处理）
33. **防重复分享**（#J 中等）：`createShare` 添加公开分享防重复检查，同一资源同一用户的有效公开分享已存在时直接返回
34. **`mapToShareItem` 补充 `targetKbName`**（#16 低）：列表查询添加 `LEFT JOIN knowledge_bases`，`mapToShareItem` 填充 `targetKbName` 字段
35. **`searchUsers` LIMIT 参数化**（#18 低）：从字符串拼接 `LIMIT ${limit}` 改为参数化查询 `LIMIT $N`
36. **链接分享路由去重查询**（#14 低）：`validateLinkCookie` 中间件将 share 挂载到 `(req as any).share`，后续路由直接使用，不再重复查询数据库
37. **错误码结构化**（#H 低）：路由返回错误使用常量字符串（`SHARE_NOT_FOUND`、`NOT_OWNER`、`NO_PERMISSION`、`SHARE_EXPIRED`、`USER_NOT_FOUND`），与前端设计文档的 `ShareErrorCode` 枚举对齐
38. **文档路径更新**：所有相对路径 `../../../weknora-ui/...` 更新为绝对路径 `d:/workspace/weknora-ui/...`
39. **添加内容搜索 API**（#E）：`GET /api/share/:shareId/search?q=xxx` 和 `GET /api/share/link/:token/search?q=xxx`，支持在分享内容的 chunks 中全文搜索。`ShareContentService` 新增 `searchContent()` 方法，知识库分享搜索所有文档的 chunks，文档分享搜索单个文档的 chunks，返回匹配分块及高亮摘要

**暂不处理（已评估，后续审查无需重复标记）：**
- #F（认证架构矛盾）：**已在「认证机制」章节顶部以 WARNING 标注。** AgentStudio JWT 无法承载 WeKnora 用户身份，查询参数传 userId 有伪造风险。当前阶段接受此风险，待后续评估
- #I（速率限制）：前端设计文档 12.4 节列出了速率规则，但属于安全建议而非前端功能，P0/P1/P2 优先级列表均未提及。如后续有实际滥用场景再按需添加

### 2026-02-06 审查修订（第四轮 - 对齐已验证模式）

13. **废弃 `weknoraAuth` 自定义中间件**：改用现有 `authMiddleware`（JWT），与 `/api/users` 路由一致（`index.ts:478`）
14. **用户标识改用查询参数/请求体**：不再使用 `X-User-ID`/`X-Tenant-ID` 自定义 Header，改为 `?userId=xxx` 和请求体字段，与 `projects.ts:43` 的 `req.query.userId` 模式一致
15. **无需修改 CORS 配置**：移除自定义 Header 后，`index.ts:263` 的 `allowedHeaders` 无需变更
16. **暴露 WeKnora 连接池**：在 `weknoraUserService` 添加 `getDbPool()` 公开方法，ShareService 复用同一连接池
17. **路由分组注册**：链接分享公开路由与管理路由分开注册，参考现有公开/受保护路由分组模式
18. **迁移脚本位置修正**：从 `backend/src/db/migrations/` 改为 `docs/sql/`（项目无 db 目录）
19. **Cookie 签名不再回退硬编码密钥**：移除 `process.env.JWT_SECRET || 'secret'`，未配置时返回错误
20. **SharePermission 简化为 `'read'`**：当前阶段不支持 `'write'`，避免歧义
21. **`mapToShareItem` 改用箭头函数调用**：`result.rows.map((row: any) => this.mapToShareItem(row))` 避免 `this` 上下文丢失
22. **添加参考实现索引表**：文档顶部新增「已验证的参考实现」表，所有复用模式有据可查
23. **`CreateShareRequest` 加入 userId/tenantId**：用户标识从请求体获取而非 Header

### 2026-02-05 审查修订（第三轮）

12. **删除重复的 `findUserByEmail` 方法**：Task 4 的 shareService 代码中私有 `findUserByEmail` 与公开方法重复，已删除私有版本，内部调用统一使用公开方法

### 2026-02-05 审查修订（第二轮）

8. **修复路由定义顺序**：确保固定路径路由（`/list/*`, `/link/*`, `/check/*`）在参数路由（`/:id`）之前定义，避免路由匹配冲突
9. **修复目标用户添加逻辑**：当传入 email 时，先查找用户再添加，而非直接将 email 当作 userId
10. **添加访问日志记录方法**：在 `shareService` 中添加 `logAccess()` 方法，用于记录访问日志到 `share_access_logs` 表
11. **导出 `findUserByEmail` 方法**：将私有方法改为公开，供路由层在添加目标用户时使用

### 2026-02-05 审查修订（第一轮）

1. **添加认证机制说明**：明确使用 API Key + Header 认证方式（已在第四轮废弃）
2. **新增 Task 3**：创建 `weknoraAuth` 中间件（已在第四轮替换为暴露连接池）
3. **修改路由代码**：将 `req.body._auth` 改为 `req.weknoraAuth`（已在第四轮改为查询参数/请求体）
4. **补充缺失的 API**
5. **添加 `idx_shares_deleted` 索引**
6. **修改分享列表路由**：从 `/api/share/my-shares` 改为 `/api/share/list/my-shares`
7. **添加 cookie-parser 依赖**
