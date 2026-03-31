# OpenCLI Phase 4 Completion Plan

**Date**: 2026-03-30  
**Status**: In Progress (30% → 100%)  
**Priority**: P0 (Blocks production readiness)  
**Owner**: AgentStudio Team

---

## Executive Summary

OpenCLI integration is 75% complete across 6 phases. Phases 1-3 (Core Channel, Pairing, Permission Engine) are production-ready. **Phase 4 (Management Console) is only 30% complete** and blocks full feature parity. This plan details the 4 missing subsystems:

| Feature | Priority | Status | Impact |
|---------|----------|--------|--------|
| Execution History System | P0 | 0% | Cannot audit opencli operations |
| Real-time Offline Alert | P0 | 0% | Users unaware bridge is down, timeout on commands |
| Remote Diagnostics | P1 | 0% | Cannot troubleshoot bridge issues |
| Domain Configuration Push | P1 | 0% | Config changes require manual restart |

**Completion Target**: 2 weeks (P0 features: 1 week, P1 features: 1 week)

---

## Current State Assessment

### What's Done (Phases 1-3, 5-6)

✅ **Phase 1: Core Channel** (100%)
- WebSocket channel `opencli-bridge` established
- Message types: `register`, `execute`, `result`, `error`
- Bidirectional communication working

✅ **Phase 2: Pairing** (100%)
- Token generation: `POST /api/opencli/pairing-token`
- Token validation in bridge registration
- Pairing UI in `weknora-ui/src/components/a2a-project/OpenCliBridgeSettings.vue` (92 lines)

✅ **Phase 3: Permission Engine** (100%)
- Role-based access control (RBAC) for opencli commands
- Permission checks in `bridgeCommandProxy.dispatch()`
- Session-scoped approval tracking via in-memory `approvalCache` (Map<string, Set<string>>)

✅ **Phase 5-6: Advanced Features** (100%)
- Config string generator (working)
- Revoke API exists (`DELETE /api/opencli/keys`)

### What's Missing (Phase 4, 30% → 100%)

❌ **Execution History System** (0%)
- Backend: `bridgeHistoryStore.ts` not created
- API: `GET /api/opencli/history` not implemented
- Frontend: History table component missing
- Storage: File-based `.a2a/opencli-history.json` (matching existing `opencliConfigStorage.ts` pattern)

❌ **Real-time Offline Alert** (0%)
- Backend: `broadcastOpenCliBridgeEvent()` not implemented in websocketService.ts
- Backend: `handleClientMessage()` 需添加 `opencli-bridge` channel 订阅分支
- Frontend: `BridgeStatusBanner.vue` component missing
- Frontend: `useAgentStudioWS.ts` 已有完整的 subscribe/on/off 事件系统（第277/345/350行），**无需重新实现**
- Current: MCP registration checks online status (Level 1 ✅), but no real-time notification (Level 2 ❌)

❌ **Remote Diagnostics** (0%)
- WS message types defined (`type: 'diagnose'`, `type: 'diagnose_result'`), but no trigger
- API: `POST /api/opencli/diagnose` not implemented
- Frontend: Diagnostic button and result display missing

❌ **Domain Configuration Push** (0%)
- WS message type defined (`type: 'config_update'`), but not implemented
- API: `PUT /api/opencli/domains` not implemented
- Frontend: Domain toggle switches UI missing (6 actual domains: social, media, finance, news, desktop, jobs)
- Current: Config stored in `.a2a/opencli-config.json` ✅, but no UI to modify ❌, no real-time push ❌

### OpenCliBridgeSettings.vue Current State

- **Location**: `weknora-ui/src/components/a2a-project/OpenCliBridgeSettings.vue`
- **Lines**: 93 (minimal)
- **Features**: Pairing token generation only
- **Missing**: 6 of 7 console features
- **Framework**: Vue 3 + Pinia + TDesign Vue Next (NOT React)

---

## Implementation Plan

### Phase 4.1: Execution History System (P0)

**Goal**: Audit all opencli command executions with full context  
**Success Criteria**: History file stores 50+ records, API filters by projectId/status/timestamp work  
**Tests**: 3 test cases (store operations, API filtering, frontend rendering)  
**Status**: Not Started

#### 1.1 Backend: File-Based History Store Service

**File**: `agentstudio/backend/src/services/opencli/bridgeHistoryStore.ts`

Uses file-based storage pattern matching `opencliConfigStorage.ts` (NOT database):

```typescript
import fs from 'fs';
import path from 'path';
import { getProjectA2ADir } from '../../config/paths.js';

const HISTORY_FILENAME = 'opencli-history.json';

interface ExecutionHistoryRecord {
  id: string;
  projectId: string;
  bridgeId: string;
  command: string;
  status: 'pending' | 'success' | 'error' | 'timeout';
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  executedAt: string; // ISO timestamp
  completedAt?: string;
  duration?: number; // ms
  userId: string;
  userEmail: string;
  workingDirectory: string; // Added: needed for file path resolution
}

interface HistoryFile {
  version: '1.0.0';
  records: ExecutionHistoryRecord[];
}

interface HistoryQueryResult {
  total: number;
  records: ExecutionHistoryRecord[];
}

export class BridgeHistoryStore {
  private getHistoryPath(workingDirectory: string): string {
    return path.join(getProjectA2ADir(workingDirectory), HISTORY_FILENAME);
  }

  private loadHistory(workingDirectory: string): HistoryFile {
    const filePath = this.getHistoryPath(workingDirectory);
    if (!fs.existsSync(filePath)) {
      return { version: '1.0.0', records: [] };
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return { version: '1.0.0', records: [] };
    }
  }

  private saveHistory(workingDirectory: string, history: HistoryFile): void {
    const dir = getProjectA2ADir(workingDirectory);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.getHistoryPath(workingDirectory), JSON.stringify(history, null, 2));
  }

  async recordExecution(workingDirectory: string, record: ExecutionHistoryRecord): Promise<void> {
    const history = this.loadHistory(workingDirectory);
    history.records.push(record);
    // Keep only last 1000 records
    if (history.records.length > 1000) {
      history.records = history.records.slice(-1000);
    }
    this.saveHistory(workingDirectory, history);
  }

  async getHistory(workingDirectory: string, limit: number, offset: number): Promise<HistoryQueryResult> {
    const history = this.loadHistory(workingDirectory);
    const total = history.records.length;
    const records = history.records.slice(offset, offset + limit);
    return { total, records };
  }

  async getHistoryByStatus(workingDirectory: string, status: string): Promise<ExecutionHistoryRecord[]> {
    const history = this.loadHistory(workingDirectory);
    return history.records.filter(r => r.status === status);
  }

  async clearHistory(workingDirectory: string, olderThanDays: number): Promise<number> {
    const history = this.loadHistory(workingDirectory);
    const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const before = history.records.length;
    history.records = history.records.filter(r => new Date(r.executedAt).getTime() > cutoffTime);
    const deleted = before - history.records.length;
    if (deleted > 0) {
      this.saveHistory(workingDirectory, history);
    }
    return deleted;
  }
}
```

