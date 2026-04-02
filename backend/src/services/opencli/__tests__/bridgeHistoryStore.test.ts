import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BridgeHistoryStore } from '../bridgeHistoryStore.js';
import type { ExecutionHistoryRecord } from '../bridgeHistoryStore.js';

const store = new BridgeHistoryStore();

function makeRecord(overrides: Partial<ExecutionHistoryRecord> = {}): ExecutionHistoryRecord {
  return {
    id: 'hist_test',
    projectId: 'proj_123',
    bridgeId: 'bridge_001',
    command: 'twitter timeline',
    status: 'success',
    exitCode: 0,
    stdout: 'result',
    executedAt: new Date().toISOString(),
    userId: 'user_1',
    workingDirectory: '',
    ...overrides,
  };
}

describe('BridgeHistoryStore', () => {
  let tmpDir: string;

  function createTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-history-test-'));
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── recordExecution ───────────────────────────────────────────────────────

  it('writes record to per-user path .a2a/opencli/u_{safeId}/history.json', async () => {
    tmpDir = createTmpDir();
    const userId = 'user@example.com';
    const record = makeRecord({ workingDirectory: tmpDir, userId });

    await store.recordExecution(tmpDir, userId, record);

    // safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_') = 'user_example_com'
    const histPath = path.join(tmpDir, '.a2a', 'opencli', 'u_user_example_com', 'history.json');
    expect(fs.existsSync(histPath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(histPath, 'utf-8'));
    expect(data.version).toBe('1.0.0');
    expect(data.records).toHaveLength(1);
    expect(data.records[0].command).toBe('twitter timeline');
  });

  it('different users write to independent files', async () => {
    tmpDir = createTmpDir();
    await store.recordExecution(tmpDir, 'alice@example.com', makeRecord({ workingDirectory: tmpDir, userId: 'alice@example.com', command: 'alice cmd' }));
    await store.recordExecution(tmpDir, 'bob@example.com', makeRecord({ workingDirectory: tmpDir, userId: 'bob@example.com', command: 'bob cmd' }));

    const aliceResult = await store.getHistory(tmpDir, 'alice@example.com', 10, 0);
    const bobResult = await store.getHistory(tmpDir, 'bob@example.com', 10, 0);

    expect(aliceResult.records[0].command).toBe('alice cmd');
    expect(bobResult.records[0].command).toBe('bob cmd');
    expect(aliceResult.total).toBe(1);
    expect(bobResult.total).toBe(1);
  });

  // ── getHistory ────────────────────────────────────────────────────────────

  it('returns records with pagination (newest first)', async () => {
    tmpDir = createTmpDir();
    const userId = 'user_1';

    for (let i = 0; i < 5; i++) {
      await store.recordExecution(tmpDir, userId, makeRecord({
        id: `hist_${i}`,
        command: `cmd_${i}`,
        executedAt: new Date(Date.now() + i * 1000).toISOString(),
        workingDirectory: tmpDir,
        userId,
      }));
    }

    const page1 = await store.getHistory(tmpDir, userId, 3, 0);
    expect(page1.total).toBe(5);
    expect(page1.records).toHaveLength(3);
    // Newest first — last inserted should be first
    expect(page1.records[0].id).toBe('hist_4');

    const page2 = await store.getHistory(tmpDir, userId, 3, 3);
    expect(page2.total).toBe(5);
    expect(page2.records).toHaveLength(2);
  });

  it('returns empty result for user with no history', async () => {
    tmpDir = createTmpDir();
    const result = await store.getHistory(tmpDir, 'nobody@example.com', 50, 0);
    expect(result.total).toBe(0);
    expect(result.records).toHaveLength(0);
  });

  // ── clearHistory ──────────────────────────────────────────────────────────

  it('removes records older than N days', async () => {
    tmpDir = createTmpDir();
    const userId = 'user_1';
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date().toISOString();

    await store.recordExecution(tmpDir, userId, makeRecord({ id: 'hist_old', executedAt: oldDate, workingDirectory: tmpDir, userId }));
    await store.recordExecution(tmpDir, userId, makeRecord({ id: 'hist_new', executedAt: recentDate, workingDirectory: tmpDir, userId }));

    const deleted = await store.clearHistory(tmpDir, userId, 90);
    expect(deleted).toBe(1);

    const remaining = await store.getHistory(tmpDir, userId, 50, 0);
    expect(remaining.total).toBe(1);
    expect(remaining.records[0].id).toBe('hist_new');
  });

  it('returns 0 when nothing to clear', async () => {
    tmpDir = createTmpDir();
    const deleted = await store.clearHistory(tmpDir, 'nobody@example.com', 30);
    expect(deleted).toBe(0);
  });
});
