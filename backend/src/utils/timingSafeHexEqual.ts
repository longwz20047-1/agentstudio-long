import crypto from 'node:crypto';

/**
 * 常数时间比较两个 hex 字符串，防 secret 长度 / 内容泄露。
 *
 * Node `crypto.timingSafeEqual` 要求 Buffer 等长否则抛 RangeError，
 * 而 Dootask 发来的 X-Internal-Secret / X-Internal-Timestamp 等 header
 * 长度不受信任（攻击者可发任意长度）。此 helper 先校验长度再调 timingSafeEqual。
 *
 * spec v2.1 §8.4 约定的唯一 HMAC 比较入口。
 */
export function safeEqualHex(headerHex: string, envHex: string): boolean {
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(headerHex || '', 'hex');
    b = Buffer.from(envHex || '', 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}
