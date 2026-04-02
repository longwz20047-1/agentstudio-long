import fs from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import { getProjectA2ADir } from '../../config/paths.js';

const HISTORY_FILENAME = 'history.json';
const MAX_RECORDS = 1000;

// Per-user directory within .a2a/opencli/ — same safeId pattern as workspaceUtils.ts
function getUserOpenCliDir(workingDirectory: string, userId: string): string {
  const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getProjectA2ADir(workingDirectory), 'opencli', `u_${safeId}`);
}

export interface ExecutionHistoryRecord {
  id: string;
  projectId: string;
  bridgeId: string;
  command: string;
  status: 'pending' | 'success' | 'error' | 'timeout';
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  executedAt: string;   // ISO timestamp
  completedAt?: string; // ISO timestamp
  duration?: number;    // ms
  userId: string;
  workingDirectory: string;
}

interface HistoryFile {
  version: '1.0.0';
  records: ExecutionHistoryRecord[];
}

export interface HistoryQueryResult {
  total: number;
  records: ExecutionHistoryRecord[];
}

export class BridgeHistoryStore {
  private getHistoryPath(workingDirectory: string, userId: string): string {
    return path.join(getUserOpenCliDir(workingDirectory, userId), HISTORY_FILENAME);
  }

  private loadHistory(workingDirectory: string, userId: string): HistoryFile {
    const filePath = this.getHistoryPath(workingDirectory, userId);
    if (!fs.existsSync(filePath)) {
      return { version: '1.0.0', records: [] };
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return { version: '1.0.0', records: [] };
    }
  }

  private saveHistory(workingDirectory: string, userId: string, history: HistoryFile): void {
    const dir = getUserOpenCliDir(workingDirectory, userId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.getHistoryPath(workingDirectory, userId), JSON.stringify(history, null, 2));
  }

  private ensureFile(workingDirectory: string, userId: string): string {
    const dir = getUserOpenCliDir(workingDirectory, userId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = this.getHistoryPath(workingDirectory, userId);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify({ version: '1.0.0', records: [] }, null, 2));
    }
    return filePath;
  }

  /** Atomic read-modify-write with file lock (same pattern as bridgeKeyService) */
  private withLockedHistory<T>(workingDirectory: string, userId: string, fn: (history: HistoryFile) => T): T {
    const filePath = this.ensureFile(workingDirectory, userId);
    const release = lockfile.lockSync(filePath);
    try {
      const history = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HistoryFile;
      const result = fn(history);
      fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
      return result;
    } finally {
      release();
    }
  }

  async recordExecution(workingDirectory: string, userId: string, record: ExecutionHistoryRecord): Promise<void> {
    this.withLockedHistory(workingDirectory, userId, history => {
      history.records.push(record);
      if (history.records.length > MAX_RECORDS) {
        history.records = history.records.slice(-MAX_RECORDS);
      }
    });
  }

  async getRecord(workingDirectory: string, userId: string, recordId: string): Promise<ExecutionHistoryRecord | null> {
    const history = this.loadHistory(workingDirectory, userId);
    return history.records.find(r => r.id === recordId) || null;
  }

  async getHistory(
    workingDirectory: string,
    userId: string,
    limit: number,
    offset: number
  ): Promise<HistoryQueryResult> {
    const history = this.loadHistory(workingDirectory, userId);
    const total = history.records.length;
    const records = history.records.slice().reverse().slice(offset, offset + limit);
    return { total, records };
  }

  async clearHistory(workingDirectory: string, userId: string, olderThanDays: number): Promise<number> {
    const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    return this.withLockedHistory(workingDirectory, userId, history => {
      const before = history.records.length;
      history.records = history.records.filter(r => new Date(r.executedAt).getTime() > cutoffTime);
      return before - history.records.length;
    });
  }
}
