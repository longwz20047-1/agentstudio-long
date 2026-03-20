# weknora-ui Cron 前端设计：用户级定时任务管理

> Date: 2026-03-19
> Status: Reviewed (2026-03-20, 20 fixes applied: C1 I1-I4 M1-M4 L1-L6 E1-E3 B1 D1; backend-verified 2026-03-21, 2 fixes: formatSchedule i18n, CronRunDetail format detection; final-review 2026-03-21, 3 fixes: F1 showCreateForm→handleCreate, F2 补全6个handler, F3 cron:sync timestamp; code-fact-review 2026-03-20, 1 fix: I2 菜单插入位置改为chat之后避免menuArr[2]硬编码冲突)
> Scope: weknora-ui 前端
> Base: `2026-03-15-a2a-cron-service-design.md` + agentstudio 后端已实现
> Prerequisites: 后端 11 个 API 端点已实现, WebSocket cron 频道已实现, 多服务器连接已实现

## 目标

在 weknora-ui 中新增定时任务管理页面，让用户可以：

1. 对每个 AgentStudio 服务器 + Agent 组合创建/编辑/删除定时任务
2. 实时查看任务执行状态（WebSocket 推送）
3. 查看执行历史和完整对话回放

## 后端 API 概览（代码事实）

后端路由已实现（`agentstudio/backend/src/routes/a2aCron.ts`），挂载在 `/a2a/:a2aAgentId/cron`，使用 apiKey Bearer 认证：

| 方法 | 路径 | 功能 | 响应格式 |
|------|------|------|---------|
| GET | `/jobs` | 任务列表 | `{ jobs: CronJob[] }` |
| GET | `/jobs/:jobId` | 单个任务 | `{ job: CronJob }` |
| POST | `/jobs` | 创建任务 | `{ job: CronJob }` (201) |
| PUT | `/jobs/:jobId` | 更新任务 | `{ job: CronJob }` |
| DELETE | `/jobs/:jobId` | 删除任务 | `{ success: true }` |
| POST | `/jobs/:jobId/toggle` | 启用/禁用 | `{ job: CronJob }` |
| POST | `/jobs/:jobId/run` | 手动触发 | `{ message, jobId }` |
| POST | `/jobs/:jobId/stop` | 停止执行 | `{ success: true }` (前端丢弃响应) |
| GET | `/jobs/:jobId/runs` | 执行历史 | `{ runs: CronRun[] }` |
| GET | `/jobs/:jobId/runs/:runId/history` | 对话历史 | `{ events: [] }` |
| GET | `/status` | 调度状态 | `{ totalJobs, activeJobs, runningJobs, registeredJobs }` |

### 后端类型定义（`agentstudio/backend/src/types/a2aCron.ts`）

```typescript
interface CronSchedule {
  type: 'interval' | 'cron' | 'once';
  intervalMinutes?: number;
  cronExpression?: string;
  executeAt?: string;
}

type CronSessionTarget = 'isolated' | 'reuse';

interface CronJob {
  id: string;
  name: string;
  description?: string;
  triggerMessage: string;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  enabled: boolean;
  agentType: string;
  workingDirectory: string;
  timeoutMs?: number;
  maxTurns?: number;
  lastRunAt?: string;
  lastRunStatus?: CronRunStatus;
  lastRunError?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

type CronRunStatus = 'running' | 'success' | 'error' | 'stopped';

interface CronRun {
  id: string;
  jobId: string;
  status: CronRunStatus;
  startedAt: string;
  completedAt?: string;
  executionTimeMs?: number;
  responseSummary?: string;
  sessionId?: string;
  error?: string;
}
```

### WebSocket 事件（`websocketService.ts` 已实现）

| 事件 | 触发时机 | 数据 |
|------|---------|------|
| `cron:sync` | subscribe 后立即单播 | `{ type, jobs: CronJob[], timestamp }` |
| `cron:started` | 执行开始 | `{ type, jobId, runId, timestamp }` |
| `cron:completed` | 执行完成 | `{ type, jobId, runId, status, responseSummary?, timestamp }` |
| `cron:error` | 执行失败 | `{ type, jobId, runId, status, timestamp }` |

## 前端现有基础设施（代码事实）

### 多服务器管理

- `serverStorage.ts`: `loadServers()`, `getActiveServerId()` — localStorage 存储 `weknora_a2a_servers`
- `A2AServerConfig`: `{ id, name, serverUrl, apiKey, status }`
- `ServerTabs.vue`: Tab 切换服务器，状态点（绿/灰）
- a2a-project 页面已实现完整的多服务器 → 项目列表聚合模式

### 双认证体系

- **apiKey**（Bearer Token）: `/a2a/:agentId/*` 路由，直接用 `A2AServerConfig.apiKey`
- **JWT**: `/api/*` 路由，`useAgentStudioAuth.getToken(serverUrl, apiKey)` 获取
- Cron API 全部走 **apiKey** 认证（`/a2a/:agentId/cron/*`），不依赖 JWT

### WebSocket 多连接（`composables/useAgentStudioWS.ts`）

- `Map<serverUrl, WSConnection>` 同时连接所有服务器
- `subscribe(channel, params?, serverUrl?)` — 广播或定向
- `on(type, handler)` — 消息注入 `_serverUrl` / `_serverName`
- 已有 `sessions` 频道的三层数据流模式（REST 加载 + WS 推送 + 断线/重连）

### Sessions 订阅模式（`stores/menu.ts`，三层参考模式）

```typescript
// 1. 按服务器隔离的数据源
const sessionsByServer = ref<Map<string, A2ASessionInfo[]>>(new Map())
// 2. REST 批量加载
async function loadAllServerSessions() { ... Promise.allSettled }
// 3. WS 实时推送
wsOn('session:update', (data) => updateServerSessions(data._serverUrl, data.sessions))
// 4. 断线清理
wsOn('_connection:closed', (data) => clearServerSessions(data._serverUrl))
// 5. 重连刷新
wsOn('_connection:opened', (data) => refreshServerSessions(data._serverUrl))
// 6. 广播订阅
wsSub('sessions')
```

### API 调用模式（`api/a2a/index.ts`）

- apiKey 路由: 直接 `fetch(serverUrl + path, { headers: { Authorization: Bearer apiKey } })`
- JWT 路由: `authFetch(serverUrl, apiKey, path)` — 自动获取 JWT + 401 重试

### 路由结构（`router/index.ts`）

所有业务页面挂载在 `/platform` 下，`requiresAuth: true`。

### 国际化

4 语言（`zh-CN`, `en-US`, `ru-RU`, `ko-KR`），`useI18n()` + `$t()` 模式。

## 文件变更概览

```
新建:
  src/
    ├── api/a2a/cron.ts                          ← Cron API 函数（11 个端点）
    ├── types/cron.ts                             ← 前端类型定义（同步后端类型）
    ├── stores/a2aCron.ts                         ← Pinia Store（按服务器隔离 + WS 三层）
    ├── views/a2a-cron/
    │   ├── index.vue                             ← 定时任务管理页面
    │   └── components/
    │       ├── CronJobList.vue                   ← 任务列表（表格 + 状态 + 操作）
    │       ├── CronJobForm.vue                   ← 创建/编辑任务表单（抽屉）
    │       ├── CronRunHistory.vue                ← 执行历史列表
    │       └── CronRunDetail.vue                 ← 单次执行对话回放
    └── i18n/locales/
        ├── zh-CN.ts                              ← +cron 命名空间
        ├── en-US.ts                              ← +cron 命名空间
        ├── ru-RU.ts                              ← +cron 命名空间
        └── ko-KR.ts                              ← +cron 命名空间

需修改:
  src/
    ├── router/index.ts                           ← 新增 /platform/a2a-cron 路由
    └── stores/menu.ts                            ← 新增菜单项 "定时任务"
```

## 设计

### 1. 前端类型定义

**File**: `src/types/cron.ts`（新建）

与后端 `a2aCron.ts` 保持同步：

