# A2A Chat Session Mode Migration: `new` -> `reuse`

> Date: 2026-03-12
> Status: Implemented
> Scope: agentstudio backend only (weknora-ui no changes needed)

## Problem

weknora-ui A2A chat defaults to `sessionMode='new'`. This mode creates a new SDK subprocess per message, destroying it after reply. Consequences:

1. **Every message spawns a new process**: ~200ms-1s startup overhead (subprocess + MCP reconnection + disk history reload)
2. **Session never reused**: Despite the name "session", each message is isolated
3. **SDK loop/background features impossible**: Process exits after reply, killing any long-running SDK features
4. **Resume unreliable**: File-based resume can fail silently, creating a new session and losing history context

## Solution

Switch A2A chat default from `sessionMode='new'` to `sessionMode='reuse'`. The `reuse` mode uses `ClaudeSession` + `MessageQueue` (Streaming Input Mode) to keep the SDK subprocess alive across messages.

**However**, the existing `reuse` streaming path in `a2a.ts` has critical bugs for new sessions (no initial sessionId). These must be fixed as part of this migration.

## Verified Bugs in Current `reuse` Streaming Path

All bugs verified by line-by-line code tracing. Only affect **first message of a new conversation** (no sessionId provided).

### Bug 1: Session never confirmed

- `handleSessionManagement()` returns `actualSessionId = null` (sessionUtils.ts:45)
- `createNewSession(undefined)` stores session in `tempSessions` (sessionManager.ts:172-174)
- `confirmSessionId()` is never called in the streaming callback (a2a.ts:1002-1024)
- Session stays in `tempSessions`, cannot be found by `getSession()` on next message
- **Impact**: Second message creates a NEW process instead of reusing. First process becomes orphan until 30-min cleanup.

### Bug 2: SSE events have `sessionId: null`

- `eventData` uses `sessionId: actualSessionId` which is `null` (a2a.ts:1006)
- `actualSessionId` is `const`, never updated after initial assignment
- **Frontend workaround exists**: `stream.ts:162` checks `data.session_id || data.sessionId`. The `...sdkMessage` spread includes SDK's `session_id` (snake_case) from `system.init` message. Frontend captures this correctly.
- **Impact**: Inconsistent event format vs `new` mode. Works only because of frontend's dual-field check.

### Bug 3: A2A history not written

- User message save: `if (actualSessionId)` is false, skipped (a2a.ts:989)
- SDK event save: `if (actualSessionId)` is false, skipped (a2a.ts:1013)
- **Impact**: Frontend cannot load history for this session. Conversation appears empty on reload.

### Bug 4: AskUserQuestion sessionId not updated

- `askUserSessionRef` is never updated with the real sessionId (no code in streaming callback)
- **Impact**: AskUserQuestion MCP tool cannot match pending inputs to the correct session.

### Bug 5: Dead sessions silently reused

- `handleSessionManagement` reuse path (sessionUtils.ts:100-106) checks `isSessionBusy()` but not `isSessionActive()`
- If a session previously died (e.g., resume failure, subprocess crash), it stays in `sessions` Map with `isActive=false`
- `getSession()` returns it, `isSessionBusy()` returns false, so the dead session is returned
- `sendMessage()` then throws "Session is not active" (claudeSession.ts:193-194)
- **Impact**: User gets cryptic error instead of automatic recovery.

**Failure timeline for resume of a corrupted session:**

```
Message 1 to expired session S1:
  handleSessionManagement → getSession(S1) → null (cleaned up by idle timeout)
  → checkSessionExists(S1) → true (.jsonl exists on disk)
  → createNewSession(resume=S1) → sessions.set(S1, session)
  → sendMessage() → isActive=true ✓ → pushes to queue → returns requestId
  → startBackgroundResponseHandler → for await → SDK subprocess tries resume → FAILS
  → catch (claudeSession.ts:279): isActive=false, isProcessing=false
  → callback never called → SSE stream hangs (no 'done' event, no res.end())

Message 2 to same S1 (user retries or sends again):
  handleSessionManagement → getSession(S1) → FOUND (still in sessions Map)
  → isSessionBusy? → false (cleared by error handler)
  → isSessionActive? → NOT CHECKED ← Bug 5
  → Returns dead session
  → sendMessage → isActive=false → throws "Session is not active"
```

