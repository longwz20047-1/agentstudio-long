import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { integrateSearchMcpServer, getSearxngToolNames } from '../searxngIntegration.js';
import type { SearxngConfig } from '../types.js';

// Mock fetch for health check
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SearXNG Integration', () => {
  const mockConfig: SearxngConfig = {
    base_url: 'http://searxng.test:8888',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: health check passes
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('integrateSearchMcpServer', () => {
    it('should add searxng server to queryOptions.mcpServers', async () => {
      const queryOptions: any = { allowedTools: [] };
      await integrateSearchMcpServer(queryOptions, mockConfig);

      expect(queryOptions.mcpServers).toBeDefined();
      expect(queryOptions.mcpServers.searxng).toBeDefined();
    });

    it('should add tool to allowedTools', async () => {
      const queryOptions: any = { allowedTools: ['other_tool'] };
      await integrateSearchMcpServer(queryOptions, mockConfig);

      expect(queryOptions.allowedTools).toContain('mcp__searxng__searxng_search');
      expect(queryOptions.allowedTools).toContain('other_tool');
    });

    it('should create allowedTools if not present', async () => {
      const queryOptions: any = {};
      await integrateSearchMcpServer(queryOptions, mockConfig);

      expect(queryOptions.allowedTools).toContain('mcp__searxng__searxng_search');
    });

    it('should not duplicate tool in allowedTools', async () => {
      const queryOptions: any = { allowedTools: ['mcp__searxng__searxng_search'] };
      await integrateSearchMcpServer(queryOptions, mockConfig);

      const count = queryOptions.allowedTools.filter(
        (t: string) => t === 'mcp__searxng__searxng_search'
      ).length;
      expect(count).toBe(1);
    });

    it('should skip integration when health check fails', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const queryOptions: any = { allowedTools: [] };
      await integrateSearchMcpServer(queryOptions, mockConfig);

      expect(queryOptions.mcpServers?.searxng).toBeUndefined();
    });
  });

  describe('getSearxngToolNames', () => {
    it('should return correct tool name', () => {
      const names = getSearxngToolNames();
      expect(names).toEqual(['mcp__searxng__searxng_search']);
    });
  });
});
