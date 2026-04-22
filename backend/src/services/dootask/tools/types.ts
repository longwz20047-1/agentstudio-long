/**
 * 传给每个 tool 的上下文对象。
 *
 * 关键设计：closure 捕获的是 `getToken` 函数而不是 token 字符串。
 * 每次工具调用都 lazy resolve，确保长对话（>1h）跨越 token TTL 时
 * 由 getDootaskToken 的缓存 + SAFETY_MARGIN_MS 自动续期，避免 401。
 *
 * 热路径开销：1 次 Map lookup + 1 次 Date.now() 比较（~0.01 ms）。
 */
export interface ToolContext {
  /** 异步获取当前有效 token。内部有缓存，冷路径才打 dootask 端点。 */
  getToken: () => Promise<string>;
}
