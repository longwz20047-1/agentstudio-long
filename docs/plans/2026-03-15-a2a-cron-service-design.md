# A2A Cron Service Design: 用户级定时任务调度

> Date: 2026-03-15
> Status: Draft
> Scope: agentstudio backend + weknora-ui frontend
> Base: 深度分析讨论 + OpenClaw Cron 架构参考
> Prerequisites: A2A Session Reuse 已实现, taskExecutor 已实现, WebSocket 多连接已实现（见代码事实章节）

## 目标

在 weknora-ui 前端配置定时任务，由 AgentStudio 在用户的专属工作空间内调度执行。支持两种执行模式（isolated / reuse），通过 WebSocket 推送执行状态。

**与现有 schedulerService 的关系**：并行共存，不修改。schedulerService 是系统级（AgentStudio 管理员用），A2A Cron 是用户级（weknora-ui 用户用）。两者共享 taskExecutor 执行引擎。

**loopStorageService 后续独立清理**：SDK native cron（CronCreate/CronDelete）事件存储不再有消费者，`.a2a/loops/` 目录废弃。已有代码可保留（无害），清理工作不在本设计范围内。

## 为什么不改现有 schedulerService

```
现有 schedulerService（系统级）
  ├── 存储: ~/.agentstudio/scheduled-tasks/tasks.json（全局，AGENTSTUDIO_HOME）
  ├── API:  /api/scheduled-tasks/*（内部 JWT 认证）
  ├── 前端: AgentStudio 自己的 React 页面 ScheduledTasksPage.tsx
  ├── MCP:  13 个 Admin 工具
  └── 用户: AgentStudio 管理员

新需求（用户级）
  ├── 存储: {workingDirectory}/.a2a/cron/jobs.json（工作空间隔离）
  ├── API:  /a2a/{agentId}/cron/*（Authorization: Bearer apiKey 认证）
  ├── 前端: weknora-ui 的 Vue 页面
  └── 用户: weknora-ui 登录用户
```

两者的**认证方式、存储位置、用户模型**都不同。强行改一个服务来兼顾两种模式会增加不必要的复杂度。

## 职责划分

```
weknora-ui 负责:
  ├── 定时任务管理页面（CRUD UI）
  ├── 多 AgentStudio 连接选择（每个 serverUrl + agentId 独立管理）
  ├── 执行历史展示
  ├── 实时状态（WebSocket 订阅）
  └── 调用 /a2a/{agentId}/cron/* API

agentstudio 负责:
  ├── API 路由 + 认证（a2aCron routes + a2aAuth）
  ├── 任务存储（workspace 级 jobs.json）
  ├── 调度引擎（node-cron 注册/触发）
  ├── 执行引擎（taskExecutor 或 ClaudeSession）
  ├── 执行历史记录（runs/{jobId}.jsonl）
  └── WebSocket 推送执行状态

不碰:
  ├── schedulerService.ts（系统级定时任务调度）
  ├── scheduledTaskStorage.ts（系统级任务存储）
  ├── scheduledTasks.ts 路由（系统级 API）
  ├── ScheduledTasksPage.tsx（AgentStudio React 前端）
  └── scheduledTaskTools.ts（13 个 MCP Admin 工具）
```

## agentstudio 文件变更概览

```
新建:
  backend/src/
    ├── types/a2aCron.ts                    ← 类型定义
    ├── services/a2a/
    │   ├── a2aCronService.ts               ← 调度逻辑（node-cron + cron-parser + 执行分发 + 内存状态同步）
    │   └── a2aCronStorage.ts               ← 工作空间存储（jobs.json + runs/ + 全局索引互斥锁）
    └── routes/a2aCron.ts                   ← 11 个 REST API 端点（含 run history）

需修改:
  backend/src/
    ├── services/taskExecutor/BuiltinExecutor.ts  ← storeResult() 中 cron_ 前缀路由
    ├── services/websocketService.ts              ← 新增 cron 订阅频道（subscribedCron 字段 + broadcastCronEvent + resolveA2AId 异步解析 + 退订/清理）
    └── index.ts                                  ← 挂载路由到 /a2a/:id/cron + 初始化服务

新增依赖:
  └── cron-parser                           ← cron 类型 nextRunAt 计算（新增，项目当前未安装，pnpm add cron-parser）

共享基础设施（直接调用）:
  ├── taskExecutor + taskWorker.ts          ← isolated 执行（不修改）
  ├── ClaudeSession + handleSessionManagement ← reuse 执行（不修改）
  ├── a2aAuth.ts 中间件                     ← apiKey → a2aContext 解析（不修改）
  ├── agentMappingService.ts resolveA2AId() ← WebSocket 订阅中 a2aAgentId → workingDirectory 解析（不修改）
  └── agentStorage.ts                       ← Agent 配置读取（不修改）
```

## 现状分析（代码事实）

### 已有基础设施

| 组件 | 文件 | 可复用 |
|------|------|--------|
| **taskExecutor** | `taskExecutor/BuiltinExecutor.ts` + `taskWorker.ts` | 100% — isolated 执行引擎 |
| **ClaudeSession** | `claudeSession.ts` + `sessionManager.ts` | 100% — reuse 执行引擎 |
| **handleSessionManagement** | `utils/sessionUtils.ts` | 100% — session 查找/创建 |
| **a2aAuth 中间件** | `middleware/a2aAuth.ts` | 100% — apiKey → a2aContext 解析 |
| **WebSocket** | `websocketService.ts` (后端) + `useAgentStudioWS.ts` (前端) | 90% — 前端多连接已实现，后端需加 cron 频道 |
| **A2A 路由挂载** | `index.ts:493` `app.use('/a2a/:a2aAgentId', a2aRouter)` | 参考模式 |
| **A2A Async Task** | `a2a.ts:1665-1677` executor.submitTask() with a2aContext | 100% — 已验证的 A2A→taskExecutor 映射 |

### A2A 上下文解析（a2aAuth.ts:118-124）

```typescript
req.a2aContext = {
  a2aAgentId,                    // A2A Agent ID
  projectId: agentMapping.projectId,
  agentType: agentMapping.agentType,  // Agent 配置名
  workingDirectory: agentMapping.workingDirectory,  // 用户工作空间路径
  apiKeyId: validation.keyId!,
};
```

### weknora-ui → AgentStudio 双认证体系（代码事实）

weknora-ui 对 AgentStudio 使用**两套并行认证**，按路径模式区分：

```
认证方式 A — apiKey（Bearer Token）
  路径: /a2a/:agentId/*
  中间件: a2aAuth.ts（bcryptjs 哈希比较）
  来源: A2AServerConfig.apiKey（localStorage 存储）
  请求头: Authorization: Bearer {apiKey}

认证方式 B — JWT（内部管理令牌）
  路径: /api/*
  中间件: auth.ts（JWT 验证）
  来源: useAgentStudioAuth.ts 调用 POST /api/auth/login（admin password），缓存 7 天
  请求头: Authorization: Bearer {jwt}
  WebSocket: /ws?token={jwt}（query param）
```

**各认证方式覆盖的端点**：

| 认证 | 路径模式 | 用途 | 典型端点 |
|------|---------|------|----------|
| **apiKey** | `/a2a/:agentId/*` | 运行时操作 | `/messages`（SSE 对话）, `/tasks`（异步任务）, `/skills`, `/.well-known/agent-card.json`, `/workspace/*`（15 个文件操作端点） |
| **JWT** | `/api/a2a/*` | A2A 管理 | `/api/a2a/history/{projectPath}/{sessionId}`（对话历史）, `/api/a2a/mapping/*`, `/api/a2a/api-keys/*`, `/api/a2a/config/*` |
| **JWT** | `/api/projects/*` | 项目管理 | `/api/projects`（项目列表）, `/api/projects/{path}/a2a-config` |
| **JWT** | `/api/agents/*` | Session 管理 | `/api/agents/sessions`（活动 session 列表/关闭） |
| **JWT** | `/api/kb/*`, `/api/share/*`, `/api/users/*` | 知识库/分享/用户 | KB 标签 CRUD, 分享链接, 用户搜索 |
| **JWT** | `/ws` | WebSocket | `/ws?token={jwt}`（实时推送：session 状态、workspace 变更） |

**代码引用**（`index.ts:489-584`）：
```typescript
// apiKey 认证路由（a2aAuth 在各 router 内部）
app.use('/a2a/:a2aAgentId/workspace', httpsOnly, a2aWorkspaceRouter);  // :490
app.use('/a2a/:a2aAgentId', httpsOnly, a2aRouter);                     // :493

// JWT 认证路由（authMiddleware 在挂载时指定）
app.use('/api/a2a', authMiddleware, a2aManagementRouter);               // :566
app.use('/api/agents', authMiddleware, agentsRouter);                   // :557
app.use('/api/projects', authMiddleware, projectsRouter);               // :564
app.use('/api/kb', authMiddleware, kbRouter);                           // :584
app.use('/api/share', authMiddleware, shareRouter);                     // :583
```

**前端实现**（weknora-ui）：
```typescript
// apiKey — 直接从 A2AServerConfig 读取，每个请求指定目标服务器
// api/a2a/index.ts:105 fetchAgentCard()
headers: { 'Authorization': `Bearer ${config.apiKey}` }

// JWT — useAgentStudioAuth.ts 按 serverUrl 管理独立令牌
// composables/useAgentStudioAuth.ts:17
async function getToken(serverUrl: string, adminPassword: string): Promise<string>
// 内部调用 POST {serverUrl}/api/auth/login，tokenMap 按 serverUrl 缓存
// adminPassword 实际上是 apiKey（A2AServerConfig.apiKey 兼做 admin password）
```

**⚠️ JWT 多服务器限制**（`agentStudioRequest.ts` 代码事实）：

`/api/kb/*`、`/api/share/*`、`/api/users/*` 路由使用 `agentStudioRequest.ts` axios 实例，其 JWT 注入逻辑：

```typescript
// utils/agentStudioRequest.ts:25 — 请求拦截器
const server = getDefaultServer()  // ← 问题在这里
if (server) {
  const jwt = await getToken(server.serverUrl, server.apiKey)
  config.headers['Authorization'] = `Bearer ${jwt}`
}

// api/a2a/serverStorage.ts:187-189 — getDefaultServer 实现
export function getDefaultServer(): { serverUrl: string; apiKey: string } | null {
  const servers = loadServers()
  return servers.length > 0 ? servers[0] : null  // ← 固定取 servers[0]，不是当前活跃服务器
}
```

**影响**：
- KB 标签树、分享链接、用户搜索的 JWT **始终来自 servers 数组的第一个服务器**，不跟随用户当前切换的活跃服务器
- 单 AgentStudio 实例部署无影响（只有一个服务器）
- 多实例部署时，如果用户切换到第二个服务器操作 KB 标签或分享，JWT 仍指向第一个服务器，可能导致**认证失败或操作到错误的实例**
- 这不是 cron 设计引入的问题，是现有代码的既有 bug，但 cron 的对话历史回放如果复用此 axios 实例，会受同样影响

**对 cron 设计的影响**：
- **cron 全部操作在 apiKey 体系内闭环** — CRUD、执行状态、对话历史回放均通过 `/a2a/:agentId/cron/*` 端点（apiKey 认证），前端对目标服务器直接发请求（`serverUrl + apiKey` 成对），不依赖 JWT，不受 `getDefaultServer()` 多服务器 bug 影响
- **WebSocket cron 订阅**通过已有的 JWT WebSocket 连接发送 — 无需额外认证

### taskWorker.ts 执行模型（isolated 路径）

```typescript
// taskWorker.ts:131-158 — 每次新 SDK 子进程
for await (const message of query({ prompt: task.message, options: queryOptions })) {
  // 收集 session_id, assistant 响应, tool_use, result
}
// 子进程退出，Worker Thread 退出
```

### ClaudeSession 执行模型（reuse 路径）

```typescript
// claudeSession.ts — SDK 子进程常驻
// conversation() 启动子进程，MessageQueue 排队消息
claudeSession.sendMessage(message, callback);
// 子进程不退出，等待下一条消息
```

