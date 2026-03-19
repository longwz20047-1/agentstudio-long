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
