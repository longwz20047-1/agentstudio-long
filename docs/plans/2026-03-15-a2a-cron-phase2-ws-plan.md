# Phase 2: WebSocket 多连接改造 + 活动会话修复 实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 weknora-ui 的 WebSocket 从单连接模型改为多连接模型，修复活动会话数据覆盖 Bug，为 A2A Cron 实时推送打基础。

**Architecture:** `useAgentStudioWS.ts` 从单个 `ws` ref 改为 `Map<serverUrl, WSConnection>` 多连接模型。`subscribe()` 增加可选 `serverUrl` 参数区分广播/定向订阅。`menu.vue` 引入 `sessionsByServer` Map 作为唯一数据源，消除 REST/WebSocket 数据覆盖竞态。

**Tech Stack:** Vue 3.5 Composition API, Pinia, WebSocket, TypeScript, Vitest

**Parent Design Doc:** `agentstudio/docs/plans/2026-03-15-a2a-cron-service-design.md` §WebSocket 多连接改造（行 236-565）

---

## File Structure

### 修改文件（5 个）

| File | Responsibility | Changes |
|------|---------------|---------|
| `src/composables/useAgentStudioWS.ts` | WebSocket 多连接管理 | 完整重写：单连接 → 多连接 Map |
| `src/components/menu.vue` | 侧边栏 + 活动会话 | connectAll 初始化 + sessionsByServer 聚合修复 |
| `src/views/a2a-chat/components/ActiveSessionsPanel.vue` | 活跃会话面板 | handler 泄漏修复 + serverUrl 过滤 |
| `src/views/a2a-chat/index.vue` | A2A 聊天主页 | 移除 wsConnect，wsSub 加 serverUrl |
| `src/views/a2a-project/index.vue` | A2A 项目管理 | 服务器增删同步 WS 连接 |

### 新建文件（1 个）

| File | Responsibility |
|------|---------------|
| `src/composables/__tests__/useAgentStudioWS.test.ts` | 多连接核心逻辑单元测试 |

**所有路径相对于 `D:\workspace\agent-weknora\weknora-ui\`。**

---

## Chunk 1: 核心改造

### Task 1: 重写 useAgentStudioWS.ts

**Files:**
- Rewrite: `src/composables/useAgentStudioWS.ts` (133 → ~220 lines)
- Test: `src/composables/__tests__/useAgentStudioWS.test.ts`

#### 当前 API（将被替换）

```typescript
// 旧 API — 单连接
export function useAgentStudioWS() {
  return { isConnected, connect, disconnect, subscribe, unsubscribe, on, off }
}
```

#### 新 API

```typescript
// 新 API — 多连接
export function useAgentStudioWS() {
  return {
    isConnected,             // computed: 任一连接活跃即为 true
    connectAll,              // (servers: A2AServerConfig[]) => void
    disconnectAll,           // () => void
    addConnection,           // (server: A2AServerConfig) => void
    removeConnection,        // (serverUrl: string) => void
    getConnectionStatus,     // (serverUrl: string) => boolean
    subscribe,               // (channel, params?, serverUrl?) => void  ← 新增第三参数
    unsubscribe,             // (channel, serverUrl?) => void           ← 新增第二参数
    on,                      // (type, handler) => void                 ← 不变
    off,                     // (type, handler) => void                 ← 不变
  }
}
```

- [ ] **Step 1: 写单元测试骨架**

创建 `src/composables/__tests__/useAgentStudioWS.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = []
  readyState = 0 // CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: any) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }
  send(data: string) { this.sent.push(data) }
  close() { this.onclose?.() }

  // Test helpers
  simulateOpen() { this.readyState = 1; this.onopen?.() }
  simulateMessage(data: any) { this.onmessage?.({ data: JSON.stringify(data) }) }
  simulateClose() { this.readyState = 3; this.onclose?.() }
}

vi.stubGlobal('WebSocket', MockWebSocket)

describe('useAgentStudioWS', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
  })

  describe('connectAll', () => {
    it('should create connections for all servers', () => {
      // test implemented in step 5
    })
  })

  describe('subscribe with serverUrl', () => {
    it('should send subscribe to specific connection when serverUrl specified', () => {
      // test implemented in step 5
    })

    it('should send subscribe to all connections when serverUrl omitted', () => {
      // test implemented in step 5
    })
  })

  describe('message routing', () => {
    it('should inject _serverUrl into messages', () => {
      // test implemented in step 5
    })
  })

  describe('subscribe upsert with unsubscribe', () => {
    it('should unsubscribe from old server when switching serverUrl', () => {
      // test implemented in step 5
    })
  })
})
```

Run: `cd weknora-ui && npx vitest run src/composables/__tests__/useAgentStudioWS.test.ts`
Expected: Tests created, all skipped/empty.

- [ ] **Step 2: 实现新的 useAgentStudioWS.ts**

完整重写 `src/composables/useAgentStudioWS.ts`：

```typescript
import { ref, computed } from 'vue'
import type { A2AServerConfig } from '@/api/a2a/types'

