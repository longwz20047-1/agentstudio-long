import cron, { ScheduledTask as CronTask } from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import type {
  CronJob,
  CronRun,
  CronRunStatus,
} from '../../types/a2aCron.js';
import { a2aCronStorage } from './a2aCronStorage.js';
import { AgentStorage } from '../agentStorage.js';
import { broadcastCronEvent } from '../websocketService.js';

interface ActiveJob {
  job: CronJob;
  cronTask?: CronTask;
  timeout?: ReturnType<typeof setTimeout>;
  intervalTimer?: ReturnType<typeof setInterval>;
}

class A2ACronService {
  readonly activeJobs = new Map<string, ActiveJob>();
  readonly runningExecutions = new Map<string, { jobId: string; runId: string; startedAt: string }>();
  private executingJobIds = new Set<string>();
  private agentStorage = new AgentStorage();

  // --- Scheduling ---

  registerJob(job: CronJob): void {
    this.unregisterJob(job.id);
    if (!job.enabled) return;

    const executeCallback = () => {
      this.executeJob(job.id).catch(err => {
        console.error(`[A2A Cron] Error executing job ${job.id}:`, err);
      });
    };

    if (job.schedule.type === 'once' && job.schedule.executeAt) {
      const delay = new Date(job.schedule.executeAt).getTime() - Date.now();
      if (delay <= 0) {
        a2aCronStorage.updateJob(job.workingDirectory, job.id, { enabled: false });
        return;
      }
      const MAX_DELAY = 2147483647;
      if (delay > MAX_DELAY) {
        const timeout = setTimeout(() => {
          const currentJob = a2aCronStorage.getJob(job.workingDirectory, job.id);
          if (currentJob && currentJob.enabled) this.registerJob(currentJob);
        }, MAX_DELAY);
        this.activeJobs.set(job.id, { job, timeout });
      } else {
        const timeout = setTimeout(executeCallback, delay);
        this.activeJobs.set(job.id, { job, timeout });
      }
      a2aCronStorage.updateJobNextRunAt(job.workingDirectory, job.id, job.schedule.executeAt);

    } else if (job.schedule.type === 'interval' && job.schedule.intervalMinutes) {
      const minutes = job.schedule.intervalMinutes;
      if (minutes < 60) {
        const cronExpression = `*/${minutes} * * * *`;
        const cronTask = cron.schedule(cronExpression, executeCallback);
        this.activeJobs.set(job.id, { job, cronTask });
      } else if (minutes % 60 === 0) {
        const cronExpression = `0 */${minutes / 60} * * *`;
        const cronTask = cron.schedule(cronExpression, executeCallback);
        this.activeJobs.set(job.id, { job, cronTask });
      } else {
        const intervalMs = minutes * 60 * 1000;
        const timer = setInterval(executeCallback, intervalMs);
        this.activeJobs.set(job.id, { job, intervalTimer: timer });
      }
      this.computeNextRunAt(job, minutes);

    } else if (job.schedule.type === 'cron' && job.schedule.cronExpression) {
      if (!cron.validate(job.schedule.cronExpression)) {
        console.error(`[A2A Cron] Invalid cron expression for job ${job.id}: ${job.schedule.cronExpression}`);
        return;
      }
      const cronTask = cron.schedule(job.schedule.cronExpression, executeCallback);
      this.activeJobs.set(job.id, { job, cronTask });
      this.computeCronNextRunAt(job);
    }
  }

  private computeNextRunAt(job: CronJob, minutes: number): void {
    if (minutes < 60 || minutes % 60 === 0) {
      const expr = minutes < 60 ? `*/${minutes} * * * *` : `0 */${minutes / 60} * * *`;
      import('cron-parser').then(({ CronExpressionParser }) => {
        const interval = CronExpressionParser.parse(expr);
        const next = interval.next();
        const iso = next?.toISOString();
        if (iso) {
          a2aCronStorage.updateJobNextRunAt(job.workingDirectory, job.id, iso);
        }
      }).catch(() => {
        a2aCronStorage.updateJobNextRunAt(job.workingDirectory, job.id,
          new Date(Date.now() + minutes * 60 * 1000).toISOString());
      });
    } else {
      a2aCronStorage.updateJobNextRunAt(job.workingDirectory, job.id,
        new Date(Date.now() + minutes * 60 * 1000).toISOString());
    }
  }

