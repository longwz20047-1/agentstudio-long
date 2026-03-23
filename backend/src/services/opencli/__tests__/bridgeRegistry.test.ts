import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RegisterMessage } from '../types.js';

// Inline the class so we get a fresh instance per test (no singleton leak)
// We test the actual file via a separate import after writing it
let BridgeRegistry: typeof import('../bridgeRegistry.js').BridgeRegistry;

beforeEach(async () => {
  // Dynamic import to pick up the implementation once it exists
  const mod = await import('../bridgeRegistry.js');
  BridgeRegistry = mod.BridgeRegistry;
});

function createMockWs(overrides: Partial<{ readyState: number; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = {}) {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as any;
}

function createRegisterMsg(overrides: Partial<RegisterMessage> = {}): RegisterMessage {
  return {
    type: 'register',
    bridgeId: 'bridge-001',
    deviceName: 'dev-laptop',
    userId: 'user@example.com',
    projects: [{ projectId: 'proj-1', projectName: 'My Project' }],
    capabilities: {
      opencliVersion: '1.0.0',
      nodeVersion: '20.0.0',
      platform: 'win32',
      daemonRunning: true,
      extensionConnected: true,
      availableSites: ['twitter', 'reddit'],
    },
    ...overrides,
  };
}

describe('BridgeRegistry', () => {
  let registry: InstanceType<typeof BridgeRegistry>;

  beforeEach(() => {
    registry = new BridgeRegistry();
  });

  it('registers a bridge and marks it online', () => {
    const ws = createMockWs();
    const msg = createRegisterMsg();

    registry.register(ws, msg);

    const entry = registry.get('proj-1', 'user@example.com');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('online');
    expect(entry!.bridgeId).toBe('bridge-001');
    expect(entry!.deviceName).toBe('dev-laptop');
    expect(entry!.ws).toBe(ws);
  });

  it('normalizes userId to lowercase', () => {
    const ws = createMockWs();
    const msg = createRegisterMsg({ userId: '  User@Example.COM  ' });

    registry.register(ws, msg);

    // Lookup with various casings should all find the entry
    expect(registry.get('proj-1', 'user@example.com')).toBeDefined();
    expect(registry.get('proj-1', 'USER@EXAMPLE.COM')).toBeDefined();
    expect(registry.get('proj-1', '  User@Example.COM  ')).toBeDefined();

    // isOnline also normalizes
    expect(registry.isOnline('proj-1', 'USER@example.com')).toBe(true);
  });

  it('registers multiple projects from one WS', () => {
    const ws = createMockWs();
    const msg = createRegisterMsg({
      projects: [
        { projectId: 'proj-a', projectName: 'A' },
        { projectId: 'proj-b', projectName: 'B' },
        { projectId: 'proj-c', projectName: 'C' },
      ],
    });

    registry.register(ws, msg);

    expect(registry.get('proj-a', 'user@example.com')).toBeDefined();
    expect(registry.get('proj-b', 'user@example.com')).toBeDefined();
    expect(registry.get('proj-c', 'user@example.com')).toBeDefined();
  });

  it('unregisters all entries for a WS and returns removed entries', () => {
    const ws = createMockWs();
    const msg = createRegisterMsg({
      projects: [
        { projectId: 'proj-a', projectName: 'A' },
        { projectId: 'proj-b', projectName: 'B' },
      ],
    });

    registry.register(ws, msg);
    const removed = registry.unregister(ws);

    expect(removed).toHaveLength(2);
    expect(removed.map(e => e.projectId).sort()).toEqual(['proj-a', 'proj-b']);
    expect(registry.get('proj-a', 'user@example.com')).toBeUndefined();
    expect(registry.get('proj-b', 'user@example.com')).toBeUndefined();
  });

  it('device takeover: last WS wins and old WS receives device_replaced', () => {
    const oldWs = createMockWs();
    const newWs = createMockWs();
    const msg = createRegisterMsg();

    registry.register(oldWs, msg);
    registry.register(newWs, msg);

    // Old WS should have received device_replaced message
    expect(oldWs.send).toHaveBeenCalledTimes(1);
    const sentData = JSON.parse(oldWs.send.mock.calls[0][0]);
    expect(sentData.type).toBe('device_replaced');

    // New WS is the active one
    const entry = registry.get('proj-1', 'user@example.com');
    expect(entry!.ws).toBe(newWs);

    // Old WS should NOT have been closed (caller handles that)
    expect(oldWs.close).not.toHaveBeenCalled();
  });

  it('get() returns undefined for unknown bridge', () => {
    expect(registry.get('nonexistent', 'nobody@example.com')).toBeUndefined();
  });

  it('isOnline returns false when WS is not in OPEN state', () => {
    const ws = createMockWs({ readyState: 3 }); // CLOSED
    const msg = createRegisterMsg();

    registry.register(ws, msg);

    expect(registry.isOnline('proj-1', 'user@example.com')).toBe(false);
  });

  it('getAllForProject returns correct entries', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    registry.register(ws1, createRegisterMsg({
      userId: 'alice@example.com',
      projects: [{ projectId: 'shared-proj', projectName: 'Shared' }],
    }));
    registry.register(ws2, createRegisterMsg({
      userId: 'bob@example.com',
      bridgeId: 'bridge-002',
      projects: [
        { projectId: 'shared-proj', projectName: 'Shared' },
        { projectId: 'bob-only', projectName: 'Bob Only' },
      ],
    }));

    const sharedEntries = registry.getAllForProject('shared-proj');
    expect(sharedEntries).toHaveLength(2);
    expect(sharedEntries.map(e => e.userId).sort()).toEqual(['alice@example.com', 'bob@example.com']);

    const bobEntries = registry.getAllForProject('bob-only');
    expect(bobEntries).toHaveLength(1);
    expect(bobEntries[0].userId).toBe('bob@example.com');
  });

  it('getAllForUser returns entries with normalized userId', () => {
    const ws = createMockWs();
    registry.register(ws, createRegisterMsg({
      userId: 'Alice@Example.COM',
      projects: [
        { projectId: 'p1', projectName: 'P1' },
        { projectId: 'p2', projectName: 'P2' },
      ],
    }));

    const entries = registry.getAllForUser('alice@example.com');
    expect(entries).toHaveLength(2);
  });

  it('updateHeartbeat updates lastHeartbeat for all matching entries', () => {
    const ws = createMockWs();
    registry.register(ws, createRegisterMsg({
      projects: [
        { projectId: 'p1', projectName: 'P1' },
        { projectId: 'p2', projectName: 'P2' },
      ],
    }));

    const beforeTime = new Date();
    // Small delay to ensure time difference
    registry.updateHeartbeat(ws);

    const entry1 = registry.get('p1', 'user@example.com');
    const entry2 = registry.get('p2', 'user@example.com');
    expect(entry1!.lastHeartbeat.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    expect(entry2!.lastHeartbeat.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
  });
});
