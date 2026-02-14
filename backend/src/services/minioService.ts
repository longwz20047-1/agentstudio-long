// backend/src/services/minioService.ts
import * as Minio from 'minio';
import { Readable } from 'stream';

let minioClient: Minio.Client | null = null;

function getClient(): Minio.Client {
  if (!minioClient) {
    const endpoint = process.env.WEKNORA_MINIO_ENDPOINT || 'http://192.168.100.30:9000';
    const url = new URL(endpoint);

    minioClient = new Minio.Client({
      endPoint: url.hostname,
      port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 9000),
      useSSL: url.protocol === 'https:',
      accessKey: process.env.WEKNORA_MINIO_ACCESS_KEY || '',
      secretKey: process.env.WEKNORA_MINIO_SECRET_KEY || '',
    });
  }
  return minioClient;
}

/**
 * 从 MinIO 路径解析出 bucket 和 object name
 * 例如: "minio:\weknora-files\10001\abc\file.pdf" → { bucket: "weknora-files", objectName: "10001/abc/file.pdf" }
 */
function parseMinioPath(filePath: string): { bucket: string; objectName: string } {
  // 去掉 "minio:" 或 "minio\" 前缀，统一斜杠
  const objectPath = filePath.replace(/^minio[:\\/]+/, '').replace(/\\/g, '/');
  const slashIdx = objectPath.indexOf('/');
  if (slashIdx === -1) {
    throw new Error('Invalid MinIO path: no bucket found');
  }
  return {
    bucket: objectPath.substring(0, slashIdx),
    objectName: objectPath.substring(slashIdx + 1),
  };
}

/**
 * 从 MinIO 获取文件流
 */
export async function getMinioFileStream(filePath: string): Promise<Readable> {
  const { bucket, objectName } = parseMinioPath(filePath);
  const client = getClient();
  return await client.getObject(bucket, objectName);
}
