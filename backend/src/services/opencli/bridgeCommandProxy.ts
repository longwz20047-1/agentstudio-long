import crypto from 'crypto';
import { BridgeError, type PendingCommand, type ResultMessage } from './types.js';
import type { BridgeRegistry } from './bridgeRegistry.js';
import { DEFAULT_COMMAND_TIMEOUT } from './constants.js';

export class BridgeCommandProxy {
  private pending = new Map<string, PendingCommand>();

  constructor(private registry: BridgeRegistry) {}

  async dispatch(
    projectId: string,
    userId: string,
    command: { site: string; action: string; args: string[]; timeout?: number }
  ): Promise<string> {
    const entry = this.registry.get(projectId, userId);
    if (!entry) {
      throw new BridgeError('BRIDGE_OFFLINE');
    }
    if ((entry.ws as any).readyState !== 1) {
      throw new BridgeError('BRIDGE_DISCONNECTED');
    }

    const id = crypto.randomUUID();
    const timeout = command.timeout || DEFAULT_COMMAND_TIMEOUT;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('BRIDGE_TIMEOUT'));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer, projectId, userId });

      entry.ws.send(
        JSON.stringify({
          type: 'command',
          id,
          site: command.site,
          action: command.action,
          args: command.args,
          timeout,
        })
      );
    });
  }

  onResult(msg: ResultMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);

    if (msg.success) {
      pending.resolve(msg.stdout);
    } else {
      pending.reject(new BridgeError('EXEC_ERROR', msg.stderr || `Exit code: ${msg.exitCode}`));
    }
  }

  rejectAllForBridge(projectId: string, userId: string): void {
    const normalizedUserId = userId.trim().toLowerCase();
    for (const [id, cmd] of this.pending) {
      if (cmd.projectId === projectId && cmd.userId.trim().toLowerCase() === normalizedUserId) {
        clearTimeout(cmd.timer);
        this.pending.delete(id);
        cmd.reject(new BridgeError('BRIDGE_DISCONNECTED'));
      }
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
