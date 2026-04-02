# A2A Cron Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement user-level cron scheduling within AgentStudio that allows weknora-ui users to create, manage, and monitor timed AI agent tasks through the A2A apiKey auth system.

**Architecture:** New `a2aCronService` orchestrates node-cron scheduling and dispatches to existing `taskExecutor` (isolated mode) or `ClaudeSession` (reuse mode). Workspace-scoped JSONL storage under `{workingDirectory}/.a2a/cron/`, global index at `~/.agentstudio/a2a-cron-index.json`. WebSocket `cron` channel pushes execution events. All API endpoints under `/a2a/:agentId/cron/*` with apiKey auth (same as A2A chat).

**Tech Stack:** Node.js, Express, TypeScript, node-cron (4.2.1, already installed), cron-parser (new dep), Zod, Vitest

**Design Doc:** `docs/plans/2026-03-15-a2a-cron-service-design.md` (1872 lines, all code and logic verified against codebase)

**Scope:** Backend only (Phases 1-5). Frontend (weknora-ui, Phase 6) is a separate plan in a separate repo.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `backend/src/types/a2aCron.ts` | All type definitions: CronJob, CronRun, CronSchedule, CronSessionTarget, API request/response types |
| `backend/src/services/a2a/a2aCronStorage.ts` | Workspace-scoped file storage: jobs.json CRUD, runs JSONL append/prune, global index with mutex |
| `backend/src/services/a2a/a2aCronService.ts` | Scheduling orchestrator: node-cron registration, execution dispatch (isolated/reuse), state management |
| `backend/src/routes/a2aCron.ts` | 11 REST API endpoints with Zod validation, a2aAuth middleware |
| `backend/src/services/a2a/__tests__/a2aCronStorage.test.ts` | Storage service unit tests |
| `backend/src/services/a2a/__tests__/a2aCronService.test.ts` | Scheduling + execution integration tests |
| `backend/src/routes/__tests__/a2aCronRoutes.test.ts` | API route tests |
| `backend/src/services/__tests__/a2aCronWebSocket.test.ts` | WebSocket push tests |

### Modified Files

| File | Changes |
|------|---------|
| `backend/src/services/taskExecutor/BuiltinExecutor.ts` | `storeResult()`: add `cron_` prefix routing to `a2aCronService.onExecutionComplete()` |
| `backend/src/services/websocketService.ts` | Add `subscribedCron` field, `broadcastCronEvent()`, cron subscribe/unsubscribe handling |
| `backend/src/index.ts` | Mount `/a2a/:id/cron` route, initialize/shutdown `a2aCronService` |
| `backend/package.json` | Add `cron-parser` dependency |

---

## Phase 1: Types + Storage Layer

### Task 1: Type Definitions

**Files:**
- Create: `backend/src/types/a2aCron.ts`
- Test: `backend/src/services/a2a/__tests__/a2aCronStorage.test.ts` (type smoke test)

- [ ] **Step 1: Create type definitions file**

```typescript
// backend/src/types/a2aCron.ts
// Full implementation: design doc lines 638-723

export interface CronSchedule {
  type: 'interval' | 'cron' | 'once';
  intervalMinutes?: number;
  cronExpression?: string;
  executeAt?: string;
}

export type CronSessionTarget = 'isolated' | 'reuse';

export interface CronJob {
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

export type CronRunStatus = 'running' | 'success' | 'error' | 'stopped';

export interface CronRun {
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

export interface CreateCronJobRequest {
  name: string;
  description?: string;
  triggerMessage: string;
  schedule: CronSchedule;
  sessionTarget?: CronSessionTarget;
  enabled?: boolean;
  timeoutMs?: number;
  maxTurns?: number;
}

export interface UpdateCronJobRequest {
  name?: string;
  description?: string;
  triggerMessage?: string;
  schedule?: CronSchedule;
  sessionTarget?: CronSessionTarget;
  enabled?: boolean;
  timeoutMs?: number;
  maxTurns?: number;
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd backend && npx tsc --noEmit src/types/a2aCron.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd agentstudio && git add backend/src/types/a2aCron.ts
git commit -m "feat: add A2A cron type definitions"
```

### Task 2: Storage Service — Path Helpers + Jobs CRUD