**Storage Location**: `.a2a/opencli-history.json` (same directory as `opencli-config.json`)

**Integration Point**: 

1. **Extend `PendingCommand` interface** in `types.ts` to include history context:
```typescript
export interface PendingCommand {
  resolve: (stdout: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  projectId: string;
  userId: string;
  // Add these fields for history recording:
  command: string;           // Full command string (e.g., "twitter post 'Hello'")
  workingDirectory: string;  // Project root path
  userEmail: string;         // User email for audit trail
  bridgeId: string;          // Bridge identifier
}
```

2. **Update `bridgeCommandProxy.dispatch()`** to store full context in `PendingCommand`:
```typescript
// In dispatch() method, when creating PendingCommand:
this.pending.set(id, { 
  resolve, 
  reject, 
  timer, 
  projectId, 
  userId,
  command: `${command.site} ${command.action} ${command.args.join(' ')}`,
  workingDirectory: /* pass from caller */,
  userEmail: /* pass from caller */,
  bridgeId: entry.bridgeId
});
```

3. **Call `bridgeHistoryStore.recordExecution()`** in `bridgeCommandProxy.onResult()` (line 48-60):
```typescript
onResult(msg: ResultMessage): void {
  const pending = this.pending.get(msg.id);
  if (!pending) return;

  clearTimeout(pending.timer);
  this.pending.delete(msg.id);

  // Record execution history
  const record: ExecutionHistoryRecord = {
    id: msg.id,
    projectId: pending.projectId,
    bridgeId: pending.bridgeId,
    command: pending.command,
    status: msg.success ? 'success' : 'error',
    exitCode: msg.exitCode,
    stdout: msg.stdout,
    stderr: msg.stderr,
    executedAt: new Date(Date.now() - msg.durationMs).toISOString(),
    completedAt: new Date().toISOString(),
    duration: msg.durationMs,
    userId: pending.userId,
    userEmail: pending.userEmail,
    workingDirectory: pending.workingDirectory
  };
  bridgeHistoryStore.recordExecution(pending.workingDirectory, record).catch(err => {
    console.error('[BridgeHistory] Failed to record execution:', err);
  });

  if (msg.success) {
    pending.resolve(msg.stdout);
  } else {
    pending.reject(new BridgeError('EXEC_ERROR', msg.stderr || `Exit code: ${msg.exitCode}`));
  }
}
```

#### 1.2 Backend: History API

**Endpoint**: `GET /api/opencli/history`

```
Query Parameters:
  - projectId (required): string
  - workingDirectory (required): string (project root path)
  - limit (optional): number, default 50, max 500
  - offset (optional): number, default 0
  - status (optional): 'pending' | 'success' | 'error' | 'timeout'
  - startDate (optional): ISO 8601
  - endDate (optional): ISO 8601

Response:
{
  "total": 1234,
  "records": [
    {
      "id": "hist_xxx",
      "command": "twitter post 'Hello World'",
      "status": "success",
      "exitCode": 0,
      "duration": 2500,
      "executedAt": "2026-03-30T10:30:00Z",
      "completedAt": "2026-03-30T10:30:02Z",
      "userId": "user_123",
      "userEmail": "dev@example.com"
    }
  ]
}
```

#### 1.3 Frontend: History Table Component

**File**: `weknora-ui/src/components/a2a-project/HistoryTable.vue`

- Columns: Command, Status (badge), Duration, Executed At, User, Actions
- Status badges: green (success), red (error), yellow (timeout), gray (pending)
- Pagination: 50 records per page
- Filters: Status dropdown, date range picker
- Actions: View details (modal with full stdout/stderr), Copy command
- Real-time update: Subscribe to `opencli:history_update` WS event for push updates (prefer over polling)

#### 1.4 Integration into OpenCliBridgeSettings.vue

- Add tab: "Execution History"
- Embed HistoryTable component
- Pass projectId and workingDirectory as props

#### 1.5 QA: Execution History System

**Backend Test**:
- **Tool**: Vitest
- **Command**: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/bridgeHistoryStore.test.ts`
- **Expected Result**: 3/3 tests pass
  - Test 1: `recordExecution` writes record to `.a2a/opencli-history.json`
  - Test 2: `getHistory` returns records with correct pagination
  - Test 3: `clearHistory` removes records older than N days

**API Test**:
- **Tool**: curl
- **Command**: 
  ```bash
  curl -X GET "http://localhost:4936/api/opencli/history?projectId=proj_123&workingDirectory=/home/user/project&limit=50&offset=0" \
    -H "Authorization: Bearer $TOKEN"
  ```
- **Expected Result**: HTTP 200, response contains `total` and `records` array with 50 items

**Frontend Test**:
- **Tool**: Browser DevTools
- **Steps**:
  1. Navigate to `/platform/a2a-projects`
  2. Click "OpenCLI Settings" → "Execution History" tab
  3. Verify table displays 50 records with columns: Command, Status, Duration, Executed At, User
  4. Click Status filter dropdown, select "success" → verify only success records shown
  5. Click date range picker, select last 7 days → verify records filtered
  6. Click "View Details" on a record → verify modal shows full stdout/stderr
- **Expected Result**: All filters work, modal displays correctly, no console errors

---

### Phase 4.2: Real-time Offline Alert (P0)

**Goal**: Notify users immediately when bridge goes offline  
**Success Criteria**: Banner appears within 2s of bridge disconnect, disappears on reconnect  
**Tests**: 3 test cases (event broadcast, component rendering, auto-dismiss)  
**Status**: Not Started

#### 2.1 Backend: WebSocket Event Broadcaster

**File**: `agentstudio/backend/src/services/websocketService.ts` (extend existing)

Uses raw `ws` library pattern matching `broadcastCronEvent()` (line 278):

```typescript
export function broadcastOpenCliBridgeEvent(
  projectId: string,
  event: {
    type: 'opencli:online' | 'opencli:offline' | 'opencli:error';
    bridgeId: string;
    timestamp: number;
    reason?: string; // e.g., "connection timeout", "heartbeat missed"
  }
): void {
  const message = JSON.stringify(event);
  
  // Iterate all connected clients
  for (const client of clients) {
    // Check if client subscribed to opencli-bridge channel for this project
    if (client.subscribedOpenCliBridges?.has(projectId)) {
      sendSafe(client, message);
    }
  }
}
```

**Client Subscription Model** (add to `WSClient` interface in `websocketService.ts`):
```typescript
interface WSClient {
  // ... existing fields ...
  subscribedOpenCliBridges?: Set<string>; // Set of projectIds
}
```

**Subscription Handler** (add new branch in `handleClientMessage`, after `cron-all` branch):
```typescript
} else if (msg.channel === 'opencli-bridge' && typeof msg.projectId === 'string') {
  if (!client.subscribedOpenCliBridges) {
    client.subscribedOpenCliBridges = new Set();
  }
  client.subscribedOpenCliBridges.add(msg.projectId);
}
```

**Cleanup** (add to `cleanupClient` function):
```typescript
client.subscribedOpenCliBridges?.clear();
```

**Unsubscribe Handler** (add to `handleClientMessage` unsubscribe section):
```typescript
} else if (msg.channel === 'opencli-bridge') {
  client.subscribedOpenCliBridges?.clear();
}
```

**Trigger Points**:
1. Bridge registration timeout (no heartbeat for 30s) → `opencli:offline` event
2. Bridge reconnects → `opencli:online` event
3. Bridge sends error message → `opencli:error` event

#### 2.2 Frontend: Bridge Status Banner Component

**File**: `weknora-ui/src/components/a2a-project/BridgeStatusBanner.vue`

**Important**: Uses existing `useAgentStudioWS` composable which already provides `subscribe/on/off` API. Do NOT create a separate event system.

```vue
<template>
  <t-alert
    v-if="bridgeStatus !== 'online'"
    :theme="bridgeStatus === 'offline' ? 'warning' : 'error'"
    :message="statusMessage"
    close
    @close="dismiss"
    style="margin-bottom: 16px;"
  />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStudioWS } from '@/composables/useAgentStudioWS'