// --- Types ---

interface WSConnection {
  ws: WebSocket | null
  serverUrl: string
  serverName: string
  apiKey: string
  isConnected: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectDelay: number
}

type Handler = (data: any) => void

// --- Module-level state (singleton) ---

const connections = new Map<string, WSConnection>()
const handlers = new Map<string, Set<Handler>>()
const activeSubscriptions: Array<{
  channel: string
  params: Record<string, any>
  serverUrl?: string   // 空 = 广播到所有连接；指定 = 只发到对应连接
}> = []

// 手动维护的连接计数（解决 plain Map 非响应式问题）
// Vue computed 无法追踪 plain Map 的变化，用 ref 计数手动触发更新
const connectedCount = ref(0)
const isConnected = computed(() => connectedCount.value > 0)

function updateConnectedCount() {
  let count = 0
  for (const conn of connections.values()) {
    if (conn.isConnected) count++
  }
  connectedCount.value = count
}

// --- Connection management ---

function createConnection(server: A2AServerConfig): WSConnection {
  return {
    ws: null,
    serverUrl: server.serverUrl,
    serverName: server.name,
    apiKey: server.apiKey,
    isConnected: false,
    reconnectTimer: null,
    reconnectDelay: 1000,
  }
}

function connectOne(conn: WSConnection) {
  // 已连接则跳过
  if (conn.ws?.readyState === WebSocket.OPEN) return

  // 清理旧连接
  if (conn.ws) {
    conn.ws.onclose = null
    conn.ws.close()
    conn.ws = null
  }

  const wsUrl = conn.serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(conn.apiKey)
  const socket = new WebSocket(wsUrl)

  socket.onopen = () => {
    conn.isConnected = true
    conn.ws = socket
    conn.reconnectDelay = 1000
    updateConnectedCount()  // 触发 isConnected 响应式更新
    // onopen replay: 只发送匹配当前连接的订阅
    for (const sub of activeSubscriptions) {
      if (!sub.serverUrl || sub.serverUrl === conn.serverUrl) {
        socket.send(JSON.stringify({ type: 'subscribe', channel: sub.channel, ...sub.params }))
      }
    }
  }

  socket.onclose = () => {
    conn.isConnected = false
    conn.ws = null
    updateConnectedCount()  // 触发 isConnected 响应式更新
    // 通知前端内部事件（_前缀区分后端事件）
    const closeHandlers = handlers.get('_connection:closed')
    if (closeHandlers) {
      for (const handler of closeHandlers) handler({ _serverUrl: conn.serverUrl })
    }
    scheduleReconnect(conn)
  }

  socket.onerror = () => {
    // onclose will fire after onerror
  }

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      // 注入来源信息
      data._serverUrl = conn.serverUrl
      data._serverName = conn.serverName
      const typeHandlers = handlers.get(data.type)
      if (typeHandlers) {
        for (const handler of typeHandlers) handler(data)
      }
    } catch {
      // Ignore malformed messages
    }
  }
}

function scheduleReconnect(conn: WSConnection) {
  if (conn.reconnectTimer) return
  if (!connections.has(conn.serverUrl)) return // 已被 removeConnection 删除
  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null
    if (connections.has(conn.serverUrl)) {
      connectOne(conn)
      conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, 30000)
    }
  }, conn.reconnectDelay)
}

// --- Public API ---

function connectAll(servers: A2AServerConfig[]) {
  // 关闭不在列表中的旧连接
  for (const [url, conn] of connections) {
    if (!servers.some(s => s.serverUrl === url)) {
      cleanupConnection(conn)
      connections.delete(url)
    }
  }
  // 创建或更新连接
  for (const server of servers) {
    let conn = connections.get(server.serverUrl)
    if (!conn) {
      conn = createConnection(server)
      connections.set(server.serverUrl, conn)
    } else {
      // 更新 apiKey/name（可能被修改）
      conn.apiKey = server.apiKey
      conn.serverName = server.name
    }
    connectOne(conn)
  }
}

