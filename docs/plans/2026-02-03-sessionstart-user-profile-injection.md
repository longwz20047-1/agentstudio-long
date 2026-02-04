# SessionStart 用户画像注入实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在会话开始时从 Graphiti 检索用户相关信息，构建"用户画像"并注入到 Claude 的上下文中，实现个性化对话。

**Architecture:**
- 使用 Claude Agent SDK 的 SessionStart Hook，在每次新建 ClaudeSession 时触发
- 并行搜索 Graphiti 的多个维度（基本信息、偏好设置、技术能力、未完成事项、关注领域）
- 通过 `additionalContext` 返回值将用户画像注入 Claude 上下文

**Tech Stack:** TypeScript, Claude Agent SDK (SessionStart Hook), Graphiti REST API, Node.js fetch

---

## ⚠️ 适用范围

**重要**: Graphiti 集成（MCP Server + Hooks）**仅在 A2A API 路径生效**：

| API 路径 | 是否集成 Graphiti | 原因 |
|----------|------------------|------|
| `/api/a2a/*` | ✅ 是 | A2A 请求携带 `context.graphiti` |
| `/api/agents/*` | ❌ 否 | 普通项目对话不传入 `graphitiContext` |

**代码路径对比:**

```
A2A 路由 (a2a.ts:304-325):
  const graphitiContext = context?.graphiti;  // ← 从请求中提取
  buildQueryOptions(..., { graphitiContext }) // ← 传入

普通 agents 路由 (agents.ts:632):
  buildQueryOptions(..., undefined)           // ← extendedOptions 为空
```

**设计决策:** Hook 只在 `graphitiContext` 有效时注册，无 context 时不注册任何 Hook，避免报错。

---

## 前置条件

已完成的工作（无需重复实现）：
- `backend/src/services/graphiti/types.ts` - GraphitiContext 接口定义
- `backend/src/services/graphiti/graphitiIntegration.ts` - Graphiti MCP Server 集成
- `backend/src/utils/claudeUtils.ts:461-467` - Graphiti 集成入口点（已有条件判断）

---

## Task 1: 创建 Graphiti Hooks 类型定义

**Files:**
- Create: `backend/src/services/graphiti/hooks/types.ts`

**Step 1: 创建 hooks 目录并创建类型文件**

```typescript
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
export interface SessionStartHookOutput extends HookJSONOutput {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: 'SessionStart';
    additionalContext?: string;
  };
}
```

**Step 2: 验证类型文件语法**

Run: `cd backend && npx tsc --noEmit src/services/graphiti/hooks/types.ts`
Expected: 无错误输出

**Step 3: Commit**

```bash
git add backend/src/services/graphiti/hooks/types.ts
git commit -m "feat(graphiti): add types for SessionStart hook"
```

---

## Task 2: 创建 Graphiti HTTP 客户端

**Files:**
- Create: `backend/src/services/graphiti/hooks/graphitiClient.ts`

**Step 1: 创建客户端文件**

```typescript
// backend/src/services/graphiti/hooks/graphitiClient.ts

import type { GraphitiContext } from '../types.js';
import type { GraphitiSearchResponse, ProfileQuery, FactResult } from './types.js';

/** 默认超时时间 (毫秒) */
const DEFAULT_TIMEOUT_MS = 5000;

/** 每个维度最大结果数 */
const DEFAULT_MAX_FACTS = 3;

/**
 * 从 Graphiti 搜索指定维度的 facts
 *
 * @param context - Graphiti 上下文
 * @param query - 搜索查询
 * @param maxFacts - 最大结果数
 * @param timeoutMs - 超时时间
 * @returns 匹配的 facts 数组
 */
export async function searchFacts(
  context: GraphitiContext,
  query: string,
  maxFacts: number = DEFAULT_MAX_FACTS,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<FactResult[]> {
  const { base_url, user_id, group_ids = [], api_key } = context;
  const allGroupIds = [`user_${user_id}`, ...group_ids];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base_url}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(api_key ? { 'Authorization': `Bearer ${api_key}` } : {}),
      },
      body: JSON.stringify({
        query,
        group_ids: allGroupIds,
        max_facts: maxFacts,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[Graphiti] Search failed: ${response.status}`);
      return [];
    }

    const data: GraphitiSearchResponse = await response.json();
    return data.facts || [];
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('[Graphiti] Search timeout');
    } else {
      console.warn('[Graphiti] Search error:', error);
    }
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 并行搜索多个维度
 *
 * @param context - Graphiti 上下文
 * @param queries - 搜索维度列表
 * @param maxFactsPerCategory - 每个维度最大结果数
 * @param timeoutMs - 每个搜索的超时时间
 * @returns 按分类名称组织的结果 Map
 */
