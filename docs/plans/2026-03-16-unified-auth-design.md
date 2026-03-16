# AgentStudio 统一认证链修复设计

## 一句话总结

**weknora-ui 对 AgentStudio 的所有请求，从"直接拿密码/WeKnora JWT 当 token"改为"先 login 获取 AgentStudio JWT 再用 JWT"。后端修 await bug 让验证真正生效。**

## 问题链（从表象到根因）

```
WebSocket 多连接重构后连不上
    ↓ 追查
authenticateToken 要求 agt_ 前缀，但传入的是 ADMIN_PASSWORD
    ↓ 临时修复：改为接受任何 token
    ↓ 追问：为什么 REST API 用 ADMIN_PASSWORD 能通过？
authMiddleware 的 verifyToken 没有 await → 任何 token 都放行
    ↓ 追问：前端为什么不调 /api/auth/login 获取正规 JWT？
weknora-ui 从未实现这步，直接拿密码当 token 用
    ↓ 追问：修 await 会影响什么？
发现 authMiddleware 保护的 28 个路由组有两类调用者，用不同的 token
    ↓ 深入验证
类型 B（share/kb/users）的 JWT 只是门卫，userId 从参数取，可以统一换成 AS JWT
```

### 根因：authMiddleware 的 await bug

`verifyToken` 是 async 函数（返回 `Promise<JWTPayload | null>`），但 `authMiddleware` 调用时没有 await：

```typescript
// middleware/auth.ts:35 — 当前代码
const payload = verifyToken(token);  // 没有 await → payload 是 Promise（truthy）
if (!payload) { ... }                // 永远不会执行 → 任何 token 都放行
```

AgentStudio 后端 28 个受 `authMiddleware` 保护的路由组，**实际上没有做任何认证**。系统能正常工作完全依赖这个 bug。

## authMiddleware 保护的两类调用者

**这是本设计最关键的发现**：authMiddleware 保护的 28 个路由组背后，有**两类完全不同的调用者**，使用不同的 token：

### 类型 A：AgentStudio 管理 API（前端 A2A 模块调用）

来源：`weknora-ui/src/api/a2a/index.ts` 中的函数，使用独立的 `fetch()` 调用，手动设置 header。

**子类 A1 — 传入 ADMIN_PASSWORD（来自 `A2AServerConfig.apiKey`）**：

| 前端函数 | 路由 | 调用方 | Token 值 |
|---------|------|--------|----------|
| `fetchA2AProjects` | `GET /api/projects` | a2a-chat, a2a-project（传 `server.apiKey`） | ADMIN_PASSWORD 明文 |
| `fetchA2AMapping` | `GET /api/a2a/mapping/:path` | a2a-chat, a2a-project, ProjectDetail（传 `server.apiKey`） | ADMIN_PASSWORD 明文 |
| `fetchA2AApiKeys` | `GET /api/a2a/api-keys/:path` | a2a-chat, a2a-project, ProjectDetail（传 `server.apiKey`） | ADMIN_PASSWORD 明文 |
| `testA2AConnection` | 内部调 `fetchA2AProjects` | ServerManager | ADMIN_PASSWORD 明文 |

**子类 A2 — 传入 `agt_proj_*`（来自 `A2AConfig.apiKey` 或 `selectedProject.projectApiKey`）**：

| 前端函数 | 路由 | 调用方 | Token 值 |
|---------|------|--------|----------|
| `getA2AHistory` | `GET /api/a2a/history/:path/:id` | a2a-chat（传 `configStore.config`，类型 `A2AConfig`） | `agt_proj_*` |

**子类 A3 — 双调用方（不同 token 类型）**：

| 前端函数 | 路由 | 调用方 1 | 调用方 2 |
|---------|------|---------|---------|
| `fetchActiveSessions` | `GET /api/agents/sessions` | menu.vue 传 `s.apiKey`（ADMIN_PW） | ActiveSessionsPanel 传 `projectApiKey`（`agt_proj_*`） |

**未被调用的函数（死代码）**：

| 前端函数 | 路由 | 说明 |
|---------|------|------|
| `fetchProjectA2AConfig` | `GET /api/projects/:path/a2a-config` | 无任何 .vue 调用方 |
| `closeActiveSession` | `DELETE /api/agents/sessions/:id` | 无任何 .vue 调用方 |

认证方式：`headers: { 'Authorization': \`Bearer ${apiKey}\` }` — 直接传 ADMIN_PASSWORD 或 agt_proj_*，从未调用 `/api/auth/login` 获取 JWT。

### 类型 B：WeKnora 用户体系延伸 API（前端通用 axios 调用）

来源：`weknora-ui/src/api/share/index.ts`、`api/agentstudio/tag.ts`，使用 `utils/request.ts` 的 axios 实例，自动附带 `weknora_token`。

