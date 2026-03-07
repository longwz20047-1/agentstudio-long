// 新的 3 个 MCP 集成（searchMcp 包含 web_search + web_fetch 双工具）
export { integrateSearchMcp, getSearchToolNames, _resetSearchCache } from './searchMcp.js';
export { integrateImagesMcp, getImagesToolNames } from './imagesMcp.js';
export { integrateVideosMcp, getVideosToolNames } from './videosMcp.js';

// 共享类型和工具
export { getSearxngConfigFromEnv } from './types.js';
export type { SearxngConfig } from './types.js';

// 缓存管理（测试用）
export { _resetExtractionCache } from './contentExtractor.js';

/** 全部工具名列表（3 个工具） */
export function getAllSearxngToolNames(): string[] {
  return [
    'mcp__searxng-search__web_search',
    'mcp__searxng-images__image_search',
    'mcp__searxng-videos__video_search',
  ];
}
