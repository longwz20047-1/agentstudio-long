# OpenCLI Bridge Phase 2: Pairing Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase 1's in-memory bridge key with a secure persistent pairing protocol: one-time `obp_` token → permanent `obk_` key exchange over WebSocket, with dual-channel UX (`obk://` protocol link + manual paste).

**Architecture:** Server generates pairing tokens (in-memory, 10min TTL), serves them via REST API. Electron bridge receives config string (via protocol link or paste), connects with pairing token, exchanges for permanent key stored in `.a2a/opencli-bridge-keys.json`. All crypto follows existing apiKeyService pattern (bcrypt + proper-lockfile).

**Tech Stack:** TypeScript, Express, WebSocket (`ws`), bcryptjs, proper-lockfile, Electron, Zod, Vitest

**Design Doc:** `docs/superpowers/specs/2026-03-24-opencli-bridge-phase2-pairing-design.md`

**Scope:** Phase 2 only (Pairing). Permission engine (Phase 3) and management console (Phase 4) are separate plans.

**Projects affected:**
- `agentstudio/backend/` — bridgeKeyService rewrite + new REST route + WS modifications (~400 lines)
- `opencli-bridge/` — protocol handler + connection manager changes + tray menu (~200 lines)
- `weknora-ui/` — pairing settings component + API wrapper (~120 lines)

---

## File Structure

### New Files (agentstudio backend)

| File | Responsibility |
|------|---------------|
| `backend/src/routes/opencli.ts` | REST route: `POST /api/opencli/pairing-token` (JWT auth, rate limited) |
| `backend/src/services/opencli/__tests__/bridgeKeyService.test.ts` | Tests for persistent key service + pairing tokens |
| `backend/src/services/opencli/__tests__/pairingFlow.test.ts` | Integration test: token generation → consumption → key exchange |

### Modified Files (agentstudio backend)

| File | Changes |
|------|---------|
| `backend/src/services/opencli/bridgeKeyService.ts` | Rewrite from 23-line in-memory stub to persistent service (~150 lines) |
| `backend/src/services/opencli/types.ts` | Add PairingToken, BridgeKeyRecord, PairingConfig types |
| `backend/src/routes/opencliWs.ts` | Support `X-Bridge-Pairing-Token` header + pairing handshake |
| `backend/src/index.ts` | Register `POST /api/opencli/pairing-token` route |

### New Files (opencli-bridge)

| File | Responsibility |
|------|---------------|
| `opencli-bridge/src/protocolHandler.ts` | Register `obk://` custom protocol, parse config string, trigger pairing |

### Modified Files (opencli-bridge)

| File | Changes |
|------|---------|
| `opencli-bridge/src/connectionManager.ts` | Support pairing handshake: connect with obp_ → receive obk_ → reconnect |
| `opencli-bridge/src/configStore.ts` | Add `addServer()`, `markPaired()`, `removeServer()` methods |
| `opencli-bridge/src/types.ts` | Add ServerConfig.pairingToken field |
| `opencli-bridge/src/tray.ts` | Add "Add Server..." menu item |
| `opencli-bridge/src/main.ts` | Register protocol handler |

### New Files (weknora-ui)

| File | Responsibility |
|------|---------------|
| `weknora-ui/src/api/agentstudio/opencli-bridge.ts` | API wrapper for pairing token generation |
| `weknora-ui/src/components/a2a-project/OpenCliBridgeSettings.vue` | Pairing UI in project settings |

### Modified Files (weknora-ui)

| File | Changes |
|------|---------|
| `weknora-ui/src/i18n/locales/{zh-CN,en-US,ko-KR,ru-RU}.ts` | Pairing UI labels |

---

## Task Dependency Graph

```
Task 1 (types) ──→ Task 2 (bridgeKeyService rewrite + tests)
                         │
                         ↓
                   Task 3 (REST route + index.ts registration)
                         │
                         ↓
                   Task 4 (opencliWs.ts pairing handshake)
                         │
                         ↓
                   Task 5 (pairingFlow integration test)
                         │
                         ↓
                   Task 6 (Electron: types + configStore + protocolHandler)
                         │
                         ↓
                   Task 7 (Electron: connectionManager pairing support)
                         │
                         ↓
                   Task 8 (Electron: tray menu + main.ts)
                         │
                         ↓
                   Task 9 (weknora-ui: API + settings component + i18n)
                         │
                         ↓
                   Task 10 (End-to-end verification)
```

---

## Task 1: Type Definitions

**Files:**
- Modify: `backend/src/services/opencli/types.ts`

- [ ] **Step 1: Add pairing-related types to types.ts**

Add these types to the existing `types.ts` file (after the existing types):