export async function searchMultipleCategories(
  context: GraphitiContext,
  queries: ProfileQuery[],
  maxFactsPerCategory: number = DEFAULT_MAX_FACTS,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();

  const searchPromises = queries.map(async ({ category, query }) => {
    const facts = await searchFacts(context, query, maxFactsPerCategory, timeoutMs);
    const factTexts = facts.map(f => f.fact).filter(Boolean);
    if (factTexts.length > 0) {
      results.set(category, factTexts);
    }
  });

  await Promise.all(searchPromises);

  return results;
}
```

**Step 2: 验证语法**

Run: `cd backend && npx tsc --noEmit src/services/graphiti/hooks/graphitiClient.ts`
Expected: 无错误输出

**Step 3: Commit**

```bash
git add backend/src/services/graphiti/hooks/graphitiClient.ts
git commit -m "feat(graphiti): add HTTP client for user profile search"
```

---

## Task 3: 创建 SessionStart Hook 实现

**Files:**
- Create: `backend/src/services/graphiti/hooks/sessionStartHook.ts`
- Test: `backend/src/services/graphiti/hooks/__tests__/sessionStartHook.test.ts`

**Step 1: 编写失败测试**

```typescript
// backend/src/services/graphiti/hooks/__tests__/sessionStartHook.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionStartHook, DEFAULT_PROFILE_QUERIES, formatUserProfile } from '../sessionStartHook.js';
import type { GraphitiContext } from '../../types.js';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SessionStart Hook', () => {
  const mockContext: GraphitiContext = {
    base_url: 'http://localhost:8000',
    user_id: 'test-user',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('formatUserProfile', () => {
    it('should return empty string for empty profile', () => {
      const result = formatUserProfile(new Map());
      expect(result).toBe('');
    });

    it('should format profile with multiple categories', () => {
      const profile = new Map([
        ['基本信息', ['用户叫张三', '在北京工作']],
        ['偏好设置', ['喜欢简洁的代码']],
      ]);

      const result = formatUserProfile(profile);

      expect(result).toContain('## 用户画像');
      expect(result).toContain('### 基本信息');
      expect(result).toContain('- 用户叫张三');
      expect(result).toContain('- 在北京工作');
      expect(result).toContain('### 偏好设置');
      expect(result).toContain('- 喜欢简洁的代码');
    });
  });

  describe('createSessionStartHook', () => {
    it('should return continue: true when no profile found', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ facts: [] }),
      });

      const hook = createSessionStartHook(mockContext, {});
      const result = await hook(
        {
          hook_event_name: 'SessionStart',
          session_id: 'test-session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp',
          source: 'startup',
        } as any,
        undefined,
        { signal: new AbortController().signal }
      );

      expect(result.continue).toBe(true);
      expect(result.hookSpecificOutput?.additionalContext).toBeUndefined();
    });

    it('should inject user profile when facts found', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          facts: [{ fact: '用户叫张三', name: 'user_name' }],
        }),
      });

      const hook = createSessionStartHook(mockContext, {});
      const result = await hook(
        {
          hook_event_name: 'SessionStart',
          session_id: 'test-session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp',
          source: 'startup',
        } as any,
        undefined,
        { signal: new AbortController().signal }
      );

      expect(result.continue).toBe(true);
      expect(result.hookSpecificOutput?.additionalContext).toContain('用户画像');
    });

    it('should handle API errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const hook = createSessionStartHook(mockContext, {});
      const result = await hook(
        {
          hook_event_name: 'SessionStart',
          session_id: 'test-session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp',
          source: 'startup',
        } as any,
        undefined,
        { signal: new AbortController().signal }
      );

      expect(result.continue).toBe(true);
      // Should not block session on error
    });
  });

  describe('DEFAULT_PROFILE_QUERIES', () => {
    it('should have at least 3 categories', () => {
      expect(DEFAULT_PROFILE_QUERIES.length).toBeGreaterThanOrEqual(3);
    });

    it('should include common categories', () => {
      const categories = DEFAULT_PROFILE_QUERIES.map(q => q.category);
      expect(categories).toContain('基本信息');
      expect(categories).toContain('偏好设置');
    });
  });
});
```

**Step 2: 运行测试验证失败**

Run: `cd backend && npx vitest run src/services/graphiti/hooks/__tests__/sessionStartHook.test.ts`
Expected: FAIL (模块不存在)

**Step 3: 编写实现**

```typescript
// backend/src/services/graphiti/hooks/sessionStartHook.ts

