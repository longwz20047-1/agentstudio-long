# A2A Loop Support Design: SDK Native Cron Integration

> Date: 2026-03-13
> Status: Draft
> Scope: agentstudio backend + weknora-ui frontend
> Phases: 2 (backend core → frontend monitoring)

## Prerequisites

**Reuse mode required**: Loop support depends on the A2A session reuse architecture (see `2026-03-12-a2a-session-reuse-migration-design.md`). Only sessions using Streaming Input Mode (`ClaudeSession` with `MessageQueue`) can keep SDK subprocesses alive for cron execution. Non-reuse (legacy) mode creates a new subprocess per message — cron tasks created in one subprocess are lost when it exits.

## Problem

### Why SDK Native Cron (Not schedulerService)

AgentStudio already has a system-level scheduler (`schedulerService.ts` + `node-cron`, 13 REST API + 13 MCP Admin tools). But it creates a **new session per execution** — Claude starts cold with no context, only able to run stateless fixed prompts.

SDK native cron runs **inside the same session**. This is a **user-level** capability: the user says "every 5 minutes check if the deploy is healthy" in a conversation, and Claude executes with full session context — knows what the user is working on, which files were discussed, which KB was selected, what tools were used. The cron prompt is a continuation of the conversation, not a cold start.

This contextual recurring execution is the core value that schedulerService cannot provide.

### Current Barriers

AgentStudio uses Claude Agent SDK's `ClaudeSession` (Streaming Input Mode) to keep SDK subprocesses alive across messages. The SDK natively supports `CronCreate`/`CronList`/`CronDelete` tools for scheduling recurring prompts inside the subprocess. These are CLI-native tools that are always available regardless of `allowedTools` configuration (which only controls auto-permission, not availability). However, two barriers prevent this from working in the current A2A architecture:

1. **Session killed before cron fires**: `sessionManager` cleans up idle sessions after 30 minutes (hardcoded). If cron interval > 30min, the subprocess dies before the cron fires
2. **Cron output silently dropped**: The `for await` loop in `claudeSession.ts:237-275` (dispatch logic at lines 257-274) only dispatches messages when a `responseCallback` exists (registered by `sendMessage()`). Cron-triggered messages arrive with no callback, so they are silently skipped — not written to history, not pushed to frontend

Additionally:
3. **3-day expiry**: SDK cron tasks auto-expire after 3 days

**Tested behavior**: Cron messages always arrive with `hasCallback=false` in the `for await` loop. The SDK's "Prompts run between your turns" guarantee ensures cron execution and user message processing are fully serialized — no message crossover occurs.

**Note on `allowedTools`**: AgentStudio's `allowedTools` option (passed to SDK `query()`) only controls **auto-permission bypass** — tools in the list execute without prompting for user confirmation. It does NOT restrict which tools are available. The actual tool whitelist is the `tools` option, which AgentStudio does not use. Cron tools are CLI-native infrastructure and are always available regardless of either setting.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Cron implementation | SDK native (CronCreate/CronList/CronDelete) | CLI built-in, always available, no configuration needed |
| Loop storage | Separate `.a2a/loops/{sessionId}.jsonl` | 不污染对话历史；结构化事件便于查询；CRD + 执行记录集中存储 |
| Cron execution delivery | Write to loops storage + WebSocket push | Loops 存储为持久化；WebSocket 提供实时展示 |
| CRD event capture | SSE callback 中检测 CronCreate/CronDelete tool_use | 复制结构化事件到 loops 存储，不影响 SSE 性能（触发频率极低） |
| Loop active status | Loops 存储 (created - deleted) + sessionManager 存活检查 | 历史只记录 CRD 事件，session 死亡会静默丢失所有 cron，需双重确认 |
| Session timeout config | Global env var + per-agent override | Configurable flexibility, users set longer timeout for cron use cases |
| 3-day expiry | Accept as SDK limitation | Each cron turn is stateless — Claude cannot reliably track creation time or execution count to self-renew. Users re-create if needed. |
| Implementation phasing | Phase 1 (backend core) → Phase 2 (frontend display) | De-risk: backend verifiable independently |

