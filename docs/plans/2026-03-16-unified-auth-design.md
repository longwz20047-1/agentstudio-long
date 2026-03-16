# AgentStudio 统一认证链修复设计

## 背景

### 问题来源

WebSocket 多连接重构（Phase 2）后，`connectAll(loadServers())` 使用 `A2AServerConfig.apiKey`（即 ADMIN_PASSWORD）连接 WebSocket，但 `websocketService.ts` 的 `authenticateToken()` 要求 token 以 `agt_` 开头（Project API Key 格式）。导致所有 WebSocket 连接失败，浏览器控制台持续报错。

临时修复：将 `authenticateToken()` 改为接受任何非空 token（与 authMiddleware 当前实际行为一致）。

追溯根因后发现 **authMiddleware 本身存在 await bug**，整个认证链需要系统性修复。

### 根因：authMiddleware 的 await bug

`verifyToken` 是 async 函数（返回 `Promise<JWTPayload | null>`），但 `authMiddleware` 调用时没有 await：

```typescript
// middleware/auth.ts:35 — 当前代码
const payload = verifyToken(token);  // 没有 await → payload 是 Promise（truthy）
if (!payload) { ... }                // 永远不会执行 → 任何 token 都放行
```

这意味着 AgentStudio 后端 29 个受 `authMiddleware` 保护的路由组，**实际上没有做任何认证**。系统之所以能正常工作，完全依赖这个 bug。

### 发现的三层问题

1. **authMiddleware 未 await verifyToken** — 29 个路由组的 JWT 验证形同虚设
2. **weknora-ui 从未调用 /api/auth/login** — 直接把 ADMIN_PASSWORD 或 WeKnora JWT 当 Bearer Token 发送，依赖 bug 工作
3. **WebSocket 认证不一致** — 原来要求 `agt_` 前缀（已临时改为接受任何非空 token）

## authMiddleware 保护的两类调用者

**这是本设计最关键的发现**：authMiddleware 保护的 29 个路由组背后，有**两类完全不同的调用者**，使用不同的 token：

### 类型 A：AgentStudio 管理 API（前端 A2A 模块调用）

来源：`weknora-ui/src/api/a2a/index.ts` 中的函数，使用独立的 `fetch()` 调用，手动设置 header。

| 前端函数 | 路由 | Token 来源 | Token 值 |
|---------|------|-----------|----------|
| `fetchA2AProjects` | `GET /api/projects` | `A2AServerConfig.apiKey` | ADMIN_PASSWORD 明文 |
| `fetchProjectA2AConfig` | `GET /api/projects/:path/a2a-config` | 同上 | ADMIN_PASSWORD 明文 |
| `fetchA2AMapping` | `GET /api/a2a/mapping/:path` | 同上 | ADMIN_PASSWORD 明文 |
| `fetchA2AApiKeys` | `GET /api/a2a/api-keys/:path` | 同上 | ADMIN_PASSWORD 明文 |
| `fetchActiveSessions` | `GET /api/agents/sessions` | 同上 | ADMIN_PASSWORD 明文 |
| `closeActiveSession` | `DELETE /api/agents/sessions/:id` | 同上 | ADMIN_PASSWORD 明文 |
| `getA2AHistory` | `GET /api/a2a/history/:path/:id` | `A2AConfig.apiKey` | `agt_proj_*` (Project Key) |

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
| WebSocket `/ws` | 自定义 `authenticateToken` | 见下文 |

## 影响范围分析

如果直接修复 authMiddleware 的 await bug（让 `verifyToken` 真正验证 JWT 签名）：

### 会 401 的路由（类型 A — ADMIN_PASSWORD）

前端发送 ADMIN_PASSWORD 明文作为 Bearer Token → `jwt.verify(ADMIN_PASSWORD, agentStudioSecret)` → 签名不匹配 → **401**

影响函数：`fetchA2AProjects`, `fetchProjectA2AConfig`, `fetchA2AMapping`, `fetchA2AApiKeys`, `fetchActiveSessions`, `closeActiveSession`

### 会 401 的路由（类型 A — agt_proj_*）

前端发送 Project API Key 作为 Bearer Token → 不是 JWT 格式 → **401**

影响函数：`getA2AHistory`

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
| authMiddleware (29 路由组) | 接受任何 token（bug） | 验证 JWT 签名和过期 |
| WebSocket | 接受任何非空 token（临时修复） | 验证 JWT 签名和过期 |
| a2aAuth (3 路由) | bcrypt 验证 agt_proj_* | 不变 |

