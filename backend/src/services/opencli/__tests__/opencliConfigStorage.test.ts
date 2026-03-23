import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  loadProjectOpenCliConfig,
  saveProjectOpenCliConfig,
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

  it('returns undefined for unconfigured project (no .a2a dir)', () => {
    tmpDir = createTmpDir();
    const result = loadProjectOpenCliConfig(tmpDir);
    expect(result).toBeUndefined();
  });

  it('saves and loads config correctly', () => {
    tmpDir = createTmpDir();
    const config: OpenCliProjectConfig = {
      enabled: true,
      enabledDomains: ['social', 'news'],
    };

    saveProjectOpenCliConfig(tmpDir, config);
    const loaded = loadProjectOpenCliConfig(tmpDir);

    expect(loaded).toBeDefined();
    expect(loaded!.enabled).toBe(true);
    expect(loaded!.enabledDomains).toEqual(['social', 'news']);
  });

  it('overwrites existing config', () => {
    tmpDir = createTmpDir();
    const original: OpenCliProjectConfig = {
      enabled: true,
      enabledDomains: ['social'],
    };
    const updated: OpenCliProjectConfig = {
      enabled: false,
      enabledDomains: ['finance', 'media'],
    };

    saveProjectOpenCliConfig(tmpDir, original);
    saveProjectOpenCliConfig(tmpDir, updated);
    const loaded = loadProjectOpenCliConfig(tmpDir);

    expect(loaded).toBeDefined();
    expect(loaded!.enabled).toBe(false);
    expect(loaded!.enabledDomains).toEqual(['finance', 'media']);
  });

  it('returns undefined for corrupted JSON file', () => {
    tmpDir = createTmpDir();
    const a2aDir = path.join(tmpDir, '.a2a');
    fs.mkdirSync(a2aDir, { recursive: true });
    fs.writeFileSync(path.join(a2aDir, 'opencli-config.json'), '{ not valid json');

    const result = loadProjectOpenCliConfig(tmpDir);
    expect(result).toBeUndefined();
  });
});
