// backend/src/services/graphiti/hooks/__tests__/graphitiClient.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchFacts, searchMultipleCategories } from '../graphitiClient.js';
import type { GraphitiContext } from '../../types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('graphitiClient', () => {
  const mockContext: GraphitiContext = {
    base_url: 'http://localhost:8000',
    user_id: 'test-user',
    group_ids: ['shared'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('searchFacts', () => {
    it('should return facts on successful response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          facts: [
            { fact: 'Test fact 1', name: 'fact1' },
            { fact: 'Test fact 2', name: 'fact2' },
          ],
        }),
      });

      const result = await searchFacts(mockContext, 'test query');

      expect(result).toHaveLength(2);
      expect(result[0].fact).toBe('Test fact 1');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/search',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"group_ids":["user_test-user","shared"]'),
        })
      );
    });

    it('should return empty array on API error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await searchFacts(mockContext, 'test query');

      expect(result).toEqual([]);
    });

    it('should return empty array on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await searchFacts(mockContext, 'test query');

      expect(result).toEqual([]);
    });
  });

  describe('searchMultipleCategories', () => {
    it('should search all categories in parallel', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          facts: [{ fact: 'Test fact', name: 'test' }],
        }),
      });

      const queries = [
        { category: 'Cat1', query: 'query1' },
        { category: 'Cat2', query: 'query2' },
      ];

      const result = await searchMultipleCategories(mockContext, queries);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.size).toBe(2);
      expect(result.get('Cat1')).toEqual(['Test fact']);
      expect(result.get('Cat2')).toEqual(['Test fact']);
    });

    it('should exclude categories with no results', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ facts: [{ fact: 'Has fact', name: 'test' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ facts: [] }),
        });

      const queries = [
        { category: 'HasFacts', query: 'query1' },
        { category: 'NoFacts', query: 'query2' },
      ];

      const result = await searchMultipleCategories(mockContext, queries);

      expect(result.size).toBe(1);
      expect(result.has('HasFacts')).toBe(true);
      expect(result.has('NoFacts')).toBe(false);
    });
  });
});