  private computeCronNextRunAt(job: CronJob): void {
    import('cron-parser').then(({ CronExpressionParser }) => {
      const interval = CronExpressionParser.parse(job.schedule.cronExpression!);
      const next = interval.next();
      const iso = next?.toISOString();
      if (iso) {
        a2aCronStorage.updateJobNextRunAt(job.workingDirectory, job.id, iso);
      }
    }).catch(() => {
      // cron-parser failure doesn't block scheduling
    });
  }

  unregisterJob(jobId: string): void {
    const active = this.activeJobs.get(jobId);
    if (!active) return;
    active.cronTask?.stop();
    if (active.timeout) clearTimeout(active.timeout);
    if (active.intervalTimer) clearInterval(active.intervalTimer);
    this.activeJobs.delete(jobId);
  }

  rescheduleJob(job: CronJob): void {
    this.unregisterJob(job.id);
    this.registerJob(job);
  }

  // --- Execution ---

  async executeJob(jobId: string): Promise<void> {
    const active = this.activeJobs.get(jobId);
    if (!active) {
      console.warn(`[A2A Cron] Job ${jobId} not found in activeJobs`);
      return;
    }
    const { job } = active;

    // Two-level concurrency protection
    if (job.lastRunStatus === 'running') {
      console.warn(`[A2A Cron] Job ${jobId} already running (lastRunStatus), skipping`);
      return;
    }
    if (this.executingJobIds.has(jobId)) {
      console.warn(`[A2A Cron] Job ${jobId} already executing (executingJobIds), skipping`);
      return;
    }

    this.executingJobIds.add(jobId);

    const runId = `run_${uuidv4().slice(0, 8)}`;
    const now = new Date().toISOString();
    const run: CronRun = {
      id: runId,
      jobId,
      status: 'running',
      startedAt: now,
    };

    try {
      // Update jobs.json & memory (JSONL only gets final status, not 'running')
      a2aCronStorage.updateJobRunStatus(job.workingDirectory, jobId, 'running');
      active.job.lastRunStatus = 'running';
      active.job.lastRunAt = now;

      // Register in runningExecutions
      this.runningExecutions.set(runId, { jobId, runId, startedAt: now });

      // Broadcast cron:started
      broadcastCronEvent(job.workingDirectory, {
        type: 'cron:started',
        jobId,
        runId,
        timestamp: Date.now(),
      });

      // Dispatch execution
      if (job.sessionTarget === 'reuse') {
        await this.executeReuse(job, run);
      } else {
        await this.executeIsolated(job, run);
      }

      // Handle once type auto-disable
      if (job.schedule.type === 'once') {
        a2aCronStorage.updateJob(job.workingDirectory, jobId, { enabled: false });
        active.job.enabled = false;
        this.unregisterJob(jobId);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const completedAt = new Date().toISOString();
      const errorRun: CronRun = {
        ...run,
        status: 'error',
        completedAt,
        executionTimeMs: Date.now() - new Date(run.startedAt).getTime(),
        error: errorMsg,
      };
      a2aCronStorage.appendRun(job.workingDirectory, jobId, errorRun);
      a2aCronStorage.updateJobRunStatus(job.workingDirectory, jobId, 'error', errorMsg);
      active.job.lastRunStatus = 'error';
      active.job.lastRunAt = completedAt;
      this.runningExecutions.delete(runId);

      broadcastCronEvent(job.workingDirectory, {
        type: 'cron:error',
        jobId,
        runId,
        status: 'error',
        timestamp: Date.now(),
      });
    } finally {
      this.executingJobIds.delete(jobId);
    }
  }

  private async executeIsolated(job: CronJob, run: CronRun): Promise<void> {
    const { getTaskExecutor } = await import('../taskExecutor/index.js');
    const executor = getTaskExecutor();

    const agent = this.agentStorage.getAgent(job.agentType);
    if (!agent) {
      throw new Error(`Agent not found: ${job.agentType}`);
    }

    await executor.submitTask({
      id: run.id,
      type: 'scheduled',
      scheduledTaskId: job.id,
      message: job.triggerMessage,
      agentId: job.agentType,
      projectPath: job.workingDirectory,
      permissionMode: 'acceptEdits',
      timeoutMs: job.timeoutMs || 300000,
      maxTurns: job.maxTurns ?? agent.maxTurns,
      createdAt: run.startedAt,
    });
  }

  private async executeReuse(job: CronJob, run: CronRun): Promise<void> {
    const fixedSessionId = `cron_session_${job.id}`;

    const agent = this.agentStorage.getAgent(job.agentType);
    if (!agent) throw new Error(`Agent not found: ${job.agentType}`);

    // Build query options (a2aStreamEnabled=false since cron has no SSE consumer)
    const { buildQueryOptions } = await import('../../utils/claudeUtils.js');
    const mcpTools = agent.allowedTools
      .filter((tool: any) => tool.enabled && tool.name.startsWith('mcp__'))
      .map((tool: any) => tool.name);
    const { queryOptions } = await buildQueryOptions(
      agent,
      job.workingDirectory,
      mcpTools.length > 0 ? mcpTools : undefined,
      'acceptEdits',
      undefined, // model
      undefined, // claudeVersion
      undefined, // defaultEnv
      undefined, // userEnv
      undefined, // sessionIdForAskUser
      undefined, // agentIdForAskUser
      false,     // a2aStreamEnabled
    );

    // Get or create reuse session
    const { handleSessionManagement } = await import('../../utils/sessionUtils.js');
    const { claudeSession } = await handleSessionManagement(
      job.agentType,
      fixedSessionId,
      job.workingDirectory,
      queryOptions,
      undefined, // claudeVersionId
      undefined, // modelId
      'reuse',
    );

    // Send message and collect response
    const { a2aHistoryService } = await import('./a2aHistoryService.js');
    let fullResponse = '';
    const result = await new Promise<{ status: string; response: string }>((resolve, reject) => {
      claudeSession.sendMessage(
        job.triggerMessage,
        (sdkMessage: any) => {
          // Write each SDK message to history (fire and forget)
          a2aHistoryService.appendEvent(job.workingDirectory, run.id, sdkMessage)
            .catch(() => {});

          // Collect assistant text
          if (sdkMessage.type === 'assistant') {
            const content = sdkMessage.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text') fullResponse += block.text;
              }
            }
          }
          // Resolve on result message
          if (sdkMessage.type === 'result') {
            resolve({
              status: sdkMessage.subtype || 'success',
              response: fullResponse,
            });
          }
        }
      ).catch(reject);
    });

