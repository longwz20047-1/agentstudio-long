// 新的 3 个 MCP 集成
export { integrateSearchMcp, getSearchToolNames } from './searchMcp.js';
export { integrateImagesMcp, getImagesToolNames } from './imagesMcp.js';
export { integrateVideosMcp, getVideosToolNames } from './videosMcp.js';

// 共享类型和工具
export { getSearxngConfigFromEnv } from './types.js';
export type { SearxngConfig } from './types.js';

/** @deprecated 使用 integrateSearchMcp/integrateImagesMcp/integrateVideosMcp 替代 */
export { integrateSearchMcpServer, getSearxngToolNames } from './searxngIntegration.js';

/** 新工具名列表（3 个工具） */
export function getAllSearxngToolNames(): string[] {
  return [
    'mcp__searxng-search__web_search',
    'mcp__searxng-images__image_search',
    'mcp__searxng-videos__video_search',
  ];
}