## Phase 1: Backend Core

### 1.1 Orphan Message Handler

**File**: `backend/src/services/claudeSession.ts`

Add new property and the orphan handler mechanism:

```typescript
// New property
private orphanMessageCallback: ((msg: SDKMessage) => void | Promise<void>) | null = null;

// New public method
public setOrphanMessageHandler(
  callback: (msg: SDKMessage) => void | Promise<void>
): void {
  if (this.orphanMessageCallback) return;  // Idempotent: only first registration takes effect
  this.orphanMessageCallback = callback;
}
```

**Modified `startBackgroundResponseHandler()`** — the core `for await` loop:

```typescript
for await (const response of this.queryStream) {
  const sdkMessage = response as SDKMessage;
  this.lastActivity = Date.now();

  // --- Session ID capture (existing, unchanged) ---
  // ...

  // --- Message dispatch with orphan handling ---
  const requestIds = Array.from(this.responseCallbacks.keys());
  const currentRequestId = requestIds.length > 0 ? requestIds[0] : null;

  if (currentRequestId && this.responseCallbacks.has(currentRequestId)) {
    // User-initiated message: dispatch to registered callback (existing behavior)
    const callback = this.responseCallbacks.get(currentRequestId)!;
    await callback(sdkMessage);
    if (sdkMessage.type === 'result') {
      this.responseCallbacks.delete(currentRequestId);
      this.isProcessing = false;
    }
  } else if (this.orphanMessageCallback) {
    // No callback registered: cron-triggered message → write to history
    // SDK guarantee: cron and user turns are fully serialized,
    // so hasCallback=false reliably identifies cron messages
    try {
      await this.orphanMessageCallback(sdkMessage);
    } catch (err) {
      console.error(`[ClaudeSession] Orphan message handler error:`, err);
    }
  }
}
```

**Design rationale**: No `isCronRunning` flag needed. Testing confirmed that SDK's "Prompts run between your turns" guarantee is strong — cron messages always arrive with `hasCallback=false`, and user messages always arrive with `hasCallback=true`. Simple callback existence check is sufficient to distinguish the two.

### 1.2 Loops Storage Service

**File**: New `backend/src/services/a2a/loopStorageService.ts`

独立于 A2A 对话历史的 loop 事件存储，JSONL 格式：

```
.a2a/loops/{sessionId}.jsonl
```

**事件类型**：

```typescript
// Loop 创建
{"type":"loop_created","jobId":"b7ab4362","cron":"*/1 * * * *","prompt":"创建一个测试文件","recurring":true,"timestamp":1234567890}

// Loop 删除
{"type":"loop_deleted","jobId":"b7ab4362","timestamp":1234567891}

// Cron 执行（无法关联到具体 job，SDK 不提供 job ID）
{"type":"loop_execution","status":"success","startTime":1234567892,"endTime":1234567893,"summary":"已创建测试文件：test_abc.txt"}
```

**Service API**：

```typescript
class LoopStorageService {
  // 写入事件
  async appendEvent(workingDirectory: string, sessionId: string, event: LoopEvent): Promise<void>;
  // 读取所有事件
  async readEvents(workingDirectory: string, sessionId: string): Promise<LoopEvent[]>;
  // 汇总 loop 列表
  async getLoopSummary(workingDirectory: string, sessionId: string): Promise<LoopSummary>;
}

interface LoopSummary {
  loops: Array<{ jobId: string; cron: string; prompt: string; recurring: boolean; status: 'active' | 'deleted'; createdAt: number; deletedAt?: number }>;
  totalExecutions: number;
  lastExecutionTime?: number;
}
```

