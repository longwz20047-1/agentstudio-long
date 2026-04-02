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
    // Step 1: Generate pairing token (weknora-ui calls REST API)
    const { configString } = service.generatePairingToken(
      'alice@example.com', 'proj_001', 'ws://localhost:4936/api/opencli/bridge', 'Test'
    );

    // Step 2: Decode config string (Electron parses)
    const config = JSON.parse(Buffer.from(configString, 'base64url').toString());
    expect(config.v).toBe(1);
    expect(config.t).toMatch(/^obp_/);
    expect(config.u).toBe('alice@example.com');

    // Step 3: Consume pairing token (server WS handler)
    const consumed = service.consumePairingToken(config.t);
    expect(consumed).not.toBeNull();
    expect(consumed!.userId).toBe('alice@example.com');

    // Step 4: Generate bridge key (server after register message)
    const obkKey = await service.generateBridgeKey('alice@example.com', 'Alice-PC', 'b_test');
    expect(obkKey).toMatch(/^obk_/);

    // Step 5: Validate bridge key (subsequent WS connections)
    const validated = await service.validateBridgeKey(obkKey);
    expect(validated).not.toBeNull();
    expect(validated!.userId).toBe('alice@example.com');
    expect(validated!.keyId).toBeDefined();

    // Step 6: Token cannot be reused
    expect(service.consumePairingToken(config.t)).toBeNull();
  });

  it('key survives service restart', async () => {
    const { configString } = service.generatePairingToken(
      'bob@example.com', 'proj_002', 'ws://localhost:4936/api/opencli/bridge', 'Test'
    );
    const config = JSON.parse(Buffer.from(configString, 'base64url').toString());
    service.consumePairingToken(config.t);
    const key = await service.generateBridgeKey('bob@example.com', 'Bob-PC', 'b_test');

    // New service instance (simulates restart)
    const service2 = new BridgeKeyService(tmpDir);
    const validated = await service2.validateBridgeKey(key);
    expect(validated).not.toBeNull();
    expect(validated!.userId).toBe('bob@example.com');
    expect(validated!.keyId).toBeDefined();
  });
});
