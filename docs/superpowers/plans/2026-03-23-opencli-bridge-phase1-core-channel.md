# OpenCLI Bridge Phase 1: Core Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end: A2A chat message → MCP tool selection → WebSocket dispatch to local Electron bridge → opencli CLI execution → result back to Claude → rendered in weknora-ui.

**Architecture:** Server-side (agentstudio backend) adds a new `services/opencli/` module with bridge registry, command proxy, and dynamic MCP tool factory. A new WebSocket endpoint `/api/opencli/bridge` accepts connections from a lightweight Electron tray app (`opencli-bridge/`) running on the user's local machine. The Electron app spawns `opencli` CLI commands and returns JSON results. Phase 1 uses hardcoded config (no pairing flow) and auto-executes all commands (no permission engine).

**Tech Stack:** TypeScript, Express, WebSocket (`ws`), Electron, cross-spawn, Zod, Vitest

**Design Doc:** `docs/superpowers/specs/2026-03-22-opencli-integration-design.md` (1499 lines, 4 rounds of review, 27 fixes applied)

**Scope:** Phase 1 only (Core Channel). Subsequent phases (Pairing, Permission, Management Console, Tool Cards, Polish) are separate plans.

**Projects affected:**
- `agentstudio/backend/` — new services + route modifications (~800 lines)
- `opencli-bridge/` — new Electron project (~400 lines)

---

## File Structure

### New Files (agentstudio backend)

| File | Responsibility |
|------|---------------|
| `backend/src/services/opencli/types.ts` | All type definitions: OpenCliContext, BridgeCommand, BridgeResult, BridgeEntry, BridgeCapabilities, RegistryKey |
| `backend/src/services/opencli/constants.ts` | DOMAIN_MAPPING (6 domains, 51 sites), WRITE_OPERATIONS whitelist (75 commands), DESCRIPTION_ENRICHMENT |
| `backend/src/services/opencli/bridgeRegistry.ts` | In-memory Map<RegistryKey, BridgeEntry>, register/unregister/get/isOnline, userId normalization |
| `backend/src/services/opencli/bridgeCommandProxy.ts` | Promise+ID Map dispatch: MCP tool → WS command → await result. Timeout handling, rejectAllForBridge() |
| `backend/src/services/opencli/bridgeKeyService.ts` | `obk_` API key generation/validation for Phase 1 manual testing. bcrypt hash + AES-256-GCM (reuse apiKeyService pattern) |
| `backend/src/services/opencli/outputFormatter.ts` | Firecrawl pattern: `## site/action results` + JSON code block |
| `backend/src/services/opencli/opencliMcpFactory.ts` | Dynamic MCP tool generation per domain. Site-level composite tools with action enum. Registers to queryOptions.mcpServers |
| `backend/src/services/opencli/opencliConfigStorage.ts` | Per-project `.a2a/opencli-config.json` CRUD. loadProjectOpenCliConfig / saveProjectOpenCliConfig |
| `backend/src/services/opencli/index.ts` | Export integrateOpenCliMcpServers() — the main integration function called from claudeUtils.ts |
| `backend/src/routes/opencliWs.ts` | WebSocket endpoint `/api/opencli/bridge`. Independent WebSocketServer, obk_ key auth, heartbeat, command relay |
| `backend/src/services/opencli/__tests__/bridgeRegistry.test.ts` | Unit tests for registry |
| `backend/src/services/opencli/__tests__/bridgeCommandProxy.test.ts` | Unit tests for command dispatch + timeout |
| `backend/src/services/opencli/__tests__/outputFormatter.test.ts` | Unit tests for formatting |
| `backend/src/services/opencli/__tests__/opencliMcpFactory.test.ts` | Unit tests for MCP tool generation |
| `backend/src/services/opencli/__tests__/opencliConfigStorage.test.ts` | Unit tests for config storage |

### Modified Files (agentstudio backend)

| File | Changes |
|------|---------|
| `backend/src/services/websocketService.ts:56-58` | Change `socket.destroy()` to `return` for non-`/ws` paths (allow opencli WS handler to fire) |
| `backend/src/index.ts:~678` | Add `setupOpenCliBridgeWs(server)` call after `setupWebSocket(server)` |
| `backend/src/utils/claudeUtils.ts:~587` | Add opencli integration block after AskUserQuestion, before return |
| `backend/src/routes/a2a.ts:~684-801` | Construct OpenCliContext from a2aContext + graphitiContext, pass in extendedOptions |

### New Project (opencli-bridge)

| File | Responsibility |
|------|---------------|
| `opencli-bridge/package.json` | Electron, cross-spawn, ws, auto-launch deps |
| `opencli-bridge/tsconfig.json` | TypeScript config for Electron main process |
| `opencli-bridge/electron-builder.yml` | Build config (Phase 1: dev only, no distribution) |
| `opencli-bridge/src/types.ts` | Shared types: ServerConfig, BridgeCommand, BridgeResult, WS message types |
| `opencli-bridge/src/configStore.ts` | Read/write `~/.opencli-bridge/config.json` |
| `opencli-bridge/src/capabilityScanner.ts` | Spawn `opencli list -f json` → extract available sites |
| `opencli-bridge/src/commandRunner.ts` | Spawn `opencli <site> <action> <args> -f json` via cross-spawn. Semaphore (max 3) |
| `opencli-bridge/src/connectionManager.ts` | Single-server WS lifecycle: connect, register, heartbeat, reconnect with exponential backoff |
| `opencli-bridge/src/tray.ts` | System tray: 3 icon states (connected/partial/disconnected), right-click menu |
| `opencli-bridge/src/trayFallback.ts` | Linux tray detection + fallback mini-window (GNOME 3.26+ removed tray). Required in Phase 1 per spec §5.3 |
| `opencli-bridge/src/main.ts` | Electron entry: create tray, init config, start connection |

---

## Task Dependency Graph

