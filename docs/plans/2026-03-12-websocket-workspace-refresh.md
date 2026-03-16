# WebSocket + Workspace Incremental Refresh Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time WebSocket push for workspace file changes (chokidar) and session status, plus incremental refresh methods in WorkspaceExplorer to eliminate full-tree refresh flicker.

**Architecture:** Backend adds `websocketService.ts` (WS server + auth + subscription routing), `workspaceWatcher.ts` (chokidar + ref counting + 300ms debounce), and `sessionManager.ts` event emission. Frontend adds `useAgentStudioWS.ts` composable (singleton WS client), and WorkspaceExplorer gains `refreshPaths()`, `refreshSilent()`, `refreshDirectory()` methods. WS messages drive targeted refreshes instead of full-tree polling.

**Tech Stack:** ws (Node.js WS server), chokidar (file watcher), EventEmitter (session events), Vue 3 composable (WS client)

**Specs:**
- `agentstudio/docs/superpowers/specs/2026-03-12-websocket-file-watcher-design.md`
- `weknora-ui/docs/superpowers/specs/2026-03-12-workspace-incremental-refresh-design.md`

---

## File Structure

### Backend (agentstudio)

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/src/services/websocketService.ts` | CREATE | WS server setup, HTTP upgrade auth, client subscription management, message routing, heartbeat ping/pong |
| `backend/src/services/workspaceWatcher.ts` | CREATE | chokidar file watchers with ref counting, 300ms debounce batching, path resolution |
| `backend/src/services/sessionManager.ts` | MODIFY (lines 24, 155, 341, 434) | Add `events` EventEmitter property, emit `session:changed` at create/remove/cleanup |
| `backend/src/index.ts` | MODIFY (lines 1-6, 601-651) | Import `http.createServer`, refactor `app.listen` → `server.listen`, add WS setup + shutdown |
| `backend/package.json` | MODIFY | Add `ws`, `@types/ws`, `chokidar` |

### Frontend (weknora-ui)

| File | Action | Responsibility |
|------|--------|---------------|
| `src/composables/useAgentStudioWS.ts` | CREATE | Singleton WS client composable (connect, subscribe, on/off, reconnect with exponential backoff) |
| `src/components/a2a-tools/WorkspaceExplorer.vue` | MODIFY (lines 257-288, 720) | Add `refreshPaths()`, `refreshSilent()`, `refreshDirectory()`, `getParentDir()`. Update `defineExpose`. Replace manual-op `refreshRoot()` with `refreshDirectory()`. |
| `src/views/a2a-chat/index.vue` | MODIFY (lines 1270-1284, 980) | Remove full refresh from `isStreaming` watcher. Add WS workspace handlers. |
| `src/components/menu.vue` | MODIFY (lines 648-669) | Add WS `session:update` handler alongside existing HTTP fallback |
| `src/views/a2a-chat/components/ActiveSessionsPanel.vue` | MODIFY (lines 1-100) | Add WS `session:update` handler, keep HTTP `loadSessions()` as mount fallback |
| `vite.config.ts` | MODIFY (line 69) | Add `/ws` proxy rule with `ws: true` before other rules |

---

## Chunk 1: Backend Infrastructure

### Task 1: Install Backend Dependencies

**Files:**
- Modify: `agentstudio/backend/package.json`

- [ ] **Step 1: Install ws, @types/ws, and chokidar**

```bash
cd agentstudio/backend && pnpm add ws chokidar && pnpm add -D @types/ws
```

- [ ] **Step 2: Verify packages installed**

Run: `cd agentstudio/backend && node -e "require('ws'); require('chokidar'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd agentstudio
git add backend/package.json backend/pnpm-lock.yaml
git commit -m "chore: add ws, chokidar dependencies for websocket file watcher"
```

---

### Task 2: Create workspaceWatcher.ts

**Files:**
- Create: `agentstudio/backend/src/services/workspaceWatcher.ts`
- Test: `agentstudio/backend/src/services/__tests__/workspaceWatcher.test.ts`

- [ ] **Step 1: Write the failing test for subscribe/unsubscribe ref counting**

```typescript
// agentstudio/backend/src/services/__tests__/workspaceWatcher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock chokidar before import
const mockWatcher = {
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
};
vi.mock('chokidar', () => ({
  default: { watch: vi.fn(() => mockWatcher) },
}));

// Mock agentMappingService
vi.mock('../a2a/agentMappingService.js', () => ({
  resolveA2AId: vi.fn().mockResolvedValue({
    a2aAgentId: 'agent-xxx',
    workingDirectory: '/projects/myproject',
  }),
}));

// Mock workspaceUtils
vi.mock('../../utils/workspaceUtils.js', () => ({
  resolveUserWorkspacePath: vi.fn().mockResolvedValue('/projects/myproject/.workspaces/u_123'),
}));

import { WorkspaceWatcher } from '../workspaceWatcher.js';