### sessionManager.getSessionsInfo()（查找 session）

```typescript
// sessionManager.ts:556-624 — 返回所有 session 信息
getSessionsInfo(): Array<{
  sessionId: string;
  agentId: string;       // ← 可用于按 agentId 查找
  projectPath: string | null;  // ← 可用于按 workingDirectory 匹配
  isActive: boolean;
  lastActivity: number;
  idleTimeMs: number;
  lastHeartbeat: number | null;
  heartbeatTimedOut: boolean;
  status: 'confirmed' | 'pending';
  claudeVersionId?: string;
  modelId?: string;
  sessionTitle?: string;
}>
```

### 路由挂载模式（index.ts）

```typescript
// index.ts:490-493 — A2A 路由挂载在 /a2a/:a2aAgentId 下
app.use('/a2a/:a2aAgentId/workspace', httpsOnly, a2aWorkspaceRouter);
app.use('/a2a/:a2aAgentId', httpsOnly, a2aRouter);
// index.ts:566 — 管理路由挂载在 /api/a2a 下（JWT 认证）
app.use('/api/a2a', authMiddleware, a2aManagementRouter);
```

### weknora-ui 多 AgentStudio 连接（代码事实）

weknora-ui 已实现完整的多服务器管理，定时任务需要在此基础上工作。

**多服务器存储**（`api/a2a/serverStorage.ts`）：

```typescript
// localStorage 存储结构
weknora_a2a_servers: A2AServerConfig[]     // 所有服务器列表
weknora_a2a_active_server: string          // 当前活跃服务器 ID

// A2AServerConfig（api/a2a/types.ts:371-386）
interface A2AServerConfig {
  id: string;           // UUID
  name: string;         // 用户自定义名称（如"开发环境"、"生产环境"）
  serverUrl: string;    // AgentStudio 地址
  apiKey: string;       // Bearer token
  createdAt: string;
  lastConnectedAt?: string;
  status?: 'connected' | 'disconnected' | 'error';
}

// 管理 API：loadServers(), saveServers(), addServer(), deleteServer(), updateServerStatus()
// 从单服务器迁移：migrateFromSingleServer() 兼容旧版 weknora_a2a_connection
```

**前端 UI**：`ServerTabs.vue` 以 Tab 切换方式展示多服务器，每个 Tab 显示连接状态（绿点/灰点）。

**每个服务器下有多个 Agent**（项目）：

```typescript
// A2AProjectWithServer（types.ts:391-401）
interface A2AProjectWithServer {
  serverId: string;     // 所属服务器 ID
  serverName: string;   // 所属服务器名称
  agentId: string;      // Agent ID
  // ...
}
```

**REST 层已做多服务器聚合**（`menu.vue:650-670`）：

```typescript
// 遍历所有服务器，聚合活动会话
const servers = loadServers()
const results = await Promise.allSettled(
    servers.map(s => fetchActiveSessions(s.serverUrl, s.apiKey))
)
// 合并所有服务器的 sessionId → setActiveSessionIds(allIds)
```

**WebSocket 层已实现多连接**（`useAgentStudioWS.ts`，代码事实）：

```typescript
// 多连接模型：Map<serverUrl, WSConnection>，同时连接所有服务器
const connections = new Map<string, WSConnection>()
// 每个消息注入 _serverUrl/_serverName 来源信息
// subscribe(channel, params?, serverUrl?) 支持广播/定向
// 详见"WebSocket 多连接（已完成）"章节
```

**对定时任务的影响**：

```
用户在 weknora-ui 看到的层次结构：

  ├── 服务器 A（开发环境, https://dev-studio:4936）
  │   ├── Agent "jarvis" → 定时任务列表 A
  │   └── Agent "ops-bot" → 定时任务列表 B
  │
  └── 服务器 B（生产环境, https://prod-studio:4936）
      └── Agent "monitor" → 定时任务列表 C

每组任务的 API 调用目标不同：
  任务列表 A → GET https://dev-studio:4936/a2a/jarvis/cron/jobs    (Authorization: Bearer key_a)
  任务列表 B → GET https://dev-studio:4936/a2a/ops-bot/cron/jobs   (Authorization: Bearer key_b)
  任务列表 C → GET https://prod-studio:4936/a2a/monitor/cron/jobs  (Authorization: Bearer key_c)
```

**agentstudio 后端不需要感知多连接** — 每个 AgentStudio 实例只管自己的 Agent 和 workspace，多连接的聚合逻辑完全在 weknora-ui 前端。后端 API 通过 `a2aAuth` 中间件解析 `Authorization: Bearer` → `a2aContext.workingDirectory`，天然隔离。

### 背景：WebSocket 多连接（已完成，非本设计范围）

> ✅ **Status: DONE** — 以下为 weknora-ui 当前代码事实，供 cron 订阅实现参考。本节不涉及新开发工作。

#### useAgentStudioWS.ts — 多连接模型（`composables/useAgentStudioWS.ts`）

已实现 `Map<string, WSConnection>` 多服务器连接管理，`serverUrl` 做 Map key：

```typescript
// 实际代码（composables/useAgentStudioWS.ts:8-18）
interface WSConnection {
  ws: WebSocket | null
  serverUrl: string
  serverName: string
  apiKey: string
  isConnected: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectDelay: number
  reconnectAttempts: number
  heartbeatTimer: ReturnType<typeof setInterval> | null
}

// :24-25 — module-level singleton
const connections = new Map<string, WSConnection>()
const handlers = new Map<string, Set<Handler>>()

// :49-53 — 带可选 serverUrl 的订阅数组
const activeSubscriptions: Array<{
  channel: string
  params: Record<string, any>
  serverUrl?: string   // 空 = 广播到所有连接；指定 = 只发到对应连接
}> = []
```

**已实现的 Public API**（:340-352）：

```typescript
export function useAgentStudioWS() {
  return {
    isConnected,          // computed: 任一连接活跃即 true（ref 计数驱动）
    connectAll,           // 连接所有服务器（清理不在列表中的旧连接）
    disconnectAll,        // 断开所有 + 清空订阅
    addConnection,        // 新增/更新服务器连接（apiKey 变化时重连）
    removeConnection,     // 删除服务器 + 清理该服务器的订阅
    getConnectionStatus,  // 单个服务器连接状态
    subscribe,            // subscribe(channel, params?, serverUrl?)
    unsubscribe,          // unsubscribe(channel, serverUrl?)
    on, off,              // 全局 handler（接收所有连接的消息，注入 _serverUrl/_serverName）
  }
}
```

**关键机制**（已验证）：

1. **onopen replay**（:102-107）：每个连接只 replay `!sub.serverUrl || sub.serverUrl === conn.serverUrl` 的订阅
2. **subscribe upsert 退订**（:277-303）：切换服务器时自动向旧连接发 unsubscribe
3. **消息来源注入**（:141-142）：`data._serverUrl = conn.serverUrl; data._serverName = conn.serverName`
4. **前端内部事件**（:127-129）：`_connection:closed`/`_connection:opened` 用 `_` 前缀与后端事件区分
5. **Page visibility 重连**（:27-47）：页面重新可见时检查所有连接并重连
6. **心跳**（:114-119）：每连接 30 秒 ping

#### sessions 订阅模式（menu store, `stores/menu.ts:130-207`）

**cron 订阅应参考此模式**。核心设计：`sessionsByServer` 作为按服务器隔离的唯一数据源，REST 和 WebSocket 都写入它，computed 自动聚合。

```typescript
// 实际代码（stores/menu.ts:133）— 按服务器隔离的唯一数据源
const sessionsByServer = ref<Map<string, A2ASessionInfo[]>>(new Map())

// :136-142 — computed 聚合所有服务器的 session ID
const activeSessionIds = computed(() => {
  const ids = new Set<string>()
  for (const sessions of sessionsByServer.value.values()) {
    for (const s of sessions) ids.add(s.sessionId)
  }
  return ids
})

// :148-151 — 按服务器更新（触发响应式，用 new Map 替换）
function updateServerSessions(serverUrl: string, sessions: A2ASessionInfo[]) {
  const map = new Map(sessionsByServer.value)
  map.set(serverUrl, sessions)
  sessionsByServer.value = map
}

// :172-183 — REST 批量加载（Promise.allSettled 遍历所有服务器）
async function loadAllServerSessions() {
  const servers = loadServers()
  const results = await Promise.allSettled(
    servers.map(s => fetchActiveSessions(s.serverUrl, s.apiKey))
  )
  for (let i = 0; i < servers.length; i++) {
    if (results[i].status === 'fulfilled') {
      updateServerSessions(servers[i].serverUrl, results[i].value.sessions || [])
    }
  }
}

// :189-192 — WebSocket 实时推送（按 _serverUrl 分流写入）
wsOn('session:update', (data: any) => {
  const serverUrl = data._serverUrl
  if (!serverUrl) return
  updateServerSessions(serverUrl, data.sessions || [])
})

// :195-198 — 断线清理
wsOn('_connection:closed', (data: any) => {
  if (data._serverUrl) clearServerSessions(data._serverUrl)
})

// :201-204 — 重连后刷新（REST 拉取最新数据）
wsOn('_connection:opened', (data: any) => {
  if (data._serverUrl) refreshServerSessions(data._serverUrl)
})

// :207 — 广播订阅（无 serverUrl → 发到所有连接）
wsSub('sessions')
```

#### ActiveSessionsPanel — 从 store computed 读取（`views/a2a-chat/components/ActiveSessionsPanel.vue`）

```typescript
// 实际代码（:18-20）— 绑定 store，由 WS 事件和重连自动更新
const sessions = computed(() => menuStore.getServerSessions(props.serverUrl))

// :42-47 — 按 projectPath 过滤
const filteredSessions = computed(() => {
  return sessions.value.filter(s => {
    if (!s.projectPath) return false
    return s.projectPath.startsWith(props.projectPath)
  })
})
```

#### workspace 订阅（`views/a2a-chat/index.vue:1572-1587`）

```typescript
// 实际代码 — 用 serverUrl 第三参数指定目标连接
watch(() => configStore.config, (config) => {
  if (config.serverUrl && config.apiKey) {
    if (config.agentId) {
      const userId = authStore.currentUserId || undefined
      wsSub('workspace', { agentId: config.agentId, userId }, config.serverUrl)
    }
  }
}, { immediate: true })
```

#### 对 cron 实现的启示

cron 频道应参照 session 的三层模式（REST 批量加载 + WebSocket 实时推送 + 断线/重连处理）：

| 维度 | sessions（已实现） | cron（待实现） |
|------|-------------------|--------------|
| Store 数据源 | `sessionsByServer: Map<serverUrl, sessions[]>` | `cronJobsByServer: Map<serverUrl, CronJob[]>`（如需前端聚合） |
| REST 加载 | `loadAllServerSessions()` — Promise.allSettled 遍历所有服务器 | `loadAllServerCronJobs()` — 同模式 |
| WS 实时更新 | `session:update` → `updateServerSessions(serverUrl, data)` | `cron:started`/`cron:completed`/`cron:error` → 更新对应 job 状态 |
| 断线清理 | `_connection:closed` → `clearServerSessions(serverUrl)` | `_connection:closed` → 标记该服务器 jobs 为 disconnected |
| 重连刷新 | `_connection:opened` → `refreshServerSessions(serverUrl)` | `_connection:opened` → REST 拉取最新 jobs + runs |
| 订阅方式 | `wsSub('sessions')` — 广播到所有连接 | `wsSub('cron', { agentId })` — 广播或指定 serverUrl |

**agentstudio 后端无需改动**：每个 WebSocket 连接对后端来说都是独立的 `WSClient`，天然支持多连接。后端只需新增 `subscribedCron` 字段和 `broadcastCronEvent` 函数（见 §6 设计）。

### WebSocket 已有订阅模型（代码事实）

**后端** `websocketService.ts`：

