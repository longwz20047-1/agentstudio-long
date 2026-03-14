import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock chokidar before import
const mockWatcher = {
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
};
vi.mock('chokidar', () => ({
  default: { watch: vi.fn(() => mockWatcher) },
}));

// Mock agentMappingService
vi.mock('../a2a/agentMappingService.js', () => ({
  resolveA2AId: vi.fn().mockResolvedValue({
    a2aAgentId: 'agent-xxx',
    workingDirectory: '/projects/myproject',
  }),
}));

// Mock workspaceUtils
vi.mock('../../utils/workspaceUtils.js', () => ({
  resolveUserWorkspacePath: vi.fn().mockResolvedValue('/projects/myproject/.workspaces/u_123'),
}));

import { WorkspaceWatcher } from '../workspaceWatcher.js';

describe('WorkspaceWatcher', () => {
  let watcher: WorkspaceWatcher;

  beforeEach(() => {
    watcher = new WorkspaceWatcher();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await watcher.shutdown();
  });

  it('should create a chokidar watcher on first subscribe', async () => {
    const chokidar = await import('chokidar');
    const key = await watcher.subscribe('agent-xxx', 'u_123');
    expect(key).toBe('agent-xxx:u_123');
    expect(chokidar.default.watch).toHaveBeenCalledTimes(1);
  });

  it('should reuse watcher on duplicate subscribe (ref counting)', async () => {
    const chokidar = await import('chokidar');
    await watcher.subscribe('agent-xxx', 'u_123');
    await watcher.subscribe('agent-xxx', 'u_123');
    expect(chokidar.default.watch).toHaveBeenCalledTimes(1);
  });

  it('should not close watcher when refCount > 0', async () => {
    await watcher.subscribe('agent-xxx', 'u_123');
    await watcher.subscribe('agent-xxx', 'u_123');
    watcher.unsubscribe('agent-xxx:u_123');
    expect(mockWatcher.close).not.toHaveBeenCalled();
  });

  it('should close watcher when refCount reaches 0', async () => {
    await watcher.subscribe('agent-xxx', 'u_123');
    watcher.unsubscribe('agent-xxx:u_123');
    expect(mockWatcher.close).toHaveBeenCalledTimes(1);
  });

  it('should use default userId when none provided', async () => {
    const key = await watcher.subscribe('agent-xxx');
    expect(key).toBe('agent-xxx:default');
  });
});