function disconnectAll() {
  // 逐个通知 _connection:closed（让 menu.vue 清理 sessionsByServer）
  const closeHandlers = handlers.get('_connection:closed')
  for (const conn of connections.values()) {
    cleanupConnection(conn)
    if (closeHandlers) {
      for (const handler of closeHandlers) handler({ _serverUrl: conn.serverUrl })
    }
  }
  connections.clear()
  activeSubscriptions.length = 0
  updateConnectedCount()
}

function addConnection(server: A2AServerConfig) {
  let conn = connections.get(server.serverUrl)
  if (conn) {
    // apiKey 变更时需要重建连接（旧连接认证已过期）
    const apiKeyChanged = conn.apiKey !== server.apiKey
    conn.apiKey = server.apiKey
    conn.serverName = server.name
    if (apiKeyChanged) {
      cleanupConnection(conn)  // 关闭旧连接
    }
  } else {
    conn = createConnection(server)
    connections.set(server.serverUrl, conn)
  }
  connectOne(conn)
}

function removeConnection(serverUrl: string) {
  const conn = connections.get(serverUrl)
  if (conn) {
    cleanupConnection(conn)
    connections.delete(serverUrl)
    // 清理该服务器的订阅
    for (let i = activeSubscriptions.length - 1; i >= 0; i--) {
      if (activeSubscriptions[i].serverUrl === serverUrl) {
        activeSubscriptions.splice(i, 1)
      }
    }
    updateConnectedCount()
    // 通知断线（同 onclose，但这是主动断开）
    const closeHandlers = handlers.get('_connection:closed')
    if (closeHandlers) {
      for (const handler of closeHandlers) handler({ _serverUrl: serverUrl })
    }
  }
}

function cleanupConnection(conn: WSConnection) {
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer)
    conn.reconnectTimer = null
  }
  if (conn.ws) {
    conn.ws.onclose = null
    conn.ws.close()
  }
  conn.ws = null
  conn.isConnected = false
}

function getConnectionStatus(serverUrl: string): boolean {
  return connections.get(serverUrl)?.isConnected ?? false
}

// --- Subscription ---

function subscribe(channel: string, params: Record<string, any> = {}, serverUrl?: string) {
  // Upsert: 替换同 channel 的旧订阅
  const existing = activeSubscriptions.findIndex(s => s.channel === channel)
  if (existing >= 0) {
    const old = activeSubscriptions[existing]
    // 旧订阅绑定了特定服务器，且与新服务器不同 → 向旧服务器发 unsubscribe
    if (old.serverUrl && old.serverUrl !== serverUrl) {
      const oldConn = connections.get(old.serverUrl)
      if (oldConn?.ws?.readyState === WebSocket.OPEN) {
        oldConn.ws.send(JSON.stringify({ type: 'unsubscribe', channel }))
      }
    }
    activeSubscriptions.splice(existing, 1)
  }
  activeSubscriptions.push({ channel, params, serverUrl })

  // 发送到目标连接
  const msg = JSON.stringify({ type: 'subscribe', channel, ...params })
  if (serverUrl) {
    const conn = connections.get(serverUrl)
    if (conn?.ws?.readyState === WebSocket.OPEN) {
      conn.ws.send(msg)
    }
  } else {
    for (const conn of connections.values()) {
      if (conn.ws?.readyState === WebSocket.OPEN) {
        conn.ws.send(msg)
      }
    }
  }
}

function unsubscribe(channel: string, serverUrl?: string) {
  // 移除匹配的订阅记录
  const idx = activeSubscriptions.findIndex(s =>
    s.channel === channel && s.serverUrl === serverUrl
  )
  if (idx >= 0) activeSubscriptions.splice(idx, 1)

  // 发送 unsubscribe
  const msg = JSON.stringify({ type: 'unsubscribe', channel })
  if (serverUrl) {
    const conn = connections.get(serverUrl)
    if (conn?.ws?.readyState === WebSocket.OPEN) {
      conn.ws.send(msg)
    }
  } else {
    for (const conn of connections.values()) {
      if (conn.ws?.readyState === WebSocket.OPEN) {
        conn.ws.send(msg)
      }
    }
  }
}

// --- Event handlers ---

function on(type: string, handler: Handler) {
  if (!handlers.has(type)) handlers.set(type, new Set())
  handlers.get(type)!.add(handler)
}

function off(type: string, handler: Handler) {
  handlers.get(type)?.delete(handler)
}