**Files:**
- Create: `backend/src/services/a2a/a2aCronStorage.ts`
- Create: `backend/src/services/a2a/__tests__/a2aCronStorage.test.ts`

- [ ] **Step 1: Write failing tests for path helpers and jobs CRUD**

```typescript
// backend/src/services/a2a/__tests__/a2aCronStorage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Will import a2aCronStorage after implementation

describe('A2ACronStorage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Jobs CRUD', () => {
    it('should create a job and load it back', () => {
      // const storage = new A2ACronStorage();
      // const job = storage.createJob(tmpDir, {
      //   name: 'Test Job',
      //   triggerMessage: 'Hello',
      //   schedule: { type: 'cron', cronExpression: '0 9 * * *' },
      // }, 'jarvis');
      // expect(job.id).toMatch(/^cron_[a-f0-9]{8}$/);
      // expect(job.name).toBe('Test Job');
      // expect(job.agentType).toBe('jarvis');
      // expect(job.enabled).toBe(true);
      // expect(job.sessionTarget).toBe('isolated');
      //
      // const loaded = storage.loadJobs(tmpDir);
      // expect(loaded).toHaveLength(1);
      // expect(loaded[0].id).toBe(job.id);
    });

    it('should update a job', () => {
      // const storage = new A2ACronStorage();
      // const job = storage.createJob(tmpDir, { name: 'Old', triggerMessage: 'Hi', schedule: { type: 'cron', cronExpression: '* * * * *' } }, 'test');
      // const updated = storage.updateJob(tmpDir, job.id, { name: 'New' });
      // expect(updated?.name).toBe('New');
      // expect(updated?.triggerMessage).toBe('Hi'); // unchanged
    });

    it('should delete a job', () => {
      // const storage = new A2ACronStorage();
      // const job = storage.createJob(tmpDir, { name: 'X', triggerMessage: 'Y', schedule: { type: 'once', executeAt: '2026-12-01T00:00:00Z' } }, 'test');
      // expect(storage.deleteJob(tmpDir, job.id)).toBe(true);
      // expect(storage.loadJobs(tmpDir)).toHaveLength(0);
      // expect(storage.deleteJob(tmpDir, 'nonexistent')).toBe(false);
    });

    it('should update job run status', () => {
      // const storage = new A2ACronStorage();
      // const job = storage.createJob(tmpDir, { name: 'J', triggerMessage: 'T', schedule: { type: 'cron', cronExpression: '0 * * * *' } }, 'a');
      // storage.updateJobRunStatus(tmpDir, job.id, 'running');
      // const loaded = storage.getJob(tmpDir, job.id);
      // expect(loaded?.lastRunStatus).toBe('running');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/a2a/__tests__/a2aCronStorage.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement storage service — paths + jobs CRUD**

Create `backend/src/services/a2a/a2aCronStorage.ts` with:
- Path helpers: `getCronDir`, `getJobsFilePath`, `getRunsDir`, `getRunsFilePath`
- `loadJobs(wd)`, `getJob(wd, jobId)`, `createJob(wd, req, agentType)`, `updateJob(wd, jobId, req)`, `deleteJob(wd, jobId)`
- `updateJobRunStatus(wd, jobId, status, error?)`, `updateJobNextRunAt(wd, jobId, nextRunAt)`
- ID generation: `cron_${uuidv4().slice(0, 8)}` (matching project pattern in `scheduledTaskStorage.ts:85`)

Reference: design doc lines 730-777 for interface, lines 601-625 for jobs.json structure.

- [ ] **Step 4: Uncomment tests and run**

Run: `cd backend && npx vitest run src/services/a2a/__tests__/a2aCronStorage.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/a2a/a2aCronStorage.ts backend/src/services/a2a/__tests__/a2aCronStorage.test.ts
git commit -m "feat: add a2aCronStorage jobs CRUD"
```

### Task 3: Storage Service — Runs JSONL + Pruning

**Files:**
- Modify: `backend/src/services/a2a/a2aCronStorage.ts`
- Modify: `backend/src/services/a2a/__tests__/a2aCronStorage.test.ts`

- [ ] **Step 1: Write failing tests for runs operations**

```typescript
describe('Runs JSONL', () => {
  it('should append and read runs', () => {
    // const storage = new A2ACronStorage();
    // const job = storage.createJob(tmpDir, { name: 'J', triggerMessage: 'T', schedule: { type: 'cron', cronExpression: '0 * * * *' } }, 'a');
    // const run1: CronRun = { id: 'run_001', jobId: job.id, status: 'success', startedAt: '2026-03-15T00:00:00Z', completedAt: '2026-03-15T00:01:00Z', executionTimeMs: 60000 };
    // const run2: CronRun = { id: 'run_002', jobId: job.id, status: 'error', startedAt: '2026-03-15T01:00:00Z', error: 'timeout' };
    // storage.appendRun(tmpDir, job.id, run1);
    // storage.appendRun(tmpDir, job.id, run2);
    // const runs = storage.getRuns(tmpDir, job.id);
    // expect(runs).toHaveLength(2);
    // expect(runs[0].id).toBe('run_001');
  });

  it('should prune runs to keep latest N', () => {
    // const storage = new A2ACronStorage();
    // const job = storage.createJob(tmpDir, { name: 'J', triggerMessage: 'T', schedule: { type: 'cron', cronExpression: '* * * * *' } }, 'a');
    // for (let i = 0; i < 10; i++) {
    //   storage.appendRun(tmpDir, job.id, { id: `run_${i}`, jobId: job.id, status: 'success', startedAt: new Date().toISOString() });
    // }
    // storage.pruneRuns(tmpDir, job.id, 3);
    // const runs = storage.getRuns(tmpDir, job.id);
    // expect(runs).toHaveLength(3);
    // expect(runs[0].id).toBe('run_7'); // oldest kept
  });

  it('should return empty array for nonexistent runs file', () => {
    // const storage = new A2ACronStorage();
    // expect(storage.getRuns(tmpDir, 'nonexistent')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement appendRun, getRuns, pruneRuns**

Reference: design doc lines 781-805 for implementation.
- `appendRun`: JSONL append + auto-prune at 2MB
- `getRuns`: Read JSONL, parse lines, optional limit (return latest N)
- `pruneRuns`: Keep last N lines

- [ ] **Step 4: Uncomment tests and run**

Run: `cd backend && npx vitest run src/services/a2a/__tests__/a2aCronStorage.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/a2a/a2aCronStorage.ts backend/src/services/a2a/__tests__/a2aCronStorage.test.ts
git commit -m "feat: add a2aCronStorage runs JSONL with auto-pruning"
```

### Task 4: Storage Service — Global Index with Mutex

**Files:**
- Modify: `backend/src/services/a2a/a2aCronStorage.ts`
- Modify: `backend/src/services/a2a/__tests__/a2aCronStorage.test.ts`

- [ ] **Step 1: Write failing tests for global index**

```typescript
describe('Global Index', () => {
  let indexDir: string;

  beforeEach(() => {
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-index-'));
  });

  afterEach(() => {
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it('should add and remove workspaces from index', async () => {
    // const storage = new A2ACronStorage(indexDir); // pass custom home for testing
    // await storage.addWorkspaceToIndex('/project-a');
    // await storage.addWorkspaceToIndex('/project-b');
    // let index = storage.loadIndex();
    // expect(index.workspaces).toContain('/project-a');
    // expect(index.workspaces).toContain('/project-b');
    //
    // await storage.removeWorkspaceFromIndex('/project-a');
    // index = storage.loadIndex();
    // expect(index.workspaces).not.toContain('/project-a');
    // expect(index.workspaces).toContain('/project-b');
  });

  it('should handle concurrent index writes without losing entries', async () => {
    // const storage = new A2ACronStorage(indexDir);
    // await Promise.all([
    //   storage.addWorkspaceToIndex('/a'),
    //   storage.addWorkspaceToIndex('/b'),
    //   storage.addWorkspaceToIndex('/c'),
    // ]);
    // const index = storage.loadIndex();
    // expect(index.workspaces).toHaveLength(3);
  });

  it('should deduplicate workspace entries', async () => {
    // const storage = new A2ACronStorage(indexDir);
    // await storage.addWorkspaceToIndex('/same');
    // await storage.addWorkspaceToIndex('/same');
    // const index = storage.loadIndex();
    // expect(index.workspaces.filter(w => w === '/same')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement global index with Promise chain mutex**

Reference: design doc lines 741-750 (withIndexLock), lines 761-764 (index operations), lines 1524-1533 (index file structure).

Key: Index file path = `${AGENTSTUDIO_HOME}/a2a-cron-index.json`. For tests, constructor accepts optional `homeDir` override.

- [ ] **Step 4: Uncomment tests and run**

Run: `cd backend && npx vitest run src/services/a2a/__tests__/a2aCronStorage.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/a2a/a2aCronStorage.ts backend/src/services/a2a/__tests__/a2aCronStorage.test.ts
git commit -m "feat: add a2aCronStorage global index with mutex"
```

---

## Phase 2: Scheduling Service Skeleton

### Task 5: Install cron-parser dependency

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Install cron-parser**

```bash
cd agentstudio/backend && pnpm add cron-parser
```

- [ ] **Step 2: Verify import works**

```bash
cd backend && node -e "import('cron-parser').then(m => { console.log(m.parseExpression('0 9 * * *').next().toString()); process.exit(0); })"
```
Expected: Prints next 9am date

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/pnpm-lock.yaml
git commit -m "chore: add cron-parser dependency for nextRunAt calculation"
```

### Task 6: Service Skeleton — registerJob + unregisterJob

**Files:**
- Create: `backend/src/services/a2a/a2aCronService.ts`
- Create: `backend/src/services/a2a/__tests__/a2aCronService.test.ts`

- [ ] **Step 1: Write failing tests for job registration**

```typescript
// backend/src/services/a2a/__tests__/a2aCronService.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('A2ACronService - Scheduling', () => {
  // Tests for:
  // 1. registerJob with type=cron → activeJobs has cronTask
  // 2. registerJob with type=interval (30min) → activeJobs has cronTask
  // 3. registerJob with type=interval (90min) → activeJobs has intervalTimer
  // 4. registerJob with type=once (future) → activeJobs has timeout
  // 5. registerJob with type=once (past) → auto-disabled, not in activeJobs
  // 6. registerJob with enabled=false → not registered
  // 7. unregisterJob → removed from activeJobs
  // 8. invalid cron expression → console.error, not registered
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement a2aCronService skeleton**

Create `backend/src/services/a2a/a2aCronService.ts` with:
- Class fields: `activeJobs`, `runningExecutions`, `executingJobIds`, `agentStorage`
- `registerJob(job)` — three schedule types (design doc lines 1006-1071)
- `unregisterJob(jobId)` — cancel cron/timeout/interval
- `rescheduleJob(job)` — unregister + register
- Stub `executeJob` — just logs, doesn't actually execute

- [ ] **Step 4: Uncomment tests and run**

Run: `cd backend && npx vitest run src/services/a2a/__tests__/a2aCronService.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/a2a/a2aCronService.ts backend/src/services/a2a/__tests__/a2aCronService.test.ts
git commit -m "feat: add a2aCronService with job scheduling (cron/interval/once)"
```

### Task 7: Service Lifecycle — initialize + shutdown

**Files:**
- Modify: `backend/src/services/a2a/a2aCronService.ts`
- Modify: `backend/src/services/a2a/__tests__/a2aCronService.test.ts`

- [ ] **Step 1: Write failing tests for lifecycle**

```typescript
describe('A2ACronService - Lifecycle', () => {
  // 1. initialize() loads jobs from index, registers enabled ones
  // 2. initialize() marks orphan running→error
  // 3. initialize() skips invalid workspaces in index
  // 4. shutdown() stops all cron tasks and clears activeJobs
});
```

- [ ] **Step 2: Implement initialize() and shutdown()**

Reference: design doc lines 1537-1619.
- `initialize()`: read index → load each workspace's jobs → orphan cleanup → registerJob
- `shutdown()`: stop all cronTask/timeout/intervalTimer → clear activeJobs

- [ ] **Step 3: Run tests**

Expected: All lifecycle tests PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/a2a/a2aCronService.ts backend/src/services/a2a/__tests__/a2aCronService.test.ts
git commit -m "feat: add a2aCronService initialize/shutdown lifecycle"
```

---

## Phase 3: Execution Engines

### Task 8: executeJob Core Flow (concurrency protection + dispatch)

**Files:**
- Modify: `backend/src/services/a2a/a2aCronService.ts`
- Modify: `backend/src/services/a2a/__tests__/a2aCronService.test.ts`

- [ ] **Step 1: Write failing tests for executeJob**

```typescript
describe('A2ACronService - executeJob', () => {
  // 1. executeJob creates run, sets running status, broadcasts cron:started
  // 2. executeJob skips if lastRunStatus === 'running'
  // 3. executeJob skips if executingJobIds has jobId
  // 4. executeJob registers run in runningExecutions
  // 5. executeJob catch block: writes error run + updates status + cleans runningExecutions
  // 6. executeJob finally: always deletes from executingJobIds
  // 7. once type auto-disables after execution
});
```

- [ ] **Step 2: Implement executeJob core flow**

Reference: design doc lines 1784-1870. Implement full `executeJob` with:
- Two-level concurrency protection (lastRunStatus + executingJobIds)
- Run creation + `runningExecutions.set()`
- Try/catch/finally with proper state cleanup
- Stub `executeIsolated` and `executeReuse` (resolve immediately for now)
- **Create `broadcastCronEvent` no-op stub** in service file (replaced by real import in Task 15):
  ```typescript
  // Temporary stub — replaced when websocketService exports broadcastCronEvent (Task 15)
  function broadcastCronEvent(_wd: string, _event: any): void { /* no-op */ }
  ```
- Run IDs use format `run_${uuidv4().slice(0,8)}` (import `{ v4 as uuidv4 }` from `uuid`, matching `scheduledTaskStorage.ts` pattern)
- Job IDs also use uuid: `cron_${uuidv4().slice(0,8)}` (统一 ID 生成方式，与项目 `task_${uuidv4().slice(0,8)}` 模式一致)
- Catch block should also update `lastRunAt` in memory: `active.job.lastRunAt = completedRun.completedAt`

- [ ] **Step 3: Run tests**

Expected: All 7 tests PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/a2a/a2aCronService.ts backend/src/services/a2a/__tests__/a2aCronService.test.ts
git commit -m "feat: add executeJob core flow with concurrency protection"
```

### Task 9: executeIsolated + BuiltinExecutor storeResult modification

**Files:**
- Modify: `backend/src/services/a2a/a2aCronService.ts`
- Modify: `backend/src/services/taskExecutor/BuiltinExecutor.ts`
- Modify: `backend/src/services/a2a/__tests__/a2aCronService.test.ts`

- [ ] **Step 1: Write failing test for isolated execution path**

```typescript
describe('executeIsolated', () => {
  // 1. Calls executor.submitTask with correct TaskDefinition fields
  //    (type='scheduled', scheduledTaskId=job.id, projectPath=wd, permissionMode='acceptEdits')
  // 2. agentStorage.getAgent() called with job.agentType
  // 3. Throws if agent not found
});
```

- [ ] **Step 2: Implement executeIsolated**

Reference: design doc lines 1108-1131.

- [ ] **Step 3: Write failing test for onExecutionComplete**

```typescript
describe('onExecutionComplete', () => {
  // 1. Writes completed run to JSONL
  // 2. Updates job lastRunStatus AND lastRunAt in storage + memory
  // 3. Deletes from runningExecutions
  // 4. Writes logs to a2aHistoryService (if logs exist)
  // 5. Broadcasts cron:completed or cron:error
  // 6. Once type auto-disables
  // 7. Handles missing activeJobs entry gracefully
});
```

- [ ] **Step 4: Implement onExecutionComplete (async)**

Reference: design doc lines 856-922.

- [ ] **Step 5: Modify BuiltinExecutor.storeResult()**

In `backend/src/services/taskExecutor/BuiltinExecutor.ts`, find the `task.type === 'scheduled'` branch (line 506). The existing code from lines 508-538 (containing `updateTaskExecution`, `updateTaskRunStatus`, `onScheduledTaskComplete`) must be **wrapped** in the `else` block:

```typescript
} else if (task.type === 'scheduled') {
  const scheduledTaskId = task.scheduledTaskId || task.id;

  if (scheduledTaskId.startsWith('cron_')) {
    // A2A Cron Job → route to a2aCronService
    const { a2aCronService } = await import('../a2a/a2aCronService.js');
    await a2aCronService.onExecutionComplete(task.id, scheduledTaskId, result);
  } else {
    // System scheduled task → KEEP ALL EXISTING CODE (lines 508-538) HERE
    const { updateTaskExecution, updateTaskRunStatus } = await import('../scheduledTaskStorage.js');
    const { onScheduledTaskComplete } = await import('../schedulerService.js');
    // ...rest of existing code unchanged...
  }
}

- [ ] **Step 6: Run all tests**

Run: `cd backend && npx vitest run src/services/a2a/__tests__/a2aCronService.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/a2a/a2aCronService.ts backend/src/services/taskExecutor/BuiltinExecutor.ts backend/src/services/a2a/__tests__/a2aCronService.test.ts
git commit -m "feat: add executeIsolated + onExecutionComplete + BuiltinExecutor cron routing"
```

### Task 10: executeReuse + history writing

**Files:**
- Modify: `backend/src/services/a2a/a2aCronService.ts`
- Modify: `backend/src/services/a2a/__tests__/a2aCronService.test.ts`

- [ ] **Step 1: Write failing tests for reuse execution**

```typescript
describe('executeReuse', () => {
  // 1. Calls handleSessionManagement with fixed sessionId 'cron_session_{jobId}'
  // 2. Calls buildQueryOptions with 13 params (a2aStreamEnabled=false)
  // 3. sendMessage callback writes each SDKMessage to a2aHistoryService
  // 4. Collects assistant text into fullResponse
  // 5. Resolves on result message with status + response
  // 6. Updates run status + memory (lastRunStatus AND lastRunAt) + broadcasts
  // 7. Deletes from runningExecutions on completion (lifecycle contract)
  // 8. Throws on SESSION_BUSY → caught by executeJob catch block
});
```

- [ ] **Step 2: Implement executeReuse**

Reference: design doc lines 1160-1265.
Key imports: `buildQueryOptions` from `claudeUtils.ts`, `handleSessionManagement` from `sessionUtils.ts`.
**Note on `a2aHistoryService`**: Import as top-level static import for `executeReuse` (used synchronously inside sendMessage callback). `onExecutionComplete` (Task 9) uses ESM dynamic `await import()` to avoid circular dependency — that's fine because it's async.

- [ ] **Step 3: Run tests**

Expected: All reuse tests PASS (with mocked ClaudeSession)

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/a2a/a2aCronService.ts backend/src/services/a2a/__tests__/a2aCronService.test.ts
git commit -m "feat: add executeReuse with session reuse and history writing"
```

### Task 11: stopExecution + deleteJob

**Files:**
- Modify: `backend/src/services/a2a/a2aCronService.ts`
- Modify: `backend/src/services/a2a/__tests__/a2aCronService.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('stopExecution', () => {
  // 1. Calls executor.cancelTask (await) and returns success
  // 2. Writes stopped run to JSONL
  // 3. Updates lastRunStatus to 'stopped' in memory + storage
  // 4. Deletes from runningExecutions
  // 5. Broadcasts cron:completed with status='stopped'
  // 6. Returns failure if runId not found
});

describe('deleteJob', () => {
  // 1. Unregisters job from scheduler
  // 2. Removes reuse session via sessionManager.removeSession
  // 3. Deletes from storage
  // 4. Removes from activeJobs
  // 5. Cleans runningExecutions for that jobId
  // 6. Removes workspace from index if last job
  // 7. Returns false if job not found
});
```

- [ ] **Step 2: Implement stopExecution (async)**

Reference: design doc lines 924-968. Key: cancelTask doesn't trigger handleTaskComplete, must self-update.

- [ ] **Step 3: Implement deleteJob (async)**

Reference: design doc lines 969-1003. Includes runningExecutions orphan cleanup.

- [ ] **Step 4: Run tests**

Expected: All stop/delete tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/a2a/a2aCronService.ts backend/src/services/a2a/__tests__/a2aCronService.test.ts
git commit -m "feat: add stopExecution and deleteJob with state cleanup"
```

---

## Phase 4: API Routes

### Task 12: Zod Schemas + CRUD Endpoints

**Files:**
- Create: `backend/src/routes/a2aCron.ts`
- Create: `backend/src/routes/__tests__/a2aCronRoutes.test.ts`

- [ ] **Step 1: Write failing tests for CRUD endpoints**

```typescript
describe('A2A Cron Routes - CRUD', () => {
  // 1. POST /jobs → 201 with valid body → creates job
  // 2. POST /jobs → 400 with invalid cron expression
  // 3. POST /jobs → 400 with missing required fields
  // 4. GET /jobs → 200 with job list
  // 5. GET /jobs/:id → 200 with single job
  // 6. GET /jobs/:id → 404 for nonexistent
  // 7. PUT /jobs/:id → 200 with partial update
  // 8. DELETE /jobs/:id → 200 + job removed
  // 9. POST /jobs/:id/toggle → toggles enabled
  // 10. GET /status → 200 with counts
});
```

- [ ] **Step 2: Implement route file with Zod schemas**

Create `backend/src/routes/a2aCron.ts`:
- `Router({ mergeParams: true })` + `router.use(a2aAuth)` + `router.use(a2aRateLimiter)`
- Zod schemas: `CronScheduleSchema`, `CreateCronJobSchema`, `UpdateCronJobSchema` (use `CreateCronJobSchema.partial()` for PUT, design doc lines 1751-1774, 713-721)
- CRUD endpoints: GET/POST/PUT/DELETE /jobs, /jobs/:jobId, /jobs/:jobId/toggle, /status
- **POST /jobs handler**: After Zod validation passes, call `cron.validate(schedule.cronExpression)` for type=cron and return 400 if invalid (design doc line 1780)
- **Test distinction**: Add separate test for string that passes Zod (`z.string().max(100)`) but fails `cron.validate()` (e.g., `"0 25 * * *"` — invalid hour), distinct from missing-field Zod failures

- [ ] **Step 3: Run tests**

Expected: All 10 CRUD tests PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/a2aCron.ts backend/src/routes/__tests__/a2aCronRoutes.test.ts
git commit -m "feat: add a2aCron CRUD routes with Zod validation"
```

### Task 13: Execution + History Endpoints

**Files:**
- Modify: `backend/src/routes/a2aCron.ts`
- Modify: `backend/src/routes/__tests__/a2aCronRoutes.test.ts`

- [ ] **Step 1: Write failing tests for execution endpoints**

```typescript
describe('A2A Cron Routes - Execution', () => {
  // 1. POST /jobs/:id/run → 200 + triggers executeJob async
  // 2. POST /jobs/:id/stop → 200 with runId body → calls stopExecution
  // 3. POST /jobs/:id/stop → 400 without runId
  // 4. GET /jobs/:id/runs → 200 with run history
  // 5. GET /jobs/:id/runs/:runId/history → 200 with a2a history events
  // 6. GET /jobs/:id/runs/:runId/history → 200 empty for no history
});
```

- [ ] **Step 2: Implement execution endpoints**

Reference: design doc lines 1368-1410.
- POST /jobs/:id/run — async trigger, immediate 200
- POST /jobs/:id/stop — await stopExecution
- GET /jobs/:id/runs — getRuns from storage
- GET /jobs/:id/runs/:runId/history — a2aHistoryService.getHistory

- [ ] **Step 3: Run tests**

Expected: All 6 execution tests PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/a2aCron.ts backend/src/routes/__tests__/a2aCronRoutes.test.ts
git commit -m "feat: add a2aCron execution and history endpoints"
```

### Task 14: Mount Routes + Service Lifecycle in index.ts

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Add route import and mounting**

```typescript
// After a2aWorkspaceRouter import (~line 27)
import a2aCronRouter from './routes/a2aCron';

// Before a2aRouter mounting (~line 490), add:
// Note: httpsOnly is already imported at the top of index.ts
app.use('/a2a/:a2aAgentId/cron', httpsOnly, a2aCronRouter);
```

- [ ] **Step 2: Add service initialization**

```typescript
// After initializeScheduler block (~line 380), add:
import { a2aCronService } from './services/a2a/a2aCronService';
try {
  a2aCronService.initialize();
} catch (error) {
  console.error('[A2A Cron] Error initializing:', error);
}
```

- [ ] **Step 3: Add shutdown handler**

```typescript
// In gracefulShutdown, after shutdownScheduler (~line 612), add:
try {
  a2aCronService.shutdown();
  console.info('[A2A Cron] Service stopped');
} catch (error) {
  console.error('[A2A Cron] Error shutting down:', error);
}
```

- [ ] **Step 4: Verify build passes**

Run: `cd backend && pnpm run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat: mount a2aCron routes and service lifecycle in index.ts"
```

---

## Phase 5: WebSocket Push

### Task 15: WebSocket cron Channel

**Files:**
- Modify: `backend/src/services/websocketService.ts`
- Create: `backend/src/services/__tests__/a2aCronWebSocket.test.ts`

- [ ] **Step 1: Write failing tests for WS cron subscription**

```typescript
describe('WebSocket Cron Channel', () => {
  // 1. subscribe('cron', {agentId}) → sets subscribedCron with workingDirectory
  // 2. subscribe('cron') → sends cron:sync with current jobs immediately
  // 3. unsubscribe('cron') → clears subscribedCron
  // 4. broadcastCronEvent → only sends to matching workingDirectory
  // 5. broadcastCronEvent → skips clients without subscribedCron
  // 6. cleanupClient → clears subscribedCron
});
```

- [ ] **Step 2: Modify WSClient interface**

```typescript
interface WSClient {
  ws: WebSocket;
  apiKey: string;
  isAlive: boolean;
  workspace?: { agentId: string; userId?: string; watchKey: string };
  subscribedSessions: boolean;
  subscribedCron?: { workingDirectory: string };  // NEW
}
```

- [ ] **Step 3: Add cron subscribe/unsubscribe handling in handleClientMessage**

Reference: design doc lines 1439-1466.
- Add imports at top of file: `import { resolveA2AId } from './a2a/agentMappingService.js'` and `import { a2aCronStorage } from './a2a/a2aCronStorage.js'`
- Subscribe: `resolveA2AId(msg.agentId).then(mapping => ...)` → set subscribedCron + send cron:sync
- Unsubscribe: clear subscribedCron

- [ ] **Step 4: Add cleanupClient cron cleanup**

```typescript
function cleanupClient(client: WSClient): void {
  // ...existing workspace + sessions cleanup...
  client.subscribedCron = undefined;  // NEW
}
```

- [ ] **Step 5: Export broadcastCronEvent function**

```typescript
export function broadcastCronEvent(workingDirectory: string, event: {
  type: 'cron:started' | 'cron:completed' | 'cron:error';
  jobId: string;
  runId: string;
  status?: string;
  responseSummary?: string;
  timestamp: number;
}): void {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.subscribedCron?.workingDirectory === workingDirectory) {
      sendSafe(client, message);
    }
  }
}
```

- [ ] **Step 6: Run tests**

Run: `cd backend && npx vitest run src/services/__tests__/a2aCronWebSocket.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/websocketService.ts backend/src/services/__tests__/a2aCronWebSocket.test.ts
git commit -m "feat: add WebSocket cron channel with subscribe/broadcast"
```

---

## Final Verification

### Task 16: Full Integration Test + Type Check

**Files:**
- All modified files

- [ ] **Step 1: Run all cron tests**

```bash
cd backend && npx vitest run src/services/a2a/__tests__/a2aCronStorage.test.ts src/services/a2a/__tests__/a2aCronService.test.ts src/routes/__tests__/a2aCronRoutes.test.ts src/services/__tests__/a2aCronWebSocket.test.ts
```
Expected: All tests PASS

- [ ] **Step 2: Run type check**

```bash
cd agentstudio && pnpm run type-check
```
Expected: No type errors

- [ ] **Step 3: Run lint**

```bash
cd agentstudio && pnpm run lint
```
Expected: No lint errors (or only pre-existing ones)

- [ ] **Step 4: Run full existing test suite to verify no regressions**

```bash
cd backend && npx vitest run
```
Expected: No regressions in existing tests

- [ ] **Step 5: Manual smoke test (optional)**

Start backend with `pnpm run dev:backend`, then:
```bash
# Create a test cron job via curl
curl -X POST http://localhost:4936/a2a/YOUR_AGENT_ID/cron/jobs \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","triggerMessage":"Say hello","schedule":{"type":"once","executeAt":"2026-03-19T00:00:00Z"}}'
```

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add <specific changed files> && git commit -m "fix: address integration test findings"
```