| 前端模块 | 路由 | Token 来源 | Token 值 |
|---------|------|-----------|----------|
| `api/share/*.ts` (18 个函数) | `/api/share/*` | `localStorage.weknora_token` | WeKnora JWT |
| `api/agentstudio/tag.ts` (6 个函数) | `/api/kb/*` | `localStorage.weknora_token` | WeKnora JWT |
| `api/share/index.ts` | `/api/users/search` | `localStorage.weknora_token` | WeKnora JWT |
| `api/share/index.ts` | `/api/users/tenant/:id` | `localStorage.weknora_token` | WeKnora JWT |

认证方式：axios 拦截器自动添加 `Authorization: Bearer ${localStorage.getItem('weknora_token')}`。`weknora_token` 是用户登录 **WeKnora**（非 AgentStudio）后获得的 JWT，用 **WeKnora 的 secret** 签名。

### 类型 C：不经过 authMiddleware 的路由（不受影响）

| 路由 | 中间件 | Token 类型 |
|------|--------|-----------|
| `/a2a/:agentId/*` (A2A 协议) | `a2aAuth` (bcrypt) | `agt_proj_*` |
| `/api/share/link/*` (分享链接) | 无 (cookie) | HMAC-SHA256 cookie |
| `/api/auth/login` | 无 | ADMIN_PASSWORD |
| `/api/engine` | 无 | 公开路由 |
| WebSocket `/ws` | 自定义 `authenticateToken` | 见下文 |

> **注意**：`api/a2a/index.ts` 中的 `fetchA2ASkills`、`fetchAgentCard` 也属于类型 C — 它们调用 `/a2a/:agentId/skills` 和 `/a2a/:agentId/.well-known/agent-card.json`，走 `a2aAuth`（bcrypt），不走 `authMiddleware`，不需要修改。

## 影响范围分析

如果直接修复 authMiddleware 的 await bug（让 `verifyToken` 真正验证 JWT 签名）：

### 会 401 的路由（类型 A1 — ADMIN_PASSWORD）

前端发送 ADMIN_PASSWORD 明文作为 Bearer Token → `jwt.verify(ADMIN_PASSWORD, agentStudioSecret)` → 签名不匹配 → **401**

影响函数：`fetchA2AProjects`, `fetchA2AMapping`, `fetchA2AApiKeys`（`testA2AConnection` 内部调 `fetchA2AProjects`）

### 会 401 的路由（类型 A2 — agt_proj_*）

前端发送 Project API Key 作为 Bearer Token → 不是 JWT 格式 → **401**

影响函数：`getA2AHistory`

### 会 401 的路由（类型 A3 — 双调用方）

`fetchActiveSessions` 有两个调用方，传不同 token：
- menu.vue 传 ADMIN_PASSWORD → **401**
- ActiveSessionsPanel 传 `agt_proj_*` → **401**

### 会 401 的路由（类型 B — WeKnora JWT）

前端发送 WeKnora JWT → `jwt.verify(weknoraJWT, agentStudioSecret)` → secret 不同 → 签名不匹配 → **401**

| 路由组 | 函数数量 | 功能 |
|--------|---------|------|
| `/api/share/*` | 18 个 | 知识库分享 CRUD + 内容访问 |
| `/api/kb/*` | 6 个 | 知识库标签树管理 |
| `/api/users/search` | 1 个 | 用户搜索 |
| `/api/users/tenant/:id` | 1 个 | 租户信息 |

### 不受影响的路由

| 路由 | 原因 |
|------|------|
| `/a2a/:agentId/*` | 走 `a2aAuth`，不走 `authMiddleware` |
| `/api/share/link/*` | 不走 `authMiddleware`，用 cookie |
| `/api/auth/login` | 公开路由，不走 `authMiddleware` |

### 业务逻辑不受影响

所有 service 层（`shareService`, `tagService`, `weknoraUserService` 等）的业务逻辑完全正常。问题**仅在 authMiddleware 认证层**，是"门卫"问题而非"功能"问题。

## 四种 Credential 说明

| Credential | 格式 | 来源 | 用途 |
|-----------|------|------|------|
| ADMIN_PASSWORD | 用户设置的密码字符串 | `weknora_a2a_servers` localStorage `.apiKey` 字段 | 应调用 `/api/auth/login` 换取 AgentStudio JWT |
| AgentStudio JWT | `eyJhbG...` (7 天有效, AgentStudio secret) | AgentStudio `/api/auth/login` 返回 | 管理 API (`/api/projects` 等) + WebSocket (`/ws`) |
| WeKnora JWT | `eyJhbG...` (WeKnora secret) | 用户登录 WeKnora 后存入 `weknora_token` | 分享/标签/用户 API（当前直接发给 AgentStudio） |
| Project API Key | `agt_proj_{hash}_{hex}` | `weknora_a2a_config` localStorage `.apiKey` 字段 | A2A 协议路由 (`/a2a/:agentId/*`) |

## 目标

修复完整认证链，使所有认证点正确工作：

| 认证点 | 修复前 | 修复后 |
|--------|--------|--------|
| authMiddleware (28 路由组) | 接受任何 token（bug） | 验证 JWT 签名和过期 |
| WebSocket | 接受任何非空 token（临时修复） | 验证 JWT 签名和过期 |
| a2aAuth (3 路由) | bcrypt 验证 agt_proj_* | 不变 |