### 类型 B 路由的处理方案（待定）

`/api/share/*`、`/api/kb/*`、`/api/users/*` 这些路由发送的是 WeKnora JWT（不同 secret），修复 authMiddleware 后会 401。可选方案：

1. **authMiddleware 双密钥验证** — 同时尝试 AgentStudio secret 和 WeKnora secret（需配置 `WEKNORA_JWT_SECRET` 环境变量）
2. **拆分中间件** — 这些路由改用独立的 `weknoraAuth` 中间件验证 WeKnora JWT
3. **前端改造** — 这些路由也改为先用 ADMIN_PASSWORD 获取 AgentStudio JWT（但会丢失 WeKnora userId）
4. **暂不修复这些路由** — 先只修复类型 A + WebSocket，类型 B 路由暂保持现状

**当前设计仅覆盖类型 A 路由和 WebSocket 的修复。类型 B 路由的方案需要单独设计。**

## 数据流（修复后 — 仅覆盖类型 A + WebSocket）

```
┌─────────────────────── weknora-ui ───────────────────────────────────┐
│                                                                      │
│  ┌── 类型 A：AgentStudio 管理 API（api/a2a/index.ts）──────────┐    │
│  │                                                              │    │
│  │  管理 API 调用时:                                            │    │
│  │    ① getToken(serverUrl, adminPassword)                      │    │
│  │       → 缓存命中? 返回缓存 AgentStudio JWT                  │    │
│  │       → 缓存未命中/过期? POST /api/auth/login                │    │
│  │         → 获取 AgentStudio JWT, 存内存 Map                   │    │
│  │    ② 用 AgentStudio JWT 调用 /api/projects 等               │    │
│  │    ③ 收到 401? clearToken + 重新 login + 重试一次           │    │
│  │                                                              │    │
│  │  WebSocket 连接时:                                           │    │
│  │    ① getToken(serverUrl, adminPassword) → 获取 JWT          │    │
│  │    ② ws://host/ws?token=${AgentStudio JWT}                  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌── 类型 B：WeKnora 用户体系 API（utils/request.ts axios）──┐     │
│  │                                                              │    │
│  │  分享/标签/用户 API:                                         │    │
│  │    axios 拦截器自动带 weknora_token (WeKnora JWT)            │    │
│  │    → /api/share/*, /api/kb/*, /api/users/*                   │    │
│  │    ⚠ 方案待定：WeKnora JWT 无法通过 AgentStudio 验证       │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌── A2A 聊天（不变）────────────────────────────────────────┐     │
│  │  ① 用 agt_proj_* key → POST /a2a/:agentId/messages         │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
          │                    │              │              │
          │ AS JWT             │ AS JWT       │ WK JWT       │ agt_proj_*
          ▼                    ▼              ▼              ▼
┌──────────────┐  ┌────────────────┐  ┌────────────┐  ┌────────────┐
│ authMiddleware│  │ WebSocket auth │  │ authMW     │  │ a2aAuth    │
│ (类型A路由)  │  │ verifyToken    │  │ (类型B路由)│  │ bcrypt     │
│ ✅ AS JWT    │  │ ✅ AS JWT      │  │ ⚠ 待定    │  │ ✅ 不变    │
└──────────────┘  └────────────────┘  └────────────┘  └────────────┘
```

## 改动详情

### 1. 后端: `middleware/auth.ts` — 修复 await

**当前代码 (bug)**:
```typescript
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // ...
  const payload = verifyToken(token);  // 没有 await，返回 Promise (truthy)
  if (!payload) { ... }                // 永远不会执行
  next();
}
```

**修复后**:
```typescript
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NO_AUTH === 'true') { next(); return; }

  const authHeader = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  let token: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (queryToken) {
    token = queryToken;
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

变化: 保持同步函数签名（Express 4 兼容），内部用 async IIFE + `.catch(next)` 包裹 await 调用。保留 query parameter 支持（SSE 需要）。注意：`NO_AUTH` 检查在当前代码中已存在，实现时保留即可。

### 2. 后端: `services/websocketService.ts` — JWT 验证

**当前代码**:
```typescript
function authenticateToken(token: string): boolean {
  return typeof token === 'string' && token.length > 0;
}
```

**修复后**:
```typescript
import { verifyToken } from '../utils/jwt.js';

