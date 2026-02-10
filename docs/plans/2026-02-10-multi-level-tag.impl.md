# 知识库多级文档分类 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将知识库详情页文档分类从 1 级扁平改为多级树形，通过 AgentStudio 后端 API + weknora-ui 前端改造实现。

**Architecture:** AgentStudio 后端直连 WeKnora PostgreSQL，新增 TagService 处理 `knowledge_tags` 表的树形 CRUD。管理 API 走 `/api/kb/:kbId/tags`（JWT 认证，详见 Task 8 鉴权说明），只读 API 复用现有 share 路由。weknora-ui 前端用 TDesign `<t-tree>` 组件替换扁平列表。

**Tech Stack:** Node.js + Express + TypeScript + PostgreSQL (AgentStudio 后端), Vue 3 + TDesign Vue Next (weknora-ui 前端)

**Design Doc:** `docs/plans/2026-02-10-multi-level-tag-design.md`

**Projects:**
- **AgentStudio:** `D:\workspace\agentstudio`
- **weknora-ui:** `D:\workspace\weknora-ui`

---

### Task 1: DB 迁移脚本

**Files:**
- Create: `docs/sql/002_add_tag_parent_id.sql`

**Step 1: Write migration SQL**

```sql
-- docs/sql/002_add_tag_parent_id.sql
-- 知识库多级文档分类：为 knowledge_tags 添加 parent_id 列
-- 在 WeKnora 数据库中执行

ALTER TABLE knowledge_tags
  ADD COLUMN parent_id VARCHAR(36) REFERENCES knowledge_tags(id) ON DELETE SET NULL;

CREATE INDEX idx_knowledge_tags_parent ON knowledge_tags(parent_id);
```

> **注意：** SQL 脚本需手动在 WeKnora 数据库中执行并验证，不在自动化执行范围内。

---

### Task 2: 类型定义

**Files:**
- Create: `backend/src/types/tag.ts`

**Step 1: Write types**

```typescript
// backend/src/types/tag.ts

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
  parent_id?: string | null;  // null = move to root, undefined = no change
  color?: string;
  sort_order?: number;
}

export interface ReorderRequest {
  items: Array<{ id: string; parent_id: string | null; sort_order: number }>;
}

export type DeleteStrategy = 'promote' | 'cascade';
```

**Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors (project-wide check).

---

### Task 3: TagService - buildTagTree 和 getTagsByKbId

**Files:**
- Create: `backend/src/services/tagService.ts`
- Create: `backend/src/services/__tests__/tagService.test.ts`

**Step 1: Write the failing test for buildTagTree**

```typescript
// backend/src/services/__tests__/tagService.test.ts
import { describe, it, expect } from 'vitest';
import { TagService } from '../tagService.js';
import type { TagItem } from '../../types/tag.js';

describe('TagService', () => {
  describe('buildTagTree', () => {
    it('should build a tree from flat tags', () => {
      const tags: TagItem[] = [
        { id: 'root-1', name: 'Root', color: null, sort_order: 0, parent_id: null, knowledge_count: 2 },
        { id: 'child-1', name: 'Child', color: null, sort_order: 0, parent_id: 'root-1', knowledge_count: 1 },
        { id: 'grandchild-1', name: 'Grandchild', color: null, sort_order: 0, parent_id: 'child-1', knowledge_count: 0 },
      ];

      const tree = TagService.buildTagTree(tags);

      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe('root-1');
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].id).toBe('child-1');
      expect(tree[0].children[0].children).toHaveLength(1);
      expect(tree[0].children[0].children[0].id).toBe('grandchild-1');
    });

    it('should handle multiple roots', () => {
      const tags: TagItem[] = [
        { id: 'a', name: 'A', color: null, sort_order: 0, parent_id: null, knowledge_count: 0 },
        { id: 'b', name: 'B', color: null, sort_order: 1, parent_id: null, knowledge_count: 0 },
      ];

      const tree = TagService.buildTagTree(tags);
      expect(tree).toHaveLength(2);
    });

    it('should sort by sort_order', () => {
      const tags: TagItem[] = [
        { id: 'b', name: 'B', color: null, sort_order: 2, parent_id: null, knowledge_count: 0 },
        { id: 'a', name: 'A', color: null, sort_order: 1, parent_id: null, knowledge_count: 0 },
      ];

      const tree = TagService.buildTagTree(tags);
      expect(tree[0].id).toBe('a');
      expect(tree[1].id).toBe('b');
    });

    it('should handle orphan tags as roots', () => {
      const tags: TagItem[] = [
        { id: 'orphan', name: 'Orphan', color: null, sort_order: 0, parent_id: 'deleted-parent', knowledge_count: 0 },
      ];

      const tree = TagService.buildTagTree(tags);
      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe('orphan');
    });

    it('should return empty array for empty input', () => {
      const tree = TagService.buildTagTree([]);
      expect(tree).toHaveLength(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd backend && npx vitest run src/services/__tests__/tagService.test.ts
```