```typescript
// --- 调度配置 ---

export interface CronSchedule {
  type: 'interval' | 'cron' | 'once'
  intervalMinutes?: number
  cronExpression?: string
  executeAt?: string
}

// --- 执行模式 ---

export type CronSessionTarget = 'isolated' | 'reuse'

// --- Job 定义 ---

export interface CronJob {
  id: string
  name: string
  description?: string
  triggerMessage: string
  schedule: CronSchedule
  sessionTarget: CronSessionTarget
  enabled: boolean
  agentType: string
  workingDirectory: string
  timeoutMs?: number
  maxTurns?: number
  lastRunAt?: string
  lastRunStatus?: CronRunStatus
  lastRunError?: string
  nextRunAt?: string
  createdAt: string
  updatedAt: string
}

export type CronRunStatus = 'running' | 'success' | 'error' | 'stopped'

// --- 执行记录 ---

export interface CronRun {
  id: string
  jobId: string
  status: CronRunStatus
  startedAt: string
  completedAt?: string
  executionTimeMs?: number
  responseSummary?: string
  sessionId?: string
  error?: string
}

// --- API 请求体 ---

export interface CreateCronJobRequest {
  name: string
  description?: string
  triggerMessage: string
  schedule: CronSchedule
  sessionTarget?: CronSessionTarget
  enabled?: boolean
  timeoutMs?: number
  maxTurns?: number
}

export interface UpdateCronJobRequest {
  name?: string
  description?: string
  triggerMessage?: string
  schedule?: CronSchedule
  sessionTarget?: CronSessionTarget
  enabled?: boolean
  timeoutMs?: number
  maxTurns?: number
}

// --- API 响应体 ---

export interface CronJobsResponse {
  jobs: CronJob[]
}

export interface CronJobResponse {
  job: CronJob
}

export interface CronRunsResponse {
  runs: CronRun[]
}

export interface CronStatusResponse {
  totalJobs: number
  activeJobs: number
  runningJobs: number
  registeredJobs: number
}

// --- WebSocket 事件 ---

// 所有 WS 事件都包含 _serverUrl 和 _serverName（由 useAgentStudioWS.ts:141-142 注入）

export interface CronSyncEvent {
  type: 'cron:sync'
  jobs: CronJob[]
  timestamp: number
  _serverUrl: string
  _serverName: string
}

export interface CronStartedEvent {
  type: 'cron:started'
  jobId: string
  runId: string
  timestamp: number
  _serverUrl: string
  _serverName: string
}

export interface CronCompletedEvent {
  type: 'cron:completed'
  jobId: string
  runId: string
  status: CronRunStatus
  responseSummary?: string
  timestamp: number
  _serverUrl: string
  _serverName: string
}

export interface CronErrorEvent {
  type: 'cron:error'
  jobId: string
  runId: string
  status: CronRunStatus
  timestamp: number
  _serverUrl: string
  _serverName: string
}
```

### 2. API 层

**File**: `src/api/a2a/cron.ts`（新建）

Cron API 全部走 apiKey 认证，直接 `fetch` 到目标 `serverUrl`（与 `fetchAgentCard` 同模式），不走 `agentStudioRequest` axios 实例（避开 `getDefaultServer()` 多服务器 bug）。

```typescript
import type {
  CronJob, CronRun, CronJobsResponse, CronJobResponse,
  CronRunsResponse, CronStatusResponse,
  CreateCronJobRequest, UpdateCronJobRequest
} from '@/types/cron'
import type { A2AHistoryEvent } from '@/api/a2a/index'

/**
 * 构建 Cron API 基础 URL
 * 路径: {serverUrl}/a2a/{agentId}/cron
 */
function buildCronUrl(serverUrl: string, agentId: string, path: string = ''): string {
  const base = serverUrl.replace(/\/+$/, '')
  return `${base}/a2a/${agentId}/cron${path}`
}

/**
 * 通用 Cron API 请求（apiKey Bearer 认证）
 */
async function cronFetch<T>(
  serverUrl: string,
  agentId: string,
  apiKey: string,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = buildCronUrl(serverUrl, agentId, path)
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...options.headers,
    },
  })

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error(body.error || `请求失败: ${resp.status}`)
  }

  return resp.json()
}

// --- Jobs CRUD ---

export async function fetchCronJobs(
  serverUrl: string, agentId: string, apiKey: string
): Promise<CronJob[]> {
  const data = await cronFetch<CronJobsResponse>(serverUrl, agentId, apiKey, '/jobs')
  return data.jobs
}

export async function fetchCronJob(
  serverUrl: string, agentId: string, apiKey: string, jobId: string
): Promise<CronJob> {
  const data = await cronFetch<CronJobResponse>(serverUrl, agentId, apiKey, `/jobs/${jobId}`)
  return data.job
}

export async function createCronJob(
  serverUrl: string, agentId: string, apiKey: string, req: CreateCronJobRequest
): Promise<CronJob> {
  const data = await cronFetch<CronJobResponse>(serverUrl, agentId, apiKey, '/jobs', {
    method: 'POST',
    body: JSON.stringify(req),
  })
  return data.job
}

export async function updateCronJob(
  serverUrl: string, agentId: string, apiKey: string, jobId: string, req: UpdateCronJobRequest
): Promise<CronJob> {
  const data = await cronFetch<CronJobResponse>(serverUrl, agentId, apiKey, `/jobs/${jobId}`, {
    method: 'PUT',
    body: JSON.stringify(req),
  })
  return data.job
}

export async function deleteCronJob(
  serverUrl: string, agentId: string, apiKey: string, jobId: string
): Promise<void> {
  await cronFetch(serverUrl, agentId, apiKey, `/jobs/${jobId}`, { method: 'DELETE' })
}

export async function toggleCronJob(
  serverUrl: string, agentId: string, apiKey: string, jobId: string
): Promise<CronJob> {
  const data = await cronFetch<CronJobResponse>(serverUrl, agentId, apiKey, `/jobs/${jobId}/toggle`, {
    method: 'POST',
  })
  return data.job
}

// --- 执行控制 ---

export async function triggerCronJob(
  serverUrl: string, agentId: string, apiKey: string, jobId: string
): Promise<void> {
  await cronFetch(serverUrl, agentId, apiKey, `/jobs/${jobId}/run`, { method: 'POST' })
}

export async function stopCronJob(
  serverUrl: string, agentId: string, apiKey: string, jobId: string, runId: string
): Promise<void> {
  await cronFetch(serverUrl, agentId, apiKey, `/jobs/${jobId}/stop`, {
    method: 'POST',
    body: JSON.stringify({ runId }),
  })
}

// --- 执行历史 ---

export async function fetchCronRuns(
  serverUrl: string, agentId: string, apiKey: string, jobId: string, limit?: number
): Promise<CronRun[]> {
  const query = limit ? `?limit=${limit}` : ''
  const data = await cronFetch<CronRunsResponse>(serverUrl, agentId, apiKey, `/jobs/${jobId}/runs${query}`)
  return data.runs
}

export async function fetchCronRunHistory(
  serverUrl: string, agentId: string, apiKey: string, jobId: string, runId: string
): Promise<A2AHistoryEvent[]> {
  const data = await cronFetch<{ events: A2AHistoryEvent[] }>(
    serverUrl, agentId, apiKey, `/jobs/${jobId}/runs/${runId}/history`
  )
  return data.events
}

// --- 状态 ---

export async function fetchCronStatus(
  serverUrl: string, agentId: string, apiKey: string
): Promise<CronStatusResponse> {
  return cronFetch<CronStatusResponse>(serverUrl, agentId, apiKey, '/status')
}
```

### 3. Pinia Store

**File**: `src/stores/a2aCron.ts`（新建）

参照 `stores/menu.ts` 中 sessions 的三层数据流模式。

**核心设计决策**：

- `cronJobsByAgent`: `Map<compositeKey, CronJob[]>` — 按 `serverUrl:agentId` 隔离
- compositeKey = `${serverUrl}::${agentId}`（双冒号分隔，因为 serverUrl 含单冒号）
- REST 初始加载 → WebSocket 实时更新 → 断线清理 + 重连刷新
- WS cron 事件只更新单个 job 的运行时状态（不替换整个列表）