```typescript
// websocketService.ts — WSClient 结构（实际代码）
interface WSClient {
  ws: WebSocket;
  apiKey: string;        // apiKey 认证
  isAlive: boolean;      // 心跳检测（30 秒 ping/pong）
  workspace?: { agentId: string; userId?: string; watchKey: string };  // workspace 订阅
  subscribedSessions: boolean;                // sessions 订阅（布尔标志，无参数）
  // 需新增: subscribedCron 字段（按 workingDirectory 过滤，见 §6 设计说明）
}
```

已有两个频道：
- `sessions`（:171-176）— 布尔标志，`sessionManager.events` 的 `session:changed` 触发广播
- `workspace`（:159-170）— 需要 `agentId` 参数，通过 `workspaceWatcher` 文件变更事件触发广播

**前端** `useAgentStudioWS.ts`（代码事实见上方"WebSocket 多连接"章节）：
- 多连接模型已实现，`subscribe(channel, params?, serverUrl?)` 支持广播/定向
- sessions 订阅模式已在 `stores/menu.ts` 中实现完整的三层数据流（REST + WS + 断线/重连）

## 设计

### 架构总览

**单 AgentStudio 实例视角**（后端只管自己，不感知其他实例）：

```
weknora-ui                                    AgentStudio Backend
┌──────────────────┐                ┌──────────────────────────────────────┐
│ 定时任务管理页面   │                │                                      │
│ (Vue 3 组件)      │  REST API     │  a2aCronRoutes.ts                    │
│                  │ ─────────────► │  POST/GET/PUT/DELETE                 │
│ 执行历史展示      │  Bearer apiKey │  /a2a/{agentId}/cron/*               │
│                  │                │         │                            │
│ 实时状态         │   WebSocket    │         ▼                            │
│ (useAgentStudioWS)│ ◄──────────── │  a2aCronService.ts                   │
│                  │  cron:*事件     │  ├── node-cron 调度                  │
└──────────────────┘                │  ├── isolated → taskExecutor          │
                                    │  ├── reuse → ClaudeSession            │
                                    │  └── 执行结果 → WebSocket broadcast   │
                                    │         │                            │
                                    │         ▼                            │
                                    │  a2aCronStorage.ts                   │
                                    │  {wd}/.a2a/cron/                     │
                                    │  ├── jobs.json                       │
                                    │  └── runs/{jobId}.jsonl              │
                                    └──────────────────────────────────────┘
```

**多 AgentStudio 实例视角**（weknora-ui 聚合多个后端）：

```
                    weknora-ui（聚合层）
                    ┌──────────────────────────────┐
                    │  服务器列表（ServerTabs.vue）    │
                    │  ┌──────┐ ┌──────┐ ┌──────┐  │
                    │  │ 开发  │ │ 生产  │ │ 测试  │  │
                    │  └──┬───┘ └──┬───┘ └──┬───┘  │
                    └─────┼────────┼────────┼──────┘
                          │        │        │
         REST + WS        │        │        │       REST + WS
     ┌────────────────────┘        │        └────────────────────┐
     ▼                             ▼                             ▼
┌──────────────┐          ┌──────────────┐          ┌──────────────┐
│ AgentStudio A │          │ AgentStudio B │          │ AgentStudio C │
│ :4936         │          │ :4936         │          │ :4936         │
│               │          │               │          │               │
│ Agent: jarvis │          │ Agent: monitor│          │ Agent: qa-bot │
│ WD: /proj-a   │          │ WD: /proj-b   │          │ WD: /proj-c   │
│               │          │               │          │               │
│ .a2a/cron/    │          │ .a2a/cron/    │          │ .a2a/cron/    │
│  jobs.json    │          │  jobs.json    │          │  jobs.json    │
└──────────────┘          └──────────────┘          └──────────────┘
      独立调度                   独立调度                   独立调度
      独立存储                   独立存储                   独立存储
      各自 WebSocket             各自 WebSocket             各自 WebSocket
      (前端同时连接所有)          (前端同时连接所有)          (前端同时连接所有)
```

**多连接隔离保证**：

- **API 隔离**：每个 AgentStudio 实例是独立服务器，API 调用到不同 `serverUrl`
- **存储隔离**：每个实例的 `jobs.json` 在各自的 `workingDirectory` 中
- **调度隔离**：每个实例的 `a2aCronService` 独立运行 node-cron
- **WebSocket 多连接**：`useAgentStudioWS.ts` 已实现按 `loadServers()` 同时连接所有服务器（`Map<serverUrl, WSConnection>`），session/workspace 事件已从所有连接聚合。cron 事件参照 session 模式即可。详见"WebSocket 多连接（已完成）"章节
- **后端无需感知**：每个 AgentStudio 只管自己的 Agent 和 workspace，多实例聚合完全由 weknora-ui 前端负责

### 1. 存储模型

**路径**: `{workingDirectory}/.a2a/cron/`

```
{workingDirectory}/.a2a/
  ├── history/                  ← A2A 对话历史（已有，不动）
  ├── cron/                     ← 定时任务（新增）
  │   ├── jobs.json             ← 任务定义列表
  │   └── runs/
  │       ├── {jobId}.jsonl     ← 每任务执行历史（JSONL，自动裁剪）
  │       └── ...
  └── loops/                    ← 废弃，不再写入
```

**jobs.json 结构**:

```typescript
// 文件内容: CronJob[]
[
  {
    "id": "cron_a1b2c3d4",
    "name": "每日部署检查",
    "description": "检查所有服务的部署状态",
    "triggerMessage": "检查所有服务的部署状态，有异常就汇报",
    "schedule": { "type": "cron", "cronExpression": "0 9 * * *" },
    "sessionTarget": "isolated",
    "enabled": true,
    "agentType": "jarvis",
    "workingDirectory": "/projects/my-project",
    "timeoutMs": 300000,
    "maxTurns": 10,
    "lastRunAt": "2026-03-15T01:00:00.000Z",
    "lastRunStatus": "success",
    "nextRunAt": "2026-03-16T01:00:00.000Z",
    "createdAt": "2026-03-15T00:00:00.000Z",
    "updatedAt": "2026-03-15T00:00:00.000Z"
  }
]
```

**runs/{jobId}.jsonl 结构**（每行一个执行记录）:

```jsonl
{"id":"run_x1y2","jobId":"cron_a1b2c3d4","status":"success","startedAt":"...","completedAt":"...","executionTimeMs":12345,"responseSummary":"所有服务正常运行","sessionId":"sess_xxx"}
{"id":"run_x3y4","jobId":"cron_a1b2c3d4","status":"error","startedAt":"...","completedAt":"...","error":"Agent not found"}
```

### 2. 类型定义

**File**: `backend/src/types/a2aCron.ts`（新建）

```typescript
// --- 调度配置 ---

export interface CronSchedule {
  type: 'interval' | 'cron' | 'once';
  intervalMinutes?: number;       // type=interval 时必填
  cronExpression?: string;        // type=cron 时必填
  executeAt?: string;             // type=once 时必填，ISO 8601
}

// --- 执行模式 ---

export type CronSessionTarget = 'isolated' | 'reuse';
// 'isolated': taskExecutor Worker Thread，每次新 SDK 进程
// 'reuse': ClaudeSession.sendMessage()，常驻 SDK 进程，保留上下文

// --- Job 定义 ---

export interface CronJob {
  id: string;                     // cron_{8hex}
  name: string;
  description?: string;
  triggerMessage: string;         // 发给 Agent 的提示词
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  enabled: boolean;

  // Agent 上下文（从 a2aContext 自动填充，用户无需指定）
  agentType: string;              // Agent 配置名（同 agentStorage.getAgent() 的 agentId 参数，如 "jarvis"）
  workingDirectory: string;       // 用户工作空间路径（WebSocket 广播的匹配键）

  // 执行配置
  timeoutMs?: number;             // 默认 300000 (5min)
  maxTurns?: number;              // 默认 10

  // 运行状态
  lastRunAt?: string;
  lastRunStatus?: CronRunStatus;
  lastRunError?: string;
  nextRunAt?: string;

  // 元数据
  createdAt: string;
  updatedAt: string;
}

export type CronRunStatus = 'running' | 'success' | 'error' | 'stopped';

// --- 执行记录 ---

export interface CronRun {
  id: string;                     // run_{8hex}
  jobId: string;
  status: CronRunStatus;
  startedAt: string;
  completedAt?: string;
  executionTimeMs?: number;
  responseSummary?: string;       // Claude 回复摘要（前 500 字符）
  sessionId?: string;             // Claude session ID
  error?: string;
}

// --- API 请求体 ---

export interface CreateCronJobRequest {
  name: string;
  description?: string;
  triggerMessage: string;
  schedule: CronSchedule;
  sessionTarget?: CronSessionTarget;  // 默认 'isolated'
  enabled?: boolean;                  // 默认 true
  timeoutMs?: number;
  maxTurns?: number;
}

export interface UpdateCronJobRequest {
  name?: string;
  description?: string;
  triggerMessage?: string;
  schedule?: CronSchedule;
  sessionTarget?: CronSessionTarget;
  enabled?: boolean;
  timeoutMs?: number;
  maxTurns?: number;
}
```

**前端类型同步**: `frontend/src/types/a2aCron.ts`（weknora-ui 中创建对应类型）

### 3. 存储服务

**File**: `backend/src/services/a2a/a2aCronStorage.ts`（新建）

参照 `scheduledTaskStorage.ts` 模式，但路径改为工作空间级。

```typescript
class A2ACronStorage {
  // --- 路径 ---
  private getCronDir(wd: string): string;         // {wd}/.a2a/cron/
  private getJobsFilePath(wd: string): string;     // {wd}/.a2a/cron/jobs.json
  private getRunsDir(wd: string): string;          // {wd}/.a2a/cron/runs/
  private getRunsFilePath(wd: string, jobId: string): string;  // ...runs/{jobId}.jsonl

  // --- 全局索引互斥锁 ---
  // a2a-cron-index.json 的读-改-写需要序列化，防止并发请求丢失更新
  // Node.js 单进程内并发只来自 async interleaving，用 Promise chain 即可
  private indexMutex: Promise<void> = Promise.resolve();
  private withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.indexMutex;
    let resolve: () => void;
    this.indexMutex = new Promise(r => resolve = r);
    return release.then(fn).finally(() => resolve!());
  }

  // --- Jobs CRUD ---
  loadJobs(wd: string): CronJob[];
  getJob(wd: string, jobId: string): CronJob | null;
  createJob(wd: string, req: CreateCronJobRequest, agentType: string): CronJob;
  updateJob(wd: string, jobId: string, req: UpdateCronJobRequest): CronJob | null;
  deleteJob(wd: string, jobId: string): boolean;
  updateJobRunStatus(wd: string, jobId: string, status: CronRunStatus, error?: string): void;
  updateJobNextRunAt(wd: string, jobId: string, nextRunAt: string): void;

  // --- 全局索引（使用 withIndexLock 序列化写入） ---
  addWorkspaceToIndex(wd: string): Promise<void>;       // 创建 job 时调用
  removeWorkspaceFromIndex(wd: string): Promise<void>;   // 删除最后一个 job 时调用
  loadIndex(): { workspaces: string[] };                  // 启动时读取（无需锁）

  // --- Runs ---
  appendRun(wd: string, jobId: string, run: CronRun): void;       // JSONL append
  getRuns(wd: string, jobId: string, limit?: number): CronRun[];   // 最新 N 条
  pruneRuns(wd: string, jobId: string, keepLines?: number): void;  // 自动裁剪

  // --- 工作空间扫描（服务启动时） ---
  // 返回所有包含 .a2a/cron/jobs.json 的工作空间路径
  // 需要一个全局索引：见下方"服务启动与恢复"
}

export const a2aCronStorage = new A2ACronStorage();
```

**runs 自动裁剪**：

```typescript
// a2aCronStorage.appendRun 内部
appendRun(wd: string, jobId: string, run: CronRun): void {
  const filePath = this.getRunsFilePath(wd, jobId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(run) + '\n', 'utf-8');

  // 检查文件大小，超过 2MB 时裁剪
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) {
      this.pruneRuns(wd, jobId, 1000);  // 只保留最新 1000 行
    }
  } catch { /* ignore */ }
}

pruneRuns(wd: string, jobId: string, keepLines: number = 1000): void {
  const filePath = this.getRunsFilePath(wd, jobId);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length <= keepLines) return;
  const kept = lines.slice(-keepLines).join('\n') + '\n';
  fs.writeFileSync(filePath, kept, 'utf-8');
}
```

