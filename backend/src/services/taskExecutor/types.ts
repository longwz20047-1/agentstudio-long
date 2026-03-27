/**
 * Unified Task Executor Types
 *
 * Defines the interfaces for a pluggable task execution system that supports
 * both A2A async tasks and scheduled tasks.
 */

/**
 * Task type identifier
 */
export type TaskType = 'a2a_async' | 'scheduled';

/**
 * Permission mode for task execution
 */
export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'default';

/**
 * Push Notification Configuration for task callbacks
 */
export interface TaskPushNotificationConfig {
  url: string;
  token?: string;
  authScheme?: string;  // e.g., "Bearer"
  authCredentials?: string;
}

/**
 * Task definition - submitted to executor
 */
export interface TaskDefinition {
  // Identity
  id: string;
  type: TaskType;
  priority?: number;

  // Agent and execution context
  agentId: string;
  projectPath: string;
  message: string;

  // Execution configuration
  timeoutMs: number;
  maxTurns?: number;
  modelId?: string;
  claudeVersionId?: string;
  permissionMode?: PermissionMode;

  // User isolation
  userId?: string; // For per-user workspace isolation (.workspaces/u_{userId})

  // Metadata
  createdAt: string;
  scheduledFor?: string; // For scheduled tasks
  scheduledTaskId?: string; // Original scheduled task ID (for status updates)
  cronJobId?: string; // Set only for A2A Cron jobs — used to route completion callbacks

  // Push Notification (for A2A async tasks)
  pushNotificationConfig?: TaskPushNotificationConfig;

  // Cron job context (WeKnora/Graphiti integration for scheduled tasks)
  cronContext?: {
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
  };
}

/**
 * Task execution result
 */
export interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'canceled';
  output?: string;
  sessionId?: string;
  error?: string;
  errorStack?: string;
  completedAt: string;
  executionTimeMs: number;

  // Additional metadata
  logs?: Array<{
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    type: string;
    message: string;
    data?: Record<string, unknown>;
  }>;
}

/**
 * Task status query result
 */
export interface TaskStatus {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  executionTimeMs?: number;
  error?: string;
}

/**
 * Task executor configuration
 */
export interface TaskExecutorConfig {
  // Concurrency
  maxConcurrent: number;

  // Timeouts
  defaultTimeoutMs: number;

  // Resource limits
  maxMemoryMb?: number;

  // Retry configuration
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * Interface for task executor implementations
 */
export interface ITaskExecutor {
  /**
   * Start the executor
   */
  start(): Promise<void>;

  /**
   * Stop the executor and cancel all running tasks
   */
  stop(): Promise<void>;

  /**
   * Submit a task for execution
   * @param task - Task definition
   */
  submitTask(task: TaskDefinition): Promise<void>;

  /**
   * Cancel a running or pending task
   * @param taskId - Task ID to cancel
   * @returns true if task was canceled, false if not found or already completed
   */
  cancelTask(taskId: string): Promise<boolean>;

  /**
   * Get current status of a task
   * @param taskId - Task ID to query
   * @returns Task status or null if not found
   */
  getTaskStatus(taskId: string): Promise<TaskStatus | null>;

  /**
   * Check if executor is healthy
   */
  isHealthy(): boolean;

  /**
   * Get executor statistics
   */
  getStats(): TaskExecutorStats;

  /**
   * Get current executor configuration
   */
  getConfig(): TaskExecutorConfig;

  /**
   * Update executor configuration dynamically
   * @param config - Partial configuration to update
   */
  updateConfig(config: Partial<TaskExecutorConfig>): void;
}

/**
 * Executor statistics
 */
export interface TaskExecutorStats {
  mode: string;
  runningTasks: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
  canceledTasks: number;
  uptimeMs: number;
}
