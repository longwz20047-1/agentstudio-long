/**
 * DooTask token exchange with in-memory cache + pending dedupe
 *
 * - 身份映射职责在 dootask 内部（UserWecomBinding::findByWecom）
 * - 本函数只做 HTTP 调用 + 缓存；bridge 侧传什么就发什么
 * - tokenCache 命中且距过期 > SAFETY_MARGIN_MS (10 min) → 直接返回
 * - pendingRequests 去重（v3.4 Top-1）: 同 key 并发只发 1 次 HTTP
 * - 多实例场景（多 AS 进程）缓存不共享，各自独立换（接受）
 */

import axios from 'axios';

interface CachedToken {
  token: string;
  expiresAt: number; // 绝对时间戳（ms）
}

// Map<`${corp_id}:${wecom_userid}`, { token, expiresAt }>
// 复合键：同 wecom_userid 在不同企业内是不同人，必须联合隔离
const tokenCache = new Map<string, CachedToken>();

// v3.4 Top-1 [P0] pending dedupe — 防 thundering herd
// 同 key 并发请求只发 1 次 HTTP，其他 N-1 个等同一个 promise
const pendingRequests = new Map<string, Promise<string>>();

// 到期前 10 分钟视为失效，提早续期
const SAFETY_MARGIN_MS = 10 * 60 * 1000;

const cacheKey = (corpId: string, wecomUserId: string) => `${corpId}:${wecomUserId}`;

/**
 * 用企微身份（corp_id + wecom_userid）换取 dootask token，带内存缓存 + pending dedupe。
 */
export async function getDootaskToken(corpId: string, wecomUserId: string): Promise<string> {
  if (!corpId || !wecomUserId) {
    throw new Error('corpId and wecomUserId are required');
  }

  const key = cacheKey(corpId, wecomUserId);

  // 1. 检查缓存（复合键：corp_id:wecom_userid）
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - Date.now() > SAFETY_MARGIN_MS) {
    return cached.token;
  }

  // 2. Pending dedupe — 同 key 并发只发 1 次 API 请求
  const pending = pendingRequests.get(key);
  if (pending) return pending;

  const promise = doExchangeToken(corpId, wecomUserId, key);
  pendingRequests.set(key, promise);
  try {
    return await promise;
  } finally {
    // 成功/失败都清 pending（失败时下次调用会重试，符合预期）
    pendingRequests.delete(key);
  }
}

/** 真正发起 HTTP 换 token — 被 pending dedupe 包装 */
async function doExchangeToken(corpId: string, wecomUserId: string, key: string): Promise<string> {
  const secret = process.env.DOOTASK_INTERNAL_SECRET;
  if (!secret) {
    throw new Error('DOOTASK_INTERNAL_SECRET is not configured');
  }
  const baseURL = process.env.DOOTASK_BASE_URL || process.env.DOOTASK_API_URL || 'http://localhost:2222';

  const { data } = await axios.post(
    `${baseURL.replace(/\/+$/, '')}/api/wecom/internal/generate_token`,
    { wecom_corp_id: corpId, wecom_userid: wecomUserId },
    {
      headers: {
        'X-Internal-Secret': secret,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    },
  );

  if (!data || data.ret !== 1) {
    throw new Error(data?.msg || 'dootask token exchange failed');
  }

  const token = data.data.token as string;
  const expiresIn = Number(data.data.expires_in) || 3600;
  tokenCache.set(key, {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  return token;
}

/** 仅用于测试：清空缓存 + pending */
export function _clearCacheForTest(): void {
  tokenCache.clear();
  pendingRequests.clear();
}

/** P2-12: 供缓存断言用 */
export function _getCacheSizeForTest(): number {
  return tokenCache.size;
}

/** v3.4 Top-1: 供并发 dedupe 断言用 */
export function _getPendingSizeForTest(): number {
  return pendingRequests.size;
}
