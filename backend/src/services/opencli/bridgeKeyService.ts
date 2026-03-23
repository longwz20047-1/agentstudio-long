import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;
const KEY_PREFIX = 'obk_';
const keyHashes = new Map<string, string>();

export async function generateBridgeKey(userId: string): Promise<string> {
  const random = crypto.randomBytes(16).toString('hex');
  const key = `${KEY_PREFIX}${random}`;
  const hash = await bcrypt.hash(key, SALT_ROUNDS);
  keyHashes.set(hash, userId.trim().toLowerCase());
  return key;
}

export async function validateBridgeKey(key: string): Promise<string | null> {
  if (!key.startsWith(KEY_PREFIX)) return null;
  for (const [hash, userId] of keyHashes) {
    if (await bcrypt.compare(key, hash)) return userId;
  }
  return null;
}
