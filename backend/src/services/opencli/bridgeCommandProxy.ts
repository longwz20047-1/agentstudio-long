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
    command: { site: string; action: string; args: string[]; timeout?: number },
    historyContext?: { workingDirectory: string; bridgeId: string }
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
        const pending = this.pending.get(id);
        this.pending.delete(id);
        reject(new BridgeError('BRIDGE_TIMEOUT'));

        // Fire-and-forget: record timeout in history (after reject, so caller isn't blocked by disk I/O)
        if (pending?.historyContext) {
          import('./singletons.js').then(({ bridgeHistoryStore }) => {
            bridgeHistoryStore.recordExecution(
              pending.historyContext!.workingDirectory,
              pending.userId,
              {
                id,
                projectId: pending.projectId,
                bridgeId: pending.historyContext!.bridgeId,
                command: pending.historyContext!.command,
                status: 'timeout',
                exitCode: -1,
                stdout: '',
                stderr: `Command timed out after ${timeout}ms`,
                executedAt: pending.startedAt,
                completedAt: new Date().toISOString(),
                duration: timeout,
                userId: pending.userId,
                workingDirectory: pending.historyContext!.workingDirectory,
              }
            ).catch(err => console.error('[BridgeHistory] Failed to record timeout:', err));
          }).catch(() => {});
        }
      }, timeout);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        projectId,
        userId,
        startedAt: new Date().toISOString(),
        historyContext: historyContext
          ? {
              // command.args contains CLI arguments (query, --limit, --id, etc.)
              // action is passed separately and will be inserted by commandRunner
              command: `${command.site} ${command.action} ${command.args.join(' ')}`,
              workingDirectory: historyContext.workingDirectory,
              bridgeId: historyContext.bridgeId,
            }
          : undefined,
      });

      try {
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
      } catch (err) {
        // ws.send failed (connection closed between readyState check and send)
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError('BRIDGE_DISCONNECTED', `Failed to send command: ${(err as Error).message}`));
      }
    });
  }

  onResult(msg: ResultMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);

    // Fire-and-forget history recording
    if (pending.historyContext) {
      // Lazy import to avoid circular dep between bridgeCommandProxy ↔ singletons
      import('./singletons.js').then(({ bridgeHistoryStore }) => {
        bridgeHistoryStore.recordExecution(
          pending.historyContext!.workingDirectory,
          pending.userId,
          {
            id: msg.id,
            projectId: pending.projectId,
            bridgeId: pending.historyContext!.bridgeId,
            command: pending.historyContext!.command,
            status: msg.success ? 'success' : 'error',
            exitCode: msg.exitCode,
            stdout: msg.stdout,
            stderr: msg.stderr,
            executedAt: new Date(Date.now() - msg.durationMs).toISOString(),
            completedAt: new Date().toISOString(),
            duration: msg.durationMs,
            userId: pending.userId,
            workingDirectory: pending.historyContext!.workingDirectory,
          }
        ).catch(err => console.error('[BridgeHistory] Failed to record:', err));
      }).catch(() => {});
    }

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
