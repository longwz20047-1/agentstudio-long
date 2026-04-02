import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  CronJob,
  CronRun,
  CronRunStatus,
  CreateCronJobRequest,
  UpdateCronJobRequest,
} from '../../types/a2aCron.js';

const CRON_DIR = '.a2a/cron';
const JOBS_FILE = 'jobs.json';
const RUNS_DIR = 'runs';
const RUNS_MAX_SIZE = 2 * 1024 * 1024; // 2MB auto-prune threshold
const RUNS_PRUNE_KEEP = 1000; // Keep last N runs when pruning

export class A2ACronStorage {
  private indexDir: string;
  private indexLock: Promise<void> = Promise.resolve();

  constructor(homeDir?: string) {
    this.indexDir = homeDir ?? (process.env.AGENTSTUDIO_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '', '.agentstudio'));
  }

  // --- Path helpers ---

  private getCronDir(wd: string): string {
    return path.join(wd, CRON_DIR);
  }

  private getJobsFilePath(wd: string): string {
    return path.join(this.getCronDir(wd), JOBS_FILE);
  }

  private getRunsDir(wd: string): string {
    return path.join(this.getCronDir(wd), RUNS_DIR);
  }

  private getRunsFilePath(wd: string, jobId: string): string {
    return path.join(this.getRunsDir(wd), `${jobId}.jsonl`);
  }

  private ensureDirs(wd: string): void {
    const cronDir = this.getCronDir(wd);
    if (!fs.existsSync(cronDir)) {
      fs.mkdirSync(cronDir, { recursive: true });
    }
    const runsDir = this.getRunsDir(wd);
    if (!fs.existsSync(runsDir)) {
      fs.mkdirSync(runsDir, { recursive: true });
    }
  }

  // --- Jobs CRUD ---

  loadJobs(wd: string): CronJob[] {
    const filePath = this.getJobsFilePath(wd);
    if (!fs.existsSync(filePath)) return [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error('[A2ACronStorage] Error loading jobs:', error);
      return [];
    }
  }

  private saveJobs(wd: string, jobs: CronJob[]): void {
    this.ensureDirs(wd);
    fs.writeFileSync(this.getJobsFilePath(wd), JSON.stringify(jobs, null, 2), 'utf-8');
  }

  getJob(wd: string, jobId: string): CronJob | null {
    return this.loadJobs(wd).find(j => j.id === jobId) ?? null;
  }

  createJob(wd: string, req: CreateCronJobRequest, agentType: string, userId?: string): CronJob {
    const jobs = this.loadJobs(wd);
    const now = new Date().toISOString();
    const job: CronJob = {
      id: `cron_${uuidv4().slice(0, 8)}`,
      name: req.name,
      description: req.description,
      triggerMessage: req.triggerMessage,
      schedule: req.schedule,
      sessionTarget: req.sessionTarget ?? 'isolated',
      enabled: req.enabled ?? true,
      agentType,
      workingDirectory: wd,
      timeoutMs: req.timeoutMs,
      maxTurns: req.maxTurns,
      userId,
      context: req.context,
      createdAt: now,
      updatedAt: now,
    };
    jobs.push(job);
    this.saveJobs(wd, jobs);
    return job;
  }

  updateJob(wd: string, jobId: string, req: UpdateCronJobRequest): CronJob | null {
    const jobs = this.loadJobs(wd);
    const idx = jobs.findIndex(j => j.id === jobId);
    if (idx === -1) return null;
    const job = jobs[idx];
    if (req.name !== undefined) job.name = req.name;
    if (req.description !== undefined) job.description = req.description;
    if (req.triggerMessage !== undefined) job.triggerMessage = req.triggerMessage;
    if (req.schedule !== undefined) job.schedule = req.schedule;
    if (req.sessionTarget !== undefined) job.sessionTarget = req.sessionTarget;
    if (req.enabled !== undefined) job.enabled = req.enabled;
    if (req.timeoutMs !== undefined) job.timeoutMs = req.timeoutMs;
    if (req.maxTurns !== undefined) job.maxTurns = req.maxTurns;
    if (req.context !== undefined) job.context = req.context ?? undefined;
    job.updatedAt = new Date().toISOString();
    jobs[idx] = job;
    this.saveJobs(wd, jobs);
    return job;
  }

  /** Persist SDK session ID for reuse resume after restart (internal, not exposed to API) */
  updateJobSdkSessionId(wd: string, jobId: string, sdkSessionId: string): void {
    const jobs = this.loadJobs(wd);
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;
    job.sdkSessionId = sdkSessionId;
    this.saveJobs(wd, jobs);
  }

  deleteJob(wd: string, jobId: string): boolean {
    const jobs = this.loadJobs(wd);
    const idx = jobs.findIndex(j => j.id === jobId);
    if (idx === -1) return false;
    jobs.splice(idx, 1);
    this.saveJobs(wd, jobs);
    // Preserve runs history file — user can still view execution history
    return true;
  }

  updateJobRunStatus(wd: string, jobId: string, status: CronRunStatus, error?: string, timestamp?: string): void {
    const jobs = this.loadJobs(wd);
    const idx = jobs.findIndex(j => j.id === jobId);
    if (idx === -1) return;
    jobs[idx].lastRunStatus = status;
    jobs[idx].lastRunAt = timestamp || new Date().toISOString();
    if (error !== undefined) jobs[idx].lastRunError = error;
    if (status === 'success') jobs[idx].lastRunError = undefined; // clear stale error
    jobs[idx].updatedAt = new Date().toISOString();
    this.saveJobs(wd, jobs);
  }

  updateJobNextRunAt(wd: string, jobId: string, nextRunAt: string | undefined): void {
    const jobs = this.loadJobs(wd);
    const idx = jobs.findIndex(j => j.id === jobId);
    if (idx === -1) return;
    jobs[idx].nextRunAt = nextRunAt;
    jobs[idx].updatedAt = new Date().toISOString();
    this.saveJobs(wd, jobs);
  }

  // --- Runs JSONL ---

  appendRun(wd: string, jobId: string, run: CronRun): void {
    this.ensureDirs(wd);
    const filePath = this.getRunsFilePath(wd, jobId);
    fs.appendFileSync(filePath, JSON.stringify(run) + '\n', 'utf-8');
    // Auto-prune if file exceeds threshold
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > RUNS_MAX_SIZE) {
        this.pruneRuns(wd, jobId, RUNS_PRUNE_KEEP);
      }
    } catch {
      // ignore stat errors
    }
  }

  getRuns(wd: string, jobId: string, limit?: number): CronRun[] {
    const filePath = this.getRunsFilePath(wd, jobId);
    if (!fs.existsSync(filePath)) return [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (!content) return [];
      const runs = content.split('\n').map(line => JSON.parse(line) as CronRun);
      if (limit && limit > 0) {
        return runs.slice(-limit);
      }
      return runs;
    } catch (error) {
      console.error('[A2ACronStorage] Error reading runs:', error);
      return [];
    }
  }

  pruneRuns(wd: string, jobId: string, keep: number): void {
    const filePath = this.getRunsFilePath(wd, jobId);
    if (!fs.existsSync(filePath)) return;
    try {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (!content) return;
      const lines = content.split('\n');
      if (lines.length <= keep) return;
      const kept = lines.slice(-keep);
      fs.writeFileSync(filePath, kept.join('\n') + '\n', 'utf-8');
    } catch (error) {
      console.error('[A2ACronStorage] Error pruning runs:', error);
    }
  }

  // --- Global Index ---

  private getIndexFilePath(): string {
    return path.join(this.indexDir, 'a2a-cron-index.json');
  }

  private withIndexLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.indexLock.then(fn, fn);
    this.indexLock = next.then(() => {}, () => {});
    return next;
  }

  loadIndex(): { workspaces: string[] } {
    const filePath = this.getIndexFilePath();
    if (!fs.existsSync(filePath)) return { workspaces: [] };
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      return { workspaces: Array.isArray(data.workspaces) ? data.workspaces : [] };
    } catch {
      return { workspaces: [] };
    }
  }

  private saveIndex(index: { workspaces: string[] }): void {
    if (!fs.existsSync(this.indexDir)) {
      fs.mkdirSync(this.indexDir, { recursive: true });
    }
    fs.writeFileSync(this.getIndexFilePath(), JSON.stringify(index, null, 2), 'utf-8');
  }

  async addWorkspaceToIndex(wd: string): Promise<void> {
    return this.withIndexLock(() => {
      const index = this.loadIndex();
      if (!index.workspaces.includes(wd)) {
        index.workspaces.push(wd);
        this.saveIndex(index);
      }
    });
  }

  async removeWorkspaceFromIndex(wd: string): Promise<void> {
    return this.withIndexLock(() => {
      const index = this.loadIndex();
      index.workspaces = index.workspaces.filter(w => w !== wd);
      this.saveIndex(index);
    });
  }
}

// Singleton instance
export const a2aCronStorage = new A2ACronStorage();