### 类型 B 路由的处理方案

经验证，类型 B 路由中 JWT **仅作为门卫 token**（验证"有没有合法 token"），从不解析 JWT payload。userId 全部从请求参数（query/body）传入，与 JWT 内容无关。

因此类型 B 可以用与类型 A 相同的方式修复：**前端改为发送 AgentStudio JWT**，不需要改后端路由和 service 层。

逐端点验证结果：

| 路由组 | 端点数 | 读 req.user | 解析 JWT payload | userId 来源 |
|--------|--------|-------------|-----------------|------------|
| `/api/share/*` | 19 | 否 | 否 | query/body param |
| `/api/kb/*` | 6 | 否 | 否 | 不需要 |
| `/api/users/*` | 7 (其中 2 个从 weknora-ui 调用) | 否 | 否 | 不需要 |

> **`/api/users/*` 说明**：该路由组共 7 个端点，但仅 `/search` 和 `/tenant/:tenantId` 从 weknora-ui 调用（Type B）。其余 5 个端点（`/status`, `/`, `/project/:projectId` GET/PUT/DELETE）从 AgentStudio 自己的 React 前端调用，该前端已有正确的 JWT 认证，属于 Type A 行为。

**结论**：JWT 在这些路由上纯粹是门卫功能。把前端发的 token 从 WeKnora JWT 换成 AgentStudio JWT，authMiddleware 就能正确验证，业务逻辑零影响。

## 类型 B 路由深度分析

### JWT 在类型 B 路由中的实际作用

经逐端点验证，类型 B 的 32 个端点中：
- **0 个**读取 `req.user`
- **0 个**解析 JWT payload
- **0 个**从 JWT 中获取 userId

JWT 的唯一作用是 authMiddleware 的门卫检查（当前因 bug 等于无检查）。userId 来源完全独立于 JWT：

| 路由 | userId 来源 | 说明 |
|------|-----------|------|
| `/api/share/list/my-shares` | `?userId=xxx` query param | 前端显式传入 |
| `/api/share` POST | body `{ userId, tenantId }` | 前端显式传入 |
| `verifyOwnership()` | `getUserId(req)` → query/body | 对比 DB 中 owner_user_id |
| `verifyAccess()` | `getUserId(req)` → query/body | 对比 share_targets |
| `/api/kb/*` | 不需要 userId | 只用 kbId path param |
| `/api/users/*` | 不需要 userId | 只用 tenantId / 搜索词 |

### 安全风险（预先存在，非本次引入）

由于 userId 来自不可信的请求参数，存在伪造风险：

| 攻击场景 | 方法 | 风险 |
|---------|------|------|
| 查看他人分享 | `?userId=victim-id` | 可列出任何人的分享列表 |
| 冒充他人创建分享 | body: `{ userId: "victim-id" }` | 可以其他用户身份创建分享 |
| 修改他人分享 | verifyOwnership 对比的 userId 也来自请求参数 | 提供正确的 owner_user_id 即可绕过 |
| 修改任何 KB 标签 | `/api/kb/:kbId/*` 无 userId 检查 | 知道 kbId 即可增删改标签 |
| 查看任何租户用户 | `/api/users/tenant/:tenantId` | 无租户边界验证 |

**这些安全问题与本次认证修复无关**，是预先存在的设计缺陷。本次修复不改变也不恶化这些问题——修复后 userId 仍然从请求参数获取，行为不变。未来如需修复，应将 userId 从已验证的 JWT payload 中提取（需要独立设计）。

## 数据流（修复后 — 覆盖类型 A + 类型 B + WebSocket）

```
┌─────────────────────── weknora-ui ───────────────────────────────────┐
│                                                                      │
│  useAgentStudioAuth.ts — JWT Token 管理器（内存 Map）                │
│    getToken(serverUrl, adminPassword) → 缓存/login → AgentStudio JWT│
│                                                                      │
│  ┌── 类型 A：AgentStudio 管理 API（api/a2a/index.ts）──────────┐    │
│  │  fetchA2AProjects, fetchActiveSessions 等 7 个函数            │    │
│  │  手动 fetch() + getToken() → Bearer ${AS JWT}                │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌── 类型 B：WeKnora 用户体系 API ─────────────────────────────┐    │
│  │  api/share/*.ts (18), api/agentstudio/tag.ts (6),            │    │
│  │  api/users (2) — 共 26 个函数                                │    │
│  │  agentStudioRequest axios 实例 + getToken() → Bearer ${AS JWT}│   │
│  │  userId 仍从 query/body param 传入（不变）                   │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌── WebSocket ─────────────────────────────────────────────────┐    │
│  │  connectOne() + getToken() → ws://host/ws?token=${AS JWT}    │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌── A2A 聊天（不变）────────────────────────────────────────┐     │
│  │  agt_proj_* key → POST /a2a/:agentId/messages → a2aAuth     │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
          │              │              │              │
          │ AS JWT       │ AS JWT       │ AS JWT       │ agt_proj_*
          ▼              ▼              ▼              ▼
   ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
   │ authMW     │ │ authMW     │ │ WS auth    │ │ a2aAuth    │
   │ (类型A)    │ │ (类型B)    │ │ verifyToken│ │ bcrypt     │
   │ ✅ verify  │ │ ✅ verify  │ │ ✅ verify  │ │ ✅ 不变    │
   └────────────┘ └────────────┘ └────────────┘ └────────────┘
```