**Note**: `getLoopSummary()` 返回的 `status: 'active'` 仅代表未被显式删除（CronDelete）。要判断 loop 是否真正运行中，还需检查 session 是否存活（见 Phase 2）。

### 1.3 Register Orphan Handler in A2A Route

**File**: `backend/src/routes/a2a.ts` — reuse streaming path, after `handleSessionManagement()` returns (line 943)

```typescript
const { claudeSession, actualSessionId } = await handleSessionManagement(...);

// Register orphan message handler (idempotent — only first call per session takes effect)
claudeSession.setOrphanMessageHandler(async (sdkMessage: SDKMessage) => {
  const sid = claudeSession.getClaudeSessionId();
  if (!sid) return;

  // 1. 记录执行事件到 loops 存储（仅 result 类型，标记执行完成）
  if (sdkMessage.type === 'result') {
    const resultMsg = sdkMessage as any;
    loopStorageService.appendEvent(a2aContext.workingDirectory, sid, {
      type: 'loop_execution',
      status: resultMsg.subtype || 'unknown',
      endTime: Date.now(),
      sessionId: sid,
    }).catch(err => console.error('[A2A] Failed to write loop execution:', err));
  }

  // 2. WebSocket 推送（实时展示 cron 执行过程）
  const wsEvent = {
    ...sdkMessage,
    sessionId: sid,
    timestamp: Date.now(),
    source: 'cron',
  };
  websocketService.broadcastToSession(sid, { type: 'cron_message', data: wsEvent });
});
```

**Changes from previous version**:
- 不再写入 A2A 对话历史（`a2aHistoryService.appendEvent`）
- 仅 `result` 类型写入 loops 存储（结构化的执行记录，不存原始 SDK 消息流）
- 所有 cron 消息通过 WebSocket 推送（前端实时渲染）

**Why closures are safe**:
- `a2aContext.workingDirectory` comes from `agentMapping.workingDirectory` (`a2aAuth.ts:122`), stable for the same agent across all requests
- `claudeSession.getClaudeSessionId()` is a getter that reads `this.claudeSessionId`, always returns the latest confirmed value
- `setOrphanMessageHandler` has idempotent guard — second call is a no-op

### 1.4 CRD Event Extraction in SSE Callback

**File**: `backend/src/routes/a2a.ts` — SSE callback inside `sendMessage()` (line 1142)

在正常用户对话的 SSE 回调中，检测 CronCreate/CronDelete tool_use 事件，提取结构化信息写入 loops 存储。

**CronCreate 需要两条消息配合**：
1. `assistant` 消息的 `tool_use` block → 提取 `{cron, prompt, recurring}`，以 `tool_use_id` 暂存
2. `user` 消息的 `tool_result` block → 从文本解析 job ID（`/job\s+([a-f0-9]+)/`），合并暂存数据写入

**CronDelete 只需一条消息**：
- `assistant` 消息的 `tool_use` block → 从 `input.id` 拿 job ID，直接写入

```typescript
// 在 SSE callback 顶部声明（sendMessage 回调闭包内）
const pendingCronCreates = new Map<string, { cron: string; prompt: string; recurring: boolean }>();

// 在 eventData 写入历史之后（约 line 1267），加 CRD 检测
// --- CRD event extraction for loops storage ---
if (sdkMessage.type === 'assistant') {
  const content = (sdkMessage as any).message?.content || [];
  for (const block of content) {
    if (block.type === 'tool_use' && block.name === 'CronCreate') {
      pendingCronCreates.set(block.id, {
        cron: block.input.cron,
        prompt: block.input.prompt,
        recurring: block.input.recurring ?? true,
      });
    }
    if (block.type === 'tool_use' && block.name === 'CronDelete') {
      loopStorageService.appendEvent(a2aContext.workingDirectory, capturedSessionId!, {
        type: 'loop_deleted',
        jobId: block.input.id,
        timestamp: Date.now(),
      }).catch(err => console.error('[A2A] Failed to write loop_deleted:', err));
    }
  }
}

if (sdkMessage.type === 'user') {
  const content = (sdkMessage as any).message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_result' && pendingCronCreates.has(block.tool_use_id)) {
        const params = pendingCronCreates.get(block.tool_use_id)!;
        pendingCronCreates.delete(block.tool_use_id);
        const match = (block.content || '').match(/job\s+([a-f0-9]+)/i);
        if (match) {
          loopStorageService.appendEvent(a2aContext.workingDirectory, capturedSessionId!, {
            type: 'loop_created',
            jobId: match[1],
            cron: params.cron,
            prompt: params.prompt,
            recurring: params.recurring,
            timestamp: Date.now(),
          }).catch(err => console.error('[A2A] Failed to write loop_created:', err));
        }
      }
    }
  }
}
```