// --- Export ---

export function useAgentStudioWS() {
  return {
    isConnected,
    connectAll,
    disconnectAll,
    addConnection,
    removeConnection,
    getConnectionStatus,
    subscribe,
    unsubscribe,
    on,
    off,
  }
}
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `cd weknora-ui && npx vue-tsc --noEmit 2>&1 | head -30`
Expected: 编译错误（消费者仍使用旧 API `connect`、`disconnect`），但 `useAgentStudioWS.ts` 本身无错误。

- [ ] **Step 4: 确认旧 API 调用者列表**

以下调用者将报错（预期的，后续 Task 逐一修复）：

| 调用者 | 旧 API | 新 API |
|--------|--------|--------|
| `a2a-chat/index.vue:1093` | `connect: wsConnect` | 移除 `wsConnect`，解构不含 `connect` |
| `a2a-chat/index.vue:1386` | `wsConnect(serverUrl, apiKey)` | 移除此调用 |
| `menu.vue:673` | `subscribe: wsSub` | 签名兼容（新增可选参数），无需改 |
| `ActiveSessionsPanel.vue:24` | 无直接调用 connect | 无需改（但 handler 需修复） |

- [ ] **Step 5: 补全单元测试**

更新 `src/composables/__tests__/useAgentStudioWS.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: any) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }
  send(data: string) { this.sent.push(data) }
  close() { /* noop in test */ }

  simulateOpen() { this.readyState = 1; this.onopen?.() }
  simulateMessage(data: any) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

vi.stubGlobal('WebSocket', MockWebSocket)

// 需要每次测试重置模块状态，使用 dynamic import
let useAgentStudioWS: any

beforeEach(async () => {
  MockWebSocket.instances = []
  // 重置模块（清除 connections Map 等模块级状态）
  vi.resetModules()
  const mod = await import('../useAgentStudioWS')
  useAgentStudioWS = mod.useAgentStudioWS
})

const serverA = { id: '1', name: 'Dev', serverUrl: 'http://dev:4936', apiKey: 'key_a', createdAt: '' }
const serverB = { id: '2', name: 'Prod', serverUrl: 'http://prod:4936', apiKey: 'key_b', createdAt: '' }

describe('useAgentStudioWS', () => {
  describe('connectAll', () => {
    it('should create WebSocket for each server', () => {
      const { connectAll } = useAgentStudioWS()
      connectAll([serverA, serverB])
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(MockWebSocket.instances[0].url).toContain('dev:4936')
      expect(MockWebSocket.instances[1].url).toContain('prod:4936')
    })

    it('should set isConnected when any connection opens', () => {
      const { connectAll, isConnected } = useAgentStudioWS()
      connectAll([serverA])
      expect(isConnected.value).toBe(false)
      MockWebSocket.instances[0].simulateOpen()
      expect(isConnected.value).toBe(true)
    })
  })

  describe('subscribe with serverUrl', () => {
    it('should send to specific connection when serverUrl specified', () => {
      const { connectAll, subscribe } = useAgentStudioWS()
      connectAll([serverA, serverB])
      MockWebSocket.instances[0].simulateOpen()
      MockWebSocket.instances[1].simulateOpen()

      subscribe('workspace', { agentId: 'x' }, 'http://dev:4936')

      // 只有 dev 收到 subscribe
      const devSent = MockWebSocket.instances[0].sent
      const prodSent = MockWebSocket.instances[1].sent
      expect(devSent.some(m => m.includes('"workspace"'))).toBe(true)
      expect(prodSent.some(m => m.includes('"workspace"'))).toBe(false)
    })

    it('should broadcast to all when serverUrl omitted', () => {
      const { connectAll, subscribe } = useAgentStudioWS()
      connectAll([serverA, serverB])
      MockWebSocket.instances[0].simulateOpen()
      MockWebSocket.instances[1].simulateOpen()

      subscribe('sessions')

      expect(MockWebSocket.instances[0].sent.some(m => m.includes('"sessions"'))).toBe(true)
      expect(MockWebSocket.instances[1].sent.some(m => m.includes('"sessions"'))).toBe(true)
    })
  })

  describe('message routing', () => {
    it('should inject _serverUrl into messages', () => {
      const { connectAll, on } = useAgentStudioWS()
      connectAll([serverA])
      MockWebSocket.instances[0].simulateOpen()

      const received: any[] = []
      on('test:event', (data: any) => received.push(data))
      MockWebSocket.instances[0].simulateMessage({ type: 'test:event', payload: 1 })

      expect(received).toHaveLength(1)
      expect(received[0]._serverUrl).toBe('http://dev:4936')
      expect(received[0]._serverName).toBe('Dev')
    })
  })

  describe('subscribe upsert', () => {
    it('should unsubscribe old server when switching', () => {
      const { connectAll, subscribe } = useAgentStudioWS()
      connectAll([serverA, serverB])
      MockWebSocket.instances[0].simulateOpen()
      MockWebSocket.instances[1].simulateOpen()

      // 先订阅 dev
      subscribe('workspace', { agentId: 'x' }, 'http://dev:4936')
      // 切换到 prod
      subscribe('workspace', { agentId: 'y' }, 'http://prod:4936')

      // dev 应收到 unsubscribe
      const devSent = MockWebSocket.instances[0].sent
      expect(devSent.some(m => m.includes('"unsubscribe"'))).toBe(true)
    })
  })

  describe('removeConnection', () => {
    it('should notify _connection:closed', () => {
      const { connectAll, removeConnection, on } = useAgentStudioWS()
      connectAll([serverA, serverB])
      MockWebSocket.instances[0].simulateOpen()
      MockWebSocket.instances[1].simulateOpen()

      const closed: any[] = []
      on('_connection:closed', (data: any) => closed.push(data))
      removeConnection('http://dev:4936')

      expect(closed).toHaveLength(1)
      expect(closed[0]._serverUrl).toBe('http://dev:4936')
    })
  })
})
```