### 4. 调度服务

**File**: `backend/src/services/a2a/a2aCronService.ts`（新建）

```typescript
import cron from 'node-cron';

class A2ACronService {
  // 状态
  private activeJobs: Map<string, { job: CronJob; cronTask?: cron.ScheduledTask; timeout?: NodeJS.Timeout; intervalTimer?: ReturnType<typeof setInterval> }>;
  private runningExecutions: Map<string, { jobId: string; startedAt: string }>;  // runId → jobId 映射，stopExecution 依赖
  private executingJobIds: Set<string>;   // 进程内乐观锁，防止 manual + cron 并发触发竞态
  private agentStorage: AgentStorage;     // 单例，避免每次执行都 new（构造函数有 I/O 副作用）

  // --- 生命周期 ---
  initialize(): void;                    // 服务启动，从索引加载所有工作空间的 enabled jobs
  shutdown(): void;                      // 服务关闭，停止所有 cron 和 timeout

  // --- Job 调度 ---
  registerJob(job: CronJob): void;       // 根据 schedule.type 注册（cron/interval→node-cron 或 setInterval, once→setTimeout）
                                          // 注意: nextRunAt 计算使用 cron-parser 的 async import，
                                          // 但 registerJob 本身是同步的（node-cron/setTimeout/setInterval 注册无需 async），
                                          // nextRunAt 计算在注册完成后异步执行，不阻塞调度注册
  unregisterJob(jobId: string): void;    // 取消 cron/timeout/interval
  rescheduleJob(job: CronJob): void;     // 更新后重新调度

  // --- 执行 ---
  executeJob(jobId: string): Promise<void>;  // 核心：从 activeJobs Map 取 job（含 workingDirectory），根据 sessionTarget 分发
  async stopExecution(runId: string): Promise<{ success: boolean; message: string }>;  // 停止执行（async，内部 await cancelTask）

  // --- 结果回调（BuiltinExecutor.storeResult 调用，仅 isolated 模式） ---
  async onExecutionComplete(runId: string, jobId: string, result: TaskResult): Promise<void>;

  // --- 执行分发 ---
  private executeIsolated(job: CronJob, run: CronRun): Promise<void>;
  private executeReuse(job: CronJob, run: CronRun): Promise<void>;

  // --- 删除 Job ---
  deleteJob(workingDirectory: string, jobId: string): Promise<boolean>;
}

export const a2aCronService = new A2ACronService();
```

#### onExecutionComplete — isolated 模式结果回调

由 `BuiltinExecutor.storeResult()` 在 `scheduledTaskId.startsWith('cron_')` 时调用：

```typescript
async onExecutionComplete(runId: string, jobId: string, result: TaskResult): Promise<void> {
  const active = this.activeJobs.get(jobId);
  if (!active) {
    console.warn(`[A2A Cron] Job ${jobId} not found in activeJobs, skipping result`);
    return;
  }
  const job = active.job;

  // 构建执行记录
  const finalStatus: CronRunStatus = result.status === 'completed' ? 'success' : 'error';
  const completedRun: CronRun = {
    id: runId,
    jobId,
    status: finalStatus,
    startedAt: result.completedAt ? new Date(Date.now() - (result.executionTimeMs || 0)).toISOString() : new Date().toISOString(),
    completedAt: result.completedAt || new Date().toISOString(),
    executionTimeMs: result.executionTimeMs,
    responseSummary: result.output?.substring(0, 500),
    sessionId: result.sessionId,
    error: result.error,
  };

  // 写 JSONL + 更新 jobs.json + 内存同步
  a2aCronStorage.appendRun(job.workingDirectory, jobId, completedRun);
  a2aCronStorage.updateJobRunStatus(job.workingDirectory, jobId, finalStatus, result.error);
  active.job.lastRunStatus = finalStatus;
  active.job.lastRunAt = completedRun.completedAt;

  // 清理 runningExecutions（stopExecution 依赖此 Map 查找 runId → jobId）
  this.runningExecutions.delete(runId);

  // isolated 模式的 history 写入：从 TaskResult.logs 构建简化版 A2A history
  // TaskResult.logs 实际类型: Array<{ timestamp: string; level: 'info'|'warn'|'error'|'debug'; type: string; message: string; data?: Record<string, unknown> }>
  if (result.logs && result.logs.length > 0) {
    // ESM 动态导入（避免循环依赖，与 BuiltinExecutor.ts:512 同模式）
    const { a2aHistoryService } = await import('./a2aHistoryService.js');
    for (const log of result.logs) {
      a2aHistoryService.appendEvent(job.workingDirectory, runId, {
        type: log.type,       // string（自由格式，如 'system', 'tool_use' 等）
        level: log.level,     // 'info' | 'warn' | 'error' | 'debug'
        message: log.message,
        timestamp: log.timestamp,
        data: log.data,
      }).catch(() => {});     // fire and forget，不阻塞结果处理
    }
  }

  // WebSocket 广播
  broadcastCronEvent(job.workingDirectory, {
    type: finalStatus === 'success' ? 'cron:completed' : 'cron:error',
    jobId, runId, status: finalStatus,
    responseSummary: completedRun.responseSummary,
    timestamp: Date.now(),
  });

  // once 类型自动 disable（isolated 模式在 onExecutionComplete 中处理，
  //                       因为 executeJob 中的 once disable 在 submitTask 后立即执行，此时结果还没回来）
  // 注意: executeJob 的 try 块中已有 once disable 逻辑（在 submitTask resolve 后执行），
  // 但为保险起见，此处再检查一次（幂等操作，重复 disable 无副作用）
  if (job.schedule.type === 'once' && active.job.enabled) {
    a2aCronStorage.updateJob(job.workingDirectory, jobId, { enabled: false });
    active.job.enabled = false;
    this.unregisterJob(jobId);
  }
}
```

#### stopExecution — 停止正在执行的任务

> **关键代码事实**: `BuiltinExecutor.cancelTask()` 直接调用 `worker.terminate()` + `this.workers.delete(taskId)`，
> 不会触发 `handleTaskComplete` → `storeResult` → `onExecutionComplete` 回调链。
> 因此 `stopExecution` 必须自行更新 run/job 状态、写 JSONL、广播 WebSocket 事件。

```typescript
async stopExecution(runId: string): Promise<{ success: boolean; message: string }> {
  // 仅支持 isolated 模式（Worker Thread 可终止）
  // reuse 模式的 sendMessage 执行中无中断机制（已知限制 #2）
  const executor = getTaskExecutor();
  const stopped = await executor.cancelTask(runId);  // BuiltinExecutor.cancelTask → worker.terminate()
  // 注意: cancelTask 返回 Promise<boolean>（async 方法），必须 await

  if (stopped) {
    // cancelTask 直接终止 worker 并从 workers Map 删除，
    // 不触发 handleTaskComplete/storeResult/onExecutionComplete。
    // 必须在此处手动更新状态。
    const execution = this.runningExecutions.get(runId);
    if (execution) {
      const { jobId, startedAt } = execution;
      const active = this.activeJobs.get(jobId);
      if (active) {
        const stoppedRun: CronRun = {
          id: runId,
          jobId,
          status: 'stopped',
          startedAt,
          completedAt: new Date().toISOString(),
          executionTimeMs: Date.now() - new Date(startedAt).getTime(),
        };
        a2aCronStorage.appendRun(active.job.workingDirectory, jobId, stoppedRun);
        a2aCronStorage.updateJobRunStatus(active.job.workingDirectory, jobId, 'stopped');
        active.job.lastRunStatus = 'stopped';  // 内存同步，解除 running 阻塞
        broadcastCronEvent(active.job.workingDirectory, {
          type: 'cron:completed', jobId, runId, status: 'stopped', timestamp: Date.now(),
        });
      }
      this.runningExecutions.delete(runId);
    }
    return { success: true, message: `Execution ${runId} stopped` };
  }
  return { success: false, message: `Execution ${runId} not found or already completed` };
}
```

#### deleteJob — 删除任务完整逻辑

```typescript
async deleteJob(workingDirectory: string, jobId: string): Promise<boolean> {
  // 1. 停止调度
  this.unregisterJob(jobId);

  // 2. 清理 reuse session（如果存在）
  try {
    await sessionManager.removeSession(`cron_session_${jobId}`);
  } catch { /* session 可能不存在，忽略 */ }

  // 3. 从存储删除
  const deleted = a2aCronStorage.deleteJob(workingDirectory, jobId);
  if (!deleted) return false;

  // 4. 从内存移除
  this.activeJobs.delete(jobId);

  // 4.5. 清理 runningExecutions 中该 job 的残留条目（如果执行中被删除）
  for (const [runId, execution] of this.runningExecutions) {
    if (execution.jobId === jobId) {
      this.runningExecutions.delete(runId);
    }
  }

  // 5. 如果是该 workspace 最后一个 job，从全局索引移除
  const remainingJobs = a2aCronStorage.loadJobs(workingDirectory);
  if (remainingJobs.length === 0) {
    await a2aCronStorage.removeWorkspaceFromIndex(workingDirectory);
  }

  // 6. runs 历史文件保留（不删除 runs/{jobId}.jsonl，用户仍可查看历史）
  // 7. a2a history 文件保留（不删除 .a2a/history/run_*.jsonl）

  return true;
}
```

#### 4.0 registerJob — 三种调度类型

参照 `schedulerService.ts` 的 `registerCronJob` + `scheduleOnceTask` + `getCronExpression` 模式：