### Why these bugs exist

The `reuse` streaming path (a2a.ts:954-1033) was written for the case where `sessionId` is already known (resume scenario). The new-session path (no sessionId) was never properly implemented. Compare with:
- `agents.ts:943-973` — properly handles session confirmation in streaming
- `a2a.ts:756-810` (`new` mode) — properly captures sessionId in streaming callback
- `a2a.ts:1108-1113` (`reuse` synchronous mode) — calls confirmSessionId but without configSnapshot; also has Bug 2/3/4 for new sessions

## Gap Analysis

Comparison of `sessionMode='new'` (one-shot, a2a.ts:705-926) vs `sessionMode='reuse'` (ClaudeSession, a2a.ts:928-1033) feature parity:

| Feature | `new` (one-shot) | `reuse` (ClaudeSession) | Gap? | Fixed by |
|---------|-------------------|-------------------------|------|----------|
| SSE streaming | `executeA2AQueryStreaming` | `claudeSession.sendMessage` | Different entry point (ok) | — |
| Resume history | `queryOptions.resume = sessionId` | `handleSessionManagement` internal | Equivalent | — |
| SessionId capture (new session) | From SDK `system.init` (a2a.ts:762) | **Missing** — uses `actualSessionId` (null) | **Bug 1+2** | File 2 fix |
| askUserQuestion update | `askUserSessionRef.current` (a2a.ts:769) | **Missing** | **Bug 4** | File 2 fix |
| `userInputRegistry.updateSessionId` | Yes (a2a.ts:771) | **Missing** | **Bug 4** | File 2 fix |
| History write (new session) | Deferred until sessionId captured (a2a.ts:776) | Skipped when `actualSessionId` null | **Bug 3** | File 2 fix |
| `sessionManager.confirmSessionId` | Not needed (no SessionManager) | **Missing** — agents.ts:949 has it | **Bug 1** | File 2 fix |
| Resume failure retry | Built-in (a2aQueryService.ts:254-275) | **Missing** — dead session silently reused | **Bug 5** | File 3 fix |
| SESSION_BUSY protection | Not needed (one-shot) | `handleSessionManagement` built-in | reuse is safer | — |
| Skill command detection | Yes | Yes | Equivalent | — |
| Image support | Yes | Yes | Equivalent | — |

**All 6 gaps are addressed by this migration (Files 1-3).**

## Changes

### File 1: `backend/src/schemas/a2a.ts` (line 37)

Change default `sessionMode` from `'new'` to `'reuse'`.

```
Before: sessionMode: SessionModeSchema.optional().default('new'),
After:  sessionMode: SessionModeSchema.optional().default('reuse'),
```

Rationale: weknora-ui never sends `sessionMode`. Changing the default is the zero-frontend-change approach.

### File 2: `backend/src/routes/a2a.ts` (lines 988-1033)

Fix the `reuse` streaming callback. The fix follows the proven pattern from `agents.ts:943-973`.

#### Current code (lines 979-1033, simplified):

The user message save and streaming callback are two separate blocks:

