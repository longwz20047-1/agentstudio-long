# A2A Session Reuse Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate A2A chat from `sessionMode='new'` (one-shot subprocess per message) to `sessionMode='reuse'` (persistent ClaudeSession), fixing 5 bugs in the existing reuse streaming path.

**Architecture:** 3 files changed in `agentstudio/backend/`. File 3 (sessionUtils.ts) adds dead-session detection. File 2 (a2a.ts) fixes the streaming callback with session confirmation, deferred history writes, and structured error handling. File 1 (schemas/a2a.ts) flips the default. Order: File 3 first (safest, benefits all paths), then File 2 (core fix), then File 1 (activates the change).

**Tech Stack:** TypeScript, Express, Vitest, Claude Agent SDK

**Spec:** `agentstudio/docs/plans/2026-03-12-a2a-session-reuse-migration-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/src/utils/sessionUtils.ts` | Modify (lines 95-124) | Add `isSessionActive()` check before returning cached session (Bug 5) |
| `backend/src/utils/__tests__/sessionUtils.test.ts` | Modify | Add tests for dead-session detection + removal |
| `backend/src/routes/a2a.ts` | Modify (lines 988-1033) | Fix reuse streaming callback: session confirmation, deferred history, error handling (Bug 1-4) |
| `backend/src/schemas/a2a.ts` | Modify (line 37) | Change `sessionMode` default from `'new'` to `'reuse'` |

---

## Chunk 1: File 3 — Dead Session Detection (sessionUtils.ts)

### Task 1: Add tests for dead-session detection

**Files:**
- Modify: `backend/src/utils/__tests__/sessionUtils.test.ts`

- [ ] **Step 1: Add mock for `removeSession` to sessionManager mock**

In `sessionUtils.test.ts`, the sessionManager mock (lines 16-23) needs `removeSession` added.

Find this block at line 16:
```typescript
vi.mock('../../services/sessionManager', () => ({
  sessionManager: {
    getSession: vi.fn(),
    checkSessionExists: vi.fn(),
    createNewSession: vi.fn(),
    isSessionBusy: vi.fn().mockReturnValue(false)
  }
}));
```

Replace with:
```typescript
vi.mock('../../services/sessionManager', () => ({
  sessionManager: {
    getSession: vi.fn(),
    checkSessionExists: vi.fn(),
    createNewSession: vi.fn(),
    isSessionBusy: vi.fn().mockReturnValue(false),
    removeSession: vi.fn().mockResolvedValue(true)
  }
}));
```

- [ ] **Step 1b: Update existing mock session to include `isSessionActive()`**

After File 3 change, `handleSessionManagement` calls `claudeSession.isSessionActive()` on every session returned from `getSession()`. The existing test at line 48 uses a bare mock `{ id: 'existing-session' }` without this method, which will throw `TypeError`.

Find line 48:
```typescript
      const mockSession = { id: 'existing-session' };
```

Replace with:
```typescript
      const mockSession = { id: 'existing-session', isSessionActive: () => true };
```

Note: The other existing tests ("resume session if history exists" at line 66 and "create new session if no history found" at line 92) mock `getSession` returning `null`, so they skip the `isSessionActive` check and need no change.

- [ ] **Step 2: Add test — dead session detected and recreated from disk**

Add inside the `describe('handleSessionManagement', ...)` block, after the existing tests (after line 139):

```typescript
    it('should remove dead session and recreate from disk history', async () => {
      const deadSession = { id: 'dead-session', isSessionActive: () => false };
      const freshSession = { id: 'fresh-session' };
      const { sessionManager } = await import('../../services/sessionManager');

      vi.mocked(sessionManager.getSession).mockReturnValue(deadSession as any);
      vi.mocked(sessionManager.removeSession).mockResolvedValue(true);
      vi.mocked(sessionManager.checkSessionExists).mockReturnValue(true);
      vi.mocked(sessionManager.createNewSession).mockReturnValue(freshSession as any);

      const result = await handleSessionManagement(
        mockAgent,
        'dead-session',
        '/test/path',
        mockQueryOptions
      );

      expect(sessionManager.removeSession).toHaveBeenCalledWith('dead-session');
      expect(sessionManager.checkSessionExists).toHaveBeenCalledWith('dead-session', '/test/path');
      expect(sessionManager.createNewSession).toHaveBeenCalledWith(
        mockAgent,
        mockQueryOptions,
        'dead-session',  // resume from disk
        undefined,
        undefined
      );
      expect(result.claudeSession).toBe(freshSession);
    });
```

