import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { URL } from 'url';
import { sessionManager } from './sessionManager.js';
import { workspaceWatcher } from './workspaceWatcher.js';
import type { FileChange } from './workspaceWatcher.js';
import { verifyToken } from '../utils/jwt.js';

interface WSClient {
  ws: WebSocket;
  apiKey: string;
  isAlive: boolean;
  workspace?: {
    agentId: string;
    userId?: string;
    watchKey: string;
  };
  subscribedSessions: boolean;
  subscribedCron?: { workingDirectory: string };
}

let wss: WebSocketServer | null = null;
const clients = new Set<WSClient>();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

async function authenticateToken(token: string): Promise<boolean> {
  if (process.env.NO_AUTH === 'true') return true;
  if (typeof token !== 'string' || token.length === 0) return false;
  const payload = await verifyToken(token);
  return payload !== null;
}

function buildSessionMessage(): string {
  return JSON.stringify({
    type: 'session:update',
    sessions: sessionManager.getSessionsInfo(),
    activeSessionCount: sessionManager.getActiveSessionCount(),
    timestamp: Date.now(),
  });
}

function sendSafe(client: WSClient, message: string): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(message);
  }
}

export function setupWebSocket(server: Server): void {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token');
      if (!token || !(await authenticateToken(token))) {
        socket.destroy();
        return;
      }
      wss!.handleUpgrade(request, socket, head, (ws) => {
        wss!.emit('connection', ws, request, token);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, token: string) => {
    const client: WSClient = { ws, apiKey: token, isAlive: true, subscribedSessions: false };
    clients.add(client);

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (typeof msg?.type !== 'string') return;
        await handleClientMessage(client, msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      cleanupClient(client);
      clients.delete(client);
    });

    ws.on('error', (err) => {
      console.error('[WebSocket] Client error:', err.message);
    });

    ws.on('pong', () => {
      client.isAlive = true;
    });
  });

  // Heartbeat: detect and terminate dead connections
  heartbeatInterval = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        cleanupClient(client);
        clients.delete(client);
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }, 30000);

  workspaceWatcher.on('changes', (watchKey: string, changes: FileChange[]) => {
    try {
      const message = changes.length === 1
        ? JSON.stringify({
            type: 'workspace:change',
            event: changes[0].event,
            path: changes[0].path,
            timestamp: Date.now(),
          })
        : JSON.stringify({
            type: 'workspace:batch',
            changes,
            timestamp: Date.now(),
          });

      for (const client of clients) {
        if (client.workspace?.watchKey === watchKey) {
          sendSafe(client, message);
        }
      }
    } catch (err) {
      console.error('[WebSocket] Broadcast workspace error:', err);
    }
  });

  sessionManager.events.on('session:changed', () => {
    try {
      const message = buildSessionMessage();
      for (const client of clients) {
        if (client.subscribedSessions) {
          sendSafe(client, message);
        }
      }
    } catch (err) {
      console.error('[WebSocket] Broadcast session error:', err);
    }
  });

  console.log('[WebSocket] Service initialized');
}

async function handleClientMessage(client: WSClient, msg: any): Promise<void> {
  if (msg.type === 'subscribe') {
    if (msg.channel === 'workspace' && typeof msg.agentId === 'string') {
      // Skip if already subscribed to the same workspace
      if (client.workspace?.agentId === msg.agentId && client.workspace?.userId === msg.userId) return;
      if (client.workspace) {
        workspaceWatcher.unsubscribe(client.workspace.watchKey);
      }
      try {
        const watchKey = await workspaceWatcher.subscribe(msg.agentId, msg.userId);
        client.workspace = { agentId: msg.agentId, userId: msg.userId, watchKey };
      } catch (err) {
        console.warn('[WebSocket] Failed to subscribe workspace:', err);
      }
    } else if (msg.channel === 'sessions') {
      if (!client.subscribedSessions) {
        client.subscribedSessions = true;
        try { sendSafe(client, buildSessionMessage()); } catch { /* ignore */ }
      }
    } else if (msg.channel === 'cron' && typeof msg.agentId === 'string') {
      try {
        const { resolveA2AId } = await import('./a2a/agentMappingService.js');
        const mapping = await resolveA2AId(msg.agentId);
        if (mapping) {
          client.subscribedCron = { workingDirectory: mapping.workingDirectory };
          // Send initial sync
          const { a2aCronStorage } = await import('./a2a/a2aCronStorage.js');
          const jobs = a2aCronStorage.loadJobs(mapping.workingDirectory);
          sendSafe(client, JSON.stringify({ type: 'cron:sync', jobs, timestamp: Date.now() }));
        }
      } catch (err) {
        console.warn('[WebSocket] Failed to subscribe cron:', err);
      }
    }
  } else if (msg.type === 'unsubscribe') {
    if (msg.channel === 'workspace' && client.workspace) {
      workspaceWatcher.unsubscribe(client.workspace.watchKey);
      client.workspace = undefined;
    } else if (msg.channel === 'sessions') {
      client.subscribedSessions = false;
    } else if (msg.channel === 'cron') {
      client.subscribedCron = undefined;
    }
  }
}

function cleanupClient(client: WSClient): void {
  if (client.workspace) {
    workspaceWatcher.unsubscribe(client.workspace.watchKey);
    client.workspace = undefined;
  }
  client.subscribedSessions = false;
  client.subscribedCron = undefined;
}

export function broadcastCronEvent(workingDirectory: string, event: {
  type: 'cron:started' | 'cron:completed' | 'cron:error';
  jobId: string;
  runId: string;
  status?: string;
  responseSummary?: string;
  timestamp: number;
}): void {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.subscribedCron?.workingDirectory === workingDirectory) {
      sendSafe(client, message);
    }
  }
}

export function shutdownWebSocket(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  for (const client of clients) {
    cleanupClient(client);
    client.ws.close();
  }
  clients.clear();
  wss?.close();
  wss = null;
  console.log('[WebSocket] Service shut down');
}