async function authenticateToken(token: string): Promise<boolean> {
  if (typeof token !== 'string' || token.length === 0) return false;
  const payload = await verifyToken(token);
  return payload !== null;
}
```

upgrade handler 对应改为 async（保持 try/catch 防止未处理 rejection）:
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

WebSocket 也应尊重 `NO_AUTH` 模式:
```typescript
async function authenticateToken(token: string): Promise<boolean> {
  if (process.env.NO_AUTH === 'true') return true;
  if (typeof token !== 'string' || token.length === 0) return false;
  const payload = await verifyToken(token);
  return payload !== null;
}
```

### 3. 前端: 新建 `composables/useAgentStudioAuth.ts` — JWT Token 管理器

```typescript
const tokenMap = new Map<string, { token: string; expiresAt: number }>()

/**
 * 获取指定服务器的 JWT token（懒加载 + 缓存）
 * @param serverUrl AgentStudio 服务器地址
 * @param adminPassword ADMIN_PASSWORD（来自 weknora_a2a_servers）
 */
async function getToken(serverUrl: string, adminPassword: string): Promise<string> {
  const cached = tokenMap.get(serverUrl)
  const now = Math.floor(Date.now() / 1000)

  // 缓存有效（提前 60s 刷新避免边界过期）
  if (cached && cached.expiresAt > now + 60) {
    return cached.token
  }

  // 调用 /api/auth/login 获取新 JWT
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

  // 解码 JWT payload 获取过期时间（仅读取，不验签）
  const payloadB64 = token.split('.')[1]
  const payload = JSON.parse(atob(payloadB64))
  const expiresAt = payload.expiresAt || payload.exp || (now + 7 * 24 * 3600)

  tokenMap.set(serverUrl, { token, expiresAt })
  return token
}

function clearToken(serverUrl: string): void {
  tokenMap.delete(serverUrl)
}

function clearAll(): void {
  tokenMap.clear()
}

export function useAgentStudioAuth() {
  return { getToken, clearToken, clearAll }
}
```

### 4. 前端: `api/a2a/index.ts` — 管理 API 改用 JWT

6 个函数统一改造模式:

```typescript
import { useAgentStudioAuth } from '@/composables/useAgentStudioAuth'
const { getToken, clearToken } = useAgentStudioAuth()

export async function fetchA2AProjects(serverUrl: string, apiKey: string) {
  const jwt = await getToken(serverUrl, apiKey)
  const resp = await fetch(`${serverUrl}/api/projects`, {
    headers: { 'Authorization': `Bearer ${jwt}` },
  })

  // 401 自动重试一次
  if (resp.status === 401) {
    clearToken(serverUrl)
    const newJwt = await getToken(serverUrl, apiKey)
    const retry = await fetch(`${serverUrl}/api/projects`, {
      headers: { 'Authorization': `Bearer ${newJwt}` },
    })
    if (!retry.ok) throw new Error(`${retry.status}`)
    return retry.json()
  }

  if (!resp.ok) throw new Error(`${resp.status}`)
  return resp.json()
}
```

受影响函数: `fetchA2AProjects`, `fetchProjectA2AConfig`, `fetchA2AMapping`, `fetchA2AApiKeys`, `fetchActiveSessions`, `closeActiveSession`, `getA2AHistory`

> **注意**: `getA2AHistory` 当前用 `config.apiKey`（agt_proj_*）调用 `/api/a2a/history/...`，该路由挂载在 `a2aManagementRouter` 下，受 `authMiddleware` 保护。修复后 agt_proj_* token 无法通过 JWT 验证，因此必须改用 JWT。
>
> **签名变更**: `getA2AHistory` 当前接收 `A2AConfig`（其 `apiKey` 是 `agt_proj_*`），需要改为额外接收 `serverUrl` + `adminPassword`（或直接接收 `A2AServerConfig`），以便内部调用 `getToken()` 获取 JWT。调用方 (`a2a-chat/index.vue`) 需从 `loadServers()` 或当前选中服务器的配置中取得 ADMIN_PASSWORD。
>
> `testA2AConnection` 内部调用 `fetchA2AProjects`，无需单独修改。

### 5. 前端: `composables/useAgentStudioWS.ts` — WebSocket 用 JWT

`connectOne` 改为 async:

```typescript
import { useAgentStudioAuth } from '@/composables/useAgentStudioAuth'
const { getToken } = useAgentStudioAuth()