## 实现步骤（按执行顺序）

### Step 1：新建 JWT 管理器（核心枢纽）

**新建** `weknora-ui/src/composables/useAgentStudioAuth.ts`

整个改造的基础设施，所有后续步骤都依赖它。

```typescript
const tokenMap = new Map<string, { token: string; expiresAt: number }>()
// key = serverUrl，每个 AgentStudio 服务器独立 login，独立缓存 JWT
// 内存存储，不持久化。页面刷新后下次 API 调用时自动 re-login。

async function getToken(serverUrl: string, adminPassword: string): Promise<string> {
  const cached = tokenMap.get(serverUrl)
  const now = Math.floor(Date.now() / 1000)

  // ① 缓存有效（提前 60s 刷新避免边界过期）→ 直接返回
  if (cached && cached.expiresAt > now + 60) {
    return cached.token
  }

  // ② 缓存过期/不存在 → POST /api/auth/login 获取新 JWT
  const resp = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPassword }),
  })
  if (!resp.ok) {
    throw new Error(`AgentStudio login failed: ${resp.status}`)
  }
  const data = await resp.json()
  const token = data.token as string

  // ③ 解码 JWT payload 获取过期时间（仅读取，不验签）
  const payloadB64 = token.split('.')[1]
  const payload = JSON.parse(atob(payloadB64))
  const expiresAt = payload.expiresAt || payload.exp || (now + 7 * 24 * 3600)

  tokenMap.set(serverUrl, { token, expiresAt })
  return token
}

function clearToken(serverUrl: string): void { tokenMap.delete(serverUrl) }
function clearAll(): void { tokenMap.clear() }

export function useAgentStudioAuth() {
  return { getToken, clearToken, clearAll }
}
```

参考 AgentStudio 前端 `stores/authStore.ts` 的 `TokensMap` 模式和 `utils/authHelpers.ts` 的 `parseJWT`。

### Step 2：类型 A 管理 API 改造

**修改** `weknora-ui/src/api/a2a/index.ts`

**A1 子类（4 个活跃函数 + 1 内部调用）** — 已有 `serverUrl` + `apiKey`（ADMIN_PW），直接用 `getToken`：

```typescript
// 改造前
const resp = await fetch(`${serverUrl}/api/projects`, {
  headers: { 'Authorization': `Bearer ${apiKey}` },  // ← ADMIN_PASSWORD 明文
})

// 改造后
import { useAgentStudioAuth } from '@/composables/useAgentStudioAuth'
const { getToken, clearToken } = useAgentStudioAuth()

const jwt = await getToken(serverUrl, apiKey)           // ← 获取 AgentStudio JWT
const resp = await fetch(`${serverUrl}/api/projects`, {
  headers: { 'Authorization': `Bearer ${jwt}` },        // ← JWT
})
// 401 自动重试：clearToken → 重新 getToken → 重试一次
```

受影响函数：`fetchA2AProjects`, `fetchA2AMapping`, `fetchA2AApiKeys`（`testA2AConnection` 内部调 `fetchA2AProjects`，自动受益）

**A2 子类 — `getA2AHistory`**：当前接收 `A2AConfig`（含 `agt_proj_*`），函数内部没有 ADMIN_PASSWORD。

改造方案：函数内部通过 `config.serverUrl` 从 `loadServers()` 查找对应服务器的 ADMIN_PASSWORD，然后调 `getToken()`：

```typescript
// 改造后
import { loadServers } from '@/api/a2a/serverStorage'

export async function getA2AHistory(config: A2AConfig, projectPath: string, sessionId: string) {
  const server = loadServers().find(s => s.serverUrl === config.serverUrl)
  const jwt = server
    ? await getToken(config.serverUrl, server.apiKey)   // ← 从 serverStorage 取 ADMIN_PW
    : config.apiKey                                       // ← fallback：无法找到服务器时保持原行为
  // ... headers: { 'Authorization': `Bearer ${jwt}` }
}
```

> 函数签名不变，调用方无需修改。

**A3 子类 — `fetchActiveSessions` 双调用方**：

- `menu.vue:671` 已传 `server.apiKey`（ADMIN_PW）→ 与 A1 相同的改造
- `ActiveSessionsPanel.vue:68` 传 `selectedProject.projectApiKey`（`agt_proj_*`）→ **需修改调用方**：改为传 `serverApiKey`（ADMIN_PW）