import type { SessionStartHookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { GraphitiContext } from '../types.js';
import type { GraphitiHooksConfig, ProfileQuery, SessionStartHookOutput } from './types.js';
import { searchMultipleCategories } from './graphitiClient.js';

/** 默认用户画像搜索维度 */
export const DEFAULT_PROFILE_QUERIES: ProfileQuery[] = [
  { category: '基本信息', query: '用户 姓名 职业 身份 个人信息 名字' },
  { category: '偏好设置', query: '用户 偏好 喜欢 习惯 风格 不喜欢' },
  { category: '技术能力', query: '用户 技术栈 编程 框架 工具 擅长' },
  { category: '未完成事项', query: '待办 未完成 进行中 下次继续 TODO' },
  { category: '关注领域', query: '关注 学习 感兴趣 正在研究' },
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
```

**Step 4: 运行测试验证通过**

Run: `cd backend && npx vitest run src/services/graphiti/hooks/__tests__/sessionStartHook.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/services/graphiti/hooks/sessionStartHook.ts backend/src/services/graphiti/hooks/__tests__/sessionStartHook.test.ts
git commit -m "feat(graphiti): implement SessionStart hook for user profile injection"
```

---

## Task 4: 创建 Hooks 入口文件

**Files:**
- Create: `backend/src/services/graphiti/hooks/index.ts`

**Step 1: 创建入口文件**

```typescript
// backend/src/services/graphiti/hooks/index.ts

import type { HookEvent, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
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
    const hookCallback = createSessionStartHook(context, mergedConfig);
    hooks.SessionStart = [{ hooks: [hookCallback] }];
  }

  // 预留其他 Hook 的扩展点
  // hooks.UserPromptSubmit = [...]
  // hooks.SessionEnd = [...]
  // hooks.PostToolUse = [...]

  return hooks;
}
```

**Step 2: 验证语法**

Run: `cd backend && npx tsc --noEmit src/services/graphiti/hooks/index.ts`
Expected: 无错误输出

**Step 3: Commit**

```bash
git add backend/src/services/graphiti/hooks/index.ts
git commit -m "feat(graphiti): add hooks entry point with createGraphitiHooks"
```

---

## Task 5: 集成 Hooks 到 claudeUtils.ts

**Files:**
- Modify: `backend/src/utils/claudeUtils.ts:461-467`

**Step 1: 查看当前集成点**

当前代码 (`claudeUtils.ts:461-467`):
```typescript
// Integrate Graphiti Memory SDK MCP server (only when context is provided and valid)
const graphitiContext = extendedOptions?.graphitiContext;
if (graphitiContext?.base_url && graphitiContext?.user_id) {
  await integrateGraphitiMcpServer(queryOptions, graphitiContext);
  const groupCount = (graphitiContext.group_ids?.length || 0) + 1;
  console.log('✅ [Graphiti] Memory MCP Server integrated for user', graphitiContext.user_id, 'with', groupCount, 'groups');
}
```

**Step 2: 添加 Hooks 集成**

在 `await integrateGraphitiMcpServer(...)` 后添加:

```typescript
// Integrate Graphiti Memory SDK MCP server (only when context is provided and valid)
const graphitiContext = extendedOptions?.graphitiContext;
if (graphitiContext?.base_url && graphitiContext?.user_id) {
  await integrateGraphitiMcpServer(queryOptions, graphitiContext);

  // Integrate Graphiti Hooks (SessionStart for user profile injection)
  const graphitiHooks = createGraphitiHooks(graphitiContext);
  queryOptions.hooks = {
    ...queryOptions.hooks,
    ...graphitiHooks,
  };

  const groupCount = (graphitiContext.group_ids?.length || 0) + 1;
  console.log('✅ [Graphiti] Memory MCP Server + Hooks integrated for user', graphitiContext.user_id, 'with', groupCount, 'groups');
}
```

**Step 3: 添加 import**

在文件顶部添加:

```typescript
import { createGraphitiHooks } from '../services/graphiti/hooks/index.js';
```

**Step 4: 验证编译**

Run: `cd backend && pnpm run build`
Expected: 编译成功

**Step 5: Commit**

```bash
git add backend/src/utils/claudeUtils.ts
git commit -m "feat(graphiti): integrate SessionStart hook into claudeUtils"
```

---

## Task 6: 端到端验证

**Files:**
- None (测试现有功能)

**Step 1: 启动开发服务器**

Run: `pnpm run dev`
Expected: 前后端都启动成功

**Step 2: 测试 Graphiti 集成**

1. 配置一个带有 Graphiti context 的 A2A agent
2. 向 Graphiti 写入测试数据：
   - 发送消息 "记住我叫测试用户，是一名前端工程师"
3. 开始新对话（触发 SessionStart）
4. 检查后端日志是否有：
   - `🚀 [Graphiti Hook] Session started, building user profile...`
   - `✅ [Graphiti Hook] User profile injected (N categories)`

**Step 3: 验证用户画像注入效果**

1. 在新对话中问 "你知道我是谁吗？"
2. 如果用户画像注入成功，Claude 应该能够回答用户的基本信息

---

## Task 7: 单元测试补充

**Files:**
- Create: `backend/src/services/graphiti/hooks/__tests__/graphitiClient.test.ts`
- Create: `backend/src/services/graphiti/hooks/__tests__/index.test.ts`

**Step 1: 编写 graphitiClient 测试**

```typescript
// backend/src/services/graphiti/hooks/__tests__/graphitiClient.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchFacts, searchMultipleCategories } from '../graphitiClient.js';
import type { GraphitiContext } from '../../types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('graphitiClient', () => {
  const mockContext: GraphitiContext = {
    base_url: 'http://localhost:8000',
    user_id: 'test-user',
    group_ids: ['shared'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('searchFacts', () => {
    it('should return facts on successful response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          facts: [
            { fact: 'Test fact 1', name: 'fact1' },
            { fact: 'Test fact 2', name: 'fact2' },
          ],
        }),
      });

      const result = await searchFacts(mockContext, 'test query');

      expect(result).toHaveLength(2);
      expect(result[0].fact).toBe('Test fact 1');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/search',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"group_ids":["user_test-user","shared"]'),
        })
      );
    });

    it('should return empty array on API error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await searchFacts(mockContext, 'test query');

      expect(result).toEqual([]);
    });

    it('should return empty array on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await searchFacts(mockContext, 'test query');

      expect(result).toEqual([]);
    });
  });

  describe('searchMultipleCategories', () => {
    it('should search all categories in parallel', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          facts: [{ fact: 'Test fact', name: 'test' }],
        }),
      });

      const queries = [
        { category: 'Cat1', query: 'query1' },
        { category: 'Cat2', query: 'query2' },
      ];

      const result = await searchMultipleCategories(mockContext, queries);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.size).toBe(2);
      expect(result.get('Cat1')).toEqual(['Test fact']);
      expect(result.get('Cat2')).toEqual(['Test fact']);
    });

    it('should exclude categories with no results', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ facts: [{ fact: 'Has fact', name: 'test' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ facts: [] }),
        });

      const queries = [
        { category: 'HasFacts', query: 'query1' },
        { category: 'NoFacts', query: 'query2' },
      ];

      const result = await searchMultipleCategories(mockContext, queries);

      expect(result.size).toBe(1);
      expect(result.has('HasFacts')).toBe(true);
      expect(result.has('NoFacts')).toBe(false);
    });
  });
});
```

**Step 2: 编写 index 入口测试**

```typescript
// backend/src/services/graphiti/hooks/__tests__/index.test.ts