describe('WorkspaceWatcher', () => {
  let watcher: WorkspaceWatcher;

  beforeEach(() => {
    watcher = new WorkspaceWatcher();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await watcher.shutdown();
  });

  it('should create a chokidar watcher on first subscribe', async () => {
    const chokidar = await import('chokidar');
    const key = await watcher.subscribe('agent-xxx', 'u_123');
    expect(key).toBe('agent-xxx:u_123');
    expect(chokidar.default.watch).toHaveBeenCalledTimes(1);
  });

  it('should reuse watcher on duplicate subscribe (ref counting)', async () => {
    const chokidar = await import('chokidar');
    await watcher.subscribe('agent-xxx', 'u_123');
    await watcher.subscribe('agent-xxx', 'u_123');
    expect(chokidar.default.watch).toHaveBeenCalledTimes(1);
  });

  it('should not close watcher when refCount > 0', () => {
    // subscribe twice, unsubscribe once
    watcher.subscribe('agent-xxx', 'u_123').then(() => {
      watcher.subscribe('agent-xxx', 'u_123').then(() => {
        watcher.unsubscribe('agent-xxx:u_123');
        expect(mockWatcher.close).not.toHaveBeenCalled();
      });
    });
  });

  it('should close watcher when refCount reaches 0', async () => {
    await watcher.subscribe('agent-xxx', 'u_123');
    watcher.unsubscribe('agent-xxx:u_123');
    expect(mockWatcher.close).toHaveBeenCalledTimes(1);
  });

  it('should use default userId when none provided', async () => {
    const key = await watcher.subscribe('agent-xxx');
    expect(key).toBe('agent-xxx:default');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agentstudio/backend && npx vitest run src/services/__tests__/workspaceWatcher.test.ts`
Expected: FAIL — cannot resolve `../workspaceWatcher.js`

- [ ] **Step 3: Implement WorkspaceWatcher**

```typescript
// agentstudio/backend/src/services/workspaceWatcher.ts
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

  async subscribe(agentId: string, userId?: string): Promise<string> {
    const watchKey = `${agentId}:${userId || 'default'}`;
    const existing = this.watchers.get(watchKey);
    if (existing) {
      existing.refCount++;
      return watchKey;
    }

    const mapping = await resolveA2AId(agentId);
    if (!mapping) throw new Error(`Unknown agentId: ${agentId}`);
    const workspacePath = await resolveUserWorkspacePath(mapping.workingDirectory, userId);

    const watcher = chokidar.watch(workspacePath, {
      ignoreInitial: true,
      ignored: [
        /(^|[/\\])\./,           // dotfiles
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

    this.watchers.set(watchKey, { watcher, refCount: 1, workspacePath });
    return watchKey;
  }

  unsubscribe(watchKey: string): void {
    const entry = this.watchers.get(watchKey);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.watcher.close();
      this.watchers.delete(watchKey);
      // Clear any pending debounce
      const timer = this.debounceTimers.get(watchKey);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(watchKey);
      }
      this.pendingChanges.delete(watchKey);
    }
  }

  private onFileChange(watchKey: string, event: string, filePath: string, workspacePath: string): void {
    const relativePath = path.relative(workspacePath, filePath).replace(/\\/g, '/');
    const changes = this.pendingChanges.get(watchKey) || [];
    changes.push({ event, path: relativePath });
    this.pendingChanges.set(watchKey, changes);

    // Reset debounce timer (300ms sliding window)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agentstudio/backend && npx vitest run src/services/__tests__/workspaceWatcher.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd agentstudio
git add backend/src/services/workspaceWatcher.ts backend/src/services/__tests__/workspaceWatcher.test.ts
git commit -m "feat: add WorkspaceWatcher with chokidar file watching and ref counting"
```

---

### Task 3: Add EventEmitter to SessionManager

**Files:**
- Modify: `agentstudio/backend/src/services/sessionManager.ts`
- Test: `agentstudio/backend/src/services/__tests__/sessionManagerEvents.test.ts`

- [ ] **Step 1: Write the failing test for session events**

```typescript
// agentstudio/backend/src/services/__tests__/sessionManagerEvents.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ClaudeSession
vi.mock('../claudeSession.js', () => ({
  ClaudeSession: vi.fn().mockImplementation((agentId) => ({
    getAgentId: () => agentId,
    isSessionActive: () => true,
    getLastActivity: () => Date.now(),
    getProjectPath: () => null,
    getClaudeVersionId: () => undefined,
    getModelId: () => undefined,
    getSessionTitle: () => undefined,
    close: vi.fn().mockResolvedValue(undefined),
    isIdle: () => false,
  })),
}));

vi.mock('../../config/sdkConfig.js', () => ({
  getProjectsDir: () => '/tmp/test-projects',
}));

import { SessionManager } from '../sessionManager.js';

describe('SessionManager events', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager();
  });

  it('should have an events property of type EventEmitter', () => {
    expect(sm.events).toBeDefined();
    expect(typeof sm.events.on).toBe('function');
    expect(typeof sm.events.emit).toBe('function');
  });

  it('should emit session:changed when creating a session with resumeSessionId', () => {
    const handler = vi.fn();
    sm.events.on('session:changed', handler);
    sm.createNewSession('agent-1', {} as any, 'session-1');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should emit session:changed when creating a temp session (no resumeSessionId)', () => {
    const handler = vi.fn();
    sm.events.on('session:changed', handler);
    sm.createNewSession('agent-1', {} as any);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should emit session:changed when removing a session', async () => {
    const handler = vi.fn();
    sm.createNewSession('agent-1', {} as any, 'session-1');
    sm.events.on('session:changed', handler);
    await sm.removeSession('session-1');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agentstudio/backend && npx vitest run src/services/__tests__/sessionManagerEvents.test.ts`
Expected: FAIL — `sm.events` is undefined

- [ ] **Step 3: Add EventEmitter to SessionManager**

In `agentstudio/backend/src/services/sessionManager.ts`:

1. Add import at line 1 area:
```typescript
import { EventEmitter } from 'events';
```

2. Add `events` property after line 24 (`export class SessionManager {`):
```typescript
  public readonly events = new EventEmitter();
```

3. In `createNewSession()` (line 155), there are two return paths:

**Path A — resumeSessionId provided (line 157-176):** Inside the `if (resumeSessionId)` block, before `return session;` at line 175:
```typescript
      this.events.emit('session:changed');
```

**Path B — no resumeSessionId, temp session (line 177-181):** Before `return session;` at line 181:
```typescript
    this.events.emit('session:changed');
```

4. In `removeSession()` (line 341), after `console.log` at line 369, before `return true;` (line 370):
```typescript
    this.events.emit('session:changed');
```

5. In `cleanupIdleSessions()` (line 434): Since `removeSession()` now emits `session:changed` on each call, the heartbeat cleanup loop (line 447-450) and idle session cleanup (line 510-513) already emit per-removal. Only the **idle-activity temp sessions** block (lines 516-523) bypasses `removeSession()` by calling `session.close()` + `this.tempSessions.delete()` directly. Add a single emit at the very end of `cleanupIdleSessions`, after all cleanup blocks complete (before the closing `}` at line 526), guarded by whether any cleanup occurred:

```typescript
    // Emit once at end if any cleanup happened
    if (heartbeatTimedOutSessions.length > 0 || idleTempKeys.length > 0 || idleSessionIds.length > 0 || idleActivityTempKeys.length > 0) {
      this.events.emit('session:changed');
    }
```

Note: This will cause duplicate emits when `removeSession` also emits during the heartbeat/idle loops. This is acceptable — the WS handler broadcasts a full snapshot (idempotent). Alternatively, a more surgical approach would be to only emit here for the `idleActivityTempKeys` path, but the guard-all approach is simpler and harmless.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agentstudio/backend && npx vitest run src/services/__tests__/sessionManagerEvents.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
cd agentstudio
git add backend/src/services/sessionManager.ts backend/src/services/__tests__/sessionManagerEvents.test.ts
git commit -m "feat: add EventEmitter to SessionManager for session lifecycle events"
```

---

### Task 4: Create websocketService.ts

**Files:**
- Create: `agentstudio/backend/src/services/websocketService.ts`
- Test: `agentstudio/backend/src/services/__tests__/websocketService.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// agentstudio/backend/src/services/__tests__/websocketService.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';

// Mock dependencies
vi.mock('../a2a/agentMappingService.js', () => ({
  listAgentMappings: vi.fn().mockResolvedValue([
    { a2aAgentId: 'agent-xxx', workingDirectory: '/projects/myproject' },
  ]),
}));

vi.mock('../a2a/apiKeyService.js', () => ({
  validateApiKey: vi.fn().mockImplementation(async (dir: string, key: string) => {
    if (key === 'valid-key') return { valid: true, keyId: 'k1' };
    return { valid: false };
  }),
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

import { setupWebSocket, shutdownWebSocket } from '../websocketService.js';

describe('websocketService', () => {
  let server: http.Server;
  let port: number;

  beforeEach((ctx) => {
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
  });

  it('should reject connection without valid token', () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=bad-key`);
      ws.on('error', () => {
        resolve(); // Connection rejected = success
      });
      ws.on('open', () => {
        ws.close();
        reject(new Error('Should have been rejected'));
      });
      // Timeout fallback
      setTimeout(() => resolve(), 2000);
    });
  });

  it('should accept connection with valid token', () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=valid-key`);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agentstudio/backend && npx vitest run src/services/__tests__/websocketService.test.ts`
Expected: FAIL — cannot resolve `../websocketService.js`

- [ ] **Step 3: Implement websocketService.ts**

```typescript
// agentstudio/backend/src/services/websocketService.ts
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { URL } from 'url';
import { listAgentMappings } from './a2a/agentMappingService.js';
import { validateApiKey } from './a2a/apiKeyService.js';
import { sessionManager } from './sessionManager.js';
import { workspaceWatcher } from './workspaceWatcher.js';
import type { FileChange } from './workspaceWatcher.js';

interface WSClient {
  ws: WebSocket;
  apiKey: string;
  workspace?: {
    agentId: string;
    userId?: string;
    watchKey: string;
  };
  subscribedSessions: boolean;
}

let wss: WebSocketServer | null = null;
const clients = new Set<WSClient>();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Authenticate WS connection by iterating all agent mappings
 * and checking the API key against each workingDirectory.
 *
 * Note: validateApiKey(projectId, key) — the param is named projectId
 * but callers actually pass workingDirectory (see a2aAuth.ts line 95-97).
 */
async function authenticateToken(token: string): Promise<boolean> {
  const mappings = await listAgentMappings();
  for (const mapping of mappings) {
    try {
      const result = await validateApiKey(mapping.workingDirectory, token);
      if (result.valid) return true;
    } catch {
      // Continue to next mapping
    }
  }
  return false;
}

export function setupWebSocket(server: Server): void {
  wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade
  server.on('upgrade', async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token');
      if (!token) {
        socket.destroy();
        return;
      }
      const valid = await authenticateToken(token);
      if (!valid) {
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

  // Handle new connections
  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, token: string) => {
    const client: WSClient = { ws, apiKey: token, subscribedSessions: false };
    clients.add(client);

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        await handleClientMessage(client, msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      cleanupClient(client);
      clients.delete(client);
    });

    ws.on('pong', () => {
      // Client is alive (heartbeat response)
    });
  });

  // Heartbeat: ping every 30s
  heartbeatInterval = setInterval(() => {
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }, 30000);

  // Listen for workspace watcher changes
  workspaceWatcher.on('changes', (watchKey: string, changes: FileChange[]) => {
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
      if (client.workspace?.watchKey === watchKey && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  });

  // Listen for session changes
  sessionManager.events.on('session:changed', () => {
    broadcastSessionUpdate();
  });

  console.log('[WebSocket] Service initialized');
}

async function handleClientMessage(client: WSClient, msg: any): Promise<void> {
  if (msg.type === 'subscribe') {
    if (msg.channel === 'workspace' && msg.agentId) {
      // Unsubscribe from previous workspace if any
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
      client.subscribedSessions = true;
      // Send initial snapshot immediately
      broadcastSessionUpdateToClient(client);
    }
  } else if (msg.type === 'unsubscribe') {
    if (msg.channel === 'workspace' && client.workspace) {
      workspaceWatcher.unsubscribe(client.workspace.watchKey);
      client.workspace = undefined;
    } else if (msg.channel === 'sessions') {
      client.subscribedSessions = false;
    }
  }
}

function cleanupClient(client: WSClient): void {
  if (client.workspace) {
    workspaceWatcher.unsubscribe(client.workspace.watchKey);
    client.workspace = undefined;
  }
  client.subscribedSessions = false;
}

function broadcastSessionUpdate(): void {
  const sessions = sessionManager.getSessionsInfo();
  const activeCount = sessionManager.getActiveSessionCount();
  const message = JSON.stringify({
    type: 'session:update',
    sessions,
    activeSessionCount: activeCount,
    timestamp: Date.now(),
  });
  for (const client of clients) {
    if (client.subscribedSessions && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

function broadcastSessionUpdateToClient(client: WSClient): void {
  const sessions = sessionManager.getSessionsInfo();
  const activeCount = sessionManager.getActiveSessionCount();
  const message = JSON.stringify({
    type: 'session:update',
    sessions,
    activeSessionCount: activeCount,
    timestamp: Date.now(),
  });
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(message);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agentstudio/backend && npx vitest run src/services/__tests__/websocketService.test.ts`
Expected: Both tests PASS

- [ ] **Step 5: Commit**

```bash
cd agentstudio
git add backend/src/services/websocketService.ts backend/src/services/__tests__/websocketService.test.ts
git commit -m "feat: add WebSocket service with auth, subscription management, and message routing"
```

---

### Task 5: Refactor index.ts Server Startup

**Files:**
- Modify: `agentstudio/backend/src/index.ts` (lines 1-6 imports, lines 601-651 shutdown+listen)

- [ ] **Step 1: Add imports at top of index.ts**

After existing imports (around line 6), add:

```typescript
import { createServer } from 'http';
import { setupWebSocket, shutdownWebSocket } from './services/websocketService.js';
```

- [ ] **Step 2: Add shutdownWebSocket to gracefulShutdown**

In `gracefulShutdown` (line 601), before the `console.info('[System] Shutdown complete')` at line 636, add a new cleanup step:

```typescript
    // N. Shutdown WebSocket service
    try {
      shutdownWebSocket();
      console.info('[WebSocket] WebSocket service stopped');
    } catch (error) {
      console.error('[WebSocket] Error shutting down WebSocket service:', error);
    }
```

- [ ] **Step 3: Replace app.listen with http.createServer + server.listen**

Replace lines 646-651:

```typescript
// Before:
if (require.main === module) {
    app.listen(PORT, HOST, () => {
      console.log(`AI PPT Editor backend running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      console.log(`Serving slides from: ${slidesDir}`);
    });
  }
