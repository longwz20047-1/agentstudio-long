import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { push, BridgePushError } from '../bridgeClient.js';

vi.mock('axios');

/**
 * M1 Part2 Task 2 bridgeClient 单元测试（spec v2.1 §8.3.4）
 * 覆盖：HMAC 签名 / body 字符串传递 / transformRequest 防重序列化 / 3 态错误分类 + config/unknown 兜底
 */
describe('bridgeClient.push', () => {
  const SECRET = 'b'.repeat(64); // 64-char hex
  const URL = 'http://bridge.test';
  const PAYLOAD = {
    a2a_agent_id: 'agent-1',
    wecom_userid: 'WxTest',
    content: '### test',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BRIDGE_INTERNAL_URL = URL;
    process.env.BRIDGE_INTERNAL_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.BRIDGE_INTERNAL_URL;
    delete process.env.BRIDGE_INTERNAL_SECRET;
  });

  it('throws BridgePushError code=config when env not set', async () => {
    delete process.env.BRIDGE_INTERNAL_URL;
    await expect(push(PAYLOAD)).rejects.toThrow(BridgePushError);
    try {
      await push(PAYLOAD);
      expect.fail('should throw');
    } catch (e) {
      expect((e as BridgePushError).code).toBe('config');
    }
  });

  it('signs with HMAC-SHA256 and sends body as string (not object)', async () => {
    (axios.post as any).mockResolvedValue({ data: { ok: true } });
    const result = await push(PAYLOAD);
    expect(result.ok).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, opts] = (axios.post as any).mock.calls[0];
    expect(url).toBe(`${URL}/internal/push`);
    // 关键：body 是 string 不是 object（防 axios 重序列化打乱 HMAC）
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toEqual(PAYLOAD);
    expect(opts.headers['Content-Type']).toBe('application/json');
    // SHA256 hex = 64 chars
    expect(opts.headers['X-Internal-Secret']).toMatch(/^[a-f0-9]{64}$/);
    expect(opts.headers['X-Internal-Timestamp']).toMatch(/^\d+$/);
    expect(opts.timeout).toBe(30_000);
    // 关键：transformRequest 覆盖防 axios 默认再次 stringify
    expect(opts.transformRequest).toBeDefined();
    expect(Array.isArray(opts.transformRequest)).toBe(true);
  });

  it('throws BridgePushError code=response on AxiosError with response', async () => {
    const err: any = new Error('boom');
    err.isAxiosError = true;
    err.response = { status: 500, data: { error: 'bridge died' } };
    (axios.isAxiosError as any) = vi.fn().mockReturnValue(true);
    (axios.post as any).mockRejectedValue(err);
    try {
      await push(PAYLOAD);
      expect.fail('should throw');
    } catch (e) {
      const pushErr = e as BridgePushError;
      expect(pushErr).toBeInstanceOf(BridgePushError);
      expect(pushErr.code).toBe('response');
      expect(pushErr.httpStatus).toBe(500);
      expect(pushErr.message).toMatch(/bridge died/);
    }
  });

  it('throws BridgePushError code=timeout on ECONNABORTED', async () => {
    const err: any = new Error('timeout');
    err.isAxiosError = true;
    err.code = 'ECONNABORTED';
    (axios.isAxiosError as any) = vi.fn().mockReturnValue(true);
    (axios.post as any).mockRejectedValue(err);
    try {
      await push(PAYLOAD);
      expect.fail('should throw');
    } catch (e) {
      expect((e as BridgePushError).code).toBe('timeout');
    }
  });

  it('throws BridgePushError code=network on network error (no response)', async () => {
    const err: any = new Error('ECONNREFUSED');
    err.isAxiosError = true;
    (axios.isAxiosError as any) = vi.fn().mockReturnValue(true);
    (axios.post as any).mockRejectedValue(err);
    try {
      await push(PAYLOAD);
      expect.fail('should throw');
    } catch (e) {
      expect((e as BridgePushError).code).toBe('network');
    }
  });
});
