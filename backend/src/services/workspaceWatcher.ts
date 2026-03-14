import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import path from 'path';
import { EventEmitter } from 'events';
import { resolveA2AId } from './a2a/agentMappingService.js';
import { resolveUserWorkspacePath } from '../utils/workspaceUtils.js';

export interface FileChange {
  event: string;  // 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string;   // relative to workspace root
}

interface WatcherEntry {
  watcher: FSWatcher;
  refCount: number;
  workspacePath: string;
}

export class WorkspaceWatcher extends EventEmitter {
  private watchers = new Map<string, WatcherEntry>();
  private pendingChanges = new Map<string, FileChange[]>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private subscribing = new Set<string>();

  async subscribe(agentId: string, userId?: string): Promise<string> {
    const watchKey = `${agentId}:${userId || 'default'}`;
    const existing = this.watchers.get(watchKey);
    if (existing) {
      existing.refCount++;
      return watchKey;
    }
    // Prevent concurrent creation for the same key; still count the ref
    if (this.subscribing.has(watchKey)) {
      // A watcher is being created — wait briefly then bump refCount
      await new Promise(resolve => setTimeout(resolve, 100));
      const created = this.watchers.get(watchKey);
      if (created) created.refCount++;
      return watchKey;
    }
    this.subscribing.add(watchKey);

    try {
      const mapping = await resolveA2AId(agentId);
      if (!mapping) throw new Error(`Unknown agentId: ${agentId}`);
      const workspacePath = await resolveUserWorkspacePath(mapping.workingDirectory, userId);

      const watcher = chokidar.watch(workspacePath, {
        ignoreInitial: true,
        ignored: [
          // Dotfiles/dotdirs EXCEPT .workspaces (agent working directories)
          /(^|[/\\])\.(?!workspaces([/\\]|$))/,
          '**/node_modules/**',
          '**/__pycache__/**',
        ],
        persistent: true,
        depth: 10,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100,
        },
      });

      const events = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const;
      for (const event of events) {
        watcher.on(event, (filePath: string) => {
          this.onFileChange(watchKey, event, filePath, workspacePath);
        });
      }

      console.log(`[WorkspaceWatcher] Watching ${workspacePath} (key: ${watchKey})`);
      watcher.on('error', (err) => {
        console.error(`[WorkspaceWatcher] Error on ${watchKey}:`, err);
      });

      this.watchers.set(watchKey, { watcher, refCount: 1, workspacePath });
      return watchKey;
    } finally {
      this.subscribing.delete(watchKey);
    }
  }

  unsubscribe(watchKey: string): void {
    const entry = this.watchers.get(watchKey);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      this.watchers.delete(watchKey);
      const timer = this.debounceTimers.get(watchKey);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(watchKey);
      }
      this.pendingChanges.delete(watchKey);
      entry.watcher.close().catch((err) => {
        console.error(`[WorkspaceWatcher] Error closing watcher ${watchKey}:`, err);
      });
    }
  }

  private onFileChange(watchKey: string, event: string, filePath: string, workspacePath: string): void {
    const relativePath = path.relative(workspacePath, filePath).replace(/\\/g, '/');
    const changes = this.pendingChanges.get(watchKey) || [];
    changes.push({ event, path: relativePath });
    this.pendingChanges.set(watchKey, changes);

    const existing = this.debounceTimers.get(watchKey);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(watchKey, setTimeout(() => {
      this.flush(watchKey);
    }, 300));
  }

  private flush(watchKey: string): void {
    const changes = this.pendingChanges.get(watchKey);
    if (!changes?.length) return;
    this.pendingChanges.delete(watchKey);
    this.debounceTimers.delete(watchKey);
    this.emit('changes', watchKey, changes);
  }

  async shutdown(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingChanges.clear();
    for (const entry of this.watchers.values()) {
      await entry.watcher.close();
    }
    this.watchers.clear();
  }
}

export const workspaceWatcher = new WorkspaceWatcher();
