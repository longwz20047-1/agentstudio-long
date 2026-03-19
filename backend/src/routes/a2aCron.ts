import express, { Router, type Response } from 'express';
import { z } from 'zod';
import cron from 'node-cron';
import { a2aAuth, type A2ARequest } from '../middleware/a2aAuth.js';
import { a2aRateLimiter } from '../middleware/rateLimiting.js';
import { a2aCronService } from '../services/a2a/a2aCronService.js';
import { a2aCronStorage } from '../services/a2a/a2aCronStorage.js';

const router: Router = express.Router({ mergeParams: true });
router.use(a2aAuth as any);
router.use(a2aRateLimiter);

// --- Zod Schemas ---

const CronScheduleSchema = z.object({
  type: z.enum(['interval', 'cron', 'once']),
  intervalMinutes: z.number().int().min(1).max(10080).optional(),
  cronExpression: z.string().max(100).optional(),
  executeAt: z.string().datetime().optional(),
}).refine(
  (s) => {
    if (s.type === 'interval') return s.intervalMinutes !== undefined;
    if (s.type === 'cron') return s.cronExpression !== undefined;
    if (s.type === 'once') return s.executeAt !== undefined;
    return false;
  },
  { message: 'Missing required field for schedule type' }
);

const CreateCronJobSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  triggerMessage: z.string().min(1).max(10000),
  schedule: CronScheduleSchema,
  sessionTarget: z.enum(['isolated', 'reuse']).optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
});

const UpdateCronJobSchema = CreateCronJobSchema.partial();

// --- Helper ---

function getContext(req: A2ARequest) {
  const ctx = req.a2aContext;
  if (!ctx) throw new Error('Missing a2aContext');
  return ctx;
}

// --- CRUD Endpoints ---