import { describe, it, expect } from 'vitest';
import { createGraphitiHooks } from '../index.js';
import type { GraphitiContext } from '../../types.js';

describe('createGraphitiHooks', () => {
  const mockContext: GraphitiContext = {
    base_url: 'http://localhost:8000',
    user_id: 'test-user',
  };

  it('should create SessionStart hook by default', () => {
    const hooks = createGraphitiHooks(mockContext);

    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart![0].hooks).toHaveLength(1);
  });

  it('should not create SessionStart hook when disabled', () => {
    const hooks = createGraphitiHooks(mockContext, {
      enableSessionStartHook: false,
    });

    expect(hooks.SessionStart).toBeUndefined();
  });

  it('should return empty hooks object when all disabled', () => {
    const hooks = createGraphitiHooks(mockContext, {
      enableSessionStartHook: false,
    });

    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('should return empty hooks object when context is undefined', () => {
    const hooks = createGraphitiHooks(undefined);

    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('should return empty hooks object when context is null', () => {
    const hooks = createGraphitiHooks(null);

    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('should return empty hooks object when context has no base_url', () => {
    const hooks = createGraphitiHooks({ user_id: 'test' } as any);

    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('should return empty hooks object when context has no user_id', () => {
    const hooks = createGraphitiHooks({ base_url: 'http://localhost' } as any);

    expect(Object.keys(hooks)).toHaveLength(0);
  });
});
```

**Step 3: 运行所有测试**

Run: `cd backend && npx vitest run src/services/graphiti/hooks/__tests__/`
Expected: 所有测试通过

**Step 4: Commit**

```bash
git add backend/src/services/graphiti/hooks/__tests__/
git commit -m "test(graphiti): add unit tests for hooks module"
```

---

## 文件清单

### 新建文件

| 文件 | 说明 |
|------|------|
| `backend/src/services/graphiti/hooks/types.ts` | Hook 类型定义 |
| `backend/src/services/graphiti/hooks/graphitiClient.ts` | Graphiti HTTP 客户端 |
| `backend/src/services/graphiti/hooks/sessionStartHook.ts` | SessionStart Hook 实现 |
| `backend/src/services/graphiti/hooks/index.ts` | Hooks 入口文件 |
| `backend/src/services/graphiti/hooks/__tests__/sessionStartHook.test.ts` | SessionStart 测试 |
| `backend/src/services/graphiti/hooks/__tests__/graphitiClient.test.ts` | HTTP 客户端测试 |
| `backend/src/services/graphiti/hooks/__tests__/index.test.ts` | 入口文件测试 |

### 修改文件

| 文件 | 修改说明 |
|------|----------|
| `backend/src/utils/claudeUtils.ts` | 添加 `createGraphitiHooks` 调用 |

---

## 扩展说明

### SessionStart 触发时机（AgentStudio 特定）

AgentStudio 使用 Streaming Input Mode，SessionStart Hook 只在以下场景触发：

| 场景 | 是否触发 | 说明 |
|------|----------|------|
| 新建对话窗口 | ✅ | 创建新 ClaudeSession |
| 同一对话窗口后续消息 | ❌ | 复用现有 ClaudeSession |
| 配置变化（model、MCP 等） | ✅ | 重建 ClaudeSession |
| 会话超时后重连 | ✅ | 创建新 ClaudeSession |
| 刷新页面重新进入 | ✅ | 重新建立连接 |

**关键结论**：用户画像查询**不会**在每条消息时重复执行，只在会话初始化时执行一次。

### 性能考虑

| 方面 | 设计决策 |
|------|----------|
| **并行搜索** | 5 个维度并行请求，总耗时 ≈ 单次请求时间 |
| **超时控制** | 默认 5 秒，超时不阻塞会话 |
| **结果限制** | 每个维度最多 3 条，总共最多 15 条 |
| **失败降级** | 任何错误都不阻塞会话，只是没有画像注入 |

### 后续扩展

本计划只实现 SessionStart Hook，后续可扩展：
- `UserPromptSubmit Hook` - 捕获用户显式记忆请求
- `PostToolUse Hook` - 记录重要工具执行结果
- `SessionEnd Hook` - 会话结束时保存对话摘要

参考设计文档：`docs/plans/2026-02-02-graphiti-memory-hooks-design.md`