```typescript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAgentStudioWS } from '@/composables/useAgentStudioWS'
import { fetchCronJobs } from '@/api/a2a/cron'
import { loadServers } from '@/api/a2a/serverStorage'
import type { CronJob, CronRunStatus } from '@/types/cron'

function makeKey(serverUrl: string, agentId: string): string {
  return `${serverUrl}::${agentId}`
}

export const useCronStore = defineStore('cronStore', () => {
  // --- 数据源：按 serverUrl::agentId 隔离 ---
  const cronJobsByAgent = ref<Map<string, CronJob[]>>(new Map())

  // --- 运行中任务的 runId 追踪（stop 操作依赖） ---
  // jobId → runId，由 cron:started 写入，cron:completed/cron:error 清除
  const runningRunIds = ref<Map<string, string>>(new Map())

  // --- 当前查看上下文（由页面设置） ---
  const currentServerUrl = ref('')
  const currentAgentId = ref('')
  const currentApiKey = ref('')

  const currentKey = computed(() =>
    makeKey(currentServerUrl.value, currentAgentId.value)
  )

  // --- Computed ---

  /** 当前 Agent 的任务列表 */
  const currentJobs = computed(() =>
    cronJobsByAgent.value.get(currentKey.value) || []
  )

  /** 当前 Agent 的活跃任务数 */
  const activeJobCount = computed(() =>
    currentJobs.value.filter(j => j.enabled).length
  )

  /** 当前 Agent 的运行中任务数 */
  const runningJobCount = computed(() =>
    currentJobs.value.filter(j => j.lastRunStatus === 'running').length
  )

  // --- 操作 ---

  function setCurrentAgent(serverUrl: string, agentId: string, apiKey: string) {
    currentServerUrl.value = serverUrl
    currentAgentId.value = agentId
    currentApiKey.value = apiKey
  }

  function updateAgentJobs(serverUrl: string, agentId: string, jobs: CronJob[]) {
    const key = makeKey(serverUrl, agentId)
    const map = new Map(cronJobsByAgent.value)
    map.set(key, jobs)
    cronJobsByAgent.value = map
  }

  function clearAgentJobs(serverUrl: string, agentId: string) {
    const key = makeKey(serverUrl, agentId)
    const map = new Map(cronJobsByAgent.value)
    map.delete(key)
    cronJobsByAgent.value = map
  }

  /** 更新单个 job 的运行时状态（WebSocket 事件触发） */
  function updateJobRunStatus(
    serverUrl: string, jobId: string,
    status: CronRunStatus, responseSummary?: string
  ) {
    // 遍历所有该 serverUrl 下的 agent 分组
    const map = new Map(cronJobsByAgent.value)
    for (const [key, jobs] of map) {
      if (!key.startsWith(serverUrl + '::')) continue
      const idx = jobs.findIndex(j => j.id === jobId)
      if (idx !== -1) {
        const updated = [...jobs]
        updated[idx] = {
          ...updated[idx],
          lastRunStatus: status,
          lastRunAt: status !== 'running' ? new Date().toISOString() : updated[idx].lastRunAt,
        }
        map.set(key, updated)
        cronJobsByAgent.value = map
        return
      }
    }
  }

  /** 插入或更新单个 job（CRUD 操作后用 API 返回值直接更新 Store，避免全量刷新） */
  function upsertJob(serverUrl: string, agentId: string, job: CronJob) {
    const key = makeKey(serverUrl, agentId)
    const map = new Map(cronJobsByAgent.value)
    const jobs = [...(map.get(key) || [])]
    const idx = jobs.findIndex(j => j.id === job.id)
    if (idx !== -1) {
      jobs[idx] = job
    } else {
      jobs.push(job)
    }
    map.set(key, jobs)
    cronJobsByAgent.value = map
  }

  /** 从 Store 中移除单个 job（delete 后调用，后端无 WS 事件通知删除） */
  function removeJob(serverUrl: string, agentId: string, jobId: string) {
    const key = makeKey(serverUrl, agentId)
    const map = new Map(cronJobsByAgent.value)
    const jobs = (map.get(key) || []).filter(j => j.id !== jobId)
    map.set(key, jobs)
    cronJobsByAgent.value = map
  }

  // --- REST 加载 ---

  async function loadJobs(serverUrl: string, agentId: string, apiKey: string) {
    try {
      const jobs = await fetchCronJobs(serverUrl, agentId, apiKey)
      updateAgentJobs(serverUrl, agentId, jobs)
    } catch (err) {
      console.warn('[CronStore] Failed to load jobs:', err)
    }
  }

  async function refreshCurrentJobs() {
    if (currentServerUrl.value && currentAgentId.value && currentApiKey.value) {
      await loadJobs(currentServerUrl.value, currentAgentId.value, currentApiKey.value)
    }
  }

  // --- WebSocket 三层集成 ---

  const { on: wsOn, subscribe: wsSub, unsubscribe: wsUnsub } = useAgentStudioWS()

  // cron:sync — subscribe 后立即收到当前 jobs 快照
  wsOn('cron:sync', (data: any) => {
    const serverUrl = data._serverUrl
    if (!serverUrl || !data.jobs) return
    // cron:sync 只包含 jobs，不含 agentId
    // 如果当前正在查看该 serverUrl 的 agent，更新其数据
    if (serverUrl === currentServerUrl.value && currentAgentId.value) {
      updateAgentJobs(serverUrl, currentAgentId.value, data.jobs)
    }
  })

  // cron:started — 标记 job 为 running + 保存 runId（stop 操作依赖）
  wsOn('cron:started', (data: any) => {
    if (data._serverUrl && data.jobId) {
      updateJobRunStatus(data._serverUrl, data.jobId, 'running')
      if (data.runId) {
        runningRunIds.value = new Map(runningRunIds.value).set(data.jobId, data.runId)
      }
    }
  })

  // cron:completed — 更新 job 状态 + 清除 runId
  wsOn('cron:completed', (data: any) => {
    if (data._serverUrl && data.jobId) {
      updateJobRunStatus(data._serverUrl, data.jobId, data.status || 'success', data.responseSummary)
      const map = new Map(runningRunIds.value)
      map.delete(data.jobId)
      runningRunIds.value = map
    }
  })

  // cron:error — 更新 job 状态 + 清除 runId
  wsOn('cron:error', (data: any) => {
    if (data._serverUrl && data.jobId) {
      updateJobRunStatus(data._serverUrl, data.jobId, 'error')
      const map = new Map(runningRunIds.value)
      map.delete(data.jobId)
      runningRunIds.value = map
    }
  })

  // 断线清理：清除该服务器下所有 agent 的 cron 数据
  wsOn('_connection:closed', (data: any) => {
    if (!data._serverUrl) return
    const map = new Map(cronJobsByAgent.value)
    for (const key of map.keys()) {
      if (key.startsWith(data._serverUrl + '::')) {
        map.delete(key)
      }
    }
    cronJobsByAgent.value = map
  })

  // 重连刷新：REST 重新拉取
  wsOn('_connection:opened', (data: any) => {
    if (data._serverUrl === currentServerUrl.value && currentAgentId.value && currentApiKey.value) {
      loadJobs(currentServerUrl.value, currentAgentId.value, currentApiKey.value)
    }
  })

  /** 订阅指定 Agent 的 cron 频道 */
  function subscribeCron(agentId: string, serverUrl?: string) {
    wsSub('cron', { agentId }, serverUrl)
  }

  /** 退订 cron 频道 */
  function unsubscribeCron(serverUrl?: string) {
    wsUnsub('cron', serverUrl)
  }

  return {
    // 数据
    cronJobsByAgent,
    runningRunIds,
    currentServerUrl,
    currentAgentId,
    currentApiKey,
    currentJobs,
    activeJobCount,
    runningJobCount,
    // 操作
    setCurrentAgent,
    updateAgentJobs,
    clearAgentJobs,
    updateJobRunStatus,
    upsertJob,
    removeJob,
    loadJobs,
    refreshCurrentJobs,
    subscribeCron,
    unsubscribeCron,
  }
})
```

### 4. 路由配置

**File**: `src/router/index.ts`（修改）

在 `/platform` children 中新增：

```typescript
{
  path: "a2a-cron",
  name: "a2aCron",
  component: () => import("../views/a2a-cron/index.vue"),
  meta: { requiresInit: true, requiresAuth: true }
},
```

### 5. 菜单配置

**File**: `src/stores/menu.ts`（修改）

在 `menuArr` 的 `chat` 之后、`settings` 之前新增（index 3）：

```typescript
{ title: '', titleKey: 'menu.cronJobs', icon: 'time', path: 'a2a-cron' },
```

