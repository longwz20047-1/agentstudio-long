// backend/src/services/graphiti/hooks/index.ts

import type { HookEvent, HookCallbackMatcher, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { GraphitiContext } from '../types.js';
import type { GraphitiHooksConfig } from './types.js';
import { createUserPromptSubmitHook } from './userPromptSubmitHook.js';

export type { GraphitiHooksConfig, ProfileQuery } from './types.js';
export { createUserPromptSubmitHook, formatUserProfile } from './userPromptSubmitHook.js';
// Legacy exports for compatibility
export { createSessionStartHook, DEFAULT_PROFILE_QUERIES } from './sessionStartHook.js';

/** 默认配置 */
const DEFAULT_CONFIG: GraphitiHooksConfig = {
  enableSessionStartHook: true,
  sessionStartTimeoutMs: 5000,
  maxFactsPerCategory: 3,
};

/**
 * 创建 Graphiti Memory Hooks
 *
 * 使用闭包模式捕获 GraphitiContext，确保每个会话独立。
 *
 * **重要**: 此函数仅在 A2A API 路径调用，普通 agents 路由不会传入 context。
 * 即使如此，仍添加防御性检查确保在无效 context 时不注册任何 Hook。
 *
 * **注意**: 使用 UserPromptSubmit hook 而不是 SessionStart，因为 SDK 的 query()
 * 函数目前不触发 SessionStart 事件。UserPromptSubmit 在用户提交消息时触发。
 *
 * @param context - Graphiti 上下文 (通过闭包捕获)
 * @param config - Hook 配置选项
 * @returns SDK hooks 对象，无效 context 时返回空对象
 */
export function createGraphitiHooks(
  context: GraphitiContext | undefined | null,
  config: GraphitiHooksConfig = {}
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  // 防御性检查：无效 context 时返回空 hooks，避免报错
  if (!context?.base_url || !context?.user_id) {
    console.warn('[Graphiti] createGraphitiHooks called without valid context, skipping hooks registration');
    return {};
  }

  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

  // UserPromptSubmit - 用户画像注入（首次消息时）
  // 注意：之前使用 SessionStart，但 SDK 的 query() 不触发该事件
  if (mergedConfig.enableSessionStartHook !== false) {
    const hookCallback = createUserPromptSubmitHook(context, mergedConfig) as HookCallback;
    hooks.UserPromptSubmit = [{ hooks: [hookCallback] }];
    console.log('📌 [Graphiti] UserPromptSubmit hook registered (for user profile injection)');
  }

  // 预留其他 Hook 的扩展点
  // hooks.SessionEnd = [...]
  // hooks.PostToolUse = [...]

  return hooks;
}