    // Update run status + memory + broadcast
    const finalStatus: CronRunStatus = result.status === 'success' ? 'success' : 'error';
    const completedAt = new Date().toISOString();
    const completedRun: CronRun = {
      ...run,
      status: finalStatus,
      completedAt,
      executionTimeMs: Date.now() - new Date(run.startedAt).getTime(),
      responseSummary: result.response.substring(0, 500),
      sessionId: fixedSessionId,
    };
    a2aCronStorage.appendRun(job.workingDirectory, job.id, completedRun);
    a2aCronStorage.updateJobRunStatus(job.workingDirectory, job.id, finalStatus);

    const active = this.activeJobs.get(job.id);
    if (active) {
      active.job.lastRunStatus = finalStatus;
      active.job.lastRunAt = completedAt;
    }
    this.runningExecutions.delete(run.id);

    broadcastCronEvent(job.workingDirectory, {
      type: finalStatus === 'success' ? 'cron:completed' : 'cron:error',
      jobId: job.id,
      runId: run.id,
      status: finalStatus,
      responseSummary: completedRun.responseSummary,
      timestamp: Date.now(),
    });
  }

  async onExecutionComplete(executionId: string, cronJobId: string, result: any): Promise<void> {
    const runInfo = this.runningExecutions.get(executionId);
    const active = this.activeJobs.get(cronJobId);

    const status: CronRunStatus = result.status === 'completed' ? 'success' : 'error';
    const completedAt = result.completedAt || new Date().toISOString();
    const completedRun: CronRun = {
      id: executionId,
      jobId: cronJobId,
      status,
      startedAt: runInfo?.startedAt || completedAt,
      completedAt,
      executionTimeMs: runInfo ? Date.now() - new Date(runInfo.startedAt).getTime() : undefined,
      responseSummary: result.output?.substring(0, 500),
      sessionId: result.sessionId,
      error: result.error,
    };

    // Get workingDirectory from active job or storage
    const wd = active?.job.workingDirectory;
    if (wd) {
      a2aCronStorage.appendRun(wd, cronJobId, completedRun);
      a2aCronStorage.updateJobRunStatus(wd, cronJobId, status, result.error);

      // Write history logs if available
      if (result.logs?.length) {
        try {
          const { a2aHistoryService } = await import('./a2aHistoryService.js');
          for (const log of result.logs) {
            a2aHistoryService.appendEvent(wd, executionId, log).catch(() => {});
          }
        } catch {
          // history service failure is non-critical
        }
      }

      // Update memory
      if (active) {
        active.job.lastRunStatus = status;
        active.job.lastRunAt = completedRun.completedAt;
      }

      // Broadcast
      broadcastCronEvent(wd, {
        type: status === 'success' ? 'cron:completed' : 'cron:error',
        jobId: cronJobId,
        runId: executionId,
        status,
        responseSummary: completedRun.responseSummary,
        timestamp: Date.now(),
      });

      // Once type auto-disable
      if (active?.job.schedule.type === 'once') {
        a2aCronStorage.updateJob(wd, cronJobId, { enabled: false });
        active.job.enabled = false;
        this.unregisterJob(cronJobId);
      }
    }

    this.runningExecutions.delete(executionId);
  }

  async stopExecution(jobId: string, runId: string): Promise<boolean> {
    const runInfo = this.runningExecutions.get(runId);
    if (!runInfo || runInfo.jobId !== jobId) return false;

    const active = this.activeJobs.get(jobId);
    const wd = active?.job.workingDirectory;

    try {
      const { getTaskExecutor } = await import('../taskExecutor/index.js');
      const executor = getTaskExecutor();
      await executor.cancelTask(runId);
    } catch {
      // cancelTask may fail if task already completed
    }

    const completedAt = new Date().toISOString();
    const stoppedRun: CronRun = {
      id: runId,
      jobId,
      status: 'stopped',
      startedAt: runInfo.startedAt,
      completedAt,
      executionTimeMs: Date.now() - new Date(runInfo.startedAt).getTime(),
    };

    if (wd) {
      a2aCronStorage.appendRun(wd, jobId, stoppedRun);
      a2aCronStorage.updateJobRunStatus(wd, jobId, 'stopped');
      if (active) {
        active.job.lastRunStatus = 'stopped';
        active.job.lastRunAt = completedAt;
      }
      broadcastCronEvent(wd, {
        type: 'cron:completed',
        jobId,
        runId,
        status: 'stopped',
        timestamp: Date.now(),
      });
    }

    this.runningExecutions.delete(runId);
    return true;
  }

  async deleteJobFull(wd: string, jobId: string): Promise<boolean> {
    // Unregister scheduler
    this.unregisterJob(jobId);

    // Clean up reuse session
    try {
      const { sessionManager } = await import('../sessionManager.js');
      sessionManager.removeSession(`cron_session_${jobId}`);
    } catch {
      // session may not exist
    }

    // Clean runningExecutions for this job
    for (const [runId, info] of this.runningExecutions) {
      if (info.jobId === jobId) {
        this.runningExecutions.delete(runId);
      }
    }

    // Delete from storage
    const deleted = a2aCronStorage.deleteJob(wd, jobId);
    if (!deleted) return false;

    // Remove workspace from index if no more jobs
    const remaining = a2aCronStorage.loadJobs(wd);
    if (remaining.length === 0) {
      await a2aCronStorage.removeWorkspaceFromIndex(wd);
    }

    return true;
  }

  // --- Lifecycle ---

  initialize(): void {
    const index = a2aCronStorage.loadIndex();
    const validWorkspaces: string[] = [];

    for (const wd of index.workspaces) {
      try {
        const jobs = a2aCronStorage.loadJobs(wd);
        if (jobs.length === 0) continue;
        validWorkspaces.push(wd);

        for (const job of jobs) {
          // Orphan cleanup: mark stale running as error
          if (job.lastRunStatus === 'running') {
            a2aCronStorage.updateJobRunStatus(wd, job.id, 'error', 'Orphaned: server restarted');
            job.lastRunStatus = 'error';
          }
          if (job.enabled) {
            this.registerJob(job);
          }
        }
      } catch (error) {
        console.error(`[A2A Cron] Error loading workspace ${wd}:`, error);
      }
    }

    // Clean up invalid workspaces from index
    if (validWorkspaces.length !== index.workspaces.length) {
      const toRemove = index.workspaces.filter(w => !validWorkspaces.includes(w));
      for (const wd of toRemove) {
        a2aCronStorage.removeWorkspaceFromIndex(wd).catch(() => {});
      }
    }

    const totalJobs = this.activeJobs.size;
    if (totalJobs > 0) {
      console.log(`[A2A Cron] Initialized: ${totalJobs} active jobs across ${validWorkspaces.length} workspaces`);
    }
  }

  shutdown(): void {
    for (const [, active] of this.activeJobs) {
      active.cronTask?.stop();
      if (active.timeout) clearTimeout(active.timeout);
      if (active.intervalTimer) clearInterval(active.intervalTimer);
    }
    this.activeJobs.clear();
    this.runningExecutions.clear();
    this.executingJobIds.clear();
    console.log('[A2A Cron] Service shut down');
  }
}

export const a2aCronService = new A2ACronService();