async function connectOne(conn: WSConnection) {
  if (conn.ws?.readyState === WebSocket.OPEN) return
  // ... cleanup ...

  const jwt = await getToken(conn.serverUrl, conn.apiKey)
  const wsUrl = conn.serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(jwt)
  const socket = new WebSocket(wsUrl)
  // ... 其余 onopen/onclose/onmessage 不变 ...
}
```

调用方 `connectAll`、`addConnection` 中的 `connectOne(conn)` 无需 await（fire-and-forget，连接结果通过 onopen/onclose 回调处理），但需加 `.catch()` 防止未处理 rejection:
```typescript
connectOne(conn).catch(() => { /* getToken 失败，scheduleReconnect 会处理 */ })
```

## 不改动的文件

| 文件 | 原因 |
|------|------|
| `middleware/a2aAuth.ts` | bcrypt 验证 agt_proj_* key，工作正常 |
| `api/a2a/stream.ts` | SSE 用 agt_proj_* key，走 a2aAuth |
| `stores/a2aConfig.ts` | 项目级 apiKey 不变 |
| `api/a2a/serverStorage.ts` | 服务器级 ADMIN_PASSWORD 存储不变 |
| `routes/auth.ts` | login 端点工作正常 |
| `utils/jwt.ts` | verifyToken/generateToken 工作正常 |

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
`getToken` 中没有加锁，多个并发调用可能对同一服务器 login 多次。结果是多获取了几个 JWT，功能不受影响，只是多了几次 HTTP 请求。如果需要优化，可以加 Promise 锁（当前不必要）。

## 部署顺序

**必须前端先、后端后**:

1. **先部署 weknora-ui** — 新前端会调 `/api/auth/login` 获取 JWT，用 JWT 调管理 API。旧后端的 authMiddleware 仍然是 bug 状态（接受任何 token），JWT 作为"任何 token"之一可以通过 → 向前兼容
2. **再部署 agentstudio 后端** — 新后端严格验证 JWT。新前端已经在发 JWT → 正常工作

**反过来会出问题**: 如果先部署后端（严格 JWT 验证），而前端还在发 ADMIN_PASSWORD → 所有管理 API 返回 401。

## 安全假设

- `/api/auth/login` 以明文传输 ADMIN_PASSWORD（`password !== config.adminPassword` 直接比较）
- 生产环境中 weknora-ui → AgentStudio 的调用必须经过 HTTPS 或本地代理（Nginx/Vite proxy），确保密码不被窃听
- 开发环境中 Vite proxy 为同源调用，无安全风险

## 改动文件清单（本次设计覆盖范围：类型 A + WebSocket）

| 项目 | 文件 | 改动 |
|------|------|------|
| agentstudio | `backend/src/middleware/auth.ts` | async IIFE + await verifyToken |
| agentstudio | `backend/src/services/websocketService.ts` | authenticateToken 改为 JWT 验证 |
| weknora-ui | `src/composables/useAgentStudioAuth.ts` | **新建** JWT token 管理器 |
| weknora-ui | `src/api/a2a/index.ts` | 7 个管理 API 函数改用 JWT（含 getA2AHistory） |
| weknora-ui | `src/composables/useAgentStudioWS.ts` | connectOne 改 async + 用 JWT |

## 本次设计不覆盖的路由（类型 B — 需要单独设计）

以下路由的前端发送 WeKnora JWT（不同 secret），修复 authMiddleware 后会 401。
这些路由的业务逻辑不受影响，仅认证层需要处理。

| 路由组 | 前端模块 | 函数数量 | 功能 |
|--------|---------|---------|------|
| `/api/share/*` | `api/share/index.ts` | 18 个 | 知识库分享 CRUD + 内容访问 |
| `/api/kb/*` | `api/agentstudio/tag.ts` | 6 个 | 知识库标签树管理 |
| `/api/users/search` | `api/share/index.ts` | 1 个 | 用户搜索 |
| `/api/users/tenant/:id` | `api/share/index.ts` | 1 个 | 租户信息 |

**注意**：`/api/share/link/*` 路由（10 个）不走 authMiddleware，使用 cookie 认证，**不受影响**。

**Vite 代理关键规则**：这些路由在 `vite.config.ts` 中必须在 `/api` 通配之前声明，否则会被代理到 WeKnora 而非 AgentStudio：
```javascript
// 必须在 '/api' 之前声明
'/api/share': { target: 'http://localhost:4936' },
'/api/kb':    { target: 'http://localhost:4936' },
'/api/users/search': { target: 'http://localhost:4936' },
'/api/users/tenant': { target: 'http://localhost:4936' },
// 通配在最后
'/api': { target: 'http://192.168.100.30:8080' },
```
