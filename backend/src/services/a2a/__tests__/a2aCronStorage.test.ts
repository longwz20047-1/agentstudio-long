import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { A2ACronStorage } from '../a2aCronStorage.js';

describe('A2ACronStorage', () => {
  let tmpDir: string;
  let storage: A2ACronStorage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-test-'));
    storage = new A2ACronStorage();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Jobs CRUD', () => {
    it('should create a job and load it back', () => {
      const job = storage.createJob(tmpDir, {
        name: 'Test Job',
        triggerMessage: 'Hello',
        schedule: { type: 'cron', cronExpression: '0 9 * * *' },
      }, 'jarvis');
      expect(job.id).toMatch(/^cron_[a-f0-9]{8}$/);
      expect(job.name).toBe('Test Job');
      expect(job.agentType).toBe('jarvis');
      expect(job.enabled).toBe(true);
      expect(job.sessionTarget).toBe('isolated');

      const loaded = storage.loadJobs(tmpDir);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe(job.id);
    });

    it('should update a job', () => {
      const job = storage.createJob(tmpDir, { name: 'Old', triggerMessage: 'Hi', schedule: { type: 'cron', cronExpression: '* * * * *' } }, 'test');
      const updated = storage.updateJob(tmpDir, job.id, { name: 'New' });
      expect(updated?.name).toBe('New');
      expect(updated?.triggerMessage).toBe('Hi');
    });

    it('should delete a job', () => {
      const job = storage.createJob(tmpDir, { name: 'X', triggerMessage: 'Y', schedule: { type: 'once', executeAt: '2026-12-01T00:00:00Z' } }, 'test');
      expect(storage.deleteJob(tmpDir, job.id)).toBe(true);
      expect(storage.loadJobs(tmpDir)).toHaveLength(0);
      expect(storage.deleteJob(tmpDir, 'nonexistent')).toBe(false);
    });

    it('should update job run status', () => {
      const job = storage.createJob(tmpDir, { name: 'J', triggerMessage: 'T', schedule: { type: 'cron', cronExpression: '0 * * * *' } }, 'a');
      storage.updateJobRunStatus(tmpDir, job.id, 'running');
      const loaded = storage.getJob(tmpDir, job.id);
      expect(loaded?.lastRunStatus).toBe('running');
    });
  });

  describe('Runs JSONL', () => {
    it('should append and read runs', () => {
      const job = storage.createJob(tmpDir, { name: 'J', triggerMessage: 'T', schedule: { type: 'cron', cronExpression: '0 * * * *' } }, 'a');
      const run1 = { id: 'run_001', jobId: job.id, status: 'success' as const, startedAt: '2026-03-15T00:00:00Z', completedAt: '2026-03-15T00:01:00Z', executionTimeMs: 60000 };
      const run2 = { id: 'run_002', jobId: job.id, status: 'error' as const, startedAt: '2026-03-15T01:00:00Z', error: 'timeout' };
      storage.appendRun(tmpDir, job.id, run1);
      storage.appendRun(tmpDir, job.id, run2);
      const runs = storage.getRuns(tmpDir, job.id);
      expect(runs).toHaveLength(2);
      expect(runs[0].id).toBe('run_001');
    });

    it('should prune runs to keep latest N', () => {
      const job = storage.createJob(tmpDir, { name: 'J', triggerMessage: 'T', schedule: { type: 'cron', cronExpression: '* * * * *' } }, 'a');
      for (let i = 0; i < 10; i++) {
        storage.appendRun(tmpDir, job.id, { id: `run_${i}`, jobId: job.id, status: 'success', startedAt: new Date().toISOString() });
      }
      storage.pruneRuns(tmpDir, job.id, 3);
      const runs = storage.getRuns(tmpDir, job.id);
      expect(runs).toHaveLength(3);
      expect(runs[0].id).toBe('run_7');
    });

    it('should return empty array for nonexistent runs file', () => {
      expect(storage.getRuns(tmpDir, 'nonexistent')).toHaveLength(0);
    });
  });

  describe('Global Index', () => {
    let indexDir: string;
    let indexStorage: A2ACronStorage;

    beforeEach(() => {
      indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-index-'));
      indexStorage = new A2ACronStorage(indexDir);
    });

    afterEach(() => {
      fs.rmSync(indexDir, { recursive: true, force: true });
    });

    it('should add and remove workspaces from index', async () => {
      await indexStorage.addWorkspaceToIndex('/project-a');
      await indexStorage.addWorkspaceToIndex('/project-b');
      let index = indexStorage.loadIndex();
      expect(index.workspaces).toContain('/project-a');
      expect(index.workspaces).toContain('/project-b');

      await indexStorage.removeWorkspaceFromIndex('/project-a');
      index = indexStorage.loadIndex();
      expect(index.workspaces).not.toContain('/project-a');
      expect(index.workspaces).toContain('/project-b');
    });

    it('should handle concurrent index writes without losing entries', async () => {
      await Promise.all([
        indexStorage.addWorkspaceToIndex('/a'),
        indexStorage.addWorkspaceToIndex('/b'),
        indexStorage.addWorkspaceToIndex('/c'),
      ]);
      const index = indexStorage.loadIndex();
      expect(index.workspaces).toHaveLength(3);
    });

    it('should deduplicate workspace entries', async () => {
      await indexStorage.addWorkspaceToIndex('/same');
      await indexStorage.addWorkspaceToIndex('/same');
      const index = indexStorage.loadIndex();
      expect(index.workspaces.filter(w => w === '/same')).toHaveLength(1);
    });
  });
});