**注意**：不能插在 `a2a-projects`(index 1) 和 `chat`(index 2) 之间，因为 `menu.ts` 中 5 处硬编码 `menuArr[2]` 引用 chat 菜单（`clearMenuArr`, `updatemenuArr`, `updataMenuChildren`, `updatasessionTitle`, `updateSessionUpdatedAt`）。插入到 index 3 不影响 `menuArr[2]` 指向。

### 6. 页面组件设计

#### 6.1 主页面 `views/a2a-cron/index.vue`

**页面结构**：参照 `a2a-project/index.vue` 的布局模式（头部 + ServerTabs + 内容区）。

```
┌─────────────────────────────────────────────────────┐
│  定时任务                                             │
│  管理 Agent 的自动化定时任务                           │
├─────────────────────────────────────────────────────┤
│  [服务器 A] [服务器 B]  [+ 添加]                      │
├────────────────────────────┬────────────────────────┤
│  Agent 选择:               │  状态: 3 个任务, 2 活跃  │
│  [▼ jarvis (项目名)]       │                          │
├────────────────────────────┴────────────────────────┤
│  [+ 新建任务]                               [刷新]   │
├─────────────────────────────────────────────────────┤
│  ┌─ CronJobList ──────────────────────────────────┐ │
│  │ 每日部署检查    0 9 * * *   ● 运行中   [▶][⏹][…]│ │
│  │ 周报生成        0 18 * * 5  ✓ 成功     [▶]  […]│ │
│  │ 日志清理        */30 * * *  ✗ 错误     [▶]  […]│ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**关键交互流程**：

```
页面加载:
  1. loadServers() → 渲染 ServerTabs
  2. 默认选中 activeServerId 对应的服务器
  3. 获取该服务器的项目列表 → 选择第一个有 A2A 配置的 Agent
  4. loadJobs(serverUrl, agentId, apiKey) → 渲染 CronJobList
  5. subscribeCron(agentId, serverUrl) → 接收实时状态

切换服务器:
  1. unsubscribeCron() → 退订旧 Agent
  2. 获取新服务器的 Agent 列表
  3. loadJobs() + subscribeCron() → 切换数据源

切换 Agent:
  1. unsubscribeCron()
  2. cronStore.setCurrentAgent(serverUrl, agentId, apiKey)
  3. loadJobs() + subscribeCron()

页面离开（onUnmounted）:
  1. unsubscribeCron(currentServerUrl) → 退订 cron 频道，后端停止推送
```

**核心实现**：

```vue
<template>
  <div class="a2a-cron-container">
    <!-- 头部 -->
    <div class="header">
      <div class="header-title">
        <h2>{{ $t('cron.title') }}</h2>
        <p class="header-subtitle">{{ $t('cron.subtitle') }}</p>
      </div>
    </div>
    <div class="header-divider"></div>

    <!-- 服务器标签页（复用 a2a-project 的 ServerTabs 组件） -->
    <!-- @add/@edit/@delete: cron 页面不管理服务器，导航到 a2a-projects 页面 -->
    <ServerTabs
      v-if="servers.length > 0"
      :servers="servers"
      :activeServerId="activeServerId"
      :showAllOption="false"
      @select="handleSelectServer"
      @add="router.push('/platform/a2a-projects')"
      @edit="router.push('/platform/a2a-projects')"
      @delete="router.push('/platform/a2a-projects')"
    />

    <!-- 无服务器状态 -->
    <div v-if="servers.length === 0" class="empty-state">
      <t-icon name="time" size="64px" class="empty-icon" />
      <span class="empty-txt">{{ $t('cron.empty.noServer') }}</span>
      <span class="empty-desc">{{ $t('cron.empty.noServerDesc') }}</span>
      <t-button theme="primary" @click="goToProjects">
        {{ $t('cron.empty.goConfig') }}
      </t-button>
    </div>

    <template v-else>
      <!-- Agent 选择器 + 状态栏 -->
      <div class="toolbar">
        <div class="toolbar-left">
          <span class="toolbar-label">Agent:</span>
          <t-select
            v-model="selectedAgentId"
            :options="agentOptions"
            size="small"
            style="width: 240px"
            @change="handleSelectAgent"
          />
        </div>
        <div class="toolbar-right">
          <span v-if="cronStore.activeJobCount > 0" class="status-badge">
            {{ cronStore.activeJobCount }} {{ $t('cron.active') }}
            <template v-if="cronStore.runningJobCount > 0">
              / {{ cronStore.runningJobCount }} {{ $t('cron.running') }}
            </template>
          </span>
          <t-button variant="outline" size="small" @click="handleRefresh">
            <template #icon><t-icon name="refresh" /></template>
          </t-button>
          <t-button theme="primary" size="small" @click="handleCreate">
            <template #icon><t-icon name="add" /></template>
            {{ $t('cron.createJob') }}
          </t-button>
        </div>
      </div>

      <!-- 加载状态 -->
      <div v-if="loading" class="loading-state">
        <t-loading size="large" />
      </div>

      <!-- 任务列表（空列表在 CronJobList 内部处理，显示 empty.noJobs 空状态） -->
      <CronJobList
        v-else
        :jobs="cronStore.currentJobs"
        @toggle="handleToggle"
        @run="handleRun"
        @stop="handleStop"
        @edit="handleEdit"
        @delete="handleDelete"
        @viewRuns="handleViewRuns"
      />
    </template>

    <!-- 创建/编辑抽屉 -->
    <CronJobForm
      v-model:visible="showForm"
      :mode="formMode"
      :job="editingJob"
      :serverUrl="currentServer?.serverUrl || ''"
      :agentId="selectedAgentId"
      :apiKey="currentServer?.apiKey || ''"
      @saved="handleJobSaved"
    />

    <!-- 执行历史抽屉 -->
    <CronRunHistory
      v-model:visible="showRunHistory"
      :job="selectedJob"
      :serverUrl="currentServer?.serverUrl || ''"
      :agentId="selectedAgentId"
      :apiKey="currentServer?.apiKey || ''"
      @viewDetail="handleViewRunDetail"
    />

    <!-- 对话回放弹窗 -->
    <CronRunDetail
      v-model:visible="showRunDetail"
      :run="selectedRun"
      :serverUrl="currentServer?.serverUrl || ''"
      :agentId="selectedAgentId"
      :apiKey="currentServer?.apiKey || ''"
      :jobId="selectedJob?.id || ''"
    />
  </div>
</template>
```

**生命周期清理**（防止页面离开后 WS 订阅泄漏）：

```typescript
import { onUnmounted } from 'vue'

onUnmounted(() => {
  cronStore.unsubscribeCron(currentServer.value?.serverUrl)
})
```

**事件 Handler 实现**（CRUD 操作后通过 `upsertJob`/`removeJob` 直接更新 Store，无需全量刷新）：

```typescript
import {
  toggleCronJob, triggerCronJob, stopCronJob, deleteCronJob
} from '@/api/a2a/cron'
import { MessagePlugin } from 'tdesign-vue-next'

// --- CronJobList 事件 ---

function handleCreate() {
  editingJob.value = null
  formMode.value = 'create'
  showForm.value = true
}

async function handleToggle(job: CronJob) {
  try {
    const updated = await toggleCronJob(sv(), selectedAgentId.value, ak(), job.id)
    cronStore.upsertJob(sv(), selectedAgentId.value, updated)
    MessagePlugin.success(updated.enabled ? t('cron.messages.toggleEnabled') : t('cron.messages.toggleDisabled'))
  } catch (err) {
    MessagePlugin.error(String(err))
  }
}

async function handleRun(job: CronJob) {
  try {
    await triggerCronJob(sv(), selectedAgentId.value, ak(), job.id)
    MessagePlugin.success(t('cron.messages.triggerSuccess'))
    // 状态更新由 WS cron:started 事件驱动，无需手动改 Store
  } catch (err) {
    MessagePlugin.error(String(err))
  }
}

async function handleStop(job: CronJob) {
  const runId = cronStore.runningRunIds.get(job.id)
  if (!runId) return
  try {
    await stopCronJob(sv(), selectedAgentId.value, ak(), job.id, runId)
    MessagePlugin.success(t('cron.messages.stopSuccess'))
    // 状态更新由 WS cron:completed(stopped) 事件驱动
  } catch (err) {
    MessagePlugin.error(String(err))
  }
}

function handleEdit(job: CronJob) {
  editingJob.value = job
  formMode.value = 'edit'
  showForm.value = true
}

