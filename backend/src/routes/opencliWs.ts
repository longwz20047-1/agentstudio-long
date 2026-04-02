import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import crypto from 'crypto';
import { bridgeRegistry, bridgeCommandProxy, bridgeKeyService } from '../services/opencli/singletons.js';
import { HEARTBEAT_INTERVAL, MAX_MISSED_HEARTBEATS } from '../services/opencli/constants.js';
import type { RegisterMessage, ResultMessage } from '../services/opencli/types.js';
import { BridgeError } from '../services/opencli/types.js';
import { broadcastOpenCliBridgeEvent } from '../services/websocketService.js';

const wssOpenCLI = new WebSocketServer({ noServer: true });

// Rate limiter: max 10 upgrades per key per minute
const wsRateLimiter = new Map<string, { count: number; resetAt: number }>();
function isRateLimited(apiKey: string): boolean {
  const now = Date.now();
  const entry = wsRateLimiter.get(apiKey);
  if (!entry || now > entry.resetAt) {
    wsRateLimiter.set(apiKey, { count: 1, resetAt: now + 60000 });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

// Cleanup expired rate limiter entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of wsRateLimiter) {
    if (now > entry.resetAt) wsRateLimiter.delete(key);
  }
}, 5 * 60 * 1000);

// ── Remote Diagnostics ────────────────────────────────────────────────────────

interface PendingDiagnose {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  ws: WebSocket;  // Track which bridge WS this belongs to for cleanup scoping
}

const pendingDiagnose = new Map<string, PendingDiagnose>();
const DIAGNOSE_TIMEOUT_MS = 10_000;

/** Called from POST /api/opencli/diagnose — sends diagnose request to bridge, awaits result. */
export function requestDiagnose(projectId: string, userId: string): Promise<any> {
  const entry = bridgeRegistry.get(projectId, userId);
  if (!entry) throw new BridgeError('BRIDGE_OFFLINE');
  if ((entry.ws as any).readyState !== 1) throw new BridgeError('BRIDGE_DISCONNECTED');

  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDiagnose.delete(id);
      reject(new Error('Diagnostics timed out after 10s'));
    }, DIAGNOSE_TIMEOUT_MS);

    pendingDiagnose.set(id, { resolve, reject, timer, ws: entry.ws });
    entry.ws.send(JSON.stringify({ type: 'diagnose', id }));
  });
}

// ── WebSocket Server Setup ────────────────────────────────────────────────────

export function setupOpenCliBridgeWs(server: Server): void {
  server.on('upgrade', async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname !== '/api/opencli/bridge') return;

    // Priority 1: Long-lived bridge key (normal connection)
    const bridgeKey = request.headers['x-bridge-key'] as string;
    if (bridgeKey) {
      const validated = await bridgeKeyService.validateBridgeKey(bridgeKey);
      if (!validated) {
        // Return 4001 close code instead of socket.destroy()
        socket.write('HTTP/1.1 401 Unauthorized\r\n');
        socket.write('Connection: close\r\n');
        socket.write('X-Bridge-Close-Code: 4001\r\n');
        socket.write('\r\n');
        socket.end();
        return;
      }
      if (isRateLimited(bridgeKey)) { socket.destroy(); return; }

      wssOpenCLI.handleUpgrade(request, socket, head, (ws) => {
        handleBridgeConnection(ws, validated.userId, false, validated.keyId);
      });
      return;
    }

    // Priority 2: One-time pairing token (first-time pairing)
    const pairingToken = request.headers['x-bridge-pairing-token'] as string;
    if (pairingToken) {
      const result = bridgeKeyService.consumePairingToken(pairingToken);
      if (!result) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nX-Bridge-Close-Code: 4002\r\n\r\n');
        socket.destroy();
        return;
      }

      wssOpenCLI.handleUpgrade(request, socket, head, (ws) => {
        handleBridgeConnection(ws, result.userId, true);
      });
      return;
    }

    // No auth header
    socket.destroy();
  });
}

function handleBridgeConnection(ws: WebSocket, userId: string, isPairing: boolean, keyId?: string): void {
  let missedHeartbeats = 0;

  const heartbeatInterval = setInterval(() => {
    if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
      console.warn(`[OpenCLI Bridge] Too many missed heartbeats, disconnecting`);
      ws.close();
      return;
    }
    missedHeartbeats++;
    ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
  }, HEARTBEAT_INTERVAL);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'register':
          // Security: override client-declared userId with server-authenticated userId
          msg.userId = userId;
          if (isPairing) {
            // Pairing mode: generate permanent key, send to bridge, close
            const key = await bridgeKeyService.generateBridgeKey(
              userId, msg.deviceName, msg.bridgeId
            );
            ws.send(JSON.stringify({ type: 'paired', obkKey: key }));
            console.log(`[OpenCLI Bridge] Paired: ${msg.deviceName} → key issued`);
            ws.close(1000, 'Pairing complete');
            return;
          }
          // Normal mode
          bridgeRegistry.register(ws, msg as RegisterMessage, keyId);
          console.log(`[OpenCLI Bridge] Registered: ${msg.deviceName} (${msg.projects?.length || 0} projects)`);

          // Broadcast online event for each registered project (re-connect case)
          const registered = msg as RegisterMessage;
          for (const project of registered.projects || []) {
            broadcastOpenCliBridgeEvent(project.projectId, registered.userId, {
              type: 'opencli:online',
              projectId: project.projectId,
              userId: registered.userId,
              bridgeId: registered.bridgeId,
              timestamp: Date.now(),
            });
          }
          break;

        case 'result':
          bridgeCommandProxy.onResult(msg as ResultMessage);
          break;

        case 'pong':
          missedHeartbeats = 0;
          bridgeRegistry.updateHeartbeat(ws);
          break;

        case 'diagnose_result': {
          const pending = pendingDiagnose.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingDiagnose.delete(msg.id);
            pending.resolve(msg);
          }
          break;
        }
      }
    } catch (err) {
      console.error('[OpenCLI Bridge] Invalid message:', err);
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeatInterval);
    const removed = bridgeRegistry.unregister(ws);

    for (const entry of removed) {
      bridgeCommandProxy.rejectAllForBridge(entry.projectId, entry.userId);
      console.log(`[OpenCLI Bridge] Disconnected: ${entry.deviceName} (${entry.projectId})`);

      // Broadcast offline event to subscribed browser clients
      broadcastOpenCliBridgeEvent(entry.projectId, entry.userId, {
        type: 'opencli:offline',
        projectId: entry.projectId,
        userId: entry.userId,
        bridgeId: entry.bridgeId,
        timestamp: Date.now(),
        reason: 'bridge disconnected',
      });
    }

    // Reject pending diagnose requests scoped to THIS bridge WS
    // (don't reject requests for other bridges still connected)
    for (const [id, pending] of pendingDiagnose) {
      if (pending.ws === ws) {
        clearTimeout(pending.timer);
        pendingDiagnose.delete(id);
        pending.reject(new Error('Bridge disconnected during diagnostics'));
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[OpenCLI Bridge] WS error:', err.message);
  });
}
