import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock a2aAuth middleware
vi.mock('../../middleware/a2aAuth.js', () => ({
  a2aAuth: (req: any, _res: any, next: any) => {
    req.a2aContext = {
      a2aAgentId: 'test-agent-id',
      projectId: 'test-project',
      agentType: 'jarvis',
      workingDirectory: req.__testWorkDir || '/tmp/test',
      apiKeyId: 'key-1',
    };
    next();
  },
}));

// Mock rate limiter
vi.mock('../../middleware/rateLimiting.js', () => ({
  a2aRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

// Mock a2aCronService
vi.mock('../../services/a2a/a2aCronService.js', () => ({
  a2aCronService: {
    registerJob: vi.fn(),
    rescheduleJob: vi.fn(),
    deleteJobFull: vi.fn().mockResolvedValue(true),
    executeJob: vi.fn().mockResolvedValue(undefined),
    stopExecution: vi.fn().mockResolvedValue(true),
    ensureRegisteredForManualRun: vi.fn(),
    activeJobs: new Map(),
  },
}));

// Mock a2aCronStorage
vi.mock('../../services/a2a/a2aCronStorage.js', () => ({
  a2aCronStorage: {
    loadJobs: vi.fn().mockReturnValue([]),
    getJob: vi.fn(),
    createJob: vi.fn(),
    updateJob: vi.fn(),
    deleteJob: vi.fn(),
    getRuns: vi.fn().mockReturnValue([]),
    addWorkspaceToIndex: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock a2aHistoryService
vi.mock('../../services/a2a/a2aHistoryService.js', () => ({
  a2aHistoryService: {
    getHistory: vi.fn().mockReturnValue([]),
  },
}));

// Import after mocks
import { a2aCronService } from '../../services/a2a/a2aCronService.js';
import { a2aCronStorage } from '../../services/a2a/a2aCronStorage.js';
import a2aCronRouter from '../a2aCron.js';

describe('A2A Cron Routes', () => {
  let app: express.Express;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-route-'));
    app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.__testWorkDir = tmpDir;
      next();
    });
    app.use('/cron', a2aCronRouter);
    vi.clearAllMocks();
    vi.mocked(a2aCronStorage.loadJobs).mockReturnValue([]);
    vi.mocked(a2aCronStorage.getRuns).mockReturnValue([]);
    vi.mocked(a2aCronService.deleteJobFull).mockResolvedValue(true);
    vi.mocked(a2aCronService.executeJob).mockResolvedValue(undefined);
    vi.mocked(a2aCronService.stopExecution).mockResolvedValue(true);
    (a2aCronService.activeJobs as Map<string, any>).clear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('CRUD', () => {
    it('POST /jobs should create job with valid body', async () => {
      const newJob = {
        id: 'cron_test0001', name: 'Test Job', triggerMessage: 'Hello',
        schedule: { type: 'cron', cronExpression: '0 9 * * *' },
        sessionTarget: 'isolated', enabled: true, agentType: 'jarvis',
        workingDirectory: tmpDir,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      vi.mocked(a2aCronStorage.createJob).mockReturnValue(newJob as any);

      const res = await request(app).post('/cron/jobs').send({
        name: 'Test Job', triggerMessage: 'Hello',
        schedule: { type: 'cron', cronExpression: '0 9 * * *' },
      });

      expect(res.status).toBe(201);
      expect(res.body.job.name).toBe('Test Job');
      expect(a2aCronStorage.createJob).toHaveBeenCalled();
      expect(a2aCronService.registerJob).toHaveBeenCalled();
    });

    it('POST /jobs should return 400 with invalid cron expression', async () => {
      const res = await request(app).post('/cron/jobs').send({
        name: 'Bad Cron', triggerMessage: 'Hello',
        schedule: { type: 'cron', cronExpression: '0 25 * * *' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid cron');
    });

    it('POST /jobs should return 400 with missing required fields', async () => {
      const res = await request(app).post('/cron/jobs').send({ name: 'No trigger' });
      expect(res.status).toBe(400);
    });

    it('GET /jobs should return job list', async () => {
      vi.mocked(a2aCronStorage.loadJobs).mockReturnValue([
        { id: 'cron_1', name: 'Job 1', enabled: true } as any,
      ]);
      const res = await request(app).get('/cron/jobs');
      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(1);
    });

    it('GET /jobs/:id should return single job', async () => {
      vi.mocked(a2aCronStorage.getJob).mockReturnValue({ id: 'cron_1', name: 'Job 1' } as any);
      const res = await request(app).get('/cron/jobs/cron_1');
      expect(res.status).toBe(200);
      expect(res.body.job.id).toBe('cron_1');
    });

    it('GET /jobs/:id should return 404 for nonexistent', async () => {
      vi.mocked(a2aCronStorage.getJob).mockReturnValue(null);
      const res = await request(app).get('/cron/jobs/nonexistent');
      expect(res.status).toBe(404);
    });

    it('PUT /jobs/:id should update job', async () => {
      vi.mocked(a2aCronStorage.updateJob).mockReturnValue({ id: 'cron_1', name: 'Updated', enabled: true } as any);
      const res = await request(app).put('/cron/jobs/cron_1').send({ name: 'Updated' });
      expect(res.status).toBe(200);
      expect(res.body.job.name).toBe('Updated');
      expect(a2aCronService.rescheduleJob).toHaveBeenCalled();
    });

    it('DELETE /jobs/:id should delete job', async () => {
      const res = await request(app).delete('/cron/jobs/cron_1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('POST /jobs/:id/toggle should toggle enabled', async () => {
      vi.mocked(a2aCronStorage.getJob).mockReturnValue({ id: 'cron_1', enabled: true } as any);
      vi.mocked(a2aCronStorage.updateJob).mockReturnValue({ id: 'cron_1', enabled: false } as any);
      const res = await request(app).post('/cron/jobs/cron_1/toggle');
      expect(res.status).toBe(200);
      expect(a2aCronStorage.updateJob).toHaveBeenCalledWith(expect.anything(), 'cron_1', { enabled: false });
    });

    it('GET /status should return counts', async () => {
      vi.mocked(a2aCronStorage.loadJobs).mockReturnValue([
        { id: 'cron_1', enabled: true, lastRunStatus: 'running' } as any,
        { id: 'cron_2', enabled: false } as any,
      ]);
      const res = await request(app).get('/cron/status');
      expect(res.status).toBe(200);
      expect(res.body.totalJobs).toBe(2);
      expect(res.body.activeJobs).toBe(1);
      expect(res.body.runningJobs).toBe(1);
    });
  });

  describe('Execution', () => {
    it('POST /jobs/:id/run should trigger execution', async () => {
      vi.mocked(a2aCronStorage.getJob).mockReturnValue({ id: 'cron_1', name: 'Test' } as any);
      const res = await request(app).post('/cron/jobs/cron_1/run');
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('triggered');
    });

    it('POST /jobs/:id/stop should stop with runId', async () => {
      const res = await request(app).post('/cron/jobs/cron_1/stop').send({ runId: 'run_test001' });
      expect(res.status).toBe(200);
      expect(a2aCronService.stopExecution).toHaveBeenCalledWith('cron_1', 'run_test001');
    });

    it('POST /jobs/:id/stop should return 400 without runId', async () => {
      const res = await request(app).post('/cron/jobs/cron_1/stop').send({});
      expect(res.status).toBe(400);
    });

    it('GET /jobs/:id/runs should return run history', async () => {
      vi.mocked(a2aCronStorage.getRuns).mockReturnValue([{ id: 'run_1', status: 'success' } as any]);
      const res = await request(app).get('/cron/jobs/cron_1/runs');
      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
    });

    it('GET /jobs/:id/runs/:runId/history should return events', async () => {
      const res = await request(app).get('/cron/jobs/cron_1/runs/run_1/history');
      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
    });
  });
});
