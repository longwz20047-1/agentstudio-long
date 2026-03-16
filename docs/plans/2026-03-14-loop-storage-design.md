# Loop Storage Design: Cron 事件独立存储

> Date: 2026-03-14
> Status: Draft
> Scope: agentstudio backend
> Base: `2026-03-13-a2a-loop-support-design.md` Phase 1 子集
> Prerequisite: Session Reuse 模式已实现，Orphan Handler 机制已存在

## 目标

将 SDK cron 生命周期事件（创建/删除/执行）从 A2A 对话历史中分离到独立的 loops 存储，实现结构化的 loop 状态管理。

**本次范围**（4 项）：
1. Orphan handler 不再写入 A2A 对话历史，改写 loops 存储
2. 新建 `loopStorageService.ts` — 独立 JSONL 事件存储
3. SSE 回调中提取 CronCreate/CronDelete tool_use 事件
4. Cron 执行结果写入 loops 存储

**不在本次范围**：Session 超时配置、WebSocket 推送、前端展示、Loop Info API。

## 现状分析（代码事实）

### 已实现：Orphan Handler 机制

`claudeSession.ts` 中 orphan message handler 已完整实现：

- **Line 36**: `private orphanMessageCallback` 属性
- **Lines 260-284**: `for await` 循环中 dispatch 逻辑，`else if (this.orphanMessageCallback)` 分支处理无主消息
- **Lines 360-366**: `setOrphanMessageHandler()` 方法，含幂等守卫

**无需修改 `claudeSession.ts`。**

### 需修改：当前 Orphan Handler 注册

`a2a.ts:1095-1113` 当前将 orphan 消息写入 A2A 对话历史：

```typescript
// 当前代码 (a2a.ts:1097-1113)
claudeSession.setOrphanMessageHandler(async (sdkMessage: SDKMessage) => {
  const sid = claudeSession.getClaudeSessionId();
  if (!sid) return;
  const historyEvent = {
    ...sdkMessage,
    sessionId: sid,
    timestamp: Date.now(),
    source: 'cron',
  };
  try {
    await a2aHistoryService.appendEvent(a2aContext.workingDirectory, sid, historyEvent);
  } catch (err) {
    console.error('[A2A] Failed to write orphan message to history:', err);
  }
});
```

问题：cron 消息混入对话历史，污染前端消息流。

### SSE 回调结构

`a2a.ts:1174-1319` — `claudeSession.sendMessage()` 的 SSE 回调中：

- **Lines 1179-1202**: Session confirmation（system.init 处理）
- **Lines 1204-1220**: Deferred user message save
- **Lines 1222-1272**: Compact 上下文压缩处理
- **Lines 1274-1284**: `eventData` 构建（含 sessionId, timestamp, isSidechain）
- **Lines 1286-1288**: SSE 写入
- **Lines 1290-1301**: A2A history 写入 ← CRD 提取插入点（在此之后）
- **Lines 1303-1319**: Stream completion + error detection

## 设计

### 1. Loop Storage Service（新文件）

**File**: `backend/src/services/a2a/loopStorageService.ts`

参照 `a2aHistoryService.ts` 的模式（同目录，同样的 JSONL + `ensureDir` 模式），创建独立存储：

```
.a2a/loops/{sessionId}.jsonl
```

**事件类型定义**：

```typescript
export interface LoopCreatedEvent {
  type: 'loop_created';
  jobId: string;           // SDK 返回的 cron job ID
  cron: string;            // cron 表达式, e.g. "*/5 * * * *"
  prompt: string;          // 执行的 prompt
  recurring: boolean;      // 是否循环
  timestamp: number;
}

export interface LoopDeletedEvent {
  type: 'loop_deleted';
  jobId: string;
  timestamp: number;
}

export interface LoopExecutionEvent {
  type: 'loop_execution';
  status: string;          // result.subtype, e.g. "success", "error"
  timestamp: number;       // 执行完成时间（orphan result 到达时间）
}

export type LoopEvent = LoopCreatedEvent | LoopDeletedEvent | LoopExecutionEvent;
```

**Service API**：

