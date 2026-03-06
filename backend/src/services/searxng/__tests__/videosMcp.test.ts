import { describe, it, expect, vi } from 'vitest';

vi.mock('../searxngClient.js', () => ({
  SearXNGClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue({
      query: 'Docker tutorial',
      number_of_results: 2,
      results: [
        {
          title: 'Docker Tutorial for Beginners',
          url: 'https://www.youtube.com/watch?v=abc123',
          content: '',
          engine: 'youtube',
          engines: ['youtube'],
          score: 1.0,
          category: 'videos',
          thumbnail: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
          publishedDate: '2025-01-15',
          length: '12:34',
          author: 'TechChannel',
        },
        {
          title: 'Docker 入门教程',
          url: 'https://www.bilibili.com/video/BV1234',
          content: '',
          engine: 'bilibili',
          engines: ['bilibili'],
          score: 0.8,
          category: 'videos',
          thumbnail: 'https://i0.hdslb.com/bfs/archive/thumb.jpg',
          length: '25:10',
          author: 'B站UP主',
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

import { integrateVideosMcp, getVideosToolNames } from '../videosMcp.js';
import type { SearxngConfig } from '../types.js';

describe('videosMcp', () => {
  const config: SearxngConfig = { base_url: 'http://localhost:8888' };

  describe('integrateVideosMcp', () => {
    it('should register MCP server on queryOptions', async () => {
      const queryOptions: any = {};
      await integrateVideosMcp(queryOptions, config);

      expect(queryOptions.mcpServers).toBeDefined();
      expect(queryOptions.mcpServers['searxng-videos']).toBeDefined();
    });

    it('should register allowedTools with correct tool name', async () => {
      const queryOptions: any = {};
      await integrateVideosMcp(queryOptions, config);

      expect(queryOptions.allowedTools).toContain('mcp__searxng-videos__video_search');
    });

    it('should create allowedTools array when undefined', async () => {
      const queryOptions: any = {};
      await integrateVideosMcp(queryOptions, config);

      expect(Array.isArray(queryOptions.allowedTools)).toBe(true);
      expect(queryOptions.allowedTools).toEqual(['mcp__searxng-videos__video_search']);
    });

    it('should append to existing allowedTools without duplicates', async () => {
      const queryOptions: any = { allowedTools: ['existing_tool'] };
      await integrateVideosMcp(queryOptions, config);

      expect(queryOptions.allowedTools).toEqual([
        'existing_tool',
        'mcp__searxng-videos__video_search',
      ]);
    });

    it('should not duplicate if tool already in allowedTools', async () => {
      const queryOptions: any = { allowedTools: ['mcp__searxng-videos__video_search'] };
      await integrateVideosMcp(queryOptions, config);

      expect(queryOptions.allowedTools).toEqual(['mcp__searxng-videos__video_search']);
    });

    it('should preserve existing mcpServers', async () => {
      const existingServer = { fake: true };
      const queryOptions: any = { mcpServers: { existing: existingServer } };
      await integrateVideosMcp(queryOptions, config);

      expect(queryOptions.mcpServers.existing).toBe(existingServer);
      expect(queryOptions.mcpServers['searxng-videos']).toBeDefined();
    });
  });

  describe('getVideosToolNames', () => {
    it('should return correct tool name format', () => {
      const names = getVideosToolNames();
      expect(names).toEqual(['mcp__searxng-videos__video_search']);
    });
  });
});
