// backend/src/services/__tests__/tagService.test.ts
import { describe, it, expect, vi } from 'vitest';
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

  describe('createTag', () => {
    it('should reject empty name', async () => {
      const pool = { query: vi.fn() } as any;
      const service = new TagService(pool);

      await expect(
        service.createTag('kb-1', { name: '' })
      ).rejects.toThrow('TAG_NAME_REQUIRED');
    });

    it('should reject whitespace-only name', async () => {
      const pool = { query: vi.fn() } as any;
      const service = new TagService(pool);

      await expect(
        service.createTag('kb-1', { name: '   ' })
      ).rejects.toThrow('TAG_NAME_REQUIRED');
    });
  });

  describe('wouldCreateCycle', () => {
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
});
