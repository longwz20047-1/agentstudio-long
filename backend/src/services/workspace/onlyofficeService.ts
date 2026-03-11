import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';

const JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET || '';
const HMAC_SECRET = process.env.ONLYOFFICE_HMAC_SECRET || '';
const DS_URL = process.env.ONLYOFFICE_DS_URL || '';
const EXTERNAL_URL = process.env.ONLYOFFICE_EXTERNAL_URL || '';

export function generateFileToken(filePath: string): string {
  return crypto.createHmac('sha256', HMAC_SECRET).update(filePath).digest('hex');
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
) {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const fileToken = generateFileToken(filePath);
  const docKey = crypto.createHash('md5').update(`${filePath}-${Date.now()}`).digest('hex');

  const config: Record<string, any> = {
    document: {
      fileType: ext,
      key: docKey,
      title: fileName,
      url: `${baseUrl}/a2a/${agentId}/workspace/onlyoffice/file?path=${encodeURIComponent(filePath)}&token=${fileToken}`,
    },
    editorConfig: {
      mode,
      callbackUrl: `${baseUrl}/a2a/${agentId}/workspace/onlyoffice/callback?path=${encodeURIComponent(filePath)}&token=${fileToken}`,
      lang: 'zh',
    },
  };

  if (JWT_SECRET) {
    config.token = jwt.sign(config, JWT_SECRET);
  }

  return { config, onlyofficeUrl: EXTERNAL_URL };
}

export function rewriteCallbackUrl(downloadUrl: string): string {
  if (!DS_URL) return downloadUrl;
  try {
    const parsed = new URL(downloadUrl);
    const internal = new URL(DS_URL);
    parsed.protocol = internal.protocol;
    parsed.host = internal.host;
    return parsed.toString();
  } catch {
    return downloadUrl;
  }
}
