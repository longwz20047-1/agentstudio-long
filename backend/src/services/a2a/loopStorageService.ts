/**
 * Loop Storage Service
 *
 * Manages the persistence of cron loop lifecycle events using JSONL files.
 * Separate from A2A conversation history to avoid polluting the message stream.
 *
 * Storage path: {workingDirectory}/.a2a/loops/{sessionId}.jsonl
 *
 * Event types:
 * - loop_created: CronCreate tool_use confirmed (extracted from SSE callback)
 * - loop_deleted: CronDelete tool_use detected (extracted from SSE callback)
 * - loop_execution: Cron-triggered turn completed (from orphan message handler)
 */

import fs from 'fs/promises';
import path from 'path';
import { ensureDir } from '../../utils/fileUtils.js';

// --- Event type definitions ---

export interface LoopCreatedEvent {
  type: 'loop_created';
  jobId: string;        // SDK cron job ID (hex string)
  cron: string;         // Cron expression, e.g. "*/5 * * * *"
  prompt: string;       // Prompt executed on each cron fire
  recurring: boolean;   // true = recurring, false = one-shot
  timestamp: number;
}

export interface LoopDeletedEvent {
  type: 'loop_deleted';
  jobId: string;
  timestamp: number;
}

export interface LoopExecutionEvent {
  type: 'loop_execution';
  status: string;       // result.subtype, e.g. "success", "error"
  timestamp: number;    // When the orphan result message arrived
  prompt?: string;      // Cron prompt (extracted from user message in the orphan turn)
  content?: string;     // Claude's response (extracted from assistant messages)
}

export type LoopEvent = LoopCreatedEvent | LoopDeletedEvent | LoopExecutionEvent;

// --- Service ---

class LoopStorageService {
  private getLoopsDir(workingDirectory: string): string {
    return path.join(workingDirectory, '.a2a', 'loops');
  }

  private getLoopsFilePath(workingDirectory: string, sessionId: string): string {
    return path.join(this.getLoopsDir(workingDirectory), `${sessionId}.jsonl`);
  }

  /**
   * Append a loop event to the JSONL file
   */
  async appendEvent(workingDirectory: string, sessionId: string, event: LoopEvent): Promise<void> {
    const loopsDir = this.getLoopsDir(workingDirectory);
    await ensureDir(loopsDir);

    const filePath = this.getLoopsFilePath(workingDirectory, sessionId);
    const line = JSON.stringify(event) + '\n';

    await fs.appendFile(filePath, line, 'utf-8');
  }

  /**
   * Read all loop events for a session
   */
  async readEvents(workingDirectory: string, sessionId: string): Promise<LoopEvent[]> {
    const filePath = this.getLoopsFilePath(workingDirectory, sessionId);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const result: LoopEvent[] = [];
      const lines = content.split('\n').filter((line: string) => line.trim());

      for (const line of lines) {
        try {
          result.push(JSON.parse(line));
        } catch {
          // Skip malformed lines (e.g. incomplete writes)
        }
      }

      return result;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}

export const loopStorageService = new LoopStorageService();