Run: `cd weknora-ui && npx vitest run src/composables/__tests__/useAgentStudioWS.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
cd weknora-ui
git add src/composables/useAgentStudioWS.ts src/composables/__tests__/useAgentStudioWS.test.ts
git commit -m "refactor: rewrite useAgentStudioWS to multi-connection model

Single ws ref replaced by Map<serverUrl, WSConnection>.
subscribe() now accepts optional serverUrl for targeted subscriptions.
Messages injected with _serverUrl/_serverName for source identification.
Upsert subscribe auto-unsubscribes from old server when switching."
```

---

### Task 2: 修复 menu.vue — 活动会话聚合 + connectAll 初始化

**Files:**
- Modify: `src/components/menu.vue` (lines 233-240, 650-680, 682-715, 717-721)

**前提:** Task 1 已完成。

- [ ] **Step 1: 更新 import**

```typescript
// 行 238-240，替换为：
import { loadServers } from '@/api/a2a/serverStorage';
import { useAgentStudioWS } from '@/composables/useAgentStudioWS';
```

无变化（import 语句兼容）。

- [ ] **Step 2: 替换 WebSocket 初始化 + session handler（行 650-680）**

旧代码（行 650-680）：

```typescript
async function loadActiveSessions() {
    try {
        const servers = loadServers()
        if (!servers.length) return

        const allIds = new Set<string>()
        const results = await Promise.allSettled(
            servers.map(s => fetchActiveSessions(s.serverUrl, s.apiKey))
        )
        for (const result of results) {
            if (result.status === 'fulfilled') {
                for (const session of result.value.sessions || []) {
                    allIds.add(session.sessionId)
                }
            }
        }
        usemenuStore.setActiveSessionIds(allIds)
    } catch {
        // 静默失败
    }
}

const { on: wsOn, off: wsOff, subscribe: wsSub, unsubscribe: wsUnsub } = useAgentStudioWS()

function handleSessionUpdate(data: any) {
  const ids = new Set<string>((data.sessions || []).map((s: any) => s.sessionId))
  usemenuStore.setActiveSessionIds(ids)
}
wsOn('session:update', handleSessionUpdate)
wsSub('sessions')
```

新代码：