```typescript
// Block 1: User message save (lines 988-1000) — BEFORE sendMessage
// Constructs historyUserMessage, then:
if (actualSessionId) {  // SKIPPED when null (new session)
  await a2aHistoryService.appendEvent(a2aContext.workingDirectory, actualSessionId, userHistoryEvent);
}

// Block 2: Streaming callback (lines 1002-1033)
try {
  await claudeSession.sendMessage(sdkUserMessage, async (sdkMessage: SDKMessage) => {
    const eventData = {
      ...sdkMessage,
      sessionId: actualSessionId,  // null for new sessions — BUG
      timestamp: Date.now(),
    };
    res.write(`data: ${JSON.stringify(eventData)}\n\n`);
    try {
      if (actualSessionId) {  // false for new sessions — BUG: history not saved
        await a2aHistoryService.appendEvent(...);
      }
    } catch (err) { ... }
    if (sdkMessage.type === 'result') {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    }
  });
} catch (error) { ... }
```

#### Fixed code:

Add tracking variables before `sendMessage` call:

```typescript
let capturedSessionId: string | null = actualSessionId;
let userMessageSaved = false;
```

Save user message to history (only when sessionId is already known):

```typescript
if (actualSessionId) {
  const userHistoryEvent = {
    ...historyUserMessage,
    sessionId: actualSessionId,
    timestamp: Date.now(),
  };
  try {
    await a2aHistoryService.appendEvent(a2aContext.workingDirectory, actualSessionId, userHistoryEvent);
    userMessageSaved = true;
  } catch (err) {
    console.error('[A2A] Failed to write user message to history:', err);
  }
}
```

Fix the streaming callback:

