# OpenCLI Bridge Phase 3: Permission Engine Design

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-24
**Depends on:** Phase 1 (Core Channel), Phase 2 (Pairing) — both completed
**Blocks:** Nothing (Phase 4 Management Console is independent)

---

## 1. Goal

Add a permission layer to OpenCLI tool execution: read operations auto-execute, write operations require user confirmation via AskUserQuestion with 3-minute timeout and session-level approval caching.

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Permission model | Read (auto) / Write (confirm) / Download (auto) | 214 read + 4 download commands are safe. 75 write commands modify external state. |
| Confirmation UX | First-confirm + session memory | Same site+action in one session only prompts once. Avoids confirmation fatigue for repeated operations (e.g., 3 tweets in a row). |
| Confirmation channel | Reuse AskUserQuestion `waitForUserInput()` | Already integrated with SSE → weknora-ui. No new infrastructure needed. |
| Timeout | 3 minutes for confirmation + 60s for bridge execution | Total ≤4 min, within Claude SDK's ~5-10 min tool timeout. Prevents orphaned Promises. |
| Unknown commands | Default to write (require confirmation) | New sites/actions not in whitelist are treated as potentially dangerous. |
| Cache scope | In-memory Map, per session | No persistence. Session cleanup auto-clears. Zero storage overhead. |

## 3. Command Classification

### 3.1 Write Operations (75 commands, require confirmation)

Defined in `constants.ts` `WRITE_OPERATIONS`:

| Site | Actions | Count |
|------|---------|-------|
| twitter | post, reply, delete, like, follow, unfollow, bookmark, unbookmark, accept, reply-dm, block, unblock, hide-reply | 13 |
| reddit | comment, upvote, save, subscribe | 4 |
| tiktok | comment, follow, like, save, unfollow, unlike, unsave | 7 |
| instagram | comment, follow, like, save, unfollow, unlike, unsave, add-friend | 8 |
| facebook | add-friend, join-group | 2 |
| boss | greet, batchgreet, send, invite, mark, exchange | 6 |
| jike | create, comment, like, repost | 4 |
| cursor | send, new, composer, ask | 4 |
| codex | send, new, ask | 3 |
| antigravity | send, new | 2 |
| chatgpt | send, new, ask | 3 |
| chatwise | send, new, ask | 3 |
| notion | write, new | 2 |
| discord-app | send | 1 |
| grok | ask | 1 |
| jimeng | generate | 1 |
| **Total** | | **64 listed** |

Plus ~11 commands from newer sites (douban, medium, substack, etc.) that default to write until audited.

### 3.2 Download Operations (4 commands, auto-execute)

| Site | Action |
|------|--------|
| bilibili | download |
| twitter | download |
| xiaohongshu | download |
| zhihu | download |

### 3.3 Read Operations (214 commands, auto-execute)

Everything not in WRITE_OPERATIONS and not a download operation. Includes all `search`, `top`, `timeline`, `trending`, `profile`, `list`, `quote`, `export` commands.

### 3.4 Classification Logic

```typescript
function isWriteOperation(site: string, action: string): boolean {
  // Known write operations
  const siteWrites = WRITE_OPERATIONS[site];
  if (siteWrites?.includes(action)) return true;

  // Known download operations (auto-execute)
  if (action === 'download') return false;

  // Known read-safe patterns
  if (['export'].includes(action)) return false;

  // Unknown site+action → default to write (safe default)
  if (!DOMAIN_MAPPING_FLAT.includes(site)) return true;

  return false;
}
```

## 4. Architecture

### 4.1 Data Flow

```
Claude selects opencli tool
    │
    ▼
opencliMcpFactory.ts (tool handler)
    │
    ├─ permissionEngine.isWriteOperation(site, action)?
    │   │
    │   ├─ NO (read/download) → bridgeCommandProxy.dispatch()
    │   │
    │   └─ YES (write) → permissionEngine.hasSessionApproval(sessionId, site, action)?
    │       │
    │       ├─ YES (cached) → bridgeCommandProxy.dispatch()
    │       │
    │       └─ NO (first time) → askUserSessionRef.waitForInput(confirmPrompt)
    │           │                  ↕ Promise.race([input, 3min timeout])
    │           │
    │           ├─ User confirms → permissionEngine.grantSessionApproval()
    │           │                  → bridgeCommandProxy.dispatch()
    │           │
    │           ├─ User rejects → return error to Claude
    │           │
    │           └─ Timeout (3min) → cleanup + return error to Claude
    │
    ▼
bridge → opencli CLI → result → Claude → rendered in UI
```