```
Task 1 (types+constants) ──→ Task 2 (bridgeRegistry) ──→ Task 4 (bridgeCommandProxy)
                          ──→ Task 3 (configStorage)        │
                          ──→ Task 5 (bridgeKeyService)      │
                          ──→ Task 6 (outputFormatter)       │
                                                             ↓
                              Task 7 (opencliMcpFactory) ←── ┘
                                       │
                                       ↓
                              Task 8 (opencliWs.ts + websocketService fix)
                                       │
                                       ↓
                              Task 9 (claudeUtils + a2a.ts integration)
                                       │
                                       ↓
                              Task 10 (Electron app — opencli-bridge)
                                       │
                                       ↓
                              Task 11 (End-to-end integration test)
```

---

## Task 1: Types and Constants

**Files:**
- Create: `backend/src/services/opencli/types.ts`
- Create: `backend/src/services/opencli/constants.ts`

- [ ] **Step 1: Create types.ts with all type definitions**

```typescript
// backend/src/services/opencli/types.ts
import type { WebSocket } from 'ws';

export type RegistryKey = `${string}||${string}`;

export interface BridgeEntry {
  bridgeId: string;
  deviceName: string;
  userId: string;
  projectId: string;
  ws: WebSocket;
  status: 'online' | 'offline';
  connectedAt: Date;
  lastHeartbeat: Date;
  capabilities: BridgeCapabilities;
}

export interface BridgeCapabilities {
  opencliVersion: string;
  nodeVersion: string;
  platform: string;
  daemonRunning: boolean;
  extensionConnected: boolean;
  availableSites: string[];
}

export interface BridgeCommand {
  id: string;
  site: string;
  action: string;
  args: string[];
  timeout?: number;
  env?: Record<string, string>;
}

export interface BridgeResult {
  id: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface OpenCliContext {
  enabled: boolean;
  enabledDomains: string[];
  projectId: string;
  userId: string;
}

export interface OpenCliProjectConfig {
  enabled: boolean;
  enabledDomains: string[];
}

export interface PendingCommand {
  resolve: (stdout: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  projectId: string;
  userId: string;
}

export interface RegisterMessage {
  type: 'register';
  bridgeId: string;
  deviceName: string;
  userId: string;
  projects: Array<{ projectId: string; projectName: string }>;
  capabilities: BridgeCapabilities;
}

export interface ResultMessage {
  type: 'result';
  id: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class BridgeError extends Error {
  constructor(public code: 'BRIDGE_OFFLINE' | 'BRIDGE_DISCONNECTED' | 'BRIDGE_TIMEOUT' | 'CLI_NOT_FOUND' | 'EXEC_ERROR', message?: string) {
    super(message || code);
    this.name = 'BridgeError';
  }
}
```

- [ ] **Step 2: Create constants.ts with domain mapping**

```typescript
// backend/src/services/opencli/constants.ts
// Domain mapping verified against opencli v1.3.1 (293 commands, 51 sites)

export const DOMAIN_MAPPING: Record<string, string[]> = {
  social: ['twitter', 'reddit', 'tiktok', 'instagram', 'jike', 'xiaohongshu', 'v2ex', 'coupang', 'zhihu', 'weibo', 'smzdm', 'ctrip', 'facebook'],
  media: ['bilibili', 'weread', 'douban', 'youtube', 'xiaoyuzhou', 'apple-podcasts', 'medium', 'jimeng'],
  finance: ['bloomberg', 'xueqiu', 'barchart', 'yahoo-finance', 'sinafinance'],
  news: ['linux-do', 'stackoverflow', 'wikipedia', 'lobsters', 'sinablog', 'google', 'devto', 'substack', 'arxiv', 'chaoxing', 'hackernews', 'bbc', 'reuters', 'steam', 'hf'],
  desktop: ['cursor', 'codex', 'chatwise', 'antigravity', 'notion', 'discord-app', 'chatgpt', 'grok'],
  jobs: ['boss', 'linkedin'],
};

export const ALL_DOMAINS = Object.keys(DOMAIN_MAPPING);

// Write operations whitelist (75 commands requiring user confirmation)
// Phase 1: all commands auto-execute (no permission engine)
// Phase 3 will enforce this whitelist
export const WRITE_OPERATIONS: Record<string, string[]> = {
  twitter: ['post', 'reply', 'delete', 'like', 'follow', 'unfollow', 'bookmark', 'unbookmark', 'accept', 'reply-dm', 'block', 'unblock', 'hide-reply'],
  reddit: ['comment', 'upvote', 'save', 'subscribe'],
  tiktok: ['comment', 'follow', 'like', 'save', 'unfollow', 'unlike', 'unsave'],
  instagram: ['comment', 'follow', 'like', 'save', 'unfollow', 'unlike', 'unsave', 'add-friend'],
  facebook: ['add-friend', 'join-group'],
  boss: ['greet', 'batchgreet', 'send', 'invite', 'mark', 'exchange'],
  jike: ['create', 'comment', 'like', 'repost'],
  cursor: ['send', 'new', 'composer', 'ask'],
  codex: ['send', 'new', 'ask'],
  antigravity: ['send', 'new'],
  chatgpt: ['send', 'new', 'ask'],
  chatwise: ['send', 'new', 'ask'],
  notion: ['write', 'new'],
  'discord-app': ['send'],
  grok: ['ask'],
  jimeng: ['generate'],
};

export const DEFAULT_COMMAND_TIMEOUT = 30000;  // 30s for read
export const WRITE_COMMAND_TIMEOUT = 60000;    // 60s for write
export const HEARTBEAT_INTERVAL = 30000;       // 30s
export const HEARTBEAT_TIMEOUT = 10000;        // 10s pong deadline
export const MAX_MISSED_HEARTBEATS = 3;
```

