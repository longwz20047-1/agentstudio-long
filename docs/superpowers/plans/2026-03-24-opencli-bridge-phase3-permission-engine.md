# Phase 3: Permission Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add permission layer to OpenCLI tool execution — read operations auto-execute, write operations require user confirmation with session-level approval caching.

**Architecture:** Insert permission check in `opencliMcpFactory.ts` tool handler before `commandProxy.dispatch()`. New `permissionEngine.ts` module handles classification + approval cache. Uses `userInputRegistry.waitForUserInput()` for confirmation prompts with 3-minute timeout via `Promise.race`.

**Tech Stack:** TypeScript, Vitest, userInputRegistry (existing)

**Spec:** `docs/superpowers/specs/2026-03-24-opencli-bridge-phase3-permission-engine-design.md`

---

### Task 1: Create permissionEngine.ts — classification + cache

**Files:**
- Create: `backend/src/services/opencli/permissionEngine.ts`
- Reference: `backend/src/services/opencli/constants.ts` (WRITE_OPERATIONS, DOMAIN_MAPPING)

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/opencli/__tests__/permissionEngine.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isWriteOperation,
  hasSessionApproval,
  grantSessionApproval,
  clearSessionApprovals,
  buildConfirmationPrompt,
} from '../permissionEngine.js';