```typescript
// --- WebSocket 多连接 + 活动会话聚合 ---

const { connectAll, on: wsOn, off: wsOff, subscribe: wsSub, unsubscribe: wsUnsub } = useAgentStudioWS()

// 按服务器维护的活动会话（唯一数据源，解决 REST/WS 数据覆盖问题）
const sessionsByServer = new Map<string, Set<string>>()

function mergeAndUpdateSessions() {
  const allIds = new Set<string>()
  for (const ids of sessionsByServer.values()) {
    for (const id of ids) allIds.add(id)
  }
  usemenuStore.setActiveSessionIds(allIds)
}

async function loadActiveSessions() {
  try {
    const servers = loadServers()
    if (!servers.length) return

    const results = await Promise.allSettled(
      servers.map(s => fetchActiveSessions(s.serverUrl, s.apiKey))
    )
    for (let i = 0; i < servers.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') {
        const ids = new Set<string>((result.value.sessions || []).map((s: any) => s.sessionId))
        sessionsByServer.set(servers[i].serverUrl, ids)
      }
    }
    mergeAndUpdateSessions()
  } catch {
    // 静默失败
  }
}

// WebSocket session 推送：按 serverUrl 更新，合并后更新 store
function handleSessionUpdate(data: any) {
  const serverUrl = data._serverUrl
  if (!serverUrl) return
  const ids = new Set<string>((data.sessions || []).map((s: any) => s.sessionId))
  sessionsByServer.set(serverUrl, ids)
  mergeAndUpdateSessions()
}

// 服务器断线：清除该服务器的数据
function handleConnectionClosed(data: any) {
  if (data._serverUrl) {
    sessionsByServer.delete(data._serverUrl)
    mergeAndUpdateSessions()
  }
}

wsOn('session:update', handleSessionUpdate)
wsOn('_connection:closed', handleConnectionClosed)
wsSub('sessions')  // 广播到所有连接（无 serverUrl 参数）
```

- [ ] **Step 3: 更新 onMounted — 加入 connectAll（行 682-715）**

在 `onMounted` 回调中，在 `loadActiveSessions()` 之前加入 WebSocket 多连接初始化：

```typescript
// 在 onMounted 中（行 710-711 之间），加入：
// 连接所有已配置的 AgentStudio 服务器 WebSocket
const servers = loadServers()
if (servers.length) {
  connectAll(servers)
}

// 加载活跃会话状态（一次性 REST 请求）
loadActiveSessions();
```

注意：`connectAll` 必须在 `wsSub('sessions')` 之后调用（或之前都行，因为 `wsSub` 已将 `sessions` 加入 `activeSubscriptions`，`connectAll` 的 `onopen` 会 replay）。但 `wsSub` 在模块顶层已调用（Step 2），在 `onMounted` 之前。所以只需在 `onMounted` 中调用 `connectAll`。

- [ ] **Step 4: 更新 onUnmounted（行 717-721）**

```typescript
onUnmounted(() => {
  wsOff('session:update', handleSessionUpdate)
  wsOff('_connection:closed', handleConnectionClosed)
  wsUnsub('sessions')
  window.removeEventListener('faqSelectionChanged', handleFaqSelectionChanged)
})
```

- [ ] **Step 5: Commit**

```bash
cd weknora-ui
git add src/components/menu.vue
git commit -m "fix: session aggregation via sessionsByServer Map

Replace single-server overwrite with per-server Map merge.
Add connectAll() in onMounted to establish all WS connections.
Handle _connection:closed to clean up disconnected server data."
```

---

### Task 3: 修复 ActiveSessionsPanel.vue — handler 泄漏 + serverUrl 过滤

**Files:**
- Modify: `src/views/a2a-chat/components/ActiveSessionsPanel.vue` (lines 1-29)

**问题（3 个 Bug）:**
1. 匿名 handler 无 `onUnmounted` 清理 → 组件重挂载时 handler 堆积泄漏
2. `sessions.value = data.sessions` 覆盖全部会话 → 多服务器数据互相覆盖
3. `menuStore.setActiveSessionIds(ids)` 重复调用 → 与 menu.vue 的聚合逻辑冲突

- [ ] **Step 1: 替换 WebSocket handler 代码（行 23-29）**

旧代码（行 23-29）：

```typescript
// WebSocket live session updates
const { on: wsOn } = useAgentStudioWS()
wsOn('session:update', (data: any) => {
  sessions.value = data.sessions || []
  const ids = new Set<string>((data.sessions || []).map((s: any) => s.sessionId))
  menuStore.setActiveSessionIds(ids)
})
```

新代码：

```typescript
// WebSocket live session updates — 按 serverUrl 过滤 + 命名 handler + 生命周期清理
const { on: wsOn, off: wsOff } = useAgentStudioWS()

const handleSessionUpdate = (data: any) => {
  // 只处理当前服务器的推送
  if (data._serverUrl !== props.serverUrl) return
  sessions.value = data.sessions || []
  // 不再调 setActiveSessionIds — 由 menu.vue 统一管理
}

wsOn('session:update', handleSessionUpdate)
```

- [ ] **Step 2: 添加 import 和 onUnmounted 清理**

在 `<script setup>` 顶部 import 中加入 `onUnmounted`：

```typescript
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
```

