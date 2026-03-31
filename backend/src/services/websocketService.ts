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
  subscribedSessions?: { userId?: string };  // undefined = 未订阅
  subscribedCronDirs: Set<string>; // supports multiple project workingDirectories
  subscribedCronAll?: {
    userId: string;
    workDirs: Set<string>;
  };
}

let wss: WebSocketServer | null = null;
const clients = new Set<WSClient>();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// 模块级懒缓存: ProjectMetadataStorage 实例
let _cachedProjectStorage: any = null;
async function getProjectStorage() {
  if (!_cachedProjectStorage) {
    const { ProjectMetadataStorage } = await import('./projectMetadataStorage.js');
    _cachedProjectStorage = new ProjectMetadataStorage();
  }
  return _cachedProjectStorage;
}

async function authenticateToken(token: string): Promise<boolean> {
  if (process.env.NO_AUTH === 'true') return true;
  if (typeof token !== 'string' || token.length === 0) return false;
  const payload = await verifyToken(token);
  return payload !== null;
}

function sendSafe(client: WSClient, message: string): void {
  try {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  } catch {
    // Send failure — connection will be cleaned up by heartbeat
  }
}

export function setupWebSocket(server: Server): void {
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }); // 64KB max message size

  server.on('upgrade', async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      if (url.pathname !== '/ws') {
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
    const client: WSClient = { ws, apiKey: token, isAlive: true, subscribedCronDirs: new Set() };
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
      for (const client of clients) {
        if (!client.subscribedSessions) continue;  // undefined = 未订阅
        const userId = client.subscribedSessions.userId;
        const sessions = sessionManager.getSessionsInfo(userId);
        sendSafe(client, JSON.stringify({
          type: 'session:update',
          sessions,
          activeSessionCount: sessions.filter((s: any) => s.isActive).length,
          timestamp: Date.now(),
        }));
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
      const userId = msg.userId || undefined;
      client.subscribedSessions = { userId };
      // 立即推送 (按 userId 过滤)
      const sessions = sessionManager.getSessionsInfo(userId);
      sendSafe(client, JSON.stringify({
        type: 'session:update',
        sessions,
        activeSessionCount: sessions.filter((s: any) => s.isActive).length,
        timestamp: Date.now(),
      }));
    } else if (msg.channel === 'cron' && typeof msg.agentId === 'string') {
      try {
        const { resolveA2AId } = await import('./a2a/agentMappingService.js');
        const mapping = await resolveA2AId(msg.agentId);
        if (mapping) {
          client.subscribedCronDirs.add(mapping.workingDirectory);
          // Send initial sync for this project
          const { a2aCronStorage } = await import('./a2a/a2aCronStorage.js');
          const { maskJobContext } = await import('./a2a/a2aCronUtils.js');
          const jobs = a2aCronStorage.loadJobs(mapping.workingDirectory);
          sendSafe(client, JSON.stringify({ type: 'cron:sync', jobs: jobs.map(maskJobContext), timestamp: Date.now() }));
        }
      } catch (err) {
        console.warn('[WebSocket] Failed to subscribe cron:', err);
      }
    } else if (msg.channel === 'cron-all' && typeof msg.userId === 'string') {
      try {
        const projectMetadataStorage = await getProjectStorage();
        const { projectUserStorage } = await import('./projectUserStorage.js');
        const { listAgentMappings } = await import('./a2a/agentMappingService.js');
        const { listApiKeysWithDecryption } = await import('./a2a/apiKeyService.js');
        const { a2aCronStorage } = await import('./a2a/a2aCronStorage.js');
        const { maskJobContext } = await import('./a2a/a2aCronUtils.js');

        const allProjects = projectMetadataStorage.getAllProjects();
        const allMappings = await listAgentMappings();
        const workDirs = new Set<string>();

        const projects: any[] = [];
        for (const project of allProjects) {
          if (!projectUserStorage.canUserAccessProject(project.id, msg.userId)) continue;

          const mapping = allMappings.find((m: any) => m.workingDirectory === project.path);
          if (!mapping) continue;

          const keys = await listApiKeysWithDecryption(mapping.workingDirectory);
          const validKey = keys.find((k: any) => !k.revokedAt && k.decryptedKey);
          if (!validKey) continue;

          const jobs = a2aCronStorage.loadJobs(mapping.workingDirectory);
          workDirs.add(mapping.workingDirectory);

          projects.push({
            projectPath: mapping.workingDirectory,
            projectName: project.name,
            agentId: mapping.a2aAgentId,
            apiKey: validKey.decryptedKey,
            agentLabel: project.defaultAgentName || project.name,
            jobs: jobs.map(maskJobContext),
          });
        }

        client.subscribedCronAll = { userId: msg.userId, workDirs };
        sendSafe(client, JSON.stringify({ type: 'cron-all:sync', projects, timestamp: Date.now() }));
      } catch (err) {
        console.warn('[WebSocket] Failed to subscribe cron-all:', err);
      }
    }
  } else if (msg.type === 'unsubscribe') {
    if (msg.channel === 'workspace' && client.workspace) {
      workspaceWatcher.unsubscribe(client.workspace.watchKey);
      client.workspace = undefined;
    } else if (msg.channel === 'sessions') {
      client.subscribedSessions = undefined;
    } else if (msg.channel === 'cron') {
      client.subscribedCronDirs.clear();
    } else if (msg.channel === 'cron-all') {
      client.subscribedCronAll = undefined;
    }
  }
}

function cleanupClient(client: WSClient): void {
  if (client.workspace) {
    workspaceWatcher.unsubscribe(client.workspace.watchKey);
    client.workspace = undefined;
  }
  client.subscribedSessions = undefined;
  client.subscribedCronDirs.clear();
  client.subscribedCronAll = undefined;
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
    if (client.subscribedCronDirs.has(workingDirectory)) {
      sendSafe(client, message);
    }
    // else if 防止同一 client 双推 (per-project 和 cron-all 只收一次)
    else if (client.subscribedCronAll?.workDirs.has(workingDirectory)) {
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
