import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import { setupWebSocket, broadcastCronEvent, shutdownWebSocket } from '../websocketService.js';

// Mock jwt verification to always pass
vi.mock('../../utils/jwt.js', () => ({
  verifyToken: vi.fn().mockResolvedValue({ userId: 'test-user' }),
}));

// Mock sessionManager
vi.mock('../sessionManager.js', () => ({
  sessionManager: {
    getSessionsInfo: vi.fn().mockReturnValue([]),
    getActiveSessionCount: vi.fn().mockReturnValue(0),
    events: { on: vi.fn() },
  },
}));

// Mock workspaceWatcher
vi.mock('../workspaceWatcher.js', () => ({
  workspaceWatcher: {
    on: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  },
}));

// Mock agentMappingService for cron subscribe
vi.mock('../a2a/agentMappingService.js', () => ({
  resolveA2AId: vi.fn().mockResolvedValue({
    projectId: 'test-project',
    agentType: 'jarvis',
    workingDirectory: '/test/workspace',
  }),
}));

// Mock a2aCronStorage for cron sync
vi.mock('../a2a/a2aCronStorage.js', () => ({
  a2aCronStorage: {
    loadJobs: vi.fn().mockReturnValue([
      { id: 'cron_001', name: 'Test Job', enabled: true },
    ]),
  },
}));

describe('WebSocket Cron Channel', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer();
    setupWebSocket(server);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    shutdownWebSocket();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function connectClient(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  function waitForMessage(ws: WebSocket, timeoutMs = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs);
      ws.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    });
  }

  function expectNoMessage(ws: WebSocket, delayMs = 200): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), delayMs);
      ws.once('message', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  it('should subscribe to cron channel and receive cron:sync', async () => {
    const ws = await connectClient();
    try {
      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'cron', agentId: 'test-agent' }));
      const msg = await msgPromise;

      expect(msg.type).toBe('cron:sync');
      expect(msg.jobs).toHaveLength(1);
      expect(msg.jobs[0].id).toBe('cron_001');
      expect(msg.timestamp).toBeTypeOf('number');
    } finally {
      ws.close();
    }
  });

  it('should receive broadcastCronEvent after subscribing', async () => {
    const ws = await connectClient();
    try {
      // Subscribe first and consume the sync message
      const syncPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'cron', agentId: 'test-agent' }));
      await syncPromise;

      // Now broadcast an event
      const eventPromise = waitForMessage(ws);
      broadcastCronEvent('/test/workspace', {
        type: 'cron:started',
        jobId: 'cron_001',
        runId: 'run_abc123',
        timestamp: Date.now(),
      });
      const event = await eventPromise;

      expect(event.type).toBe('cron:started');
      expect(event.jobId).toBe('cron_001');
      expect(event.runId).toBe('run_abc123');
    } finally {
      ws.close();
    }
  });

  it('should NOT receive broadcastCronEvent for different workingDirectory', async () => {
    const ws = await connectClient();
    try {
      // Subscribe to /test/workspace
      const syncPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'cron', agentId: 'test-agent' }));
      await syncPromise;

      // Broadcast to a DIFFERENT workspace
      broadcastCronEvent('/other/workspace', {
        type: 'cron:started',
        jobId: 'cron_002',
        runId: 'run_other',
        timestamp: Date.now(),
      });

      // Should NOT receive this event
      const received = await expectNoMessage(ws);
      expect(received).toBe(false);
    } finally {
      ws.close();
    }
  });

  it('should stop receiving events after unsubscribe', async () => {
    const ws = await connectClient();
    try {
      // Subscribe
      const syncPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'cron', agentId: 'test-agent' }));
      await syncPromise;

      // Unsubscribe
      ws.send(JSON.stringify({ type: 'unsubscribe', channel: 'cron' }));
      await new Promise((r) => setTimeout(r, 50));

      // Broadcast — should NOT reach client
      broadcastCronEvent('/test/workspace', {
        type: 'cron:completed',
        jobId: 'cron_001',
        runId: 'run_001',
        status: 'success',
        timestamp: Date.now(),
      });

      const received = await expectNoMessage(ws);
      expect(received).toBe(false);
    } finally {
      ws.close();
    }
  });

  it('should NOT receive events without subscribing', async () => {
    const ws = await connectClient();
    try {
      broadcastCronEvent('/test/workspace', {
        type: 'cron:started',
        jobId: 'cron_001',
        runId: 'run_001',
        timestamp: Date.now(),
      });

      const received = await expectNoMessage(ws);
      expect(received).toBe(false);
    } finally {
      ws.close();
    }
  });
});
