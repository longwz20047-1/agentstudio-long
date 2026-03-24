import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import type { PairingToken, BridgeKeyRecord, BridgeKeyRegistry, PairingConfigString } from './types.js';

const SALT_ROUNDS = 10;
const OBP_PREFIX = 'obp_';
const OBK_PREFIX = 'obk_';
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TOKENS_PER_USER_PER_MIN = 5;
const MAX_TOTAL_TOKENS = 1000;
const KEYS_FILENAME = 'opencli-bridge-keys.json';

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
    const now = Date.now();
    const rl = this.tokenRateLimiter.get(userId);
    if (rl && now < rl.resetAt) {
      if (rl.count >= MAX_TOKENS_PER_USER_PER_MIN) throw new Error('Rate limited');
      rl.count++;
    } else {
      this.tokenRateLimiter.set(userId, { count: 1, resetAt: now + 60000 });
    }

    if (this.pairingTokens.size >= MAX_TOTAL_TOKENS) throw new Error('Token capacity exceeded');

    const token = `${OBP_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = new Date(now + TOKEN_TTL_MS);

    this.pairingTokens.set(token, {
      token,
      userId: userId.trim().toLowerCase(),
      projectId,
      expiresAt,
    });

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
    this.pairingTokens.delete(token);
    return { userId: entry.userId, projectId: entry.projectId };
  }

  // --- Bridge Keys (persistent) ---

  private get keysFilePath(): string {
    return path.join(this.dataDir, KEYS_FILENAME);
  }

  private ensureFile(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.keysFilePath)) {
      fs.writeFileSync(this.keysFilePath, JSON.stringify({ version: '1.0.0', keys: [] }, null, 2));
    }
  }

  private loadRegistry(): BridgeKeyRegistry {
    try {
      if (fs.existsSync(this.keysFilePath)) {
        return JSON.parse(fs.readFileSync(this.keysFilePath, 'utf-8'));
      }
    } catch (err) {
      console.warn('[BridgeKeyService] Failed to load registry:', (err as Error).message);
    }
    return { version: '1.0.0', keys: [] };
  }

  /** Atomic read-modify-write with file lock to prevent race conditions */
  private withLockedRegistry<T>(fn: (registry: BridgeKeyRegistry) => T): T {
    this.ensureFile();
    const lockfile = require('proper-lockfile');
    const release = lockfile.lockSync(this.keysFilePath);
    try {
      const registry = JSON.parse(fs.readFileSync(this.keysFilePath, 'utf-8')) as BridgeKeyRegistry;
      const result = fn(registry);
      fs.writeFileSync(this.keysFilePath, JSON.stringify(registry, null, 2));
      return result;
    } finally {
      release();
    }
  }

  async generateBridgeKey(userId: string, deviceName: string, bridgeId: string): Promise<string> {
    const random = crypto.randomBytes(16).toString('hex');
    const key = `${OBK_PREFIX}${random}`;
    const keyHash = await bcrypt.hash(key, SALT_ROUNDS);
    const now = new Date().toISOString();

    this.withLockedRegistry(registry => {
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
    });
    return key;
  }

  async validateBridgeKey(key: string): Promise<string | null> {
    if (!key.startsWith(OBK_PREFIX)) return null;
    const registry = this.loadRegistry();
    for (const record of registry.keys) {
      if (record.revokedAt) continue;
      if (await bcrypt.compare(key, record.keyHash)) {
        // Update lastUsedAt (best-effort, don't fail validation on write error)
        try {
          this.withLockedRegistry(reg => {
            const r = reg.keys.find(k => k.id === record.id);
            if (r) r.lastUsedAt = new Date().toISOString();
          });
        } catch {}
        return record.userId;
      }
    }
    return null;
  }

  revokeBridgeKey(keyId: string): boolean {
    return this.withLockedRegistry(registry => {
      const record = registry.keys.find(k => k.id === keyId);
      if (!record || record.revokedAt) return false;
      record.revokedAt = new Date().toISOString();
      return true;
    });
  }

  listBridgeKeys(includeRevoked = false): BridgeKeyRecord[] {
    const registry = this.loadRegistry();
    return includeRevoked ? registry.keys : registry.keys.filter(k => !k.revokedAt);
  }
}