`ActiveSessionsPanel` 改造：
```typescript
// SelectedProject 接口需新增 serverApiKey 字段
interface SelectedProject {
  ...
  serverApiKey: string   // ← 新增，从 ProjectOption.serverApiKey 传入
  projectApiKey: string
}

// index.vue 改造前
<ActiveSessionsPanel :api-key="selectedProject.projectApiKey" />

// index.vue 改造后
<ActiveSessionsPanel :api-key="selectedProject.serverApiKey" />
```

> `ProjectOption` 已有 `serverApiKey`（赋值为 `server.apiKey`），但 `SelectedProject` 没有。需在 `SelectedProject` 接口中新增此字段，并在 `autoSelectFirstProject` 和 `restoreSession` 等构造 `SelectedProject` 的位置传入。

**死代码函数（仍需改造，保持一致性）**：

`fetchProjectA2AConfig`、`closeActiveSession` 当前无调用方，但函数签名已有 `(serverUrl, apiKey)`，改造方式与 A1 相同。

参考 AgentStudio 前端 `utils/authFetch.ts` 的 401 重试模式。

### Step 3：WebSocket 改造

**修改** `weknora-ui/src/composables/useAgentStudioWS.ts`

```typescript
// 改造前（sync）
function connectOne(conn: WSConnection) {
  const wsUrl = conn.serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(conn.apiKey)
  //                                                                          ↑ ADMIN_PASSWORD

// 改造后（async）
async function connectOne(conn: WSConnection) {
  const jwt = await getToken(conn.serverUrl, conn.apiKey)
  const wsUrl = conn.serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(jwt)
  //                                                                          ↑ AgentStudio JWT
```

调用方 `connectAll`、`addConnection`、`scheduleReconnect` 加 `.catch()`（fire-and-forget）：
```typescript
connectOne(conn).catch(() => { /* getToken 失败，scheduleReconnect 会处理 */ })
```

> **注意**：`scheduleReconnect` 中的 `setTimeout` 回调也调用 `connectOne`，必须加 `.catch()` 防止 `getToken` 拒绝时产生 unhandled rejection。

### Step 4：类型 B 分享/标签/用户 API 改造（26 个函数）

**新建** `weknora-ui/src/utils/agentStudioRequest.ts` — AgentStudio 专用 axios 实例

```typescript
import axios from 'axios'
import { useAgentStudioAuth } from '@/composables/useAgentStudioAuth'
import { getDefaultServer } from '@/api/a2a/serverStorage'

const { getToken } = useAgentStudioAuth()

const agentStudioRequest = axios.create({ timeout: 30000 })

// 拦截器：用 AgentStudio JWT 替代 weknora_token
agentStudioRequest.interceptors.request.use(async (config) => {
  const server = getDefaultServer()  // ← 取第一个配置的服务器
  if (server) {
    const jwt = await getToken(server.serverUrl, server.apiKey)
    config.headers['Authorization'] = `Bearer ${jwt}`
  }
  return config
})

// 封装 HTTP 方法（与 utils/request.ts 保持一致的 API）
export const get = (url, params?, config?) => agentStudioRequest.get(url, { params, ...config })
export const post = (url, data?, config?) => agentStudioRequest.post(url, data, config)
export const put = (url, data?, config?) => agentStudioRequest.put(url, data, config)
export const del = (url, config?) => agentStudioRequest.delete(url, config)
// blob 下载（api/share/index.ts 的 downloadSharedDocBlob 等需要）
export const getDown = (url, params?) => agentStudioRequest.get(url, { params, responseType: 'blob' })
```

**修改 3 个文件**（只换 import，函数签名和业务逻辑零改动）：

| 文件 | 改动 | 函数数 |
|------|------|--------|
| `api/share/index.ts` | `import { get, post, put, del, getDown } from '@/utils/agentStudioRequest'` | 18 share + 2 users |
| `api/agentstudio/tag.ts` | 同上 | 6 |
| `api/a2a/serverStorage.ts` | 新增 `getDefaultServer()` — 返回 `loadServers()[0]` | — |

> **`utils/request.ts` 不改动**。它继续为 WeKnora `/api/v1/*` 路由服务，附带 `weknora_token`。
>
> **`/api/share/link/*` 函数（10 个）不需要改** — 不走 authMiddleware，用 cookie 认证。

### Step 5：后端修复（2 个文件）

**5a. 修改** `agentstudio/backend/src/middleware/auth.ts` — 修复 await

```typescript
// 改造前（bug）
export function authMiddleware(req, res, next): void {
  const payload = verifyToken(token);  // 没有 await → Promise(truthy) → 永远放行
  if (!payload) { ... }
  next();
}

// 改造后
export function authMiddleware(req, res, next): void {
  if (process.env.NO_AUTH === 'true') { next(); return; }

  const authHeader = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  let token: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (queryToken) {
    token = queryToken;  // 保留 query param 支持（SSE 需要）
  }

  if (!token) { res.status(401).json({ error: 'No token provided' }); return; }

  // Express 4 不原生支持 async middleware，用 IIFE + .catch(next) 防止未捕获 rejection
  (async () => {
    const payload = await verifyToken(token!);
    if (!payload) { res.status(401).json({ error: 'Invalid or expired token' }); return; }
    next();
  })().catch(next);
}
```

