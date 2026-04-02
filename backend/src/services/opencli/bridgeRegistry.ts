import type { WebSocket } from 'ws';
import type { BridgeEntry, RegisterMessage, RegistryKey } from './types.js';

export class BridgeRegistry {
  private entries = new Map<RegistryKey, BridgeEntry>();

  private makeKey(projectId: string, userId: string): RegistryKey {
    const normalizedUserId = userId.trim().toLowerCase();
    return `${projectId}||${normalizedUserId}`;
  }

  register(ws: WebSocket, msg: RegisterMessage, keyId?: string): void {
    const normalizedUserId = msg.userId.trim().toLowerCase();
    const now = new Date();

    for (const project of msg.projects) {
      const key = this.makeKey(project.projectId, normalizedUserId);
      const existing = this.entries.get(key);

      // Device takeover: if entry exists with a different WS, notify old one then close
      if (existing && existing.ws !== ws) {
        try {
          existing.ws.send(JSON.stringify({
            type: 'device_replaced',
          }));
        } catch {
          // Old WS may already be dead — ignore send errors
        }
        // Close old WS after a short delay to allow the message to be delivered
        const oldWs = existing.ws;
        setTimeout(() => {
          try { oldWs.close(1000, 'device_replaced'); } catch {}
        }, 50);
      }

      this.entries.set(key, {
        bridgeId: msg.bridgeId,
        deviceName: msg.deviceName,
        userId: normalizedUserId,
        projectId: project.projectId,
        keyId,
        ws,
        status: 'online',
        connectedAt: now,
        lastHeartbeat: now,
        capabilities: msg.capabilities,
      });
    }
  }

  unregister(ws: WebSocket): BridgeEntry[] {
    const removed: BridgeEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.ws === ws) {
        removed.push(entry);
        this.entries.delete(key);
      }
    }
    return removed;
  }

  get(projectId: string, userId: string): BridgeEntry | undefined {
    const key = this.makeKey(projectId, userId);
    return this.entries.get(key);
  }

  isOnline(projectId: string, userId: string): boolean {
    const entry = this.get(projectId, userId);
    if (!entry) return false;
    return entry.status === 'online' && entry.ws.readyState === 1;
  }

  getAllForProject(projectId: string): BridgeEntry[] {
    const results: BridgeEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.projectId === projectId) {
        results.push(entry);
      }
    }
    return results;
  }

  getAllForKey(keyId: string): BridgeEntry[] {
    const results: BridgeEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.keyId === keyId) {
        results.push(entry);
      }
    }
    return results;
  }

  getAllForUser(userId: string): BridgeEntry[] {
    const normalizedUserId = userId.trim().toLowerCase();
    const results: BridgeEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.userId === normalizedUserId) {
        results.push(entry);
      }
    }
    return results;
  }

  updateHeartbeat(ws: WebSocket): void {
    const now = new Date();
    for (const entry of this.entries.values()) {
      if (entry.ws === ws) {
        entry.lastHeartbeat = now;
      }
    }
  }
}

export const bridgeRegistry = new BridgeRegistry();
