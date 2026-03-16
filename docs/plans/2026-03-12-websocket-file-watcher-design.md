# WebSocket + chokidar Real-Time Push Design

## Goal

Add a WebSocket channel to AgentStudio backend that provides two real-time push capabilities:

1. **Workspace file change notifications** — chokidar watches the file system and pushes change events to the frontend, so WorkspaceExplorer updates without polling or full refresh.
2. **Active session status notifications** — SessionManager lifecycle events push to the frontend, so menu sidebar and ActiveSessionsPanel stay current without HTTP polling.

Both features share a single WebSocket connection per browser tab, using message `type` fields to distinguish channels.

## Problem

### Workspace Refresh

Current `WorkspaceExplorer.vue` calls `refreshRoot()` after every AI response. This re-fetches the root directory plus every expanded directory (11+ HTTP requests for 10 expanded dirs), shows a loading spinner (flicker), and cannot detect file changes from non-SDK sources (user SSH, external scripts).

### Session Status

Current `menu.vue` calls `fetchActiveSessions()` once on mount via HTTP GET `/api/agents/sessions`. There is no ongoing update mechanism — once loaded, session status becomes stale. The `ActiveSessionsPanel.vue` also loads once on mount and on props change, with no live updates.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  weknora-ui (browser)                                       │
│                                                             │
│  useAgentStudioWS composable (singleton WS connection)      │
│     ├─ workspace:change/batch → WorkspaceExplorer methods   │
│     └─ session:update        → menuStore + ActiveSessions   │
└──────────────────────┬──────────────────────────────────────┘
                       │ ws://host:4936/ws?token=<apiKey>
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  AgentStudio backend (Express + ws)                         │
│                                                             │
│  websocketService.ts                                        │
│     ├─ HTTP upgrade auth (validateApiKey)                   │
│     ├─ subscribe/unsubscribe message handling               │
│     ├─ workspace channel ← workspaceWatcher.ts (chokidar)  │
│     └─ session channel   ← sessionManager.events           │
│                                                             │
│  workspaceWatcher.ts                                        │
│     ├─ chokidar.watch(workspacePath) per subscription       │
│     ├─ Reference counting (create on first sub, close on 0) │
│     └─ 300ms debounce → batch events                        │
│                                                             │
│  sessionManager.ts (modified)                               │
│     └─ events: EventEmitter (session:created/removed)       │
└─────────────────────────────────────────────────────────────┘
```

## Detailed Design

### 1. Server Startup Refactor (`backend/src/index.ts`)

**Current** (line 647):
```typescript
app.listen(PORT, HOST, () => { ... });
```

**Changed to** (preserving the existing `require.main === module` guard at line 646):
```typescript
import { createServer } from 'http';
import { setupWebSocket, shutdownWebSocket } from './services/websocketService';

if (require.main === module) {
  const server = createServer(app);
  setupWebSocket(server);
  server.listen(PORT, HOST, () => { ... });
}
```

The `require.main === module` guard must be preserved — without it, importing `index.ts` for tests would start a server.

This is a non-breaking change — `app.listen()` internally calls `http.createServer(app).listen()`. Splitting it out gives access to the `server` instance for WebSocket upgrade handling.

**Graceful shutdown** (line 601 `gracefulShutdown`): Add `shutdownWebSocket()` to close all connections and watchers.

### 2. WebSocket Service (`backend/src/services/websocketService.ts` — NEW)

**Responsibilities:**
- Create `WebSocketServer` attached to the HTTP server
- Authenticate connections during HTTP upgrade
- Manage client subscriptions (workspace + session channels)
- Route events from workspaceWatcher and sessionManager to subscribed clients
- Heartbeat ping/pong (30s interval)

**Authentication:**

The existing `a2aAuth.ts` middleware requires `req.params.a2aAgentId` from the URL path, which is not available during a generic WebSocket upgrade. WebSocket authentication uses a simplified flow:

1. Client connects to `ws://host:4936/ws?token=<apiKey>`
2. Server extracts `token` from query string
3. Server iterates all registered agent mappings via `listAgentMappings()` (from `agentMappingService.ts`), calling `validateApiKey(mapping.workingDirectory, key)` for each. Accepts on first match.
4. If valid, connection is accepted; otherwise `socket.destroy()`