- [ ] **Step 3: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/types.ts backend/src/services/opencli/constants.ts
git commit -m "feat: add opencli types and constants (Phase 1)"
```

---

## Task 2: Bridge Registry

**Files:**
- Create: `backend/src/services/opencli/bridgeRegistry.ts`
- Create: `backend/src/services/opencli/__tests__/bridgeRegistry.test.ts`

- [ ] **Step 1: Write failing tests for bridgeRegistry**

```typescript
// backend/src/services/opencli/__tests__/bridgeRegistry.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BridgeRegistry } from '../bridgeRegistry.js';
import type { RegisterMessage } from '../types.js';

function createMockWs(readyState = 1 /* OPEN */): any {
  return { readyState, send: vi.fn(), close: vi.fn() };
}

function createRegisterMsg(overrides: Partial<RegisterMessage> = {}): RegisterMessage {
  return {
    type: 'register',
    bridgeId: 'b_test',
    deviceName: 'Test-PC',
    userId: 'alice@example.com',
    projects: [{ projectId: 'proj_001', projectName: 'Test' }],
    capabilities: {
      opencliVersion: '1.3.1', nodeVersion: '20.0.0', platform: 'win32',
      daemonRunning: true, extensionConnected: true,
      availableSites: ['twitter', 'bilibili', 'hackernews'],
    },
    ...overrides,
  };
}