- [ ] **Step 3: Add test — dead session detected, no disk history, creates fresh**

```typescript
    it('should remove dead session and create fresh when no disk history', async () => {
      const deadSession = { id: 'dead-session', isSessionActive: () => false };
      const freshSession = { id: 'fresh-session' };
      const { sessionManager } = await import('../../services/sessionManager');

      vi.mocked(sessionManager.getSession).mockReturnValue(deadSession as any);
      vi.mocked(sessionManager.removeSession).mockResolvedValue(true);
      vi.mocked(sessionManager.checkSessionExists).mockReturnValue(false);
      vi.mocked(sessionManager.createNewSession).mockReturnValue(freshSession as any);

      const result = await handleSessionManagement(
        mockAgent,
        'dead-session',
        '/test/path',
        mockQueryOptions
      );

      expect(sessionManager.removeSession).toHaveBeenCalledWith('dead-session');
      expect(sessionManager.createNewSession).toHaveBeenCalledWith(
        mockAgent,
        mockQueryOptions,
        undefined,  // no resume, fresh session
        undefined,
        undefined
      );
      expect(result.claudeSession).toBe(freshSession);
    });
```

- [ ] **Step 4: Add test — active session still reused (no regression)**

```typescript
    it('should reuse active session without removal', async () => {
      const activeSession = { id: 'active-session', isSessionActive: () => true };
      const { sessionManager } = await import('../../services/sessionManager');

      vi.mocked(sessionManager.getSession).mockReturnValue(activeSession as any);

      const result = await handleSessionManagement(
        mockAgent,
        'active-session',
        '/test/path',
        mockQueryOptions
      );

      expect(sessionManager.removeSession).not.toHaveBeenCalled();
      expect(result.claudeSession).toBe(activeSession);
      expect(result.actualSessionId).toBe('active-session');
    });
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd agentstudio/backend && npx vitest run src/utils/__tests__/sessionUtils.test.ts`

Expected: The 2 dead-session tests ("dead session detected and recreated from disk" and "dead session detected, no disk history") FAIL because `sessionUtils.ts` doesn't call `isSessionActive()` yet. The code goes to the "use existing" path instead of removing the dead session.

The "active session still reused" test and all 4 existing tests should PASS (existing behavior preserved, mock session updated with `isSessionActive: () => true`).

- [ ] **Step 6: Commit test additions**

```bash
cd agentstudio && git add backend/src/utils/__tests__/sessionUtils.test.ts
git commit -m "test: add dead-session detection tests for handleSessionManagement"
```

### Task 2: Implement dead-session detection in sessionUtils.ts

**Files:**
- Modify: `backend/src/utils/sessionUtils.ts:95-124`

- [ ] **Step 1: Replace the `if (claudeSession)` block**

In `sessionUtils.ts`, replace lines 95-124 (the entire `if (sessionId)` block body):

