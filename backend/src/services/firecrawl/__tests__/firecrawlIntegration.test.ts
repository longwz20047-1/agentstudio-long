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
    // Health check passes (GET / returns 200)
    mockFetch.mockResolvedValue({ ok: true });
    delete process.env.FIRECRAWL_EXTRACT_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FIRECRAWL_EXTRACT_ENABLED;
  });

  describe('integrateFirecrawlMcpServer', () => {
    it('should add firecrawl server to queryOptions.mcpServers', async () => {
      const queryOptions: any = { allowedTools: [] };
      await integrateFirecrawlMcpServer(queryOptions, mockConfig);

      expect(queryOptions.mcpServers).toBeDefined();
      expect(queryOptions.mcpServers.firecrawl).toBeDefined();
    });

    it('should add 2 base tools to allowedTools', async () => {
      const queryOptions: any = { allowedTools: [] };
      await integrateFirecrawlMcpServer(queryOptions, mockConfig);

      expect(queryOptions.allowedTools).toContain('mcp__firecrawl__firecrawl_scrape');
      expect(queryOptions.allowedTools).toContain('mcp__firecrawl__firecrawl_interact');
      expect(queryOptions.allowedTools).not.toContain('mcp__firecrawl__firecrawl_extract');
    });

    it('should add extract tool when FIRECRAWL_EXTRACT_ENABLED=true', async () => {
      process.env.FIRECRAWL_EXTRACT_ENABLED = 'true';
      const queryOptions: any = { allowedTools: [] };
      await integrateFirecrawlMcpServer(queryOptions, mockConfig);

      expect(queryOptions.allowedTools).toContain('mcp__firecrawl__firecrawl_extract');
    });

    it('should skip integration when health check fails', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const queryOptions: any = { allowedTools: [] };
      const result = await integrateFirecrawlMcpServer(queryOptions, mockConfig);

      expect(result).toBe(false);
      expect(queryOptions.mcpServers?.firecrawl).toBeUndefined();
    });

    it('should return true on success', async () => {
      const queryOptions: any = { allowedTools: [] };
      const result = await integrateFirecrawlMcpServer(queryOptions, mockConfig);

      expect(result).toBe(true);
    });
  });

  describe('getFirecrawlToolNames', () => {
    it('should return 2 tools by default', () => {
      const names = getFirecrawlToolNames();
      expect(names).toHaveLength(2);
      expect(names).toContain('mcp__firecrawl__firecrawl_scrape');
      expect(names).toContain('mcp__firecrawl__firecrawl_interact');
    });

    it('should include extract when enabled', () => {
      process.env.FIRECRAWL_EXTRACT_ENABLED = 'true';
      const names = getFirecrawlToolNames();
      expect(names).toHaveLength(4);
      expect(names).toContain('mcp__firecrawl__firecrawl_extract');
    });
  });
});
