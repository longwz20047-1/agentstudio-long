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
   * 获取 KB 下的文档统计（全部文档数、未分类文档数）
   * 未分类包括：tag_id 为 NULL、tag_id 指向已删除标签、tag_id 无对应标签
   */
  async getDocumentCounts(kbId: string): Promise<{ total_count: number; untagged_count: number }> {
    const result = await this.pool.query(
      `SELECT
         COUNT(*) AS total_count,
         SUM(CASE WHEN t.id IS NULL THEN 1 ELSE 0 END)::int AS untagged_count
       FROM knowledges k
       LEFT JOIN knowledge_tags t ON t.id = k.tag_id AND t.deleted_at IS NULL
       WHERE k.knowledge_base_id = $1 AND k.deleted_at IS NULL`,
      [kbId]
    );
    const row = result.rows[0];
    return {
      total_count: parseInt(row.total_count) || 0,
      untagged_count: parseInt(row.untagged_count) || 0,
    };
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

  /**
   * 从 knowledge_bases 表获取 tenant_id
   */
  private async getTenantId(kbId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT tenant_id FROM knowledge_bases WHERE id = $1',
      [kbId]
    );
    if (result.rows.length === 0) {
      throw new Error('KB_NOT_FOUND');
    }
    return result.rows[0].tenant_id;
  }

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

      // 限制最多三级：计算 parent 深度，若 >= 2 则不允许创建子级
      const allTags = await this.getTagsByKbId(kbId);
      const parentMap = new Map<string, string | null>();
      for (const tag of allTags) {
        parentMap.set(tag.id, tag.parent_id);
      }
      let depth = 0;
      let cur: string | null = data.parent_id;
      while (cur) {
        depth++;
        cur = parentMap.get(cur) ?? null;
      }
      if (depth >= 3) {
        throw new Error('TAG_MAX_DEPTH');
      }
    }

    // 校验知识库内不重名（数据库唯一约束 idx_knowledge_tags_kb_name）
    const dupCheck = await this.pool.query(
      `SELECT id FROM knowledge_tags
       WHERE knowledge_base_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [kbId, name]
    );
    if (dupCheck.rows.length > 0) {
      throw new Error('TAG_NAME_DUPLICATE');
    }

    // 从知识库获取 tenant_id（knowledge_tags 表必填字段）
    const tenantId = await this.getTenantId(kbId);

    const id = uuidv4();
    const sortOrder = data.sort_order ?? 0;
    const color = data.color ?? null;
    const parentId = data.parent_id ?? null;

    await this.pool.query(
      `INSERT INTO knowledge_tags (id, knowledge_base_id, name, color, sort_order, parent_id, tenant_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
      [id, kbId, name, color, sortOrder, parentId, tenantId]
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

    // 如果要改名，检查知识库内不重名（数据库唯一约束 idx_knowledge_tags_kb_name）
    const newName = data.name?.trim();
    if (newName !== undefined) {
      if (!newName) throw new Error('TAG_NAME_REQUIRED');
      const dupCheck = await this.pool.query(
        `SELECT id FROM knowledge_tags
         WHERE knowledge_base_id = $1 AND name = $2 AND id != $3 AND deleted_at IS NULL`,
        [kbId, newName, tagId]
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
}