注意：`NO_AUTH` 检查在当前代码中已存在，实现时保留即可。

**5b. 修改** `agentstudio/backend/src/services/websocketService.ts` — JWT 验证

```typescript
// 改造前
function authenticateToken(token: string): boolean {
  return typeof token === 'string' && token.length > 0;  // 接受任何非空
}

// 改造后
import { verifyToken } from '../utils/jwt.js';

async function authenticateToken(token: string): Promise<boolean> {
  if (process.env.NO_AUTH === 'true') return true;
  if (typeof token !== 'string' || token.length === 0) return false;
  const payload = await verifyToken(token);
  return payload !== null;
}
```

upgrade handler 对应改为 async + try/catch：
```typescript
server.on('upgrade', async (request, socket, head) => {
  try {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const token = url.searchParams.get('token');
    if (!token || !(await authenticateToken(token))) { socket.destroy(); return; }
    wss!.handleUpgrade(request, socket, head, (ws) => { ... });
  } catch {
    socket.destroy();
  }
});
```

## 边界情况

### 页面刷新
tokenMap 清空 → 下次管理 API 调用时自动 re-login → 无感知

### 服务器密码变更
旧 JWT 验证失败 → 401 → clearToken → 用新密码（已更新到 localStorage）re-login

### 未配置密码的 AgentStudio
`/api/auth/login` 在无密码模式下不需要 password 参数，直接返回 JWT → 兼容

### WebSocket 重连
reconnect 时 `connectOne` 会重新 `getToken` → 如果 JWT 过期会自动 re-login

### 多服务器并发 login
`getToken` 中没有加锁，多个并发调用可能对同一服务器 login 多次。结果是多获取了几个 JWT，功能不受影响，只是多了几次 HTTP 请求。未来可优化：对每个 serverUrl 加 Promise 锁（同一 serverUrl 的并发 `getToken` 共享同一个 login Promise），当前版本不必要。如果后端 `/api/auth/login` 加了限流，此优化变为必要。

## 部署顺序

**必须前端先、后端后**:

1. **先部署 weknora-ui** — 新前端会调 `/api/auth/login` 获取 JWT，用 JWT 调管理 API。旧后端的 authMiddleware 仍然是 bug 状态（接受任何 token），JWT 作为"任何 token"之一可以通过 → 向前兼容
2. **再部署 agentstudio 后端** — 新后端严格验证 JWT。新前端已经在发 JWT → 正常工作

**反过来会出问题**: 如果先部署后端（严格 JWT 验证），而前端还在发 ADMIN_PASSWORD → 所有管理 API 返回 401。

## 多服务器场景下的 JWT 管理

weknora-ui 支持配置多个 AgentStudio 后端服务器。每个服务器独立认证，获取各自的 JWT。

### tokenMap 结构

```typescript
// useAgentStudioAuth.ts — 内存存储
const tokenMap = new Map<string, { token: string; expiresAt: number }>()
// key = serverUrl（与 A2AServerConfig.serverUrl 一致）
// 每个服务器独立 login，独立缓存 JWT
```

### 各场景的 JWT 使用规则

#### 1. WebSocket 连接 — 每个服务器一个连接，各用自己的 JWT

```
weknora_a2a_servers: [Server A, Server B, Server C]

connectAll(loadServers()):
  Server A → getToken(A.url, A.apiKey) → JWT_A → ws://A/ws?token=JWT_A
  Server B → getToken(B.url, B.apiKey) → JWT_B → ws://B/ws?token=JWT_B
  Server C → getToken(C.url, C.apiKey) → JWT_C → ws://C/ws?token=JWT_C
```

有多少个 AgentStudio 服务器，就建立多少个 WebSocket 连接。每个连接使用该服务器自己的 JWT。这是现有 `useAgentStudioWS.ts` 多连接模型的自然延伸，只是把 `conn.apiKey`（ADMIN_PASSWORD）换成 JWT。

#### 2. Session 推送 — 多服务器汇聚

Session 信息由每个 AgentStudio 服务器通过各自的 WebSocket 连接推送。前端汇聚所有服务器的 session：

```
Server A → WS_A → session:update → sessions_A (注入 _serverUrl=A)
Server B → WS_B → session:update → sessions_B (注入 _serverUrl=B)
Server C → WS_C → session:update → sessions_C (注入 _serverUrl=C)

menu.vue sessionsByServer Map:
  A → sessions_A
  B → sessions_B
  C → sessions_C
→ 合并显示所有 session
```

这是已实现的 `sessionsByServer` Map 模式（Phase 2 多连接重构），不需要额外改动。

#### 3. Workspace 订阅 — 跟随当前对话的服务器

Workspace 文件变更只订阅**当前对话所在项目对应的服务器**，不是所有服务器：

```
用户选择项目 → 项目来自 Server B → subscribe('workspace', { agentId }, B.url)
```

