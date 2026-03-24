import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { validateBridgeKey } from '../services/opencli/bridgeKeyService.js';
import { bridgeRegistry, bridgeCommandProxy } from '../services/opencli/singletons.js';
import { HEARTBEAT_INTERVAL, MAX_MISSED_HEARTBEATS } from '../services/opencli/constants.js';
import type { RegisterMessage, ResultMessage } from '../services/opencli/types.js';

const wssOpenCLI = new WebSocketServer({ noServer: true });

// Rate limiter
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

export function setupOpenCliBridgeWs(server: Server): void {
  server.on('upgrade', async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname !== '/api/opencli/bridge') return;

    const apiKey = request.headers['x-bridge-key'] as string;
    if (!apiKey) { socket.destroy(); return; }

    const userId = await validateBridgeKey(apiKey);
    if (!userId) { socket.destroy(); return; }
    if (isRateLimited(apiKey)) { socket.destroy(); return; }

    wssOpenCLI.handleUpgrade(request, socket, head, (ws) => {
      handleBridgeConnection(ws, userId);
    });
  });
}

function handleBridgeConnection(ws: WebSocket, userId: string): void {
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

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'register':
          bridgeRegistry.register(ws, msg as RegisterMessage);
          console.log(`[OpenCLI Bridge] Registered: ${msg.deviceName} (${msg.projects?.length || 0} projects)`);
          break;
        case 'result':
          bridgeCommandProxy.onResult(msg as ResultMessage);
          break;
        case 'pong':
          missedHeartbeats = 0;
          bridgeRegistry.updateHeartbeat(ws);
          break;
        case 'diagnose_result':
          console.log(`[OpenCLI Bridge] Diagnose:`, msg);
          break;
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
    }
  });

  ws.on('error', (err) => {
    console.error('[OpenCLI Bridge] WS error:', err.message);
  });
}
