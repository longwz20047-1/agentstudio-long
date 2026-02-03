// backend/src/services/graphiti/hooks/types.ts

import type { HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/**
 * Graphiti Hooks 配置选项
 */
export interface GraphitiHooksConfig {
  /** 启用 SessionStart hook - 用户画像注入 (默认: true) */
  enableSessionStartHook?: boolean;

  /** SessionStart 搜索超时时间，毫秒 (默认: 5000) */
  sessionStartTimeoutMs?: number;

  /** 自定义用户画像搜索维度 */
  profileQueries?: ProfileQuery[];

  /** 每个维度最大结果数 (默认: 3) */
  maxFactsPerCategory?: number;
}

/**
 * 用户画像搜索维度
 */
export interface ProfileQuery {
  /** 分类名称，将显示在画像标题中 */
  category: string;
  /** 搜索查询关键词 */
  query: string;
}

/**
 * Graphiti 搜索结果中的单条 Fact
 */
export interface FactResult {
  uuid: string;
  name: string;
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
  created_at: string;
  expired_at: string | null;
}

/**
 * Graphiti /search API 响应
 */
export interface GraphitiSearchResponse {
  facts: FactResult[];
}

/**
 * SessionStart Hook 返回类型
 *
 * 来源: @anthropic-ai/claude-agent-sdk sdk.d.ts:1569-1572
 */
export type SessionStartHookOutput = HookJSONOutput & {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: 'SessionStart';
    additionalContext?: string;
  };
};
