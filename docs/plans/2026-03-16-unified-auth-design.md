# AgentStudio 统一认证链修复设计

## 背景

weknora-ui 与 AgentStudio 后端之间的认证链存在系统性缺陷：

1. **authMiddleware 未 await verifyToken** — `verifyToken` 是 async 函数，但 `authMiddleware` 调用时没有 await，返回的 Promise 永远 truthy，导致 28 个路由组的 JWT 验证形同虚设
2. **weknora-ui 从未调用 /api/auth/login** — 直接把 ADMIN_PASSWORD 明文当 Bearer Token 发送，依赖 authMiddleware 的 bug 工作
3. **WebSocket 认证不一致** — 原来要求 `agt_` 前缀（与管理 API 凭证不匹配），后改为接受任何非空 token

## 目标

修复完整认证链，使三个认证点各自正确工作：

| 认证点 | 修复前 | 修复后 |
|--------|--------|--------|
| authMiddleware (28 路由) | 接受任何 token（bug） | 验证 JWT 签名和过期 |
| WebSocket | 接受任何非空 token | 验证 JWT 签名和过期 |
| a2aAuth (3 路由) | bcrypt 验证 agt_proj_* | 不变 |

## 三种 Credential 说明

| Credential | 格式 | 来源 | 用途 |
|-----------|------|------|------|
| ADMIN_PASSWORD | 用户设置的密码字符串 | `weknora_a2a_servers` localStorage `.apiKey` 字段 | 调用 `/api/auth/login` 换取 JWT |
| JWT Token | `eyJhbG...` (7 天有效) | AgentStudio `/api/auth/login` 返回 | 管理 API (`/api/*`) + WebSocket (`/ws`) |
| Project API Key | `agt_proj_{hash}_{hex}` | `weknora_a2a_config` localStorage `.apiKey` 字段 | A2A 协议路由 (`/a2a/:agentId/*`) |

## 数据流（修复后）

```
┌─────────────────────── weknora-ui ───────────────────────┐
│                                                          │
│  页面加载 → loadServers() → 获取 ADMIN_PASSWORD          │
│                                                          │
│  管理 API 调用时:                                        │
│    ① getToken(serverUrl, adminPassword)                  │
│       → 缓存命中? 返回缓存 JWT                          │
│       → 缓存未命中/过期? POST /api/auth/login            │
│         → 获取 JWT, 存内存 Map                           │
│    ② 用 JWT 调用 /api/projects 等                       │
│    ③ 收到 401? clearToken + 重新 login + 重试一次       │
│                                                          │
│  WebSocket 连接时:                                       │
│    ① getToken(serverUrl, adminPassword) → 获取 JWT      │
│    ② ws://host/ws?token=${JWT}                          │
│                                                          │
│  A2A 聊天时:                                             │
│    ① 用 agt_proj_* key (不变)                           │
│    ② POST /a2a/:agentId/messages                        │
│                                                          │
└──────────────────────────────────────────────────────────┘
          │                    │                    │
          │ JWT                │ JWT                │ agt_proj_*
          ▼                    ▼                    ▼
┌──────────────┐  ┌──────────────────┐  ┌────────────────┐
│ authMiddleware│  │ WebSocket auth   │  │ a2aAuth        │
│ await verify │  │ await verify     │  │ bcrypt compare │
│ JWT 签名+过期│  │ JWT 签名+过期    │  │ (不变)         │
└──────────────┘  └──────────────────┘  └────────────────┘
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
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env.NO_AUTH === 'true') { next(); return; }

  const token = /* 从 header 或 query 提取 */;
  if (!token) { res.status(401).json({ error: 'No token provided' }); return; }

  const payload = await verifyToken(token);
  if (!payload) { res.status(401).json({ error: 'Invalid or expired token' }); return; }

  next();
}
```

变化: `function` → `async function`, 返回值 `void` → `Promise<void>`, 加 `await`。

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

upgrade handler 对应改为 async:
```typescript
server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url!, `http://${request.headers.host}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }

  const token = url.searchParams.get('token');
  if (!token || !(await authenticateToken(token))) { socket.destroy(); return; }

  wss!.handleUpgrade(request, socket, head, (ws) => { ... });
});
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

受影响函数: `fetchA2AProjects`, `fetchProjectA2AConfig`, `fetchA2AMapping`, `fetchA2AApiKeys`, `fetchActiveSessions`, `closeActiveSession`

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

调用方 `connectAll`、`addConnection` 中的 `connectOne(conn)` 无需 await（fire-and-forget，连接结果通过 onopen/onclose 回调处理）。

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

## 改动文件清单

| 项目 | 文件 | 改动 |
|------|------|------|
| agentstudio | `backend/src/middleware/auth.ts` | async + await verifyToken |
| agentstudio | `backend/src/services/websocketService.ts` | authenticateToken 改为 JWT 验证 |
| weknora-ui | `src/composables/useAgentStudioAuth.ts` | **新建** JWT token 管理器 |
| weknora-ui | `src/api/a2a/index.ts` | 6 个管理 API 函数改用 JWT |
| weknora-ui | `src/composables/useAgentStudioWS.ts` | connectOne 改 async + 用 JWT |