### 4.2 Confirmation Prompt Format

```
⚠️ OpenCLI Write Operation

{site}/{action} wants to execute a write operation on your behalf.

Command: opencli {site} {action} {args...}

This will modify data on {site}. Do you want to proceed?

[Confirm] [Reject]

(Approval will be remembered for this session. Timeout: 3 minutes)
```

### 4.3 Session Approval Cache

```typescript
// In-memory, keyed by sessionId
const approvalCache = new Map<string, Set<string>>();

// Key format: "site/action" (e.g., "twitter/post")
// Cleared when session ends (via sessionManager cleanup hook)
```

No persistence needed — session ends, approvals gone. This is the safest default.

## 5. Components

### 5.1 permissionEngine.ts (new, ~120 lines)

```typescript
import { WRITE_OPERATIONS } from './constants.js';

const DOWNLOAD_ACTIONS = ['download'];
const READ_SAFE_ACTIONS = ['export'];

// Session approval cache
const approvalCache = new Map<string, Set<string>>();

export function isWriteOperation(site: string, action: string): boolean;
export function hasSessionApproval(sessionId: string, site: string, action: string): boolean;
export function grantSessionApproval(sessionId: string, site: string, action: string): void;
export function clearSessionApprovals(sessionId: string): void;
export function buildConfirmationPrompt(site: string, action: string, args: string[]): string;
```

### 5.2 opencliMcpFactory.ts (modify, +30 lines)

Insert permission check before `commandProxy.dispatch()`:

```typescript
import { isWriteOperation, hasSessionApproval, grantSessionApproval, buildConfirmationPrompt } from './permissionEngine.js';
import { WRITE_COMMAND_TIMEOUT } from './constants.js';

// In tool handler, before dispatch:
if (isWriteOperation(site, args.action)) {
  if (!hasSessionApproval(sessionId, site, args.action)) {
    const prompt = buildConfirmationPrompt(site, args.action, cliArgs);

    const CONFIRMATION_TIMEOUT = 3 * 60 * 1000; // 3 minutes
    let timeoutId: NodeJS.Timeout;

    try {
      const response = await Promise.race([
        askUserSessionRef.current.waitForInput(prompt),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Confirmation expired (3 min). Please retry.')), CONFIRMATION_TIMEOUT);
        }),
      ]);
      clearTimeout(timeoutId!);

      if (response.toLowerCase().includes('reject') || response.toLowerCase().includes('cancel')) {
        return formatOpenCliError(site, args.action, 'User rejected the write operation.');
      }

      grantSessionApproval(sessionId, site, args.action);
    } catch (err) {
      clearTimeout(timeoutId!);
      return formatOpenCliError(site, args.action, (err as Error).message);
    }
  }
}

// Then dispatch with WRITE_COMMAND_TIMEOUT (60s) for write ops
const timeout = isWriteOperation(site, args.action) ? WRITE_COMMAND_TIMEOUT : undefined;
const stdout = await commandProxy.dispatch(projectId, userId, {
  site, action: args.action, args: cliArgs, timeout,
});
```

### 5.3 Integration with sessionManager

When a session is cleaned up, call `clearSessionApprovals(sessionId)`. This requires finding where session cleanup happens and adding a one-line hook. The existing `sessionEventBus` or session cleanup in `sessionManager.ts` is the integration point.

## 6. File Summary

### New Files

| File | Lines (est.) |
|------|-------------|
| `backend/src/services/opencli/permissionEngine.ts` | ~120 |
| `backend/src/services/opencli/__tests__/permissionEngine.test.ts` | ~100 |

### Modified Files

| File | Changes |
|------|---------|
| `backend/src/services/opencli/opencliMcpFactory.ts` | +30 lines (permission check before dispatch) |

### Total Estimate: ~250 lines

## 7. Testing Strategy

- **Unit tests for permissionEngine**: isWriteOperation (all 75 write commands + read commands + unknown commands), session approval cache (grant/check/clear), confirmation prompt generation
- **Integration test**: Mock askUserSessionRef, verify write operation triggers confirmation, cached approval skips confirmation, timeout returns error
- **Regression**: Run existing 47 backend opencli tests to ensure no breakage