Current code (lines 95-124):
```typescript
  if (sessionId) {
    // Try to reuse existing session from SessionManager cache
    console.log(`🔍 Looking for existing session: ${sessionId} for agent: ${agentId}`);
    claudeSession = sessionManager.getSession(sessionId);

    if (claudeSession) {
      // 并发控制：检查会话是否正在处理其他请求
      if (sessionManager.isSessionBusy(sessionId)) {
        console.warn(`⚠️  Session ${sessionId} is currently busy processing another request`);
        throw new Error('SESSION_BUSY: This session is currently processing another request. Please wait for the current request to complete or create a new session.');
      }
      console.log(`♻️  Using existing persistent Claude session: ${sessionId} for agent: ${agentId}`);
    } else {
      console.log(`❌ Session ${sessionId} not found in memory for agent: ${agentId}`);

      // Check if session history exists in project directory
      console.log(`🔍 Checking project directory for session history: ${sessionId}, projectPath: ${projectPath}`);
      const sessionExists = sessionManager.checkSessionExists(sessionId, projectPath);
      console.log(`📁 Session history exists: ${sessionExists} for sessionId: ${sessionId}`);

      if (sessionExists) {
        // Session history exists, resume session
        console.log(`🔄 Found session history for ${sessionId}, resuming session for agent: ${agentId}`);
        claudeSession = sessionManager.createNewSession(agentId, queryOptions, sessionId, claudeVersionId, modelId, configSnapshot);
      } else {
        // Session history not found, create new session but keep original sessionId for frontend
        console.log(`⚠️  Session ${sessionId} not found in memory or project history, creating new session for agent: ${agentId}`);
        claudeSession = sessionManager.createNewSession(agentId, queryOptions, undefined, claudeVersionId, modelId, configSnapshot);
      }
    }
```

Replace with:
```typescript
  if (sessionId) {
    // Try to reuse existing session from SessionManager cache
    console.log(`🔍 Looking for existing session: ${sessionId} for agent: ${agentId}`);
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
```

Key structural change: `if (claudeSession) { ... } else { ... }` becomes two sequential checks. The dead-session case sets `claudeSession = null` and falls through to the recreate block.

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd agentstudio/backend && npx vitest run src/utils/__tests__/sessionUtils.test.ts`

Expected: ALL tests pass, including the 3 new dead-session tests and the 4 existing tests.

- [ ] **Step 3: Run full backend type-check**

Run: `cd agentstudio && pnpm run type-check`

Expected: No new type errors. The `claudeSession` variable is typed as `any` (sessionUtils.ts:44), so `isSessionActive()` call compiles without issue.

- [ ] **Step 4: Commit**

```bash
cd agentstudio && git add backend/src/utils/sessionUtils.ts
git commit -m "fix: detect and recover dead sessions in handleSessionManagement (Bug 5)"
```

---

## Chunk 2: File 2 — Reuse Streaming Callback Fix (a2a.ts)

### Task 3: Fix reuse streaming callback (Bug 1-4)

**Files:**
- Modify: `backend/src/routes/a2a.ts:988-1033`

This is the core fix. The existing streaming callback uses `const actualSessionId` (null for new sessions) throughout. The fix adds:
1. Mutable `capturedSessionId` tracking variable
2. Session confirmation from `system.init` message
3. Deferred user message save
4. Correct sessionId in all SSE events and history writes
5. Structured error handling for SESSION_INACTIVE and SESSION_BUSY

- [ ] **Step 1: Add tracking variables before the user message save block**

In `a2a.ts`, find line 988 (the `if (actualSessionId)` block for user message save). Insert BEFORE it (after line 987, after the `historyUserMessage` construction):

```typescript
        let capturedSessionId: string | null = actualSessionId;
        let userMessageSaved = false;
```

- [ ] **Step 2: Replace the user message save block (lines 989-1000)**

Replace lines 989-1000:
```typescript
        if (actualSessionId) {
          const userHistoryEvent = {
            ...historyUserMessage,
            sessionId: actualSessionId,
            timestamp: Date.now(),
          };
          try {
            await a2aHistoryService.appendEvent(a2aContext.workingDirectory, actualSessionId, userHistoryEvent);
          } catch (err) {
            console.error('[A2A] Failed to write user message to history:', err);
          }
        }
```

Replace with:
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

Only change: added `userMessageSaved = true;` after the successful write.

- [ ] **Step 3: Replace the streaming callback (lines 1002-1033)**

Replace lines 1002-1033 (the entire `try { await claudeSession.sendMessage(...) } catch { ... }` block):

Current:
```typescript
        try {
          await claudeSession.sendMessage(sdkUserMessage, async (sdkMessage: SDKMessage) => {
            const eventData = {
              ...sdkMessage,
              sessionId: actualSessionId,
              timestamp: Date.now(),
            };

            res.write(`data: ${JSON.stringify(eventData)}\n\n`);

            try {
              if (actualSessionId) {
                await a2aHistoryService.appendEvent(a2aContext.workingDirectory, actualSessionId, eventData);
              }
            } catch (err) {
              console.error('[A2A] Failed to write history event:', err);
            }

            if (sdkMessage.type === 'result') {
              res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
              res.end();
            }
          });
        } catch (error) {
          console.error('[A2A] Error in streaming session:', error);
          const errorEvent = {
            type: 'error',
            error: error instanceof Error ? error.message : String(error)
          };
          res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
          res.end();
        }