const props = defineProps<{
  projectId: string
  serverUrl: string  // Required: which AgentStudio server this bridge connects to
}>()

const { t } = useI18n()
const { subscribe, on, off } = useAgentStudioWS()

const bridgeStatus = ref<'online' | 'offline' | 'error'>('online')
let dismissTimer: ReturnType<typeof setTimeout> | null = null

const statusMessage = computed(() => {
  if (bridgeStatus.value === 'offline') return t('opencli.bridge.offline')
  if (bridgeStatus.value === 'error') return t('opencli.bridge.error')
  return ''
})

function dismiss() {
  bridgeStatus.value = 'online'
  if (dismissTimer) clearTimeout(dismissTimer)
}

// Event handlers (named functions for proper cleanup via off())
function handleOffline(event: any) {
  if (event.projectId === props.projectId) {
    bridgeStatus.value = 'offline'
  }
}

function handleOnline(event: any) {
  if (event.projectId === props.projectId) {
    bridgeStatus.value = 'online'
    if (dismissTimer) clearTimeout(dismissTimer)
    dismissTimer = setTimeout(() => dismiss(), 3000)
  }
}

function handleError(event: any) {
  if (event.projectId === props.projectId) {
    bridgeStatus.value = 'error'
  }
}

onMounted(() => {
  // Subscribe to opencli-bridge channel for specific server
  subscribe('opencli-bridge', { projectId: props.projectId }, props.serverUrl)

  on('opencli:offline', handleOffline)
  on('opencli:online', handleOnline)
  on('opencli:error', handleError)
})

onUnmounted(() => {
  off('opencli:offline', handleOffline)
  off('opencli:online', handleOnline)
  off('opencli:error', handleError)
  if (dismissTimer) clearTimeout(dismissTimer)
})
</script>
```

#### 2.3 Frontend: WebSocket Integration (Uses Existing Composable)

**No new code needed.** `useAgentStudioWS.ts` (line 345-368) already provides:
- `subscribe(channel, params, serverUrl?)` — Subscribe to a WS channel
- `on(type, handler)` — Listen for events by type
- `off(type, handler)` — Remove event listener
- `socket.onmessage` auto-dispatches by `data.type` (line 138-150)

The composable manages **multi-server connections** (line 24: `connections = new Map<string, WSConnection>()`). When subscribing, pass `serverUrl` to target the correct AgentStudio instance. Omitting `serverUrl` broadcasts to all connections.

#### 2.4 Integration into OpenCliBridgeSettings.vue

- Import BridgeStatusBanner component
- Place at top of settings panel
- Pass projectId and serverUrl as props (serverUrl from a2aConfig store)
- No extra subscription needed — BridgeStatusBanner handles its own lifecycle

#### 2.5 QA: Real-time Offline Alert

**Backend Test**:
- **Tool**: Vitest
- **Command**: `cd agentstudio/backend && npx vitest run src/services/__tests__/websocketService.test.ts`
- **Expected Result**: 2/2 tests pass
  - Test 1: `broadcastOpenCliBridgeEvent` sends message to subscribed clients only
  - Test 2: Message format includes `type: 'opencli:offline'`, `bridgeId`, `timestamp`

**Integration Test**:
- **Tool**: Browser DevTools + Backend API
- **Steps**:
  1. Open `/platform/a2a-projects` in browser, open DevTools Console
  2. Navigate to project detail, verify BridgeStatusBanner visible at top
  3. **Simulate bridge offline**: Call backend API to disconnect bridge:
     ```bash
     curl -X POST "http://localhost:4936/api/opencli/test/disconnect" \
       -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"projectId": "proj_123", "userId": "user_123"}'
     ```
  4. Observe: Banner appears with "Bridge is offline" message within 2s
  5. **Simulate bridge online**: Reconnect via API:
     ```bash
     curl -X POST "http://localhost:4936/api/opencli/test/reconnect" \
       -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"projectId": "proj_123", "userId": "user_123"}'
     ```
  6. Observe: Banner changes to "Bridge is online", auto-dismisses after 3s
- **Expected Result**: Banner appears/disappears correctly, no console errors, WebSocket stays connected
- **Note**: If test API endpoints don't exist, manually test by closing/reopening opencli-bridge desktop app

---

### Phase 4.3: Remote Diagnostics (P1)

**Goal**: Troubleshoot bridge connectivity and configuration issues  
**Success Criteria**: Diagnostic report shows bridge version, connection status, config validation  
**Tests**: 2 test cases (API call, result parsing)  
**Status**: Not Started

#### 3.1 Backend: Diagnostics API

**Endpoint**: `POST /api/opencli/diagnose`

```
Request:
{
  "projectId": "proj_123",
  "userId": "user_123"
}

