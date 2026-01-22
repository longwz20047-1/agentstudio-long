import { describe, it, expect, vi, beforeEach } from 'vitest';
import { integrateWeKnoraMcpServer, getWeknoraToolName, type WeknoraContext } from '../weknoraIntegration.js';

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
});