Expected: FAIL - `TagService` not found.

**Step 3: Implement TagService with buildTagTree and getTagsByKbId**

```typescript
// backend/src/services/tagService.ts
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type { TagItem, TagTreeNode, CreateTagRequest, UpdateTagRequest, ReorderRequest, DeleteStrategy } from '../types/tag.js';

export class TagService {
  constructor(private pool: Pool) {}

  /**
   * 查出 KB 下所有 tag（含 parent_id、knowledge_count），返回扁平列表
   */
  async getTagsByKbId(kbId: string): Promise<TagItem[]> {
    const result = await this.pool.query(
      `SELECT t.id, t.name, t.color, t.sort_order, t.parent_id,
              COUNT(k.id) AS knowledge_count
       FROM knowledge_tags t
       LEFT JOIN knowledges k ON k.tag_id = t.id AND k.deleted_at IS NULL
       WHERE t.knowledge_base_id = $1 AND t.deleted_at IS NULL
       GROUP BY t.id, t.name, t.color, t.sort_order, t.parent_id
       ORDER BY t.sort_order ASC, t.created_at DESC`,
      [kbId]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      sort_order: row.sort_order,
      parent_id: row.parent_id,
      knowledge_count: parseInt(row.knowledge_count) || 0,
    }));
  }

  /**
   * 内存构建树形结构（纯函数，可静态调用）
   */
  static buildTagTree(tags: TagItem[]): TagTreeNode[] {
    const nodeMap = new Map<string, TagTreeNode>();
    const roots: TagTreeNode[] = [];

    // 1. 创建所有节点（带空 children）
    for (const tag of tags) {
      nodeMap.set(tag.id, { ...tag, children: [] });
    }

    // 2. 建立父子关系
    for (const tag of tags) {
      const node = nodeMap.get(tag.id)!;
      if (tag.parent_id && nodeMap.has(tag.parent_id)) {
        nodeMap.get(tag.parent_id)!.children.push(node);
      } else {
        // parent_id 为 null 或指向不存在的父级 → 作为根节点
        roots.push(node);
      }
    }

    // 3. 各层按 sort_order 排序
    const sortChildren = (nodes: TagTreeNode[]) => {
      nodes.sort((a, b) => a.sort_order - b.sort_order);
      for (const node of nodes) {
        if (node.children.length) sortChildren(node.children);
      }
    };
    sortChildren(roots);

    return roots;
  }

  /**
   * 获取 tag 及其所有子孙 ID（用于 cascade 删除）
   */
  static getDescendantIds(tree: TagTreeNode[], targetId: string): string[] {
    const ids: string[] = [];

    function collectAll(nodes: TagTreeNode[]) {
      for (const node of nodes) {
        ids.push(node.id);
        if (node.children.length) collectAll(node.children);
      }
    }

    function find(nodes: TagTreeNode[]): boolean {
      for (const node of nodes) {
        if (node.id === targetId) {
          ids.push(node.id);
          if (node.children.length) collectAll(node.children);
          return true;
        }
        if (node.children.length && find(node.children)) return true;
      }
      return false;
    }

    find(tree);
    return ids;
  }
}
```

**Step 4: Run test to verify it passes**

```bash
cd backend && npx vitest run src/services/__tests__/tagService.test.ts
```