async function handleDelete(job: CronJob) {
  try {
    await deleteCronJob(sv(), selectedAgentId.value, ak(), job.id)
    cronStore.removeJob(sv(), selectedAgentId.value, job.id)
    MessagePlugin.success(t('cron.messages.deleteSuccess'))
  } catch (err) {
    MessagePlugin.error(String(err))
  }
}

function handleViewRuns(job: CronJob) {
  selectedJob.value = job
  showRunHistory.value = true
}

// --- CronJobForm 事件 ---

function handleJobSaved(job: CronJob) {
  cronStore.upsertJob(sv(), selectedAgentId.value, job)
  showForm.value = false
  MessagePlugin.success(formMode.value === 'create'
    ? t('cron.messages.createSuccess')
    : t('cron.messages.updateSuccess'))
}

// --- 工具函数（简写当前服务器信息） ---
function sv() { return currentServer.value?.serverUrl || '' }
function ak() { return currentServer.value?.apiKey || '' }

// --- 页面级 UI handler ---

function goToProjects() {
  router.push('/platform/a2a-projects')
}

async function handleRefresh() {
  await cronStore.refreshCurrentJobs()
}

async function handleSelectServer(serverId: string | null) {
  if (!serverId) return
  activeServerId.value = serverId
  const server = servers.value.find(s => s.id === serverId)
  if (!server) return
  cronStore.unsubscribeCron(currentServer.value?.serverUrl)
  currentServer.value = server
  loading.value = true
  agentOptions.value = await loadAgents(server.serverUrl, server.apiKey)
  if (agentOptions.value.length > 0) {
    selectedAgentId.value = agentOptions.value[0].value
    await handleSelectAgent(selectedAgentId.value)
  }
  loading.value = false
}

async function handleSelectAgent(agentId: string) {
  cronStore.unsubscribeCron(currentServer.value?.serverUrl)
  selectedAgentId.value = agentId
  cronStore.setCurrentAgent(sv(), agentId, ak())
  await cronStore.loadJobs(sv(), agentId, ak())
  cronStore.subscribeCron(agentId, sv())
}

function handleViewRunDetail(run: CronRun) {
  selectedRun.value = run
  showRunDetail.value = true
}
```

**Agent 选择器数据获取**：

```typescript
// 获取当前服务器的项目列表 → 提取有 A2A 配置的 Agent
// 复用 api/a2a/index.ts 中已有的 fetchA2AProjects + fetchA2AMapping
// 注意: fetchA2AProjects 使用 authFetch（JWT 认证），这是 Agent 选择器的唯一 JWT 依赖

// 竞态防护：快速切换服务器时，丢弃过期请求的结果
let loadAgentsVersion = 0

async function loadAgents(serverUrl: string, apiKey: string) {
  const version = ++loadAgentsVersion

  try {
    const projects = await fetchA2AProjects(serverUrl, apiKey)

    // 竞态检查：如果在 await 期间用户已切换到其他服务器，丢弃本次结果
    if (version !== loadAgentsVersion) return []

    const agentOptions = []

    // 使用 Promise.allSettled 并行获取 mapping，避免串行 N+1 延迟
    // 单个 mapping 失败不影响其他项目
    const mappingResults = await Promise.allSettled(
      projects.map(project => fetchA2AMapping(serverUrl, apiKey, project.path))
    )

    // 二次竞态检查
    if (version !== loadAgentsVersion) return []

    for (let i = 0; i < projects.length; i++) {
      const result = mappingResults[i]
      if (result.status === 'fulfilled' && result.value.a2aAgentId) {
        const mapping = result.value
        agentOptions.push({
          label: `${projects[i].defaultAgentName || projects[i].name} (${projects[i].name})`,
          value: mapping.a2aAgentId,
          // 额外数据供 API 调用使用
          projectPath: projects[i].path,
          agentType: mapping.agentType,
          workingDirectory: mapping.workingDirectory,
        })
      }
    }

    return agentOptions
  } catch (err) {
    // fetchA2AProjects 在 401/网络失败时抛异常（有 401 单次重试）
    console.warn('[CronPage] Failed to load agents:', err)
    return []
  }
}
```

#### 6.2 任务列表 `CronJobList.vue`

使用 TDesign `t-table` 表格组件：

**空列表状态**：当 `jobs` 为空数组时，显示空状态插槽（TDesign `t-table` 的 `empty` slot），内容为 `cron.empty.noJobs` + `cron.empty.noJobsDesc` + 新建按钮。

| 列 | 字段 | 说明 |
|---|---|---|
| 名称 | `name` | 任务名，hover 显示 `description` tooltip |
| 触发消息 | `triggerMessage` | 截断显示前 50 字符 |
| 调度 | `schedule` | 可读格式（"每 5 分钟" / "0 9 * * *" / "2026-03-20 09:00"） |
| 执行模式 | `sessionTarget` | Tag: "隔离" / "复用" |
| 状态 | `lastRunStatus` + `enabled` | 状态指示器（见下方） |
| 下次执行 | `nextRunAt` | 相对时间（"3 小时后"） |
| 操作 | — | 按钮组（见下方） |

**状态指示器设计**（使用 i18n，不硬编码中文）：

```typescript
function getStatusDisplay(job: CronJob) {
  if (!job.enabled) return { color: 'default', text: t('cron.status.disabled'), icon: 'pause-circle' }
  if (job.lastRunStatus === 'running') return { color: 'warning', text: t('cron.status.running'), icon: 'loading', spin: true }
  if (job.lastRunStatus === 'success') return { color: 'success', text: t('cron.status.success'), icon: 'check-circle' }
  if (job.lastRunStatus === 'error') return { color: 'danger', text: t('cron.status.error'), icon: 'close-circle' }
  if (job.lastRunStatus === 'stopped') return { color: 'default', text: t('cron.status.stopped'), icon: 'stop-circle' }
  return { color: 'primary', text: t('cron.status.waiting'), icon: 'time' }
}
```

**操作按钮**：

```
[▶ 运行] — 手动触发（lastRunStatus === 'running' 时禁用）
[⏹ 停止] — 仅 running 状态 + isolated 模式时显示（reuse 不支持停止）
             runId 从 cronStore.runningRunIds.get(job.id) 获取
             runId 不存在时按钮禁用（极端情况：WS cron:started 未到达）
[⏯ 启用/禁用] — toggle
[📋 历史] — 查看执行历史
[✏️ 编辑] — 打开编辑抽屉
[🗑 删除] — 确认后删除
```

**Schedule 可读格式转换**：

```typescript
function formatSchedule(schedule: CronSchedule): string {
  const { t } = useI18n()
  switch (schedule.type) {
    case 'interval':
      if (!schedule.intervalMinutes) return '—'
      if (schedule.intervalMinutes < 60)
        return t('cron.schedule.everyNMinutes', { n: schedule.intervalMinutes })
      if (schedule.intervalMinutes % 60 === 0)
        return t('cron.schedule.everyNHours', { n: schedule.intervalMinutes / 60 })
      return t('cron.schedule.everyNMinutes', { n: schedule.intervalMinutes })
    case 'cron':
      return schedule.cronExpression || '—'
    case 'once':
      return schedule.executeAt
        ? new Date(schedule.executeAt).toLocaleString()
        : '—'
    default:
      return '—'
  }
}
```

#### 6.3 创建/编辑表单 `CronJobForm.vue`

使用 TDesign `t-drawer` 侧边抽屉：

```
┌──────────────────────────────────────┐
│  [×]  新建定时任务 / 编辑定时任务       │
├──────────────────────────────────────┤
│  任务名称 *                            │
│  [每日部署检查                     ]   │
│                                       │
│  描述                                  │
│  [检查所有服务的部署状态          ]     │
│                                       │
│  触发消息 *                            │
│  ┌───────────────────────────────┐    │
│  │ 检查所有服务的部署状态，        │    │
│  │ 有异常就汇报                    │    │
│  └───────────────────────────────┘    │
│                                       │
│  调度类型                              │
│  (●) 定时 Cron  ( ) 间隔  ( ) 单次    │
│                                       │
│  Cron 表达式 *        [? 帮助]         │
│  [0 9 * * *                       ]   │
│  下次执行: 2026-03-20 09:00:00         │
│                                       │
│  执行模式                              │
│  (●) 隔离模式    ( ) 复用模式          │
│  💡 每次新建 SDK 进程，无上下文         │
│                                       │
│  ▼ 高级选项                            │
│  超时时间(秒)   [300]                  │
│  最大轮次       [10 ]                  │
│  💡 复用模式下修改后需等 session 重建   │
│                                       │
├──────────────────────────────────────┤
│            [取消]    [保存]            │
└──────────────────────────────────────┘
```

**表单验证规则**：

```typescript
// Cron 表达式前端预校验（5 段格式基础检查，精确校验由后端 node-cron.validate 完成）
function validateCronExpression(val: string): boolean {
  return /^(\S+\s+){4}\S+$/.test(val.trim())
}