> **注意**: `validateApiKey(projectId, key)` 的形参名为 `projectId`，但实际调用时传入的是 `workingDirectory`（参见 `a2aAuth.ts` line 95-97 注释："Use workingDirectory as the path for API key storage, not projectId"）。这是 `apiKeyService.ts` 的形参命名误导，实际语义是 workingDirectory。此处遵循 `a2aAuth.ts` 的实际调用模式。

**Why not reuse `a2aAuth` directly**: `a2aAuth` validates against a specific project (needs `a2aAgentId` → `workingDirectory` → `validateApiKey(workingDirectory, key)`). At WS connection time, we don't know which project the user wants yet. The project-specific context comes later via `subscribe` messages.

**Connection state:**

```typescript
interface WSClient {
  ws: WebSocket;
  apiKey: string;
  workspace?: {
    agentId: string;
    userId?: string;
    watchKey: string;  // "${agentId}:${userId}"
  };
  subscribedSessions: boolean;
}
```

**Client messages (frontend → backend):**

```typescript
// Subscribe to workspace changes for a specific agent+user
{
  type: 'subscribe',
  channel: 'workspace',
  agentId: 'agent-xxx',
  userId: 'u_123'        // optional, for user workspace isolation
}

// Subscribe to session status updates
{
  type: 'subscribe',
  channel: 'sessions'
}

// Unsubscribe from workspace (e.g., when switching projects)
{
  type: 'unsubscribe',
  channel: 'workspace'
}
```

**Server messages (backend → frontend):**

```typescript
// Single file change
{
  type: 'workspace:change',
  event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir',
  path: 'src/utils/helper.ts',  // relative to workspace root
  timestamp: 1741795200000
}

// Batched changes (when many files change in rapid succession)
{
  type: 'workspace:batch',
  changes: [
    { event: 'change', path: 'src/a.ts' },
    { event: 'add', path: 'src/b.ts' }
  ],
  timestamp: 1741795200000
}

// Session status update (full snapshot)
{
  type: 'session:update',
  sessions: [
    {
      sessionId: 'abc-123',
      agentId: 'agent-xxx',
      isActive: true,
      projectPath: '/path/to/project' | null,  // null if not set
      idleTimeMs: 5000,
      status: 'confirmed',
      sessionTitle: 'Fix login bug'
    }
  ],
  activeSessionCount: 2,
  timestamp: 1741795200000
}
```

### 3. Workspace Watcher (`backend/src/services/workspaceWatcher.ts` — NEW)

**Responsibilities:**
- Create/destroy chokidar watchers with reference counting
- Debounce rapid file changes into batched events
- Resolve workspace paths using the same `resolveUserWorkspacePath()` as `a2aWorkspace.ts`

**Watcher lifecycle:**

```typescript
// watchKey format: "${agentId}:${userId || 'default'}"
private watchers = new Map<string, { watcher: FSWatcher, refCount: number, workspacePath: string }>()

async function subscribe(agentId: string, userId?: string): Promise<string> {
  const watchKey = `${agentId}:${userId || 'default'}`
  const existing = this.watchers.get(watchKey)
  if (existing) {
    existing.refCount++
    return watchKey
  }
  // Resolve agentId -> workingDirectory -> workspace filesystem path
  const mapping = await resolveA2AId(agentId)
  if (!mapping) throw new Error(`Unknown agentId: ${agentId}`)
  const workspacePath = await resolveUserWorkspacePath(mapping.workingDirectory, userId)
  const watcher = chokidar.watch(workspacePath, options)
  this.watchers.set(watchKey, { watcher, refCount: 1, workspacePath })
  // Attach event listeners...
  return watchKey
}

function unsubscribe(watchKey: string) {
  const entry = this.watchers.get(watchKey)
  if (!entry) return
  entry.refCount--
  if (entry.refCount <= 0) {
    entry.watcher.close()
    this.watchers.delete(watchKey)
  }
}
```

**chokidar configuration:**

```typescript
chokidar.watch(workspacePath, {
  ignoreInitial: true,
  ignored: [
    /(^|[\/\\])\../,           // dotfiles (.git, .env, etc.)
    '**/node_modules/**',       // node_modules
    '**/__pycache__/**',        // Python cache
  ],
  persistent: true,
  depth: 10,
  awaitWriteFinish: {
    stabilityThreshold: 300,   // wait 300ms after last write
    pollInterval: 100
  }
})
```

**Event debouncing:**

chokidar can fire many events in rapid succession (e.g., `git checkout`, `npm install`). A 300ms sliding window collects changes into a batch:

