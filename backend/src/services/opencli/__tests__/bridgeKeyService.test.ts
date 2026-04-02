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
      const config = JSON.parse(Buffer.from(result.configString, 'base64url').toString());
      const consumed = service.consumePairingToken(config.t);
      expect(consumed).toEqual({ userId: 'alice@example.com', projectId: 'proj_001' });
    });

    it('rejects already consumed token', () => {
      const result = service.generatePairingToken('alice@example.com', 'proj_001', 'ws://localhost:4936/api/opencli/bridge', 'Test');
      const config = JSON.parse(Buffer.from(result.configString, 'base64url').toString());
      service.consumePairingToken(config.t);
      expect(service.consumePairingToken(config.t)).toBeNull();
    });

    it('rejects expired token', () => {
      vi.useFakeTimers();
      const result = service.generatePairingToken('alice@example.com', 'proj_001', 'ws://localhost:4936/api/opencli/bridge', 'Test');
      const config = JSON.parse(Buffer.from(result.configString, 'base64url').toString());
      vi.advanceTimersByTime(11 * 60 * 1000);
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
      const result = await service.validateBridgeKey(key);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('alice@example.com');
      expect(result!.keyId).toBeDefined();
    });

    it('persists keys to disk', async () => {
      await service.generateBridgeKey('alice@example.com', 'Alice-PC', 'b_test');
      const service2 = new BridgeKeyService(tmpDir);
      const keys = service2.listBridgeKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0].userId).toBe('alice@example.com');
    });

    it('rejects revoked key', async () => {
      const key = await service.generateBridgeKey('alice@example.com', 'Alice-PC', 'b_test');
      const keys = service.listBridgeKeys();
      service.revokeBridgeKey(keys[0].id);
      const result = await service.validateBridgeKey(key);
      expect(result).toBeNull();
    });

    it('rejects invalid key', async () => {
      const result = await service.validateBridgeKey('obk_invalid_key_not_registered');
      expect(result).toBeNull();
    });
  });
});