// 表单验证规则（所有 message 使用 i18n，不硬编码）
// 按 schedule.type 条件化：仅校验当前调度类型对应的字段，避免非当前 type 的 required 误触发
const { t } = useI18n()

const formRules = computed(() => {
  const rules: Record<string, any[]> = {
    name: [
      { required: true, message: t('cron.form.validation.nameRequired') },
      { max: 100, message: t('cron.form.validation.nameMax') },
    ],
    description: [
      { max: 500, message: t('cron.form.validation.descriptionMax') },
    ],
    triggerMessage: [
      { required: true, message: t('cron.form.validation.triggerMessageRequired') },
      { max: 10000, message: t('cron.form.validation.triggerMessageMax') },
    ],
  }

  // 按当前 schedule.type 动态添加对应字段的校验
  if (formData.scheduleType === 'cron') {
    rules['schedule.cronExpression'] = [
      { required: true, message: t('cron.form.validation.cronRequired'), trigger: 'blur' },
      { validator: validateCronExpression, message: t('cron.form.validation.cronInvalid') },
    ]
  } else if (formData.scheduleType === 'interval') {
    rules['schedule.intervalMinutes'] = [
      { required: true, message: t('cron.form.validation.intervalRequired') },
      { type: 'number', min: 1, max: 10080, message: t('cron.form.validation.intervalRange') },
    ]
  } else if (formData.scheduleType === 'once') {
    rules['schedule.executeAt'] = [
      { required: true, message: t('cron.form.validation.executeAtRequired') },
      // 仅 create 模式校验未来时间；edit 模式已过期的 once job（enabled=false）允许保存
      // 避免用户只改名或改消息时被 future 校验阻止
      ...(props.mode === 'create' ? [{
        validator: (val: string) => new Date(val) > new Date(),
        message: t('cron.form.validation.executeAtFuture'),
      }] : []),
    ]
  }

  return rules
})
```

**表单提交转换**（秒→毫秒 + 按 type 清除无关 schedule 字段）：

```typescript
const submitting = ref(false)

// --- 编辑模式回填（CronJob → formData，反向转换） ---

function initFormData(job?: CronJob) {
  if (!job) {
    // create 模式：使用默认值
    Object.assign(formData, {
      name: '', description: '', triggerMessage: '',
      scheduleType: 'cron' as const,
      cronExpression: '', intervalMinutes: 5, executeAt: '',
      sessionTarget: 'isolated' as const,
      timeoutSeconds: 300, maxTurns: 10,
    })
    return
  }

  // edit 模式：从 CronJob 反向填充
  Object.assign(formData, {
    name: job.name,
    description: job.description || '',
    triggerMessage: job.triggerMessage,
    scheduleType: job.schedule.type,
    cronExpression: job.schedule.cronExpression || '',
    intervalMinutes: job.schedule.intervalMinutes || 5,
    executeAt: job.schedule.executeAt || '',
    sessionTarget: job.sessionTarget,
    // ms → 秒 反转换（后端存 ms，前端表单用秒）
    timeoutSeconds: job.timeoutMs ? job.timeoutMs / 1000 : 300,
    maxTurns: job.maxTurns || 10,
  })
}

// 监听 props.job 变化，visible 打开时初始化
watch(() => [props.visible, props.job], ([visible]) => {
  if (visible) initFormData(props.mode === 'edit' ? props.job : undefined)
}, { immediate: true })

// --- 提交转换（formData → CreateCronJobRequest） ---

function buildRequest(): CreateCronJobRequest {
  return {
    name: formData.name,
    description: formData.description || undefined,
    triggerMessage: formData.triggerMessage,
    schedule: {
      type: formData.scheduleType,
      // 仅发送当前 type 对应的字段，避免残留旧值
      ...(formData.scheduleType === 'cron' && { cronExpression: formData.cronExpression }),
      ...(formData.scheduleType === 'interval' && { intervalMinutes: Math.round(Number(formData.intervalMinutes)) }),
      ...(formData.scheduleType === 'once' && { executeAt: formData.executeAt }),
    },
    sessionTarget: formData.sessionTarget,
    // 前端以秒为单位输入，后端 Zod 校验 min(10000).max(3600000) 毫秒 + .int() 整数约束
    // Math.round 确保整数，避免 10.5 * 1000 = 10500.0000...001 被 Zod .int() 拒绝
    timeoutMs: formData.timeoutSeconds ? Math.round(formData.timeoutSeconds * 1000) : undefined,
    maxTurns: formData.maxTurns ? Math.round(Number(formData.maxTurns)) : undefined,
  }
}

async function handleSubmit() {
  if (submitting.value) return
  submitting.value = true
  try {
    const req = buildRequest()
    if (props.mode === 'create') {
      const job = await createCronJob(props.serverUrl, props.agentId, props.apiKey, req)
      emit('saved', job)
    } else {
      const job = await updateCronJob(props.serverUrl, props.agentId, props.apiKey, props.job!.id, req)
      emit('saved', job)
    }
  } catch (err: any) {
    // 后端 400（Zod 校验失败/cron 表达式无效）→ 显示错误
    MessagePlugin.error(err.message || t('cron.messages.submitError'))
  } finally {
    submitting.value = false
  }
}
```

**Cron 表达式帮助**：

```
常用表达式:
  */5 * * * *     每 5 分钟
  0 * * * *       每小时
  0 9 * * *       每天 9:00
  0 9 * * 1-5     工作日 9:00
  0 0 * * 0       每周日 0:00
  0 9,18 * * *    每天 9:00 和 18:00

格式: 分 时 日 月 周
  分: 0-59
  时: 0-23
  日: 1-31
  月: 1-12
  周: 0-7 (0 和 7 都是周日)
```

**执行模式说明文案**：

| 模式 | 说明 |
|------|------|
| **隔离模式 (isolated)** | 每次执行启动独立 SDK 进程，执行完销毁。无上下文记忆，适合独立的检查任务。 |
| **复用模式 (reuse)** | 使用固定的常驻 SDK 进程，保留历史对话上下文。Agent 能记住之前的执行结果。不支持中途停止。 |

#### 6.4 执行历史 `CronRunHistory.vue`

使用 TDesign `t-drawer` 侧边抽屉，内含 `t-table`：

```
┌──────────────────────────────────────┐
│  [×]  执行历史 — 每日部署检查          │
├──────────────────────────────────────┤
│  ID       状态    开始时间    耗时  操作│
│  run_a1b2 ✓ 成功  03-19 09:00 12s  [📖]│
│  run_c3d4 ✗ 错误  03-18 09:00 5s   [📖]│
│  run_e5f6 ⏹ 停止  03-17 09:00 3s   [📖]│
│  ...                                  │
├──────────────────────────────────────┤
│  共 15 条记录                          │
└──────────────────────────────────────┘
```

| 列 | 字段 | 说明 |
|---|---|---|
| 状态 | `status` | Tag 颜色（success/error/warning/default） |
| 开始时间 | `startedAt` | 格式化为本地时间 |
| 耗时 | `executionTimeMs` | 格式化（"12s" / "2m 30s"） |
| 摘要 | `responseSummary` | 前 100 字符 + tooltip |
| 错误 | `error` | 仅 error 状态显示，红色文字 |
| 操作 | — | [查看对话] 按钮 → 打开 CronRunDetail |

#### 6.5 对话回放 `CronRunDetail.vue`

使用 TDesign `t-dialog` 全屏弹窗。

**核心逻辑**：调用 `fetchCronRunHistory()` 获取 `A2AHistoryEvent[]`，然后根据事件格式选择渲染方式：

- **reuse 模式** history：标准 SDK 事件（有 `message.content` 数组），使用 `convertHistoryToMessages()` 转换后渲染
- **isolated 模式** history：简化 log 事件（有 `level` 字段，无 `message.content`），降级渲染为日志列表

```typescript
// CronRunDetail.vue — 核心数据获取 + 格式检测
import { fetchCronRunHistory } from '@/api/a2a/cron'
import { convertHistoryToMessages } from '@/api/a2a/index'
import type { A2AChatMessage } from '@/api/a2a/types'