Response:
{
  "bridgeId": "bridge_xxx",
  "version": "1.2.3",
  "status": "connected",
  "lastHeartbeat": "2026-03-30T10:30:00Z",
  "uptime": 86400,
  "configValid": true,
  "configErrors": [],
  "permissionsValid": true,
  "permissionErrors": [],
  "networkLatency": 45,
  "timestamp": 1711862415000
}
```

**Implementation**:
1. Look up bridge via `bridgeRegistry.get(projectId, userId)`
2. Send WS message `type: 'diagnose'` to bridge
3. Wait for `type: 'diagnose_result'` response (timeout 10s)
4. Parse and return to client

#### 3.2 Frontend: Diagnostics Button & Result Modal

**File**: `weknora-ui/src/components/a2a-project/DiagnosticsModal.vue`

- Button: "Run Diagnostics" in OpenCliBridgeSettings
- Modal: Shows diagnostic report in table format
- Status indicators: Green (valid), Red (error), Yellow (warning)
- Auto-refresh: Button to re-run diagnostics

#### 3.3 QA: Remote Diagnostics

**Backend Test**:
- **Tool**: Vitest
- **Command**: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/bridgeDiagnostics.test.ts`
- **Expected Result**: 2/2 tests pass
  - Test 1: `POST /api/opencli/diagnose` sends `diagnose` message to bridge and waits for result
  - Test 2: Timeout after 10s if bridge doesn't respond

**API Test**:
- **Tool**: curl
- **Command**:
  ```bash
  curl -X POST "http://localhost:4936/api/opencli/diagnose" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "projectId": "proj_123",
      "userId": "user_123"
    }'
  ```
- **Expected Result**: HTTP 200, response includes:
  - `bridgeId`: non-empty string
  - `version`: semantic version (e.g., "1.2.3")
  - `status`: "connected" or "disconnected"
  - `configValid`: boolean
  - `timestamp`: milliseconds since epoch

**Browser UI Test** (Manual):
- **Steps**:
  1. Open `/platform/a2a-projects` in browser
  2. Click "OpenCLI Settings" → "Remote Diagnostics" tab
  3. Click "Run Diagnostics" button
  4. Observe: Loading spinner appears
  5. After 2-5 seconds, diagnostic report displays in table format
  6. Verify rows include: Bridge ID, Version, Status, Last Heartbeat, Uptime, Config Valid, Permissions Valid, Network Latency
  7. Click "Run Diagnostics" again to verify refresh works
- **Expected Result**: Report displays correctly, no console errors, refresh works

---

### Phase 4.4: Domain Configuration Push (P1)

**Goal**: Allow users to enable/disable domains via UI with real-time push  
**Success Criteria**: Toggle switches update config, bridge receives update within 2s  
**Tests**: 2 test cases (API update, WS broadcast)  
**Status**: Not Started

#### 4.1 Backend: Domain Configuration API

**Endpoint 1**: `GET /api/opencli/config`

```
Query Parameters:
  - projectId (required): string
  - userId (required): string
  - workingDirectory (required): string (project root path)

Response:
{
  "enabled": true,
  "enabledDomains": ["social", "media", "desktop"]
}
```

**Implementation**:
```typescript
router.get('/config', (req, res) => {
  try {
    const { projectId, userId, workingDirectory } = req.query;
    if (!projectId || !userId || !workingDirectory) {
      return res.status(400).json({ error: 'projectId, userId, and workingDirectory required' });
    }
    
    const config = loadProjectOpenCliConfig(workingDirectory as string);
    if (!config) {
      return res.json({ enabled: false, enabledDomains: [] });
    }
    
    res.json(config);
  } catch (err) {
    console.error('[OpenCLI] Config load error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

**Endpoint 2**: `PUT /api/opencli/domains`

```
Request:
{
  "projectId": "proj_123",
  "userId": "user_123",
  "workingDirectory": "/home/user/project",
  "domains": {
    "social": true,
    "media": true,
    "finance": false,
    "news": false,
    "desktop": true,
    "jobs": false
  }
}

Response:
{
  "success": true,
  "updated": ["social", "media", "desktop"],
  "timestamp": 1711862415000
}
```

**Implementation**:
1. Validate domains against `ALL_DOMAINS` from `constants.ts` (social, media, finance, news, desktop, jobs)
2. Update `OpenCliProjectConfig.enabledDomains` via `saveProjectOpenCliConfig(workingDirectory, config)`
3. Broadcast WS message `type: 'opencli:config_update'` to subscribed browser clients
4. **Send config update to bridge** (critical step):
   ```typescript
   // After broadcasting to browser clients:
   const bridgeEntry = bridgeRegistry.get(projectId, userId);
   if (bridgeEntry && bridgeEntry.ws.readyState === WebSocket.OPEN) {
     bridgeEntry.ws.send(JSON.stringify({
       type: 'config_update',
       enabledDomains: config.enabledDomains,
       timestamp: Date.now()
     }));
   }
   ```
5. Return updated config

#### 4.2 Backend: Config Update Broadcaster (Browser Clients)

**In websocketService.ts** (add new export function):

```typescript
export function broadcastOpenCliConfigUpdate(
  projectId: string,
  event: {
    type: 'opencli:config_update';
    projectId: string;
    domains: Record<string, boolean>;
    timestamp: number;
  }
): void {
  const message = JSON.stringify(event);
  
  // Iterate all connected browser clients
  for (const client of clients) {
    // Check if client subscribed to opencli-bridge channel for this project
    if (client.subscribedOpenCliBridges?.has(projectId)) {
      sendSafe(client, message);
    }
  }
}
```

**Message Format** (to browser clients):
```json
{
  "type": "opencli:config_update",
  "projectId": "proj_123",
  "domains": {
    "social": true,
    "media": true,
    "finance": false,
    "news": false,
    "desktop": true,
    "jobs": false
  },
  "timestamp": 1711862415000
}
```

**Message Format** (to bridge via `bridgeRegistry.get()`):
```json
{
  "type": "config_update",
  "enabledDomains": ["social", "media", "desktop"],
  "timestamp": 1711862415000
}
```

#### 4.3 Frontend: Domain Configuration UI

**File**: `weknora-ui/src/components/a2a-project/DomainConfiguration.vue`

**Prerequisite**: Add `/api/opencli` proxy to `weknora-ui/vite.config.ts` **before** the `/api` wildcard:
```typescript
// In vite.config.ts proxy section, add BEFORE '/api':
'/api/opencli': {
  target: 'http://localhost:4936',
  changeOrigin: true,
},
```

```vue
<template>
  <div class="domain-config">
    <t-loading v-if="loadingConfig" size="small" style="padding: 20px; text-align: center;" />
    <template v-else>
      <div class="domains-grid">
        <div v-for="domain in domains" :key="domain" class="domain-toggle">
          <t-checkbox
            v-model="config[domain]"
            :disabled="isSaving"
          >
            <span class="domain-name">{{ domain }}</span>
          </t-checkbox>
          <p class="domain-description">{{ domainDescriptions[domain] }}</p>
        </div>
      </div>

      <div class="actions">
        <t-button :loading="isSaving" @click="save">
          {{ isSaving ? t('opencli.domains.saving') : t('opencli.domains.save') }}
        </t-button>
        <span v-if="saveMessage" :class="['message', saveStatus]">
          {{ saveMessage }}
        </span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStudioAuth } from '@/composables/useAgentStudioAuth'
