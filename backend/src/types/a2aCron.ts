export interface CronSchedule {
  type: 'interval' | 'cron' | 'once';
  intervalMinutes?: number;
  cronExpression?: string;
  executeAt?: string;
}

export type CronSessionTarget = 'isolated' | 'reuse';

export interface CronJobContext {
  weknora?: {
    api_key: string;
    kb_ids: string[];
    knowledge_ids?: string[];
    base_url: string;
  };
  graphiti?: {
    base_url: string;
    user_id: string;
    group_ids?: string[];
  };
}

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
  userId?: string; // For per-user workspace isolation
  context?: CronJobContext | null;
  lastRunAt?: string;
  lastRunStatus?: CronRunStatus;
  lastRunError?: string;
  nextRunAt?: string;
  sdkSessionId?: string; // Real Claude SDK session ID for reuse resume after restart
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
  context?: CronJobContext | null;
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
  context?: CronJobContext | null;
}