```

Replace with:
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
          // File 3 (sessionUtils.ts) adds a proactive check, but this handles the race condition.
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

- [ ] **Step 4: Run type-check**

Run: `cd agentstudio && pnpm run type-check`

Expected: No new type errors. All variables used (`capturedSessionId`, `userMessageSaved`, `configSnapshot`, `askUserSessionRef`, `userInputRegistry`, `sessionManager`, `historyUserMessage`, `a2aHistoryService`) are already in scope from the surrounding closure.

- [ ] **Step 5: Commit**

```bash
cd agentstudio && git add backend/src/routes/a2a.ts
git commit -m "fix: reuse streaming callback - session confirmation, history, error handling (Bug 1-4)"
```

---

## Chunk 3: File 1 — Flip the Default + Verification

### Task 4: Change sessionMode default

**Files:**
- Modify: `backend/src/schemas/a2a.ts:37`

- [ ] **Step 1: Change the default value**

In `schemas/a2a.ts` line 37, replace:
```typescript
  sessionMode: SessionModeSchema.optional().default('new'),
```

With:
```typescript
  sessionMode: SessionModeSchema.optional().default('reuse'),
```

- [ ] **Step 2: Run type-check**

Run: `cd agentstudio && pnpm run type-check`

Expected: No type errors.

- [ ] **Step 3: Run all existing tests to verify no regression**

Run: `cd agentstudio/backend && npx vitest run`

Expected: All existing tests pass. The schema default change should not break any test since tests that use the schema either pass `sessionMode` explicitly or don't depend on the default value.

- [ ] **Step 4: Commit**

```bash
cd agentstudio && git add backend/src/schemas/a2a.ts
git commit -m "feat: change A2A sessionMode default from 'new' to 'reuse'"
```

### Task 5: Manual verification

This task follows the verification checklist from the spec. Requires a running backend + frontend.

- [ ] **Step 1: Start backend**

Run: `cd agentstudio && pnpm run dev:backend`

- [ ] **Step 2: New session, first message**

Open weknora-ui, start a new A2A chat, send a message.

Verify:
- SSE events contain `sessionId` (not null) in every event
- Backend logs show `[A2A reuse] Confirmed session <id>`
- A2A history file created at `{workingDir}/.a2a/history/{sessionId}.jsonl`

- [ ] **Step 3: Same session, second message**

Send a second message in the same chat.

Verify:
- Backend logs show `Using existing persistent Claude session`
- No `Created new` or `Resuming session` logs
- Response uses same subprocess (no startup delay)

- [ ] **Step 4: Reload and check history**

Reload the page, open the same chat from history.

Verify:
- Chat history loads correctly with both messages
- Session ID preserved in frontend

- [ ] **Step 5: Explicit sessionMode='new' regression**

Use curl or API client to send a message with `sessionMode: 'new'` explicitly:

```bash
curl -X POST http://localhost:4936/api/a2a/<agentId>/messages?stream=true \
  -H "x-api-key: <key>" \
  -H "Content-Type: application/json" \
  -d '{"message": "test", "sessionMode": "new"}'
```

Verify: Uses one-shot mode (backend logs show `sessionMode=new`, uses `executeA2AQueryStreaming`).

- [ ] **Step 6: Update spec status**

In `agentstudio/docs/plans/2026-03-12-a2a-session-reuse-migration-design.md`, change:
```
> Status: Reviewed
```
To:
```
> Status: Implemented
```

- [ ] **Step 7: Final commit**

```bash
cd agentstudio && git add docs/plans/2026-03-12-a2a-session-reuse-migration-design.md
git commit -m "docs: mark A2A session reuse migration as implemented"
```
