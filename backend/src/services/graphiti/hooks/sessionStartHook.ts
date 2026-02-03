// backend/src/services/graphiti/hooks/sessionStartHook.ts

import type { SessionStartHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { GraphitiContext } from '../types.js';
import type { GraphitiHooksConfig, ProfileQuery, SessionStartHookOutput } from './types.js';
import { searchMultipleCategories } from './graphitiClient.js';

/** 默认用户画像搜索维度 */
export const DEFAULT_PROFILE_QUERIES: ProfileQuery[] = [
  // 基础信息维度
  { category: '基本信息', query: '用户 姓名 职业 身份 角色 个人信息 背景' },
  { category: '工作目标', query: '目标 计划 愿景 想要实现 希望达成 OKR KPI' },

  // 能力与技术维度
  { category: '技术能力', query: '技术栈 编程语言 框架 工具 擅长 熟悉 精通' },
  { category: '知识领域', query: '专业 领域 行业 经验 专长 背景知识' },

  // 偏好与风格维度
  { category: '偏好设置', query: '偏好 喜欢 习惯 风格 不喜欢 讨厌 避免' },
  { category: '沟通风格', query: '沟通 表达 简洁 详细 正式 随意 语气 风格偏好' },

  // 当前状态维度
  { category: '当前项目', query: '正在做 当前项目 在开发 产品 系统 应用' },
  { category: '待办事项', query: '待办 TODO 未完成 进行中 下次继续 提醒' },

  // 兴趣与发展维度
  { category: '关注领域', query: '关注 学习 感兴趣 研究 探索 想了解' },
  { category: '常见挑战', query: '困难 挑战 问题 痛点 卡住 需要帮助' },
];

/** 默认超时时间 (毫秒) */
const DEFAULT_TIMEOUT_MS = 5000;

/** 默认每个维度最大结果数 */
const DEFAULT_MAX_FACTS_PER_CATEGORY = 3;

/**
 * 将用户画像格式化为 Markdown
 */
export function formatUserProfile(profile: Map<string, string[]>): string {
  if (profile.size === 0) {
    return '';
  }

  let markdown = '## 用户画像\n\n';
  markdown += '_以下是从长期记忆中检索的用户信息，请据此提供个性化帮助：_\n\n';

  for (const [category, facts] of profile) {
    markdown += `### ${category}\n`;
    for (const fact of facts) {
      markdown += `- ${fact}\n`;
    }
    markdown += '\n';
  }

  return markdown;
}

/**
 * 创建 SessionStart Hook - 用户画像注入
 *
 * 在会话开始时从 Graphiti 搜索用户相关信息，构建用户画像
 * 并通过 additionalContext 注入到 Claude 的上下文中。
 *
 * @param context - Graphiti 上下文 (通过闭包捕获)
 * @param config - Hook 配置选项
 * @returns Hook 回调函数
 */
export function createSessionStartHook(
  context: GraphitiContext,
  config: GraphitiHooksConfig
) {
  const timeoutMs = config.sessionStartTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFactsPerCategory = config.maxFactsPerCategory ?? DEFAULT_MAX_FACTS_PER_CATEGORY;
  const profileQueries = config.profileQueries ?? DEFAULT_PROFILE_QUERIES;

  return async (
    input: SessionStartHookInput,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal }
  ): Promise<SessionStartHookOutput> => {
    console.log('🚀 [Graphiti Hook] Session started, building user profile...');
    console.log(`   Session ID: ${input.session_id}`);
    console.log(`   Source: ${input.source}`);

    try {
      // 并行搜索所有维度
      const profile = await searchMultipleCategories(
        context,
        profileQueries,
        maxFactsPerCategory,
        timeoutMs
      );

      if (profile.size === 0) {
        console.log('📭 [Graphiti Hook] No user profile found');
        return { continue: true };
      }

      // 格式化为 Markdown
      const additionalContext = formatUserProfile(profile);

      console.log(`✅ [Graphiti Hook] User profile injected (${profile.size} categories)`);
      console.log('📋 [Graphiti Hook] Injected context:\n' + '─'.repeat(50));
      console.log(additionalContext);
      console.log('─'.repeat(50));

      // 通过 hookSpecificOutput.additionalContext 注入上下文
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext,
        },
      };
    } catch (error) {
      console.error('❌ [Graphiti Hook] Failed to build user profile:', error);
      // 失败不阻塞会话
      return { continue: true };
    }
  };
}
