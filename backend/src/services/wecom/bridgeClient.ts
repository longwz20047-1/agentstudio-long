import axios, { AxiosError } from 'axios';
import crypto from 'node:crypto';

export interface BridgePushPayload {
  a2a_agent_id: string;
  wecom_userid: string;
  content: string;
}

export interface BridgePushResult {
  ok: boolean;
  error?: string;
}

/**
 * bridge push 失败的类型化错误
 * - response: bridge 返非 2xx（含 HTTP status code）
 * - network: 网络层失败（ECONNREFUSED / ETIMEDOUT 等）
 * - timeout: axios 超时（ECONNABORTED）
 * - config:  BRIDGE_INTERNAL_URL / SECRET 未配置
 * - unknown: 其他
 */
export class BridgePushError extends Error {
  constructor(
    public code: 'response' | 'network' | 'timeout' | 'config' | 'unknown',
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'BridgePushError';
  }
}

/**
 * AS → bridge 推送（spec v2.1 §8.3.4）
 *
 * HMAC 签名规则（与 Dootask→AS 方向同算法，但用不同 secret）：
 *   signature = hmac_sha256(BRIDGE_INTERNAL_SECRET, timestamp + "\n" + body)
 *   Header: X-Internal-Secret / X-Internal-Timestamp
 *
 * 关键约束：axios.post 第二参数传 body **字符串**（不是 object）。
 * 传 object 会让 axios 默认 JSON.stringify，可能打乱 key 顺序，
 * 与我们签的 body bytes 不一致，bridge 端 HMAC 验证会失败。
 */
export async function push(payload: BridgePushPayload): Promise<BridgePushResult> {
  const baseUrl = process.env.BRIDGE_INTERNAL_URL;
  const secret = process.env.BRIDGE_INTERNAL_SECRET;
  if (!baseUrl || !secret) {
    throw new BridgePushError(
      'config',
      'BRIDGE_INTERNAL_URL / BRIDGE_INTERNAL_SECRET not configured',
    );
  }

  // 序列化一次，签名和 body 发送用同一份 bytes（避免 axios 重序列化打乱 key 顺序）
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${body}`)
    .digest('hex');

  try {
    const { data } = await axios.post<BridgePushResult>(
      `${baseUrl.replace(/\/+$/, '')}/internal/push`,
      body, // 注意：字符串而非对象
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': signature,
          'X-Internal-Timestamp': String(timestamp),
        },
        timeout: 30_000,
        // 让 axios 不对 string body 再做 transformRequest 破坏签名
        transformRequest: [(d) => d],
      },
    );
    return data ?? { ok: true };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{ error?: string; ok?: boolean }>;
      if (axiosErr.response) {
        const responseData = axiosErr.response.data;
        const errorMsg =
          (responseData && typeof responseData === 'object' && responseData.error) ||
          `bridge returned ${axiosErr.response.status}`;
        throw new BridgePushError('response', errorMsg, axiosErr.response.status);
      }
      if (axiosErr.code === 'ECONNABORTED') {
        throw new BridgePushError('timeout', 'bridge request timeout');
      }
      throw new BridgePushError('network', axiosErr.message);
    }
    throw new BridgePushError('unknown', String(err));
  }
}
