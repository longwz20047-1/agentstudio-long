// backend/src/services/graphiti/hooks/__tests__/sessionStartHook.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionStartHook, DEFAULT_PROFILE_QUERIES, formatUserProfile } from '../sessionStartHook.js';
import type { GraphitiContext } from '../../types.js';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SessionStart Hook', () => {
  const mockContext: GraphitiContext = {
    base_url: 'http://localhost:8000',
    user_id: 'test-user',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('formatUserProfile', () => {
    it('should return empty string for empty profile', () => {
      const result = formatUserProfile(new Map());
      expect(result).toBe('');
    });

    it('should format profile with multiple categories', () => {
      const profile = new Map([
        ['基本信息', ['用户叫张三', '在北京工作']],
        ['偏好设置', ['喜欢简洁的代码']],
      ]);

      const result = formatUserProfile(profile);

      expect(result).toContain('## 用户画像');
      expect(result).toContain('### 基本信息');
      expect(result).toContain('- 用户叫张三');
      expect(result).toContain('- 在北京工作');
      expect(result).toContain('### 偏好设置');
      expect(result).toContain('- 喜欢简洁的代码');
    });
  });

  describe('createSessionStartHook', () => {
    it('should return continue: true when no profile found', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ facts: [] }),
      });

      const hook = createSessionStartHook(mockContext, {});
      const result = await hook(
        {
          hook_event_name: 'SessionStart',
          session_id: 'test-session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp',
          source: 'startup',
        } as any,
        undefined,
        { signal: new AbortController().signal }
      );

      expect(result.continue).toBe(true);
      expect(result.hookSpecificOutput?.additionalContext).toBeUndefined();
    });

    it('should inject user profile when facts found', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          facts: [{ fact: '用户叫张三', name: 'user_name' }],
        }),
      });

      const hook = createSessionStartHook(mockContext, {});
      const result = await hook(
        {
          hook_event_name: 'SessionStart',
          session_id: 'test-session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp',
          source: 'startup',
        } as any,
        undefined,
        { signal: new AbortController().signal }
      );

      expect(result.continue).toBe(true);
      expect(result.hookSpecificOutput?.additionalContext).toContain('用户画像');
    });

    it('should handle API errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const hook = createSessionStartHook(mockContext, {});
      const result = await hook(
        {
          hook_event_name: 'SessionStart',
          session_id: 'test-session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp',
          source: 'startup',
        } as any,
        undefined,
        { signal: new AbortController().signal }
      );

      expect(result.continue).toBe(true);
      // Should not block session on error
    });
  });

  describe('DEFAULT_PROFILE_QUERIES', () => {
    it('should have at least 3 categories', () => {
      expect(DEFAULT_PROFILE_QUERIES.length).toBeGreaterThanOrEqual(3);
    });

    it('should include common categories', () => {
      const categories = DEFAULT_PROFILE_QUERIES.map(q => q.category);
      expect(categories).toContain('基本信息');
      expect(categories).toContain('偏好设置');
    });
  });
});