Expected: All 5 tests PASS.

---

### Task 4: TagService - createTag

**Files:**
- Modify: `backend/src/services/tagService.ts`
- Modify: `backend/src/services/__tests__/tagService.test.ts`

**Step 1: Write failing test for createTag**

Append to test file:

```typescript
describe('createTag', () => {
  // These tests require a mock Pool - we test the validation logic
  it('should reject empty name', async () => {
    const pool = { query: vi.fn() } as any;
    const service = new TagService(pool);

    await expect(
      service.createTag('kb-1', { name: '' })
    ).rejects.toThrow('TAG_NAME_REQUIRED');
  });
});
```

Add `import { vi } from 'vitest';` to the top.

**Step 2: Run test to verify it fails**

```bash
cd backend && npx vitest run src/services/__tests__/tagService.test.ts
```

Expected: FAIL - `service.createTag is not a function`.

**Step 3: Implement createTag**

Add to `TagService`:

```typescript
  /**
   * 创建分类
   */
  async createTag(kbId: string, data: CreateTagRequest): Promise<TagItem> {
    if (!data.name || !data.name.trim()) {
      throw new Error('TAG_NAME_REQUIRED');
    }

    const name = data.name.trim();

    // 校验 parent_id 属于同一 KB
    if (data.parent_id) {
      const parentCheck = await this.pool.query(
        'SELECT id FROM knowledge_tags WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL',
        [data.parent_id, kbId]
      );
      if (parentCheck.rows.length === 0) {
        throw new Error('PARENT_NOT_IN_KB');
      }
    }

    // 校验同父级下不重名
    const dupCheck = await this.pool.query(
      `SELECT id FROM knowledge_tags
       WHERE knowledge_base_id = $1 AND name = $2 AND deleted_at IS NULL
       AND ${data.parent_id ? 'parent_id = $3' : 'parent_id IS NULL'}`,
      data.parent_id ? [kbId, name, data.parent_id] : [kbId, name]
    );
    if (dupCheck.rows.length > 0) {
      throw new Error('TAG_NAME_DUPLICATE');
    }

    const id = uuidv4();
    const sortOrder = data.sort_order ?? 0;
    const color = data.color ?? null;
    const parentId = data.parent_id ?? null;

    await this.pool.query(
      `INSERT INTO knowledge_tags (id, knowledge_base_id, name, color, sort_order, parent_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      [id, kbId, name, color, sortOrder, parentId]
    );

    return {
      id,
      name,
      color,
      sort_order: sortOrder,
      parent_id: parentId,
      knowledge_count: 0,
    };
  }
