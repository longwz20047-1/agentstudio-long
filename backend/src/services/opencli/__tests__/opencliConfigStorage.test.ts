import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  loadProjectOpenCliConfig,
  saveProjectOpenCliConfig,
  loadProjectOpenCliEnabled,
  loadUserOpenCliConfig,
  saveUserOpenCliConfig,
} from '../opencliConfigStorage.js';
import type { OpenCliProjectConfig } from '../types.js';

describe('opencliConfigStorage', () => {
  let tmpDir: string;

  function createTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-cfg-test-'));
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Project-level (enabled toggle) ────────────────────────────────────────

  it('returns undefined for unconfigured project (no .a2a dir)', () => {
    tmpDir = createTmpDir();
    const result = loadProjectOpenCliConfig(tmpDir);
    expect(result).toBeUndefined();
  });

  it('saves and loads project-level config (enabled only)', () => {
    tmpDir = createTmpDir();
    const config: OpenCliProjectConfig = { enabled: true };

    saveProjectOpenCliConfig(tmpDir, config);
    const loaded = loadProjectOpenCliConfig(tmpDir);

    expect(loaded).toBeDefined();
    expect(loaded!.enabled).toBe(true);
  });

  it('loadProjectOpenCliEnabled returns false for unconfigured project', () => {
    tmpDir = createTmpDir();
    expect(loadProjectOpenCliEnabled(tmpDir)).toBe(false);
  });

  it('loadProjectOpenCliEnabled returns true after enabling', () => {
    tmpDir = createTmpDir();
    saveProjectOpenCliConfig(tmpDir, { enabled: true });
    expect(loadProjectOpenCliEnabled(tmpDir)).toBe(true);
  });

  it('overwrites existing project config', () => {
    tmpDir = createTmpDir();
    saveProjectOpenCliConfig(tmpDir, { enabled: true });
    saveProjectOpenCliConfig(tmpDir, { enabled: false });
    const loaded = loadProjectOpenCliConfig(tmpDir);
    expect(loaded!.enabled).toBe(false);
  });

  it('returns undefined for corrupted JSON file', () => {
    tmpDir = createTmpDir();
    const a2aDir = path.join(tmpDir, '.a2a');
    fs.mkdirSync(a2aDir, { recursive: true });
    fs.writeFileSync(path.join(a2aDir, 'opencli-config.json'), '{ not valid json');

    const result = loadProjectOpenCliConfig(tmpDir);
    expect(result).toBeUndefined();
  });

  // ── Per-user config (enabledDomains) ──────────────────────────────────────

  it('loadUserOpenCliConfig returns all domains by default', () => {
    tmpDir = createTmpDir();
    const config = loadUserOpenCliConfig(tmpDir, 'alice@example.com');
    expect(config.enabledDomains).toEqual(['social', 'media', 'finance', 'news', 'desktop', 'jobs']);
  });

  it('saves and loads per-user domain config', () => {
    tmpDir = createTmpDir();
    saveUserOpenCliConfig(tmpDir, 'alice@example.com', { enabledDomains: ['social', 'news'] });
    const loaded = loadUserOpenCliConfig(tmpDir, 'alice@example.com');
    expect(loaded.enabledDomains).toEqual(['social', 'news']);
  });

  it('different users have independent configs', () => {
    tmpDir = createTmpDir();
    saveUserOpenCliConfig(tmpDir, 'alice@example.com', { enabledDomains: ['social'] });
    saveUserOpenCliConfig(tmpDir, 'bob@example.com', { enabledDomains: ['finance', 'media'] });

    expect(loadUserOpenCliConfig(tmpDir, 'alice@example.com').enabledDomains).toEqual(['social']);
    expect(loadUserOpenCliConfig(tmpDir, 'bob@example.com').enabledDomains).toEqual(['finance', 'media']);
  });

  it('userId with special chars is safely encoded in path', () => {
    tmpDir = createTmpDir();
    const userId = 'user@example.com';
    saveUserOpenCliConfig(tmpDir, userId, { enabledDomains: ['desktop'] });

    // File should exist at u_user_example_com/config.json
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const configPath = path.join(tmpDir, '.a2a', 'opencli', `u_${safeId}`, 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const loaded = loadUserOpenCliConfig(tmpDir, userId);
    expect(loaded.enabledDomains).toEqual(['desktop']);
  });
});