```typescript
private pendingChanges = new Map<string, FileChange[]>()  // watchKey -> changes
private debounceTimers = new Map<string, NodeJS.Timeout>()

function onFileChange(watchKey: string, event: string, filePath: string) {
  const relativePath = path.relative(workspacePath, filePath)
  const changes = this.pendingChanges.get(watchKey) || []
  changes.push({ event, path: relativePath })
  this.pendingChanges.set(watchKey, changes)

  // Reset debounce timer
  if (this.debounceTimers.has(watchKey)) {
    clearTimeout(this.debounceTimers.get(watchKey))
  }
  this.debounceTimers.set(watchKey, setTimeout(() => {
    this.flush(watchKey)
  }, 300))
}

function flush(watchKey: string) {
  const changes = this.pendingChanges.get(watchKey)
  if (!changes?.length) return
  this.pendingChanges.delete(watchKey)
  this.debounceTimers.delete(watchKey)
  // Emit to websocketService for broadcasting
  this.emit('changes', watchKey, changes)
}
```

**Path resolution:**

The workspace watcher needs to resolve `agentId` → `workingDirectory`. This uses the same path resolution chain as `a2aWorkspace.ts`:

1. `agentId` → `resolveA2AId(agentId)` → `{ workingDirectory }` (from `agentMappingService.ts`)
2. `resolveUserWorkspacePath(workingDirectory, userId)` → actual filesystem path

### 4. SessionManager Events (`backend/src/services/sessionManager.ts` — MODIFIED)

**Current**: `SessionManager` is a plain class. No event broadcasting. The singleton is exported at line 742.

**Change**: Add an `EventEmitter` property and emit events at lifecycle points.

```typescript
import { EventEmitter } from 'events';

export class SessionManager {
  public readonly events = new EventEmitter();

  // ... existing code ...

  createNewSession(...): ClaudeSession {
    // ... existing creation logic ...
    this.events.emit('session:changed');
    return session;
  }

  async removeSession(sessionId: string): Promise<boolean> {
    // ... existing removal logic ...
    this.events.emit('session:changed');
    return true;
  }

  private cleanupIdleSessions(): void {
    // ... existing cleanup logic ...
    if (removedAny) {
      this.events.emit('session:changed');
    }
  }
}
```

**Design choice**: Emit a generic `session:changed` event (not `session:created`/`session:removed` separately). The websocketService listens to `session:changed` and broadcasts the full `getSessionsInfo()` snapshot. This is simpler and more reliable than incremental updates — the session list is small (typically <10 items).

### 5. Frontend WebSocket Client (`weknora-ui/src/composables/useAgentStudioWS.ts` — NEW)

**Singleton composable** — one WS connection per browser tab, shared across all components.

```typescript
import { ref, onUnmounted } from 'vue'

const ws = ref<WebSocket | null>(null)
const isConnected = ref(false)

// Event handlers registry
type Handler = (data: any) => void
const handlers = new Map<string, Set<Handler>>()

export function useAgentStudioWS() {
  function connect(serverUrl: string, apiKey: string) {
    if (ws.value?.readyState === WebSocket.OPEN) return

    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(apiKey)
    ws.value = new WebSocket(wsUrl)

    ws.value.onopen = () => {
      isConnected.value = true
      reconnectDelay = 1000  // reset
    }

    ws.value.onclose = () => {
      isConnected.value = false
      scheduleReconnect(serverUrl, apiKey)
    }

    ws.value.onmessage = (event) => {
      const data = JSON.parse(event.data)
      const typeHandlers = handlers.get(data.type)
      if (typeHandlers) {
        for (const handler of typeHandlers) handler(data)
      }
    }
  }

  function subscribe(channel: string, params: Record<string, any>) {
    ws.value?.send(JSON.stringify({ type: 'subscribe', channel, ...params }))
  }

  function unsubscribe(channel: string) {
    ws.value?.send(JSON.stringify({ type: 'unsubscribe', channel }))
  }

  function on(type: string, handler: Handler) {
    if (!handlers.has(type)) handlers.set(type, new Set())
    handlers.get(type)!.add(handler)
  }

  function off(type: string, handler: Handler) {
    handlers.get(type)?.delete(handler)
  }

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 1000

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    ws.value?.close()
    ws.value = null
    isConnected.value = false
  }

  function scheduleReconnect(serverUrl: string, apiKey: string) {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect(serverUrl, apiKey)
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    }, reconnectDelay)
  }

  return { isConnected, connect, disconnect, subscribe, unsubscribe, on, off }
}
```