import { useAgentStudioWS } from '@/composables/useAgentStudioWS'

const props = defineProps<{
  projectId: string
  userId: string
  workingDirectory: string
  serverUrl: string   // AgentStudio server URL (from a2aConfig store)
  apiKey: string      // AgentStudio API key (from a2aConfig store)
}>()

const { t } = useI18n()
const { getToken } = useAgentStudioAuth()
const { on, off } = useAgentStudioWS()

// Domain constants (matches backend constants.ts DOMAIN_MAPPING)
const domains = ['social', 'media', 'finance', 'news', 'desktop', 'jobs'] as const

const domainDescriptions: Record<string, string> = {
  social: 'Twitter, Reddit, TikTok, Instagram, Jike, Xiaohongshu, V2EX, Coupang, Zhihu, Weibo, SMZDM, Ctrip, Facebook',
  media: 'Bilibili, WeRead, Douban, YouTube, Xiaoyuzhou, Apple Podcasts, Medium, Jimeng',
  finance: 'Bloomberg, Xueqiu, Barchart, Yahoo Finance, Sina Finance',
  news: 'Linux.do, Stack Overflow, Wikipedia, Lobsters, Sina Blog, Google, Dev.to, Substack, arXiv, Chaoxing, Hacker News, BBC, Reuters, Steam, Hugging Face',
  desktop: 'Cursor, Codex, ChatWise, Antigravity, Notion, Discord, ChatGPT, Grok',
  jobs: 'Boss, LinkedIn'
}

const config = reactive<Record<string, boolean>>({
  social: false,
  media: false,
  finance: false,
  news: false,
  desktop: false,
  jobs: false
})

const loadingConfig = ref(true)
const isSaving = ref(false)
const saveMessage = ref('')
const saveStatus = ref<'success' | 'error'>('success')

