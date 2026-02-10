# 知识库多级文档分类设计方案

## 概述

将知识库详情页左侧的文档分类从 1 级扁平结构改为多级树形结构。通过在 AgentStudio 后端新增分类管理 API 实现，不修改 weknora 后端代码。

## 涉及项目

| 项目 | 路径 | 说明 |
|---|---|---|
| **AgentStudio** | `D:\workspace\agentstudio` | 后端 API 开发（Node.js + Express + TypeScript） |
| **weknora-ui** | `D:\workspace\weknora-ui` | 前端改造（Vue 3 + TDesign Vue Next） |
| **WeKnora DB** | PostgreSQL（通过 `WEKNORA_DB_*` 环境变量连接） | 数据库 schema 变更 |

## 需求决策

| 决策点 | 结论 |
|---|---|
| 使用场景 | 管理端（KB owner）+ 分享只读端 |
| 层级深度 | DB 不限制，UI 建议 ≤ 3-4 级 |
| 删除策略 | 用户选择：提升子分类（promote） / 级联删除（cascade） |
| 鉴权方式 | 管理 API 仅做 JWT 登录认证（详见 §7 鉴权设计）；只读 API 复用现有 share 鉴权 |
| 文档归属 | 单 tag_id，点击分类只显示该分类直接关联的文档 |
| 排序移动 | 拖拽排序 + 拖拽移动层级 |

## 1. 数据库变更

对 WeKnora 数据库的 `knowledge_tags` 表加一列，不新建表，不改现有字段。

迁移脚本位置：`AgentStudio/docs/sql/002_add_tag_parent_id.sql`

```sql
-- docs/sql/002_add_tag_parent_id.sql

ALTER TABLE knowledge_tags
  ADD COLUMN parent_id VARCHAR(36) REFERENCES knowledge_tags(id) ON DELETE SET NULL;

CREATE INDEX idx_knowledge_tags_parent ON knowledge_tags(parent_id);
```

- `parent_id` 可空，NULL 表示根分类
- `ON DELETE SET NULL`：DB 层面删除父分类时，子分类自动变为根级
- 向后兼容：已有 tag 的 `parent_id` 默认 NULL，weknora 后端查询不 SELECT 此字段，无影响

## 2. API 路由设计

### 2.1 管理 API — `/api/kb/:kbId/...`

面向 KB owner，JWT 登录用户直接管理自己知识库的分类。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/kb/:kbId/tag-tree` | 获取树形分类 |
| POST | `/api/kb/:kbId/tags` | 创建分类 |
| PUT | `/api/kb/:kbId/tags/:tagId` | 更新分类（改名、改色、移动层级） |
| DELETE | `/api/kb/:kbId/tags/:tagId?strategy=promote\|cascade` | 删除分类 |
| PUT | `/api/kb/:kbId/tag-reorder` | 批量更新排序（拖拽后） |
| PUT | `/api/kb/:kbId/documents/:docId/tag` | 变更文档所属分类 |

> 注意：`tag-reorder` 使用独立路径，避免与 `/tags/:tagId` 路由冲突。

鉴权：`authMiddleware`（JWT 认证）+ `requireTagService`（服务可用性）。kbId 来源于 weknora-ui 已经过 WeKnora 后端用户权限过滤的知识库列表，无需 AgentStudio 侧再做 KB owner 验证。

### 2.2 只读 API — Share 路由（扩展）

面向分享访问者，复用现有 share 鉴权体系。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/share/:shareId/kb/tag-tree` | 树形分类（只读） |

原有 `GET /api/share/:shareId/kb/tags` 保留兼容。

### 2.3 公开链接 API — ShareLink 路由（扩展）

面向无登录的链接访问者，cookie 验证。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/share/link/:token/kb/tag-tree` | 树形分类（只读） |

## 3. 类型定义

文件：`AgentStudio/backend/src/types/tag.ts`

```typescript
export interface TagItem {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
  parent_id: string | null;
  knowledge_count: number;
}