**Reconnection**: Exponential backoff (1s → 2s → 4s → 8s → max 30s). On reconnect, re-send active subscriptions.

### 6. Frontend Consumer: WorkspaceExplorer

**How WS messages drive workspace refresh:**

In `index.vue` (or the component that hosts WorkspaceExplorer), register WS handlers:

```typescript
const { on, off, subscribe, unsubscribe } = useAgentStudioWS()

function handleWorkspaceChange(data: any) {
  if (!showWorkspace.value) return

  if (data.type === 'workspace:batch') {
    if (data.changes.length > 20) {
      workspaceExplorerRef.value?.refreshSilent()
    } else {
      const paths = new Set(data.changes.map(c => c.path))
      workspaceExplorerRef.value?.refreshPaths(paths)
    }
  } else if (data.type === 'workspace:change') {
    workspaceExplorerRef.value?.refreshPaths(new Set([data.path]))
  }
}

// On agent/project selection:
on('workspace:change', handleWorkspaceChange)
on('workspace:batch', handleWorkspaceChange)
subscribe('workspace', { agentId: config.agentId, userId })

// On project switch:
unsubscribe('workspace')
subscribe('workspace', { agentId: newAgentId, userId })
```

**What this replaces in `index.vue`:**
- ~~`changedPaths` ref + `needsFullRefresh` ref~~ — not needed
- ~~`trackChangedFiles()` function~~ — not needed
- ~~`isStreaming` watcher workspace refresh logic~~ — not needed

**What is reused from the incremental refresh design (these are new methods defined by that spec, carried over here):**
- `WorkspaceExplorer.refreshPaths()` — called by WS handler instead of `isStreaming` watcher
- `WorkspaceExplorer.refreshSilent()` — called for large batches
- `WorkspaceExplorer.refreshDirectory()` — still used for user manual operations (upload, delete, etc.)
- `WorkspaceExplorer.refreshRoot()` — still used for manual refresh button, initial load
- All manual operation local refreshes from the incremental design remain unchanged

### 7. Frontend Consumer: Session Status

**In `menu.vue`:**

The current `loadActiveSessions()` iterates all configured servers via `loadServers()`. The WS connection is per-AgentStudio-instance, so `session:update` only covers sessions from the connected server. For multi-server setups, keep the HTTP fallback for other servers on mount, and use WS for the primary server's live updates.

```typescript
const { on, subscribe } = useAgentStudioWS()

// WS updates for primary server (live):
on('session:update', (data) => {
  const ids = new Set(data.sessions.map(s => s.sessionId))
  usemenuStore.setActiveSessionIds(ids)
})
subscribe('sessions')

// HTTP fallback for additional servers (one-time on mount):
// loadActiveSessions() still called, but only for non-primary servers
```

**In `ActiveSessionsPanel.vue`:**

```typescript
const { on } = useAgentStudioWS()

// Replace fetchActiveSessions() with:
on('session:update', (data) => {
  sessions.value = data.sessions || []
})

// Still load once on mount as fallback (in case WS isn't connected yet):
onMounted(() => {
  if (props.serverUrl && props.apiKey && props.projectPath) {
    loadSessions()  // HTTP fallback
  }
})
```

**In `index.vue` (a2a-chat):**

```typescript
// After successful sendMessage, markSessionActive() still works as before
// But now WS also pushes session:update when the backend creates the session
// Both sources feed into menuStore.activeSessionIds — no conflict
```

### 8. Vite Proxy (`weknora-ui/vite.config.ts`)

Add WebSocket proxy rule **before** other rules:

```typescript
proxy: {
  '/ws': {
    target: 'ws://localhost:4936',
    ws: true,
  },
  // ... existing proxy rules ...
}
```

### 9. New Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `ws` | ^8.x | WebSocket server for Node.js |
| `@types/ws` | ^8.x | TypeScript types for ws |
| `chokidar` | ^4.x | Cross-platform file watching |

All three are mature, widely-used libraries with no known issues.

## Files Changed

### Backend

