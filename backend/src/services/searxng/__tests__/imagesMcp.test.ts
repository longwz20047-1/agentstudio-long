import { describe, it, expect, vi } from 'vitest';

vi.mock('../searxngClient.js', () => ({
  SearXNGClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue({
      query: 'aurora borealis',
      number_of_results: 2,
      results: [
        {
          title: 'Aurora Photo 1',
          url: 'https://example.com/aurora1',
          content: '',
          engine: 'google images',
          engines: ['google images'],
          score: 1.0,
          category: 'images',
          img_src: 'https://example.com/aurora1-full.jpg',
          thumbnail: 'https://example.com/aurora1-thumb.jpg',
          img_format: 'jpeg',
        },
        {
          title: 'Aurora Photo 2',
          url: 'https://example.com/aurora2',
          content: '',
          engine: 'bing images',
          engines: ['bing images'],
          score: 0.8,
          category: 'images',
          img_src: 'https://example.com/aurora2-full.jpg',
          thumbnail: '//example.com/aurora2-thumb.jpg',
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

import { integrateImagesMcp, getImagesToolNames } from '../imagesMcp.js';
import type { SearxngConfig } from '../types.js';

describe('imagesMcp', () => {
  const config: SearxngConfig = { base_url: 'http://localhost:8888' };

  describe('integrateImagesMcp', () => {
    it('should register MCP server on queryOptions', async () => {
      const queryOptions: any = {};
      await integrateImagesMcp(queryOptions, config);

      expect(queryOptions.mcpServers).toBeDefined();
      expect(queryOptions.mcpServers['searxng-images']).toBeDefined();
    });

    it('should register allowedTools with correct tool name', async () => {
      const queryOptions: any = {};
      await integrateImagesMcp(queryOptions, config);

      expect(queryOptions.allowedTools).toContain('mcp__searxng-images__image_search');
    });

    it('should create allowedTools array when undefined', async () => {
      const queryOptions: any = {};
      await integrateImagesMcp(queryOptions, config);

      expect(Array.isArray(queryOptions.allowedTools)).toBe(true);
      expect(queryOptions.allowedTools).toEqual(['mcp__searxng-images__image_search']);
    });

    it('should append to existing allowedTools without duplicates', async () => {
      const queryOptions: any = { allowedTools: ['existing_tool'] };
      await integrateImagesMcp(queryOptions, config);

      expect(queryOptions.allowedTools).toEqual([
        'existing_tool',
        'mcp__searxng-images__image_search',
      ]);
    });

    it('should not duplicate if tool already in allowedTools', async () => {
      const queryOptions: any = { allowedTools: ['mcp__searxng-images__image_search'] };
      await integrateImagesMcp(queryOptions, config);

      expect(queryOptions.allowedTools).toEqual(['mcp__searxng-images__image_search']);
    });

    it('should preserve existing mcpServers', async () => {
      const existingServer = { fake: true };
      const queryOptions: any = { mcpServers: { existing: existingServer } };
      await integrateImagesMcp(queryOptions, config);

      expect(queryOptions.mcpServers.existing).toBe(existingServer);
      expect(queryOptions.mcpServers['searxng-images']).toBeDefined();
    });
  });

  describe('getImagesToolNames', () => {
    it('should return correct tool name format', () => {
      const names = getImagesToolNames();
      expect(names).toEqual(['mcp__searxng-images__image_search']);
    });
  });
});