```typescript
registerJob(job: CronJob): void {
  // 先取消已有调度（reschedule 场景）
  this.unregisterJob(job.id);

  if (!job.enabled) return;

  const executeCallback = () => {
    this.executeJob(job.id).catch(err => {
      console.error(`[A2A Cron] Error executing job ${job.id}:`, err);
    });
  };

  if (job.schedule.type === 'once' && job.schedule.executeAt) {
    // --- once: 用 setTimeout（参照 schedulerService.ts:286-340 scheduleOnceTask） ---
    const delay = new Date(job.schedule.executeAt).getTime() - Date.now();
    if (delay <= 0) {
      // 已过期，标记为 disabled
      a2aCronStorage.updateJob(job.workingDirectory, job.id, { enabled: false });
      return;
    }
    // setTimeout 的 delay 上限为 2^31 - 1（约 24.8 天），超出需分段
    const MAX_DELAY = 2147483647;
    if (delay > MAX_DELAY) {
      const timeout = setTimeout(() => {
        // 到时间后重新检查并调度
        const currentJob = a2aCronStorage.getJob(job.workingDirectory, job.id);
        if (currentJob && currentJob.enabled) this.registerJob(currentJob);
      }, MAX_DELAY);
      this.activeJobs.set(job.id, { job, timeout });
    } else {
      const timeout = setTimeout(executeCallback, delay);
      this.activeJobs.set(job.id, { job, timeout });
    }
    a2aCronStorage.updateJobNextRunAt(job.workingDirectory, job.id, job.schedule.executeAt);

  } else if (job.schedule.type === 'interval' && job.schedule.intervalMinutes) {
    // --- interval: 转为 cron 表达式或 setInterval ---
    // 注意: cron minute 字段范围 0-59，*/N 中 N 不能超过 59
    // 参照 schedulerService.ts getCronExpression，但修复了 minutes >= 60 且不被 60 整除的情况
    const minutes = job.schedule.intervalMinutes;
    if (minutes < 60) {
      // 分钟级: */5 * * * *（N < 60，合法）
      const cronExpression = `*/${minutes} * * * *`;
      const cronTask = cron.schedule(cronExpression, executeCallback);
      this.activeJobs.set(job.id, { job, cronTask });
    } else if (minutes % 60 === 0) {
      // 整小时: 0 */2 * * *（小时级，合法）
      const cronExpression = `0 */${minutes / 60} * * *`;
      const cronTask = cron.schedule(cronExpression, executeCallback);
      this.activeJobs.set(job.id, { job, cronTask });
    } else {
      // 不能被 60 整除（如 90、75）: cron 无法精确表达，改用 setInterval
      // 例如 90 分钟 → 5400000ms，cron 表达式 */90 * * * * 无效（minute 字段上限 59）
      const intervalMs = minutes * 60 * 1000;
      const timer = setInterval(executeCallback, intervalMs);
      this.activeJobs.set(job.id, { job, intervalTimer: timer });
    }
    // interval 类型的 nextRunAt: 对使用 cron 表达式的情况用 cron-parser 计算精确时间
    // 对 setInterval 的情况用当前时间 + intervalMinutes 估算
    // 注意: registerJob 是 void（非 async），nextRunAt 计算用 .then() 异步执行，不阻塞调度注册
    if (minutes < 60 || minutes % 60 === 0) {
      // 使用了 cron 表达式，用 cron-parser 计算更精确的 nextRunAt
      const expr = minutes < 60 ? `*/${minutes} * * * *` : `0 */${minutes / 60} * * *`;
      import('cron-parser').then(({ parseExpression }) => {
        const interval = parseExpression(expr);
        a2aCronStorage.updateJobNextRunAt(job.workingDirectory, job.id, interval.next().toISOString());
      }).catch(() => {
        a2aCronStorage.updateJobNextRunAt(job.workingDirectory, job.id,
          new Date(Date.now() + minutes * 60 * 1000).toISOString());
      });
    } else {
      // setInterval 模式，用估算时间
      const nextRunAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
      a2aCronStorage.updateJobNextRunAt(job.workingDirectory, job.id, nextRunAt);
    }

  } else if (job.schedule.type === 'cron' && job.schedule.cronExpression) {
    // --- cron: 直接使用 node-cron ---
    if (!cron.validate(job.schedule.cronExpression)) {
      console.error(`[A2A Cron] Invalid cron expression for job ${job.id}: ${job.schedule.cronExpression}`);
      return;
    }
    const cronTask = cron.schedule(job.schedule.cronExpression, executeCallback);
    this.activeJobs.set(job.id, { job, cronTask });
    // cron 类型的 nextRunAt: 使用 cron-parser 计算下次执行时间
    // 依赖: pnpm add cron-parser（新增依赖，项目当前未安装）
    // 注意: registerJob 是 void（非 async），用 .then() 异步计算，不阻塞调度注册
    import('cron-parser').then(({ parseExpression }) => {
      const interval = parseExpression(job.schedule.cronExpression!);
      a2aCronStorage.updateJobNextRunAt(job.workingDirectory, job.id, interval.next().toISOString());
    }).catch(() => {
      // cron-parser 失败不阻塞调度，nextRunAt 留空
    });
  }
}
```

#### 4.1 executeIsolated — 临时工模式

复用 `a2a.ts:1665-1677` 已验证的模式：

```typescript
private async executeIsolated(job: CronJob, run: CronRun): Promise<void> {
  const executor = getTaskExecutor();

  // 加载 Agent 配置（使用类级单例 this.agentStorage）
  // 注意: agentStorage.getAgent() 参数名是 agentId，与 CronJob.agentType 是同一个值
  //       （都是 agent 配置文件名去掉 .json，如 "jarvis"）
  const agent = this.agentStorage.getAgent(job.agentType);
  if (!agent) throw new Error(`Agent not found: ${job.agentType}`);

  // 提交到 taskExecutor（Worker Thread + 新 SDK 子进程）
  await executor.submitTask({
    id: run.id,                          // run ID 作为 executor task ID
    type: 'scheduled',                   // 复用已有的 scheduled 类型
    agentId: job.agentType,
    projectPath: job.workingDirectory,   // 用户的工作空间
    message: job.triggerMessage,
    timeoutMs: job.timeoutMs || 300000,
    maxTurns: job.maxTurns || 10,
    permissionMode: 'acceptEdits',
    createdAt: run.startedAt,
    scheduledTaskId: job.id,             // 关联回 CronJob（用于 storeResult 回调）
  });
}
```

**结果回收**：BuiltinExecutor.storeResult() 已有 `task.type === 'scheduled'` 分支（`BuiltinExecutor.ts:506-539`）。需要适配：当 `scheduledTaskId` 以 `cron_` 开头时，写入 a2aCronStorage 而非 scheduledTaskStorage。

```typescript
// BuiltinExecutor.ts:506 — 需修改的结果回收逻辑
} else if (task.type === 'scheduled') {
  const scheduledTaskId = task.scheduledTaskId || task.id;

  if (scheduledTaskId.startsWith('cron_')) {
    // A2A Cron Job → 写入 a2aCronStorage
    const { a2aCronService } = await import('../a2a/a2aCronService.js');
    await a2aCronService.onExecutionComplete(task.id, scheduledTaskId, result);  // async，内部含 ESM import
  } else {
    // 系统级定时任务 → 保持原逻辑
    // ...existing code...
  }
}
```

#### 4.2 executeReuse — 常驻员工模式

复用 `handleSessionManagement` + `ClaudeSession.sendMessage`：

**⚠️ 并发限制**：`claudeSession.sendMessage()` 在 `isProcessing=true` 时**抛异常**（`claudeSession.ts:200-203`），不是排队等待。如果上一次 cron 执行还没完成，本次触发必须跳过或标记为 error。

```typescript
private async executeReuse(job: CronJob, run: CronRun): Promise<void> {
  // session ID 不能含冒号（Windows 文件名非法字符，sessionManager 用 sessionId 做文件名）
  const fixedSessionId = `cron_session_${job.id}`;  // 固定 session ID，跨次复用

  // 加载 Agent 配置（使用类级单例 this.agentStorage，避免每次 new 的 I/O 副作用）
  const agent = this.agentStorage.getAgent(job.agentType);
  if (!agent) throw new Error(`Agent not found: ${job.agentType}`);

  // buildQueryOptions 共 13 个参数（claudeUtils.ts:244），此处传前 11 个，省略尾部 2 个 optional 参数:
  //   - extendedOptions（含 weknoraContext/graphitiContext）: 首版 cron 不支持 WeKnora/Graphiti 集成（见已知限制 #13）
  //   - cwdOverride: 不需要，已通过 projectPath 传入 workingDirectory
  // 注意: 第 11 个参数 a2aStreamEnabled 显式传 false，因为 cron 执行无 SSE 消费者
  const mcpTools = agent.allowedTools
    .filter((tool: any) => tool.enabled && tool.name.startsWith('mcp__'))
    .map((tool: any) => tool.name);
  const { queryOptions } = await buildQueryOptions(
    agent,
    job.workingDirectory,
    mcpTools.length > 0 ? mcpTools : undefined,
    'acceptEdits',            // permissionMode
    undefined,                // model (use agent default)
    undefined,                // claudeVersion
    undefined,                // defaultEnv
    undefined,                // userEnv
    undefined,                // sessionIdForAskUser
    undefined,                // agentIdForAskUser
    false,                    // a2aStreamEnabled — cron 执行无 SSE 消费者
  );

  // 查找或创建 ClaudeSession（复用 A2A 用户聊天的同一套机制）
  // handleSessionManagement(agentId, sessionId, projectPath, queryOptions, claudeVersionId?, modelId?, sessionMode?, configSnapshot?)
  const { claudeSession } = await handleSessionManagement(
    job.agentType,
    fixedSessionId,           // 固定 session ID → 每次 cron 复用同一进程
    job.workingDirectory,     // projectPath（实参来自 workingDirectory）
    queryOptions,
    undefined,                // claudeVersionId
    undefined,                // modelId
    'reuse',                  // sessionMode = reuse
  );

  // 发送消息
  // 注意：sendMessage 在 isProcessing=true 时抛异常，不排队
  // 调用前应由 executeJob 的 lastRunStatus=running 检查拦截
  // 二级防护：handleSessionManagement 在 sessionMode='reuse' 时也会检查 sessionManager.isSessionBusy(sessionId)，
  //          若 session 正忙则抛 'SESSION_BUSY' 异常（sessionUtils.ts reuse 流程），外层 catch 会将 run 标记为 error
  // sendMessage 签名: sendMessage(message: any, responseCallback: (response: SDKMessage) => void | Promise<void>): Promise<string>
  //   - 第一参数类型为 any（传 string 可行，SDK 内部处理格式转换）
  //   - 返回 Promise<string>，resolve 值为 request ID（如 "req_0_170612..."），不是响应内容
  //   - 响应内容通过 responseCallback 异步回传
  //
  // SDKMessage 类型参考（来自 a2a.ts reuse session 消息处理模式）:
  //   type='assistant' → message.content: Array<{type:'text', text:string} | {type:'tool_use', ...}>
  //   type='result'    → subtype: 'success' | 'error' | 'error_max_turns'
  //   type='tool_use'  → tool_use 事件（cron 不需要处理）
  // 实现时应从 claude-agent-sdk 导入精确类型替代 as any
  let fullResponse = '';
  const result = await new Promise<{ status: string; response: string }>((resolve, reject) => {
    claudeSession.sendMessage(
      job.triggerMessage,
      (sdkMessage: SDKMessage) => {
        // --- A2A history 写入（每条 SDK 消息都写入，用 run.id 作为 sessionId） ---
        a2aHistoryService.appendEvent(job.workingDirectory, run.id, sdkMessage)
          .catch(() => {});  // fire and forget，不阻塞消息处理

        // 收集 assistant 文本（参照 a2a.ts reuse session 的 assistant 消息处理）
        if (sdkMessage.type === 'assistant') {
          const content = (sdkMessage as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') fullResponse += block.text;
            }
          }
        }
        // 执行完成
        if (sdkMessage.type === 'result') {
          resolve({
            status: (sdkMessage as any).subtype || 'success',
            response: fullResponse,
          });
        }
      }
    ).catch(reject);  // sendMessage 返回 Promise<string>（request ID），可能 reject
  });

  // 更新执行记录 + 状态 + 内存同步 + WebSocket 广播
  const finalStatus = result.status === 'success' ? 'success' : 'error';
  const completedRun: CronRun = {
    ...run,
    status: finalStatus as CronRunStatus,
    completedAt: new Date().toISOString(),
    executionTimeMs: Date.now() - new Date(run.startedAt).getTime(),
    responseSummary: result.response.substring(0, 500),
  };
  a2aCronStorage.appendRun(job.workingDirectory, job.id, completedRun);
  a2aCronStorage.updateJobRunStatus(job.workingDirectory, job.id, finalStatus as CronRunStatus);
  // 同步内存状态，确保后续 cron 触发的并发检查读到最新值
  const active = this.activeJobs.get(job.id);
  if (active) active.job.lastRunStatus = finalStatus as CronRunStatus;
  // 清理 runningExecutions（stopExecution 依赖此 Map）
  this.runningExecutions.delete(run.id);
  broadcastCronEvent(job.workingDirectory, {
    type: finalStatus === 'success' ? 'cron:completed' : 'cron:error',
    jobId: job.id, runId: run.id, status: finalStatus,
    responseSummary: completedRun.responseSummary,
    timestamp: Date.now(),
  });
}
```

**reuse session 生命周期管理**：

#### 固定 Session ID 设计（`cron_session_{jobId}`）

reuse 模式的核心设计是**每个 cron job 使用固定的 session ID**，而非每次执行生成随机 ID。这个固定 ID 是跨次执行、跨超时、跨重启的**唯一关联键**，承担三个职责：

```
cron_session_cron_a1b2c3d4
  │
  ├── 1. Resume 锚点（上下文保持）
  │   SDK 历史文件: ~/.claude/projects/{encoded-wd}/cron_session_cron_a1b2c3d4.jsonl
  │   ├── session 活跃 → getSession() 返回 → 直接 sendMessage（零开销复用）
  │   ├── session 超时 → 进程死，文件在 → checkSessionExists() = true → resume 加载历史
  │   ├── 服务重启 → 同超时，SDK 文件保留 → resume 加载历史
  │   └── 文件被删 → checkSessionExists() = false → 全新 session（唯一真正丢失上下文的场景）
  │
  ├── 2. 并发防护锚点
  │   sessionManager.isSessionBusy('cron_session_cron_a1b2c3d4')
  │   → 精确检查该 cron job 的 SDK 进程是否正在处理消息
  │   → handleSessionManagement 的二级防护（第一级是 lastRunStatus 内存检查）
  │
  └── 3. 清理锚点
      删除 job 时: sessionManager.removeSession('cron_session_cron_a1b2c3d4')
      → 精确终止对应 SDK 进程 + 清除内存索引
      → 磁盘历史文件保留（removeSession 不删文件）
```