const messages = ref<A2AChatMessage[]>([])
const logEvents = ref<Array<{ type: string; level: string; message: string; timestamp: string }>>([])
const isLogFormat = ref(false)  // isolated 模式产生 log 格式事件
const loading = ref(false)

async function loadHistory() {
  if (!props.run || !props.serverUrl) return
  loading.value = true
  try {
    const events = await fetchCronRunHistory(
      props.serverUrl, props.agentId, props.apiKey,
      props.jobId, props.run.id
    )

    // 检测事件格式：isolated 模式 history 来自 TaskResult.logs，有 level 字段
    // logs 结构: { type, level, message: string, timestamp }（message 是字符串，不是 SDK 的 { content: [] } 对象）
    // SDK 事件结构: { type: 'assistant', message: { content: [...] } }
    if (events.length > 0 && 'level' in events[0] && !events[0].message?.content) {
      isLogFormat.value = true
      logEvents.value = events as any
      messages.value = []
    } else {
      isLogFormat.value = false
      messages.value = convertHistoryToMessages(events)
      logEvents.value = []
    }
  } catch (err) {
    console.error('[CronRunDetail] Failed to load history:', err)
  } finally {
    loading.value = false
  }
}
```

**消息渲染**：根据 `isLogFormat` 选择渲染方式。reuse 模式复用现有 A2A 消息组件，isolated 模式降级为日志列表。

```vue
<!-- reuse 模式：标准 A2A 消息渲染 -->
<template v-if="!isLogFormat">
  <div v-for="msg in messages" :key="msg.id" class="message-item">
    <!-- 用户消息 -->
    <div v-if="msg.role === 'user'" class="user-message">
      {{ msg.content }}
    </div>

    <!-- 助手消息 -->
    <div v-else class="assistant-message">
      <div v-for="part in msg.contentParts" :key="part.toolCallId || part.content?.slice(0, 20)">
        <!-- 文本块 -->
        <div v-if="part.type === 'text'" class="text-content" v-html="renderMarkdown(part.content)" />

        <!-- 工具调用块 -->
        <ToolCallRenderer
          v-else-if="part.type === 'tool_call'"
          :toolCall="msg.toolCalls?.find(tc => tc.id === part.toolCallId)"
        />
      </div>
    </div>
  </div>
</template>

<!-- isolated 模式：日志格式降级渲染 -->
<!-- isolated history 来自 TaskResult.logs，结构为 { type, level, message, timestamp, data? } -->
<!-- 无法走 convertHistoryToMessages（缺少 message.content 结构），直接渲染为日志列表 -->
<template v-else>
  <div v-for="(log, i) in logEvents" :key="i" class="log-item">
    <span class="log-time">{{ new Date(log.timestamp).toLocaleTimeString() }}</span>
    <t-tag :theme="log.level === 'error' ? 'danger' : log.level === 'warn' ? 'warning' : 'default'" size="small">
      {{ log.level }}
    </t-tag>
    <span class="log-type">{{ log.type }}</span>
    <span class="log-message">{{ log.message }}</span>
  </div>