在 `onMounted()` 之后添加：

```typescript
onUnmounted(() => {
  wsOff('session:update', handleSessionUpdate)
})
```

- [ ] **Step 3: Commit**

```bash
cd weknora-ui
git add src/views/a2a-chat/components/ActiveSessionsPanel.vue
git commit -m "fix: ActiveSessionsPanel handler leak and data overwrite

Named handler with onUnmounted cleanup prevents leak on remount.
Filter by _serverUrl to only process current server's data.
Remove setActiveSessionIds call (now managed by menu.vue)."
```

---

## Chunk 2: 消费者适配

### Task 4: 修复 a2a-chat/index.vue — 移除 wsConnect + 定向 workspace 订阅

**Files:**
- Modify: `src/views/a2a-chat/index.vue` (lines 1093, 1382-1397)

- [ ] **Step 1: 更新解构（行 1093）**

旧：
```typescript
const { connect: wsConnect, on: wsOn, off: wsOff, subscribe: wsSub, unsubscribe: wsUnsub } = useAgentStudioWS()
```

新（移除 `connect: wsConnect`）：
```typescript
const { on: wsOn, off: wsOff, subscribe: wsSub, unsubscribe: wsUnsub } = useAgentStudioWS()
```

- [ ] **Step 2: 替换 watch（行 1382-1397）**

旧：
```typescript
let wsHandlersRegistered = false
watch(() => configStore.config, (config) => {
  if (config.serverUrl && config.apiKey) {
    wsConnect(config.serverUrl, config.apiKey)
    if (!wsHandlersRegistered) {
      wsOn('workspace:change', handleWorkspaceWS)
      wsOn('workspace:batch', handleWorkspaceWS)
      wsHandlersRegistered = true
    }
    if (config.agentId) {
      const userId = authStore.currentUserId || undefined
      wsSub('workspace', { agentId: config.agentId, userId })
    }
  }
}, { immediate: true })
```

新（移除 `wsConnect`，`wsSub` 加 `config.serverUrl`）：
```typescript
let wsHandlersRegistered = false
watch(() => configStore.config, (config) => {
  if (config.serverUrl && config.apiKey) {
    // 连接已由 menu.vue connectAll() 管理，此处不再调用 connect
    if (!wsHandlersRegistered) {
      wsOn('workspace:change', handleWorkspaceWS)
      wsOn('workspace:batch', handleWorkspaceWS)
      wsHandlersRegistered = true
    }
    if (config.agentId) {
      const userId = authStore.currentUserId || undefined
      // 指定 serverUrl → 只发到对应服务器的连接（第三参数）
      wsSub('workspace', { agentId: config.agentId, userId }, config.serverUrl)
    }
  }
}, { immediate: true })
```

- [ ] **Step 3: Commit**

```bash
cd weknora-ui
git add src/views/a2a-chat/index.vue
git commit -m "refactor: remove wsConnect, use targeted workspace subscription

Connection lifecycle now managed by menu.vue connectAll().
wsSub('workspace') uses serverUrl param for targeted subscription."
```

---

### Task 5: 修复 a2a-project/index.vue — 服务器增删同步 WS 连接

**Files:**
- Modify: `src/views/a2a-project/index.vue` (lines 251-322)

- [ ] **Step 1: 添加 import**

在 `<script setup>` 中添加：

```typescript
import { useAgentStudioWS } from '@/composables/useAgentStudioWS'
```

在 setup 中解构：

```typescript
const { addConnection, removeConnection } = useAgentStudioWS()
```

- [ ] **Step 2: handleSaveServer 中添加 addConnection（行 296-322）**

在 `if (configMode.value === 'add')` 分支中，`addServer()` 之后：

```typescript
if (configMode.value === 'add') {
    const newServer = addServer({
      name: serverData.name,
      serverUrl: serverData.serverUrl,
      apiKey: serverData.apiKey,
      lastConnectedAt: serverData.lastConnectedAt,
      status: serverData.status
    })
    servers.value = loadServers()

    // 同步建立 WebSocket 连接
    addConnection(newServer)

    // 如果是第一个服务器，自动选中
    // ... existing code ...
```

在 `else`（编辑模式）分支中，`updateServer()` 之后：

```typescript
} else {
    updateServer(serverData)
    servers.value = loadServers()

    // 更新连接（apiKey 或 name 可能变化）
    addConnection(serverData)

    MessagePlugin.success(t('a2aProject.messages.serverUpdated'))
}
```

