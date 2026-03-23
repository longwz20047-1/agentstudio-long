import fs from 'fs';
import path from 'path';
import { getProjectA2ADir } from '../../config/paths.js';
import type { OpenCliProjectConfig } from './types.js';

const CONFIG_FILENAME = 'opencli-config.json';

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