```

**Step 4: Run test to verify it passes**

```bash
cd backend && npx vitest run src/services/__tests__/tagService.test.ts
```

Expected: All tests PASS.

---

### Task 5: TagService - updateTag (含循环引用检测)

**Files:**
- Modify: `backend/src/services/tagService.ts`
- Modify: `backend/src/services/__tests__/tagService.test.ts`

**Step 1: Write failing test for cycle detection**

```typescript
describe('detectCycle', () => {
  it('should detect direct cycle', () => {
    const tags: TagItem[] = [
      { id: 'a', name: 'A', color: null, sort_order: 0, parent_id: null, knowledge_count: 0 },
      { id: 'b', name: 'B', color: null, sort_order: 0, parent_id: 'a', knowledge_count: 0 },
    ];

    // Moving 'a' under 'b' would create a cycle
    expect(TagService.wouldCreateCycle(tags, 'a', 'b')).toBe(true);
  });

  it('should detect indirect cycle', () => {
    const tags: TagItem[] = [
      { id: 'a', name: 'A', color: null, sort_order: 0, parent_id: null, knowledge_count: 0 },
      { id: 'b', name: 'B', color: null, sort_order: 0, parent_id: 'a', knowledge_count: 0 },
      { id: 'c', name: 'C', color: null, sort_order: 0, parent_id: 'b', knowledge_count: 0 },
    ];

    // Moving 'a' under 'c' would create a→b→c→a cycle
    expect(TagService.wouldCreateCycle(tags, 'a', 'c')).toBe(true);
  });

  it('should allow valid move', () => {
    const tags: TagItem[] = [
      { id: 'a', name: 'A', color: null, sort_order: 0, parent_id: null, knowledge_count: 0 },
      { id: 'b', name: 'B', color: null, sort_order: 0, parent_id: null, knowledge_count: 0 },
    ];

    expect(TagService.wouldCreateCycle(tags, 'a', 'b')).toBe(false);
  });

  it('should allow move to root', () => {
    const tags: TagItem[] = [
      { id: 'a', name: 'A', color: null, sort_order: 0, parent_id: null, knowledge_count: 0 },
      { id: 'b', name: 'B', color: null, sort_order: 0, parent_id: 'a', knowledge_count: 0 },
    ];

    expect(TagService.wouldCreateCycle(tags, 'b', null)).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd backend && npx vitest run src/services/__tests__/tagService.test.ts
```

Expected: FAIL - `TagService.wouldCreateCycle is not a function`.

**Step 3: Implement wouldCreateCycle and updateTag**

Add to `TagService`:

```typescript
  /**
   * 检测移动是否会产生循环引用
   * 从 newParentId 向上遍历祖先链，如果遇到 tagId 则说明有循环
   */
  static wouldCreateCycle(tags: TagItem[], tagId: string, newParentId: string | null): boolean {
    if (!newParentId) return false; // move to root is always safe

    const parentMap = new Map<string, string | null>();
    for (const tag of tags) {
      parentMap.set(tag.id, tag.parent_id);
    }

    let current: string | null = newParentId;
    const visited = new Set<string>();
    while (current) {
      if (current === tagId) return true; // cycle detected
      if (visited.has(current)) break; // already visited (broken chain, stop)
      visited.add(current);
      current = parentMap.get(current) ?? null;
    }
    return false;
  }

  /**
   * 更新分类（含移动层级）
   */
  async updateTag(tagId: string, kbId: string, data: UpdateTagRequest): Promise<TagItem> {
    // 验证 tag 存在
    const tagResult = await this.pool.query(
      'SELECT id, name, parent_id FROM knowledge_tags WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL',
      [tagId, kbId]
    );
    if (tagResult.rows.length === 0) throw new Error('TAG_NOT_FOUND');

    // 如果要移动层级，检测循环引用
    if (data.parent_id !== undefined) {
      if (data.parent_id !== null) {
        // 校验 parent 属于同一 KB
        const parentCheck = await this.pool.query(
          'SELECT id FROM knowledge_tags WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL',
          [data.parent_id, kbId]
        );
        if (parentCheck.rows.length === 0) throw new Error('PARENT_NOT_IN_KB');
      }

      const allTags = await this.getTagsByKbId(kbId);
      if (TagService.wouldCreateCycle(allTags, tagId, data.parent_id)) {
        throw new Error('CIRCULAR_REFERENCE');
      }
    }

    // 如果要改名，检查同父级下不重名
    const newName = data.name?.trim();
    if (newName !== undefined) {
      if (!newName) throw new Error('TAG_NAME_REQUIRED');
      const effectiveParent = data.parent_id !== undefined ? data.parent_id : tagResult.rows[0].parent_id;
      const dupCheck = await this.pool.query(
        `SELECT id FROM knowledge_tags
         WHERE knowledge_base_id = $1 AND name = $2 AND id != $3 AND deleted_at IS NULL
         AND ${effectiveParent ? 'parent_id = $4' : 'parent_id IS NULL'}`,
        effectiveParent ? [kbId, newName, tagId, effectiveParent] : [kbId, newName, tagId]
      );
      if (dupCheck.rows.length > 0) throw new Error('TAG_NAME_DUPLICATE');
    }

    // 构建 UPDATE SET 子句
    const sets: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (newName !== undefined) {
      sets.push(`name = $${paramIdx++}`);
      params.push(newName);
    }
    if (data.color !== undefined) {
      sets.push(`color = $${paramIdx++}`);
      params.push(data.color);
    }
    if (data.parent_id !== undefined) {
      sets.push(`parent_id = $${paramIdx++}`);
      params.push(data.parent_id);
    }
    if (data.sort_order !== undefined) {
      sets.push(`sort_order = $${paramIdx++}`);
      params.push(data.sort_order);
    }

    if (sets.length === 0) {
      // nothing to update, return current tag
      const currentTags = await this.getTagsByKbId(kbId);
      return currentTags.find(t => t.id === tagId)!;
    }

    sets.push(`updated_at = NOW()`);
    params.push(tagId, kbId);

    await this.pool.query(
      `UPDATE knowledge_tags SET ${sets.join(', ')} WHERE id = $${paramIdx++} AND knowledge_base_id = $${paramIdx}`,
      params
    );

    const updated = await this.getTagsByKbId(kbId);
    return updated.find(t => t.id === tagId)!;
  }
```

**Step 4: Run tests**

```bash
cd backend && npx vitest run src/services/__tests__/tagService.test.ts
```

Expected: All tests PASS.

---

### Task 6: TagService - deleteTag

**Files:**
- Modify: `backend/src/services/tagService.ts`
- Modify: `backend/src/services/__tests__/tagService.test.ts`

**Step 1: Write failing test**

```typescript
describe('deleteTag', () => {
  it('should reject invalid strategy', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'tag-1' }] }),
      connect: vi.fn(),
    } as any;
    const service = new TagService(pool);

    await expect(
      service.deleteTag('tag-1', 'kb-1', 'invalid' as any)
    ).rejects.toThrow('INVALID_STRATEGY');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd backend && npx vitest run src/services/__tests__/tagService.test.ts
```

Expected: FAIL - `service.deleteTag is not a function`.

**Step 3: Implement deleteTag**

Add to `TagService`:

```typescript
  /**
   * 删除分类
   * - promote: 子分类提升到被删 tag 的父级，关联文档 tag_id 置 NULL
   * - cascade: 递归删除所有子孙，关联文档 tag_id 置 NULL
   */
  async deleteTag(tagId: string, kbId: string, strategy: DeleteStrategy): Promise<void> {
    if (strategy !== 'promote' && strategy !== 'cascade') {
      throw new Error('INVALID_STRATEGY');
    }

    // 验证 tag 存在
    const tagResult = await this.pool.query(
      'SELECT id, parent_id FROM knowledge_tags WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL',
      [tagId, kbId]
    );
    if (tagResult.rows.length === 0) throw new Error('TAG_NOT_FOUND');

    const tag = tagResult.rows[0];
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      if (strategy === 'promote') {
        // 子分类提升到被删 tag 的父级
        await client.query(
          'UPDATE knowledge_tags SET parent_id = $1, updated_at = NOW() WHERE parent_id = $2 AND knowledge_base_id = $3',
          [tag.parent_id, tagId, kbId]
        );
        // 关联文档的 tag_id 置 NULL
        await client.query(
          'UPDATE knowledges SET tag_id = NULL WHERE tag_id = $1',
          [tagId]
        );
        // 软删除 tag
        await client.query(
          'UPDATE knowledge_tags SET deleted_at = NOW() WHERE id = $1',
          [tagId]
        );
      } else {
        // cascade: 递归收集所有子孙 ID
        const allTags = await this.getTagsByKbId(kbId);
        const tree = TagService.buildTagTree(allTags);
        const idsToDelete = TagService.getDescendantIds(tree, tagId);

        if (idsToDelete.length > 0) {
          // 关联文档的 tag_id 置 NULL
          await client.query(
            `UPDATE knowledges SET tag_id = NULL WHERE tag_id = ANY($1::varchar[])`,
            [idsToDelete]
          );
          // 软删除所有 tag
          await client.query(
            `UPDATE knowledge_tags SET deleted_at = NOW() WHERE id = ANY($1::varchar[])`,
            [idsToDelete]
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
```

**Step 4: Run tests**

```bash
cd backend && npx vitest run src/services/__tests__/tagService.test.ts
```

Expected: All tests PASS.

---

### Task 7: TagService - reorderTags 和 updateDocumentTag

**Files:**
- Modify: `backend/src/services/tagService.ts`

**Step 1: Implement reorderTags and updateDocumentTag**

Add to `TagService`:

```typescript
  /**
   * 批量更新排序（拖拽后提交整棵树的位置信息）
   */
  async reorderTags(kbId: string, items: ReorderRequest['items']): Promise<number> {
    if (!items || items.length === 0) return 0;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const item of items) {
        await client.query(
          `UPDATE knowledge_tags SET parent_id = $1, sort_order = $2, updated_at = NOW()
           WHERE id = $3 AND knowledge_base_id = $4 AND deleted_at IS NULL`,
          [item.parent_id, item.sort_order, item.id, kbId]
        );
      }

      await client.query('COMMIT');
      return items.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 变更文档所属分类
   */
  async updateDocumentTag(docId: string, kbId: string, tagId: string | null): Promise<void> {
    // 验证文档存在且属于该 KB
    const docResult = await this.pool.query(
      'SELECT id FROM knowledges WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL',
      [docId, kbId]
    );
    if (docResult.rows.length === 0) throw new Error('DOC_NOT_FOUND');

    // 如果 tagId 不为 null，验证 tag 属于该 KB
    if (tagId) {
      const tagResult = await this.pool.query(
        'SELECT id FROM knowledge_tags WHERE id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL',
        [tagId, kbId]
      );
      if (tagResult.rows.length === 0) throw new Error('TAG_NOT_FOUND');
    }

    await this.pool.query(
      'UPDATE knowledges SET tag_id = $1 WHERE id = $2',
      [tagId, docId]
    );
  }
```

**Step 2: Run all tests**

```bash
cd backend && npx vitest run src/services/__tests__/tagService.test.ts
```

Expected: All tests PASS.

---

### Task 8: KB 管理路由

**Files:**
- Create: `backend/src/routes/kb.ts`

> **鉴权说明：** 不需要 KB Owner 验证中间件。实际鉴权链路：
> 1. 用户在 weknora-ui 登录 → WeKnora 后端签发 JWT，包含用户身份
> 2. "我的"页面调用 WeKnora API → WeKnora 后端根据 JWT 过滤，仅返回当前用户的知识库
> 3. 用户点击 KB 卡片进入详情 → kbId 来源已经过权限过滤
> 4. 详情页调用 AgentStudio API → authMiddleware 验证 AgentStudio JWT（确认已认证）
>
> kbId 不是用户随意构造的，而是从 WeKnora 后端鉴权后返回的列表中获取的。
> AgentStudio JWT 仅含 `{ authenticated: true }`，不含 userId，架构上无法做用户级校验。
> 因此只需 `authMiddleware`（JWT 认证）+ `requireTagService`（服务可用性）。

**Step 1: Implement KB routes**

```typescript
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
    const tags = await tagService.getTagsByKbId(req.params.kbId);
    const tree = TagService.buildTagTree(tags);
    res.json({ success: true, data: { items: tree, total: tags.length } });
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
    const statusMap: Record<string, number> = {
      TAG_NAME_REQUIRED: 400,
      TAG_NAME_DUPLICATE: 400,
      PARENT_NOT_IN_KB: 400,
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
```

**Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors related to kb.ts.

---

### Task 9: 注册路由到 index.ts

**Files:**
- Modify: `backend/src/index.ts`

**Step 1: Add import and initialization**

At the top of `index.ts` (with other imports), add:

```typescript
import { kbRouter, initKbRoutes } from './routes/kb.js';
```

In the initialization section (after `initShareRoutes()`, around line 323-331), add:

```typescript
  // 3.6. KB Service: Initialize KB tag management routes
  try {
    initKbRoutes();
  } catch (error) {
    console.error('[KbRoutes] Failed to initialize KB routes:', error);
  }
```

In the protected routes section (around line 495, after `app.use('/api/share', ...)`), add:

```typescript
  app.use('/api/kb', authMiddleware, kbRouter); // KB tag management
```

**Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors.

---

### Task 10: ShareContentService 新增 getTagTree

**Files:**
- Modify: `backend/src/services/shareContentService.ts`

**Step 1: Add getTagTree method**

Import `TagService` at the top of `shareContentService.ts` (after existing imports):

```typescript
import { TagService } from './tagService.js';
```

Add after `getKnowledgeBaseTags` method (around line 299):

```typescript
  /**
   * 获取知识库的树形文档分类标签（只读）
   */
  async getTagTree(shareId: string) {
    const share = await this.shareService.getShareById(shareId);
    if (!share) throw new Error('SHARE_NOT_FOUND');

    const kbId = share.share_type === 'knowledge_base'
      ? share.target_id
      : share.target_kb_id;

    if (!kbId) throw new Error('KB_NOT_FOUND');

    const tagService = new TagService(this.pool);
    const tags = await tagService.getTagsByKbId(kbId);
    const tree = TagService.buildTagTree(tags);

    return { items: tree, total: tags.length };
  }
```

**Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors.

---

### Task 11: Share/ShareLink 路由新增 tag-tree 端点

**Files:**
- Modify: `backend/src/routes/share.ts`
- Modify: `backend/src/routes/shareLink.ts`

**Step 1: Add tag-tree endpoint to share.ts**

Add after `/:shareId/kb/tags` route (around line 424):

```typescript
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
```

**Step 2: Add tag-tree endpoint to shareLink.ts**

Add after `/:token/kb/tags` route (line 180-188), before `/:token/kb/documents` route:

```typescript
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
```

**Step 3: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors.

---

### Task 12: 完整后端集成验证

**Step 1: Build backend**

```bash
cd backend && pnpm run build
```

Expected: Build succeeds.

**Step 2: Run all existing tests**

```bash
cd backend && pnpm run test:run
```

Expected: No new test failures (existing failures may exist per CLAUDE.md).

**Step 3: Manual API test (if dev server running)**

```bash
# Get tag tree for a KB
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:4936/api/kb/<KB_ID>/tag-tree

# Expected: { "success": true, "data": { "items": [...], "total": N } }
```

---

### Task 13-15: weknora-ui 前端改造（概要）

> 以下任务在 `D:\workspace\weknora-ui` 项目中执行。

### Task 13: 前端类型 + API + 工具函数

**Files:**
- Create: `D:\workspace\weknora-ui\src\types\tag.ts` — 同 AgentStudio 的 TagItem / TagTreeNode 类型
- Create: `D:\workspace\weknora-ui\src\api\agentstudio\tag.ts` — AgentStudio tag CRUD API
- Modify: `D:\workspace\weknora-ui\src\api\share\index.ts` — 新增 `getSharedTagTree`

### Task 14: KnowledgeBase.vue 管理端改造

**Files:**
- Modify: `D:\workspace\weknora-ui\src\views\knowledge\KnowledgeBase.vue`

关键变更：
1. 替换 `.tag-list` 区域为 `<t-tree :data="tagTreeData" :draggable="true" :activable="true" ...>`
2. API 从 `listKnowledgeTags` 切换到 `getTagTree`
3. 新增 `operations` 插槽渲染操作菜单（编辑/删除/新建子分类）
4. 拖拽 `@drop` 事件处理：调用 `PUT /api/kb/:kbId/tag-reorder`
5. 删除弹窗：有子分类时显示 strategy 选择 Dialog
6. 文档分类选择器：`<t-select>` 改为 `<t-tree-select>`
7. 移除分页逻辑（`tagHasMore`, `tagLoadingMore`）

**文档列表过滤：** 点击分类直接传 `tag_id` 给 WeKnora API，只显示该分类直接关联的文档。现有 `loadKnowledgeFiles` 逻辑无需改动（已经传 `selectedTagId` 作为 `tag_id`）。上传文档、导入网页、在线编辑等写操作不受影响。

### Task 15: SharedKnowledgeBase.vue 只读端改造

**Files:**
- Modify: `D:\workspace\weknora-ui\src\views\share\SharedKnowledgeBase.vue`

关键变更：
1. 替换 `.tag-list` 区域为 `<t-tree :data="tagTreeData" :draggable="false" :activable="true" ...>`
2. API 从 `getSharedKBTags` 切换到 `getSharedTagTree`
3. `operations` 插槽仅渲染文档数量 badge
4. 文档过滤逻辑保持不变：`filteredDocuments` 的 `tag_id === selectedTagId` 只显示该分类直接关联的文档