export interface TagTreeNode extends TagItem {
  children: TagTreeNode[];
}

export interface CreateTagRequest {
  name: string;
  parent_id?: string;
  color?: string;
  sort_order?: number;
}

export interface UpdateTagRequest {
  name?: string;
  parent_id?: string | null;  // null = 移到根级, undefined = 不变
  color?: string;
  sort_order?: number;
}

export interface ReorderRequest {
  items: Array<{ id: string; parent_id: string | null; sort_order: number }>;
}

export type DeleteStrategy = 'promote' | 'cascade';
```

## 4. Service 层设计

新增 `TagService`（`AgentStudio/backend/src/services/tagService.ts`），纯数据操作层，不含 HTTP/鉴权逻辑。

### 核心方法

| 方法 | 说明 |
|---|---|
| `getTagsByKbId(kbId)` | 查出 KB 下所有 tag（含 parent_id、knowledge_count），返回扁平列表 |
| `buildTagTree(tags)` | 内存构建树形结构（Map 索引父子关系） |
| `createTag(kbId, data)` | 创建分类，校验同父级下不重名、parent_id 属于同 KB |
| `updateTag(tagId, kbId, data)` | 更新分类，含循环引用检测 |
| `deleteTag(tagId, kbId, strategy)` | 删除分类，事务执行 |
| `reorderTags(kbId, items)` | 批量更新 sort_order 和 parent_id |
| `updateDocumentTag(docId, kbId, tagId)` | 变更文档分类 |
| `getDescendantIds(tree, tagId)` | 获取 tag 及其所有子孙 ID（cascade 删除用） |

### 关键逻辑

**树形构建（内存）：**
- 一次 SQL 查出 KB 下所有 tag
- 用 `Map<id, TagTreeNode>` 索引，遍历一次建立父子关系
- 单个 KB 分类通常 < 100 个，内存构建比 SQL CTE 更简单

**删除策略：**
- `promote`：子分类的 `parent_id` 更新为被删 tag 的 `parent_id`，被删 tag 关联的文档 `tag_id` 置 NULL
- `cascade`：递归收集所有子孙 tag ID，批量删除，关联文档 `tag_id` 置 NULL
- 均在数据库事务中执行

**循环引用检测：**
- `updateTag` 设置 `parent_id` 时，从目标 parent 向上遍历祖先链
- 如果祖先链包含当前 tagId，则拒绝操作，返回 `CIRCULAR_REFERENCE`

**文档列表显示：**
- 点击任意分类节点，直接传单个 `tag_id` 给 WeKnora 文档列表 API，只显示该分类直接关联的文档
- 不做子分类文档聚合，逻辑清晰，分页正常
- 文档列表 API 始终走 WeKnora API，写操作不受影响

## 5. 接口响应格式

### GET tag-tree

```json
{
  "items": [
    {
      "id": "tag-1",
      "name": "技术文档",
      "color": "#4A90D9",
      "sort_order": 0,
      "parent_id": null,
      "knowledge_count": 5,
      "children": [
        {
          "id": "tag-2",
          "name": "前端",
          "color": "#50C878",
          "sort_order": 0,
          "parent_id": "tag-1",
          "knowledge_count": 3,
          "children": []
        }
      ]
    }
  ],
  "total": 12
}
```

- `knowledge_count` 只统计当前分类直接关联的文档数（不含子分类）
- 前端按需递归求和得出"含子分类的总文档数"

### POST / PUT tags

返回创建/更新后的 tag 对象：

```json
{ "id": "uuid", "name": "前端", "parent_id": "tag-1", "color": "#50C878", "sort_order": 0 }
```

### DELETE tags

204 No Content

### PUT tag-reorder

```json
{ "updated": 5 }
```

### PUT documents/:docId/tag

```json
{ "docId": "doc-1", "tagId": "tag-2" }
```

## 6. 错误码

| HTTP 状态 | 错误码 | 场景 |
|---|---|---|
| 400 | `TAG_NAME_REQUIRED` | 创建/更新时 name 为空 |
| 400 | `TAG_NAME_DUPLICATE` | 同一父级下同名分类 |
| 400 | `CIRCULAR_REFERENCE` | 移动时检测到循环引用 |
| 400 | `INVALID_STRATEGY` | 删除 strategy 参数无效 |
| 400 | `PARENT_NOT_IN_KB` | parent_id 指向的 tag 不属于该 KB |
| 404 | `TAG_NOT_FOUND` | tagId 不存在或不属于该 KB |
| 404 | `DOC_NOT_FOUND` | docId 不存在或不属于该 KB |

## 7. 鉴权设计

### 三个入口复用 TagService

```
/api/kb/:kbId/tags             → authMiddleware → requireTagService → TagService     (管理)
/api/share/:shareId/kb/tag-tree → authMiddleware → validateShareAccess → ShareContentService → TagService  (只读)
/api/share/link/:token/kb/tag-tree → validateLinkCookie → ShareContentService → TagService  (只读)
```

### 管理 API 鉴权说明

管理 API（`/api/kb/:kbId/...`）不需要 AgentStudio 侧的 KB owner 验证中间件。

**实际鉴权链路：**

```
1. 用户在 weknora-ui 登录 → WeKnora 后端签发 JWT，包含用户身份
2. "我的"页面调用 WeKnora API → WeKnora 后端根据 JWT 过滤，仅返回当前用户的知识库列表
3. 用户点击某个 KB 卡片进入详情 → kbId 来源已经是经过权限过滤的
4. 详情页调用 AgentStudio API → authMiddleware 验证 AgentStudio JWT（确认已认证）
```

**关键点：** kbId 不是用户随意构造的，而是从 WeKnora 后端鉴权后返回的知识库列表中获取的。AgentStudio 的 JWT 仅包含 `{ authenticated: true }`，不含 userId，架构上无法做用户级归属校验。因此管理 API 只需两层保障：

- `authMiddleware`：确保请求方是已登录的合法用户
- `requireTagService`：确保 WeKnora 数据库连接可用

## 8. 文件结构

> 以下路径相对于各自项目根目录。AgentStudio = `D:\workspace\agentstudio`

### AgentStudio 新增文件

```
backend/src/types/tag.ts                    # Tag 类型定义
backend/src/services/tagService.ts          # Tag CRUD + 树形构建
backend/src/routes/kb.ts                    # /api/kb 管理路由
docs/sql/002_add_tag_parent_id.sql          # 数据库迁移脚本
```

### AgentStudio 修改文件

```
backend/src/index.ts                        # 注册 /api/kb 路由
backend/src/services/shareContentService.ts # 新增 getTagTree 方法，复用 TagService
backend/src/routes/share.ts                 # 新增 GET /:shareId/kb/tag-tree
backend/src/routes/shareLink.ts             # 新增 GET /:token/kb/tag-tree
```

## 9. AgentStudio 后端实现顺序

> 项目路径：`D:\workspace\agentstudio`

| 步骤 | 内容 | 文件 |
|---|---|---|
| 1 | DB 迁移：加 `parent_id` 列 + 索引 | `docs/sql/002_add_tag_parent_id.sql` |
| 2 | 类型定义 | `backend/src/types/tag.ts` |
| 3 | TagService：CRUD + 树形构建 + 循环检测 | `backend/src/services/tagService.ts` |
| 4 | KB 管理路由 | `backend/src/routes/kb.ts` |
| 5 | 注册路由 | `backend/src/index.ts` |
| 6 | ShareContentService 新增 getTagTree | `backend/src/services/shareContentService.ts` |
| 7 | Share/ShareLink 路由新增 tag-tree 端点 | `backend/src/routes/share.ts`, `backend/src/routes/shareLink.ts` |
| 8 | 单元测试 | `backend/src/__tests__/tagService.test.ts` |

## 10. 前端改造设计

> 项目路径：`D:\workspace\weknora-ui`

技术栈：Vue 3 + TDesign Vue Next (1.17.2) + Pinia

### 10.1 组件改造：用 `<t-tree>` 替换扁平列表

**替换范围：** `D:\workspace\weknora-ui\src\views\knowledge\KnowledgeBase.vue` 中 `.tag-list` 区域（约第 1039-1181 行）。

**保留不变：** sidebar-header（标题 + 创建按钮）、tag-search-bar（搜索栏）、`.tag-sidebar` 容器样式。

**`<t-tree>` 配置：**

| Prop | 值 | 说明 |
|---|---|---|
| `data` | 树形数据 | 后端返回树 + 前端插入"全部文档"/"未分类"虚拟节点 |
| `draggable` | `true` | 启用拖拽 |
| `activable` | `true` | 点击选中高亮 |
| `expandOnClickNode` | `false` | 点击节点不展开，只有箭头展开 |
| `hover` | `true` | hover 状态 |
| `keys` | `{ value: 'id', label: 'name', children: 'children' }` | 字段映射 |
| `filter` | 搜索过滤函数 | 对接现有 `tagSearchQuery` |
| `allowDrop` | 校验函数 | 禁止拖到虚拟节点下、限制深度 ≤ 4 级 |
| `line` | `true` | 显示层级连接线 |

**关键事件：**
- `@drop`：拖拽完成后，提取所有节点的 `{ id, parent_id, sort_order }` 调用 `PUT /api/kb/:kbId/tag-reorder`
- `@active`：节点选中后触发文档过滤（替代现有 `handleTagFilterChange`）

**自定义渲染：**
- `operations` 插槽：渲染右侧文档数量 badge + 更多操作菜单（编辑/删除/新建子分类）
- 虚拟节点（"全部文档"/"未分类"）设置 `draggable: false`，不渲染操作按钮

**去掉分页：** 改为一次加载全部 tag 构建树（单个 KB 分类通常 < 100 个）。移除 `tagHasMore`、`tagLoadingMore` 相关逻辑。

### 10.2 API 层改造

**新增文件：** `D:\workspace\weknora-ui\src\api\agentstudio\tag.ts`

```typescript
getTagTree(kbId: string): Promise<{ items: TagTreeNode[], total: number }>
createTag(kbId: string, data: CreateTagRequest): Promise<TagItem>
updateTag(kbId: string, tagId: string, data: UpdateTagRequest): Promise<TagItem>
deleteTag(kbId: string, tagId: string, strategy: DeleteStrategy): Promise<void>
reorderTags(kbId: string, items: ReorderItem[]): Promise<{ updated: number }>
updateDocumentTag(kbId: string, docId: string, tagId: string | null): Promise<void>
```

**API 调用替换：**

| 原调用（weknora 后端） | 替换为（AgentStudio 后端） |
|---|---|
| `listKnowledgeTags(kbId)` | `getTagTree(kbId)` |
| `createKnowledgeBaseTag(kbId, data)` | `createTag(kbId, { ...data, parent_id })` |
| `updateKnowledgeBaseTag(kbId, tagId, data)` | `updateTag(kbId, tagId, data)` |
| `deleteKnowledgeBaseTag(kbId, tagId)` | `deleteTag(kbId, tagId, strategy)` |
| `updateKnowledgeTagBatch(data)` | `updateDocumentTag(kbId, docId, tagId)` |

**JWT 认证：** 复用 weknora-ui 现有的 axios 拦截器，在请求头带上 `Authorization: Bearer <token>`。需确认 weknora-ui 的登录 token 与 AgentStudio JWT 是否兼容，不兼容则需要 token 交换。

### 10.3 交互设计

**创建分类：**
- 顶部 `+` 按钮：创建根级分类（`parent_id` 为 null）
- 每个分类右键菜单增加"新建子分类"选项：在该节点下插入内联输入框，创建时自动带 `parent_id`

**拖拽排序 & 移动层级：**
- 利用 TDesign Tree 原生拖拽事件 `@drop`，返回 `{ dragNode, dropNode, dropPosition }`
  - `dropPosition = 0`：放入 dropNode 内部（作为子级）
  - `dropPosition = -1`：放在 dropNode 前面（同级）
  - `dropPosition = 1`：放在 dropNode 后面（同级）
- 拖拽结束后提交整棵树的排序状态到后端
- `allowDrop` 做深度校验：拖拽子树最大深度 + 目标位置深度 > 4 时禁止放置

**删除分类：**
- 无子分类：简单确认后直接删除
- 有子分类：弹出 TDesign `<t-dialog>`，提供两个选项：
  - "将子分类提升到上一级"（`strategy=promote`）
  - "删除所有子分类"（`strategy=cascade`）
  - 显示受影响的文档数量提示

**文档列表过滤：**
- 点击任意分类：`loadKnowledgeFiles` 传单个 `tag_id` 给 WeKnora API，只显示该分类直接关联的文档，与现有行为一致
- "全部文档" / "未分类" 逻辑保持不变
- 上传文档、导入网页、在线编辑等写操作不受影响

**文档分类选择器：**
- 文档卡片上的分类下拉从扁平 `<t-select>` 改为 `<t-tree-select>`，展示树形分类

### 10.4 前端文件变更清单

**新增文件：**

| 文件 | 说明 |
|---|---|
| `src/api/agentstudio/tag.ts` | AgentStudio tag CRUD API 调用 |
| `src/types/tag.ts` | `TagTreeNode`、`CreateTagRequest` 等前端类型 |

**修改文件：**

| 文件 | 改动 |
|---|---|
| `src/views/knowledge/KnowledgeBase.vue` | 左侧栏改用 `<t-tree>`，API 切换，删除弹窗，创建子分类，文档分类选择器改 `<t-tree-select>` |
| `src/api/knowledge-base/index.ts` | tag 相关函数标记为 deprecated（保留但不再使用） |

**不改的文件：**
- 路由、store — 无需改动

### 10.5 SharedKnowledgeBase.vue 分享只读页改造

分享只读页的分类侧栏同样从扁平列表改为树形展示，但不含任何管理操作。

**当前实现（`D:\workspace\weknora-ui\src\views\share\SharedKnowledgeBase.vue`）：**
- 调用 `getSharedKBTags(shareId, userId)` → `GET /api/share/${shareId}/kb/tags` 获取扁平 tag 列表
- 左侧栏 `.tag-list` 用 `v-for` 渲染扁平列表（全部文档 + 未分类 + 真实分类）
- 文档过滤：前端 `filteredDocuments` computed 按 `selectedTagId` 过滤
- 仅当 `tagList.length > 0` 时才显示侧栏

**改造方案：**

**API 替换：**

| 原调用 | 替换为 |
|---|---|
| `getSharedKBTags(shareId, userId)` | `getSharedTagTree(shareId, userId)` → `GET /api/share/${shareId}/kb/tag-tree` |

新增函数放在 `D:\workspace\weknora-ui\src\api\share\index.ts` 中（因为仍是 share 路由，不走 AgentStudio 管理 API）。

**组件替换：** 用 `<t-tree>` 替换 `.tag-list` 区域（约第 47-86 行），配置为只读模式。

**`<t-tree>` 配置（只读版）：**

| Prop | 值 | 说明 |
|---|---|---|
| `data` | 树形数据 | 后端返回树 + 前端插入"全部文档"/"未分类"虚拟节点 |
| `draggable` | `false` | 只读，禁止拖拽 |
| `activable` | `true` | 点击选中高亮，用于过滤文档 |
| `expandOnClickNode` | `false` | 点击节点只选中，不展开 |
| `hover` | `true` | hover 状态 |
| `keys` | `{ value: 'id', label: 'name', children: 'children' }` | 字段映射 |
| `filter` | 搜索过滤函数 | 对接现有 `tagSearchKeyword` |
| `line` | `true` | 显示层级连接线 |

**自定义渲染：**
- `operations` 插槽：仅渲染文档数量 badge，不渲染操作菜单
- 虚拟节点使用特定图标（view-list / folder）

**文档过滤：**

点击分类只显示该分类直接关联的文档。现有 `filteredDocuments` computed 的 `tag_id === selectedTagId` 逻辑保持不变，无需修改。

**侧栏可见性：** 保持 `v-if="tagList.length > 0"` 逻辑不变，改为判断树形数据是否有真实节点。

### 10.6 weknora-ui 前端文件变更清单（完整）

> 项目路径：`D:\workspace\weknora-ui`

**新增文件：**

| 文件 | 说明 |
|---|---|
| `src/api/agentstudio/tag.ts` | AgentStudio tag 管理 CRUD API 调用 |
| `src/types/tag.ts` | `TagTreeNode`、`CreateTagRequest` 等前端类型 |

**修改文件：**

| 文件 | 改动 |
|---|---|
| `src/views/knowledge/KnowledgeBase.vue` | 左侧栏改用 `<t-tree>`（可拖拽），API 切换到 AgentStudio，删除弹窗，创建子分类，文档分类选择器改 `<t-tree-select>` |
| `src/views/share/SharedKnowledgeBase.vue` | 左侧栏改用 `<t-tree>`（只读），API 切换到 tag-tree 端点，文档过滤改为树形聚合 |
| `src/api/share/index.ts` | 新增 `getSharedTagTree(shareId, userId)` 函数 |
| `src/api/knowledge-base/index.ts` | tag 相关函数标记为 deprecated |

**不改的文件：**
- `LinkAccess.vue`（`D:\workspace\weknora-ui\src\views\share\LinkAccess.vue`）— 公开链接页无分类功能
- 路由（`D:\workspace\weknora-ui\src\router\index.ts`）、store — 无需改动

## 11. 完整实现顺序

| 步骤 | 内容 | 项目 | 文件（相对项目根） |
|---|---|---|---|
| 1 | DB 迁移：加 `parent_id` 列 + 索引 | AgentStudio | `docs/sql/002_add_tag_parent_id.sql` |
| 2 | 类型定义 | AgentStudio | `backend/src/types/tag.ts` |
| 3 | TagService：CRUD + 树形构建 + 循环检测 | AgentStudio | `backend/src/services/tagService.ts` |
| 4 | KB 管理路由 | AgentStudio | `backend/src/routes/kb.ts` |
| 5 | 注册路由 | AgentStudio | `backend/src/index.ts` |
| 6 | ShareContentService 新增 getTagTree | AgentStudio | `backend/src/services/shareContentService.ts` |
| 7 | Share/ShareLink 路由新增 tag-tree 端点 | AgentStudio | `backend/src/routes/share.ts`, `backend/src/routes/shareLink.ts` |
| 8 | 后端单元测试 | AgentStudio | `backend/src/__tests__/tagService.test.ts` |
| 9 | 前端类型定义 + API 模块 | weknora-ui | `src/types/tag.ts`, `src/api/agentstudio/tag.ts` |
| 10 | KnowledgeBase.vue 管理端改造 | weknora-ui | `src/views/knowledge/KnowledgeBase.vue` |
| 11 | SharedKnowledgeBase.vue 只读端改造 | weknora-ui | `src/views/share/SharedKnowledgeBase.vue`, `src/api/share/index.ts` |

## 12. 不在本次范围

- weknora 后端代码改动（不需要）
- 现有扁平 `GET /tags` 接口（保留兼容，不修改）
- `LinkAccess.vue`（`D:\workspace\weknora-ui\src\views\share\LinkAccess.vue`）— 公开链接页（当前无分类功能，不涉及）