**为什么不用随机 ID**：如果每次执行用 `run_xxxx` 作为 sessionId，第二次执行找不到上一次的 session，无法复用上下文，退化为 isolated 模式。

**命名规则**：`cron_session_` 前缀 + `jobId`（如 `cron_a1b2c3d4`）。不含冒号（`:`），因为 `sessionManager` 用 `${sessionId}.jsonl` 做文件名，冒号在 Windows 上是非法字符。

**Session 超时后 resume 完整链路**：

```
第 1 次触发（session 不存在）:
  handleSessionManagement('cron_session_xxx', reuse)
    → getSession() = null
    → checkSessionExists() = false（首次无历史）
    → createNewSession(agentId, opts, undefined) → 全新 SDK 进程
    → sendMessage → SDK 写历史到 ~/.claude/projects/.../cron_session_xxx.jsonl

  30 分钟无触发 → sessionManager.cleanupIdleSessions()
    → session.isIdle(30min) = true
    → removeSession → session.close()（杀进程） → 清内存 → 不删文件

第 2 次触发（session 已超时）:
  handleSessionManagement('cron_session_xxx', reuse)
    → getSession() = null（内存已清）
    → checkSessionExists() = true（文件还在）
    → createNewSession(agentId, opts, 'cron_session_xxx') → SDK resume 加载历史
    → sendMessage → Claude 记得之前的对话
```

- session ID 固定为 `cron_session_{jobId}`（不含冒号，因为 `sessionManager.checkSessionExists` 用 `${sessionId}.jsonl` 做文件名，冒号在 Windows 上非法）
- sessionManager 的超时清理机制自动管理（idle timeout 后子进程被 kill）
- 下次 cron 触发时，`handleSessionManagement` 自动检测：
  - session 还在 → 复用（sendMessage）
  - session 已超时 → 创建新的（conversation）
- 删除 job 时，主动调用 `sessionManager.removeSession('cron_session_' + jobId)` 清理
- **并发保护**：`executeJob` 在调用 `executeReuse` 前检查 `active.job.lastRunStatus === 'running'`（内存值，磁盘同步），跳过正在执行的 job（与 schedulerService 同样的模式，`schedulerService.ts:407-410`）

### 5. API 路由

**File**: `backend/src/routes/a2aCron.ts`（新建）

挂载到 A2A router 下，复用 a2aAuth 认证：

```typescript
// a2aCron.ts
const router = Router({ mergeParams: true });  // 继承 :a2aAgentId 参数

// 所有路由经过 a2aAuth 中间件（由父路由挂载时指定）
// req.a2aContext 提供 { workingDirectory, agentType, a2aAgentId }

// 注意: 路由路径不含 /cron 前缀，因为挂载点已包含 /cron
router.get('/jobs', ...);               // 列出该工作空间的所有任务
router.post('/jobs', ...);              // 创建任务
router.get('/jobs/:jobId', ...);        // 获取单个任务
router.put('/jobs/:jobId', ...);        // 更新任务
router.delete('/jobs/:jobId', ...);     // 删除任务
router.post('/jobs/:jobId/toggle', ...);// 启用/禁用
router.post('/jobs/:jobId/run', ...);   // 手动触发
router.post('/jobs/:jobId/stop', ...);  // 停止执行
router.get('/jobs/:jobId/runs', ...);   // 执行历史
router.get('/jobs/:jobId/runs/:runId/history', ...);  // 单次执行的完整对话历史（apiKey 认证，a2aHistoryService.getHistory）
router.get('/status', ...);             // 该工作空间的调度器状态

export default router;
```

**关键端点实现**：

```typescript
// DELETE /jobs/:jobId — 删除任务（含 session 清理）
router.delete('/jobs/:jobId', async (req: A2ARequest, res: Response) => {
  const { workingDirectory } = req.a2aContext!;
  const { jobId } = req.params;
  const deleted = await a2aCronService.deleteJob(workingDirectory, jobId);
  if (!deleted) return res.status(404).json({ error: 'Job not found' });
  res.json({ success: true });
});

// POST /jobs/:jobId/run — 手动触发
router.post('/jobs/:jobId/run', async (req: A2ARequest, res: Response) => {
  const { jobId } = req.params;
  // 异步触发，不等待执行完成
  a2aCronService.executeJob(jobId).catch(err => {
    console.error(`[A2A Cron] Manual trigger error for ${jobId}:`, err);
  });
  res.json({ success: true, message: 'Job triggered' });
});

// POST /jobs/:jobId/stop — 停止执行
router.post('/jobs/:jobId/stop', async (req: A2ARequest, res: Response) => {
  const { runId } = req.body;
  if (!runId) return res.status(400).json({ error: 'runId is required' });
  const result = await a2aCronService.stopExecution(runId);  // async，内部 await cancelTask
  res.json(result);
});

// GET /jobs/:jobId/runs/:runId/history — 单次执行的完整对话历史
router.get('/jobs/:jobId/runs/:runId/history', async (req: A2ARequest, res: Response) => {
  const { workingDirectory } = req.a2aContext!;
  const { runId } = req.params;
  // a2aHistoryService 无 sessionId 格式校验，run_xxxx 直接可用
  const history = await a2aHistoryService.getHistory(workingDirectory, runId);
  res.json({ history });
});

// GET /status — 该工作空间的调度器状态
router.get('/status', async (req: A2ARequest, res: Response) => {
  const { workingDirectory } = req.a2aContext!;
  const jobs = a2aCronStorage.loadJobs(workingDirectory);
  const activeCount = jobs.filter(j => j.enabled).length;
  const runningCount = jobs.filter(j => j.lastRunStatus === 'running').length;
  res.json({ totalJobs: jobs.length, activeCount, runningCount });
});
```

**路由内部认证**（与现有模式一致）：

```typescript
// a2aCron.ts 内部（与 a2a.ts:360, a2aWorkspace.ts:69 相同模式）
router.use(a2aAuth);        // 内部自带认证，外部挂载时不加
router.use(a2aRateLimiter);
```

**挂载位置**（`index.ts` 修改）：

```typescript
// index.ts — 挂载到独立的 /cron 子路径，避免与 a2aRouter 共享路径导致双重 a2aAuth
// 关键: a2aCronRouter 和 a2aRouter 都内部调用 router.use(a2aAuth)，
// 如果挂在同一路径，非 cron 请求会先经过 a2aCronRouter 的 a2aAuth（无路由匹配但中间件已执行），
// 再经过 a2aRouter 的 a2aAuth，造成双重 bcrypt 校验开销。
// 挂到 /cron 子路径后，只有 /a2a/:id/cron/* 请求进入 a2aCronRouter。
import a2aCronRouter from './routes/a2aCron';
app.use('/a2a/:a2aAgentId/cron', httpsOnly, a2aCronRouter);  // cron 路由（a2aAuth 在 router 内部）
app.use('/a2a/:a2aAgentId', httpsOnly, a2aRouter);            // 已有 A2A 路由（a2aAuth 在 router 内部）
```

**路由匹配说明**：a2aCronRouter 挂载在 `/a2a/:a2aAgentId/cron` 子路径下，只匹配 `/cron/*` 请求。其他 A2A 请求直接进入 a2aRouter，不经过 a2aCronRouter 的中间件栈。与 `a2aWorkspaceRouter` 挂载到 `/a2a/:a2aAgentId/workspace` 的模式一致。

**API 示例**：

```
# 创建任务
POST /a2a/jarvis-001/cron/jobs
Authorization: Bearer agt_xxx
{
  "name": "每日部署检查",
  "triggerMessage": "检查所有服务的部署状态，有异常就汇报",
  "schedule": { "type": "cron", "cronExpression": "0 9 * * *" },
  "sessionTarget": "isolated"
}

# 返回
201 Created
{
  "id": "cron_a1b2c3d4",
  "name": "每日部署检查",
  ...
  "nextRunAt": "2026-03-16T01:00:00.000Z"
}
```

### 6. WebSocket 推送

**后端修改**（`websocketService.ts`）：

> **设计说明**: 前端订阅时发送的是 `a2aAgentId`（UUID），但 CronJob 存储的是 `agentType`（配置名如 "jarvis"），两者不是同一个标识符。因此 cron 订阅按 `workingDirectory` 匹配——这是跨两端唯一稳定的关联键。后端在 subscribe 时通过 `resolveA2AId()` 将 `a2aAgentId` 解析为 `AgentMapping`（含 `workingDirectory`），广播时用 `workingDirectory` 过滤。

```typescript
// WSClient 新增字段
interface WSClient {
  // ...existing fields...
  subscribedCron?: {
    workingDirectory: string;     // 按工作空间过滤（不用 agentId，因为前端传 a2aAgentId 而 CronJob 存 agentType）
  };
}

// handleClientMessage 新增 cron 订阅处理
// 前端发送 a2aAgentId，后端解析为 workingDirectory
// 注意: resolveA2AId 是 async 函数（读文件），需在消息处理中用 IIFE 处理
if (msg.channel === 'cron' && typeof msg.agentId === 'string') {
  // resolveA2AId 是 agentMappingService.ts 导出的独立 async 函数，不是类方法
  resolveA2AId(msg.agentId).then(mapping => {
    if (mapping) {
      client.subscribedCron = { workingDirectory: mapping.workingDirectory };
      // 订阅成功后立即推送当前 cron jobs 状态（参照 sessions 频道的 buildSessionMessage 模式）
      // 这能缓解 resolveA2AId 异步期间丢失事件的问题（已知限制 #16）
      try {
        const jobs = a2aCronStorage.loadJobs(mapping.workingDirectory);
        sendSafe(client, JSON.stringify({ type: 'cron:sync', jobs }));
      } catch { /* ignore — workspace 可能还没有 cron jobs */ }
    }
  }).catch(err => {
    console.error('[WebSocket] Failed to resolve A2A ID for cron subscription:', err);
  });
}

// handleClientMessage 新增 cron 退订处理
// （在 unsubscribe 分支中）
if (msg.channel === 'cron') {
  client.subscribedCron = undefined;
}

// cleanupClient 新增 cron 清理
function cleanupClient(client: WSClient): void {
  // ...existing workspace + sessions cleanup...
  client.subscribedCron = undefined;
}

// 新增广播函数（a2aCronService 调用，按 workingDirectory 过滤）
// 注意: cron:sync 事件在 subscribe 时单播给订阅者（见上方），不经过此函数
export function broadcastCronEvent(workingDirectory: string, event: {
  type: 'cron:started' | 'cron:completed' | 'cron:error';
  jobId: string;
  runId: string;
  status?: string;
  responseSummary?: string;
  timestamp: number;
}): void {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.subscribedCron?.workingDirectory === workingDirectory) {
      sendSafe(client, message);
    }
  }
}
```

**前端使用**（weknora-ui）：

**WebSocket 事件格式**：

| 事件 | 方向 | 触发时机 | 数据结构 |
|------|------|---------|---------|
| `cron:sync` | 后端→前端 | subscribe 完成后立即单播 | `{ type: 'cron:sync', jobs: CronJob[] }` |
| `cron:started` | 后端→前端 | executeJob 开始 | `{ type: 'cron:started', jobId, runId, timestamp }` |
| `cron:completed` | 后端→前端 | 执行成功 | `{ type: 'cron:completed', jobId, runId, status: 'success', responseSummary?, timestamp }` |
| `cron:error` | 后端→前端 | 执行失败 | `{ type: 'cron:error', jobId, runId, status: 'error', timestamp }` |