// GET /jobs — List all jobs
router.get('/jobs', (req: A2ARequest, res: Response) => {
  try {
    const { workingDirectory } = getContext(req);
    const jobs = a2aCronStorage.loadJobs(workingDirectory);
    res.json({ jobs });
  } catch {
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

// GET /jobs/:jobId — Get single job
router.get('/jobs/:jobId', (req: A2ARequest, res: Response) => {
  try {
    const { workingDirectory } = getContext(req);
    const job = a2aCronStorage.getJob(workingDirectory, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job });
  } catch {
    res.status(500).json({ error: 'Failed to get job' });
  }
});

// POST /jobs — Create job
router.post('/jobs', async (req: A2ARequest, res: Response) => {
  try {
    const { workingDirectory, agentType } = getContext(req);
    const parsed = CreateCronJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    }

    // Extra validation: cron expression must be valid per node-cron
    if (parsed.data.schedule.type === 'cron' && parsed.data.schedule.cronExpression) {
      if (!cron.validate(parsed.data.schedule.cronExpression)) {
        return res.status(400).json({ error: 'Invalid cron expression', cronExpression: parsed.data.schedule.cronExpression });
      }
    }

    const job = a2aCronStorage.createJob(workingDirectory, parsed.data, agentType);

    // Add workspace to index and register
    await a2aCronStorage.addWorkspaceToIndex(workingDirectory);
    if (job.enabled) {
      a2aCronService.registerJob(job);
    }

    res.status(201).json({ job });
  } catch {
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// PUT /jobs/:jobId — Update job
router.put('/jobs/:jobId', (req: A2ARequest, res: Response) => {
  try {
    const { workingDirectory } = getContext(req);
    const parsed = UpdateCronJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    }

    // Extra validation for cron expression update
    if (parsed.data.schedule?.type === 'cron' && parsed.data.schedule?.cronExpression) {
      if (!cron.validate(parsed.data.schedule.cronExpression)) {
        return res.status(400).json({ error: 'Invalid cron expression' });
      }
    }

    const job = a2aCronStorage.updateJob(workingDirectory, req.params.jobId, parsed.data);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Reschedule if schedule or enabled changed
    a2aCronService.rescheduleJob(job);

    res.json({ job });
  } catch {
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// DELETE /jobs/:jobId — Delete job
router.delete('/jobs/:jobId', async (req: A2ARequest, res: Response) => {
  try {
    const { workingDirectory } = getContext(req);
    const deleted = await a2aCronService.deleteJobFull(workingDirectory, req.params.jobId);
    if (!deleted) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

// POST /jobs/:jobId/toggle — Toggle enabled
router.post('/jobs/:jobId/toggle', (req: A2ARequest, res: Response) => {
  try {
    const { workingDirectory } = getContext(req);
    const existing = a2aCronStorage.getJob(workingDirectory, req.params.jobId);
    if (!existing) return res.status(404).json({ error: 'Job not found' });

    const job = a2aCronStorage.updateJob(workingDirectory, req.params.jobId, {
      enabled: !existing.enabled,
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });

    a2aCronService.rescheduleJob(job);
    res.json({ job });
  } catch {
    res.status(500).json({ error: 'Failed to toggle job' });
  }
});

// GET /status — Service status
router.get('/status', (req: A2ARequest, res: Response) => {
  try {
    const { workingDirectory } = getContext(req);
    const jobs = a2aCronStorage.loadJobs(workingDirectory);
    const activeCount = jobs.filter(j => j.enabled).length;
    const runningCount = jobs.filter(j => j.lastRunStatus === 'running').length;

    res.json({
      totalJobs: jobs.length,
      activeJobs: activeCount,
      runningJobs: runningCount,
      registeredJobs: a2aCronService.activeJobs.size,
    });
  } catch {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// --- Execution Endpoints ---

// POST /jobs/:jobId/run — Trigger manual execution
router.post('/jobs/:jobId/run', (req: A2ARequest, res: Response) => {
  try {
    const { workingDirectory } = getContext(req);
    const job = a2aCronStorage.getJob(workingDirectory, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Ensure job is in activeJobs (register if not)
    if (!a2aCronService.activeJobs.has(job.id)) {
      // Temporarily register for execution (even if disabled)
      a2aCronService.activeJobs.set(job.id, { job } as any);
    }

    // Trigger async — don't await
    a2aCronService.executeJob(job.id).catch(err => {
      console.error(`[A2A Cron] Manual run error for ${job.id}:`, err);
    });

    res.json({ message: 'Execution triggered', jobId: job.id });
  } catch {
    res.status(500).json({ error: 'Failed to trigger execution' });
  }
});

// POST /jobs/:jobId/stop — Stop running execution
router.post('/jobs/:jobId/stop', async (req: A2ARequest, res: Response) => {
  try {
    const { runId } = req.body;
    if (!runId || typeof runId !== 'string') {
      return res.status(400).json({ error: 'runId is required' });
    }

    const result = await a2aCronService.stopExecution(req.params.jobId, runId);
    if (!result) return res.status(404).json({ error: 'Running execution not found' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to stop execution' });
  }
});

// GET /jobs/:jobId/runs — Get run history
router.get('/jobs/:jobId/runs', (req: A2ARequest, res: Response) => {
  try {
    const { workingDirectory } = getContext(req);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const runs = a2aCronStorage.getRuns(workingDirectory, req.params.jobId, limit);
    res.json({ runs });
  } catch {
    res.status(500).json({ error: 'Failed to get runs' });
  }
});

// GET /jobs/:jobId/runs/:runId/history — Get A2A history for a run
router.get('/jobs/:jobId/runs/:runId/history', async (req: A2ARequest, res: Response) => {
  try {
    const { workingDirectory } = getContext(req);
    const { a2aHistoryService } = await import('../services/a2a/a2aHistoryService.js');
    const events = a2aHistoryService.getHistory(workingDirectory, req.params.runId);
    res.json({ events: events || [] });
  } catch {
    res.status(500).json({ error: 'Failed to get history' });
  }
});

export default router;
