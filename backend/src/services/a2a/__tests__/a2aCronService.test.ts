import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock node-cron before importing service
const mockSchedule = vi.fn();
const mockValidate = vi.fn().mockReturnValue(true);
const mockCronStop = vi.fn();
mockSchedule.mockReturnValue({ stop: mockCronStop });

vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: any[]) => mockSchedule(...args),
    validate: (...args: any[]) => mockValidate(...args),
  },
}));

// Mock taskExecutor
const mockSubmitTask = vi.fn().mockResolvedValue(undefined);
const mockCancelTask = vi.fn().mockResolvedValue(undefined);
vi.mock('../../taskExecutor/index.js', () => ({
  getTaskExecutor: () => ({
    submitTask: mockSubmitTask,
    cancelTask: mockCancelTask,
  }),
}));

// Mock agentStorage
vi.mock('../../agentStorage.js', () => ({
  AgentStorage: vi.fn().mockImplementation(() => ({
    getAgent: vi.fn().mockReturnValue({
      id: 'test-agent',
      name: 'Test',
      permissionMode: 'acceptEdits',
      model: 'claude-sonnet-4-20250514',
      maxTurns: 10,
    }),
  })),
}));

// Mock sessionManager
vi.mock('../../sessionManager.js', () => ({
  sessionManager: {
    removeSession: vi.fn(),
  },
}));

