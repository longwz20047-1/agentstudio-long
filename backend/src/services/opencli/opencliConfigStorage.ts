import fs from 'fs';
import path from 'path';
import { getProjectA2ADir } from '../../config/paths.js';
import { ALL_DOMAINS } from './constants.js';
import type { OpenCliProjectConfig } from './types.js';

const CONFIG_FILENAME = 'opencli-config.json';

// ── Project-level (enabled toggle only) ──────────────────────────────────────

export function loadProjectOpenCliConfig(workingDirectory: string): OpenCliProjectConfig | undefined {
  const configPath = path.join(getProjectA2ADir(workingDirectory), CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

export function saveProjectOpenCliConfig(workingDirectory: string, config: OpenCliProjectConfig): void {
  const dir = getProjectA2ADir(workingDirectory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(config, null, 2));
}

/** Convenience: read just the project-level enabled flag. */
export function loadProjectOpenCliEnabled(workingDirectory: string): boolean {
  return loadProjectOpenCliConfig(workingDirectory)?.enabled ?? false;
}

// ── Per-user config (enabledDomains) ─────────────────────────────────────────

function getUserOpenCliDir(workingDirectory: string, userId: string): string {
  const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getProjectA2ADir(workingDirectory), 'opencli', `u_${safeId}`);
}

export interface UserOpenCliConfig {
  enabledDomains: string[];
}

/** Per-user domain preferences. Defaults to all domains on first access. */
export function loadUserOpenCliConfig(workingDirectory: string, userId: string): UserOpenCliConfig {
  const configPath = path.join(getUserOpenCliDir(workingDirectory, userId), 'config.json');
  if (!fs.existsSync(configPath)) {
    return { enabledDomains: [...ALL_DOMAINS] };
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return { enabledDomains: [...ALL_DOMAINS] };
  }
}

export function saveUserOpenCliConfig(
  workingDirectory: string,
  userId: string,
  config: UserOpenCliConfig
): void {
  const dir = getUserOpenCliDir(workingDirectory, userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}