describe('permissionEngine', () => {
  describe('isWriteOperation', () => {
    // Known write operations
    it('returns true for twitter/post', () => {
      expect(isWriteOperation('twitter', 'post')).toBe(true);
    });
    it('returns true for boss/greet', () => {
      expect(isWriteOperation('boss', 'greet')).toBe(true);
    });
    it('returns true for notion/write', () => {
      expect(isWriteOperation('notion', 'write')).toBe(true);
    });

    // Known read operations
    it('returns false for twitter/timeline', () => {
      expect(isWriteOperation('twitter', 'timeline')).toBe(false);
    });
    it('returns false for bilibili/search', () => {
      expect(isWriteOperation('bilibili', 'search')).toBe(false);
    });

    // Download operations (auto-execute)
    it('returns false for twitter/download', () => {
      expect(isWriteOperation('twitter', 'download')).toBe(false);
    });
    it('returns false for bilibili/download', () => {
      expect(isWriteOperation('bilibili', 'download')).toBe(false);
    });

    // Export operations (auto-execute)
    it('returns false for any site/export', () => {
      expect(isWriteOperation('twitter', 'export')).toBe(false);
    });

    // Unknown site defaults to write
    it('returns true for unknown-site/unknown-action', () => {
      expect(isWriteOperation('unknown-site', 'something')).toBe(true);
    });

    // Known site, unknown action defaults to read
    it('returns false for twitter/some-new-read-action', () => {
      expect(isWriteOperation('twitter', 'some-new-read-action')).toBe(false);
    });
  });

  describe('session approval cache', () => {
    const sessionId = 'test-session-1';

    beforeEach(() => {
      clearSessionApprovals(sessionId);
    });

    it('returns false when no approval granted', () => {
      expect(hasSessionApproval(sessionId, 'twitter', 'post')).toBe(false);
    });

    it('returns true after granting approval', () => {
      grantSessionApproval(sessionId, 'twitter', 'post');
      expect(hasSessionApproval(sessionId, 'twitter', 'post')).toBe(true);
    });

    it('approval is scoped to site/action', () => {
      grantSessionApproval(sessionId, 'twitter', 'post');
      expect(hasSessionApproval(sessionId, 'twitter', 'reply')).toBe(false);
    });

    it('approval is scoped to session', () => {
      grantSessionApproval(sessionId, 'twitter', 'post');
      expect(hasSessionApproval('other-session', 'twitter', 'post')).toBe(false);
    });

    it('clearSessionApprovals removes all approvals for session', () => {
      grantSessionApproval(sessionId, 'twitter', 'post');
      grantSessionApproval(sessionId, 'boss', 'greet');
      clearSessionApprovals(sessionId);
      expect(hasSessionApproval(sessionId, 'twitter', 'post')).toBe(false);
      expect(hasSessionApproval(sessionId, 'boss', 'greet')).toBe(false);
    });
  });

  describe('buildConfirmationPrompt', () => {
    it('includes site and action', () => {
      const prompt = buildConfirmationPrompt('twitter', 'post', ['post', 'Hello world']);
      expect(prompt).toContain('twitter');
      expect(prompt).toContain('post');
    });

    it('includes the command args', () => {
      const prompt = buildConfirmationPrompt('twitter', 'post', ['post', 'Hello world']);
      expect(prompt).toContain('Hello world');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/opencli/__tests__/permissionEngine.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/services/opencli/permissionEngine.ts`:

```typescript
import { WRITE_OPERATIONS, DOMAIN_MAPPING } from './constants.js';

// Flatten all known sites from DOMAIN_MAPPING
const ALL_KNOWN_SITES = new Set(Object.values(DOMAIN_MAPPING).flat());

const DOWNLOAD_ACTIONS = new Set(['download']);
const READ_SAFE_ACTIONS = new Set(['export']);

// Session approval cache: Map<sessionId, Set<"site/action">>
const approvalCache = new Map<string, Set<string>>();

/**
 * Determine if a site/action combination is a write operation.
 * - Known write operations → true
 * - Download/export actions → false (auto-execute)
 * - Known site + unknown action → false (assume read)
 * - Unknown site + unknown action → true (safe default)
 */
export function isWriteOperation(site: string, action: string): boolean {
  // Download and export are always safe
  if (DOWNLOAD_ACTIONS.has(action)) return false;
  if (READ_SAFE_ACTIONS.has(action)) return false;

  // Check explicit write list
  const siteWrites = WRITE_OPERATIONS[site];
  if (siteWrites?.includes(action)) return true;

  // Known site but action not in write list → read
  if (ALL_KNOWN_SITES.has(site)) return false;

  // Unknown site → default to write (safe)
  return true;
}

export function hasSessionApproval(sessionId: string, site: string, action: string): boolean {
  const key = `${site}/${action}`;
  return approvalCache.get(sessionId)?.has(key) ?? false;
}

export function grantSessionApproval(sessionId: string, site: string, action: string): void {
  const key = `${site}/${action}`;
  if (!approvalCache.has(sessionId)) {
    approvalCache.set(sessionId, new Set());
  }
  approvalCache.get(sessionId)!.add(key);
}

export function clearSessionApprovals(sessionId: string): void {
  approvalCache.delete(sessionId);
}

/**
 * Build a human-readable confirmation prompt for the user.
 */
export function buildConfirmationPrompt(site: string, action: string, args: string[]): string {
  const command = `opencli ${site} ${args.join(' ')}`;
  return [
    `OpenCLI Write Operation Confirmation`,
    ``,
    `${site}/${action} wants to execute a write operation.`,
    ``,
    `Command: ${command}`,
    ``,
    `This will modify data on ${site}. Reply "confirm" to proceed or "reject" to cancel.`,
    `(Approval remembered for this session. Timeout: 3 minutes)`,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/services/opencli/__tests__/permissionEngine.test.ts`
Expected: All 14 tests PASS

- [ ] **Step 5: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/permissionEngine.ts backend/src/services/opencli/__tests__/permissionEngine.test.ts
git commit -m "feat(opencli): add permissionEngine with classification + session cache"
```

---

### Task 2: Integrate permission check into opencliMcpFactory.ts

**Files:**
- Modify: `backend/src/services/opencli/opencliMcpFactory.ts:43-99` (integrateOpenCliMcpServers + tool handler)
- Reference: `backend/src/services/askUserQuestion/userInputRegistry.ts` (waitForUserInput)
- Reference: `backend/src/services/opencli/constants.ts` (WRITE_COMMAND_TIMEOUT)

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/opencli/__tests__/permissionCheck.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isWriteOperation } from '../permissionEngine.js';
import { WRITE_COMMAND_TIMEOUT, DEFAULT_COMMAND_TIMEOUT } from '../constants.js';

describe('permission check integration', () => {
  it('isWriteOperation returns true for write ops', () => {
    expect(isWriteOperation('twitter', 'post')).toBe(true);
  });

  it('isWriteOperation returns false for read ops', () => {
    expect(isWriteOperation('twitter', 'timeline')).toBe(false);
  });

  it('WRITE_COMMAND_TIMEOUT is 60 seconds', () => {
    expect(WRITE_COMMAND_TIMEOUT).toBe(60000);
  });

  it('DEFAULT_COMMAND_TIMEOUT is 30 seconds', () => {
    expect(DEFAULT_COMMAND_TIMEOUT).toBe(30000);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (baseline)**

Run: `cd backend && npx vitest run src/services/opencli/__tests__/permissionCheck.test.ts`
Expected: PASS (baseline sanity check)

- [ ] **Step 3: Modify opencliMcpFactory.ts**

Changes to `integrateOpenCliMcpServers`:

1. Change function signature — use `askUserSessionRef` (remove `_` prefix) and add `sessionId` parameter:

```typescript
export async function integrateOpenCliMcpServers(
  queryOptions: any,
  opencliContext: OpenCliContext,
  askUserSessionRef: any,
  agentId: string,
  sessionId?: string
): Promise<void> {
```

2. Add imports at top:

```typescript
import { DOMAIN_MAPPING, WRITE_COMMAND_TIMEOUT, DEFAULT_COMMAND_TIMEOUT } from './constants.js';
import { isWriteOperation, hasSessionApproval, grantSessionApproval, buildConfirmationPrompt } from './permissionEngine.js';
import { userInputRegistry } from '../askUserQuestion/userInputRegistry.js';
import { v4 as uuidv4 } from 'uuid';
```

3. Inside the tool handler (the `async (args) => {` callback at line 75), insert permission check BEFORE the `commandProxy.dispatch()` call:

```typescript
        async (args) => {
          const cliArgs: string[] = [args.action];
          if (args.query) cliArgs.push(args.query);
          if (args.limit !== undefined) cliArgs.push('--limit', String(args.limit));
          if (args.id) cliArgs.push('--id', args.id);
          if (args.options) {
            for (const [k, v] of Object.entries(args.options)) {
              cliArgs.push(`--${k}`, v);
            }
          }

          // --- Permission check for write operations ---
          if (isWriteOperation(site, args.action)) {
            const effectiveSessionId = askUserSessionRef?.current || sessionId || '';
            if (effectiveSessionId && !hasSessionApproval(effectiveSessionId, site, args.action)) {
              const CONFIRMATION_TIMEOUT = 3 * 60 * 1000;
              const prompt = buildConfirmationPrompt(site, args.action, cliArgs);
              const toolUseId = `opencli-confirm-${uuidv4()}`;

              try {
                let timeoutId: NodeJS.Timeout;
                const response = await Promise.race([
                  userInputRegistry.waitForUserInput(
                    effectiveSessionId,
                    agentId,
                    toolUseId,
                    [{ question: prompt, header: 'OpenCLI Permission' }]
                  ),
                  new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(
                      () => reject(new Error('Confirmation timed out (3 min). Please retry the command.')),
                      CONFIRMATION_TIMEOUT
                    );
                  }),
                ]);
                clearTimeout(timeoutId!);

                const lower = response.toLowerCase().trim();
                if (lower.includes('reject') || lower.includes('cancel') || lower === 'no' || lower === 'n') {
                  return formatOpenCliError(site, args.action, 'User rejected the write operation.');
                }

                grantSessionApproval(effectiveSessionId, site, args.action);
              } catch (err) {
                clearTimeout(timeoutId!);
                // Clean up pending input on timeout
                try { userInputRegistry.cancelPendingInput(toolUseId); } catch {}
                return formatOpenCliError(site, args.action, (err as Error).message);
              }
            }
          }
          // --- End permission check ---

          try {
            const timeout = isWriteOperation(site, args.action) ? WRITE_COMMAND_TIMEOUT : DEFAULT_COMMAND_TIMEOUT;
            const stdout = await commandProxy.dispatch(projectId, userId, {
              site,
              action: args.action,
              args: cliArgs,
              timeout,
            });
            return formatOpenCliResult(site, args.action, stdout);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(`[OpenCLI] ${site}/${args.action} failed:`, msg);
            return formatOpenCliError(site, args.action, msg);
          }
        },
```

4. Update the `readOnlyHint` annotation to be dynamic:

```typescript
        { annotations: { readOnlyHint: !isWriteOperation(site, 'post'), openWorldHint: true } }
```

Wait — `readOnlyHint` is per-tool (per-site), not per-action. Keep it `false` (current value) since a site can have both read and write actions. No change needed here.

- [ ] **Step 4: Check if `cancelPendingInput` exists on userInputRegistry**

Run: `cd backend && grep -n "cancelPendingInput\|cancel.*pending\|removePending" src/services/askUserQuestion/userInputRegistry.ts`

If it doesn't exist, add a simple method or just skip the cleanup (best-effort). The timeout rejection already prevents the Promise from hanging. If the method doesn't exist, remove that line from the catch block.

- [ ] **Step 5: Update the call site in claudeUtils.ts**

In `backend/src/utils/claudeUtils.ts:596`, pass `sessionId` as 5th argument:

```typescript
await integrateOpenCliMcpServers(queryOptions, opencliContext, askUserSessionRef, agentIdForAskUser || '', tempSessionId);
```

- [ ] **Step 6: Run all opencli tests**

Run: `cd backend && npx vitest run src/services/opencli/`
Expected: All tests PASS

- [ ] **Step 7: Run type check**

Run: `cd agentstudio && pnpm run type-check`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/opencliMcpFactory.ts backend/src/utils/claudeUtils.ts backend/src/services/opencli/__tests__/permissionCheck.test.ts
git commit -m "feat(opencli): integrate permission check into MCP tool handler"
```

---

### Task 3: Session cleanup hook

**Files:**
- Modify: `backend/src/services/sessionManager.ts` (add clearSessionApprovals call in removeSession)

- [ ] **Step 1: Add import and cleanup call**

In `sessionManager.ts`, add import:

```typescript
import { clearSessionApprovals } from './opencli/permissionEngine.js';
```

In the `removeSession` method (around line 349), add cleanup BEFORE deleting the session:

```typescript
async removeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // ... existing code
    }

    // Clean up OpenCLI permission approvals
    clearSessionApprovals(sessionId);

    // ... rest of existing code (session.close(), delete from maps, etc.)
```

- [ ] **Step 2: Run session manager tests**

Run: `cd backend && npx vitest run src/services/__tests__/`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd agentstudio
git add backend/src/services/sessionManager.ts
git commit -m "feat(opencli): clear permission approvals on session cleanup"
```

---

### Task 4: Re-export and final verification

**Files:**
- Modify: `backend/src/services/opencli/index.ts` (add permissionEngine exports)

- [ ] **Step 1: Add re-exports**

In `backend/src/services/opencli/index.ts`, add:

```typescript
export { isWriteOperation, clearSessionApprovals } from './permissionEngine.js';
```

- [ ] **Step 2: Run full test suite**

Run: `cd backend && npx vitest run src/services/opencli/`
Expected: All tests PASS (permissionEngine.test.ts + permissionCheck.test.ts + existing tests)

- [ ] **Step 3: Run E2E type check**

Run: `cd agentstudio && pnpm run type-check`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/index.ts
git commit -m "feat(opencli): complete Phase 3 permission engine"
```

---

## Summary

| Task | Files | Lines (est.) |
|------|-------|-------------|
| 1. permissionEngine.ts + tests | 2 new | ~120 + ~100 |
| 2. opencliMcpFactory.ts integration | 2 modified, 1 new | ~40 + ~20 |
| 3. Session cleanup hook | 1 modified | ~3 |
| 4. Re-export + verification | 1 modified | ~2 |
| **Total** | **3 new, 4 modified** | **~285 lines** |