`subscribe` 的第三个参数 `serverUrl` 指定只发送到对应的 WebSocket 连接。切换对话/项目时，自动取消旧订阅并建立新订阅。这也是已实现的逻辑（`a2a-chat/index.vue` 中 `wsSub('workspace', ..., config.serverUrl)`）。

#### 4. 类型 A 管理 API — 按目标服务器使用对应 JWT

```typescript
// 获取 Server B 的项目列表
const jwt = await getToken(serverB.url, serverB.apiKey)
fetchA2AProjects(serverB.url, serverB.apiKey) // 内部用 jwt
```

每个管理 API 调用都明确指定目标服务器，使用该服务器的 JWT。这是现有模式的自然延伸。

#### 5. 类型 B 分享/标签/用户 API — 固定使用第一个服务器的 JWT

类型 B 路由（`/api/share/*`、`/api/kb/*`、`/api/users/*`）的特点：
- 通过 Vite proxy / Nginx 代理到**一个** AgentStudio 后端
- 所有服务器共享同一个 WeKnora 数据库（分享、标签、用户数据相同）
- 不需要区分来自哪个服务器

因此，类型 B 固定使用**第一个（默认）服务器**的 JWT：

```typescript
// agentStudioRequest.ts 拦截器
function getDefaultServer(): A2AServerConfig | null {
  const servers = loadServers()
  return servers.length > 0 ? servers[0] : null
}

// 拦截器中：
const server = getDefaultServer()
const jwt = await getToken(server.serverUrl, server.apiKey)
config.headers['Authorization'] = `Bearer ${jwt}`
```

### JWT 管理总结

| 场景 | JWT 来源 | 说明 |
|------|---------|------|
| WebSocket 连接 | 每个服务器各自的 JWT | N 个服务器 = N 个连接 = N 个 JWT |
| Session 推送 | N/A（服务器推送） | 汇聚到 sessionsByServer Map |
| Workspace 订阅 | 当前对话服务器的 JWT | subscribe 指定 serverUrl |
| 类型 A 管理 API | 目标服务器的 JWT | 调用时明确指定 serverUrl |
| 类型 B 分享/标签/用户 | 第一个服务器的 JWT | getDefaultServer() 固定取 servers[0] |

- `/api/auth/login` 以明文传输 ADMIN_PASSWORD（`password !== config.adminPassword` 直接比较）
- 生产环境中 weknora-ui → AgentStudio 的调用必须经过 HTTPS 或本地代理（Nginx/Vite proxy），确保密码不被窃听
- 开发环境中 Vite proxy 为同源调用，无安全风险

## AgentStudio 前端认证参考

AgentStudio 自己的 React 前端已有完整的认证实现，weknora-ui 应参考其模式。

### AgentStudio 前端 vs weknora-ui 认证对比

| 维度 | AgentStudio 前端（正确实现） | weknora-ui（当前状态） |
|------|---------------------------|----------------------|
| **登录** | 调用 `/api/auth/login` 获取 JWT | 从未调用，直接拿 ADMIN_PASSWORD 当 token |
| **Token 存储** | `TokensMap`（Record<serviceId, TokenData>）| `weknora_a2a_servers` 存 ADMIN_PASSWORD |
| **请求认证** | `authFetch` 自动带 JWT | 手动 `fetch` 带 ADMIN_PASSWORD |
| **Token 刷新** | 双层：5 分钟定时 + 请求时后台刷新 | 无 |
| **401 处理** | 自动刷新 token + 重试 1 次 | 无 |
| **多服务器** | `BackendService[]` + `currentServiceId` | `A2AServerConfig[]` + 类似结构 |
| **HTTP 库** | 原生 fetch + authFetch 封装 | axios（WeKnora API）/ fetch（A2A API） |

### 可参考的核心文件

| AgentStudio 前端文件 | 职责 | weknora-ui 对应 |
|---------------------|------|----------------|
| `stores/authStore.ts` | TokensMap + getToken/setToken | → `useAgentStudioAuth.ts` 的 tokenMap |
| `utils/authFetch.ts` | 带认证的 fetch + 自动刷新 + 401 重试 | → `agentStudioRequest.ts` 的 axios 拦截器 |
| `hooks/useAuth.ts` | login/logout/verifyToken/refreshToken | → `useAgentStudioAuth.ts` 的 getToken |
| `utils/authHelpers.ts` | parseJWT/isTokenExpired/shouldRefresh | → `useAgentStudioAuth.ts` 的过期检查 |
| `utils/backendServiceStorage.ts` | 多服务器存储 + getCurrentService | → `serverStorage.ts` 已有类似结构 |

### 关键参考模式

**1. TokenData 结构**（`authStore.ts`）

```typescript
// AgentStudio 前端的 Token 存储结构
interface TokenData {
  token: string;          // JWT token 字符串
  serviceId: string;      // 所属服务器 ID
  serviceName: string;    // 服务器名称
  serviceUrl: string;     // 服务器 URL
  timestamp: number;      // Token 创建时间戳
}
type TokensMap = Record<string, TokenData>;
```