// Load current config from backend on mount
async function loadCurrentConfig() {
  loadingConfig.value = true
  try {
    const token = await getToken(props.serverUrl, props.apiKey)
    const response = await fetch(`/api/opencli/config?projectId=${props.projectId}&userId=${props.userId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    if (response.ok) {
      const data = await response.json()
      const enabledDomains: string[] = data.enabledDomains || []
      for (const domain of domains) {
        config[domain] = enabledDomains.includes(domain)
      }
    }
  } catch (err) {
    console.warn('[DomainConfiguration] Failed to load config:', err)
  } finally {
    loadingConfig.value = false
  }
}

async function save() {
  isSaving.value = true
  saveMessage.value = ''

  try {
    const token = await getToken(props.serverUrl, props.apiKey)
    const response = await fetch('/api/opencli/domains', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        projectId: props.projectId,
        userId: props.userId,
        workingDirectory: props.workingDirectory,
        domains: config
      })
    })

    if (!response.ok) throw new Error('Failed to save')

    saveStatus.value = 'success'
    saveMessage.value = t('opencli.domains.saved')
    setTimeout(() => saveMessage.value = '', 3000)
  } catch (err) {
    saveStatus.value = 'error'
    saveMessage.value = t('opencli.domains.saveFailed')
  } finally {
    isSaving.value = false
  }
}

// Listen for config updates from other clients
function handleConfigUpdate(event: any) {
  if (event.projectId === props.projectId) {
    Object.assign(config, event.domains)
  }
}

onMounted(() => {
  loadCurrentConfig()
  on('opencli:config_update', handleConfigUpdate)
})

import { onUnmounted } from 'vue'
onUnmounted(() => {
  off('opencli:config_update', handleConfigUpdate)
})
</script>

<style scoped>
.domain-config { padding: 16px; }

.domains-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.domain-toggle {
  padding: 12px;
  border: 1px solid var(--td-component-border, #dcdcdc);
  border-radius: var(--td-radius-medium, 6px);
  background: var(--td-bg-color-container, #fff);
}

.domain-name {
  text-transform: capitalize;
  font-weight: 500;
}

.domain-description {
  margin: 8px 0 0 28px;
  font-size: 12px;
  color: var(--td-text-color-placeholder);
  line-height: 1.4;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.message {
  font-size: 14px;
  padding: 4px 8px;
  border-radius: var(--td-radius-default, 3px);
}

.message.success {
  color: var(--td-success-color);
  background: var(--td-success-color-1, #e3f9e9);
}

.message.error {
  color: var(--td-error-color);
  background: var(--td-error-color-1, #fdecee);
}
</style>
```

#### 4.4 Integration into OpenCliBridgeSettings.vue

- Add tab: "Domain Configuration"
- Embed DomainConfiguration component
- Pass projectId, userId, workingDirectory, serverUrl, and apiKey as props
- serverUrl and apiKey come from the a2aConfig Pinia store

#### 4.5 QA: Domain Configuration Push

**Backend Test**:
- **Tool**: Vitest
- **Command**: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/domainConfig.test.ts`
- **Expected Result**: 2/2 tests pass
  - Test 1: `PUT /api/opencli/domains` updates config file and broadcasts to browser clients
  - Test 2: Config update message sent to bridge via `bridgeRegistry.get()` with correct format

**API Test**:
- **Tool**: curl
- **Command**:
  ```bash
  curl -X PUT "http://localhost:4936/api/opencli/domains" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "projectId": "proj_123",
      "userId": "user_123",
      "workingDirectory": "D:/workspace/my-project",
      "domains": {
        "social": true,
        "media": false,
        "finance": true,
        "news": false,
        "desktop": true,
        "jobs": false
      }
    }'
  ```
- **Expected Result**: HTTP 200, response includes `success: true`, `updated: ["social", "finance", "desktop"]`

**File Persistence Test**:
- **Tool**: Node.js script or Backend API
- **Steps**:
  1. **Read config via API** (recommended, cross-platform):
     ```bash
     curl -X GET "http://localhost:4936/api/opencli/config?projectId=proj_123&userId=user_123" \
       -H "Authorization: Bearer $TOKEN"
     ```
  2. Verify output: `enabledDomains` matches saved config `["social", "finance", "desktop"]`
  3. Restart backend: `cd agentstudio/backend && pnpm run dev`
  4. Reload browser
  5. Verify toggles still match saved config
- **Expected Result**: Config persists across restarts
- **Note**: Project path comes from `ProjectDetail.vue` (`project.path`)

**Browser UI Test** (Manual):
- **Steps**:
  1. Open `/platform/a2a-projects` in browser
  2. Click project card to open detail modal
  3. Scroll to "OpenCLI Bridge" section → "Domain Configuration" tab
  4. Verify 6 toggles visible: social, media, finance, news, desktop, jobs
  5. Toggle "social" from true to false, click "Save Configuration"
  6. Observe: Message "Configuration updated successfully" appears
  7. **Verify file updated** (browser DevTools Console):
     - The DomainConfiguration component loads current config on mount
     - Simply refresh the page and verify toggles reflect the saved state
     - Or use backend API directly:
       ```bash
       curl -s "http://localhost:4936/api/opencli/config?projectId=proj_123&userId=user_123" \
         -H "Authorization: Bearer $TOKEN" | jq .enabledDomains
       ```
     - Verify `enabledDomains` array doesn't include "social"
- **Expected Result**: UI updates, config persists, no console errors

---

## Technical Specifications

### File-Based Storage

**History Storage Location**: `.a2a/opencli-history.json` (same directory as `opencli-config.json`)

**File Format**:
```json
{
  "version": "1.0.0",
  "records": [
    {
      "id": "hist_xxx",
      "projectId": "proj_123",
      "bridgeId": "bridge_xxx",
      "command": "twitter post 'Hello'",
      "status": "success",
      "exitCode": 0,
      "stdout": "Posted successfully",
      "stderr": "",
      "executedAt": "2026-03-30T10:30:00Z",
      "completedAt": "2026-03-30T10:30:02Z",
      "duration": 2000,
      "userId": "user_123",
      "userEmail": "dev@example.com"
    }
  ]
}
```

**Max Records**: 1000 (older records automatically pruned)

**Config Storage Location**: `.a2a/opencli-config.json` (existing)

**Config Format**:
```json
{
  "enabled": true,
  "enabledDomains": ["social", "media", "desktop"]
}
```

### WebSocket Message Types

**Subscription** (client → server):
```json
{
  "type": "subscribe",
  "channel": "opencli-bridge",
  "projectId": "proj_123"
}
```

**Bridge Events** (server → client):
```json
{
  "type": "opencli:online",
  "projectId": "proj_123",
  "bridgeId": "bridge_xxx",
  "timestamp": 1711862415000
}
```

```json
{
  "type": "opencli:offline",
  "projectId": "proj_123",
  "bridgeId": "bridge_xxx",
  "timestamp": 1711862415000,
  "reason": "heartbeat timeout"
}
```

```json
{
  "type": "opencli:error",
  "projectId": "proj_123",
  "bridgeId": "bridge_xxx",
  "timestamp": 1711862415000,
  "reason": "connection error"
}
```

**Config Update** (server → client):
```json
{
  "type": "opencli:config_update",
  "projectId": "proj_123",
  "domains": {
    "social": true,
    "media": false,
    "finance": true,
    "news": false,
    "desktop": true,
    "jobs": false
  },
  "timestamp": 1711862415000
}
```

**Diagnostics** (client → server):
```json
{
  "type": "opencli:diagnose",
  "projectId": "proj_123"
}
```

**Diagnostics Result** (server → client):
```json
{
  "type": "opencli:diagnose_result",
  "projectId": "proj_123",
  "bridgeId": "bridge_xxx",
  "version": "1.2.3",
  "status": "connected",
  "lastHeartbeat": "2026-03-30T10:30:00Z",
  "uptime": 86400,
  "configValid": true,
  "configErrors": [],
  "permissionsValid": true,
  "permissionErrors": [],
  "networkLatency": 45,
  "timestamp": 1711862415000
}
```

### API Summary

| Method | Endpoint | Status | Priority |
|--------|----------|--------|----------|
| GET | `/api/opencli/config` | New | P0 |
| GET | `/api/opencli/history` | New | P0 |
| POST | `/api/opencli/diagnose` | New | P1 |
| PUT | `/api/opencli/domains` | New | P1 |
| DELETE | `/api/opencli/keys` | Exists | P2 |

---

## Frontend Component Specifications

### OpenCliBridgeSettings.vue (Refactor)

**Location**: `weknora-ui/src/components/a2a-project/OpenCliBridgeSettings.vue`
**Current**: 93 lines, pairing only
**Target**: ~120 lines (tab container + child component imports; logic lives in child components)

**Prerequisite**: Add Vite proxy rule before `/api` wildcard in `weknora-ui/vite.config.ts`:
```typescript
'/api/opencli': { target: 'http://localhost:4936', changeOrigin: true },
```

**Structure**:
```
<template>
  <div class="opencli-settings">
    <BridgeStatusBanner :projectId="projectId" :serverUrl="serverUrl" />

    <t-tabs>
      <t-tab-panel label="Pairing">
        <PairingTokenGenerator />
      </t-tab-panel>
      <t-tab-panel label="Connection Status">
        <ConnectionStatus />
      </t-tab-panel>
      <t-tab-panel label="Domain Configuration">
        <DomainConfiguration />
      </t-tab-panel>
      <t-tab-panel label="Remote Diagnostics">
        <DiagnosticsModal />
      </t-tab-panel>
      <t-tab-panel label="Execution History">
        <HistoryTable />
      </t-tab-panel>
      <t-tab-panel label="Revoke">
        <RevokeButton />
      </t-tab-panel>
    </t-tabs>
  </div>
</template>
```

### New Components

1. **BridgeStatusBanner.vue** (50 lines)
   - Uses TDesign `<t-alert>` component
   - Real-time status via `useAgentStudioWS` subscribe/on/off
   - Requires `serverUrl` prop for multi-server support
   - Auto-dismiss on reconnect

2. **HistoryTable.vue** (120 lines)
   - Paginated table
   - Filters and sorting
   - Detail modal

3. **DiagnosticsModal.vue** (100 lines)
   - Diagnostic report display
   - Run button
   - Result formatting

4. **DomainConfiguration.vue** (100 lines)
   - 6 toggle switches using TDesign `<t-checkbox>` (social, media, finance, news, desktop, jobs)
   - Loads current config on mount via API
   - Requires `serverUrl` and `apiKey` props for auth
   - Save button with loading state
   - Listens for WS config updates from other clients

5. **ConnectionStatus.vue** (60 lines)
   - Bridge ID, version, uptime
   - Last heartbeat
   - Status indicator

---

## Testing Strategy

### Backend Tests

**File**: `agentstudio/backend/src/services/opencli/__tests__/bridgeHistoryStore.test.ts`

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { BridgeHistoryStore } from '../bridgeHistoryStore';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('BridgeHistoryStore', () => {
  let store: BridgeHistoryStore;
  const testDir = path.join(os.tmpdir(), 'test-a2a-' + Date.now());

  beforeEach(() => {
    store = new BridgeHistoryStore();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  test('recordExecution writes record to .a2a/opencli-history.json', async () => {
    const record = {
      id: 'hist_1',
      projectId: 'proj_123',
      bridgeId: 'bridge_1',
      command: 'twitter post hello',
      status: 'success' as const,
      exitCode: 0,
      executedAt: new Date().toISOString(),
      userId: 'user_1',
      userEmail: 'test@example.com'
    };

    await store.recordExecution(testDir, record);

    const historyPath = path.join(testDir, '.a2a', 'opencli-history.json');
    expect(fs.existsSync(historyPath)).toBe(true);
    
    const content = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    expect(content.records).toHaveLength(1);
    expect(content.records[0]).toMatchObject(record);
  });

  test('getHistory returns records with pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await store.recordExecution(testDir, {
        id: `hist_${i}`,
        projectId: 'proj_123',
        bridgeId: 'bridge_1',
        command: `cmd_${i}`,
        status: 'success' as const,
        exitCode: 0,
        executedAt: new Date().toISOString(),
        userId: 'user_1',
        userEmail: 'test@example.com'
      });
    }

    const page1 = await store.getHistory(testDir, 3, 0);
    expect(page1).toHaveLength(3);

    const page2 = await store.getHistory(testDir, 3, 3);
    expect(page2).toHaveLength(2);
  });

  test('clearHistory removes old records', async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    
    await store.recordExecution(testDir, {
      id: 'hist_old',
      projectId: 'proj_123',
      bridgeId: 'bridge_1',
      command: 'old_cmd',
      status: 'success' as const,
      exitCode: 0,
      executedAt: oldDate,
      userId: 'user_1',
      userEmail: 'test@example.com'
    });

    const deleted = await store.clearHistory(testDir, 90);
    expect(deleted).toBe(1);

    const remaining = await store.getHistory(testDir, 50, 0);
    expect(remaining).toHaveLength(0);
  });
});
```

**Run Test**:
```bash
cd agentstudio/backend
npx vitest run src/services/opencli/__tests__/bridgeHistoryStore.test.ts
```

**Expected Output**:
```
✓ recordExecution writes record to .a2a/opencli-history.json
✓ getHistory returns records with pagination
✓ clearHistory removes old records

Test Files  1 passed (1)
     Tests  3 passed (3)
```

### WebSocket Broadcast Tests

**File**: `agentstudio/backend/src/services/__tests__/websocketService.test.ts`

```typescript
describe('broadcastOpenCliBridgeEvent', () => {
  test('sends message to subscribed clients only', () => {
    const client1 = createMockClient();
    const client2 = createMockClient();
    
    client1.subscribedOpenCliBridges = new Set(['proj_123']);
    client2.subscribedOpenCliBridges = new Set(['proj_456']);
    
    broadcastOpenCliBridgeEvent('proj_123', {
      type: 'opencli:online',
      bridgeId: 'bridge_1',
      timestamp: Date.now()
    });
    
    expect(client1.ws.send).toHaveBeenCalled();
    expect(client2.ws.send).not.toHaveBeenCalled();
  });

  test('message format includes required fields', () => {
    const client = createMockClient();
    client.subscribedOpenCliBridges = new Set(['proj_123']);
    
    broadcastOpenCliBridgeEvent('proj_123', {
      type: 'opencli:offline',
      bridgeId: 'bridge_1',
      timestamp: 1711862415000,
      reason: 'heartbeat timeout'
    });
    
    const message = JSON.parse(client.ws.send.mock.calls[0][0]);
    expect(message).toHaveProperty('type', 'opencli:offline');
    expect(message).toHaveProperty('bridgeId', 'bridge_1');
    expect(message).toHaveProperty('timestamp');
    expect(message).toHaveProperty('reason');
  });
});
```

**Run Test**:
```bash
cd agentstudio/backend
npx vitest run src/services/__tests__/websocketService.test.ts
```

### Domain Configuration Tests

**File**: `agentstudio/backend/src/services/opencli/__tests__/domainConfig.test.ts`

```typescript
describe('Domain Configuration', () => {
  test('PUT /api/opencli/domains updates config file', async () => {
    const response = await request(app)
      .put('/api/opencli/domains')
      .set('Authorization', `Bearer ${token}`)
      .send({
        projectId: 'proj_123',
        userId: 'user_123',
        workingDirectory: testDir,
        domains: {
          social: true,
          media: false,
          finance: true,
          news: false,
          desktop: true,
          jobs: false
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.updated).toContain('social');

    // Verify file was written
    const configPath = path.join(testDir, '.a2a', 'opencli-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.enabledDomains).toEqual(['social', 'finance', 'desktop']);
  });

  test('Config update sent to bridge via bridgeRegistry', async () => {
    const mockBridgeEntry = {
      ws: { readyState: WebSocket.OPEN, send: vi.fn() },
      projectId: 'proj_123',
      userId: 'user_123'
    };
    
    vi.spyOn(bridgeRegistry, 'get').mockReturnValue(mockBridgeEntry);

    await request(app)
      .put('/api/opencli/domains')
      .set('Authorization', `Bearer ${token}`)
      .send({
        projectId: 'proj_123',
        userId: 'user_123',
        workingDirectory: testDir,
        domains: { social: true, media: false, finance: true, news: false, desktop: true, jobs: false }
      });

    expect(mockBridgeEntry.ws.send).toHaveBeenCalled();
    const message = JSON.parse(mockBridgeEntry.ws.send.mock.calls[0][0]);
    expect(message.type).toBe('config_update');
    expect(message.enabledDomains).toEqual(['social', 'finance', 'desktop']);
  });
});
```

**Run Test**:
```bash
cd agentstudio/backend
npx vitest run src/services/opencli/__tests__/domainConfig.test.ts
```

### Diagnostics Tests

**File**: `agentstudio/backend/src/services/opencli/__tests__/bridgeDiagnostics.test.ts`

```typescript
describe('Bridge Diagnostics', () => {
  test('POST /api/opencli/diagnose sends diagnose message to bridge', async () => {
    const mockBridgeEntry = {
      ws: { readyState: WebSocket.OPEN, send: vi.fn() },
      projectId: 'proj_123',
      userId: 'user_123'
    };
    
    vi.spyOn(bridgeRegistry, 'get').mockReturnValue(mockBridgeEntry);

    const response = await request(app)
      .post('/api/opencli/diagnose')
      .set('Authorization', `Bearer ${token}`)
      .send({
        projectId: 'proj_123',
        userId: 'user_123'
      });

    expect(mockBridgeEntry.ws.send).toHaveBeenCalled();
    const message = JSON.parse(mockBridgeEntry.ws.send.mock.calls[0][0]);
    expect(message.type).toBe('diagnose');
  });

  test('Diagnostics timeout after 10s if no response', async () => {
    const mockBridgeEntry = {
      ws: { readyState: WebSocket.OPEN, send: vi.fn() },
      projectId: 'proj_123',
      userId: 'user_123'
    };
    
    vi.spyOn(bridgeRegistry, 'get').mockReturnValue(mockBridgeEntry);

    const response = await request(app)
      .post('/api/opencli/diagnose')
      .set('Authorization', `Bearer ${token}`)
      .send({
        projectId: 'proj_123',
        userId: 'user_123'
      })
      .timeout(15000);

    expect(response.status).toBe(504); // Gateway Timeout
  });
});
```

**Run Test**:
```bash
cd agentstudio/backend
npx vitest run src/services/opencli/__tests__/bridgeDiagnostics.test.ts
```

### Frontend Manual Testing

**Note**: `weknora-ui` has Vitest installed (`vitest@4.0.18`) and some test files exist (e.g., `useAgentStudioWS.test.ts`), but test coverage is minimal. Frontend testing for these new components is primarily manual via browser.

**Manual Test Checklist**:

1. **Execution History**:
   - Navigate to `/platform/a2a-projects` → "OpenCLI Settings" → "Execution History"
   - Verify table displays with columns: Command, Status, Duration, Executed At, User
   - Test filters: Status dropdown, date range picker
   - Click "View Details" on a record → verify modal shows stdout/stderr

2. **Offline Alert**:
   - Open `/platform/a2a-projects`, click project card to open detail modal
   - Scroll to "OpenCLI Bridge" section
   - **Simulate bridge offline**: Close opencli-bridge desktop app (or use backend test API if available)
   - Verify: Banner appears with "Bridge is offline" message within 2s
   - **Reconnect**: Reopen opencli-bridge app
   - Verify: Banner changes to "Bridge is online", auto-dismisses after 3s

3. **Domain Configuration**:
   - Navigate to `/platform/a2a-projects`, click project card
   - Scroll to "OpenCLI Bridge" → "Domain Configuration" tab
   - Verify 6 toggles visible: social, media, finance, news, desktop, jobs
   - Verify toggles show **current saved state** (loaded from API on mount), not hardcoded defaults
   - Toggle "social" to false, click "Save Configuration"
   - Verify success message appears
   - Refresh page → verify "social" toggle is still off (config persisted)
   - Or verify via API:
     ```bash
     curl -s "http://localhost:4936/api/opencli/config?projectId=proj_123&userId=user_123" \
       -H "Authorization: Bearer $TOKEN" | jq .enabledDomains
     ```

4. **Remote Diagnostics**:
   - Navigate to `/platform/a2a-projects` → "OpenCLI Settings" → "Remote Diagnostics"
   - Click "Run Diagnostics"
   - Verify report displays with: Bridge ID, Version, Status, Last Heartbeat, Uptime, Config Valid, Permissions Valid, Network Latency
   - Click "Run Diagnostics" again to verify refresh works

---

## Rollout Plan

### Week 1: P0 Features

**Day 0 (Prerequisite)**: Vite Proxy & Backend WS Setup
- Add `/api/opencli` proxy rule to `weknora-ui/vite.config.ts` (before `/api` wildcard)
- Add `opencli-bridge` channel to `handleClientMessage()` in `websocketService.ts`
- Add `subscribedOpenCliBridges` to `WSClient` interface
- Add cleanup in `cleanupClient()`

**Day 1-2**: Execution History System
- Implement BridgeHistoryStore
- Add history API endpoint
- Write backend tests

**Day 3-4**: Real-time Offline Alert
- Implement broadcastOpenCliBridgeEvent()
- Create BridgeStatusBanner component
- Add WebSocket subscription

**Day 5**: Integration & Testing
- Integrate both features into OpenCliBridgeSettings
- End-to-end testing
- Code review

### Week 2: P1 Features

**Day 1-2**: Remote Diagnostics
- Implement diagnostics API
- Create DiagnosticsModal component
- Write tests

**Day 3-4**: Domain Configuration Push
- Implement domain configuration API
- Create DomainConfiguration component
- Add config broadcaster

**Day 5**: Integration & Polish
- Integrate all features
- Performance testing
- Documentation

### Deployment

1. **Staging**: Deploy to staging environment, run full test suite
2. **Canary**: Deploy to 10% of production, monitor for 24h
3. **Full Rollout**: Deploy to 100% of production
4. **Monitoring**: Alert on history store errors, WebSocket broadcast failures

---

## Success Criteria

- [ ] All 4 features implemented and tested
- [ ] Vite proxy `/api/opencli` added to `weknora-ui/vite.config.ts` before `/api` wildcard
- [ ] `opencli-bridge` WS channel subscription handled in `websocketService.ts`
- [ ] OpenCliBridgeSettings.vue refactored to tab-based console (using TDesign `<t-tabs>`)
- [ ] History table shows 50+ records with filtering
- [ ] Offline alert appears within 2s of bridge disconnect
- [ ] Diagnostics report completes within 10s
- [ ] Domain configuration updates bridge within 2s
- [ ] All tests passing (backend + frontend)
- [ ] Code review approved
- [ ] Documentation updated

---

## References

- **File-Based Storage Pattern**: `agentstudio/backend/src/services/opencli/opencliConfigStorage.ts` (uses `fs.writeFileSync` to `.a2a/opencli-config.json`)
- **WebSocket Broadcast Pattern**: `agentstudio/backend/src/services/websocketService.ts:278` (`broadcastCronEvent()` — iterate clients, check subscription, call `sendSafe()`)
- **Frontend WebSocket Composable**: `weknora-ui/src/composables/useAgentStudioWS.ts` (multi-server connection manager: subscribe L277, on L345, off L350, auto-dispatch by data.type L138-150)
- **Frontend Auth Composable**: `weknora-ui/src/composables/useAgentStudioAuth.ts` (getToken(serverUrl, adminPassword) → JWT, cached with expiry)
- **Frontend Test Infrastructure**: `weknora-ui` has `vitest@4.0.18` installed, test file exists at `composables/__tests__/useAgentStudioWS.test.ts`
- **Bridge Connection Handler**: `agentstudio/backend/src/routes/opencliWs.ts:71` (`handleBridgeConnection()`)
- **Bridge Registry Lookup**: `agentstudio/backend/src/services/opencli/bridgeRegistry.ts:58` (`get(projectId, userId)`)
- **Project A2A Directory**: `agentstudio/backend/src/config/paths.ts:196` (`getProjectA2ADir(projectPath)`)
- **Command Execution**: `agentstudio/backend/src/services/opencli/bridgeCommandProxy.ts:11` (dispatch method)
- **Domain Constants**: `agentstudio/backend/src/services/opencli/constants.ts:1` (DOMAIN_MAPPING)
- **Type Definitions**: `agentstudio/backend/src/services/opencli/types.ts:51` (OpenCliProjectConfig)
- **Existing Routes**: `agentstudio/backend/src/routes/opencli.ts:19` (/pairing-token, /keys, /status)
- **Frontend Components**: `weknora-ui/src/components/a2a-project/` (OpenCliBridgeSettings.vue, BridgeManagement.vue)
- **Frontend Scripts**: `weknora-ui/package.json:7` (available: dev, build, type-check, preview, docker:build, docker:up, docker:down)
