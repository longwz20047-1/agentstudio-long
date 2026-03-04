import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { integrateFirecrawlMcpServer, getFirecrawlToolNames } from '../firecrawlIntegration.js';
import type { FirecrawlConfig } from '../types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Firecrawl Integration', () => {
  const mockConfig: FirecrawlConfig = {
    base_url: 'http://firecrawl.test:3002',
    api_key: 'test-key',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('integrateFirecrawlMcpServer', () => {
    it('should add firecrawl server to queryOptions.mcpServers', async () => {
      const queryOptions: any = { allowedTools: [] };
      await integrateFirecrawlMcpServer(queryOptions, mockConfig);

      expect(queryOptions.mcpServers).toBeDefined();
      expect(queryOptions.mcpServers.firecrawl).toBeDefined();
    });

    it('should add both tools to allowedTools', async () => {
      const queryOptions: any = { allowedTools: [] };
      await integrateFirecrawlMcpServer(queryOptions, mockConfig);

      expect(queryOptions.allowedTools).toContain('mcp__firecrawl__firecrawl_scrape');
      expect(queryOptions.allowedTools).toContain('mcp__firecrawl__firecrawl_map');
    });

    it('should skip integration when health check fails', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const queryOptions: any = { allowedTools: [] };
      await integrateFirecrawlMcpServer(queryOptions, mockConfig);

      expect(queryOptions.mcpServers?.firecrawl).toBeUndefined();
    });
  });

  describe('getFirecrawlToolNames', () => {
    it('should return both tool names', () => {
      const names = getFirecrawlToolNames();
      expect(names).toEqual([
        'mcp__firecrawl__firecrawl_scrape',
        'mcp__firecrawl__firecrawl_map',
      ]);
    });
  });
});