```typescript
// --- Phase 2: Pairing Protocol ---

export interface PairingToken {
  token: string;        // obp_xxx (32 hex chars)
  userId: string;
  projectId: string;
  expiresAt: Date;
}

export interface BridgeKeyRecord {
  id: string;              // UUID
  userId: string;          // normalized lowercase
  deviceName: string;
  bridgeId: string;
  keyHash: string;         // bcrypt hash of obk_ key
  createdAt: string;       // ISO timestamp
  lastUsedAt: string;      // ISO timestamp
  revokedAt: string | null;
}

export interface BridgeKeyRegistry {
  version: string;         // "1.0.0"
  keys: BridgeKeyRecord[];
}

export interface PairingConfigString {
  v: number;               // version, always 1
  s: string;               // WebSocket server URL
  t: string;               // obp_ pairing token
  p: string;               // project ID
  n: string;               // project display name
  u: string;               // user ID (email)
}
```

- [ ] **Step 2: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/types.ts
git commit -m "feat: add Phase 2 pairing types (PairingToken, BridgeKeyRecord)"
```

---

## Task 2: Bridge Key Service Rewrite

**Files:**
- Modify: `backend/src/services/opencli/bridgeKeyService.ts` (rewrite from 23 → ~150 lines)
- Create: `backend/src/services/opencli/__tests__/bridgeKeyService.test.ts` (rewrite)

- [ ] **Step 1: Write failing tests for the new bridgeKeyService**

```typescript
// backend/src/services/opencli/__tests__/bridgeKeyService.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BridgeKeyService } from '../bridgeKeyService.js';