```typescript
class LoopStorageService {
  private getLoopsDir(workingDirectory: string): string {
    return path.join(workingDirectory, '.a2a', 'loops');
  }

  private getLoopsFilePath(workingDirectory: string, sessionId: string): string {
    return path.join(this.getLoopsDir(workingDirectory), `${sessionId}.jsonl`);
  }

  async appendEvent(workingDirectory: string, sessionId: string, event: LoopEvent): Promise<void>;
  async readEvents(workingDirectory: string, sessionId: string): Promise<LoopEvent[]>;
}

export const loopStorageService = new LoopStorageService();
```

实现模式完全复用 `a2aHistoryService.ts`（`fs.appendFile` + JSONL + `ensureDir`），不需要 `tailHistory`。

### 2. 替换 Orphan Handler：写 Loops Storage

**File**: `backend/src/routes/a2a.ts`

**位置**: Lines 1095-1113（`handleSessionManagement()` 返回之后，`if (stream)` 之前）

**替换逻辑**: 不再写 A2A 对话历史，仅在 `result` 类型时写入 loops 存储的 `loop_execution` 事件。

```typescript
// 替换 a2a.ts:1095-1113
// 注册 orphan message handler（幂等，同一 session 只生效一次）
// cron 触发的执行结果写入 loops 存储（不污染 A2A 对话历史）
claudeSession.setOrphanMessageHandler(async (sdkMessage: SDKMessage) => {
  const sid = claudeSession.getClaudeSessionId();
  if (!sid) return;

  // 仅 result 类型标记一次执行完成
  if (sdkMessage.type === 'result') {
    const resultMsg = sdkMessage as any;
    loopStorageService.appendEvent(a2aContext.workingDirectory, sid, {
      type: 'loop_execution',
      status: resultMsg.subtype || 'unknown',
      timestamp: Date.now(),
    }).catch(err => console.error('[A2A] Failed to write loop execution:', err));
  }
  // 非 result 类型的 cron 消息（assistant, user, system 等）静默丢弃
  // 后续可通过 WebSocket 推送实时展示，但不在本次范围
});
```

**变更要点**：
- 删除 `a2aHistoryService.appendEvent()` 调用
- 新增 `loopStorageService.appendEvent()` 调用
- 只处理 `result` 类型，其他类型不存储
- fire-and-forget（`.catch()`），不阻塞消息分发

### 3. CRD 事件提取

**File**: `backend/src/routes/a2a.ts`

**位置**: SSE 回调内，A2A history 写入之后（line 1301 之后，`// --- Stream completion` 之前）

CronCreate 需要两条消息配合提取，CronDelete 只需一条。

#### 3.1 声明暂存 Map

在 `sendMessage()` 回调**外部**（line 1171 `compactMessageBuffer` 声明附近）添加：

```typescript
let compactMessageBuffer: any[] = [];  // 已有 (line 1171)
const pendingCronCreates = new Map<string, { cron: string; prompt: string; recurring: boolean }>();
```

#### 3.2 提取逻辑

在 line 1301（`if (capturedSessionId)` 块的闭合 `}`）之后、line 1303（`// --- Stream completion`）之前插入：

```typescript
            // --- CRD event extraction for loops storage ---
            if (capturedSessionId && sdkMessage.type === 'assistant') {
              const content = (sdkMessage as any).message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_use' && block.name === 'CronCreate') {
                    pendingCronCreates.set(block.id, {
                      cron: block.input?.cron,
                      prompt: block.input?.prompt,
                      recurring: block.input?.recurring ?? true,
                    });
                  }
                  if (block.type === 'tool_use' && block.name === 'CronDelete') {
                    loopStorageService.appendEvent(
                      a2aContext.workingDirectory, capturedSessionId, {
                        type: 'loop_deleted',
                        jobId: block.input?.id,
                        timestamp: Date.now(),
                      }
                    ).catch(err => console.error('[A2A] Failed to write loop_deleted:', err));
                  }
                }
              }
            }

            if (capturedSessionId && sdkMessage.type === 'user') {
              const content = (sdkMessage as any).message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_result' && pendingCronCreates.has(block.tool_use_id)) {
                    const params = pendingCronCreates.get(block.tool_use_id)!;
                    pendingCronCreates.delete(block.tool_use_id);
                    // tool_result content 格式: "Scheduled job <hex_id> ..."
                    const resultText = typeof block.content === 'string'
                      ? block.content
                      : Array.isArray(block.content)
                        ? block.content.map((b: any) => b.text || '').join('')
                        : '';
                    const match = resultText.match(/job\s+([a-f0-9]+)/i);
                    if (match) {
                      loopStorageService.appendEvent(
                        a2aContext.workingDirectory, capturedSessionId, {
                          type: 'loop_created',
                          jobId: match[1],
                          cron: params.cron,
                          prompt: params.prompt,
                          recurring: params.recurring,
                          timestamp: Date.now(),
                        }
                      ).catch(err => console.error('[A2A] Failed to write loop_created:', err));
                    }
                  }
                }
              }
            }
```