| File | Change |
|------|--------|
| `backend/src/index.ts` | `app.listen` → `http.createServer(app)` + `setupWebSocket(server)` + shutdown cleanup |
| `backend/src/services/websocketService.ts` | **NEW**: WS server, connection auth, subscription management, message routing |
| `backend/src/services/workspaceWatcher.ts` | **NEW**: chokidar file watching, ref counting, 300ms debounce batching |
| `backend/src/services/sessionManager.ts` | Add `events` EventEmitter + emit `session:changed` at create/remove/cleanup |
| `backend/package.json` | Add `ws`, `@types/ws`, `chokidar` |

### Frontend

| File | Change |
|------|--------|
| `weknora-ui/src/composables/useAgentStudioWS.ts` | **NEW**: Singleton WS client composable (connect, subscribe, on/off, reconnect) |
| `weknora-ui/src/views/a2a-chat/index.vue` | Remove tool-event collection (`changedPaths`, `trackChangedFiles`). Add WS workspace handler. |
| `weknora-ui/src/components/a2a-tools/WorkspaceExplorer.vue` | Add `refreshPaths()`, `refreshSilent()`, `refreshDirectory()`, `getParentDir()`. Update `defineExpose`. Replace manual-op `refreshRoot()` with `refreshDirectory()`. (Same changes as incremental refresh design.) |
| `weknora-ui/src/components/menu.vue` | Replace `loadActiveSessions()` HTTP call with WS `session:update` handler |
| `weknora-ui/src/views/a2a-chat/components/ActiveSessionsPanel.vue` | Add WS `session:update` handler. Keep HTTP `loadSessions()` as mount-time fallback. |
| `weknora-ui/src/stores/menu.ts` | `activeSessionIds` + `setActiveSessionIds()` unchanged (already exists from previous work) |
| `weknora-ui/vite.config.ts` | Add `/ws` proxy rule with `ws: true` |

## Files NOT Changed

| File | Reason |
|------|--------|
| `src/api/a2a/stream.ts` | SSE streaming unaffected |
| `src/api/a2a/workspace.ts` | HTTP workspace API unchanged |
| `src/api/a2a/index.ts` | `fetchActiveSessions()` kept as HTTP fallback |
| `backend/src/routes/a2aWorkspace.ts` | HTTP workspace routes unchanged |
| `backend/src/middleware/a2aAuth.ts` | WS auth is independent (different flow) |
| `backend/src/services/sessionEventBus.ts` | AGUI-specific, unrelated to Claude SDK sessions |

**Note:** `index.vue` line 830 `@saved="workspaceExplorerRef?.refresh()"` on `WorkspaceFilePreview` remains unchanged — user-initiated saves in preview panel still use the existing full `refresh()`.

**Deployment note:** In production, `agentstudio-deploy/nginx.conf` needs a `/ws` location block with WebSocket upgrade headers (`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"`). Without this, nginx will reject WS connections with 400 Bad Request. This is a deployment config change, not a code change.
## Relationship to Incremental Refresh Design

The WebSocket design **supersedes** the tool-event-driven collection part of the incremental refresh design (`2026-03-12-workspace-incremental-refresh-design.md`), but **reuses** its WorkspaceExplorer methods:

| Incremental Refresh Component | Status in WebSocket Design |
|-------------------------------|---------------------------|
| `changedPaths` + `needsFullRefresh` + `trackChangedFiles()` in `index.vue` | **Replaced** by WS `workspace:change/batch` handler |
| `isStreaming` watcher refresh logic | **Replaced** by WS events |
| `WorkspaceExplorer.refreshPaths()` | **Kept** — called by WS handler |
| `WorkspaceExplorer.refreshSilent()` | **Kept** — called for large batches |
| `WorkspaceExplorer.refreshDirectory()` + `getParentDir()` | **Kept** — used for manual operations |
| Manual operation local refresh table | **Kept** unchanged |

## Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Workspace: HTTP requests after AI edits 1 file | 11+ (full refresh) | 0 (WS push → 1-2 targeted re-fetches) |
| Workspace: HTTP requests after AI reads only | 11+ | 0 |
| Workspace: Detect non-SDK file changes (SSH, scripts) | Impossible | Automatic (chokidar) |
| Workspace: UI flicker | Yes (loading spinner) | No |
| Sessions: Update latency | Stale after mount | Real-time (<100ms) |
| Sessions: HTTP polling requests | 1 on mount (was 5s polling before recent fix) | 0 ongoing (1 fallback on mount) |
| Network overhead | N/A | 1 persistent WS connection (~50 bytes/ping) |