</template>
```

### 7. 国际化

在 4 个语言文件中新增 `cron` 命名空间。以 `zh-CN.ts` 为例：

```typescript
cron: {
  title: '定时任务',
  subtitle: '管理 Agent 的自动化定时任务',
  createJob: '新建任务',
  editJob: '编辑任务',
  active: '活跃',
  running: '运行中',

  // 空状态
  empty: {
    noServer: '未配置 AgentStudio 服务器',
    noServerDesc: '请先在智能体页面添加服务器连接',
    goConfig: '前往配置',
    noAgent: '该服务器暂无可用 Agent',
    noJobs: '暂无定时任务',
    noJobsDesc: '创建一个定时任务，让 Agent 定时执行自动化工作',
  },

  // 表格列
  columns: {
    name: '任务名称',
    triggerMessage: '触发消息',
    schedule: '调度',
    sessionTarget: '执行模式',
    status: '状态',
    nextRun: '下次执行',
    actions: '操作',
  },

  // 调度可读格式（formatSchedule 使用）
  schedule: {
    everyNMinutes: '每 {n} 分钟',
    everyNHours: '每 {n} 小时',
  },

  // 调度类型
  scheduleType: {
    interval: '间隔',
    cron: '定时 Cron',
    once: '单次',
  },

  // 执行模式
  sessionTargetLabel: {
    isolated: '隔离',
    reuse: '复用',
  },
  sessionTargetDesc: {
    isolated: '每次新建 SDK 进程，无上下文记忆，适合独立检查任务',
    reuse: '常驻 SDK 进程，保留对话上下文。不支持中途停止',
  },

  // 状态
  status: {
    running: '运行中',
    success: '成功',
    error: '错误',
    stopped: '已停止',
    disabled: '已禁用',
    waiting: '等待中',
  },

  // 操作
  actions: {
    run: '运行',
    stop: '停止',
    enable: '启用',
    disable: '禁用',
    edit: '编辑',
    delete: '删除',
    viewHistory: '执行历史',
    viewConversation: '查看对话',
    refresh: '刷新',
  },

  // 表单
  form: {
    name: '任务名称',
    namePlaceholder: '如: 每日部署检查',
    description: '描述',
    descriptionPlaceholder: '任务的简要描述（可选）',
    triggerMessage: '触发消息',
    triggerMessagePlaceholder: '发送给 Agent 的指令内容',
    triggerMessageHelp: '这段文字会作为用户消息发送给 Agent',
    scheduleType: '调度类型',
    cronExpression: 'Cron 表达式',
    cronExpressionPlaceholder: '0 9 * * *',
    cronHelp: 'Cron 表达式帮助',
    cronTimezoneHint: '调度时间以服务器时区为准',
    intervalMinutes: '间隔分钟',
    executeAt: '执行时间',
    sessionTarget: '执行模式',
    advanced: '高级选项',
    timeoutMs: '超时时间（秒）',
    timeoutMsRange: '范围: 10 ~ 3600 秒',
    maxTurns: '最大轮次',
    maxTurnsHelp: '复用模式下修改后需等 session 超时重建后生效',
    // 表单验证消息（供 formRules 的 message 使用）
    validation: {
      nameRequired: '请输入任务名称',
      nameMax: '名称不超过 100 字符',
      descriptionMax: '描述不超过 500 字符',
      triggerMessageRequired: '请输入触发消息',
      triggerMessageMax: '触发消息不超过 10000 字符',
      cronRequired: '请输入 Cron 表达式',
      cronInvalid: '无效的 Cron 表达式',
      intervalRequired: '请输入间隔分钟数',
      intervalRange: '间隔范围: 1 ~ 10080 分钟（最长 7 天）',
      executeAtRequired: '请选择执行时间',
      executeAtFuture: '执行时间必须在未来',
      timeoutRange: '超时范围: 10 ~ 3600 秒',
      maxTurnsRange: '轮次范围: 1 ~ 100',
    },
  },

  // 确认弹窗
  confirm: {
    deleteTitle: '删除定时任务',
    deleteMessage: '确定删除任务「{name}」？关联的执行历史将保留。',
  },

  // 执行历史
  history: {
    title: '执行历史',
    noRuns: '暂无执行记录',
    columns: {
      status: '状态',
      startedAt: '开始时间',
      duration: '耗时',
      summary: '摘要',
      error: '错误',
      actions: '操作',
    },
  },

  // 对话回放
  detail: {
    title: '执行对话',
    loading: '加载对话记录...',
    noHistory: '无对话记录',
  },

  // 消息
  messages: {
    createSuccess: '任务创建成功',
    updateSuccess: '任务更新成功',
    deleteSuccess: '任务已删除',
    triggerSuccess: '已触发执行',
    stopSuccess: '已停止执行',
    toggleEnabled: '任务已启用',
    toggleDisabled: '任务已禁用',
    submitError: '操作失败，请重试',
  },
},
```

## 组件复用清单

| 需求 | 复用来源 | 说明 |
|------|---------|------|
| 服务器 Tab 切换 | `a2a-project/components/ServerTabs.vue` | 直接复用，`showAllOption=false` |
| 获取项目/Agent 列表 | `api/a2a/index.ts` `fetchA2AProjects` + `fetchA2AMapping` | 直接调用 |
| WebSocket 订阅 | `composables/useAgentStudioWS.ts` | `subscribe('cron', { agentId }, serverUrl)` |
| 对话历史转换 | `api/a2a/index.ts` `convertHistoryToMessages` | reuse 模式直接调用；isolated 模式降级为日志列表 |
| 工具调用渲染 | `components/a2a-tools/ToolCallRenderer.vue` | 直接复用 |
| Markdown 渲染 | 现有 marked + highlight.js 工具 | 直接复用 |
| 表格/表单/抽屉 | TDesign `t-table`, `t-form`, `t-drawer`, `t-dialog` | 直接使用 |
| 消息通知 | TDesign `MessagePlugin` | 操作反馈 |

## 数据流总览

```
                          weknora-ui
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  a2a-cron/index.vue                                      │
│    │                                                     │
│    ├── ServerTabs.vue ← loadServers()                    │
│    │                                                     │
│    ├── Agent 选择器 ← fetchA2AProjects + fetchA2AMapping │
│    │                                                     │
│    ├── cronStore.loadJobs() ──────────► api/a2a/cron.ts  │
│    │     ↕ WS 三层数据流                  │ apiKey Bearer│
│    │   ┌─ cron:sync (subscribe 后立即)    │              │
│    │   ├─ cron:started → running         │              │
│    │   ├─ cron:completed → success       │              │
│    │   ├─ cron:error → error             │              │
│    │   ├─ _connection:closed → 清除      │              │
│    │   └─ _connection:opened → REST 刷新 │              │
│    │                                      ▼              │
│    ├── CronJobList.vue ← cronStore.currentJobs           │
│    │     ├── toggle → toggleCronJob()                    │
│    │     ├── run → triggerCronJob()                      │
│    │     ├── stop → stopCronJob()                        │
│    │     ├── edit → CronJobForm.vue                      │
│    │     ├── delete → deleteCronJob()                    │
│    │     └── viewRuns → CronRunHistory.vue               │
│    │                      └── viewDetail →               │
│    │                           CronRunDetail.vue         │
│    │                             ├── fetchCronRunHistory()│
│    │                             ├── convertHistoryToMessages()
│    │                             └── ToolCallRenderer.vue│
│    │                                                     │
│    └── CronJobForm.vue                                   │
│           ├── createCronJob()                            │
│           └── updateCronJob()                            │
│                                                          │
└──────────────────────────────────────────────────────────┘
                          │
                          │ apiKey Bearer Token
                          │ /a2a/{agentId}/cron/*
                          ▼
                   AgentStudio Backend
                   (已实现，不修改)
```

## 验证清单

### 页面加载
- [ ] 无服务器 → 显示空状态，引导去智能体页面配置
- [ ] 有服务器无 Agent → 显示无 Agent 提示
- [ ] 正常加载 → ServerTabs + Agent 选择器 + 任务列表

### 多服务器
- [ ] 切换服务器 → 退订旧 cron 频道 → 加载新 Agent 列表 → 订阅新频道
- [ ] 服务器断线 → 清除该服务器的 cron 数据 → 重连后 REST 刷新

### CRUD
- [ ] 创建任务 → 表单验证 → API 调用 → 列表自动刷新
- [ ] 编辑任务 → 抽屉回填数据 → 保存 → 列表更新
- [ ] 删除任务 → 确认弹窗 → API 调用 → 列表移除
- [ ] 启用/禁用 → toggle API → 状态更新

### 执行
- [ ] 手动触发 → API 调用 → WS cron:started → 状态变为 running
- [ ] 执行完成 → WS cron:completed → 状态变为 success
- [ ] 执行失败 → WS cron:error → 状态变为 error
- [ ] 停止执行 → cronStore.runningRunIds.get(jobId) 获取 runId → API 调用 → 状态变为 stopped（仅 isolated 模式）
- [ ] running 状态 → 运行按钮禁用 → 防止重复触发
- [ ] 停止按钮 → runId 不存在时禁用（WS cron:started 未到达的极端情况）

### 执行历史
- [ ] 查看历史 → 抽屉展示 CronRun 列表
- [ ] 查看对话（reuse 模式）→ fetchCronRunHistory → convertHistoryToMessages → 渲染消息
- [ ] 查看对话（isolated 模式）→ fetchCronRunHistory → 检测 log 格式 → 渲染日志列表
- [ ] 工具调用 → ToolCallRenderer 正确渲染（仅 reuse 模式）

### WebSocket
- [ ] 页面打开 → subscribe('cron', { agentId }, serverUrl)
- [ ] 页面离开（onUnmounted）→ unsubscribe('cron', serverUrl)
- [ ] 切换 Agent → unsubscribe 旧 → subscribe 新
- [ ] cron:sync → 立即更新 Store 数据
- [ ] cron:started → 更新 lastRunStatus + 保存 runId 到 runningRunIds
- [ ] cron:completed/error → 更新 lastRunStatus + 从 runningRunIds 删除

### 国际化
- [ ] 所有用户可见文字使用 $t() 而非硬编码
- [ ] 4 种语言文件都包含 cron 命名空间

## 已知限制

1. **Agent 选择器依赖 JWT**：`fetchA2AProjects` + `fetchA2AMapping` 使用 `authFetch`（JWT 认证），是 cron 页面唯一的 JWT 依赖。Cron CRUD/执行/历史等核心操作全部走 apiKey，不受 `getDefaultServer()` 多服务器 bug 影响。Agent 选择器的 JWT 依赖与 a2a-project 页面相同，已验证可用。
2. **reuse 模式停止按钮隐藏**：后端限制，reuse 模式 `sendMessage` 执行中无中断机制。前端在 `sessionTarget === 'reuse'` 时隐藏停止按钮。
3. **cron 表达式前端预校验有限**：前端只做基础格式校验（5 段式），精确校验由后端 `node-cron.validate()` 完成。提交后如果后端返回 400，显示错误提示。
4. **无跨 Agent 聚合视图**：首版每次只看一个 Agent 的任务。多 Agent 聚合视图（类似 a2a-project 的"全部"Tab）作为后续增强。
5. **cron:sync 的 agentId 缺失**：后端 `cron:sync` 事件只包含 `jobs` 数组，不含 `agentId`。Store 收到 `cron:sync` 时假设数据属于 `currentAgentId`。如果用户快速切换 Agent，可能将旧 Agent 的 sync 数据写入新 Agent 的 slot。影响极小（REST 加载会覆盖），但前端应在 `cron:sync` handler 中加 `serverUrl` 匹配检查。
6. **时区显示**：`nextRunAt` 和执行时间使用 `toLocaleString()` 显示本地时区。Cron 表达式按服务器时区执行，前端在 Cron 表达式输入旁显示时区提示（`cron.form.cronTimezoneHint`）。
7. **`timeoutMs` 范围 10s~3600s**：后端 Zod 校验 `min(10000).max(3600000)`（单位 ms），前端表单以秒为单位输入（range: 10~3600 秒），提交时乘以 1000 转换为 ms。
8. **`ServerTabs` 跨页面引用**：当前从 `views/a2a-project/components/` 导入，后续可提升到 `src/components/` 共享目录。
9. **`lastRunError` 无法通过 WS 实时获取**：后端 `cron:error` 事件只包含 `status`、`jobId`、`runId`、`timestamp`，不包含错误详情。`lastRunError` 字段只能通过 REST 刷新获取（从 `jobs.json` 读取）。用户看到"错误"状态后点击刷新或查看执行历史可获取详情。
10. **isolated 模式对话回放为日志格式**：isolated 执行的 history 来自 `TaskResult.logs`（`{ type, level, message, timestamp, data }`），与标准 A2A history 事件格式不同。`convertHistoryToMessages()` 无法处理此格式，`CronRunDetail.vue` 对 isolated history 降级渲染为日志列表。reuse 模式 history 为标准 SDK 事件，正常渲染。