**Performance**: `sdkMessage.type` 字符串比较过滤掉 ~90% 的 `stream_event`。CRD 检测仅在 `assistant`/`user` 消息触发，整个会话可能只有 1~5 次。`appendEvent` 用 fire-and-forget（不 await），不阻塞 SSE 流。

### 1.5 Configurable Session Timeout

**File**: `backend/src/services/sessionManager.ts`

#### 1.5.1 Global environment variable

**Implementation note**: The existing `sessionManager.ts` declares `defaultIdleTimeoutMs` and `heartbeatTimeoutMs` as `private readonly` field initializers (lines 40-41). To make them configurable, remove `readonly` and move initialization into the constructor.

```typescript
// Change from field initializers to constructor-assigned properties
private defaultIdleTimeoutMs: number;
private heartbeatTimeoutMs: number;

constructor() {
  const envTimeout = process.env.SESSION_IDLE_TIMEOUT_MS;
  this.defaultIdleTimeoutMs = envTimeout ? parseInt(envTimeout, 10) : 30 * 60 * 1000;
  // Heartbeat timeout: independent of idle timeout.
  // Heartbeat checks if the SDK subprocess is responsive (ping/pong).
  // Idle timeout checks if the session has had any user activity.
  // Keep heartbeat at 30min default unless explicitly configured.
  const heartbeatEnv = process.env.SESSION_HEARTBEAT_TIMEOUT_MS;
  this.heartbeatTimeoutMs = heartbeatEnv ? parseInt(heartbeatEnv, 10) : 30 * 60 * 1000;
  // ... existing code ...
}
```

#### 1.5.2 Per-agent timeout override

**File**: `backend/src/types/agents.ts` — `AgentConfig` interface

```typescript
interface AgentConfig {
  // ... existing fields ...
  idleTimeoutMs?: number;  // Optional: overrides global SESSION_IDLE_TIMEOUT_MS
}
```

**File**: `backend/src/services/sessionManager.ts` — new helper method

**New dependency**: `sessionManager.ts` currently does not import `agentStorage`. Adding `getAgentIdleTimeout()` introduces a dependency on `agentStorage.getAgent()`. Import it at the top of the file:
```typescript
import { agentStorage } from './agentStorage.js';
```

```typescript
private getAgentIdleTimeout(agentId: string): number | undefined {
  try {
    const agent = agentStorage.getAgent(agentId);
    return agent?.idleTimeoutMs;
  } catch {
    return undefined;
  }
}
```

**Performance note**: `agentStorage.getAgent()` reads from the file system (JSON files). `cleanupIdleSessions()` runs every 60 seconds and iterates all sessions. To avoid N file reads per cycle, consider caching the timeout value on `ClaudeSession` at creation time, or using a simple in-memory cache with TTL in `getAgentIdleTimeout()`.

**Note**: `idleTimeoutMs` is a backend-only configuration field. It should NOT be added to the frontend `AgentConfig` type (`frontend/src/types/agents.ts`). It is only relevant for session lifecycle management in the backend.

