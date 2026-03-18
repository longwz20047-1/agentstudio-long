import { describe, it, expect, vi, beforeEach } from 'vitest';
import { integrateWeKnoraMcpServer, getWeknoraToolName, searchWeKnoraRaw, type WeknoraContext, type WeKnoraSearchResult } from '../weknoraIntegration.js';

describe('WeKnora Integration', () => {
  const mockContext: WeknoraContext = {
    api_key: 'test-api-key',
    kb_ids: ['kb-1', 'kb-2'],
    base_url: 'http://test-weknora.local'
  };

  describe('integrateWeKnoraMcpServer', () => {
    it('should add weknora server to queryOptions.mcpServers', async () => {
      const queryOptions: any = { allowedTools: [] };

      await integrateWeKnoraMcpServer(queryOptions, mockContext);

      expect(queryOptions.mcpServers).toBeDefined();
      expect(queryOptions.mcpServers.weknora).toBeDefined();
    });

    it('should add weknora tool to allowedTools', async () => {
      const queryOptions: any = { allowedTools: ['other_tool'] };

      await integrateWeKnoraMcpServer(queryOptions, mockContext);

      expect(queryOptions.allowedTools).toContain('mcp__weknora__weknora_search');
      expect(queryOptions.allowedTools).toContain('other_tool');
    });

    it('should create allowedTools if not present', async () => {
      const queryOptions: any = {};

      await integrateWeKnoraMcpServer(queryOptions, mockContext);

      expect(queryOptions.allowedTools).toContain('mcp__weknora__weknora_search');
    });

    it('should not duplicate tool in allowedTools', async () => {
      const queryOptions: any = { allowedTools: ['mcp__weknora__weknora_search'] };

      await integrateWeKnoraMcpServer(queryOptions, mockContext);

      const toolCount = queryOptions.allowedTools.filter(
        (t: string) => t === 'mcp__weknora__weknora_search'
      ).length;
      expect(toolCount).toBe(1);
    });
  });

  describe('getWeknoraToolName', () => {
    it('should return correct tool name format', () => {
      const toolName = getWeknoraToolName();
      expect(toolName).toBe('mcp__weknora__weknora_search');
    });
  });

  describe('WeknoraContext with knowledge_ids', () => {
    const contextWithKnowledgeIds: WeknoraContext = {
      api_key: 'test-api-key',
      kb_ids: ['kb-1'],
      knowledge_ids: ['doc-1', 'doc-2'],
      base_url: 'http://test-weknora.local'
    };

    it('should integrate with knowledge_ids in context', async () => {
      const queryOptions: any = {};
      await integrateWeKnoraMcpServer(queryOptions, contextWithKnowledgeIds);
      expect(queryOptions.mcpServers.weknora).toBeDefined();
    });

    it('should work without knowledge_ids (backward compatible)', async () => {
      const queryOptions: any = {};
      await integrateWeKnoraMcpServer(queryOptions, mockContext);
      expect(queryOptions.mcpServers.weknora).toBeDefined();
    });

    it('should work with only knowledge_ids and empty kb_ids', async () => {
      const contextOnlyDocs: WeknoraContext = {
        api_key: 'test-api-key',
        kb_ids: [],
        knowledge_ids: ['doc-1'],
        base_url: 'http://test-weknora.local'
      };
      const queryOptions: any = {};
      await integrateWeKnoraMcpServer(queryOptions, contextOnlyDocs);
      expect(queryOptions.mcpServers.weknora).toBeDefined();
    });
  });
});

describe('searchWeKnoraRaw', () => {
  const ctx: WeknoraContext = {
    api_key: 'test-key',
    kb_ids: ['kb-1'],
    knowledge_ids: ['doc-1'],
    base_url: 'http://weknora.local',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should return normalized results on success', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            knowledge_id: 'kid-1',
            knowledge_title: 'Test Doc',
            knowledge_filename: 'test.pdf',
            content: 'Hello world content',
            score: 0.85,
            match_type: 'vector',
          },
        ],
      }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    const results = await searchWeKnoraRaw('test query', ctx);

    expect(results).toHaveLength(1);
    expect(results![0]).toEqual({
      knowledge_id: 'kid-1',
      title: 'Test Doc',
      filename: 'test.pdf',
      content: 'Hello world content',
      score: 0.85,
      match_type: 'vector',
    });
  });

  it('should send correct request body with kb_ids and knowledge_ids', async () => {
    const mockResponse = { ok: true, json: vi.fn().mockResolvedValue({ data: [] }) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    await searchWeKnoraRaw('query', ctx);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://weknora.local/api/v1/knowledge-search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          query: 'query',
          knowledge_base_ids: ['kb-1'],
          knowledge_ids: ['doc-1'],
        }),
      }),
    );
  });

  it('should omit knowledge_base_ids when kb_ids is empty', async () => {
    const ctxOnlyDocs: WeknoraContext = { ...ctx, kb_ids: [] };
    const mockResponse = { ok: true, json: vi.fn().mockResolvedValue({ data: [] }) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    await searchWeKnoraRaw('query', ctxOnlyDocs);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.knowledge_base_ids).toBeUndefined();
    expect(body.knowledge_ids).toEqual(['doc-1']);
  });

  it('should return null on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as any);
    const results = await searchWeKnoraRaw('query', ctx);
    expect(results).toBeNull();
  });

  it('should return null on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network failed'));
    const results = await searchWeKnoraRaw('query', ctx);
    expect(results).toBeNull();
  });

  it('should apply timeout when specified', async () => {
    const mockResponse = { ok: true, json: vi.fn().mockResolvedValue({ data: [] }) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    await searchWeKnoraRaw('query', ctx, { timeoutMs: 5000 });

    const fetchOptions = fetchSpy.mock.calls[0][1]!;
    expect(fetchOptions.signal).toBeDefined();
  });

  it('should normalize title with fallback chain', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [
          { knowledge_filename: 'fallback.pdf', content: '', score: 0.5 },
          { title: 'title-field', content: '', score: 0.3 },
          { content: '', score: 0.1 },
        ],
      }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    const results = await searchWeKnoraRaw('query', ctx);

    expect(results![0].title).toBe('fallback.pdf');
    expect(results![1].title).toBe('title-field');
    expect(results![2].title).toBe('Untitled');
  });
});
