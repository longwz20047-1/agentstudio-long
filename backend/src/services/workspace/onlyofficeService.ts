import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';

// Read env vars lazily (not at module init) because dotenv.config() runs after ES module imports
function env(key: string): string {
  return process.env[key] || '';
}

export function generateFileToken(filePath: string): string {
  return crypto.createHmac('sha256', env('ONLYOFFICE_HMAC_SECRET')).update(filePath).digest('hex');
}

export function verifyFileToken(filePath: string, token: string): boolean {
  const expected = Buffer.from(generateFileToken(filePath));
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

export function buildOnlyOfficeConfig(
  filePath: string,
  mode: 'view' | 'edit',
  agentId: string,
  baseUrl: string,
  userId?: string,
) {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const fileToken = generateFileToken(filePath);
  const docKey = crypto.createHash('md5').update(`${filePath}-${Date.now()}`).digest('hex');
  const userParam = userId ? `&userId=${encodeURIComponent(userId)}` : '';

  const config: Record<string, any> = {
    document: {
      fileType: ext,
      key: docKey,
      title: fileName,
      url: `${baseUrl}/a2a/${agentId}/workspace/onlyoffice/file?path=${encodeURIComponent(filePath)}&token=${fileToken}${userParam}`,
    },
    editorConfig: {
      mode,
      callbackUrl: `${baseUrl}/a2a/${agentId}/workspace/onlyoffice/callback?path=${encodeURIComponent(filePath)}&token=${fileToken}${userParam}`,
      lang: 'zh',
    },
  };

  const jwtSecret = env('ONLYOFFICE_JWT_SECRET');
  if (jwtSecret) {
    config.token = jwt.sign(config, jwtSecret);
  }

  return { config, onlyofficeUrl: env('ONLYOFFICE_EXTERNAL_URL') };
}

export function rewriteCallbackUrl(downloadUrl: string): string {
  const dsUrl = env('ONLYOFFICE_DS_URL');
  if (!dsUrl) return downloadUrl;
  try {
    const parsed = new URL(downloadUrl);
    const internal = new URL(dsUrl);
    parsed.protocol = internal.protocol;
    parsed.host = internal.host;
    return parsed.toString();
  } catch {
    return downloadUrl;
  }
}
