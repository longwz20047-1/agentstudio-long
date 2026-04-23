import express, { Request, Response, NextFunction, Router } from 'express';
import crypto from 'node:crypto';
import { safeEqualHex } from '../utils/timingSafeHexEqual.js';
import { push as bridgePush, BridgePushError } from '../services/wecom/bridgeClient.js';

/**
 * M1 企微任务通知 — AS push endpoint（spec v2.1 §8.3.3）
 *
 * POST /api/internal/wecom/push
 *
 * 职责（极简代理，zero 业务逻辑）：
 *   ① 入站 HMAC 验证（secret=AS_PUSH_SECRET, body + timestamp + hex sig）
 *   ② 字段验证
 *   ③ bridgeClient.push 透传到 bridge（出站 HMAC 用 BRIDGE_INTERNAL_SECRET 重新签）
 *   ④ 透传 bridge 返回的 { ok, error? }
 *
 * 业务编排（反查 binding / 渲染 markdown）都在 Dootask 侧（spec §1 决策 1b 方案 Y）
 */
const router: Router = express.Router();

const TIMESTAMP_WINDOW_SEC = 300; // 5 分钟重放窗口（spec §8.3.1）

/**
 * 入站 HMAC guard middleware。
 * 注：必须挂在 express.json({ verify: ... }) 之后（req.rawBody 才可用）。
 */
function hmacGuard(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.AS_PUSH_SECRET;
  if (!secret) {
    console.error('[wecomPush] AS_PUSH_SECRET not configured');
    res.status(500).json({ ok: false, error: 'server not configured' });
    return;
  }

  const sig = String(req.header('X-Internal-Secret') || '');
  const tsHeader = String(req.header('X-Internal-Timestamp') || '');
  const ts = Number.parseInt(tsHeader, 10);

  if (!ts || Number.isNaN(ts)) {
    res.status(403).json({ ok: false, error: 'missing or invalid timestamp' });
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > TIMESTAMP_WINDOW_SEC) {
    res.status(403).json({ ok: false, error: 'timestamp out of window' });
    return;
  }

  const rawBody: string | undefined = (req as any).rawBody;
  if (!rawBody) {
    // body parser verify 未捕获（路由 mount 顺序错）
    res.status(500).json({ ok: false, error: 'rawBody not captured (check express.json verify callback)' });
    return;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${ts}\n${rawBody}`)
    .digest('hex');

  if (!safeEqualHex(sig, expected)) {
    res.status(401).json({ ok: false, error: 'invalid signature' });
    return;
  }

  next();
}

interface WecomPushRequestBody {
  a2a_agent_id?: string;
  wecom_userid?: string;
  content?: string;
}

router.post('/push', hmacGuard, async (req: Request<{}, {}, WecomPushRequestBody>, res: Response) => {
  const { a2a_agent_id, wecom_userid, content } = req.body || {};
  if (!a2a_agent_id || !wecom_userid || !content) {
    res.status(400).json({
      ok: false,
      error: 'missing required fields: a2a_agent_id, wecom_userid, content',
    });
    return;
  }

  try {
    const result = await bridgePush({ a2a_agent_id, wecom_userid, content });
    if (result.ok) {
      res.status(200).json({ ok: true });
    } else {
      res.status(502).json({ ok: false, error: result.error ?? 'bridge returned ok=false' });
    }
  } catch (err) {
    if (err instanceof BridgePushError) {
      const status =
        err.code === 'response' ? err.httpStatus ?? 502 :
        err.code === 'timeout'  ? 504 :
        err.code === 'config'   ? 500 :
        502; // network / unknown
      res.status(status).json({ ok: false, error: err.message });
    } else {
      console.error('[wecomPush] unexpected error', err);
      res.status(500).json({ ok: false, error: 'internal error' });
    }
  }
});

export default router;