```typescript
try {
  await claudeSession.sendMessage(sdkUserMessage, async (sdkMessage: SDKMessage) => {
    // --- Session confirmation (adapted from agents.ts:943-973) ---
    // Note: uses inline type check instead of isSDKSystemMessage() which is not imported in a2a.ts.
    // This block runs synchronously before eventData construction below,
    // so even the system.init event itself will carry the correct sessionId.
    if (sdkMessage.type === 'system'
        && (sdkMessage as any).subtype === 'init'
        && sdkMessage.session_id) {
      const sdkSessionId = sdkMessage.session_id;

      if (!capturedSessionId) {
        // New session: confirm in SessionManager
        capturedSessionId = sdkSessionId;
        claudeSession.setClaudeSessionId(sdkSessionId);
        sessionManager.confirmSessionId(claudeSession, sdkSessionId, configSnapshot);
        console.log(`[A2A reuse] Confirmed session ${sdkSessionId}`);

        // Update AskUserQuestion MCP sessionId
        if (askUserSessionRef) {
          const oldId = askUserSessionRef.current;
          askUserSessionRef.current = sdkSessionId;
          userInputRegistry.updateSessionId(oldId, sdkSessionId);
        }
      } else if (sdkSessionId !== capturedSessionId) {
        // Resume returned different ID: update internal ID, keep public ID
        claudeSession.setClaudeSessionId(sdkSessionId);
        console.log(`[A2A reuse] Resume branched: SDK=${sdkSessionId}, public=${capturedSessionId}`);
      }
    }

    // --- Deferred user message save (new session, now have sessionId) ---
    if (capturedSessionId && !userMessageSaved) {
      userMessageSaved = true;
      try {
        await a2aHistoryService.appendEvent(
          a2aContext.workingDirectory,
          capturedSessionId,
          {
            ...historyUserMessage,
            sessionId: capturedSessionId,
            timestamp: Date.now() - 1, // before SDK events for ordering
          }
        );
      } catch (err) {
        console.error('[A2A] Failed to write deferred user message:', err);
      }
    }

    // --- Build event with correct sessionId ---
    const eventData = {
      ...sdkMessage,
      sessionId: capturedSessionId || actualSessionId,
      timestamp: Date.now(),
    };

    res.write(`data: ${JSON.stringify(eventData)}\n\n`);

    // --- Save to A2A history ---
    if (capturedSessionId) {
      try {
        await a2aHistoryService.appendEvent(
          a2aContext.workingDirectory,
          capturedSessionId,
          eventData
        );
      } catch (err) {
        console.error('[A2A] Failed to write history event:', err);
      }
    }

    // --- Stream completion ---
    if (sdkMessage.type === 'result') {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    }
  });
} catch (error) {
  // --- Session not active: subprocess died (resume failure, crash, etc.) ---
  // sendMessage() throws "Session is not active" when isActive=false (claudeSession.ts:193-194).
  // This happens when a session was found in SessionManager but its subprocess already crashed.
  // Note: File 3 (sessionUtils.ts) adds a proactive isSessionActive() check to catch this
  // BEFORE sendMessage, but this catch handles the race condition where the session dies
  // between the check and the sendMessage call.
  if (error instanceof Error && error.message.includes('not active')) {
    console.warn(`[A2A] Session not active for agent ${a2aContext.agentType}, returning error`);
    if (actualSessionId) {
      await sessionManager.removeSession(actualSessionId).catch(() => {});
    }
    res.write(`data: ${JSON.stringify({
      type: 'error',
      error: 'Session expired or crashed. Please retry to start a fresh session.',
      code: 'SESSION_INACTIVE',
    })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
    return;
  }

  // --- Busy session handling ---
  // claudeSession.sendMessage() throws "Session is busy processing another request..."
  // when isProcessing is true (claudeSession.ts:198-199).
  // Note: handleSessionManagement() also throws SESSION_BUSY (sessionUtils.ts:104),
  // but that occurs BEFORE this try block and is caught by the outer catch at a2a.ts:1148,
  // which returns a 500 JSON response (correct, since SSE headers aren't set yet).
  // In the streaming reuse path, SSE headers are already sent (a2a.ts:956-959 flushHeaders),
  // so we can write SSE events directly.
  if (error instanceof Error && error.message.includes('busy processing')) {
    console.warn(`[A2A] Session busy for agent ${a2aContext.agentType}`);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      error: 'Session is busy processing another request. Please wait.',
      code: 'SESSION_BUSY',
    })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
    return;
  }
  console.error('[A2A] Error in streaming session:', error);
  const errorEvent = {
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
  };
  res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
  res.end();
}
```

### File 3: `backend/src/utils/sessionUtils.ts` (lines 95-106)

Add `isSessionActive()` check to prevent dead sessions from being reused. This fixes Bug 5.

#### Current code (lines 95-106):

```typescript
if (sessionId) {
  claudeSession = sessionManager.getSession(sessionId);

  if (claudeSession) {
    if (sessionManager.isSessionBusy(sessionId)) {
      throw new Error('SESSION_BUSY: ...');
    }
    console.log(`♻️  Using existing persistent Claude session: ${sessionId} for agent: ${agentId}`);
  } else {
    // ... check disk, create/resume
  }
}
```

#### Fixed code (lines 95-106):

```typescript
if (sessionId) {
  claudeSession = sessionManager.getSession(sessionId);

  if (claudeSession) {
    // Check if session subprocess is still alive (may have died from resume failure or crash)
    if (!claudeSession.isSessionActive()) {
      console.warn(`⚠️ Session ${sessionId} found but inactive (dead subprocess), removing and recreating`);
      await sessionManager.removeSession(sessionId);
      claudeSession = null;
      // Falls through to the "not in memory" path below to recreate
    } else if (sessionManager.isSessionBusy(sessionId)) {
      console.warn(`⚠️  Session ${sessionId} is currently busy processing another request`);
      throw new Error('SESSION_BUSY: This session is currently processing another request. Please wait for the current request to complete or create a new session.');
    } else {
      console.log(`♻️  Using existing persistent Claude session: ${sessionId} for agent: ${agentId}`);
    }
  }

  if (!claudeSession) {
    console.log(`❌ Session ${sessionId} not found in memory for agent: ${agentId}`);

    // Check if session history exists in project directory
    console.log(`🔍 Checking project directory for session history: ${sessionId}, projectPath: ${projectPath}`);
    const sessionExists = sessionManager.checkSessionExists(sessionId, projectPath);
    console.log(`📁 Session history exists: ${sessionExists} for sessionId: ${sessionId}`);

    if (sessionExists) {
      console.log(`🔄 Found session history for ${sessionId}, resuming session for agent: ${agentId}`);
      claudeSession = sessionManager.createNewSession(agentId, queryOptions, sessionId, claudeVersionId, modelId, configSnapshot);
    } else {
      console.log(`⚠️  Session ${sessionId} not found in memory or project history, creating new session for agent: ${agentId}`);
      claudeSession = sessionManager.createNewSession(agentId, queryOptions, undefined, claudeVersionId, modelId, configSnapshot);
    }
  }
}
```

**Key change**: After `getSession()` returns a session, check `isSessionActive()`. If false (subprocess crashed), remove from SessionManager and fall through to the recreate path. This also benefits `agents.ts` which uses the same `handleSessionManagement` function.

**Structural refactor**: The `if (claudeSession) { ... } else { ... }` is split into two sequential checks: first handle the found-but-dead case (set `claudeSession = null`), then handle the not-found case (recreate). This avoids duplicating the recreate logic.

### No changes needed

| File | Reason |
|------|--------|
| `weknora-ui/src/api/a2a/stream.ts` | Frontend checks `data.session_id \|\| data.sessionId` — already compatible |
| `weknora-ui/src/views/a2a-chat/index.vue` | `onSessionCreated` callback works with any sessionId source |
| `backend/src/services/claudeSession.ts` | Streaming Input Mode fully implemented. `isSessionActive()` method already exists (line 358). |
| `backend/src/services/sessionManager.ts` | Cleanup, heartbeat, config detection all working |
| `backend/src/services/messageQueue.ts` | No changes |
| `backend/src/services/a2a/a2aQueryService.ts` | Retained for `sessionMode='new'` (still available) |

### Backward compatibility

- `sessionMode='new'` code is NOT deleted. Any A2A caller can still explicitly pass `sessionMode: 'new'` to use one-shot mode.
- SSE event format is unchanged: `{ ...sdkMessage, sessionId, timestamp }` + final `{ type: 'done' }`.
- A2A history file format is unchanged: JSONL at `{workingDir}/.a2a/history/{sessionId}.jsonl`.
- File 3 change also fixes `agents.ts` (which uses the same `handleSessionManagement`), making dead-session recovery consistent across all chat paths.

### Known limitations (out of scope)

- **Synchronous `reuse` path** (`a2a.ts:1067-1113`) has Bug 2/3/4 for new sessions (null sessionId guards). Bug 1 is partially fixed: `confirmSessionId` is called (line 1111) but without `configSnapshot`. This path is rarely used for A2A and is not addressed in this migration. If needed, the same fix pattern can be applied later.
- **First-message async resume failure**: When `handleSessionManagement` creates a new session with `resume=sessionId` and the resume fails asynchronously during `startBackgroundResponseHandler` iteration (claudeSession.ts:237), the error is caught internally (line 279, `isActive=false`) but the pending SSE callback is never notified. The SSE stream hangs until client timeout. File 3 prevents this on **subsequent messages** (dead session detected and recreated), but the **first message** to a freshly-resumed corrupted session will still hang. This is a pre-existing issue in `ClaudeSession` (also affects `agents.ts`) and requires background-handler-to-callback error propagation to fix properly. The scenario is rare: requires a `.jsonl` file that passes `checkSessionExists` but causes SDK subprocess crash during resume.
- **Per-user loop isolation**: `reuse` mode enables SDK loop features, but user-level isolation of loops is a separate concern to be addressed independently.

## SSE Event Comparison (Before vs After)

### First message, new session

**Before (sessionMode='new'):**
```
data: {"type":"system","subtype":"init","session_id":"S1","sessionId":"S1","timestamp":...}
data: {"type":"content_block_start",...,"sessionId":"S1","timestamp":...}
data: {"type":"content_block_delta",...,"sessionId":"S1","timestamp":...}
data: {"type":"result",...,"sessionId":"S1","timestamp":...}
data: {"type":"done"}
```

**After (sessionMode='reuse', fixed):**
```
data: {"type":"system","subtype":"init","session_id":"S1","sessionId":"S1","timestamp":...}
data: {"type":"content_block_start",...,"sessionId":"S1","timestamp":...}
data: {"type":"content_block_delta",...,"sessionId":"S1","timestamp":...}
data: {"type":"result",...,"sessionId":"S1","timestamp":...}
data: {"type":"done"}
```

Identical. The `sessionId` field now has the correct value (captured from `system.init` before building `eventData`).

### Second message, same session

**Before (sessionMode='new'):** New subprocess spawned, resume from disk.

**After (sessionMode='reuse'):** Same subprocess, `messageQueue.push()`. No subprocess spawn, no disk I/O.

## Session Lifecycle (After Migration)

```
User opens new chat, sends message 1:
  POST /a2a/agent/messages { message: "hello" }  (no sessionId)
  -> handleSessionManagement('reuse', null) -> createNewSession() -> tempSessions
  -> sendMessage() -> SDK processes -> system.init { session_id: "S1" }
  -> callback: capturedSessionId = "S1"
  -> confirmSessionId(session, "S1") -> tempSessions -> sessions Map
  -> SSE events with sessionId: "S1"
  -> A2A history written to S1.jsonl
  -> Frontend captures S1, creates WeKnora session

