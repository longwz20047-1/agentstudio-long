import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ResultMessage } from '../types.js';
import { BridgeError } from '../types.js';
import { BridgeRegistry } from '../bridgeRegistry.js';
import { BridgeCommandProxy } from '../bridgeCommandProxy.js';

function createMockWs(overrides: Partial<{ readyState: number; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = {}) {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as any;
}

function registerBridge(registry: BridgeRegistry, ws: any, projectId = 'proj-1', userId = 'user@example.com') {
  registry.register(ws, {
    type: 'register',
    bridgeId: 'bridge-001',
    deviceName: 'dev-laptop',
    userId,
    projects: [{ projectId, projectName: 'Test Project' }],
    capabilities: {
      opencliVersion: '1.0.0',
      nodeVersion: '20.0.0',
      platform: 'win32',
      daemonRunning: true,
      extensionConnected: true,
      availableSites: ['twitter', 'reddit'],
    },
  });
}

describe('BridgeCommandProxy', () => {
  let registry: BridgeRegistry;
  let proxy: BridgeCommandProxy;

  beforeEach(() => {
    registry = new BridgeRegistry();
    proxy = new BridgeCommandProxy(registry);
  });

  it('throws BRIDGE_OFFLINE when no bridge registered', async () => {
    await expect(
      proxy.dispatch('proj-1', 'user@example.com', {
        site: 'twitter',
        action: 'search',
        args: ['query'],
      })
    ).rejects.toThrow(BridgeError);

    await expect(
      proxy.dispatch('proj-1', 'user@example.com', {
        site: 'twitter',
        action: 'search',
        args: ['query'],
      })
    ).rejects.toMatchObject({ code: 'BRIDGE_OFFLINE' });
  });

  it('throws BRIDGE_DISCONNECTED when WS is not open', async () => {
    const ws = createMockWs({ readyState: 3 }); // CLOSED
    registerBridge(registry, ws);

    await expect(
      proxy.dispatch('proj-1', 'user@example.com', {
        site: 'twitter',
        action: 'search',
        args: ['query'],
      })
    ).rejects.toMatchObject({ code: 'BRIDGE_DISCONNECTED' });
  });

  it('sends command to bridge and resolves on result', async () => {
    const ws = createMockWs();
    registerBridge(registry, ws);

    const promise = proxy.dispatch('proj-1', 'user@example.com', {
      site: 'twitter',
      action: 'search',
      args: ['hello'],
    });

    // Extract the command ID from the ws.send call
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sentPayload = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sentPayload.type).toBe('command');
    expect(sentPayload.site).toBe('twitter');
    expect(sentPayload.action).toBe('search');
    expect(sentPayload.args).toEqual(['hello']);
    expect(sentPayload.id).toBeDefined();

    const commandId = sentPayload.id;

    // Simulate bridge returning result
    const result: ResultMessage = {
      type: 'result',
      id: commandId,
      success: true,
      stdout: 'search results here',
      stderr: '',
      exitCode: 0,
      durationMs: 150,
    };
    proxy.onResult(result);

    const output = await promise;
    expect(output).toBe('search results here');
    expect(proxy.pendingCount).toBe(0);
  });

  it('rejects with EXEC_ERROR on failed result', async () => {
    const ws = createMockWs();
    registerBridge(registry, ws);

    const promise = proxy.dispatch('proj-1', 'user@example.com', {
      site: 'twitter',
      action: 'post',
      args: ['content'],
    });

    const sentPayload = JSON.parse(ws.send.mock.calls[0][0]);
    const commandId = sentPayload.id;

    // Simulate bridge returning error
    proxy.onResult({
      type: 'result',
      id: commandId,
      success: false,
      stdout: '',
      stderr: 'Authentication failed',
      exitCode: 1,
      durationMs: 50,
    });

    await expect(promise).rejects.toMatchObject({
      code: 'EXEC_ERROR',
      message: 'Authentication failed',
    });
  });

  it('rejects with BRIDGE_TIMEOUT after timeout', async () => {
    vi.useFakeTimers();
    try {
      const ws = createMockWs();
      registerBridge(registry, ws);

      const promise = proxy.dispatch('proj-1', 'user@example.com', {
        site: 'twitter',
        action: 'search',
        args: ['query'],
        timeout: 5000,
      });

      expect(proxy.pendingCount).toBe(1);

      // Advance past the timeout
      vi.advanceTimersByTime(5001);

      await expect(promise).rejects.toMatchObject({ code: 'BRIDGE_TIMEOUT' });
      expect(proxy.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejectAllForBridge clears pending commands', async () => {
    const ws = createMockWs();
    registerBridge(registry, ws);

    // Dispatch two commands
    const promise1 = proxy.dispatch('proj-1', 'user@example.com', {
      site: 'twitter',
      action: 'search',
      args: ['q1'],
      timeout: 60000,
    });
    const promise2 = proxy.dispatch('proj-1', 'user@example.com', {
      site: 'reddit',
      action: 'search',
      args: ['q2'],
      timeout: 60000,
    });

    expect(proxy.pendingCount).toBe(2);

    // Reject all for this bridge
    proxy.rejectAllForBridge('proj-1', 'user@example.com');

    await expect(promise1).rejects.toMatchObject({ code: 'BRIDGE_DISCONNECTED' });
    await expect(promise2).rejects.toMatchObject({ code: 'BRIDGE_DISCONNECTED' });
    expect(proxy.pendingCount).toBe(0);
  });

  it('rejectAllForBridge normalizes userId for matching', async () => {
    const ws = createMockWs();
    registerBridge(registry, ws, 'proj-1', 'User@Example.COM');

    const promise = proxy.dispatch('proj-1', 'User@Example.COM', {
      site: 'twitter',
      action: 'search',
      args: ['q1'],
      timeout: 60000,
    });

    // Call with different casing
    proxy.rejectAllForBridge('proj-1', '  user@example.com  ');

    await expect(promise).rejects.toMatchObject({ code: 'BRIDGE_DISCONNECTED' });
    expect(proxy.pendingCount).toBe(0);
  });

  it('onResult ignores unknown command IDs', () => {
    // Should not throw
    proxy.onResult({
      type: 'result',
      id: 'nonexistent-id',
      success: true,
      stdout: 'data',
      stderr: '',
      exitCode: 0,
      durationMs: 10,
    });

    expect(proxy.pendingCount).toBe(0);
  });

  it('uses DEFAULT_COMMAND_TIMEOUT when no timeout specified', async () => {
    vi.useFakeTimers();
    try {
      const ws = createMockWs();
      registerBridge(registry, ws);

      const promise = proxy.dispatch('proj-1', 'user@example.com', {
        site: 'twitter',
        action: 'search',
        args: ['query'],
        // no timeout specified — should use DEFAULT_COMMAND_TIMEOUT (30000)
      });

      // Verify the sent message includes the default timeout
      const sentPayload = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentPayload.timeout).toBe(30000);

      // Advance past default timeout
      vi.advanceTimersByTime(30001);

      await expect(promise).rejects.toMatchObject({ code: 'BRIDGE_TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });
});
