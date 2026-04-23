import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

// 在 import 路由前 mock bridgeClient（vi.mock 会 hoist）
vi.mock('../../services/wecom/bridgeClient.js', () => ({
  push: vi.fn(),
  BridgePushError: class BridgePushError extends Error {
    constructor(
      public code: string,
      message: string,
      public httpStatus?: number,
    ) {
      super(message);
      this.name = 'BridgePushError';
    }
  },
}));

import wecomPushRouter from '../wecomPush.js';
import { push as bridgePush, BridgePushError } from '../../services/wecom/bridgeClient.js';

/**
 * M1 Part2 Task 3 wecomPush 路由 + HMAC guard 单元测试（spec v2.1 §8.3.3）
 */
describe('wecomPush route', () => {
  const SECRET = 'a'.repeat(64);
  const VALID_BODY = JSON.stringify({
    a2a_agent_id: 'test-agent',
    wecom_userid: 'WxTest',
    content: '### test\n**任务**：foo',
  });

  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AS_PUSH_SECRET = SECRET;
    app = express();
    // 仿 index.ts 局部 body parser verify 模式
    app.use(
      '/api/internal/wecom',
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf.toString('utf8');
        },
      }),
      wecomPushRouter,
    );
  });

  afterEach(() => {
    delete process.env.AS_PUSH_SECRET;
  });

  function sign(body: string, ts: number, secret = SECRET): string {
    return crypto.createHmac('sha256', secret).update(`${ts}\n${body}`).digest('hex');
  }

  it('rejects 401 on wrong HMAC signature', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/api/internal/wecom/push')
      .set('X-Internal-Secret', 'wrong-sig')
      .set('X-Internal-Timestamp', String(ts))
      .set('Content-Type', 'application/json')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid signature/);
  });

  it('rejects 403 on stale timestamp (>5min window)', async () => {
    const staleTs = Math.floor(Date.now() / 1000) - 400;
    const res = await request(app)
      .post('/api/internal/wecom/push')
      .set('X-Internal-Secret', sign(VALID_BODY, staleTs))
      .set('X-Internal-Timestamp', String(staleTs))
      .set('Content-Type', 'application/json')
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/timestamp/);
  });

  it('rejects 403 on missing timestamp header', async () => {
    const res = await request(app)
      .post('/api/internal/wecom/push')
      .set('X-Internal-Secret', 'any')
      .set('Content-Type', 'application/json')
      .send(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it('rejects 400 on missing body fields', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const partial = JSON.stringify({ a2a_agent_id: 'x' });
    const res = await request(app)
      .post('/api/internal/wecom/push')
      .set('X-Internal-Secret', sign(partial, ts))
      .set('X-Internal-Timestamp', String(ts))
      .set('Content-Type', 'application/json')
      .send(partial);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing required fields/);
  });

  it('forwards to bridge and returns 200 on success', async () => {
    (bridgePush as any).mockResolvedValue({ ok: true });
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/api/internal/wecom/push')
      .set('X-Internal-Secret', sign(VALID_BODY, ts))
      .set('X-Internal-Timestamp', String(ts))
      .set('Content-Type', 'application/json')
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(bridgePush).toHaveBeenCalledWith({
      a2a_agent_id: 'test-agent',
      wecom_userid: 'WxTest',
      content: '### test\n**任务**：foo',
    });
  });

  it('returns 502 on bridge {ok:false}', async () => {
    (bridgePush as any).mockResolvedValue({ ok: false, error: 'no bot' });
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/api/internal/wecom/push')
      .set('X-Internal-Secret', sign(VALID_BODY, ts))
      .set('X-Internal-Timestamp', String(ts))
      .set('Content-Type', 'application/json')
      .send(VALID_BODY);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/no bot/);
  });

  it('returns 504 on BridgePushError code=timeout', async () => {
    (bridgePush as any).mockRejectedValue(
      new (BridgePushError as any)('timeout', 'req timeout'),
    );
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/api/internal/wecom/push')
      .set('X-Internal-Secret', sign(VALID_BODY, ts))
      .set('X-Internal-Timestamp', String(ts))
      .set('Content-Type', 'application/json')
      .send(VALID_BODY);
    expect(res.status).toBe(504);
  });

  it('hmac uses rawBody not parsed JSON (key order matters)', async () => {
    // 同 JSON 语义不同 key 顺序 → 签名不同
    const body1 = '{"a2a_agent_id":"x","wecom_userid":"y","content":"z"}';
    const body2 = '{"content":"z","a2a_agent_id":"x","wecom_userid":"y"}';
    const ts = Math.floor(Date.now() / 1000);
    const sig1 = sign(body1, ts);
    // 用 body1 的签名发 body2 → 401
    const res = await request(app)
      .post('/api/internal/wecom/push')
      .set('X-Internal-Secret', sig1)
      .set('X-Internal-Timestamp', String(ts))
      .set('Content-Type', 'application/json')
      .send(body2);
    expect(res.status).toBe(401);
  });
});