```

With:

```typescript
if (require.main === module) {
    const server = createServer(app);
    setupWebSocket(server);
    server.listen(PORT, HOST, () => {
      console.log(`AI PPT Editor backend running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      console.log(`Serving slides from: ${slidesDir}`);
    });
  }
```

- [ ] **Step 4: Verify backend builds**

Run: `cd agentstudio && pnpm run build:backend`
Expected: Build succeeds with no errors

- [ ] **Step 5: Commit**

```bash
cd agentstudio
git add backend/src/index.ts
git commit -m "feat: refactor server startup to http.createServer for WebSocket support"
```

---

## Chunk 2: Frontend WorkspaceExplorer Methods

### Task 6: Add Incremental Refresh Methods to WorkspaceExplorer

**Files:**
- Modify: `weknora-ui/src/components/a2a-tools/WorkspaceExplorer.vue` (lines 257-288, 720)

- [ ] **Step 1: Add refreshPaths() after refreshRoot() (after line 288)**

```typescript
async function refreshPaths(paths: Set<string>) {
  const dirsToRefresh = new Set<string>()
  for (const p of paths) {
    const parentDir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '.'
    dirsToRefresh.add(parentDir)
  }

  for (const dir of dirsToRefresh) {
    if (dir === '.') {
      rootItems.value = await loadDirectory('.')
    } else if (expandedPaths.value.has(dir)) {
      try {
        childrenMap.value.set(dir, await loadDirectory(dir))
      } catch {
        expandedPaths.value.delete(dir)
        childrenMap.value.delete(dir)
      }
    }
  }
}
```

- [ ] **Step 2: Add refreshSilent() after refreshPaths()**

```typescript
async function refreshSilent() {
  try {
    rootItems.value = await loadDirectory('.')
    for (const p of expandedPaths.value) {
      try {
        childrenMap.value.set(p, await loadDirectory(p))
      } catch {
        expandedPaths.value.delete(p)
        childrenMap.value.delete(p)
      }
    }
  } catch (e) {
    console.warn('[WorkspaceExplorer] refreshSilent failed:', e)
  }
}
```

- [ ] **Step 3: Add refreshDirectory() and getParentDir() helpers**

```typescript
async function refreshDirectory(dirPath: string) {
  try {
    if (dirPath === '.') {
      rootItems.value = await loadDirectory('.')
    } else if (expandedPaths.value.has(dirPath)) {
      childrenMap.value.set(dirPath, await loadDirectory(dirPath))
    }
  } catch { /* ignore */ }
}

function getParentDir(filePath: string): string {
  return filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '.'
}
```

- [ ] **Step 4: Update defineExpose (line 720)**

Replace:
```typescript
defineExpose({ refresh: debouncedRefresh })
```
With:
```typescript
defineExpose({
  refresh: debouncedRefresh,
  refreshPaths,
  refreshSilent,
})
```

- [ ] **Step 5: Verify build**

Run: `cd weknora-ui && pnpm run type-check`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
cd weknora-ui
git add src/components/a2a-tools/WorkspaceExplorer.vue
git commit -m "feat: add refreshPaths, refreshSilent, refreshDirectory to WorkspaceExplorer"
```

---

### Task 7: Replace Manual Operation refreshRoot() Calls

**Files:**
- Modify: `weknora-ui/src/components/a2a-tools/WorkspaceExplorer.vue`

This task replaces `refreshRoot()` calls after user operations with targeted `refreshDirectory()` calls, per the table in the incremental refresh design. Operations that keep `refreshRoot()`: manual refresh button (line 496), compress (line 427), extract-here (line 440), extract-to-new (line 454), onMounted (line 739), config watch (line 752, 754), debouncedRefresh (line 732).

- [ ] **Step 1: Replace handleNewFolder refreshRoot (line 330)**

Find `await createWorkspaceDir(props.config, dirPath)` followed by `await refreshRoot()` at line 330. The `dirPath` variable is the new folder path. Replace with:
```typescript
    await refreshDirectory(getParentDir(dirPath))
```

- [ ] **Step 2: Replace handleFileUpload refreshRoot (line 347)**

After `await uploadWorkspaceFile(props.config, dirPath, file)` at line 346-347. Replace `await refreshRoot()` with:
```typescript
    await refreshDirectory(dirPath)
```
Here `dirPath` is `uploadTargetDir.value` — the directory uploaded into.

- [ ] **Step 3: Replace rename refreshRoot (line 390)**

After `await renameWorkspaceItem(...)` at line 389. Replace `await refreshRoot()` with:
```typescript
            await refreshDirectory(getParentDir(target.path))
```

- [ ] **Step 4: Replace paste (copy/move) refreshRoot (line 414)**

After paste operations at line 414. This is inside a block that handles both copy and move. Replace `await refreshRoot()` with:
```typescript
          await refreshDirectory(getParentDir(destPath))
```
Note: for move operations, the source directory also changes. Check if `clipboard.value.action === 'cut'` and if so also refresh source parent. If the surrounding code structure makes it complex, use `refreshRoot()` as fallback for paste.

- [ ] **Step 5: Replace delete refreshRoot (line 512)**

After `await deleteWorkspaceItem(...)` at line 510, `dialog.destroy()` at line 511. Replace `await refreshRoot()` with:
```typescript
        await refreshDirectory(getParentDir(item.path))
```

- [ ] **Step 6: Replace new-file refreshRoot (line 472)**

After `await writeWorkspaceFile(props.config, filePath, '')` at line 471. Replace `await refreshRoot()` with:
```typescript
        await refreshDirectory(getParentDir(filePath))
```

- [ ] **Step 7: Replace new-dir refreshRoot (line 485)**

After `await createWorkspaceDir(props.config, dirPath)` at line 484. Replace `await refreshRoot()` with:
```typescript
        await refreshDirectory(getParentDir(dirPath))
```

- [ ] **Step 8: Replace handleTreeDrop move refreshRoot (line 566)**

After `await moveWorkspaceItem(...)` at line 565. Replace `await refreshRoot()` with:
```typescript
      await refreshDirectory(target.path)
      await refreshDirectory(getParentDir(sourcePath))
```

- [ ] **Step 9: Replace handleTreeDrop upload refreshRoot (line 578)**

After upload loop at line 576-577. Replace `await refreshRoot()` with:
```typescript
    await refreshDirectory(target.path)
```

- [ ] **Step 10: Replace handleAreaDrop refreshRoot (line 600)**

After upload to root at line 598. Replace `await refreshRoot()` with:
```typescript
  await refreshDirectory('.')
```

- [ ] **Step 11: Verify build**

Run: `cd weknora-ui && pnpm run type-check`
Expected: No type errors

- [ ] **Step 12: Commit**

```bash
cd weknora-ui
git add src/components/a2a-tools/WorkspaceExplorer.vue
git commit -m "refactor: replace manual operation refreshRoot with targeted refreshDirectory"
```

---

## Chunk 3: Frontend WebSocket Client

### Task 8: Create useAgentStudioWS Composable

**Files:**
- Create: `weknora-ui/src/composables/useAgentStudioWS.ts`

- [ ] **Step 1: Create the composable**

```typescript
// src/composables/useAgentStudioWS.ts
import { ref } from 'vue'

const ws = ref<WebSocket | null>(null)
const isConnected = ref(false)

type Handler = (data: any) => void
const handlers = new Map<string, Set<Handler>>()

// Track active subscriptions for reconnection
const activeSubscriptions: Array<{ channel: string; params: Record<string, any> }> = []

let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
let lastServerUrl = ''
let lastApiKey = ''

function connect(serverUrl: string, apiKey: string) {
  if (ws.value?.readyState === WebSocket.OPEN) return

  lastServerUrl = serverUrl
  lastApiKey = apiKey

  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(apiKey)
  const socket = new WebSocket(wsUrl)

  socket.onopen = () => {
    isConnected.value = true
    reconnectDelay = 1000
    ws.value = socket
    // Re-send active subscriptions after reconnect
    for (const sub of activeSubscriptions) {
      socket.send(JSON.stringify({ type: 'subscribe', ...sub }))
    }
  }

  socket.onclose = () => {
    isConnected.value = false
    ws.value = null
    scheduleReconnect()
  }

  socket.onerror = () => {
    // onclose will fire after onerror
  }

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      const typeHandlers = handlers.get(data.type)
      if (typeHandlers) {
        for (const handler of typeHandlers) handler(data)
      }
    } catch {
      // Ignore malformed messages
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  if (!lastServerUrl || !lastApiKey) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect(lastServerUrl, lastApiKey)
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
  }, reconnectDelay)
}

function subscribe(channel: string, params: Record<string, any> = {}) {
  // Track for reconnection
  const existing = activeSubscriptions.findIndex(s => s.channel === channel)
  if (existing >= 0) activeSubscriptions.splice(existing, 1)
  activeSubscriptions.push({ channel, params })

  if (ws.value?.readyState === WebSocket.OPEN) {
    ws.value.send(JSON.stringify({ type: 'subscribe', channel, ...params }))
  }
}

function unsubscribe(channel: string) {
  const idx = activeSubscriptions.findIndex(s => s.channel === channel)
  if (idx >= 0) activeSubscriptions.splice(idx, 1)

  if (ws.value?.readyState === WebSocket.OPEN) {
    ws.value.send(JSON.stringify({ type: 'unsubscribe', channel }))
  }
}

function on(type: string, handler: Handler) {
  if (!handlers.has(type)) handlers.set(type, new Set())
  handlers.get(type)!.add(handler)
}

function off(type: string, handler: Handler) {
  handlers.get(type)?.delete(handler)
}

function disconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  activeSubscriptions.length = 0
  ws.value?.close()
  ws.value = null
  isConnected.value = false
  lastServerUrl = ''
  lastApiKey = ''
}

export function useAgentStudioWS() {
  return { isConnected, connect, disconnect, subscribe, unsubscribe, on, off }
}
```

- [ ] **Step 2: Verify build**

Run: `cd weknora-ui && pnpm run type-check`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
cd weknora-ui
git add src/composables/useAgentStudioWS.ts
git commit -m "feat: add useAgentStudioWS singleton WebSocket composable"
```

---

### Task 9: Add Vite WS Proxy

**Files:**
- Modify: `weknora-ui/vite.config.ts` (line 69)

- [ ] **Step 1: Add /ws proxy rule**

In `vite.config.ts`, add `/ws` proxy BEFORE the first `/api/share` rule (before line 71):

```typescript
      // WebSocket proxy for AgentStudio real-time push
      '/ws': {
        target: 'ws://localhost:4936',
        ws: true,
      },
```

- [ ] **Step 2: Verify dev server starts**

Run: `cd weknora-ui && pnpm run dev` (manual check — Ctrl+C to stop)
Expected: Dev server starts without proxy errors

- [ ] **Step 3: Commit**

```bash
cd weknora-ui
git add vite.config.ts
git commit -m "feat: add WebSocket proxy rule for AgentStudio WS connection"
```

---

## Chunk 4: Frontend Consumer Integration

### Task 10: Wire WS Workspace Handler in index.vue

**Files:**
- Modify: `weknora-ui/src/views/a2a-chat/index.vue` (lines 836, 980, 1270-1284)

- [ ] **Step 1: Import useAgentStudioWS**

In the `<script setup>` imports (around line 842), add:

```typescript
import { useAgentStudioWS } from '@/composables/useAgentStudioWS'
```

- [ ] **Step 2: Initialize WS connection and workspace handler**

After the workspace section (around line 984), add:

```typescript
// ========== WebSocket real-time push ==========
const { connect: wsConnect, on: wsOn, off: wsOff, subscribe: wsSub, unsubscribe: wsUnsub, disconnect: wsDisconnect } = useAgentStudioWS()

function handleWorkspaceWS(data: any) {
  if (!showWorkspace.value) return
  if (data.type === 'workspace:batch') {
    if (data.changes.length > 20) {
      workspaceExplorerRef.value?.refreshSilent()
    } else {
      const paths = new Set(data.changes.map((c: any) => c.path))
      workspaceExplorerRef.value?.refreshPaths(paths)
    }
  } else if (data.type === 'workspace:change') {
    workspaceExplorerRef.value?.refreshPaths(new Set([data.path]))
  }
}
```

- [ ] **Step 3: Connect WS and subscribe on config ready**

In the config watcher or onMounted section, add WS connection initialization. Find where `formData`/config is set up, and add:

```typescript
// Connect WebSocket when config is available
watch(() => configStore.config, (config) => {
  if (config.serverUrl && config.apiKey) {
    wsConnect(config.serverUrl, config.apiKey)
    wsOn('workspace:change', handleWorkspaceWS)
    wsOn('workspace:batch', handleWorkspaceWS)
    if (config.agentId) {
      wsSub('workspace', { agentId: config.agentId })
    }
  }
}, { immediate: true })
```

- [ ] **Step 4: Remove full refresh from isStreaming watcher**

Replace lines 1270-1284:

```typescript
// Before:
watch(isStreaming, (streaming) => {
  configStore.setStreaming(streaming)
  if (!streaming) {
    if (showWorkspace.value) {
      workspaceExplorerRef.value?.refresh()
    }
    nextTick(() => {
      inputRef.value?.focus()
    })
  }
})
```

With:

```typescript
watch(isStreaming, (streaming) => {
  configStore.setStreaming(streaming)
  if (!streaming) {
    // Workspace refresh now handled by WebSocket push — no polling needed
    nextTick(() => {
      inputRef.value?.focus()
    })
  }
})
```

- [ ] **Step 5: Clean up WS on unmount**

In the `onUnmounted` handler (find existing one), add:

```typescript
wsOff('workspace:change', handleWorkspaceWS)
wsOff('workspace:batch', handleWorkspaceWS)
```

Note: Do NOT call `wsDisconnect()` here — the WS is singleton and shared. Only disconnect on logout.

- [ ] **Step 6: Verify build**

Run: `cd weknora-ui && pnpm run type-check`
Expected: No type errors

- [ ] **Step 7: Commit**

```bash
cd weknora-ui
git add src/views/a2a-chat/index.vue
git commit -m "feat: wire WebSocket workspace change handler, remove polling refresh"
```

---

### Task 11: Wire WS Session Handler in menu.vue

**Files:**
- Modify: `weknora-ui/src/components/menu.vue` (lines 648-669)

- [ ] **Step 1: Import useAgentStudioWS**

In the `<script setup>` imports, add:

```typescript
import { useAgentStudioWS } from '@/composables/useAgentStudioWS'
```

- [ ] **Step 2: Add WS session handler**

After the `loadActiveSessions()` function (around line 669), add:

```typescript
// WebSocket session status updates (live, primary server only)
const { on: wsOn, subscribe: wsSub } = useAgentStudioWS()

wsOn('session:update', (data: any) => {
  const ids = new Set<string>((data.sessions || []).map((s: any) => s.sessionId))
  usemenuStore.setActiveSessionIds(ids)
})
wsSub('sessions')
```

The existing `loadActiveSessions()` remains unchanged — it serves as initial HTTP fallback on mount for all servers (including those not connected via WS).

- [ ] **Step 3: Verify build**

Run: `cd weknora-ui && pnpm run type-check`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
cd weknora-ui
git add src/components/menu.vue
git commit -m "feat: add WebSocket session status handler in menu sidebar"
```

---

### Task 12: Wire WS Session Handler in ActiveSessionsPanel.vue

**Files:**
- Modify: `weknora-ui/src/views/a2a-chat/components/ActiveSessionsPanel.vue` (lines 1-100)

- [ ] **Step 1: Import useAgentStudioWS**

Add to imports at top:

```typescript
import { useAgentStudioWS } from '@/composables/useAgentStudioWS'
```

- [ ] **Step 2: Add WS handler**

After `const loading = ref(false)` (line 20), add:

```typescript
// WebSocket live session updates
const { on: wsOn } = useAgentStudioWS()
wsOn('session:update', (data: any) => {
  sessions.value = data.sessions || []
  // Also update menuStore to keep sidebar in sync
  const ids = new Set<string>((data.sessions || []).map((s: any) => s.sessionId))
  menuStore.setActiveSessionIds(ids)
})
```

The existing `loadSessions()` on mount (lines 95-98) and props watch (lines 87-93) remain as HTTP fallback.

- [ ] **Step 3: Verify build**

Run: `cd weknora-ui && pnpm run type-check`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
cd weknora-ui
git add src/views/a2a-chat/components/ActiveSessionsPanel.vue
git commit -m "feat: add WebSocket session status handler in ActiveSessionsPanel"
```

---

## Chunk 5: Integration Testing & Cleanup

### Task 13: End-to-End Manual Test

This task verifies the full flow works in the development environment. Requires both AgentStudio backend and weknora-ui frontend running.

- [ ] **Step 1: Start AgentStudio backend**

Run: `cd agentstudio && pnpm run dev:backend`
Expected: Backend starts on port 4936, console shows `[WebSocket] Service initialized`

- [ ] **Step 2: Start weknora-ui frontend**

Run: `cd weknora-ui && pnpm run dev`
Expected: Dev server on port 5173

- [ ] **Step 3: Test WS connection**

Open browser DevTools → Network → WS tab. Navigate to A2A chat page. Should see a WS connection to `/ws?token=...` in OPEN state.

- [ ] **Step 4: Test workspace file change detection**

In a separate terminal, create/edit a file in the workspace directory of the connected agent. The WorkspaceExplorer tree should update within ~500ms without a loading spinner.

- [ ] **Step 5: Test session status push**

Send a message in A2A chat (creates a session). The sidebar session indicator should update in real-time. Close/cleanup the session — sidebar should reflect the change.

- [ ] **Step 6: Test reconnection**

Restart the backend while the frontend is connected. The WS should reconnect (exponential backoff visible in console), and subscriptions should re-activate automatically.

---

### Task 14: Type Check Both Projects

- [ ] **Step 1: Type check weknora-ui**

Run: `cd weknora-ui && pnpm run type-check`
Expected: No errors

- [ ] **Step 2: Type check agentstudio**

Run: `cd agentstudio && pnpm run type-check`
Expected: No errors

- [ ] **Step 3: Run backend tests**

Run: `cd agentstudio/backend && npx vitest run`
Expected: All tests pass (including new workspaceWatcher, sessionManagerEvents, websocketService tests)

- [ ] **Step 4: Final commit (if any cleanup needed)**

```bash
cd agentstudio && git status
cd ../weknora-ui && git status
```

If clean, no action needed. Otherwise commit any remaining fixes.

---

### Task 15: Nginx Deployment Config (Production)

> **仅生产部署，本机开发跳过。** Vite dev proxy (Task 9) 已处理开发环境 WS 转发。此任务仅在部署到 nginx 反代的生产环境时执行。

**Files:**
- Modify: `agentstudio-deploy/nginx.conf` (or equivalent production nginx config)

Without this change, nginx in production will reject WS connections with 400 Bad Request.

- [ ] **Step 1: Add /ws location block to nginx.conf**

Add before other `location` blocks:

```nginx
location /ws {
    proxy_pass http://backend:4936;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 86400s;
}
```

- [ ] **Step 2: Verify nginx config syntax**

Run: `nginx -t` (or `docker exec <container> nginx -t`)
Expected: `syntax is ok`

- [ ] **Step 3: Reload nginx**

Run: `nginx -s reload` (or `docker exec <container> nginx -s reload`)