User sends message 2 (same chat):
  POST /a2a/agent/messages { sessionId: "S1" }
  -> handleSessionManagement('reuse', "S1") -> getSession("S1") -> FOUND (confirmed!)
  -> isSessionActive? -> true ✓
  -> sendMessage() -> messageQueue.push() -> same subprocess handles it
  -> SSE events with sessionId: "S1"
  -> No new process. Zero startup overhead.

User switches to history chat S2:
  POST /a2a/agent/messages { sessionId: "S2" }
  -> getSession("S2") -> NOT FOUND (different session or cleaned up)
  -> checkSessionExists("S2") -> SDK .jsonl exists on disk
  -> createNewSession(resume="S2") -> new subprocess with history
  -> sessions.set("S2", session)  // directly in sessions (has resumeSessionId)

30 minutes idle on S1:
  -> cleanupIdleSessions() -> removeSession("S1") -> session.close() -> process exits
  -> User comes back -> same flow as "switches to history chat"

Dead session recovery (Bug 5 fix):
  Session S1 subprocess crashed earlier (isActive=false, still in sessions Map)
  POST /a2a/agent/messages { sessionId: "S1" }
  -> getSession("S1") -> FOUND
  -> isSessionActive? -> false ← File 3 fix catches this
  -> removeSession("S1") -> clean up dead session
  -> Falls through to recreate: checkSessionExists -> createNewSession(resume="S1")
  -> Fresh subprocess. Transparent to user.