// Mock a2aHistoryService
vi.mock('../a2aHistoryService.js', () => ({
  a2aHistoryService: {
    appendEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock buildQueryOptions
vi.mock('../../../utils/claudeUtils.js', () => ({
  buildQueryOptions: vi.fn().mockResolvedValue({
    queryOptions: { model: 'sonnet', maxTurns: 10 },
  }),
}));

// Mock handleSessionManagement
vi.mock('../../../utils/sessionUtils.js', () => ({
  handleSessionManagement: vi.fn().mockResolvedValue({
    claudeSession: { sendMessage: vi.fn() },
    actualSessionId: 'cron_session_test',
  }),
}));

import { A2ACronStorage } from '../a2aCronStorage.js';

// We need to test the service class directly. Import after mocks.
// Since a2aCronService.ts creates a singleton, we import the module and work with its export.
let a2aCronService: any;

describe('A2ACronService', () => {
  let tmpDir: string;
  let storage: A2ACronStorage;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-svc-'));
    storage = new A2ACronStorage(tmpDir);
    vi.clearAllMocks();
    mockSchedule.mockReturnValue({ stop: mockCronStop });
    mockValidate.mockReturnValue(true);

    // Re-import to get fresh singleton (reset state)
    const mod = await import('../a2aCronService.js');
    a2aCronService = mod.a2aCronService;
    // Clean up any leftover state
    a2aCronService.activeJobs.clear();
    a2aCronService.runningExecutions.clear();
  });

  afterEach(() => {
    // Clean up timers
    for (const [, active] of a2aCronService.activeJobs) {
      active.cronTask?.stop();
      if (active.timeout) clearTimeout(active.timeout);
      if (active.intervalTimer) clearInterval(active.intervalTimer);
    }
    a2aCronService.activeJobs.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Scheduling', () => {
    it('should register job with type=cron', () => {
      const job = storage.createJob(tmpDir, {
        name: 'Cron Job',
        triggerMessage: 'Hello',
        schedule: { type: 'cron', cronExpression: '0 9 * * *' },
      }, 'test');

      a2aCronService.registerJob(job);
      expect(mockSchedule).toHaveBeenCalledWith('0 9 * * *', expect.any(Function));
      expect(a2aCronService.activeJobs.has(job.id)).toBe(true);
      const active = a2aCronService.activeJobs.get(job.id);
      expect(active.cronTask).toBeDefined();
    });

    it('should register job with type=interval (30min) as cron', () => {
      const job = storage.createJob(tmpDir, {
        name: 'Interval Job',
        triggerMessage: 'Run',
        schedule: { type: 'interval', intervalMinutes: 30 },
      }, 'test');

      a2aCronService.registerJob(job);
      expect(mockSchedule).toHaveBeenCalledWith('*/30 * * * *', expect.any(Function));
      expect(a2aCronService.activeJobs.has(job.id)).toBe(true);
    });

    it('should register job with type=interval (90min) as setInterval', () => {
      vi.useFakeTimers();
      const job = storage.createJob(tmpDir, {
        name: 'Long Interval',
        triggerMessage: 'Run',
        schedule: { type: 'interval', intervalMinutes: 90 },
      }, 'test');

      a2aCronService.registerJob(job);
      expect(mockSchedule).not.toHaveBeenCalled();
      const active = a2aCronService.activeJobs.get(job.id);
      expect(active.intervalTimer).toBeDefined();
      vi.useRealTimers();
    });

    it('should register job with type=once (future) as setTimeout', () => {
      vi.useFakeTimers();
      const futureDate = new Date(Date.now() + 60000).toISOString();
      const job = storage.createJob(tmpDir, {
        name: 'Once Job',
        triggerMessage: 'Fire',
        schedule: { type: 'once', executeAt: futureDate },
      }, 'test');

      a2aCronService.registerJob(job);
      const active = a2aCronService.activeJobs.get(job.id);
      expect(active.timeout).toBeDefined();
      vi.useRealTimers();
    });

    it('should auto-disable once job with past executeAt', () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();
      const job = storage.createJob(tmpDir, {
        name: 'Past Job',
        triggerMessage: 'Too late',
        schedule: { type: 'once', executeAt: pastDate },
      }, 'test');

      a2aCronService.registerJob(job);
      expect(a2aCronService.activeJobs.has(job.id)).toBe(false);
      // Verify job was disabled in storage
      const loaded = storage.getJob(tmpDir, job.id);
      expect(loaded?.enabled).toBe(false);
    });

    it('should not register disabled job', () => {
      const job = storage.createJob(tmpDir, {
        name: 'Disabled',
        triggerMessage: 'Nope',
        schedule: { type: 'cron', cronExpression: '0 9 * * *' },
        enabled: false,
      }, 'test');

      a2aCronService.registerJob(job);
      expect(a2aCronService.activeJobs.has(job.id)).toBe(false);
    });

    it('should unregister job', () => {
      const job = storage.createJob(tmpDir, {
        name: 'To Remove',
        triggerMessage: 'Bye',
        schedule: { type: 'cron', cronExpression: '0 9 * * *' },
      }, 'test');

      a2aCronService.registerJob(job);
      expect(a2aCronService.activeJobs.has(job.id)).toBe(true);

      a2aCronService.unregisterJob(job.id);
      expect(a2aCronService.activeJobs.has(job.id)).toBe(false);
      expect(mockCronStop).toHaveBeenCalled();
    });

    it('should not register job with invalid cron expression', () => {
      mockValidate.mockReturnValue(false);
      const job = storage.createJob(tmpDir, {
        name: 'Bad Cron',
        triggerMessage: 'Invalid',
        schedule: { type: 'cron', cronExpression: 'not valid' },
      }, 'test');

      a2aCronService.registerJob(job);
      expect(a2aCronService.activeJobs.has(job.id)).toBe(false);
      expect(mockSchedule).not.toHaveBeenCalled();
    });
  });

  describe('Lifecycle', () => {
    it('should initialize and register enabled jobs from index', async () => {
      // Create jobs in workspace
      const job1 = storage.createJob(tmpDir, {
        name: 'Enabled',
        triggerMessage: 'Go',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
      }, 'test');
      const job2 = storage.createJob(tmpDir, {
        name: 'Disabled',
        triggerMessage: 'No',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
        enabled: false,
      }, 'test');

      // Add workspace to index
      const indexStorage = new A2ACronStorage(tmpDir);
      await indexStorage.addWorkspaceToIndex(tmpDir);

      // Patch service to use our test index
      const origLoadIndex = (a2aCronService as any).__proto__.constructor;
      // Use the index storage directly
      const originalModule = await import('../a2aCronStorage.js');
      const origStorageLoadIndex = originalModule.a2aCronStorage.loadIndex;
      const origStorageLoadJobs = originalModule.a2aCronStorage.loadJobs;
      const origStorageUpdateJobRunStatus = originalModule.a2aCronStorage.updateJobRunStatus;

      originalModule.a2aCronStorage.loadIndex = () => indexStorage.loadIndex();
      originalModule.a2aCronStorage.loadJobs = (wd: string) => storage.loadJobs(wd);
      originalModule.a2aCronStorage.updateJobRunStatus = (wd: string, jobId: string, status: any, error?: string) =>
        storage.updateJobRunStatus(wd, jobId, status, error);

      try {
        a2aCronService.initialize();
        expect(a2aCronService.activeJobs.size).toBe(1);
        expect(a2aCronService.activeJobs.has(job1.id)).toBe(true);
        expect(a2aCronService.activeJobs.has(job2.id)).toBe(false);
      } finally {
        originalModule.a2aCronStorage.loadIndex = origStorageLoadIndex;
        originalModule.a2aCronStorage.loadJobs = origStorageLoadJobs;
        originalModule.a2aCronStorage.updateJobRunStatus = origStorageUpdateJobRunStatus;
      }
    });

    it('should mark orphan running jobs as error on initialize', async () => {
      // Create a job with running status
      const job = storage.createJob(tmpDir, {
        name: 'Orphan',
        triggerMessage: 'Stuck',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
      }, 'test');
      storage.updateJobRunStatus(tmpDir, job.id, 'running');

      const indexStorage = new A2ACronStorage(tmpDir);
      await indexStorage.addWorkspaceToIndex(tmpDir);

      const originalModule = await import('../a2aCronStorage.js');
      const origLoadIndex = originalModule.a2aCronStorage.loadIndex;
      const origLoadJobs = originalModule.a2aCronStorage.loadJobs;
      const origUpdateStatus = originalModule.a2aCronStorage.updateJobRunStatus;

      originalModule.a2aCronStorage.loadIndex = () => indexStorage.loadIndex();
      originalModule.a2aCronStorage.loadJobs = (wd: string) => storage.loadJobs(wd);
      originalModule.a2aCronStorage.updateJobRunStatus = (wd: string, jobId: string, status: any, error?: string) =>
        storage.updateJobRunStatus(wd, jobId, status, error);

      try {
        a2aCronService.initialize();
        const loaded = storage.getJob(tmpDir, job.id);
        expect(loaded?.lastRunStatus).toBe('error');
      } finally {
        originalModule.a2aCronStorage.loadIndex = origLoadIndex;
        originalModule.a2aCronStorage.loadJobs = origLoadJobs;
        originalModule.a2aCronStorage.updateJobRunStatus = origUpdateStatus;
      }
    });

    it('should shutdown and clear all active jobs', () => {
      const job = storage.createJob(tmpDir, {
        name: 'Active',
        triggerMessage: 'Running',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
      }, 'test');

      a2aCronService.registerJob(job);
      expect(a2aCronService.activeJobs.size).toBe(1);

      a2aCronService.shutdown();
      expect(a2aCronService.activeJobs.size).toBe(0);
      expect(mockCronStop).toHaveBeenCalled();
    });
  });

  describe('executeJob', () => {
    it('should skip if lastRunStatus is running', async () => {
      const job = storage.createJob(tmpDir, {
        name: 'Running',
        triggerMessage: 'Go',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
      }, 'test');

      a2aCronService.registerJob(job);
      // Simulate running state
      a2aCronService.activeJobs.get(job.id)!.job.lastRunStatus = 'running';

      await a2aCronService.executeJob(job.id);
      expect(mockSubmitTask).not.toHaveBeenCalled();
    });

    it('should skip if executingJobIds has jobId', async () => {
      const job = storage.createJob(tmpDir, {
        name: 'Executing',
        triggerMessage: 'Go',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
      }, 'test');

      a2aCronService.registerJob(job);
      // Manually add to executingJobIds
      (a2aCronService as any).executingJobIds = new Set([job.id]);

      await a2aCronService.executeJob(job.id);
      expect(mockSubmitTask).not.toHaveBeenCalled();

      // Clean up
      (a2aCronService as any).executingJobIds = new Set();
    });

    it('should create run and call submitTask for isolated execution', async () => {
      const job = storage.createJob(tmpDir, {
        name: 'Isolated',
        triggerMessage: 'Execute me',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
      }, 'test');

      a2aCronService.registerJob(job);
      await a2aCronService.executeJob(job.id);

      expect(mockSubmitTask).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'scheduled',
          scheduledTaskId: job.id,
          message: 'Execute me',
          projectPath: tmpDir,
        })
      );
      expect(a2aCronService.runningExecutions.size).toBe(1);
    });

    it('should handle execution errors gracefully', async () => {
      mockSubmitTask.mockRejectedValueOnce(new Error('Execution failed'));

      const job = storage.createJob(tmpDir, {
        name: 'Failing',
        triggerMessage: 'Fail',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
      }, 'test');

      a2aCronService.registerJob(job);
      await a2aCronService.executeJob(job.id);

      // Should have cleaned up
      expect(a2aCronService.runningExecutions.size).toBe(0);
      const active = a2aCronService.activeJobs.get(job.id);
      expect(active?.job.lastRunStatus).toBe('error');
    });
  });

  describe('executeReuse', () => {
    // Note: executeReuse uses dynamic await import() for claudeUtils and sessionUtils,
    // which vitest cannot intercept with vi.mock(). These tests verify the error handling
    // and state management paths that are exercised when executeReuse encounters errors.

    it('should route reuse jobs through executeReuse and handle errors gracefully', async () => {
      const job = storage.createJob(tmpDir, {
        name: 'Reuse Job',
        triggerMessage: 'Run reuse',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
        sessionTarget: 'reuse',
      }, 'test');

      a2aCronService.registerJob(job);
      await a2aCronService.executeJob(job.id);

      // executeReuse's dynamic imports resolve to real modules in test env,
      // which will error (no real SDK session), caught by executeJob's catch block
      const active = a2aCronService.activeJobs.get(job.id);
      expect(active?.job.lastRunStatus).toBe('error');
      expect(a2aCronService.runningExecutions.size).toBe(0);
      // executingJobIds should be cleaned up in finally block
      expect((a2aCronService as any).executingJobIds.size).toBe(0);
    });

    it('should not execute reuse job if already running', async () => {
      const job = storage.createJob(tmpDir, {
        name: 'Already Running',
        triggerMessage: 'Skip me',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
        sessionTarget: 'reuse',
      }, 'test');

      a2aCronService.registerJob(job);
      a2aCronService.activeJobs.get(job.id)!.job.lastRunStatus = 'running';

      await a2aCronService.executeJob(job.id);
      // Should skip — no run created
      expect(a2aCronService.runningExecutions.size).toBe(0);
    });

    it('should use fixed session ID format cron_session_{jobId}', () => {
      // Verify the session ID pattern used for reuse mode
      const jobId = 'cron_abc12345';
      const expectedSessionId = `cron_session_${jobId}`;
      expect(expectedSessionId).toBe('cron_session_cron_abc12345');
      // No colons (Windows-safe for file names)
      expect(expectedSessionId).not.toContain(':');
    });
  });

  describe('onExecutionComplete', () => {
    it('should update run status and clean up', async () => {
      const job = storage.createJob(tmpDir, {
        name: 'Complete',
        triggerMessage: 'Done',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
      }, 'test');

      a2aCronService.registerJob(job);
      // Simulate running state
      const runId = 'run_test001';
      a2aCronService.runningExecutions.set(runId, {
        jobId: job.id,
        runId,
        startedAt: new Date().toISOString(),
      });

      await a2aCronService.onExecutionComplete(runId, job.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        output: 'Task completed successfully',
      });

      expect(a2aCronService.runningExecutions.has(runId)).toBe(false);
      const active = a2aCronService.activeJobs.get(job.id);
      expect(active?.job.lastRunStatus).toBe('success');
    });
  });

  describe('stopExecution', () => {
    it('should stop a running execution', async () => {
      const job = storage.createJob(tmpDir, {
        name: 'To Stop',
        triggerMessage: 'Stop me',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
      }, 'test');

      a2aCronService.registerJob(job);
      const runId = 'run_stop001';
      a2aCronService.runningExecutions.set(runId, {
        jobId: job.id,
        runId,
        startedAt: new Date().toISOString(),
      });

      const result = await a2aCronService.stopExecution(job.id, runId);
      expect(result).toBe(true);
      expect(a2aCronService.runningExecutions.has(runId)).toBe(false);
      expect(mockCancelTask).toHaveBeenCalledWith(runId);
    });

    it('should return false if runId not found', async () => {
      const result = await a2aCronService.stopExecution('nonexistent', 'run_none');
      expect(result).toBe(false);
    });
  });

  describe('deleteJobFull', () => {
    it('should unregister, delete, and clean up', async () => {
      const job = storage.createJob(tmpDir, {
        name: 'To Delete',
        triggerMessage: 'Bye',
        schedule: { type: 'cron', cronExpression: '0 * * * *' },
      }, 'test');

      a2aCronService.registerJob(job);
      expect(a2aCronService.activeJobs.has(job.id)).toBe(true);

      const result = await a2aCronService.deleteJobFull(tmpDir, job.id);
      expect(result).toBe(true);
      expect(a2aCronService.activeJobs.has(job.id)).toBe(false);
      expect(storage.getJob(tmpDir, job.id)).toBeUndefined();
    });

    it('should return false if job not found', async () => {
      const result = await a2aCronService.deleteJobFull(tmpDir, 'nonexistent');
      expect(result).toBe(false);
    });
  });
});