```typescript
// 订阅（传 a2aAgentId，后端自动解析为 workingDirectory）
const { subscribe, on } = useAgentStudioWS()
subscribe('cron', { agentId: currentAgentId })

// 监听
on('cron:sync', (data) => {
  // 订阅后立即收到当前 jobs 状态（REST 补偿，防止 resolveA2AId 异步期间丢失事件）
})
on('cron:started', (data) => {
  // 更新任务状态为"运行中"
})
on('cron:completed', (data) => {
  // 更新任务状态，显示 responseSummary
})
on('cron:error', (data) => {
  // 显示错误状态
})
```

### 7. 服务启动与恢复

**问题**：工作空间级存储意味着 jobs.json 分散在各 workspace 中，服务启动时需要知道去哪些 workspace 加载。

**方案**：全局索引文件记录有 cron job 的 workspace 列表。

**File**: `${AGENTSTUDIO_HOME}/a2a-cron-index.json`（`AGENTSTUDIO_HOME` 来自 `config/paths.ts:39-42`，默认值 `~/.agentstudio`）

```json
{
  "workspaces": [
    "/projects/my-project",
    "/projects/ops"
  ]
}
```

**启动流程**（`a2aCronService.initialize()`）：

```
1. 读取 a2a-cron-index.json
2. 遍历 workspaces，读取每个 {wd}/.a2a/cron/jobs.json
3. 孤儿清理：标记上次 status=running 的为 error
4. 对所有 enabled=true 的 job，调用 registerJob() 注册 node-cron
5. 移除 index 中无效的 workspace（目录不存在或无 jobs.json）
```

**运行时维护**：

```
创建 job → a2aCronStorage.createJob() + 更新 index + registerJob()
删除最后一个 job → 从 index 中移除该 workspace
```

**挂载点**（`index.ts` 修改）：

```typescript
// index.ts — 在 initializeScheduler 之后
import { a2aCronService } from './services/a2a/a2aCronService';

// 初始化 A2A Cron 服务
try {
  a2aCronService.initialize();
} catch (error) {
  console.error('[A2A Cron] Error initializing:', error);
}

// shutdown 时（参照 index.ts 中 schedulerService.shutdown() 的位置）
a2aCronService.shutdown();
```

**shutdown 流程**（`a2aCronService.shutdown()`）：

```typescript
shutdown(): void {
  // 1. 停止所有调度（不再触发新的执行）
  for (const [id, active] of this.activeJobs) {
    active.cronTask?.stop();                       // 停止 node-cron
    if (active.timeout) clearTimeout(active.timeout); // 清除 setTimeout（once 类型）
    if (active.intervalTimer) clearInterval(active.intervalTimer); // 清除 setInterval（interval 不整除 60 的类型）
  }
  this.activeJobs.clear();

  // 2. 正在执行的 job 不主动终止（由 taskExecutor 的 shutdown 统一处理 isolated 模式）
  //    reuse 模式的 sendMessage 若正在进行中，SDK 进程退出时会自然结束
  // 3. 下次启动时的孤儿清理（initialize 步骤 3）会将 status=running 标记为 error

  console.log('[A2A Cron] Service shut down');
}
```

### 8. 备忘：Main 模式（不在本设计范围）

> 目标明确为 isolated + reuse 两种模式。Main 模式作为后续扩展备忘，不影响首版实现。

**概念**：Cron 触发时发到用户当前活跃的 A2A 聊天 session 中，结果出现在聊天记录里。通过 `sessionManager.getSessionsInfo()` 查找最近活跃的匹配 session，找不到则降级为 isolated。

**暂不实现原因**：串行排队（用户操作时 cron 需等待）、无 session 降级、isProcessing 并发冲突。isolated 和 reuse 已覆盖 90% 场景，main 模式可靠性最差，投入产出比低。

## File Change Summary

### 新建文件

| File | Changes |
|------|---------|
| `backend/src/types/a2aCron.ts` | CronJob, CronRun, CronSchedule, CronSessionTarget, API 请求类型 |
| `backend/src/services/a2a/a2aCronStorage.ts` | 工作空间级 JSONL 存储（jobs CRUD + runs append/prune） |
| `backend/src/services/a2a/a2aCronService.ts` | 调度核心（node-cron + cron-parser + executeIsolated + executeReuse + 内存状态同步 + runningExecutions 生命周期） |
| `backend/src/routes/a2aCron.ts` | 11 个 REST API 端点（含 run history） |
| `weknora-ui 前端` | 定时任务管理页面 + 类型定义 + API 调用 + cron WebSocket 订阅（参照 session 模式，WebSocket 多连接已就绪） |

### 新增依赖

| Package | 用途 |
|---------|------|
| `cron-parser` | `registerJob` 中 cron 类型的 `nextRunAt` 计算（新增依赖，项目当前未安装。计算失败不阻塞调度） |

### 需修改的文件

| File | Changes |
|------|---------|
| `backend/src/services/taskExecutor/BuiltinExecutor.ts` | storeResult() 中 `cron_` 前缀路由到 a2aCronService |
| `backend/src/services/websocketService.ts` | 新增 subscribedCron 字段（按 workingDirectory 过滤）+ broadcastCronEvent() + cron 退订/清理 + import resolveA2AId |
| `backend/src/index.ts` | 挂载 a2aCronRouter 到 `/a2a/:id/cron` + 初始化/关闭 a2aCronService |

### 不修改的文件（并行共存，互不影响）

| File | 原因 |
|------|------|
| `backend/src/services/schedulerService.ts` | 系统级定时任务调度，AgentStudio 管理员使用，与用户级 A2A Cron 无关 |
| `backend/src/services/scheduledTaskStorage.ts` | 系统级任务存储（`~/.agentstudio/scheduled-tasks/`），不改路径 |
| `backend/src/routes/scheduledTasks.ts` | 系统级 API（`/api/scheduled-tasks/*`，JWT 认证），保持原样 |
| `frontend/src/pages/ScheduledTasksPage.tsx` | AgentStudio React 前端定时任务页面，不影响 |
| `backend/src/services/mcpAdmin/tools/scheduledTaskTools.ts` | 13 个 MCP Admin 工具，系统级管理用 |
| `backend/src/types/scheduledTasks.ts` | 系统级类型定义，A2A Cron 使用独立的 `a2aCron.ts` |

## 验证清单

### isolated 模式
- [ ] 创建 job (schedule.type=cron, sessionTarget=isolated) → jobs.json 写入成功
- [ ] cron 触发 → taskExecutor 启动 Worker Thread → SDK 子进程在 workingDirectory 中执行
- [ ] 执行完成 → runs/{jobId}.jsonl 写入记录 + WebSocket 推送 cron:completed
- [ ] 执行完成 → activeJobs Map 内存中 lastRunStatus 同步更新为 success/error
- [ ] 手动触发 (POST /cron/jobs/{id}/run) → 立即执行，不影响正常调度
- [ ] isolated 快速连续触发（手动 + cron）→ 第二次被 lastRunStatus=running 拦截（内存同步验证）
- [ ] 停止执行 → Worker Thread 终止，状态标记为 stopped
- [ ] 停止执行 → JSONL 写入 stopped 记录 + jobs.json lastRunStatus 更新 + runningExecutions 清理 + WebSocket cron:completed(stopped) 广播
- [ ] 停止执行后重新触发 → lastRunStatus 已非 running，可正常执行
- [ ] 服务重启 → 从 index 加载 + 孤儿清理 + 重新注册 cron

### reuse 模式
- [ ] 创建 job (sessionTarget=reuse) → 首次触发创建 ClaudeSession (cron_session_{jobId})
- [ ] 后续触发 → 复用同一 ClaudeSession，Claude 记得上次对话
- [ ] session 超时后再触发 → 自动创建新 session，SDK resume 加载历史（Claude 记得之前对话）
- [ ] 删除 reuse job → session 被主动清理 (sessionManager.removeSession)
- [ ] 上次执行未完成时触发 → lastRunStatus=running 检查跳过，不报错
- [ ] 修改 maxTurns/timeoutMs → 已有 session 不受影响，需等 session 超时重建后生效（已知限制 #11）

### once 类型
- [ ] 创建 once job (executeAt 在未来) → setTimeout 注册成功 + nextRunAt 正确
- [ ] once job 触发并执行成功 → 自动设 enabled=false + unregisterJob
- [ ] 创建 once job (executeAt 在过去) → 立即标记为 disabled，不执行
- [ ] 服务重启后 once job (enabled=false) → 不重新注册

### nextRunAt
- [ ] interval 类型 → registerJob 后 nextRunAt = now + intervalMinutes
- [ ] cron 类型 → registerJob 后 nextRunAt 由 cron-parser 计算
- [ ] once 类型 → nextRunAt = executeAt

### 通用
- [ ] 不同工作空间的 job 互不可见（apiKey 隔离）
- [ ] 启用/禁用 job → cron 注册/取消
- [ ] 更新 schedule → cron 重新调度
- [ ] 执行历史 → 返回按时间倒序的最新 N 条
- [ ] 并发控制 → 同一 job 不重复执行（lastRunStatus=running 内存+磁盘同步 + executingJobIds 乐观锁）
- [ ] WebSocket 订阅 → subscribe('cron', {agentId}) 后收到该工作空间的执行事件（后端用 resolveA2AId 异步解析 workingDirectory）
- [ ] schedulerService（系统级定时任务）不受影响，继续独立运行
- [ ] 全局索引并发写入 → 多个 createJob/deleteJob 并发调用不丢失 index 条目

### 对话历史
- [ ] reuse 模式 → sendMessage 回调中用 `run.id` 作为 sessionId 写入 `a2aHistoryService.appendEvent()`
- [ ] isolated 模式 → Worker 通过 postMessage 传递事件到主线程，主线程写入 `a2aHistoryService`
- [ ] `GET /a2a/:agentId/cron/jobs/:jobId/runs/:runId/history`（apiKey 认证）→ 返回完整对话事件流
- [ ] 前端执行历史页面 → 从 `CronRun.id` 获取 `runId` → 调用同一 serverUrl 的 cron history API → 渲染完整对话

## 已知限制