```

## Verification Checklist

After implementation, verify these scenarios:

- [ ] **New session, first message**: Frontend receives `sessionId` in SSE events (not null). A2A history file created. Session confirmed in SessionManager.
- [ ] **Same session, second message**: `getSession()` returns the session. No new subprocess. Response uses same process.
- [ ] **Switch to history session**: Resume works. New subprocess created with history context.
- [ ] **30-min idle then resume**: Session cleaned up, then resumed from disk.
- [ ] **Rapid double-send**: SESSION_BUSY error returned properly via SSE. Frontend does not crash.
- [ ] **Agent config change between messages**: `hasConfigChanged()` detects it. Old session removed, new one created.
- [ ] **Dead session recovery (Bug 5)**: Session with `isActive=false` is detected by `isSessionActive()` check, removed, and recreated. User sees normal response, not "Session is not active" error.
- [ ] **Resume failure (corrupted .jsonl)**: Known limitation — first message to a corrupted session may hang. Second message triggers dead-session recovery (File 3 fix). Verify the second message recovers correctly.
- [ ] **Frontend history load**: `getA2AHistory()` returns events. Messages display correctly.
- [ ] **AskUserQuestion tool**: Pending inputs matched correctly with updated sessionId.
- [ ] **Explicit `sessionMode:'new'` regression**: Sending `sessionMode: 'new'` explicitly still uses one-shot mode (no session reuse).

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Process memory from long-lived sessions | Low | 30-min idle cleanup exists. Same behavior as `/api/agents/chat`. |
| SESSION_BUSY on rapid sends | Medium | Two-layer handling: `handleSessionManagement` returns 500 JSON (pre-SSE); `sendMessage` returns SSE error event (in-stream). Frontend can show "please wait". |
| Orphan processes during migration | Low | Existing `tempSessions` cleanup handles this. 30-min max lifetime. |
| `new` mode callers break | None | Default changed, but explicit `sessionMode:'new'` still works. |
| Dead session reuse | Low | File 3 adds `isSessionActive()` check. File 2 adds `SESSION_INACTIVE` catch. Only uncovered case: first message to freshly-resumed corrupted .jsonl (rare, documented as known limitation). |
| Resume failure SSE hang (first message) | Low | Rare scenario (requires corrupted .jsonl that passes `existsSync` but crashes subprocess). Pre-existing in `agents.ts` too. Proper fix requires `ClaudeSession` background-handler-to-callback error propagation (separate improvement). |

## SESSION_BUSY Error Handling: Two Layers

There are two independent SESSION_BUSY checks. They trigger at different points in the request lifecycle:

| Check Point | Location | When | Error Format |
|-------------|----------|------|--------------|
| `handleSessionManagement` | sessionUtils.ts:102-104 | Before SSE headers sent | 500 JSON `{ error: "SESSION_BUSY: ..." }` — caught by outer catch (a2a.ts:1148) |
| `claudeSession.sendMessage` | claudeSession.ts:198-199 | After SSE headers sent | SSE event `{ type: "error", code: "SESSION_BUSY" }` + `{ type: "done" }` |

The first check (`sessionManager.isSessionBusy(sessionId)`) queries the `sessions` Map. The second check (`this.isProcessing`) is on the `ClaudeSession` instance. Both are needed because a session could become busy between the first check and the `sendMessage` call (race condition window).

## Rollback Strategy

实施前记录当前 commit hash：

```bash
cd agentstudio && git rev-parse HEAD
# 记下此 hash，用于完整回滚
```

### Level 1：最快回滚（只还原默认值）

weknora-ui 从不发送 `sessionMode`，只需将默认值改回 `'new'`，所有流量立即走回原路径。Bug 修复代码留在代码库中但不会被执行，零风险。

```bash
cd agentstudio
git revert <commit: feat: change A2A sessionMode default> --no-edit
```

或手动修改 `backend/src/schemas/a2a.ts:37`：

```
sessionMode: SessionModeSchema.optional().default('new'),
```

### Level 2：完整回滚（还原全部改动）

逐个 revert（保留 git 历史，推荐）：

```bash
cd agentstudio
git revert <commit-4: feat: change default>   --no-edit
git revert <commit-3: fix: reuse streaming>    --no-edit
git revert <commit-2: fix: dead session>       --no-edit
git revert <commit-1: test: add tests>         --no-edit
```

或直接 reset（丢弃历史，慎用）：

```bash
cd agentstudio
git reset --hard <implementation-前的commit-hash>
```

### 推荐

优先使用 Level 1。File 2（流式回调修复）和 File 3（dead session 检测）是防御性代码，即使留着也不影响 `sessionMode='new'` 路径，且 File 3 对 `agents.ts` 聊天路径同样有益。