weknora-ui 的 `useAgentStudioAuth.ts` 设计中的 `tokenMap: Map<serverUrl, { token, expiresAt }>` 是简化版本，足够使用。

**2. authFetch 401 自动重试**（`authFetch.ts`）

```typescript
// AgentStudio 前端的请求流程
while (attempt <= maxRetries) {
  const response = await makeAuthRequest(url, fetchOptions, skipAuth);
  if (response.status === 401 && attempt < maxRetries && !skipAuth) {
    const refreshed = await attemptTokenRefresh();
    if (refreshed) { attempt++; continue; }  // 用新 token 重试
  }
  return response;
}
```

weknora-ui 的设计文档已包含类似的 401 重试逻辑（Section 4 的 `clearToken + 重新 login + 重试一次`）。

**3. 多服务器 Token 获取**（`authFetch.ts:makeAuthRequest`）

```typescript
// AgentStudio 前端按 serviceId 获取 token
const currentServiceId = getCurrentServiceId();
const token = currentServiceId ? getToken(currentServiceId) : null;
const actualToken = extractToken(token);
headers.set('Authorization', `Bearer ${actualToken}`);
```

weknora-ui 的类型 A 路由用 `getToken(serverUrl, adminPassword)` 实现类似逻辑。类型 B 路由通过 `getDefaultServer()` 确定目标服务器。

**4. JWT 过期检查**（`authHelpers.ts`）

```typescript
// AgentStudio 前端的 JWT 解析
function parseJWT(token: string): { exp?: number } | null {
  const base64Url = token.split('.')[1];
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(window.atob(base64));
}
```

weknora-ui 的设计文档已包含相同的 `atob(token.split('.')[1])` 模式。

## 改动文件清单

| # | 项目 | 文件 | 类型 | 改动 |
|---|------|------|------|------|
| 1 | weknora-ui | `composables/useAgentStudioAuth.ts` | **新建** | JWT 管理器（~50 行） |
| 2 | weknora-ui | `api/a2a/index.ts` | 改 | A1: 4 函数加 getToken + 401 重试；A2: getA2AHistory 内部查 serverStorage 获取 ADMIN_PW；A3: fetchActiveSessions 同 A1 |
| 3 | weknora-ui | `composables/useAgentStudioWS.ts` | 改 | connectOne 改 async + 用 JWT |
| 4 | weknora-ui | `utils/agentStudioRequest.ts` | **新建** | AS 专用 axios + JWT 拦截器 + getDown blob 支持（~40 行） |
| 5 | weknora-ui | `api/share/index.ts` | 改 | 20 个函数换 import（1 行） |
| 6 | weknora-ui | `api/agentstudio/tag.ts` | 改 | 6 个函数换 import（1 行） |
| 7 | weknora-ui | `api/a2a/serverStorage.ts` | 改 | 新增 getDefaultServer（5 行） |
| 8 | weknora-ui | `views/a2a-chat/index.vue` | 改 | SelectedProject 接口加 serverApiKey；ActiveSessionsPanel 绑定改为 serverApiKey；restoreSession 等构造处传入 |
| 9 | agentstudio | `middleware/auth.ts` | 改 | async IIFE + await verifyToken |
| 10 | agentstudio | `services/websocketService.ts` | 改 | authenticateToken 改用 verifyToken |

**后端 0 行为变化（只是让验证真正生效），前端换 token 来源。**

### 不改动的文件

| 文件 | 原因 |
|------|------|
| `utils/request.ts` | 继续为 WeKnora `/api/v1/*` 路由服务，附带 weknora_token |
| `middleware/a2aAuth.ts` | bcrypt 验证 agt_proj_* key，工作正常 |
| `api/a2a/stream.ts` | SSE 用 agt_proj_* key，走 a2aAuth |
| `routes/share.ts`, `kb.ts`, `users.ts` | 后端路由不改，userId 继续从 query/body 获取 |
| `routes/auth.ts`, `utils/jwt.ts` | login 和 JWT 工具函数工作正常 |

## 不受影响的路由

以下路由不走 authMiddleware，本次修复不涉及：

| 路由组 | 认证方式 | 原因 |
|--------|---------|------|
| `/a2a/:agentId/*` (3 路由) | `a2aAuth` (bcrypt) | 独立认证，工作正常 |
| `/api/share/link/*` (10 路由) | cookie (HMAC-SHA256) | 不走 authMiddleware |
| `/api/auth/login` | 公开路由 | 不需要认证 |

**Vite 代理关键规则**：AgentStudio 路由在 `vite.config.ts` 中必须在 `/api` 通配之前声明，否则会被代理到 WeKnora 而非 AgentStudio：
```javascript
// 必须在 '/api' 之前声明
'/api/share': { target: 'http://localhost:4936' },
'/api/kb':    { target: 'http://localhost:4936' },
'/api/users/search': { target: 'http://localhost:4936' },
'/api/users/tenant': { target: 'http://localhost:4936' },
// 通配在最后
'/api': { target: 'http://192.168.100.30:8080' },
```
