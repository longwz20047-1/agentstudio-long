import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';

// Mock dependencies
vi.mock('../a2a/agentMappingService.js', () => ({
  listAgentMappings: vi.fn().mockResolvedValue([
    { a2aAgentId: 'agent-xxx', workingDirectory: '/projects/myproject' },
  ]),
}));

vi.mock('../sessionManager.js', () => {
  const { EventEmitter } = require('events');
  const events = new EventEmitter();
  return {
    sessionManager: {
      events,
      getSessionsInfo: vi.fn().mockReturnValue([]),
      getActiveSessionCount: vi.fn().mockReturnValue(0),
    },
  };
});

vi.mock('../workspaceWatcher.js', () => {
  const { EventEmitter } = require('events');
  const watcher = Object.assign(new EventEmitter(), {
    subscribe: vi.fn().mockResolvedValue('agent-xxx:default'),
    unsubscribe: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  });
  return { workspaceWatcher: watcher };
});

vi.mock('../../utils/jwt.js', () => ({
  verifyToken: vi.fn().mockImplementation(async (token: string) => {
    if (token === 'valid-jwt') return { authenticated: true };
    return null;
  }),
}));

import { setupWebSocket, shutdownWebSocket } from '../websocketService.js';

describe('websocketService', () => {
  let server: http.Server;
  let port: number;

  beforeEach(() => {
    return new Promise<void>((resolve) => {
      server = http.createServer();
      setupWebSocket(server);
      server.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    shutdownWebSocket();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.NO_AUTH;
  });

  it('should reject connection without valid token', () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=bad-key`);
      ws.on('error', () => {
        resolve();
      });
      ws.on('open', () => {
        ws.close();
        reject(new Error('Should have been rejected'));
      });
      setTimeout(() => resolve(), 2000);
    });
  });

  it('should accept connection with valid JWT token', () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=valid-jwt`);
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', (err) => {
        reject(err);
      });
    });
  });

  it('should accept connection when NO_AUTH is set', () => {
    process.env.NO_AUTH = 'true';
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=any-string`);
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', (err) => {
        reject(err);
      });
    });
  });
});