#### 1.5.3 Apply per-agent timeout in cleanup

**File**: `backend/src/services/sessionManager.ts` — `cleanupIdleSessions()`

Replace the hardcoded timeout in the confirmed-session cleanup loop:

```typescript
// Check confirmed sessions
for (const [sessionId, session] of this.sessions.entries()) {
  // Per-agent timeout override, falling back to global default
  const agentTimeout = this.getAgentIdleTimeout(session.getAgentId());
  const effectiveTimeout = agentTimeout ?? this.defaultIdleTimeoutMs;

  if (session.isIdle(effectiveTimeout)) {
    idleSessionIds.push(sessionId);
  }
}
```

Precedence: **agent-level timeout > global env var > 30min default**

Users who use cron should set `SESSION_IDLE_TIMEOUT_MS` or per-agent `idleTimeoutMs` to a value longer than their cron interval. Loop state tracking (whether a session has active crons) is deferred — the A2A history already records all CronCreate/CronDelete events with `source: 'cron'`, which can be queried when needed.

## Phase 2: Frontend Loop Display

### 2.1 Loop Info API

**File**: New route `backend/src/routes/loops.ts`

```typescript
// GET /api/sessions/:sessionId/loops
// 从 loops 存储读取，结合 sessionManager 判断活跃状态
router.get('/:sessionId/loops', a2aAuthMiddleware, async (req, res) => {
  const { workingDirectory } = req.a2aContext;
  const sessionId = req.params.sessionId;

  const summary = await loopStorageService.getLoopSummary(workingDirectory, sessionId);

  // Session 是否存活决定 loop 是否真正活跃
  const sessionAlive = sessionManager.getSession(sessionId) !== null;

  res.json({
    sessionAlive,
    loops: summary.loops.map(loop => ({
      ...loop,
      // 未被删除 + session 存活 = 真正活跃
      status: loop.status === 'active' && sessionAlive ? 'active' :
              loop.status === 'deleted' ? 'deleted' : 'expired',
    })),
    totalExecutions: summary.totalExecutions,
    lastExecutionTime: summary.lastExecutionTime,
  });
});
```

**Loop 状态三态**：
- `active` — 未 CronDelete 且 session 存活
- `deleted` — 被 CronDelete 显式删除
- `expired` — 未 CronDelete 但 session 已死（超时/重启/崩溃）

### 2.2 Frontend Loop Display

**File**: `weknora-ui/src/views/a2a-chat/index.vue` or new component

**两种场景**：

**A. 进入历史会话** — 调用 `GET /api/sessions/:sid/loops` 获取 loop 列表和执行统计。

**B. 实时对话中** — 通过 WebSocket 接收 `cron_message` 事件，渲染 cron 执行过程。前端根据 `source: 'cron'` 做差异化展示（如不同背景色、Loop 标签）。

**展示信息**：

| Information | 来源 |
|-------------|------|
| Loop 列表（job ID, schedule, prompt, status） | `GET /api/sessions/:sid/loops` |
| 执行总次数 / 最后执行时间 | 同上 |
| Cron 实时执行过程 | WebSocket `cron_message` 事件 |

## File Change Summary

### Phase 1 (Backend Core)

| File | Action | Changes |
|------|--------|---------|
| `backend/src/services/claudeSession.ts` | Modify | +orphanMessageCallback, +setOrphanMessageHandler(), modified for-await loop with else branch for orphan messages |
| `backend/src/services/a2a/loopStorageService.ts` | **New** | Loop 事件 JSONL 存储服务（appendEvent, readEvents, getLoopSummary） |
| `backend/src/routes/a2a.ts` | Modify | 注册 orphan handler（写 loops 存储 + WebSocket 推送）；SSE 回调中 CRD 事件提取 |
| `backend/src/services/sessionManager.ts` | Modify | Constructor reads `SESSION_IDLE_TIMEOUT_MS` env var, +getAgentIdleTimeout(), modified cleanupIdleSessions() with per-agent timeout |
| `backend/src/types/agents.ts` | Modify | +idleTimeoutMs optional field in AgentConfig |

