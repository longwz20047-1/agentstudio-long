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
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify({ version: '1.0.0', keys: [] }, null, 2));
    }
    const lockfile = require('proper-lockfile');
    const release = lockfile.lockSync(filePath);
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