- [ ] **Step 3: confirmDeleteServer 中添加 removeConnection（行 275-293）**

在 `deleteServer()` 之后：

```typescript
function confirmDeleteServer(): void {
  if (deletingServer.value) {
    // 先断开 WebSocket 连接
    removeConnection(deletingServer.value.serverUrl)

    deleteServer(deletingServer.value.id)
    servers.value = loadServers()
    // ... existing code ...
```

- [ ] **Step 4: Commit**

```bash
cd weknora-ui
git add src/views/a2a-project/index.vue
git commit -m "feat: sync WebSocket connections on server add/delete

addConnection() on server add/edit to establish WS immediately.
removeConnection() on server delete to clean up WS and data."
```

---

### Task 6: 集成验证

- [ ] **Step 1: TypeScript 编译检查**

Run: `cd weknora-ui && npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 2: 单元测试**

Run: `cd weknora-ui && npx vitest run`
Expected: 全部 PASS。

- [ ] **Step 3: 开发服务器启动**

Run: `cd weknora-ui && pnpm run dev`
Expected: 无错误启动。

- [ ] **Step 4: 手动验证清单**

| 场景 | 验证方法 | 预期结果 |
|------|---------|---------|
| 单服务器连接 | 配置 1 个服务器，打开浏览器控制台 Network/WS | 1 个 WebSocket 连接建立 |
| 多服务器连接 | 配置 2 个服务器，检查 WS 连接数 | 2 个 WebSocket 连接同时存在 |
| 活动会话聚合 | 两个服务器各有活跃会话 | 侧边栏显示所有服务器的活跃会话总数 |
| 服务器断线 | 停止 1 个 AgentStudio 实例 | 该服务器的会话从侧边栏消失，另一个不受影响 |
| 添加服务器 | 在项目管理页添加新服务器 | 立即建立 WS 连接（无需刷新页面） |
| 删除服务器 | 在项目管理页删除服务器 | WS 连接断开，该服务器的会话数据清除 |
| workspace 订阅 | 打开 A2A 聊天，切换 Agent | 文件浏览器只显示当前 Agent 的工作空间变化 |
| 服务器切换 | 从 serverA 的 agentX 切到 serverB 的 agentY | serverA 收到 workspace unsubscribe |
| 页面刷新 | 配置多服务器后刷新浏览器 | 所有 WS 连接自动重建 |
| ActiveSessionsPanel | 打开活跃会话面板 | 只显示当前服务器的会话，不影响其他服务器数据 |

- [ ] **Step 5: 最终 Commit（如有调整）**

```bash
cd weknora-ui
git add -A
git commit -m "fix: integration adjustments for multi-connection WebSocket"
```

---

## 依赖关系

```
Task 1 (useAgentStudioWS.ts 重写)
  ├── Task 2 (menu.vue 修复) — 依赖 Task 1 的 connectAll API
  ├── Task 3 (ActiveSessionsPanel 修复) — 依赖 Task 1 的 _serverUrl 注入
  ├── Task 4 (a2a-chat 修复) — 依赖 Task 1 移除 connect
  └── Task 5 (a2a-project 修复) — 依赖 Task 1 的 addConnection/removeConnection

Task 2-5 之间无依赖，可并行。

Task 6 (集成验证) — 依赖 Task 1-5 全部完成。
```

## 风险与回退

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 单元测试中 `vi.resetModules()` 无法清理模块级 Map | 测试隔离失败 | 导出 `_resetForTesting()` 函数 |
| `connectAll` 在 `menu.vue` 执行早于 `a2a-chat` 挂载 | workspace 订阅在连接建立后才发送 | `subscribe` 追加到 `activeSubscriptions`，`onopen` replay 保证 |
| 多连接增加内存占用 | 通常 2-3 个服务器，影响极小 | 监控连接数，上限 10 |
| 旧版 weknora-ui 单连接行为回退 | 用户只配置 1 个服务器时 | 单服务器场景功能完全等价，`connectAll([singleServer])` 行为与旧 `connect()` 一致 |

## Review 修复记录

| Issue | 严重度 | 修复方案 |
|-------|--------|---------|
| `isConnected` computed 依赖非响应式 Map | HIGH | 改用 `connectedCount` ref + `updateConnectedCount()` 手动触发 |
| `disconnectAll` 不触发 `_connection:closed` | MEDIUM | 逐个通知后再 clear |
| `addConnection` apiKey 变更不重建连接 | MEDIUM | 检测 apiKey 变化时 `cleanupConnection` + 重连 |