1. **reuse 模式不支持并发**：`claudeSession.sendMessage()` 在 `isProcessing=true` 时抛异常（`claudeSession.ts:200-203`，不排队），通过 `lastRunStatus=running` 检查跳过防护
2. **reuse 模式无法中途停止**：`stopExecution` 仅支持 isolated 模式（终止 Worker Thread），reuse 模式的 sendMessage 执行中无中断机制。**关键代码事实**：`BuiltinExecutor.cancelTask()` 直接调用 `worker.terminate()` + `workers.delete(taskId)`，不触发 `handleTaskComplete` → `storeResult` → `onExecutionComplete` 回调链，因此 `stopExecution` 内部自行更新 run/job 状态（详见 `stopExecution` 实现）
3. **reuse session 无超时配置**：使用 sessionManager 的默认超时（30 分钟无活动），不可自定义。session 超时后 SDK 进程被 kill，但**历史文件保留在磁盘**（`~/.claude/projects/{encoded-wd}/cron_session_{jobId}.jsonl`）。下次触发时 `handleSessionManagement` 检测到历史文件存在，使用 SDK 的 resume 机制加载历史上下文，**Claude 能看到之前的对话**。仅在历史文件被手动删除或服务器迁移时才会真正丢失上下文
4. **全局索引并发写入**：`a2a-cron-index.json` 使用进程内 Promise chain 互斥锁序列化读-改-写操作，防止并发请求丢失更新。磁盘满或进程崩溃仍可能导致损坏，启动时校验 JSON 格式，损坏时从各 workspace 重建
5. **无重试机制**：首版不实现，执行失败即标记 error，等下次 cron 触发
6. **无模型覆盖**：使用 Agent 配置的默认模型，不支持 per-job 覆盖（后续可加）
7. **Session ID 不能含冒号**：Windows 文件名限制（`sessionManager` 用 `${sessionId}.jsonl` 做文件名），reuse session ID 格式为 `cron_session_{jobId}`
8. **cron 时区为服务器本地时区**：`node-cron` 默认使用服务器时区，前端需提示用户当前时区。首版不支持 per-job 时区配置
9. **Agent 删除不联动**：Agent 配置被删除后，引用该 agentType 的 cron job 每次触发都会报错（`Agent not found`），需用户手动删除 job
10. **并发触发竞态**：手动触发 (POST /run) 与定时触发之间存在竞态窗口。通过进程内 `executingJobIds` Set 做乐观锁防护（见 `executeJob` 流程），但非跨进程原子操作。对 isolated 模式影响小（两个 Worker 各自执行），对 reuse 模式第二个执行会被 `isProcessing` 抛异常后被外层 catch 标记为 error
11. **reuse 模式 maxTurns 仅在首次创建 session 时生效**：`handleSessionManagement` 只在创建新 session 时使用 `queryOptions`（含 `maxTurns`）。已存在的 reuse session 复用时（`sendMessage`）不接受 `maxTurns` 参数，SDK 进程使用创建时的配置。修改 job 的 `maxTurns` 后需等 session 超时重建（或手动删除 job 触发 `removeSession` 后重建）才生效。建议前端 UI 在 reuse 模式下对 maxTurns 字段标注此行为
12. **weknora-ui 前端需单独设计文档**：Vue 组件、路由、API hooks 等不在本文档范围。WebSocket 多连接基础设施已完成（见代码事实章节），cron 频道订阅参照 session 模式实现
13. **首版不支持 WeKnora/Graphiti 集成**：`buildQueryOptions` 的 `extendedOptions` 参数（含 `weknoraContext` / `graphitiContext`）未传入，cron 任务不具备知识库搜索和 AI 记忆能力。后续版本可通过在 CronJob 中存储相关 context 并传入 `extendedOptions` 来支持
14. **cron-parser 依赖**：`registerJob` 中 cron 类型的 `nextRunAt` 计算依赖 `cron-parser` 包。项目当前未安装，需 `pnpm add cron-parser`。使用 ESM 动态导入 `await import('cron-parser')`。计算失败不阻塞调度
15. **无全局并发限制**：现有 `schedulerService` 有 `maxConcurrent` 配置（默认 20），A2A Cron 只有 per-job 并发控制，没有全局上限。大量 cron job 同时触发可能耗尽资源。后续可在 `executeJob` 开头加 `runningExecutions.size >= MAX_CONCURRENT_CRON_RUNS` 检查
16. **WebSocket cron 订阅异步竞态**：`resolveA2AId` 是 async 函数，subscribe 消息处理中用 `.then()` 解析。在解析完成前广播的 cron 事件会丢失。影响：首次订阅后极短窗口内可能丢一个事件，前端可通过 REST 补偿（类似 sessions 频道 subscribe 后立即发送当前状态）
17. **reuse 模式 configSnapshot 未传入**：`handleSessionManagement` 调用时省略第 8 参数 `configSnapshot`，Agent 配置（allowedTools、systemPrompt 等）变更后 reuse session 不会检测差异，继续使用旧配置的 SDK 进程。需等 session 超时重建后生效。与限制 #11（maxTurns）是同类问题，影响范围更广
18. **Cron 执行 A2A 对话历史** ✅ **已在设计中解决**：两种执行模式均已接入 `a2aHistoryService.appendEvent()`，使用 `CronRun.id`（如 `run_x1y2`）作为 history sessionId，每次执行生成独立的 history 文件 `{wd}/.a2a/history/{runId}.jsonl`：
    - **isolated 模式**：在 `onExecutionComplete` 回调中从 `TaskResult.logs`（含 `type`、`level`、`message`、`timestamp`、`data` 字段）构建简化版 A2A history，通过 ESM `await import()` 动态导入 `a2aHistoryService`
    - **reuse 模式**：在 `executeReuse` 的 `sendMessage` 回调中对每个 `SDKMessage` 直接调用 `a2aHistoryService.appendEvent()`，实时写入完整事件流
    - **读取端**：新增 `GET /a2a/:agentId/cron/jobs/:jobId/runs/:runId/history`（apiKey 认证，与其他 cron API 一致），内部调用 `a2aHistoryService.getHistory(workingDirectory, runId)`
    - **为什么不复用现有 JWT 端点**：cron 全部操作在 apiKey 体系内闭环，避免 `getDefaultServer()` 多服务器 bug 影响
    - **前端数据流**：执行历史列表（`CronRun[]`）→ 点击"查看完整对话"→ 同一 serverUrl + apiKey 调用 cron history API → 渲染完整对话
19. **认证性能：bcrypt 哈希比较**：`validateApiKey` 每次 API 调用都做 bcrypt 哈希比较（遍历所有未撤销的 key，逐个 `bcrypt.compare`）。高频 cron 触发（如每分钟）叠加 CRUD API 调用可能产生认证开销。但 cron 执行本身不经过 API（由 `a2aCronService` 直接调用），只有 CRUD 操作经过认证，影响可控

## API 输入校验规则

路由层使用 Zod schema 校验（参照 `scheduledTasks.ts` 路由中的 `TaskScheduleSchema` 模式）：

```typescript
// a2aCron.ts 路由中的校验 schema
const CronScheduleSchema = z.object({
  type: z.enum(['interval', 'cron', 'once']),
  intervalMinutes: z.number().min(1).max(10080).optional(),       // 1 分钟 ~ 7 天（与 schedulerService TaskScheduleSchema 上限一致）
                                                                   // 注意: >= 60 且不被 60 整除的值会走 setInterval 而非 node-cron（见 registerJob）
  cronExpression: z.string().max(100).optional(),                  // node-cron validate() 校验
  executeAt: z.string().datetime().optional(),                     // ISO 8601
}).refine(data => {
  if (data.type === 'interval') return data.intervalMinutes !== undefined;
  if (data.type === 'cron') return data.cronExpression !== undefined;
  if (data.type === 'once') return data.executeAt !== undefined;
  return false;
});

const CreateCronJobSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  triggerMessage: z.string().min(1).max(10000),
  schedule: CronScheduleSchema,
  sessionTarget: z.enum(['isolated', 'reuse']).default('isolated'),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().min(10000).max(3600000).optional(),       // 10s ~ 1h
  maxTurns: z.number().min(1).max(100).optional(),                // 1 ~ 100
});
```

**cron 表达式额外校验**：调用 `node-cron` 的 `cron.validate(expr)` 验证语法合法性。

**once 类型过去时间**：`executeAt` 在过去时，创建成功但立即标记为 disabled（与 schedulerService 行为一致）。

## executeJob 核心流程

```typescript
async executeJob(jobId: string): Promise<void> {
  const active = this.activeJobs.get(jobId);
  if (!active) return;
  const job = active.job;

  // 并发保护（与 schedulerService.ts:406-410 相同模式）
  if (job.lastRunStatus === 'running') {
    console.warn(`[A2A Cron] Job ${jobId} is already running, skipping`);
    return;
  }

  // 进程内乐观锁（防止 manual trigger + cron trigger 并发竞态）
  // 两级并发保护设计:
  //   第一级: lastRunStatus === 'running' — 内存+磁盘同步状态，覆盖整个执行周期
  //   第二级: executingJobIds Set — 进程内锁，仅覆盖 "check → set running" 之间的短暂竞态窗口
  // executingJobIds 在 finally 中释放，此时 active.job.lastRunStatus 已在内存中被设为 'running'，
  // 后续触发由第一级检查拦截。对于 isolated 模式，submitTask() 在任务入队时即 resolve，
  // executingJobIds 会在任务实际执行完成前释放，但 lastRunStatus 内存值为 'running'，
  // 直到 onExecutionComplete 回调将其更新为 success/error，因此并发保护不会失效。
  if (this.executingJobIds.has(jobId)) {
    console.warn(`[A2A Cron] Job ${jobId} is being dispatched, skipping`);
    return;
  }
  this.executingJobIds.add(jobId);

  // 创建 run 记录
  const run: CronRun = { id: `run_${uuid().slice(0,8)}`, jobId, status: 'running', startedAt: new Date().toISOString() };

  // 注册到 runningExecutions Map（stopExecution 依赖此 Map 查找 runId → jobId）
  this.runningExecutions.set(run.id, { jobId, startedAt: run.startedAt });

  // running 状态同时更新 jobs.json 和内存（确保并发检查读到最新状态）
  // JSONL 只在最终完成/失败时写一条记录，避免 getRuns 返回重复条目
  a2aCronStorage.updateJobRunStatus(job.workingDirectory, jobId, 'running');
  active.job.lastRunStatus = 'running';  // 同步内存，确保后续 cron 触发能检测到 running

  // WebSocket 通知执行开始
  broadcastCronEvent(job.workingDirectory, {
    type: 'cron:started', jobId, runId: run.id, timestamp: Date.now(),
  });

  try {
    if (job.sessionTarget === 'isolated') {
      await this.executeIsolated(job, run);
      // isolated 结果由 BuiltinExecutor.storeResult() 回调 → onExecutionComplete() 处理
      // onExecutionComplete 负责: 写 JSONL + 更新 lastRunStatus（磁盘+内存） + WebSocket 广播
    } else {
      await this.executeReuse(job, run);
      // reuse 结果在 executeReuse 内部处理（直接写 JSONL + 更新状态 + 同步内存）
    }

    // once 类型执行后自动 disable（setTimeout 已消费，不再需要调度）
    if (job.schedule.type === 'once') {
      a2aCronStorage.updateJob(job.workingDirectory, jobId, { enabled: false });
      active.job.enabled = false;
      this.unregisterJob(jobId);
    }
  } catch (err) {
    // 统一错误处理：确保 job 状态从 running 更新为 error
    const errorMsg = err instanceof Error ? err.message : String(err);
    const completedRun: CronRun = {
      ...run, status: 'error', completedAt: new Date().toISOString(),
      executionTimeMs: Date.now() - new Date(run.startedAt).getTime(), error: errorMsg,
    };
    a2aCronStorage.appendRun(job.workingDirectory, jobId, completedRun);  // JSONL 唯一写入点
    a2aCronStorage.updateJobRunStatus(job.workingDirectory, jobId, 'error', errorMsg);
    active.job.lastRunStatus = 'error';  // 同步内存
    this.runningExecutions.delete(run.id);  // 清理 runningExecutions
    broadcastCronEvent(job.workingDirectory, {
      type: 'cron:error', jobId, runId: run.id, status: 'error', timestamp: Date.now(),
    });
  } finally {
    this.executingJobIds.delete(jobId);
  }
}
```

**JSONL 写入规则**：每个 run 只写入一条最终状态记录（`success` / `error` / `stopped`），不写入中间状态 `running`。`running` 状态仅存在于 `jobs.json` 的 `lastRunStatus` 字段（磁盘+内存同步）和 WebSocket 的 `cron:started` 事件中。这确保 `getRuns()` 返回的每条记录都是最终结果，无需去重。

**内存状态同步规则**：所有 `updateJobRunStatus` 调用后，必须同步更新 `activeJobs` Map 中的 `active.job.lastRunStatus`。这确保 `executeJob` 开头的 `lastRunStatus === 'running'` 检查读到最新状态，避免 isolated 模式下 `submitTask()` 异步入队后、`executingJobIds` 释放后的并发窗口中出现重复执行。

**`runningExecutions` Map 生命周期**：`executeJob` 创建 run 后 `set(runId, { jobId, startedAt })`，在 `onExecutionComplete`（isolated 完成）、`executeReuse`（reuse 完成）、`stopExecution`（手动停止）、`executeJob catch`（异常）四处 `delete(runId)`。`stopExecution` 依赖此 Map 将 `runId` 映射回 `jobId` 以更新正确的 job 状态。

**once 类型自动 disable**：`once` 类型 job 在 try 块末尾（执行成功后）自动设 `enabled: false` 并调用 `unregisterJob`。这确保前端显示正确状态，服务重启后不会因 `delay <= 0` 误判。

**关键**：executeReuse 内部的 sendMessage 可能因 `isProcessing=true` 或 `session not active` 抛异常，外层 catch 确保 run 记录不会卡在 `running` 状态。`finally` 块确保乐观锁总是释放。
