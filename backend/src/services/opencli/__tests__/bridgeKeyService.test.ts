import { describe, it, expect, beforeEach } from 'vitest';

let generateBridgeKey: typeof import('../bridgeKeyService.js').generateBridgeKey;
let validateBridgeKey: typeof import('../bridgeKeyService.js').validateBridgeKey;

beforeEach(async () => {
  const mod = await import('../bridgeKeyService.js');
  generateBridgeKey = mod.generateBridgeKey;
  validateBridgeKey = mod.validateBridgeKey;
});

describe('bridgeKeyService', () => {
  it('generates key with obk_ prefix and correct hex format', async () => {
    const key = await generateBridgeKey('user@example.com');
    expect(key).toMatch(/^obk_[a-f0-9]{32}$/);
  });

  it('validates a generated key and returns lowercase userId', async () => {
    const key = await generateBridgeKey('  Alice@Example.COM  ');
    const userId = await validateBridgeKey(key);
    expect(userId).toBe('alice@example.com');
  });

  it('rejects invalid key (wrong content)', async () => {
    // Generate a real key so there is something in the store
    await generateBridgeKey('user@example.com');
    const result = await validateBridgeKey('obk_0000000000000000000000000000dead');
    expect(result).toBeNull();
  });

  it('rejects key without obk_ prefix', async () => {
    const result = await validateBridgeKey('bad_0123456789abcdef0123456789abcdef');
    expect(result).toBeNull();
  });
});
