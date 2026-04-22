/**
 * DooTask API HTTP 客户端
 *
 * 等价行为：原 `dootask/electron/lib/mcp.js` 的 `this.request(method, path, data)` —
 * 通过 `mainWindow.webContents.executeJavaScript` 调用前端 `$A.apiCall`。
 * 这里直接 HTTP 调用后端 `${baseUrl}/api/<path>`。
 *
 * Dootask API 约定（见 `dootask/app/Module/Base.php::token/retSuccess/retError`）：
 *   - 认证 header: `dootask-token: <token>`（`headerOrInput('dootask-token')` 优先）
 *   - 响应格式: `{ ret: 1|0, msg: string, data: any }`
 *   - `ret=1` success → 返回 `data`
 *   - `ret=0` fail   → 抛 Error(msg)
 */

import axios, { AxiosError } from 'axios';

const DEFAULT_TIMEOUT_MS = 30_000;

export class DootaskApiError extends Error {
  constructor(public readonly msg: string, public readonly ret = 0) {
    super(msg);
    this.name = 'DootaskApiError';
  }
}

function getBaseUrl(): string {
  // 与 dootaskTokenExchange.ts 保持同一约定：优先 DOOTASK_BASE_URL，兼容老式 DOOTASK_API_URL
  const url = process.env.DOOTASK_BASE_URL || process.env.DOOTASK_API_URL;
  if (!url) {
    throw new Error('DOOTASK_BASE_URL is not set');
  }
  return url.replace(/\/+$/, '');
}

/**
 * 调用 Dootask API
 *
 * @param token    用户 token（由 dootaskTokenExchange 换取）
 * @param method   HTTP 方法
 * @param path     API 相对路径（如 `project/task/add`；不要包含 `/api/` 前缀或前导 `/`）
 * @param data     GET 作 query，POST/PUT/DELETE 作 body
 */
export async function makeDootaskRequest(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data: Record<string, unknown> = {},
): Promise<any> {
  if (!token) {
    throw new Error('dootask token is required');
  }
  const cleanPath = path.replace(/^\/+/, '');
  const url = `${getBaseUrl()}/api/${cleanPath}`;
  const isRead = method === 'GET';

  try {
    const response = await axios.request({
      url,
      method,
      timeout: DEFAULT_TIMEOUT_MS,
      headers: {
        'dootask-token': token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      // GET 用 params；其余方法用 body
      ...(isRead ? { params: data } : { data }),
    });

    const payload = response.data;
    if (!payload || typeof payload !== 'object') {
      throw new DootaskApiError(
        `unexpected response shape from ${path}: ${JSON.stringify(payload).slice(0, 200)}`,
      );
    }
    if (payload.ret !== 1) {
      throw new DootaskApiError(payload.msg || `Dootask API error at ${path}`, payload.ret ?? 0);
    }
    return payload.data;
  } catch (err) {
    if (err instanceof DootaskApiError) throw err;
    const ax = err as AxiosError;
    if (ax.response) {
      throw new DootaskApiError(
        `HTTP ${ax.response.status} from ${path}: ${JSON.stringify(ax.response.data).slice(0, 200)}`,
      );
    }
    if (ax.code === 'ECONNABORTED') {
      throw new DootaskApiError(`request timeout (${DEFAULT_TIMEOUT_MS} ms) at ${path}`);
    }
    throw new DootaskApiError(`network error at ${path}: ${ax.message || String(err)}`);
  }
}