describe('BridgeRegistry', () => {
  let registry: BridgeRegistry;

  beforeEach(() => { registry = new BridgeRegistry(); });

  it('registers a bridge and marks it online', () => {
    const ws = createMockWs();
    registry.register(ws, createRegisterMsg());
    expect(registry.isOnline('proj_001', 'alice@example.com')).toBe(true);
  });

  it('normalizes userId to lowercase', () => {
    const ws = createMockWs();
    registry.register(ws, createRegisterMsg({ userId: 'Alice@Example.COM' }));
    expect(registry.isOnline('proj_001', 'alice@example.com')).toBe(true);
  });

  it('registers multiple projects from one WS', () => {
    const ws = createMockWs();
    registry.register(ws, createRegisterMsg({
      projects: [
        { projectId: 'proj_001', projectName: 'A' },
        { projectId: 'proj_002', projectName: 'B' },
      ],
    }));
    expect(registry.isOnline('proj_001', 'alice@example.com')).toBe(true);
    expect(registry.isOnline('proj_002', 'alice@example.com')).toBe(true);
  });

  it('unregisters all entries for a WS', () => {
    const ws = createMockWs();
    registry.register(ws, createRegisterMsg());
    registry.unregister(ws);
    expect(registry.isOnline('proj_001', 'alice@example.com')).toBe(false);
  });

  it('device takeover: last-wins', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    registry.register(ws1, createRegisterMsg({ deviceName: 'PC1' }));
    registry.register(ws2, createRegisterMsg({ deviceName: 'PC2' }));

    const entry = registry.get('proj_001', 'alice@example.com');
    expect(entry?.deviceName).toBe('PC2');
    expect(ws1.send).toHaveBeenCalledWith(expect.stringContaining('device_replaced'));
  });

  it('get returns undefined for offline bridge', () => {
    expect(registry.get('proj_001', 'alice@example.com')).toBeUndefined();
  });

  it('getAllForProject returns entries for a project', () => {
    const ws = createMockWs();
    registry.register(ws, createRegisterMsg());
    expect(registry.getAllForProject('proj_001')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/bridgeRegistry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement bridgeRegistry.ts**

```typescript
// backend/src/services/opencli/bridgeRegistry.ts
import type { WebSocket } from 'ws';
import type { BridgeEntry, RegisterMessage, RegistryKey } from './types.js';

export class BridgeRegistry {
  private entries = new Map<RegistryKey, BridgeEntry>();

  private makeKey(projectId: string, userId: string): RegistryKey {
    return `${projectId}||${userId.trim().toLowerCase()}` as RegistryKey;
  }

  register(ws: WebSocket, msg: RegisterMessage): void {
    const normalizedUserId = msg.userId.trim().toLowerCase();
    for (const project of msg.projects) {
      const key = this.makeKey(project.projectId, normalizedUserId);
      const existing = this.entries.get(key);

      if (existing && existing.ws !== ws && (existing.ws as any).readyState === 1) {
        existing.ws.send(JSON.stringify({
          type: 'device_replaced',
          projectId: project.projectId,
          replacedBy: msg.deviceName,
        }));
      }

      this.entries.set(key, {
        bridgeId: msg.bridgeId,
        deviceName: msg.deviceName,
        userId: normalizedUserId,
        projectId: project.projectId,
        ws,
        status: 'online',
        connectedAt: new Date(),
        lastHeartbeat: new Date(),
        capabilities: msg.capabilities,
      });
    }
  }

  unregister(ws: WebSocket): BridgeEntry[] {
    const removed: BridgeEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.ws === ws) {
        this.entries.delete(key);
        removed.push(entry);
      }
    }
    return removed;
  }

  get(projectId: string, userId: string): BridgeEntry | undefined {
    return this.entries.get(this.makeKey(projectId, userId));
  }

  isOnline(projectId: string, userId: string): boolean {
    const entry = this.get(projectId, userId);
    return !!entry && entry.status === 'online' && (entry.ws as any).readyState === 1;
  }

  getAllForProject(projectId: string): BridgeEntry[] {
    return [...this.entries.values()].filter(e => e.projectId === projectId);
  }

  getAllForUser(userId: string): BridgeEntry[] {
    const normalized = userId.trim().toLowerCase();
    return [...this.entries.values()].filter(e => e.userId === normalized);
  }

  updateHeartbeat(ws: WebSocket): void {
    for (const entry of this.entries.values()) {
      if (entry.ws === ws) entry.lastHeartbeat = new Date();
    }
  }
}

export const bridgeRegistry = new BridgeRegistry();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/bridgeRegistry.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/bridgeRegistry.ts backend/src/services/opencli/__tests__/bridgeRegistry.test.ts
git commit -m "feat: add bridge registry with device takeover"
```

---

## Task 3: OpenCLI Config Storage

**Files:**
- Create: `backend/src/services/opencli/opencliConfigStorage.ts`
- Create: `backend/src/services/opencli/__tests__/opencliConfigStorage.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// backend/src/services/opencli/__tests__/opencliConfigStorage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadProjectOpenCliConfig, saveProjectOpenCliConfig } from '../opencliConfigStorage.js';

describe('opencliConfigStorage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined for unconfigured project', () => {
    expect(loadProjectOpenCliConfig(tmpDir)).toBeUndefined();
  });

  it('saves and loads config', () => {
    saveProjectOpenCliConfig(tmpDir, { enabled: true, enabledDomains: ['social', 'news'] });
    const config = loadProjectOpenCliConfig(tmpDir);
    expect(config).toEqual({ enabled: true, enabledDomains: ['social', 'news'] });
  });

  it('overwrites existing config', () => {
    saveProjectOpenCliConfig(tmpDir, { enabled: true, enabledDomains: ['social'] });
    saveProjectOpenCliConfig(tmpDir, { enabled: true, enabledDomains: ['media'] });
    expect(loadProjectOpenCliConfig(tmpDir)?.enabledDomains).toEqual(['media']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/opencliConfigStorage.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement opencliConfigStorage.ts**

```typescript
// backend/src/services/opencli/opencliConfigStorage.ts
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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/opencliConfigStorage.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/opencliConfigStorage.ts backend/src/services/opencli/__tests__/opencliConfigStorage.test.ts
git commit -m "feat: add per-project opencli config storage"
```

---

## Task 4: Bridge Command Proxy

**Files:**
- Create: `backend/src/services/opencli/bridgeCommandProxy.ts`
- Create: `backend/src/services/opencli/__tests__/bridgeCommandProxy.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// backend/src/services/opencli/__tests__/bridgeCommandProxy.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BridgeCommandProxy } from '../bridgeCommandProxy.js';
import { BridgeRegistry } from '../bridgeRegistry.js';
import { BridgeError } from '../types.js';

function createMockWs(): any {
  return { readyState: 1, send: vi.fn() };
}

describe('BridgeCommandProxy', () => {
  let proxy: BridgeCommandProxy;
  let registry: BridgeRegistry;

  beforeEach(() => {
    registry = new BridgeRegistry();
    proxy = new BridgeCommandProxy(registry);
  });

  it('throws BRIDGE_OFFLINE when no bridge registered', async () => {
    await expect(proxy.dispatch('proj_001', 'alice@example.com', {
      site: 'twitter', action: 'timeline', args: [],
    })).rejects.toThrow(BridgeError);
  });

  it('sends command to bridge and resolves on result', async () => {
    const ws = createMockWs();
    registry.register(ws, {
      type: 'register', bridgeId: 'b1', deviceName: 'PC', userId: 'alice@example.com',
      projects: [{ projectId: 'proj_001', projectName: 'Test' }],
      capabilities: { opencliVersion: '1.3.1', nodeVersion: '20', platform: 'win32', daemonRunning: true, extensionConnected: true, availableSites: ['twitter'] },
    });

    const promise = proxy.dispatch('proj_001', 'alice@example.com', {
      site: 'twitter', action: 'timeline', args: ['--limit', '5'],
    });

    // Extract the command ID from the WS send call
    const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sentMsg.type).toBe('command');
    expect(sentMsg.site).toBe('twitter');

    // Simulate bridge returning result
    proxy.onResult({ type: 'result', id: sentMsg.id, success: true, stdout: '[{"text":"hello"}]', stderr: '', exitCode: 0, durationMs: 150 });

    await expect(promise).resolves.toBe('[{"text":"hello"}]');
  });

  it('rejects with BRIDGE_TIMEOUT after timeout', async () => {
    vi.useFakeTimers();
    const ws = createMockWs();
    registry.register(ws, {
      type: 'register', bridgeId: 'b1', deviceName: 'PC', userId: 'alice@example.com',
      projects: [{ projectId: 'proj_001', projectName: 'Test' }],
      capabilities: { opencliVersion: '1.3.1', nodeVersion: '20', platform: 'win32', daemonRunning: true, extensionConnected: true, availableSites: ['twitter'] },
    });

    const promise = proxy.dispatch('proj_001', 'alice@example.com', {
      site: 'twitter', action: 'timeline', args: [], timeout: 1000,
    });

    vi.advanceTimersByTime(1001);
    await expect(promise).rejects.toThrow('BRIDGE_TIMEOUT');
    vi.useRealTimers();
  });

  it('rejectAllForBridge clears pending commands', async () => {
    const ws = createMockWs();
    registry.register(ws, {
      type: 'register', bridgeId: 'b1', deviceName: 'PC', userId: 'alice@example.com',
      projects: [{ projectId: 'proj_001', projectName: 'Test' }],
      capabilities: { opencliVersion: '1.3.1', nodeVersion: '20', platform: 'win32', daemonRunning: true, extensionConnected: true, availableSites: ['twitter'] },
    });

    const promise = proxy.dispatch('proj_001', 'alice@example.com', {
      site: 'twitter', action: 'timeline', args: [],
    });

    proxy.rejectAllForBridge('proj_001', 'alice@example.com');
    await expect(promise).rejects.toThrow('BRIDGE_DISCONNECTED');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/bridgeCommandProxy.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement bridgeCommandProxy.ts**

```typescript
// backend/src/services/opencli/bridgeCommandProxy.ts
import crypto from 'crypto';
import { BridgeError, type PendingCommand, type ResultMessage } from './types.js';
import type { BridgeRegistry } from './bridgeRegistry.js';
import { DEFAULT_COMMAND_TIMEOUT } from './constants.js';

export class BridgeCommandProxy {
  private pending = new Map<string, PendingCommand>();

  constructor(private registry: BridgeRegistry) {}

  async dispatch(
    projectId: string, userId: string,
    command: { site: string; action: string; args: string[]; timeout?: number }
  ): Promise<string> {
    const entry = this.registry.get(projectId, userId);
    if (!entry) throw new BridgeError('BRIDGE_OFFLINE');
    if ((entry.ws as any).readyState !== 1) throw new BridgeError('BRIDGE_DISCONNECTED');

    const id = crypto.randomUUID();
    const timeout = command.timeout || DEFAULT_COMMAND_TIMEOUT;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('BRIDGE_TIMEOUT'));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer, projectId, userId });
      entry.ws.send(JSON.stringify({
        type: 'command', id,
        site: command.site, action: command.action,
        args: command.args, timeout,
      }));
    });
  }

  onResult(msg: ResultMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (msg.success) {
      pending.resolve(msg.stdout);
    } else {
      pending.reject(new BridgeError('EXEC_ERROR', msg.stderr || `Exit code: ${msg.exitCode}`));
    }
  }

  rejectAllForBridge(projectId: string, userId: string): void {
    const normalizedUserId = userId.trim().toLowerCase();
    for (const [id, cmd] of this.pending) {
      if (cmd.projectId === projectId && cmd.userId.trim().toLowerCase() === normalizedUserId) {
        clearTimeout(cmd.timer);
        this.pending.delete(id);
        cmd.reject(new BridgeError('BRIDGE_DISCONNECTED'));
      }
    }
  }

  get pendingCount(): number { return this.pending.size; }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/bridgeCommandProxy.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/bridgeCommandProxy.ts backend/src/services/opencli/__tests__/bridgeCommandProxy.test.ts
git commit -m "feat: add bridge command proxy with Promise+ID Map dispatch"
```

---

## Task 5: Bridge Key Service

**Files:**
- Create: `backend/src/services/opencli/bridgeKeyService.ts`

Phase 1 only needs key generation and validation for manual testing. Full pairing flow is Phase 2.

- [ ] **Step 1: Implement bridgeKeyService.ts (minimal for Phase 1)**

```typescript
// backend/src/services/opencli/bridgeKeyService.ts
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;
const KEY_PREFIX = 'obk_';

// In-memory store for Phase 1 (Phase 2 adds persistent storage)
const keyHashes = new Map<string, string>();  // keyHash → userId

export async function generateBridgeKey(userId: string): Promise<string> {
  const random = crypto.randomBytes(16).toString('hex');
  const key = `${KEY_PREFIX}${random}`;
  const hash = await bcrypt.hash(key, SALT_ROUNDS);
  keyHashes.set(hash, userId.trim().toLowerCase());
  return key;
}

export async function validateBridgeKey(key: string): Promise<string | null> {
  if (!key.startsWith(KEY_PREFIX)) return null;
  for (const [hash, userId] of keyHashes) {
    if (await bcrypt.compare(key, hash)) return userId;
  }
  return null;
}
```

- [ ] **Step 2: Write tests for bridgeKeyService**

```typescript
// backend/src/services/opencli/__tests__/bridgeKeyService.test.ts
import { describe, it, expect } from 'vitest';
import { generateBridgeKey, validateBridgeKey } from '../bridgeKeyService.js';

describe('bridgeKeyService', () => {
  it('generates key with obk_ prefix', async () => {
    const key = await generateBridgeKey('alice@example.com');
    expect(key).toMatch(/^obk_[a-f0-9]{32}$/);
  });

  it('validates a generated key and returns userId', async () => {
    const key = await generateBridgeKey('alice@example.com');
    const userId = await validateBridgeKey(key);
    expect(userId).toBe('alice@example.com');
  });

  it('rejects invalid key', async () => {
    const userId = await validateBridgeKey('obk_invalid_key_that_does_not_exist');
    expect(userId).toBeNull();
  });

  it('rejects key without obk_ prefix', async () => {
    const userId = await validateBridgeKey('agt_proj_xxx_abc');
    expect(userId).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/bridgeKeyService.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/bridgeKeyService.ts backend/src/services/opencli/__tests__/bridgeKeyService.test.ts
git commit -m "feat: add bridge key service with tests (Phase 1 in-memory)"
```

---

## Task 6: Output Formatter

**Files:**
- Create: `backend/src/services/opencli/outputFormatter.ts`
- Create: `backend/src/services/opencli/__tests__/outputFormatter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// backend/src/services/opencli/__tests__/outputFormatter.test.ts
import { describe, it, expect } from 'vitest';
import { formatOpenCliResult, formatOpenCliError } from '../outputFormatter.js';

describe('outputFormatter', () => {
  it('formats JSON array result', () => {
    const result = formatOpenCliResult('bilibili', 'search', '[{"title":"LLM","url":"https://b23.tv/1"}]');
    expect(result.content[0].text).toContain('## bilibili/search results');
    expect(result.content[0].text).toContain('```json');
    expect(result.content[0].text).toContain('"title": "LLM"');
  });

  it('formats non-JSON result as code block', () => {
    const result = formatOpenCliResult('hackernews', 'top', 'plain text output');
    expect(result.content[0].text).toContain('## hackernews/top results');
    expect(result.content[0].text).toContain('plain text output');
  });

  it('formats error', () => {
    const result = formatOpenCliError('twitter', 'timeline', 'BRIDGE_TIMEOUT');
    expect(result.content[0].text).toContain('Error');
    expect(result.content[0].text).toContain('BRIDGE_TIMEOUT');
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/outputFormatter.test.ts`

- [ ] **Step 3: Implement outputFormatter.ts**

```typescript
// backend/src/services/opencli/outputFormatter.ts
type McpResult = { content: Array<{ type: 'text'; text: string }> };

export function formatOpenCliResult(site: string, action: string, stdout: string): McpResult {
  let formatted: string;
  try {
    const data = JSON.parse(stdout);
    const count = Array.isArray(data) ? `${data.length} found` : 'object';
    formatted = `## ${site}/${action} results (${count})\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  } catch {
    formatted = `## ${site}/${action} results\n\n\`\`\`\n${stdout}\n\`\`\``;
  }
  return { content: [{ type: 'text', text: formatted }] };
}

export function formatOpenCliError(site: string, action: string, errorMessage: string): McpResult {
  return { content: [{ type: 'text', text: `## ${site}/${action} Error\n\n${errorMessage}` }] };
}
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/outputFormatter.ts backend/src/services/opencli/__tests__/outputFormatter.test.ts
git commit -m "feat: add opencli output formatter (Firecrawl pattern)"
```

---

## Task 7: OpenCLI MCP Factory

**Files:**
- Create: `backend/src/services/opencli/opencliMcpFactory.ts`
- Create: `backend/src/services/opencli/index.ts`
- Create: `backend/src/services/opencli/__tests__/opencliMcpFactory.test.ts`

This is the largest task — generates MCP tools dynamically per domain.

- [ ] **Step 1: Write failing tests for MCP tool generation**

```typescript
// backend/src/services/opencli/__tests__/opencliMcpFactory.test.ts
import { describe, it, expect } from 'vitest';
import { generateSiteTools, filterSitesByCapabilities } from '../opencliMcpFactory.js';
import { DOMAIN_MAPPING } from '../constants.js';

describe('opencliMcpFactory', () => {
  it('filters sites by bridge capabilities', () => {
    const available = ['twitter', 'bilibili', 'hackernews'];
    const socialSites = filterSitesByCapabilities('social', available);
    expect(socialSites).toEqual(['twitter']);
  });

  it('returns empty when no sites match', () => {
    const result = filterSitesByCapabilities('finance', ['twitter']);
    expect(result).toEqual([]);
  });

  it('generates site tools with action enum', () => {
    // This test validates the tool description structure
    const tools = generateSiteTools(['twitter'], DOMAIN_MAPPING);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('twitter');
    expect(tools[0].description).toContain('twitter platform operations');
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/opencliMcpFactory.test.ts`

- [ ] **Step 3: Implement opencliMcpFactory.ts**

Key logic: for each enabled domain, intersect DOMAIN_MAPPING with bridge's availableSites, generate one composite tool per site with action enum parameter. Tool handler calls `bridgeCommandProxy.dispatch()` then `outputFormatter`.

Reference the spec §3.4 (tool description generation) and §3.5 (tool schema) for exact formats. Reference `services/firecrawl/firecrawlIntegration.ts` for the `createSdkMcpServer()` usage pattern.

- [ ] **Step 4: Create index.ts with integrateOpenCliMcpServers()**

```typescript
// backend/src/services/opencli/index.ts
export { integrateOpenCliMcpServers } from './opencliMcpFactory.js';
export { bridgeRegistry } from './bridgeRegistry.js';
export { BridgeCommandProxy } from './bridgeCommandProxy.js';
export type { OpenCliContext } from './types.js';
```

- [ ] **Step 5: Run tests, verify pass**

- [ ] **Step 6: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/opencliMcpFactory.ts backend/src/services/opencli/index.ts backend/src/services/opencli/__tests__/opencliMcpFactory.test.ts
git commit -m "feat: add dynamic MCP tool factory for opencli (6 domains, 51 sites)"
```

---

## Task 8: WebSocket Endpoint + websocketService Fix

**Files:**
- Create: `backend/src/routes/opencliWs.ts`
- Modify: `backend/src/services/websocketService.ts:56-58`
- Modify: `backend/src/index.ts:~678`

- [ ] **Step 1: Fix websocketService.ts — remove socket.destroy() for non-/ws paths**

Read `backend/src/services/websocketService.ts` first. At lines 56-58, change:

```typescript
// BEFORE:
if (url.pathname !== '/ws') {
  socket.destroy();
  return;
}

// AFTER:
if (url.pathname !== '/ws') {
  return;  // Let other upgrade listeners handle their paths
}
```

- [ ] **Step 2: Implement opencliWs.ts**

```typescript
// backend/src/routes/opencliWs.ts
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { validateBridgeKey } from '../services/opencli/bridgeKeyService.js';
import { bridgeRegistry } from '../services/opencli/bridgeRegistry.js';
import { BridgeCommandProxy } from '../services/opencli/bridgeCommandProxy.js';
import { HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT, MAX_MISSED_HEARTBEATS } from '../services/opencli/constants.js';
import type { RegisterMessage, ResultMessage } from '../services/opencli/types.js';

const wssOpenCLI = new WebSocketServer({ noServer: true });
export const bridgeCommandProxy = new BridgeCommandProxy(bridgeRegistry);

// Rate limiter: max 10 upgrades per API key per minute
const wsRateLimiter = new Map<string, { count: number; resetAt: number }>();
function isRateLimited(apiKey: string): boolean {
  const now = Date.now();
  const entry = wsRateLimiter.get(apiKey);
  if (!entry || now > entry.resetAt) {
    wsRateLimiter.set(apiKey, { count: 1, resetAt: now + 60000 });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

export function setupOpenCliBridgeWs(server: Server): void {
  server.on('upgrade', async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname !== '/api/opencli/bridge') return;

    const apiKey = request.headers['x-bridge-key'] as string;
    if (!apiKey) { socket.destroy(); return; }

    const userId = await validateBridgeKey(apiKey);
    if (!userId) { socket.destroy(); return; }
    if (isRateLimited(apiKey)) { socket.destroy(); return; }

    wssOpenCLI.handleUpgrade(request, socket, head, (ws) => {
      handleBridgeConnection(ws, request, userId);
    });
  });
}

function handleBridgeConnection(ws: WebSocket, request: IncomingMessage, userId: string): void {
  let missedHeartbeats = 0;

  const heartbeatInterval = setInterval(() => {
    if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
      console.warn(`[OpenCLI Bridge] ${userId}: ${MAX_MISSED_HEARTBEATS} missed heartbeats, disconnecting`);
      ws.close();
      return;
    }
    missedHeartbeats++;
    ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
  }, HEARTBEAT_INTERVAL);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'register':
          bridgeRegistry.register(ws, msg as RegisterMessage);
          console.log(`[OpenCLI Bridge] Registered: ${msg.deviceName} (${msg.projects?.length || 0} projects)`);
          break;
        case 'result':
          bridgeCommandProxy.onResult(msg as ResultMessage);
          break;
        case 'pong':
          missedHeartbeats = 0;
          bridgeRegistry.updateHeartbeat(ws);
          break;
        case 'diagnose_result':
          console.log(`[OpenCLI Bridge] Diagnose:`, msg);
          break;
      }
    } catch (err) {
      console.error('[OpenCLI Bridge] Invalid message:', err);
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeatInterval);
    const removed = bridgeRegistry.unregister(ws);
    for (const entry of removed) {
      bridgeCommandProxy.rejectAllForBridge(entry.projectId, entry.userId);
      console.log(`[OpenCLI Bridge] Disconnected: ${entry.deviceName} (${entry.projectId})`);
    }
  });

  ws.on('error', (err) => {
    console.error('[OpenCLI Bridge] WS error:', err.message);
  });
}
```

- [ ] **Step 3: Add setupOpenCliBridgeWs to index.ts**

Read `backend/src/index.ts`, find the `setupWebSocket(server)` call. Add after it:

```typescript
import { setupOpenCliBridgeWs } from './routes/opencliWs.js';
// ... after setupWebSocket(server):
setupOpenCliBridgeWs(server);
```

- [ ] **Step 4: Commit**

```bash
cd agentstudio
git add backend/src/routes/opencliWs.ts backend/src/services/websocketService.ts backend/src/index.ts
git commit -m "feat: add opencli bridge WS endpoint with independent handler"
```

---

## Task 9: claudeUtils.ts + a2a.ts Integration

**Files:**
- Modify: `backend/src/utils/claudeUtils.ts:~587`
- Modify: `backend/src/routes/a2a.ts:~684-801`

- [ ] **Step 1: Add OpenCliContext to BuildQueryExtendedOptions**

Read `backend/src/utils/claudeUtils.ts`. Find `BuildQueryExtendedOptions` interface (~line 238). Add `opencliContext?`:

```typescript
export interface BuildQueryExtendedOptions {
  weknoraContext?: WeknoraContext;
  graphitiContext?: GraphitiContext;
  opencliContext?: OpenCliContext;  // NEW
  effort?: 'low' | 'medium' | 'high' | 'max';
}
```

- [ ] **Step 2: Add opencli integration block in buildQueryOptions()**

Add a static import at the top of `claudeUtils.ts` (follow same pattern as Firecrawl — all other integrations use static imports):

```typescript
import { integrateOpenCliMcpServers, bridgeRegistry } from '../services/opencli/index.js';
import type { OpenCliContext } from '../services/opencli/types.js';
```

Then after the AskUserQuestion integration (~line 587), before `return`:

```typescript
// Integrate OpenCLI MCP servers (if bridge connected)
const opencliContext = extendedOptions?.opencliContext;
if (opencliContext?.enabled && opencliContext?.enabledDomains?.length > 0) {
  if (bridgeRegistry.isOnline(opencliContext.projectId, opencliContext.userId)) {
    await integrateOpenCliMcpServers(queryOptions, opencliContext, askUserSessionRef, agentIdForAskUser || '');
    console.log(`[OpenCLI] Integrated domains: ${opencliContext.enabledDomains.join(', ')}`);
  } else {
    queryOptions.systemPrompt = (queryOptions.systemPrompt || '') +
      '\n\n[OpenCLI Bridge is not connected. External platform access unavailable.]';
  }
}
```

- [ ] **Step 3: Construct OpenCliContext in a2a.ts**

Read `backend/src/routes/a2a.ts`. Find where `extendedOptions` is constructed (~line 795-801). Add opencliContext:

```typescript
import { loadProjectOpenCliConfig } from '../services/opencli/opencliConfigStorage.js';

// After graphitiContext extraction (~line 687):
const opencliConfig = loadProjectOpenCliConfig(a2aContext.workingDirectory);
const opencliUserId = graphitiContext?.user_id || undefined;  // Phase 2 adds apiKey owner fallback
const opencliContext = opencliConfig?.enabled && opencliUserId
  ? { enabled: true, enabledDomains: opencliConfig.enabledDomains, projectId: a2aContext.projectId, userId: opencliUserId }
  : undefined;

// In extendedOptions construction:
...(opencliContext ? { opencliContext } : {}),
```

- [ ] **Step 4: Commit**

```bash
cd agentstudio
git add backend/src/utils/claudeUtils.ts backend/src/routes/a2a.ts
git commit -m "feat: integrate opencli MCP servers into buildQueryOptions"
```

---

## Task 10: Electron Bridge App (opencli-bridge)

**Files:**
- Create entire `opencli-bridge/` project

This task creates the Electron app in the workspace root alongside other projects.

- [ ] **Step 1: Initialize project**

```bash
cd D:/workspace/agent-weknora
mkdir opencli-bridge && cd opencli-bridge
npm init -y
npm install electron cross-spawn ws
npm install -D typescript @types/node @types/ws electron-builder
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create src/types.ts**

Shared types for WS messages (mirrors server-side types but standalone — no shared package in Phase 1).

- [ ] **Step 4: Create src/configStore.ts**

Reads/writes `~/.opencli-bridge/config.json`. Phase 1: manually edit this file with hardcoded server URL and `obk_` key.

- [ ] **Step 5: Create src/capabilityScanner.ts**

Spawns `opencli list -f json`, parses JSON output to extract site names. Falls back to empty array if opencli not installed.

- [ ] **Step 6: Create src/commandRunner.ts**

Spawns `opencli <site> <action> <args...> -f json` via cross-spawn. Strips Electron env vars (`ELECTRON_RUN_AS_NODE`). Semaphore limits to 3 concurrent browser commands. Returns `{ success, stdout, stderr, exitCode, durationMs }`.

- [ ] **Step 7: Create src/connectionManager.ts**

Single-server WS connection with exponential backoff reconnect. Sends `register` message on connect. Handles `command` → `commandRunner.execute()` → sends `result`. Responds to `ping` with `pong`.

- [ ] **Step 8: Create src/tray.ts**

System tray with 3 icon states. Right-click menu: server status + Quit. Uses Electron `Tray` and `Menu`.

- [ ] **Step 8b: Create src/trayFallback.ts (Linux support)**

Linux tray detection + fallback mini-window. GNOME 3.26+ removed legacy tray. Required in Phase 1 per spec §5.3:

```typescript
// src/trayFallback.ts
import { Tray, BrowserWindow } from 'electron';

export async function ensureTrayVisibility(tray: Tray): Promise<void> {
  if (process.platform !== 'linux') return;

  // Wait for tray to initialize, then check bounds
  await new Promise(r => setTimeout(r, 800));
  const bounds = tray.getBounds();
  const trayWorking = bounds.width > 0 && bounds.height > 0;

  if (!trayWorking) {
    console.warn('[Tray] System tray not supported, falling back to mini-window');
    createStatusWindow();
    console.log('opencli-bridge running. Manage via web UI.');
  }
}

function createStatusWindow(): void {
  const win = new BrowserWindow({
    width: 250, height: 80,
    alwaysOnTop: true, frame: false, resizable: false,
    webPreferences: { nodeIntegration: false },
  });
  win.loadURL('data:text/html,<body style="font:14px sans-serif;padding:12px;background:#1a1a2e;color:#eee">OpenCLI Bridge: Running</body>');
}
```

Call from `main.ts` after tray creation: `await ensureTrayVisibility(tray);`

- [ ] **Step 9: Create src/main.ts**

Electron entry point. `app.whenReady()` → load config → create tray → start connection. `app.dock.hide()` on macOS (tray-only app).

- [ ] **Step 10: Add scripts to package.json**

```json
{
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc",
    "start": "npm run build && electron .",
    "dev": "tsc -w & electron ."
  }
}
```

- [ ] **Step 11: Create manual test config**

Generate an `obk_` key on the server side (one-time setup):

```bash
cd agentstudio/backend
node -e "
  import('./src/services/opencli/bridgeKeyService.js')
    .then(m => m.generateBridgeKey('your@email.com'))
    .then(key => console.log('Bridge key:', key))
"
```

Save the key in `~/.opencli-bridge/config.json`:

```json
{
  "bridgeId": "b_test_manual",
  "deviceName": "Dev-PC",
  "autoStart": false,
  "servers": [{
    "id": "srv_dev",
    "name": "Local Dev",
    "wsUrl": "ws://localhost:4936/api/opencli/bridge",
    "apiKey": "obk_<paste key here>",
    "userId": "your@email.com",
    "projects": [{ "projectId": "proj_test", "projectName": "Test Project" }],
    "paired": true,
    "addedAt": "2026-03-23T00:00:00Z"
  }]
}
```

- [ ] **Step 12: Commit**

```bash
cd D:/workspace/agent-weknora/opencli-bridge
git init
git add .
git commit -m "feat: opencli-bridge Electron app skeleton (Phase 1)"
```

---

## Task 11: End-to-End Integration Test

**Files:** No new files — manual verification

- [ ] **Step 1: Enable opencli for a test project**

Create a test opencli config:

```bash
cd agentstudio/backend
node -e "
  import('./src/services/opencli/opencliConfigStorage.js')
    .then(m => m.saveProjectOpenCliConfig('/path/to/test/project', { enabled: true, enabledDomains: ['news'] }))
"
```

- [ ] **Step 2: Start AgentStudio backend**

```bash
cd agentstudio && pnpm run dev:backend
```

Verify in console: no errors related to opencli WS setup.

- [ ] **Step 3: Start Electron bridge**

```bash
cd opencli-bridge && npm start
```

Verify:
- Console: `[WS] Connected to ws://localhost:4936/api/opencli/bridge`
- Console: `[Register] Sent registration for 1 project`
- AgentStudio console: `[OpenCLI Bridge] Registered: Dev-PC (1 project)`
- Tray icon: green

- [ ] **Step 4: Test via A2A chat (weknora-ui)**

Send message in A2A chat: "What's trending on HackerNews?"

Verify:
1. AgentStudio log: `[OpenCLI] Integrated domains: news`
2. Claude selects tool `mcp__opencli-news__hackernews`
3. AgentStudio log: WS command dispatched
4. Electron console: `opencli hackernews top -f json` executed
5. Result streamed back to Claude
6. weknora-ui renders result (generic McpToolCard in Phase 1)

- [ ] **Step 5: Test bridge disconnect**

Kill Electron app. Send another opencli-related message.

Verify:
- AgentStudio log: `[OpenCLI Bridge] Disconnected`
- Claude response includes: `[OpenCLI Bridge is not connected]`
- No crash, no hanging Promises

- [ ] **Step 6: Test bridge reconnect**

Restart Electron app.

Verify:
- Auto-reconnect succeeds
- Registry re-populated
- Next opencli command works

- [ ] **Step 7: Final commit — update CLAUDE.md if needed**

If any project-level docs need updating after integration, do it now. Do NOT modify the workspace root CLAUDE.md (user-maintained).

---

## Post-Phase 1 Notes

After Phase 1 is verified, create separate implementation plans for:

| Phase | Plan Name | Dependency |
|-------|-----------|------------|
| Phase 2 | `2026-XX-XX-opencli-bridge-phase2-pairing.md` | Phase 1 complete |
| Phase 3 | `2026-XX-XX-opencli-bridge-phase3-permissions.md` | Phase 1 complete (parallel with Phase 2) |
| Phase 4 | `2026-XX-XX-opencli-bridge-phase4-management.md` | Phase 2 complete |
| Phase 5 | `2026-XX-XX-opencli-bridge-phase5-tool-cards.md` | Phase 1 complete (parallel with Phase 4) |
| Phase 6 | `2026-XX-XX-opencli-bridge-phase6-polish.md` | Phase 4 + 5 complete |