**性能分析**：
- `sdkMessage.type` 字符串比较过滤掉 ~90% 的 `stream_event` 消息
- CRD 检测仅在 `assistant`/`user` 消息触发，整个会话生命周期可能只有 1~5 次
- `appendEvent` 用 fire-and-forget（`.catch()`），不阻塞 SSE 流

**CronCreate 两步流程**：
```
Step 1: assistant 消息
  content: [{ type: "tool_use", id: "toolu_xxx", name: "CronCreate",
              input: { cron: "*/5 * * * *", prompt: "check deploy", recurring: true } }]
  → 暂存到 pendingCronCreates Map, key = "toolu_xxx"

Step 2: user 消息 (SDK 自动生成的 tool_result)
  content: [{ type: "tool_result", tool_use_id: "toolu_xxx",
              content: "Scheduled job b7ab4362 with cron ..." }]
  → 从 pendingCronCreates 取出参数, 正则提取 jobId, 写入 loop_created
```

**CronDelete 一步完成**：
```
assistant 消息
  content: [{ type: "tool_use", name: "CronDelete",
              input: { id: "b7ab4362" } }]
  → 直接从 input.id 取 jobId, 写入 loop_deleted
```

## File Change Summary

| File | Action | Changes |
|------|--------|---------|
| `backend/src/services/a2a/loopStorageService.ts` | **New** | LoopEvent 类型定义 + JSONL 存储服务（appendEvent, readEvents） |
| `backend/src/routes/a2a.ts` | **Modify** | ① 新增 import loopStorageService ② 替换 orphan handler (lines 1095-1113): 从写 A2A 历史改为写 loops 存储 ③ SSE 回调中新增 CRD 事件提取 (line 1301 之后) ④ 新增 pendingCronCreates Map 声明 (line 1171 附近) |

## 验证清单

- [ ] cron 触发的消息**不再**出现在 `.a2a/history/{sessionId}.jsonl` 中
- [ ] Claude 调用 CronCreate → `.a2a/loops/{sessionId}.jsonl` 写入 `loop_created` 事件（含 jobId, cron, prompt）
- [ ] Claude 调用 CronDelete → `.a2a/loops/{sessionId}.jsonl` 写入 `loop_deleted` 事件（含 jobId）
- [ ] Cron 触发执行完成 → `.a2a/loops/{sessionId}.jsonl` 写入 `loop_execution` 事件（含 status, timestamp）
- [ ] 正常用户对话（非 cron 相关）不受影响，SSE 流和 A2A 历史行为不变
- [ ] CRD 检测不阻塞 SSE 流（fire-and-forget）
- [ ] CronCreate 正则匹配失败时（tool_result 格式异常），不写入 `loop_created`，不报错，不影响 SSE 流

## 已知限制

1. **执行无法关联具体 job**: SDK cron 触发的消息不携带 job ID，`loop_execution` 事件无法标记是哪个 job 触发的
2. **cron 中间过程不存储**: orphan handler 只存 `result` 类型，`assistant`/`user` 等中间消息静默丢弃。后续可通过 WebSocket 推送实时展示
3. **CronCreate job ID 依赖正则**: 从 tool_result 文本中提取 `/job\s+([a-f0-9]+)/`，如果 SDK 格式变化需更新
4. **Session 死亡不产生事件**: session 被超时清理/服务重启时，loops 存储中的 loop 仍显示为 `active`（未被 CronDelete），需外部检查 session 存活状态
