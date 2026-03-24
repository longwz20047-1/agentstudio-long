import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { bridgeRegistry, bridgeCommandProxy, bridgeKeyService } from '../services/opencli/singletons.js';
import { HEARTBEAT_INTERVAL, MAX_MISSED_HEARTBEATS } from '../services/opencli/constants.js';
import type { RegisterMessage, ResultMessage } from '../services/opencli/types.js';

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

export function setupOpenCliBridgeWs(server: Server): void {
  server.on('upgrade', async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname !== '/api/opencli/bridge') return;

    // Priority 1: Long-lived bridge key (normal connection)
    const bridgeKey = request.headers['x-bridge-key'] as string;
    if (bridgeKey) {
      const userId = await bridgeKeyService.validateBridgeKey(bridgeKey);
      if (!userId) { socket.destroy(); return; }
      if (isRateLimited(bridgeKey)) { socket.destroy(); return; }

      wssOpenCLI.handleUpgrade(request, socket, head, (ws) => {
        handleBridgeConnection(ws, userId, false);
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

function handleBridgeConnection(ws: WebSocket, userId: string, isPairing: boolean): void {
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
