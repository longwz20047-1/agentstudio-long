// backend/src/services/graphiti/hooks/index.ts

import type { HookEvent, HookCallbackMatcher, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { GraphitiContext } from '../types.js';
import type { GraphitiHooksConfig } from './types.js';
import { createSessionStartHook } from './sessionStartHook.js';

export type { GraphitiHooksConfig, ProfileQuery } from './types.js';
export { createSessionStartHook, DEFAULT_PROFILE_QUERIES, formatUserProfile } from './sessionStartHook.js';

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

  // SessionStart - 用户画像注入
  if (mergedConfig.enableSessionStartHook !== false) {
    const hookCallback = createSessionStartHook(context, mergedConfig) as HookCallback;
    hooks.SessionStart = [{ hooks: [hookCallback] }];
  }

  // 预留其他 Hook 的扩展点
  // hooks.UserPromptSubmit = [...]
  // hooks.SessionEnd = [...]
  // hooks.PostToolUse = [...]

  return hooks;
}
