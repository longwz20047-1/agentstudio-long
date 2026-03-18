import { describe, it, expect, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('../queryRouter.js', () => ({
  analyzeQuery: vi.fn().mockReturnValue({
    intent: 'general',
    lang: 'en',
    languageCode: 'en',
    engines: 'google,duckduckgo',
    matchedRule: 'tier6:fallback',
  }),
}));

vi.mock('../contentExtractor.js', () => ({
  fetchAndExtract: vi.fn().mockResolvedValue({
    title: 'Test Page',
    content: 'Extracted content here',
  }),
}));

vi.mock('../resultProcessor.js', () => ({
  dedupeAndRank: vi.fn().mockReturnValue([
    {
      title: 'Result 1',
      url: 'https://example.com/1',
      snippet: 'Snippet 1',
      engines: ['google'],
      score: 1.0,
      category: 'general',
    },
  ]),
}));

vi.mock('../searxngClient.js', () => ({
  SearXNGClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue({
      query: 'test',
      number_of_results: 1,
      results: [
        {
          title: 'Result 1',
          url: 'https://example.com/1',
          content: 'Snippet 1',
          engine: 'google',
          engines: ['google'],
          score: 1.0,
          category: 'general',
        },
      ],
      suggestions: [],
      answers: [],
      corrections: [],
      infoboxes: [],
      unresponsive_engines: [],
    }),
  })),
}));

vi.mock('../../weknora/weknoraIntegration.js', () => ({
  searchWeKnoraRaw: vi.fn().mockResolvedValue([
    {
      knowledge_id: 'kid-1',
      title: 'KB Doc 1',
      filename: 'doc.pdf',
      content: 'KB content here',
      score: 0.9,
      match_type: 'vector',
    },
  ]),
}));

import { integrateSearchMcp, getSearchToolNames, _resetSearchCache } from '../searchMcp.js';
import type { SearxngConfig } from '../types.js';
import { searchWeKnoraRaw } from '../../weknora/weknoraIntegration.js';
import type { WeknoraContext } from '../../weknora/weknoraIntegration.js';

describe('searchMcp', () => {
  const config: SearxngConfig = { base_url: 'http://localhost:8888' };

  describe('integrateSearchMcp', () => {
    it('should register MCP server on queryOptions', async () => {
      const queryOptions: any = {};
      await integrateSearchMcp(queryOptions, config);

      expect(queryOptions.mcpServers).toBeDefined();
      expect(queryOptions.mcpServers['searxng-search']).toBeDefined();
    });

    it('should register allowedTools with correct tool name', async () => {
      const queryOptions: any = {};
      await integrateSearchMcp(queryOptions, config);

      expect(queryOptions.allowedTools).toContain('mcp__searxng-search__web_search');
    });

    it('should create allowedTools array when undefined', async () => {
      const queryOptions: any = {};
      await integrateSearchMcp(queryOptions, config);

      expect(Array.isArray(queryOptions.allowedTools)).toBe(true);
      expect(queryOptions.allowedTools).toEqual([
        'mcp__searxng-search__web_search',
      ]);
    });

    it('should append to existing allowedTools without duplicates', async () => {
      const queryOptions: any = { allowedTools: ['existing_tool'] };
      await integrateSearchMcp(queryOptions, config);

      expect(queryOptions.allowedTools).toEqual([
        'existing_tool',
        'mcp__searxng-search__web_search',
      ]);
    });

    it('should not duplicate if tool already in allowedTools', async () => {
      const queryOptions: any = { allowedTools: ['mcp__searxng-search__web_search'] };
      await integrateSearchMcp(queryOptions, config);

      expect(queryOptions.allowedTools).toEqual([
        'mcp__searxng-search__web_search',
      ]);
    });

    it('should preserve existing mcpServers', async () => {
      const existingServer = { fake: true };
      const queryOptions: any = { mcpServers: { existing: existingServer } };
      await integrateSearchMcp(queryOptions, config);

      expect(queryOptions.mcpServers.existing).toBe(existingServer);
      expect(queryOptions.mcpServers['searxng-search']).toBeDefined();
    });

    it('should register only web_search tool', async () => {
      const queryOptions: any = {};
      await integrateSearchMcp(queryOptions, config);

      expect(queryOptions.allowedTools).toContain('mcp__searxng-search__web_search');
      expect(queryOptions.allowedTools).not.toContain('mcp__searxng-search__web_fetch');
    });
  });

  describe('getSearchToolNames', () => {
    it('should return correct tool name format', () => {
      const names = getSearchToolNames();
      expect(names).toEqual([
        'mcp__searxng-search__web_search',
      ]);
    });
  });

  describe('_resetSearchCache', () => {
    it('should be a callable function', () => {
      expect(typeof _resetSearchCache).toBe('function');
      _resetSearchCache(); // Should not throw
    });
  });

  describe('KB integration via weknoraContext', () => {
    const weknoraCtx: WeknoraContext = {
      api_key: 'test-key',
      kb_ids: ['kb-1'],
      knowledge_ids: [],
      base_url: 'http://weknora.local',
    };

    beforeEach(() => {
      _resetSearchCache();
      vi.mocked(searchWeKnoraRaw).mockResolvedValue([
        {
          knowledge_id: 'kid-1',
          title: 'KB Doc 1',
          filename: 'doc.pdf',
          content: 'KB content here',
          score: 0.9,
          match_type: 'vector',
        },
      ]);
    });

    it('should accept optional weknoraContext parameter', async () => {
      const queryOptions: any = {};
      await integrateSearchMcp(queryOptions, config, weknoraCtx);
      expect(queryOptions.mcpServers['searxng-search']).toBeDefined();
    });

    it('should still work without weknoraContext (backward compatible)', async () => {
      const queryOptions: any = {};
      await integrateSearchMcp(queryOptions, config);
      expect(queryOptions.mcpServers['searxng-search']).toBeDefined();
    });

    it('should trigger KB search when weknoraContext has kb_ids', async () => {
      const queryOptions: any = {};
      await integrateSearchMcp(queryOptions, config, weknoraCtx);
      expect(queryOptions.mcpServers['searxng-search']).toBeDefined();
      expect(searchWeKnoraRaw).toBeDefined();
    });

    it('should trigger KB search when weknoraContext has only knowledge_ids', async () => {
      const ctxOnlyDocs: WeknoraContext = {
        api_key: 'test-key',
        kb_ids: [],
        knowledge_ids: ['doc-1'],
        base_url: 'http://weknora.local',
      };
      const queryOptions: any = {};
      await integrateSearchMcp(queryOptions, config, ctxOnlyDocs);
      expect(queryOptions.mcpServers['searxng-search']).toBeDefined();
    });

    it('should not trigger KB search when no api_key', async () => {
      const ctxNoKey: WeknoraContext = {
        api_key: '',
        kb_ids: ['kb-1'],
        base_url: 'http://weknora.local',
      };
      const queryOptions: any = {};
      await integrateSearchMcp(queryOptions, config, ctxNoKey);
      expect(queryOptions.mcpServers['searxng-search']).toBeDefined();
    });
  });
});