### Phase 2 (Frontend Display)

| File | Action | Changes |
|------|--------|---------|
| `backend/src/routes/loops.ts` | **New** | +GET /api/sessions/:sessionId/loops（读 loops 存储 + session 存活检查） |
| `weknora-ui/src/views/a2a-chat/index.vue` | Modify | Loop info 展示 + WebSocket cron_message 实时渲染 |

## Known Limitations

1. **3-day auto-expiry**: SDK cron tasks auto-expire after 3 days. Each cron execution is stateless — Claude has no persistent memory across cron turns to track creation time or execution count. Users must manually re-create expired crons. **Improvement path**: Backend-driven renewal — track cron creation timestamps in loops storage, inject renewal prompts when approaching 2.5 days.

2. **First request required**: The orphan handler is registered during the first A2A request to a session. If a session is created programmatically without going through A2A route, orphan messages won't be handled. This matches current usage patterns (all sessions start from weknora-ui A2A chat).

3. **No per-user loop isolation**: In the current architecture, loops run within a session which is tied to an agent+project, not a specific user. Multiple users sharing the same agent could see each other's loop results. This matches the existing session sharing model.

4. **Execution cannot关联到具体 job**: SDK 在 cron 触发的消息中不携带 job ID，无法精确标记"这次执行是哪个 job 触发的"。`loop_execution` 事件只记录执行时间和结果，不关联具体 loop。

5. **Session timeout vs cron lifetime**: No automatic loop exemption from idle cleanup. Users must manually configure `SESSION_IDLE_TIMEOUT_MS` or per-agent `idleTimeoutMs` to exceed their cron interval. If timeout is too short, the session gets killed and all crons in it are lost.

6. **Session 死亡无事件**: Session 被超时清理、服务重启、SDK 崩溃时，不会产生 CronDelete 事件。loops 存储中的 loop 显示为 `active`，但实际已失效。需结合 `sessionManager.getSession()` 判断真实状态（Phase 2 API 已处理）。

## Verification Checklist

### Phase 1
- [ ] Claude 在 A2A 对话中调用 CronCreate → loops 存储写入 `loop_created` 事件
- [ ] Claude 调用 CronDelete → loops 存储写入 `loop_deleted` 事件
- [ ] Cron 触发执行 → loops 存储写入 `loop_execution` 事件
- [ ] Cron 执行消息通过 WebSocket 推送到前端
- [ ] `SESSION_IDLE_TIMEOUT_MS` env var changes effective timeout
- [ ] Agent-level `idleTimeoutMs` overrides global default

### Phase 2
- [ ] `GET /api/sessions/:sid/loops` 返回 loop 列表 + 正确的三态状态（active/deleted/expired）
- [ ] 进入历史会话 → 展示 loop 汇总
- [ ] 实时对话中 → WebSocket 收到 cron 消息并差异化渲染

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Session killed while cron active | Medium | 用户配置 `SESSION_IDLE_TIMEOUT_MS` 或 per-agent `idleTimeoutMs`。Phase 2 API 通过 session 存活检查返回 `expired` 状态 |
| Memory growth from long-lived sessions | Low | Same concern as existing reuse mode. Monitor process RSS. |
| Orphan handler closure leak | Low | Idempotent registration. Handler references stable values (getter, constant workingDirectory). |
| 3-day cron expiry | Medium | Accepted as SDK limitation. Users re-create expired crons. |
| CRD 提取 regex 失败 | Low | Job ID regex `/job\s+([a-f0-9]+)/` 匹配 SDK 当前格式。SDK 格式变化需更新 regex。 |
| Loops 存储文件增长 | Low | 仅存结构化事件（非原始 stream），单次执行一条记录，增长可控 |
