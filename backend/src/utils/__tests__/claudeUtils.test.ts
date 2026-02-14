/**
 * Unit tests for claudeUtils.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  readMcpConfig,
  getDefaultClaudeVersionEnv,
  buildQueryOptions
} from '../claudeUtils';

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn()
}));

// Mock os
vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home')
}));

// Mock claudeVersionStorage
vi.mock('../../services/claudeVersionStorage', () => ({
  getDefaultVersionId: vi.fn(),
  getAllVersionsInternal: vi.fn(),
  getVersionByIdInternal: vi.fn()
}));

// Mock a2aIntegration
vi.mock('../../services/a2a/a2aIntegration', () => ({
  integrateA2AMcpServer: vi.fn()
}));

describe('claudeUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('readMcpConfig', () => {
    it('should read and parse MCP config file', () => {
      const mockConfig = {
        mcpServers: {
          'test-server': {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            status: 'active'
          }
        }
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockConfig));

      const result = readMcpConfig();
      expect(result).toEqual(mockConfig);
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join('/mock/home', '.agentstudio', 'data', 'mcp-server.json'),
        'utf-8'
      );
    });

    it('should return default config if file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = readMcpConfig();
      expect(result).toEqual({ mcpServers: {} });
    });

    it('should return default config if JSON parsing fails', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('invalid json');

      const result = readMcpConfig();
      expect(result).toEqual({ mcpServers: {} });
    });
  });

  describe('getDefaultClaudeVersionEnv', () => {
    it('should return environment variables from default version', async () => {
      const mockVersions = [
        {
          id: 'default-version',
          name: 'Claude Default',
          alias: 'default',
          environmentVariables: {
            ANTHROPIC_API_KEY: 'test-key-123'
          }
        }
      ];

      const { getDefaultVersionId, getAllVersionsInternal } = await import('../../services/claudeVersionStorage');
      vi.mocked(getDefaultVersionId).mockResolvedValue('default-version');
      vi.mocked(getAllVersionsInternal).mockResolvedValue(mockVersions as any);

      const result = await getDefaultClaudeVersionEnv();
      expect(result).toEqual({
        ANTHROPIC_API_KEY: 'test-key-123'
      });
    });

    it('should return null if no default version found', async () => {
      const { getDefaultVersionId } = await import('../../services/claudeVersionStorage');
      vi.mocked(getDefaultVersionId).mockResolvedValue(null);

      const result = await getDefaultClaudeVersionEnv();
      expect(result).toBeNull();
    });

    it('should return null if default version has no API keys', async () => {
      const mockVersions = [
        {
          id: 'default-version',
          name: 'Claude Default',
          alias: 'default',
          environmentVariables: {
            // No API keys
            SOME_OTHER_VAR: 'value'
          }
        }
      ];

      const { getDefaultVersionId, getAllVersionsInternal } = await import('../../services/claudeVersionStorage');
      vi.mocked(getDefaultVersionId).mockResolvedValue('default-version');
      vi.mocked(getAllVersionsInternal).mockResolvedValue(mockVersions as any);

      const result = await getDefaultClaudeVersionEnv();
      expect(result).toBeNull();
    });
  });

  describe('buildQueryOptions', () => {
    const mockAgent = {
      systemPrompt: 'Test system prompt',
      workingDirectory: './test-dir',
      permissionMode: 'acceptEdits',
      model: 'sonnet',
      maxTurns: 10,
      allowedTools: [
        { name: 'Write', enabled: true },
        { name: 'Read', enabled: true },
        { name: 'Disabled', enabled: false }
      ]
    };

    it('should build basic query options', async () => {
      const { getDefaultVersionId } = await import('../../services/claudeVersionStorage');
      vi.mocked(getDefaultVersionId).mockResolvedValue(null);

      const result = await buildQueryOptions(mockAgent);

      // SDK 0.1.76+ uses built-in CLI, no pathToClaudeCodeExecutable needed
      expect(result.queryOptions).toMatchObject({
        systemPrompt: 'Test system prompt',
        allowedTools: ['Write', 'Read'],
        maxTurns: 10,
        permissionMode: 'acceptEdits',
        model: 'sonnet'
        // Note: pathToClaudeCodeExecutable is only set when a valid path is configured
        // by a provider, otherwise SDK uses its bundled CLI
      });
      expect(result.queryOptions.env).toBeDefined();
      // pathToClaudeCodeExecutable should not be set when using SDK built-in CLI
      expect(result.queryOptions.pathToClaudeCodeExecutable).toBeUndefined();
    });

    it('should use projectPath as cwd if provided', async () => {
      const { getDefaultVersionId } = await import('../../services/claudeVersionStorage');
      vi.mocked(getDefaultVersionId).mockResolvedValue(null);

      const result = await buildQueryOptions(mockAgent, '/custom/project/path');

      expect(result.queryOptions.cwd).toBe('/custom/project/path');
    });

    it('should include MCP tools in allowed tools', async () => {
      const { getDefaultVersionId } = await import('../../services/claudeVersionStorage');
      vi.mocked(getDefaultVersionId).mockResolvedValue(null);

      const mcpTools = ['mcp__server1__tool1', 'mcp__server2__tool2'];
      const result = await buildQueryOptions(mockAgent, undefined, mcpTools);

      expect(result.queryOptions.allowedTools).toContain('mcp__server1__tool1');
      expect(result.queryOptions.allowedTools).toContain('mcp__server2__tool2');
    });

    it('should configure MCP servers when MCP tools are provided', async () => {
      const { getDefaultVersionId } = await import('../../services/claudeVersionStorage');
      vi.mocked(getDefaultVersionId).mockResolvedValue(null);

      const mockMcpConfig = {
        mcpServers: {
          'server1': {
            type: 'stdio',
            command: 'node',
            args: ['server1.js'],
            status: 'active'
          }
        }
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockMcpConfig));

      const mcpTools = ['mcp__server1__tool1'];
      const result = await buildQueryOptions(mockAgent, undefined, mcpTools);

      expect(result.queryOptions.mcpServers).toBeDefined();
      expect(result.queryOptions.mcpServers?.server1).toMatchObject({
        type: 'stdio',
        command: 'node',
        args: ['server1.js']
      });
    });

    it('should use agent-specific Claude version environment variables', async () => {
      const mockVersion = {
        id: 'custom-version',
        name: 'Custom Claude',
        alias: 'custom',
        environmentVariables: {
          ANTHROPIC_API_KEY: 'custom-key'
        }
      };

      const { getVersionByIdInternal } = await import('../../services/claudeVersionStorage');
      vi.mocked(getVersionByIdInternal).mockResolvedValue(mockVersion as any);

      const result = await buildQueryOptions(mockAgent, undefined, undefined, undefined, undefined, 'custom-version');

      // SDK 0.1.76+ uses built-in CLI, environment variables are loaded from version config
      expect(result.queryOptions.env?.ANTHROPIC_API_KEY).toBe('custom-key');
      expect(result.queryOptions.pathToClaudeCodeExecutable).toBeUndefined();
    });

    it('should override agent settings with request parameters', async () => {
      const { getDefaultVersionId } = await import('../../services/claudeVersionStorage');
      vi.mocked(getDefaultVersionId).mockResolvedValue(null);

      const result = await buildQueryOptions(
        mockAgent,
        undefined,
        undefined,
        'bypassPermissions',
        'opus'
      );

      expect(result.queryOptions.permissionMode).toBe('bypassPermissions');
      expect(result.queryOptions.model).toBe('opus');
    });

    it('should fallback to bundled CLI when configured path does not exist', async () => {
      const mockVersion = {
        id: 'invalid-version',
        name: 'Invalid Claude',
        alias: 'invalid',
        executablePath: 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude-internal',
        environmentVariables: {
          ANTHROPIC_API_KEY: 'test-key'
        }
      };

      const { getVersionByIdInternal } = await import('../../services/claudeVersionStorage');
      vi.mocked(getVersionByIdInternal).mockResolvedValue(mockVersion as any);

      // Mock fs.existsSync to return false for the invalid path
      vi.mocked(fs.existsSync).mockImplementation((path: any) => {
        if (path === 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude-internal') {
          return false;
        }
        return true;
      });

      const result = await buildQueryOptions(mockAgent, undefined, undefined, undefined, undefined, 'invalid-version');

      // Should not set pathToClaudeCodeExecutable (let SDK use bundled CLI)
      expect(result.queryOptions.pathToClaudeCodeExecutable).toBeUndefined();
      // But should still use the environment variables
      expect(result.queryOptions.env?.ANTHROPIC_API_KEY).toBe('test-key');
    });

    it('should auto-include engine-native MCP servers without mcpTools', async () => {
      const { getDefaultVersionId } = await import('../../services/claudeVersionStorage');
      vi.mocked(getDefaultVersionId).mockResolvedValue(null);

      // Engine MCP config (e.g. ~/.claude/mcp.json) - these have NO status field
      const engineMcpConfig = {
        mcpServers: {
          'engine-server': {
            command: 'npx',
            args: ['-y', '@engine/mcp-server']
          },
          'engine-http': {
            url: 'http://localhost:8080/mcp',
            headers: { 'Authorization': 'Bearer test' }
          }
        }
      };

      // Mock fs to return engine config for engine path, empty for AS path
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (filePath.includes('.claude') && filePath.includes('mcp.json')) {
          return JSON.stringify(engineMcpConfig);
        }
        // AgentStudio config
        return JSON.stringify({ mcpServers: {} });
      });

      // No mcpTools provided - engine MCP should still be loaded
      const result = await buildQueryOptions(mockAgent);

      expect(result.queryOptions.mcpServers).toBeDefined();
      expect(result.queryOptions.mcpServers?.['engine-server']).toMatchObject({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@engine/mcp-server']
      });
      expect(result.queryOptions.mcpServers?.['engine-http']).toMatchObject({
        type: 'http',
        url: 'http://localhost:8080/mcp',
        headers: { 'Authorization': 'Bearer test' }
      });
    });

    it('should give precedence to AgentStudio config over engine config for duplicate servers', async () => {
      const { getDefaultVersionId } = await import('../../services/claudeVersionStorage');
      vi.mocked(getDefaultVersionId).mockResolvedValue(null);

      // AgentStudio config has server1 with specific command
      const asMcpConfig = {
        mcpServers: {
          'server1': {
            type: 'stdio',
            command: 'node',
            args: ['as-server1.js'],
            status: 'active'
          }
        }
      };

      // Engine config also has server1 but with different command
      const engineMcpConfig = {
        mcpServers: {
          'server1': {
            command: 'npx',
            args: ['engine-server1']
          },
          'server2': {
            command: 'npx',
            args: ['engine-server2']
          }
        }
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (filePath.includes('.claude') && filePath.includes('mcp.json')) {
          return JSON.stringify(engineMcpConfig);
        }
        return JSON.stringify(asMcpConfig);
      });

      const mcpTools = ['mcp__server1__tool1'];
      const result = await buildQueryOptions(mockAgent, undefined, mcpTools);

      // server1 should come from AgentStudio config (precedence)
      expect(result.queryOptions.mcpServers?.['server1']).toMatchObject({
        type: 'stdio',
        command: 'node',
        args: ['as-server1.js']
      });

      // server2 should come from engine config (auto-included)
      expect(result.queryOptions.mcpServers?.['server2']).toMatchObject({
        type: 'stdio',
        command: 'npx',
        args: ['engine-server2']
      });
    });

    it('should use valid executable path when it exists', async () => {
      const mockVersion = {
        id: 'valid-version',
        name: 'Valid Claude',
        alias: 'valid',
        executablePath: '/usr/local/bin/claude',
        environmentVariables: {
          ANTHROPIC_API_KEY: 'test-key'
        }
      };

      const { getVersionByIdInternal } = await import('../../services/claudeVersionStorage');
      vi.mocked(getVersionByIdInternal).mockResolvedValue(mockVersion as any);

      // Mock fs.existsSync to return true for the valid path
      vi.mocked(fs.existsSync).mockImplementation((path: any) => {
        if (path === '/usr/local/bin/claude') {
          return true;
        }
        return false;
      });

      const result = await buildQueryOptions(mockAgent, undefined, undefined, undefined, undefined, 'valid-version');

      // Should use the valid path
      expect(result.queryOptions.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude');
      expect(result.queryOptions.env?.ANTHROPIC_API_KEY).toBe('test-key');
    });
  });
});

