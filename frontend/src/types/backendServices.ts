export interface BackendService {
  id: string;
  name: string;
  url: string;
  isDefault?: boolean;
}

export interface BackendServicesState {
  services: BackendService[];
  currentServiceId: string | null;
}

// 默认后端服务地址：
// - 嵌入模式（VITE_API_BASE 以 / 开头）：从 VITE_API_BASE 推断（去掉 /api 后缀）
// - 非嵌入模式：开发时用 localhost
function getDefaultServiceUrl(): string {
  const apiBase = import.meta.env.VITE_API_BASE;
  if (typeof apiBase === 'string' && apiBase.startsWith('/') && !apiBase.startsWith('//')) {
    // /agentstudio/api → origin + /agentstudio
    const backendPath = apiBase.replace(/\/api\/?$/, '');
    return (typeof window !== 'undefined' ? window.location.origin : '') + backendPath;
  }
  return 'http://127.0.0.1:4936';
}

export const DEFAULT_SERVICES: BackendService[] = [
  {
    id: 'default',
    name: '默认服务',
    url: getDefaultServiceUrl(),
    isDefault: true
  }
];