describe('BridgeKeyService', () => {
  let tmpDir: string;
  let service: BridgeKeyService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bks-test-'));
    service = new BridgeKeyService(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('pairing tokens', () => {
    it('generates token with obp_ prefix and returns config string', () => {
      const result = service.generatePairingToken('alice@example.com', 'proj_001', 'ws://localhost:4936/api/opencli/bridge', 'Test Project');
      expect(result.configString).toBeTruthy();
      expect(result.protocolLink).toMatch(/^obk:\/\//);
      expect(result.expiresAt).toBeTruthy();
    });

    it('consumes token successfully', () => {
      const result = service.generatePairingToken('alice@example.com', 'proj_001', 'ws://localhost:4936/api/opencli/bridge', 'Test');
      // Decode config string to get token
      const config = JSON.parse(Buffer.from(result.configString, 'base64url').toString());
      const consumed = service.consumePairingToken(config.t);
      expect(consumed).toEqual({ userId: 'alice@example.com', projectId: 'proj_001' });
    });

    it('rejects already consumed token', () => {
      const result = service.generatePairingToken('alice@example.com', 'proj_001', 'ws://localhost:4936/api/opencli/bridge', 'Test');
      const config = JSON.parse(Buffer.from(result.configString, 'base64url').toString());
      service.consumePairingToken(config.t); // first use
      expect(service.consumePairingToken(config.t)).toBeNull(); // second use
    });

    it('rejects expired token', () => {
      vi.useFakeTimers();
      const result = service.generatePairingToken('alice@example.com', 'proj_001', 'ws://localhost:4936/api/opencli/bridge', 'Test');
      const config = JSON.parse(Buffer.from(result.configString, 'base64url').toString());
      vi.advanceTimersByTime(11 * 60 * 1000); // 11 minutes
      expect(service.consumePairingToken(config.t)).toBeNull();
      vi.useRealTimers();
    });

    it('rate limits: max 5 tokens per user per minute', () => {
      for (let i = 0; i < 5; i++) {
        service.generatePairingToken('alice@example.com', `proj_${i}`, 'ws://localhost:4936/api/opencli/bridge', 'Test');
      }
      expect(() => service.generatePairingToken('alice@example.com', 'proj_6', 'ws://localhost:4936/api/opencli/bridge', 'Test'))
        .toThrow('Rate limited');
    });
  });

  describe('bridge keys', () => {
    it('generates key with obk_ prefix', async () => {
      const key = await service.generateBridgeKey('alice@example.com', 'Alice-PC', 'b_test');
      expect(key).toMatch(/^obk_[a-f0-9]{32}$/);
    });

    it('validates generated key', async () => {
      const key = await service.generateBridgeKey('alice@example.com', 'Alice-PC', 'b_test');
      const userId = await service.validateBridgeKey(key);
      expect(userId).toBe('alice@example.com');
    });

    it('persists keys to disk', async () => {
      await service.generateBridgeKey('alice@example.com', 'Alice-PC', 'b_test');
      // Create new service instance pointing to same dir
      const service2 = new BridgeKeyService(tmpDir);
      // Should be able to list the key
      const keys = service2.listBridgeKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0].userId).toBe('alice@example.com');
    });

    it('rejects revoked key', async () => {
      const key = await service.generateBridgeKey('alice@example.com', 'Alice-PC', 'b_test');
      const keys = service.listBridgeKeys();
      service.revokeBridgeKey(keys[0].id);
      const userId = await service.validateBridgeKey(key);
      expect(userId).toBeNull();
    });

    it('rejects invalid key', async () => {
      const userId = await service.validateBridgeKey('obk_invalid_key_not_registered');
      expect(userId).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/bridgeKeyService.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement bridgeKeyService.ts**

```typescript
// backend/src/services/opencli/bridgeKeyService.ts
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import lockfile from 'proper-lockfile';
import type { PairingToken, BridgeKeyRecord, BridgeKeyRegistry, PairingConfigString } from './types.js';

const SALT_ROUNDS = 10;
const OBP_PREFIX = 'obp_';
const OBK_PREFIX = 'obk_';
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TOKENS_PER_USER_PER_MIN = 5;
const MAX_TOTAL_TOKENS = 1000;
const KEYS_FILENAME = 'opencli-bridge-keys.json';
const LOCK_OPTIONS = { retries: { retries: 5, minTimeout: 100, maxTimeout: 500 } };

export class BridgeKeyService {
  private pairingTokens = new Map<string, PairingToken>();
  private tokenRateLimiter = new Map<string, { count: number; resetAt: number }>();

  constructor(private dataDir: string) {}

  // --- Pairing Tokens (in-memory) ---

  generatePairingToken(userId: string, projectId: string, wsUrl: string, projectName: string): {
    configString: string;
    protocolLink: string;
    expiresAt: string;
  } {
    // Rate limit
    const now = Date.now();
    const rl = this.tokenRateLimiter.get(userId);
    if (rl && now < rl.resetAt) {
      if (rl.count >= MAX_TOKENS_PER_USER_PER_MIN) throw new Error('Rate limited');
      rl.count++;
    } else {
      this.tokenRateLimiter.set(userId, { count: 1, resetAt: now + 60000 });
    }

    // Capacity limit
    if (this.pairingTokens.size >= MAX_TOTAL_TOKENS) throw new Error('Token capacity exceeded');

    const token = `${OBP_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = new Date(now + TOKEN_TTL_MS);

    this.pairingTokens.set(token, {
      token,
      userId: userId.trim().toLowerCase(),
      projectId,
      expiresAt,
    });

    // Auto-cleanup after TTL
    setTimeout(() => this.pairingTokens.delete(token), TOKEN_TTL_MS);

    const config: PairingConfigString = { v: 1, s: wsUrl, t: token, p: projectId, n: projectName, u: userId };
    const configString = Buffer.from(JSON.stringify(config)).toString('base64url');

    return {
      configString,
      protocolLink: `obk://${configString}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  consumePairingToken(token: string): { userId: string; projectId: string } | null {
    const entry = this.pairingTokens.get(token);
    if (!entry) return null;
    if (new Date() > entry.expiresAt) {
      this.pairingTokens.delete(token);
      return null;
    }
    this.pairingTokens.delete(token); // Single-use: delete immediately
    return { userId: entry.userId, projectId: entry.projectId };
  }

  // --- Bridge Keys (persistent) ---

  private get keysFilePath(): string {
    return path.join(this.dataDir, KEYS_FILENAME);
  }

  private loadRegistry(): BridgeKeyRegistry {
    try {
      if (fs.existsSync(this.keysFilePath)) {
        return JSON.parse(fs.readFileSync(this.keysFilePath, 'utf-8'));
      }
    } catch {}
    return { version: '1.0.0', keys: [] };
  }

  private saveRegistry(registry: BridgeKeyRegistry): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const filePath = this.keysFilePath;
    // Ensure file exists for lockfile
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify({ version: '1.0.0', keys: [] }, null, 2));
    }
    const release = lockfile.lockSync(filePath, LOCK_OPTIONS);
    try {
      fs.writeFileSync(filePath, JSON.stringify(registry, null, 2));
    } finally {
      release();
    }
  }

  async generateBridgeKey(userId: string, deviceName: string, bridgeId: string): Promise<string> {
    const random = crypto.randomBytes(16).toString('hex');
    const key = `${OBK_PREFIX}${random}`;
    const keyHash = await bcrypt.hash(key, SALT_ROUNDS);
    const now = new Date().toISOString();

    const registry = this.loadRegistry();
    registry.keys.push({
      id: uuidv4(),
      userId: userId.trim().toLowerCase(),
      deviceName,
      bridgeId,
      keyHash,
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null,
    });
    this.saveRegistry(registry);
    return key;
  }

  async validateBridgeKey(key: string): Promise<string | null> {
    if (!key.startsWith(OBK_PREFIX)) return null;
    const registry = this.loadRegistry();
    for (const record of registry.keys) {
      if (record.revokedAt) continue;
      if (await bcrypt.compare(key, record.keyHash)) {
        record.lastUsedAt = new Date().toISOString();
        this.saveRegistry(registry);
        return record.userId;
      }
    }
    return null;
  }

  revokeBridgeKey(keyId: string): boolean {
    const registry = this.loadRegistry();
    const record = registry.keys.find(k => k.id === keyId);
    if (!record || record.revokedAt) return false;
    record.revokedAt = new Date().toISOString();
    this.saveRegistry(registry);
    return true;
  }

  listBridgeKeys(includeRevoked = false): BridgeKeyRecord[] {
    const registry = this.loadRegistry();
    return includeRevoked ? registry.keys : registry.keys.filter(k => !k.revokedAt);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/bridgeKeyService.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/bridgeKeyService.ts backend/src/services/opencli/__tests__/bridgeKeyService.test.ts
git commit -m "feat: rewrite bridgeKeyService with persistent storage and pairing tokens"
```

---

## Task 3: REST Route for Pairing Token

**Files:**
- Create: `backend/src/routes/opencli.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Create REST route**

```typescript
// backend/src/routes/opencli.ts
import { Router } from 'express';
import { bridgeKeyService } from '../services/opencli/singletons.js';

const router = Router();

router.post('/pairing-token', async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    // userId from JWT auth (set by auth middleware)
    const userId = (req as any).user?.email;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const wsUrl = `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/api/opencli/bridge`;
    const projectName = req.body.projectName || projectId;

    const result = bridgeKeyService.generatePairingToken(userId, projectId, wsUrl, projectName);
    res.json(result);
  } catch (err: any) {
    if (err.message === 'Rate limited') return res.status(429).json({ error: 'Rate limited. Max 5 tokens per minute.' });
    if (err.message === 'Token capacity exceeded') return res.status(503).json({ error: 'Server busy. Try again later.' });
    console.error('[OpenCLI] Pairing token error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
```

**IMPORTANT:** The `bridgeKeyService` MUST be a module-level singleton (from `singletons.ts`), NOT created per-request. The in-memory pairing token Map must be shared between the REST route (which generates tokens) and the WS handler (which consumes them). Add to `singletons.ts`:

```typescript
// Add to backend/src/services/opencli/singletons.ts:
import { BridgeKeyService } from './bridgeKeyService.js';
import { getProjectDataDir } from '../../config/paths.js';

export const bridgeKeyService = new BridgeKeyService(getProjectDataDir('default'));
```

- [ ] **Step 2: Register route in index.ts**

Read `backend/src/index.ts` and find the route registration section. Add:

```typescript
import opencliRouter from './routes/opencli.js';
// ... in route registration area:
app.use('/api/opencli', authMiddleware, opencliRouter);
```

- [ ] **Step 3: Commit**

```bash
cd agentstudio
git add backend/src/routes/opencli.ts backend/src/index.ts
git commit -m "feat: add POST /api/opencli/pairing-token REST endpoint"
```

---

## Task 4: WebSocket Pairing Handshake

**Files:**
- Modify: `backend/src/routes/opencliWs.ts`

- [ ] **Step 1: Modify upgrade handler to support dual auth**

Read current `opencliWs.ts`. Modify the `setupOpenCliBridgeWs` function to support both `X-Bridge-Key` (existing) and `X-Bridge-Pairing-Token` (new) headers:

```typescript
// In setupOpenCliBridgeWs, replace the auth logic:
export function setupOpenCliBridgeWs(server: Server): void {
  server.on('upgrade', async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname !== '/api/opencli/bridge') return;

    // Priority 1: Long-lived bridge key
    const bridgeKey = request.headers['x-bridge-key'] as string;
    if (bridgeKey) {
      const userId = await validateBridgeKey(bridgeKey);
      if (!userId) { socket.destroy(); return; }
      if (isRateLimited(bridgeKey)) { socket.destroy(); return; }
      wssOpenCLI.handleUpgrade(request, socket, head, (ws) => {
        handleBridgeConnection(ws, userId, false);
      });
      return;
    }

    // Priority 2: One-time pairing token
    const pairingToken = request.headers['x-bridge-pairing-token'] as string;
    if (pairingToken) {
      const result = bridgeKeyService.consumePairingToken(pairingToken);
      if (!result) {
        // Close with 4002 so bridge can show "token expired" message
        const wsTmp = new WebSocket(null as any);
        socket.write('HTTP/1.1 401 Unauthorized\r\nX-Bridge-Close-Code: 4002\r\n\r\n');
        socket.destroy();
        return;
      }
      wssOpenCLI.handleUpgrade(request, socket, head, (ws) => {
        handleBridgeConnection(ws, result.userId, true);
      });
      return;
    }

    // No auth header
    socket.destroy();
  });
}
```

- [ ] **Step 2: Add pairing exchange in handleBridgeConnection**

Modify `handleBridgeConnection` to accept `isPairing` flag. When `isPairing === true`, on first `register` message:
1. Generate `obk_` key via `bridgeKeyService.generateBridgeKey()`
2. Send `{ type: 'paired', obkKey: key }` to bridge
3. Close connection (bridge will reconnect with the permanent key)

```typescript
function handleBridgeConnection(ws: WebSocket, userId: string, isPairing: boolean): void {
  // ... existing heartbeat setup ...

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'register':
          if (isPairing) {
            // Pairing mode: generate key, send to bridge, close
            const key = await bridgeKeyService.generateBridgeKey(
              userId, msg.deviceName, msg.bridgeId
            );
            ws.send(JSON.stringify({ type: 'paired', obkKey: key }));
            console.log(`[OpenCLI Bridge] Paired: ${msg.deviceName} → key issued`);
            ws.close(1000, 'Pairing complete');
            return;
          }
          // Normal mode
          bridgeRegistry.register(ws, msg as RegisterMessage);
          // ... existing log ...
          break;
        // ... existing cases ...
      }
    } catch (err) {
      console.error('[OpenCLI Bridge] Invalid message:', err);
    }
  });

  // ... existing close/error handlers ...
}
```

- [ ] **Step 3: Update imports**

The `validateBridgeKey` and `consumePairingToken` functions now come from the class-based `BridgeKeyService`. Update imports accordingly — create a shared instance or use the singleton pattern.

- [ ] **Step 4: Commit**

```bash
cd agentstudio
git add backend/src/routes/opencliWs.ts
git commit -m "feat: add pairing handshake support to WS endpoint"
```

---

## Task 5: Pairing Flow Integration Test

**Files:**
- Create: `backend/src/services/opencli/__tests__/pairingFlow.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// backend/src/services/opencli/__tests__/pairingFlow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BridgeKeyService } from '../bridgeKeyService.js';

describe('Pairing Flow (end-to-end)', () => {
  let tmpDir: string;
  let service: BridgeKeyService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-test-'));
    service = new BridgeKeyService(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('complete pairing flow: generate token → consume → generate key → validate', async () => {
    // Step 1: Generate pairing token (simulates weknora-ui calling REST API)
    const { configString } = service.generatePairingToken(
      'alice@example.com', 'proj_001', 'ws://localhost:4936/api/opencli/bridge', 'Test'
    );

    // Step 2: Decode config string (simulates Electron parsing)
    const config = JSON.parse(Buffer.from(configString, 'base64url').toString());
    expect(config.v).toBe(1);
    expect(config.t).toMatch(/^obp_/);
    expect(config.u).toBe('alice@example.com');

    // Step 3: Consume pairing token (simulates server WS handler)
    const consumed = service.consumePairingToken(config.t);
    expect(consumed).not.toBeNull();
    expect(consumed!.userId).toBe('alice@example.com');

    // Step 4: Generate bridge key (simulates server after register message)
    const obkKey = await service.generateBridgeKey('alice@example.com', 'Alice-PC', 'b_test');
    expect(obkKey).toMatch(/^obk_/);

    // Step 5: Validate bridge key (simulates subsequent WS connections)
    const userId = await service.validateBridgeKey(obkKey);
    expect(userId).toBe('alice@example.com');

    // Step 6: Verify token cannot be reused
    expect(service.consumePairingToken(config.t)).toBeNull();
  });

  it('key survives service restart', async () => {
    const { configString } = service.generatePairingToken(
      'bob@example.com', 'proj_002', 'ws://localhost:4936/api/opencli/bridge', 'Test'
    );
    const config = JSON.parse(Buffer.from(configString, 'base64url').toString());
    service.consumePairingToken(config.t);
    const key = await service.generateBridgeKey('bob@example.com', 'Bob-PC', 'b_test');

    // Create new service instance (simulates server restart)
    const service2 = new BridgeKeyService(tmpDir);
    const userId = await service2.validateBridgeKey(key);
    expect(userId).toBe('bob@example.com');

    // Note: pairing tokens are in-memory, so they DON'T survive restart (by design)
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/__tests__/pairingFlow.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
cd agentstudio
git add backend/src/services/opencli/__tests__/pairingFlow.test.ts
git commit -m "test: add pairing flow integration tests"
```

---

## Task 6: Electron — Types, ConfigStore, Protocol Handler

**Files:**
- Modify: `opencli-bridge/src/types.ts`
- Modify: `opencli-bridge/src/configStore.ts`
- Create: `opencli-bridge/src/protocolHandler.ts`

- [ ] **Step 1: Add pairingToken to ServerConfig type**

In `opencli-bridge/src/types.ts`, add `pairingToken?: string` and `paired: boolean` to `ServerConfig`:

```typescript
export interface ServerConfig {
  id: string;
  name: string;
  wsUrl: string;
  apiKey?: string;         // obk_ key (set after pairing)
  pairingToken?: string;   // obp_ token (temporary)
  userId: string;
  projects: Array<{ projectId: string; projectName: string }>;
  paired: boolean;
  addedAt: string;
}
```

- [ ] **Step 2: Add server management to configStore.ts**

```typescript
// Add to configStore.ts:
import crypto from 'crypto';

export function addServer(config: BridgeConfig, configString: string): ServerConfig {
  const json = JSON.parse(Buffer.from(configString, 'base64url').toString());
  if (json.v !== 1) throw new Error('Unsupported config version');

  const server: ServerConfig = {
    id: `srv_${crypto.randomBytes(4).toString('hex')}`,
    name: json.n || 'Unknown Server',
    wsUrl: json.s,
    pairingToken: json.t,
    userId: json.u,
    projects: [{ projectId: json.p, projectName: json.n }],
    paired: false,
    addedAt: new Date().toISOString(),
  };

  config.servers.push(server);
  saveConfig(config);
  return server;
}

export function markPaired(config: BridgeConfig, serverId: string, obkKey: string): void {
  const server = config.servers.find(s => s.id === serverId);
  if (!server) return;
  server.apiKey = obkKey;
  server.pairingToken = undefined;
  server.paired = true;
  saveConfig(config);
}

export function removeServer(config: BridgeConfig, serverId: string): void {
  config.servers = config.servers.filter(s => s.id !== serverId);
  saveConfig(config);
}
```

- [ ] **Step 3: Create protocolHandler.ts**

```typescript
// opencli-bridge/src/protocolHandler.ts
import { app } from 'electron';

let onConfigString: ((configString: string) => void) | null = null;

export function setupProtocolHandler(callback: (configString: string) => void): void {
  onConfigString = callback;

  // Register protocol (best-effort, may fail on Linux)
  if (process.defaultApp) {
    app.setAsDefaultProtocolClient('obk', process.execPath, [__dirname]);
  } else {
    app.setAsDefaultProtocolClient('obk');
  }

  // macOS: open-url event
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
  });

  // Windows: second-instance with protocol URL in argv
  app.on('second-instance', (_event, argv) => {
    const obkUrl = argv.find(a => a.startsWith('obk://'));
    if (obkUrl) handleProtocolUrl(obkUrl);
  });
}

function handleProtocolUrl(url: string): void {
  const configString = url.replace('obk://', '').replace(/\/$/, '');
  if (configString && onConfigString) {
    console.log('[Protocol] Received obk:// config string');
    onConfigString(configString);
  }
}
```

- [ ] **Step 4: Commit**

```bash
cd D:/workspace/agent-weknora/opencli-bridge
git add src/types.ts src/configStore.ts src/protocolHandler.ts
git commit -m "feat: add server management, protocol handler, pairing types"
```

---

## Task 7: Electron — ConnectionManager Pairing Support

**Files:**
- Modify: `opencli-bridge/src/connectionManager.ts`

- [ ] **Step 1: Add pairing handshake support**

Modify `connect()` to use `X-Bridge-Pairing-Token` header for unpaired servers, and handle the `paired` message type:

```typescript
// In connect():
const headers: Record<string, string> = {
  'x-bridge-id': this.bridgeConfig.bridgeId,
  'x-device-name': this.bridgeConfig.deviceName,
};

if (this.serverConfig.paired && this.serverConfig.apiKey) {
  headers['x-bridge-key'] = this.serverConfig.apiKey;
} else if (this.serverConfig.pairingToken) {
  headers['x-bridge-pairing-token'] = this.serverConfig.pairingToken;
}

const ws = new WebSocket(this.serverConfig.wsUrl, { headers, handshakeTimeout: 10000 });
```

Add `paired` message handler in `ws.on('message')`:

```typescript
} else if (msg.type === 'paired') {
  console.log('[WS] Pairing successful, received bridge key');
  this.onPaired(msg.obkKey);
}
```

Add `onPaired` callback to constructor and handle the key storage + reconnect:

```typescript
private onPaired: (obkKey: string) => void;

constructor(
  serverConfig: ServerConfig,
  bridgeConfig: BridgeConfig,
  onStatusChange: StatusCallback,
  onPaired: (obkKey: string) => void = () => {},
) {
  this.onPaired = onPaired;
  // ...
}
```

- [ ] **Step 2: Handle close code 4002 (pairing token expired)**

In the `ws.on('close')` handler, add:

```typescript
if (code === 4002) {
  console.error('[WS] Pairing token expired. Please generate a new one.');
  return; // Don't reconnect
}
```

- [ ] **Step 3: Commit**

```bash
cd D:/workspace/agent-weknora/opencli-bridge
git add src/connectionManager.ts
git commit -m "feat: add pairing handshake and key exchange to connectionManager"
```

---

## Task 8: Electron — Tray Menu + Main Entry

**Files:**
- Modify: `opencli-bridge/src/tray.ts`
- Modify: `opencli-bridge/src/main.ts`

- [ ] **Step 1: Add "Add Server..." menu item to tray**

In `tray.ts`, add a menu item that opens a small paste dialog:

```typescript
// Add to context menu:
{ label: 'Add Server...', click: () => showPasteDialog() }

function showPasteDialog(): void {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({
    width: 500, height: 200,
    resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadURL(`data:text/html,
    <body style="font:14px sans-serif;padding:16px;background:#1a1a2e;color:#eee">
      <h3>Paste Config String</h3>
      <textarea id="input" style="width:100%;height:60px;background:#2a2a4e;color:#eee;border:1px solid #444;border-radius:4px;padding:8px" placeholder="Paste obk:// config string here..."></textarea>
      <button onclick="require('electron').ipcRenderer.send('paste-config', document.getElementById('input').value)" style="margin-top:8px;padding:8px 16px;background:#4a9eff;color:white;border:none;border-radius:4px;cursor:pointer">Connect</button>
    </body>
  `);
}
```

- [ ] **Step 2: Register protocol handler in main.ts**

```typescript
import { setupProtocolHandler } from './protocolHandler';

// In app.whenReady():
setupProtocolHandler((configString) => {
  const server = addServer(config, configString);
  startConnection(server);
});
```

- [ ] **Step 3: Handle `paste-config` IPC event**

```typescript
import { ipcMain } from 'electron';

ipcMain.on('paste-config', (_event, configString: string) => {
  try {
    const cleaned = configString.replace('obk://', '').trim();
    const server = addServer(config, cleaned);
    startConnection(server);
  } catch (err) {
    console.error('[Main] Invalid config string:', err);
  }
});
```

- [ ] **Step 4: Commit**

```bash
cd D:/workspace/agent-weknora/opencli-bridge
git add src/tray.ts src/main.ts
git commit -m "feat: add tray paste dialog and protocol handler registration"
```

---

## Task 9: weknora-ui — API Wrapper + Settings Component + i18n

**Files:**
- Create: `weknora-ui/src/api/agentstudio/opencli-bridge.ts`
- Create: `weknora-ui/src/components/a2a-project/OpenCliBridgeSettings.vue`
- Modify: i18n files (4 languages)

- [ ] **Step 1: Create API wrapper**

```typescript
// weknora-ui/src/api/agentstudio/opencli-bridge.ts
import { agentStudioAxios } from './index';

export interface PairingTokenResponse {
  configString: string;
  protocolLink: string;
  expiresAt: string;
}

export async function generatePairingToken(projectId: string, projectName?: string): Promise<PairingTokenResponse> {
  const { data } = await agentStudioAxios.post('/api/opencli/pairing-token', {
    projectId,
    projectName,
  });
  return data;
}
```

**Note:** Check how `agentStudioAxios` is configured. If it doesn't exist, use the existing API pattern in `weknora-ui/src/api/` — look at how other AgentStudio API calls are made and follow the same pattern (likely with `x-api-key` or JWT header).

- [ ] **Step 2: Create OpenCliBridgeSettings.vue**

```vue
<!-- weknora-ui/src/components/a2a-project/OpenCliBridgeSettings.vue -->
<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessagePlugin } from 'tdesign-vue-next'
import { generatePairingToken, type PairingTokenResponse } from '@/api/agentstudio/opencli-bridge'

const props = defineProps<{
  projectId: string
  projectName?: string
}>()

const { t } = useI18n()
const loading = ref(false)
const pairingResult = ref<PairingTokenResponse | null>(null)
const countdown = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null

const countdownText = computed(() => {
  if (countdown.value <= 0) return ''
  const min = Math.floor(countdown.value / 60)
  const sec = countdown.value % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
})

async function handleGenerate() {
  loading.value = true
  try {
    pairingResult.value = await generatePairingToken(props.projectId, props.projectName)
    // Start countdown
    const expiresMs = new Date(pairingResult.value.expiresAt).getTime() - Date.now()
    countdown.value = Math.floor(expiresMs / 1000)
    countdownTimer = setInterval(() => {
      countdown.value--
      if (countdown.value <= 0) {
        clearInterval(countdownTimer!)
        pairingResult.value = null
      }
    }, 1000)
  } catch (err) {
    MessagePlugin.error(t('opencli.pairing.error'))
  } finally {
    loading.value = false
  }
}

function handleCopy() {
  if (!pairingResult.value) return
  navigator.clipboard.writeText(pairingResult.value.configString)
  MessagePlugin.success(t('opencli.pairing.copied'))
}

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer)
})
</script>

<template>
  <div class="opencli-bridge-settings">
    <h4>{{ t('opencli.pairing.title') }}</h4>
    <p class="description">{{ t('opencli.pairing.description') }}</p>

    <t-button :loading="loading" @click="handleGenerate">
      {{ t('opencli.pairing.generate') }}
    </t-button>

    <div v-if="pairingResult" class="pairing-result">
      <div class="config-string-row">
        <t-input :value="pairingResult.configString" readonly />
        <t-button variant="outline" @click="handleCopy">
          {{ t('opencli.pairing.copy') }}
        </t-button>
      </div>

      <a :href="pairingResult.protocolLink" class="protocol-link">
        {{ t('opencli.pairing.openInBridge') }}
      </a>

      <div v-if="countdownText" class="countdown">
        {{ t('opencli.pairing.expiresIn', { time: countdownText }) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.opencli-bridge-settings { padding: 16px; }
.description { color: var(--td-text-color-secondary); margin-bottom: 16px; }
.pairing-result { margin-top: 16px; }
.config-string-row { display: flex; gap: 8px; margin-bottom: 8px; }
.protocol-link { display: block; margin: 8px 0; color: var(--td-brand-color); }
.countdown { font-size: 13px; color: var(--td-warning-color); }
</style>
```

- [ ] **Step 3: Add i18n keys (4 languages)**

Add `opencli.pairing` section to each locale file:

**zh-CN:**
```typescript
opencli: {
  pairing: {
    title: 'Bridge 配对',
    description: '生成配对令牌，将本地 OpenCLI Bridge 连接到此项目。',
    generate: '生成配对令牌',
    copy: '复制',
    copied: '已复制到剪贴板',
    openInBridge: '在 Bridge 中打开',
    expiresIn: '{time} 后过期',
    error: '生成配对令牌失败',
  },
},
```

**en-US:**
```typescript
opencli: {
  pairing: {
    title: 'Bridge Pairing',
    description: 'Generate a pairing token to connect your local OpenCLI Bridge to this project.',
    generate: 'Generate Pairing Token',
    copy: 'Copy',
    copied: 'Copied to clipboard',
    openInBridge: 'Open in Bridge',
    expiresIn: 'Expires in {time}',
    error: 'Failed to generate pairing token',
  },
},
```

**ko-KR / ru-RU:** Follow same pattern with appropriate translations.

- [ ] **Step 4: Commit**

```bash
cd weknora-ui
git add src/api/agentstudio/opencli-bridge.ts src/components/a2a-project/OpenCliBridgeSettings.vue src/i18n/locales/*.ts
git commit -m "feat: add OpenCLI Bridge pairing UI + API wrapper + i18n"
```

---

## Task 10: End-to-End Verification

**Files:** No new files — manual verification.

- [ ] **Step 1: Run all backend opencli tests**

Run: `cd agentstudio/backend && npx vitest run src/services/opencli/`
Expected: All PASS (including new pairing tests)

- [ ] **Step 2: Build and start backend**

Run: `cd agentstudio && pnpm run build:backend && pnpm run dev:backend`
Expected: No errors, server starts on port 4936

- [ ] **Step 3: Build Electron bridge**

Run: `cd opencli-bridge && npm run build`
Expected: TypeScript compiles without errors

- [ ] **Step 4: Test pairing flow manually**

1. In weknora-ui project settings, click "Generate Pairing Token"
2. Copy the config string
3. In Electron bridge, use "Add Server..." paste dialog
4. Verify: bridge connects, receives obk_ key, reconnects
5. Verify: bridge status shows "connected" in tray

- [ ] **Step 5: Test bridge disconnect + reconnect**

1. Kill Electron bridge
2. Restart it
3. Verify: auto-reconnects with stored obk_ key (no re-pairing needed)

- [ ] **Step 6: Test expired token**

1. Generate a pairing token
2. Wait 11 minutes
3. Try to pair with expired token
4. Verify: connection rejected, bridge shows appropriate error
