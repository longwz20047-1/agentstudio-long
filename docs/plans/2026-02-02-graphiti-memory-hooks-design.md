# Graphiti Memory Hooks 设计文档

**日期**: 2026-02-02
**状态**: 设计中
**作者**: Claude

## 项目路径参考

| 项目 | 路径 | 说明 |
|------|------|------|
| **AgentStudio** | `D:\workspace\agentstudio` | 主项目，实现 Hooks |
| **Graphiti** | `D:\workspace\graphiti` | 知识图谱服务端 |
| **claude-mem** | `d:\workspace\claude-mem` | 参考实现 |

## 概述

基于 Claude Agent SDK 的代码级 hooks，自动将对话内容写入 Graphiti 记忆系统。

## 关键发现：Graphiti 内置 LLM 处理

**重要**: Graphiti 的 `add_episode` 方法内部已包含完整的 LLM 处理流程：

```
POST /messages (原始内容)
    ↓
add_episode()
    ↓
┌─────────────────────────────────────┐
│  1. extract_nodes (LLM)             │ → 从内容提取实体
│  2. resolve_extracted_nodes (LLM)   │ → 去重/合并实体
│  3. extract_edges (LLM)             │ → 提取实体间关系
│  4. resolve_extracted_edges (LLM)   │ → 去重/合并关系
│  5. extract_attributes (LLM)        │ → 提取实体属性
│  6. extract_summary (LLM)           │ → 生成实体摘要
└─────────────────────────────────────┘
    ↓
保存到 Neo4j 图数据库
```

**结论**: Hook 实现只需组装数据并发送请求，**无需在 Hook 内做 LLM 总结**。

## 参考实现

**claude-mem 项目**: `d:\workspace\claude-mem`
- Transcript 解析器: `src/shared/transcript-parser.ts`
- SessionEnd Hook: `src/hooks/summary-hook.ts`
- Hook 配置: `cursor-hooks/hooks.json`

**Graphiti 项目**: `D:\workspace\graphiti`
- API 路由: `server/graph_service/routers/ingest.py`
- DTO 定义: `server/graph_service/dto/common.py`, `server/graph_service/dto/ingest.py`
- 检索 DTO: `server/graph_service/dto/retrieve.py`

## SDK Hook 完整参考

### SDK 类型来源

**文件**: `D:\workspace\agentstudio\backend\node_modules\@anthropic-ai\claude-agent-sdk\sdk.d.ts`

```typescript
// 第 80-85 行
export declare type BaseHookInput = {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode?: string;
};

// 第 257-259 行
export declare type HookCallback = (input: HookInput, toolUseID: string | undefined, options: {
    signal: AbortSignal;
}) => Promise<HookJSONOutput>;

// 第 264-269 行
export declare interface HookCallbackMatcher {
    matcher?: string;
    hooks: HookCallback[];
    timeout?: number;
};

// 第 589 行
hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;

// 第 892-898 行
export declare type PostToolUseHookInput = BaseHookInput & {
    hook_event_name: 'PostToolUse';
    tool_name: string;
    tool_input: unknown;
    tool_response: unknown;
    tool_use_id: string;
};

// 第 1557-1560 行
export declare type SessionEndHookInput = BaseHookInput & {
    hook_event_name: 'SessionEnd';
    reason: ExitReason;
};

// 第 1766-1769 行
export declare type UserPromptSubmitHookInput = BaseHookInput & {
    hook_event_name: 'UserPromptSubmit';
    prompt: string;
};
```

### Hook 类型一览表

| Hook 类型 | 触发时机 | 输入数据 | 适合场景 |
|-----------|----------|----------|----------|
| **SessionStart** | 会话开始 | `session_id`, `transcript_path`, `cwd`, `source`, `agent_type?`, `model?` | 初始化记忆上下文 |
| **SessionEnd** | 会话结束 | `session_id`, `transcript_path`, `cwd`, `reason` | 总结对话写入记忆 |
| **UserPromptSubmit** | 用户提交消息 | `session_id`, `transcript_path`, `cwd`, **`prompt`** | 捕获用户意图/偏好 |
| **PreToolUse** | 工具调用前 | `session_id`, `tool_name`, `tool_input`, `tool_use_id` | 拦截/修改工具调用 |
| **PostToolUse** | 工具调用后 | `session_id`, `tool_name`, `tool_input`, **`tool_response`**, `tool_use_id` | 记录工具执行结果 |
| **PostToolUseFailure** | 工具调用失败 | `session_id`, `tool_name`, `tool_input`, `tool_use_id`, `error` | 记录失败信息 |
| **Notification** | 系统通知 | `session_id`, `message`, `title?`, `notification_type` | 捕获重要系统事件 |
| **Stop** | 代理停止 | `session_id`, `stop_hook_active` | 清理/收尾工作 |
| **SubagentStart** | 子代理启动 | `session_id`, `agent_id`, `agent_type` | 追踪子代理 |
| **SubagentStop** | 子代理停止 | `session_id`, `agent_id`, `agent_type`, `agent_transcript_path` | 收集子代理结果 |
| **PreCompact** | 上下文压缩前 | `session_id`, `transcript_path`, `trigger`, `custom_instructions` | 保存即将被压缩的内容 |
| **PermissionRequest** | 权限请求 | `session_id`, `tool_name`, `tool_input`, `permission_suggestions?` | 审计权限使用 |
| **Setup** | SDK 初始化 | `session_id`, `trigger` | 全局配置 |

> **注意**: 字段名已根据 SDK 0.2.29 类型定义验证。`UserPromptSubmit` 使用 `prompt` (非 `user_prompt`)，`PostToolUse` 使用 `tool_response` (非 `tool_result`)。

### BaseHookInput 基础字段

```typescript
interface BaseHookInput {
  session_id: string;        // 会话唯一标识
  transcript_path: string;   // JSONL 对话记录文件路径
  cwd: string;               // 工作目录
  permission_mode?: string;  // 权限模式
}
```

### SessionEnd 详细规格

```typescript
interface SessionEndHookInput extends BaseHookInput {
  hook_event_name: 'SessionEnd';
  reason: ExitReason;  // 'user_request' | 'tool_limit' | 'error' | ...
}
```

**重要**: SessionEnd **不包含** 已总结的内容，只提供 `transcript_path`，需要自行解析。

### Transcript 文件格式

**位置**: 由 `transcript_path` 指定
**格式**: JSONL (每行一个 JSON 对象)

```jsonl
{"type":"user","message":{"content":"用户消息内容..."}}
{"type":"assistant","message":{"content":[{"type":"text","text":"助手回复..."}]}}
{"type":"user","message":{"content":"..."}}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
```

---

## 一次性实现方案

### 实现难度评估

| Hook | 难度 | 核心工作 |
|------|------|----------|
| UserPromptSubmit | 低 | 关键词匹配 + 发送请求 |
| PostToolUse | 低 | 工具名过滤 + 格式化结果 + 发送请求 |
| SessionEnd | 低 | 解析 transcript + 发送请求 |

**所有 Hook 难度相同**，因为 Graphiti 内部已处理 LLM 总结，Hook 只负责数据组装。

### 文件结构

```
backend/src/services/graphiti/
├── types.ts                      # GraphitiContext 接口 (已存在)
├── graphitiIntegration.ts        # MCP Server (已实现)
└── hooks/
    ├── index.ts                  # Hook 注册入口
    ├── types.ts                  # Hook 输入输出类型
    ├── userPromptHook.ts         # UserPromptSubmit 处理
    ├── postToolUseHook.ts        # PostToolUse 处理
    ├── sessionStartHook.ts       # SessionStart 处理（用户画像注入）
    ├── sessionEndHook.ts         # SessionEnd 处理
    ├── transcriptParser.ts       # Transcript 解析工具
    └── graphitiClient.ts         # Graphiti API 客户端
```

### hooks/index.ts 完整实现

```typescript
// hooks/index.ts
import type { HookEvent, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type { GraphitiContext } from '../types.js';
import { createSessionStartHook } from './sessionStartHook.js';
import { createUserPromptHook } from './userPromptHook.js';
import { createPostToolUseHook } from './postToolUseHook.js';
import { createSessionEndHook } from './sessionEndHook.js';

export interface GraphitiHooksConfig {
  /** 启用 SessionStart hook - 用户画像注入 (默认: true) */
  enableSessionStartHook?: boolean;
  /** 启用 UserPromptSubmit hook (默认: true) */
  enableUserPromptHook?: boolean;
  /** 启用 PostToolUse hook (默认: true) */
  enablePostToolUseHook?: boolean;
  /** 启用 SessionEnd hook (默认: true) */
  enableSessionEndHook?: boolean;
  /** 需要记录的工具列表 (PostToolUse 用) */
  importantTools?: string[];
  /** SessionEnd 时最大消息数量 (默认: 10) */
  maxMessagesForSessionEnd?: number;
  /** SessionStart 搜索超时时间 (默认: 5000ms) */
  sessionStartTimeoutMs?: number;
  /** 自定义用户画像搜索维度 */
  profileQueries?: Array<{ category: string; query: string }>;
}

const DEFAULT_CONFIG: GraphitiHooksConfig = {
  enableSessionStartHook: true,
  enableUserPromptHook: true,
  enablePostToolUseHook: true,
  enableSessionEndHook: true,
  importantTools: ['Write', 'Edit', 'NotebookEdit'],
  maxMessagesForSessionEnd: 10,
  sessionStartTimeoutMs: 5000,
};

/**
 * 创建 Graphiti Memory Hooks
 *
 * 使用闭包模式捕获 GraphitiContext，确保每个会话独立
 *
 * @param context - Graphiti 上下文 (通过闭包捕获)
 * @param config - Hook 配置选项
 * @returns SDK hooks 对象
 */
export function createGraphitiHooks(
  context: GraphitiContext,
  config: GraphitiHooksConfig = DEFAULT_CONFIG
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

  // SessionStart - 用户画像注入
  if (mergedConfig.enableSessionStartHook !== false) {
    const hookCallback = createSessionStartHook(context, mergedConfig);
    hooks.SessionStart = [{ hooks: [hookCallback] }];
  }

  // UserPromptSubmit - 记忆关键词捕获
  if (mergedConfig.enableUserPromptHook !== false) {
    const hookCallback = createUserPromptHook(context);
    hooks.UserPromptSubmit = [{ hooks: [hookCallback] }];
  }

  // PostToolUse - 工具执行记录
  if (mergedConfig.enablePostToolUseHook !== false) {
    const hookCallback = createPostToolUseHook(context, mergedConfig.importantTools);
    hooks.PostToolUse = [{ hooks: [hookCallback] }];
  }

  // SessionEnd - 对话摘要
  if (mergedConfig.enableSessionEndHook !== false) {
    const hookCallback = createSessionEndHook(context, mergedConfig);
    hooks.SessionEnd = [{ hooks: [hookCallback] }];
  }

  return hooks;
}

export { createSessionStartHook } from './sessionStartHook.js';
export { createUserPromptHook } from './userPromptHook.js';
export { createPostToolUseHook } from './postToolUseHook.js';
export { createSessionEndHook } from './sessionEndHook.js';
```

---

## Hook 0: SessionStart - 用户画像注入（上下文初始化）

### 功能概述

在会话开始时，**主动从 Graphiti 检索用户相关信息**，构建"用户画像"并注入到 Claude 的上下文中。

**目标**：让 AI 在对话开始前就对用户有全面了解，实现更个性化、更有效的沟通。

### 触发时机说明（AgentStudio 特定）

AgentStudio 使用 **Streaming Input Mode**，会话管理机制如下：

```
用户在对话窗口发消息
        ↓
handleSessionManagement()
        ↓
   有现有 ClaudeSession?
      /        \
    是          否
     |           |
复用 session   创建新 ClaudeSession
(通过 messageQueue  (调用 query())
 推送消息)            |
     |               ↓
     |         SessionStart 触发 ✅
     ↓               |
SessionStart       用户画像注入
**不触发** ❌
```

**SessionStart 触发场景：**

| 场景 | 是否触发 | 说明 |
|------|----------|------|
| 新建对话窗口 | ✅ 触发 | 创建新 ClaudeSession |
| 同一对话窗口后续消息 | ❌ 不触发 | 复用现有 ClaudeSession |
| 配置变化（model、MCP 等） | ✅ 触发 | 重建 ClaudeSession |
| 会话超时后重连 | ✅ 触发 | 创建新 ClaudeSession |
| 刷新页面重新进入 | ✅ 触发 | 重新建立连接 |

**关键结论：**
- 同一个对话窗口只创建一次 `ClaudeSession`
- 后续消息通过 `messageQueue` 推送，不重新调用 `query()`
- **SessionStart Hook 只在首次创建 session 时触发**
- 用户画像查询**不会**在每条消息时重复执行

**源码参考：**
- `backend/src/services/claudeSession.ts:120-150` - Streaming Input Mode 实现
- `backend/src/utils/sessionUtils.ts:34-100` - handleSessionManagement 逻辑
- `backend/src/services/sessionManager.ts` - ClaudeSession 缓存管理

### 用户画像维度

| 维度 | 说明 | 示例 |
|------|------|------|
| **基本信息** | 姓名、职业、位置等 | "用户叫张三，是北京的前端工程师" |
| **偏好设置** | 编码风格、语言偏好、工作习惯 | "偏好 TypeScript、喜欢函数式编程" |
| **重要事项** | 需要记住的关键信息 | "项目截止日期是下周五" |
| **未完成任务** | 上次会话的待办事项 | "上次讨论的 API 重构还未完成" |
| **关注领域** | 用户感兴趣的技术/话题 | "关注 AI、React、系统设计" |
| **沟通偏好** | 交流方式偏好 | "喜欢简洁回答、需要代码示例" |

### 注入效果示例

```markdown
## 用户画像

**基本信息**
- 姓名：张三
- 职业：前端工程师
- 常用技术栈：React, TypeScript, Node.js

**偏好设置**
- 编码风格：函数式编程、优先使用 hooks
- 语言偏好：中文交流、英文注释
- 回答风格：简洁、带代码示例

**近期关注**
- 正在学习 AI Agent 开发
- 关注 Claude Agent SDK 的新特性

**未完成事项**
- AgentStudio 的 Graphiti 集成还在进行中
- 上次讨论的性能优化方案待验证

请根据以上信息提供个性化的帮助。
```

### SDK 类型定义

```typescript
// SDK 实际类型 (来自 @anthropic-ai/claude-agent-sdk@0.2.29)
type SessionStartHookInput = BaseHookInput & {
  hook_event_name: 'SessionStart';
  source?: string;        // 会话来源
  agent_type?: string;    // 代理类型
  model?: string;         // 使用的模型
};

// Hook 返回类型 - 可通过 additionalContext 注入上下文
type HookJSONOutput = {
  continue: boolean;
  additionalContext?: string;  // 注入到 Claude 上下文的内容
};
```

### Graphiti 搜索策略

**分类搜索**：针对不同维度使用不同的搜索查询，然后合并结果

```typescript
const PROFILE_QUERIES = [
  { category: '基本信息', query: '用户 姓名 职业 位置 身份' },
  { category: '偏好设置', query: '用户 偏好 喜欢 习惯 风格' },
  { category: '技术栈', query: '用户 技术 编程语言 框架 工具' },
  { category: '未完成事项', query: '待办 未完成 进行中 下次 继续' },
  { category: '关注领域', query: '关注 学习 感兴趣 研究' },
];
```

### 实现

```typescript
// hooks/sessionStartHook.ts
import type {
  SessionStartHookInput,
  HookJSONOutput
} from '@anthropic-ai/claude-agent-sdk';
import type { GraphitiContext } from '../types.js';
import type { GraphitiHooksConfig } from './types.js';

/** 用户画像搜索维度 */
const PROFILE_QUERIES = [
  { category: '基本信息', query: '用户 姓名 职业 身份 个人信息' },
  { category: '偏好设置', query: '用户 偏好 喜欢 习惯 风格 不喜欢' },
  { category: '技术能力', query: '用户 技术栈 编程 框架 工具 擅长' },
  { category: '未完成事项', query: '待办 未完成 进行中 下次继续 TODO' },
  { category: '关注领域', query: '关注 学习 感兴趣 正在研究' },
];

/** 默认超时时间 (毫秒) */
const DEFAULT_TIMEOUT_MS = 5000;

/** 每个维度最大结果数 */
const MAX_FACTS_PER_CATEGORY = 3;

interface FactResult {
  name: string;
  fact: string;
  valid_at: string | null;
}

interface SearchResults {
  facts: FactResult[];
}

/**
 * 从 Graphiti 搜索用户画像
 */
async function searchUserProfile(
  context: GraphitiContext,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Map<string, string[]>> {
  const { base_url, user_id, group_ids = [], api_key } = context;
  const allGroupIds = [`user_${user_id}`, ...group_ids];

  const profile = new Map<string, string[]>();

  // 并行搜索所有维度
  const searchPromises = PROFILE_QUERIES.map(async ({ category, query }) => {
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
          max_facts: MAX_FACTS_PER_CATEGORY,
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        const data: SearchResults = await response.json();
        const facts = data.facts?.map(f => f.fact).filter(Boolean) || [];
        if (facts.length > 0) {
          profile.set(category, facts);
        }
      }
    } catch (error) {
      // 单个搜索失败不影响整体
      console.warn(`[Graphiti] Profile search failed for "${category}":`, error);
    } finally {
      clearTimeout(timeoutId);
    }
  });

  await Promise.all(searchPromises);

  return profile;
}

/**
 * 将用户画像格式化为 Markdown
 */
function formatUserProfile(profile: Map<string, string[]>): string {
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
 */
export function createSessionStartHook(
  context: GraphitiContext,
  config: GraphitiHooksConfig
) {
  const timeoutMs = config.sessionStartTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (
    input: SessionStartHookInput,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {
    console.log('🚀 [Graphiti Hook] Session started, building user profile...');

    try {
      // 从 Graphiti 搜索用户画像
      const profile = await searchUserProfile(context, timeoutMs);

      if (profile.size === 0) {
        console.log('📭 [Graphiti Hook] No user profile found');
        return { continue: true };
      }

      // 格式化为 Markdown
      const additionalContext = formatUserProfile(profile);

      console.log(`✅ [Graphiti Hook] User profile injected (${profile.size} categories)`);

      // 通过 additionalContext 注入到 Claude 上下文
      return {
        continue: true,
        additionalContext,
      };

    } catch (error) {
      console.error('❌ [Graphiti Hook] Failed to build user profile:', error);
      // 失败不阻塞会话
      return { continue: true };
    }
  };
}
```

### 配置选项扩展

```typescript
// hooks/types.ts 新增配置
export interface GraphitiHooksConfig {
  // ... 现有配置 ...

  /** 启用 SessionStart hook (默认: true) */
  enableSessionStartHook?: boolean;

  /** SessionStart 搜索超时时间 (默认: 5000ms) */
  sessionStartTimeoutMs?: number;

  /** 自定义用户画像搜索维度 */
  profileQueries?: Array<{ category: string; query: string }>;
}
```

### hooks/index.ts 更新

```typescript
// 在 createGraphitiHooks 中添加 SessionStart hook
import { createSessionStartHook } from './sessionStartHook.js';

export function createGraphitiHooks(
  context: GraphitiContext,
  config: GraphitiHooksConfig = {}
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

  // SessionStart - 用户画像注入
  if (mergedConfig.enableSessionStartHook !== false) {
    const hookCallback = createSessionStartHook(context, mergedConfig);
    hooks.SessionStart = [{ hooks: [hookCallback] }];
  }

  // UserPromptSubmit - 记忆关键词捕获
  if (mergedConfig.enableUserPromptHook !== false) {
    // ... existing code ...
  }

  // ... 其他 hooks ...

  return hooks;
}
```

### 性能考虑

| 方面 | 设计决策 |
|------|----------|
| **并行搜索** | 5 个维度并行请求，总耗时 ≈ 单次请求时间 |
| **超时控制** | 默认 5 秒，超时不阻塞会话 |
| **结果限制** | 每个维度最多 3 条，总共最多 15 条 |
| **失败降级** | 任何错误都不阻塞会话，只是没有画像注入 |

### 用户画像更新机制

用户画像的数据来源于其他 Hook 写入的内容：

```
SessionStart (读)  ←─────────────────────────────┐
    │                                           │
    ↓                                           │
  会话进行中                                     │
    │                                           │
    ↓                                           │
UserPromptSubmit (写) → "记住我喜欢简洁的回答"    │
PostToolUse (写)      → "创建了 React 组件"      │
SessionEnd (写)       → "对话摘要..."            │
    │                                           │
    ↓                                           │
  Graphiti LLM 处理                             │
    │                                           │
    ↓                                           │
  图数据库更新                                   │
    │                                           │
    └───────────────────────────────────────────┘
                    (下次会话时可检索到)
```

---

## Hook 1: UserPromptSubmit

### 功能
捕获用户显式记忆请求（如"记住..."）并写入 Graphiti。

### SDK 类型定义

```typescript
// SDK 实际类型 (来自 @anthropic-ai/claude-agent-sdk@0.2.29)
type UserPromptSubmitHookInput = BaseHookInput & {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;  // 注意：是 prompt，不是 user_prompt
};

type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### 实现

```typescript
// hooks/userPromptHook.ts
import type {
  UserPromptSubmitHookInput,
  HookJSONOutput
} from '@anthropic-ai/claude-agent-sdk';
import type { GraphitiContext } from '../types.js';
import { sendToGraphiti } from './graphitiClient.js';

const MEMORY_KEYWORDS = {
  zh: ['记住', '记下', '别忘了', '我喜欢', '我不喜欢', '我偏好', '我的名字是', '我叫'],
  en: ['remember', "don't forget", 'i prefer', 'i like', "i don't like", 'my name is']
};

// 按 session_id 分组的已处理 prompts (避免不同用户互相影响)
const processedUserPromptsBySession = new Map<string, Set<string>>();

export function markUserPromptAsProcessed(sessionId: string, prompt: string): void {
  if (!processedUserPromptsBySession.has(sessionId)) {
    processedUserPromptsBySession.set(sessionId, new Set());
  }
  processedUserPromptsBySession.get(sessionId)!.add(prompt.slice(0, 100));
}

export function getProcessedUserPrompts(sessionId: string): Set<string> {
  return processedUserPromptsBySession.get(sessionId) || new Set();
}

export function clearProcessedUserPrompts(sessionId: string): void {
  processedUserPromptsBySession.delete(sessionId);
}

function containsMemoryKeyword(text: string): boolean {
  const lowerText = text.toLowerCase();
  for (const keywords of Object.values(MEMORY_KEYWORDS)) {
    if (keywords.some(kw => lowerText.includes(kw))) {
      return true;
    }
  }
  return false;
}

export function createUserPromptHook(context: GraphitiContext) {
  return async (
    input: UserPromptSubmitHookInput,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {
    // SDK 中字段名是 prompt，不是 user_prompt
    if (!containsMemoryKeyword(input.prompt)) {
      return { continue: true };
    }

    console.log('📝 [Graphiti Hook] Memory keyword detected, saving...');

    // 标记为已处理 (用于 SessionEnd 去重，按 session_id 隔离)
    markUserPromptAsProcessed(input.session_id, input.prompt);

    await sendToGraphiti(context, {
      content: input.prompt,
      role_type: 'user',
      role: 'user',
      source_description: `session:${input.session_id}:user_prompt`
    });

    return { continue: true };
  };
}
```

---

## Hook 2: PostToolUse

### 功能
记录重要工具执行结果（如文件创建、配置修改）。

### SDK 类型定义

```typescript
// SDK 实际类型 (来自 @anthropic-ai/claude-agent-sdk@0.2.29)
type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;  // 注意：是 tool_response，不是 tool_result
  tool_use_id: string;
};
```

### 实现

```typescript
// hooks/postToolUseHook.ts
import type {
  PostToolUseHookInput,
  HookJSONOutput
} from '@anthropic-ai/claude-agent-sdk';
import type { GraphitiContext } from '../types.js';
import { sendToGraphiti } from './graphitiClient.js';

// 需要记录的重要工具 (白名单)
const IMPORTANT_TOOLS = [
  'Write',           // 文件创建
  'Edit',            // 文件编辑
  'NotebookEdit',    // Notebook 编辑
  // 'Bash',         // 命令执行 - 可选，可能太多噪音
];

export function createPostToolUseHook(context: GraphitiContext) {
  return async (
    input: PostToolUseHookInput,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {
    // 只记录白名单中的重要工具 (移除了多余的 SKIP_TOOLS 逻辑)
    if (!IMPORTANT_TOOLS.includes(input.tool_name)) {
      return { continue: true };
    }

    console.log('🔧 [Graphiti Hook] Recording tool result:', input.tool_name);

    const content = formatToolResult(input);

    await sendToGraphiti(context, {
      content,
      role_type: 'assistant',
      role: 'assistant',
      source_description: `session:${input.session_id}:tool:${input.tool_name}`
    });

    return { continue: true };
  };
}

function formatToolResult(input: PostToolUseHookInput): string {
  const { tool_name, tool_input } = input;
  const toolInput = tool_input as Record<string, unknown>;

  switch (tool_name) {
    case 'Write':
      return `创建文件: ${toolInput.file_path}`;
    case 'Edit':
      return `编辑文件: ${toolInput.file_path}`;
    case 'Bash':
      return `执行命令: ${toolInput.command}\n结果: ${truncate(String(input.tool_response), 500)}`;
    default:
      return `工具 ${tool_name}: ${truncate(JSON.stringify(input.tool_response), 500)}`;
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
}
```

---

## Hook 3: SessionEnd

### 功能
会话结束时，解析完整对话记录并写入 Graphiti。

### claude-mem 参考实现

**文件**: `d:/workspace/claude-mem/src/shared/transcript-parser.ts`

```typescript
// 完整的 transcript 解析实现 (来自 claude-mem)
import { readFileSync, existsSync } from 'fs';

/**
 * Extract last message of specified role from transcript JSONL file
 * @param transcriptPath Path to transcript file
 * @param role 'user' or 'assistant'
 * @param stripSystemReminders Whether to remove <system-reminder> tags
 */
export function extractLastMessage(
  transcriptPath: string,
  role: 'user' | 'assistant',
  stripSystemReminders: boolean = false
): string {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    throw new Error(`Transcript path missing or file does not exist: ${transcriptPath}`);
  }

  const content = readFileSync(transcriptPath, 'utf-8').trim();
  if (!content) {
    throw new Error(`Transcript file exists but is empty: ${transcriptPath}`);
  }

  const lines = content.split('\n');
  let foundMatchingRole = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = JSON.parse(lines[i]);
    if (line.type === role) {
      foundMatchingRole = true;

      if (line.message?.content) {
        let text = '';
        const msgContent = line.message.content;

        if (typeof msgContent === 'string') {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          text = msgContent
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        } else {
          throw new Error(`Unknown message content format in transcript`);
        }

        if (stripSystemReminders) {
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
          text = text.replace(/\n{3,}/g, '\n\n').trim();
        }

        return text;
      }
    }
  }

  if (!foundMatchingRole) {
    throw new Error(`No message found for role '${role}' in transcript`);
  }

  return '';
}
```

**文件**: `d:/workspace/claude-mem/src/hooks/summary-hook.ts`

```typescript
// SessionEnd Hook 入口 (来自 claude-mem)
export interface StopInput {
  session_id: string;
  cwd: string;
  transcript_path: string;
}

async function summaryHook(input: StopInput): Promise<void> {
  const { session_id, transcript_path } = input;

  // 从 transcript 提取最后一条助手消息
  const lastAssistantMessage = extractLastMessage(transcript_path, 'assistant', true);

  // 发送到 worker 服务进行处理
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contentSessionId: session_id,
      last_assistant_message: lastAssistantMessage
    })
  });
}
```

### AgentStudio 实现

```typescript
// hooks/sessionEndHook.ts
import { readFileSync, existsSync } from 'fs';
import type {
  SessionEndHookInput,
  HookJSONOutput
} from '@anthropic-ai/claude-agent-sdk';
import type { GraphitiContext } from '../types.js';
import type { GraphitiHooksConfig } from './index.js';
import { sendToGraphiti } from './graphitiClient.js';
import { getProcessedUserPrompts, clearProcessedUserPrompts } from './userPromptHook.js';

interface TranscriptLine {
  type: 'user' | 'assistant';
  message: {
    content: string | Array<{ type: string; text?: string }>;
  };
}

export function createSessionEndHook(
  context: GraphitiContext,
  config: GraphitiHooksConfig
) {
  const maxMessages = config.maxMessagesForSessionEnd ?? 10;

  return async (
    input: SessionEndHookInput,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {
    const { session_id, transcript_path } = input;

    console.log('🏁 [Graphiti Hook] Session ended, processing transcript...');

    try {
      // 获取该 session 已处理的 prompts (用于去重)
      const processedPrompts = getProcessedUserPrompts(session_id);

      // 解析 transcript 获取对话摘要
      const conversationSummary = parseTranscriptForMemory(
        transcript_path,
        maxMessages,
        processedPrompts
      );

      if (!conversationSummary || conversationSummary.trim().length < 10) {
        console.log('⏭️ [Graphiti Hook] Conversation too short, skipping');
        // 清理该 session 的去重记录
        clearProcessedUserPrompts(session_id);
        return { continue: true };
      }

      await sendToGraphiti(context, {
        content: conversationSummary,
        role_type: 'assistant',
        role: 'assistant',
        source_description: `session:${session_id}:summary`
      });

      console.log('✅ [Graphiti Hook] Session summary saved');

      // 清理该 session 的去重记录 (释放内存)
      clearProcessedUserPrompts(session_id);

    } catch (error) {
      console.error('❌ [Graphiti Hook] Failed to process session:', error);
      // 确保清理
      clearProcessedUserPrompts(session_id);
    }

    return { continue: true };
  };
}

/**
 * 解析 transcript 文件，提取关键对话内容
 *
 * @param transcriptPath - transcript 文件路径
 * @param maxMessages - 最大消息数量
 * @param skipPrompts - 已处理过的 prompt 集合 (用于去重)
 *
 * 参考: claude-mem/src/shared/transcript-parser.ts
 */
function parseTranscriptForMemory(
  transcriptPath: string,
  maxMessages: number,
  skipPrompts: Set<string>
): string {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    console.warn('[Graphiti] Transcript file not found:', transcriptPath);
    return '';
  }

  const content = readFileSync(transcriptPath, 'utf-8').trim();
  if (!content) {
    return '';
  }

  const lines = content.split('\n');
  const messages: string[] = [];

  for (const line of lines) {
    try {
      const parsed: TranscriptLine = JSON.parse(line);
      const text = extractTextFromMessage(parsed);

      if (!text) continue;

      // 跳过已通过 UserPromptSubmit 处理的消息 (去重)
      if (parsed.type === 'user' && skipPrompts.has(text.slice(0, 100))) {
        continue;
      }

      const prefix = parsed.type === 'user' ? 'User' : 'Assistant';
      messages.push(`${prefix}: ${text}`);
    } catch {
      // 跳过无法解析的行
    }
  }

  // 限制消息数量，取最近的 N 条
  const recentMessages = messages.slice(-maxMessages);

  return recentMessages.join('\n\n');
}

/**
 * 从 transcript message 中提取文本内容
 *
 * content 可能是 string 或 array 格式
 */
function extractTextFromMessage(line: TranscriptLine): string {
  const msgContent = line.message?.content;

  if (!msgContent) {
    return '';
  }

  let text = '';

  if (typeof msgContent === 'string') {
    text = msgContent;
  } else if (Array.isArray(msgContent)) {
    text = msgContent
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n');
  }

  // 移除 system-reminder 标签
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // 截断过长内容
  if (text.length > 1000) {
    text = text.slice(0, 1000) + '...';
  }

  return text;
}
```

---

## Graphiti API 客户端

```typescript
// hooks/graphitiClient.ts
import type { GraphitiContext } from '../types.js';

/** 默认超时时间 (毫秒) */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Graphiti Message 接口
 *
 * 对应 Graphiti 服务端 DTO:
 * - 文件: D:\workspace\graphiti\server\graph_service\dto\common.py
 * - 行号: 13-28
 */
interface GraphitiMessage {
  content: string;
  role_type: 'user' | 'assistant' | 'system';
  role: string | null;  // 可选，用户名或机器人名
  source_description?: string;
  // 以下为可选字段（有默认值）
  uuid?: string;        // 消息唯一 ID，默认由服务端生成
  name?: string;        // episodic node 名称，默认为空
  timestamp?: string;   // ISO 8601 时间戳，默认为当前时间
}

/**
 * 发送消息到 Graphiti Memory API (带超时)
 *
 * API 端点: POST /messages
 * 状态码: 202 Accepted (异步处理)
 *
 * 来源: D:\workspace\graphiti\server\graph_service\routers\ingest.py:15-36
 *
 * Graphiti 内部会自动进行:
 * - 实体提取 (extract_nodes)
 * - 实体去重 (resolve_extracted_nodes)
 * - 关系提取 (extract_edges)
 * - 关系去重 (resolve_extracted_edges)
 * - 属性提取 (extract_attributes)
 * - 摘要生成 (extract_summary)
 *
 * @param context - Graphiti 上下文
 * @param message - 要保存的消息
 * @param timeoutMs - 超时时间 (默认 5000ms)
 */
export async function sendToGraphiti(
  context: GraphitiContext,
  message: GraphitiMessage,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<void> {
  const { base_url, user_id, api_key } = context;
  const group_id = `user_${user_id}`;

  // 创建 AbortController 用于超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    console.warn(`⏱️ [Graphiti] Request timeout after ${timeoutMs}ms`);
  }, timeoutMs);

  try {
    const response = await fetch(`${base_url}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(api_key ? { 'Authorization': `Bearer ${api_key}` } : {}),
      },
      body: JSON.stringify({
        group_id,
        messages: [{
          content: message.content,
          role_type: message.role_type,
          role: message.role || null,  // 注意: 可以为 null
          source_description: message.source_description || 'agentstudio_hook',
        }],
      }),
      signal: controller.signal,  // 传入 abort signal
    });

    // 注意: Graphiti /messages 端点返回 202 Accepted (异步处理)
    // response.ok 包含 200-299，所以 202 也会通过
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Graphiti API error: ${response.status} - ${errorText}`);
    }

    console.log('✅ [Graphiti] Message saved to memory');
  } catch (error) {
    // 区分超时错误和其他错误
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('❌ [Graphiti] Request aborted (timeout)');
    } else {
      console.error('❌ [Graphiti] Failed to save message:', error);
    }
    // 不抛出错误，避免影响主流程
  } finally {
    // 清理 timeout，避免内存泄漏
    clearTimeout(timeoutId);
  }
}
```

---

## 闭包机制详解：如何在 Hook 中获取 GraphitiContext

### 问题背景

SDK Hook 回调函数签名是固定的：
```typescript
type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

**问题**: Hook 回调只接收 `input`、`toolUseID`、`options` 三个参数，没有 `GraphitiContext`。

**解决方案**: 使用 **闭包 (Closure)** 在创建 Hook 时捕获 context。

### 闭包原理图解

```
┌─────────────────────────────────────────────────────────────────────┐
│  claudeUtils.ts - buildQueryOptions()                               │
│                                                                     │
│  1. 从 extendedOptions 获取 graphitiContext                         │
│     const graphitiContext = extendedOptions?.graphitiContext;       │
│                                                                     │
│  2. 调用工厂函数，传入 context                                       │
│     const hooks = createGraphitiHooks(graphitiContext);             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  hooks/index.ts - createGraphitiHooks(context)                      │
│                                                                     │
│  3. 工厂函数内部调用各 Hook 创建函数                                  │
│     createUserPromptHook(context)  ← context 传入                   │
│     createPostToolUseHook(context) ← context 传入                   │
│     createSessionEndHook(context)  ← context 传入                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  hooks/userPromptHook.ts - createUserPromptHook(context)            │
│                                                                     │
│  4. 创建函数返回一个闭包函数                                          │
│                                                                     │
│     export function createUserPromptHook(context: GraphitiContext) {│
│       // context 被闭包捕获 ↓                                        │
│       return async (input, toolUseID, options) => {                 │
│         // 这里可以访问 context！                                    │
│         await sendToGraphiti(context, { ... });                     │
│       };                                                            │
│     }                                                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SDK 调用 Hook                                                      │
│                                                                     │
│  5. 当事件触发时，SDK 调用 Hook 回调                                  │
│     hookCallback(input, toolUseID, options)                         │
│                                                                     │
│  6. 闭包函数执行时，仍然可以访问之前捕获的 context                     │
│     await sendToGraphiti(context, { ... }); // context 仍然可用！   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 代码详解

#### 步骤 1: a2a.ts 提取 GraphitiContext

```typescript
// backend/src/routes/a2a.ts

// 从请求 context 中提取 Graphiti 配置
const graphitiContext = context?.graphiti as GraphitiContext | undefined;

// 传递给 buildQueryOptions
const queryOptions = await buildQueryOptions(
  agent,
  systemPrompt,
  // ... other params
  (weknoraContext || graphitiContext)
    ? {
        ...(weknoraContext ? { weknoraContext } : {}),
        ...(graphitiContext ? { graphitiContext } : {}),  // ← 传入
      }
    : undefined
);
```

#### 步骤 2: claudeUtils.ts 创建 Hooks

```typescript
// backend/src/utils/claudeUtils.ts

import { createGraphitiHooks } from '../services/graphiti/hooks/index.js';
import type { GraphitiContext } from '../services/graphiti/types.js';

export interface BuildQueryExtendedOptions {
  weknoraContext?: WeknoraContext;
  graphitiContext?: GraphitiContext;  // ← 新增
}

export async function buildQueryOptions(
  agent: Agent,
  systemPrompt: string,
  // ... other params
  extendedOptions?: BuildQueryExtendedOptions
): Promise<QueryOptions> {
  const queryOptions: QueryOptions = { /* ... */ };

  // 获取 GraphitiContext
  const graphitiContext = extendedOptions?.graphitiContext;

  if (graphitiContext?.base_url && graphitiContext?.user_id) {
    // 集成 MCP Server (用于搜索)
    await integrateGraphitiMcpServer(queryOptions, graphitiContext);

    // 创建 Hooks (用于自动写入)
    // ↓↓↓ 这里 graphitiContext 通过闭包被捕获 ↓↓↓
    const graphitiHooks = createGraphitiHooks(graphitiContext);

    // 合并到 queryOptions.hooks
    queryOptions.hooks = {
      ...queryOptions.hooks,
      ...graphitiHooks,
    };

    console.log('✅ [Graphiti] Memory hooks registered');
  }

  return queryOptions;
}
```

#### 步骤 3: 工厂函数创建闭包

```typescript
// hooks/index.ts

export function createGraphitiHooks(
  context: GraphitiContext,  // ← 外部传入的 context
  config: GraphitiHooksConfig = DEFAULT_CONFIG
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {

  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

  if (config.enableUserPromptHook) {
    // createUserPromptHook 返回一个闭包，捕获了 context
    const hookCallback = createUserPromptHook(context);
    hooks.UserPromptSubmit = [{ hooks: [hookCallback] }];
  }

  if (config.enablePostToolUseHook) {
    const hookCallback = createPostToolUseHook(context);
    hooks.PostToolUse = [{ hooks: [hookCallback] }];
  }

  if (config.enableSessionEndHook) {
    const hookCallback = createSessionEndHook(context, config);
    hooks.SessionEnd = [{ hooks: [hookCallback] }];
  }

  return hooks;
}
```

#### 步骤 4: Hook 创建函数返回闭包

```typescript
// hooks/userPromptHook.ts

export function createUserPromptHook(context: GraphitiContext) {
  // ┌─────────────────────────────────────────────────┐
  // │  context 在这里被闭包捕获                        │
  // │  即使 createUserPromptHook 函数执行完毕，        │
  // │  返回的函数仍然可以访问 context                  │
  // └─────────────────────────────────────────────────┘

  return async (
    input: UserPromptSubmitHookInput,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {

    if (!containsMemoryKeyword(input.prompt)) {
      return { continue: true };
    }

    // ↓↓↓ 这里使用闭包捕获的 context ↓↓↓
    await sendToGraphiti(context, {
      content: input.prompt,
      role_type: 'user',
      role: 'user',
      source_description: `session:${input.session_id}:user_prompt`
    });

    return { continue: true };
  };
}
```

### 闭包捕获的变量

每个 Hook 闭包捕获以下变量：

| Hook | 捕获的变量 |
|------|-----------|
| UserPromptSubmit | `context: GraphitiContext` |
| PostToolUse | `context: GraphitiContext` |
| SessionEnd | `context: GraphitiContext`, `config: GraphitiHooksConfig` |

### 生命周期

```
时间线
──────────────────────────────────────────────────────────────────►

T1: buildQueryOptions() 调用
    │
    ├── graphitiContext 从 extendedOptions 获取
    │
    ├── createGraphitiHooks(graphitiContext) 调用
    │   │
    │   ├── createUserPromptHook(context) 调用
    │   │   └── 返回闭包函数 (捕获 context)
    │   │
    │   ├── createPostToolUseHook(context) 调用
    │   │   └── 返回闭包函数 (捕获 context)
    │   │
    │   └── createSessionEndHook(context, config) 调用
    │       └── 返回闭包函数 (捕获 context, config)
    │
    └── queryOptions.hooks = { ... } 设置完成

T2: SDK 开始处理用户消息
    │
    └── (闭包函数已创建，等待事件触发)

T3: 用户发送 "记住我叫张三"
    │
    └── SDK 触发 UserPromptSubmit hook
        │
        └── 闭包函数执行
            │
            ├── input.prompt = "记住我叫张三"
            ├── context = { base_url, user_id, ... }  ← 闭包捕获的
            │
            └── sendToGraphiti(context, { content: input.prompt, ... })

T4: 会话结束
    │
    └── SDK 触发 SessionEnd hook
        │
        └── 闭包函数执行
            │
            ├── input = { session_id, transcript_path, ... }
            ├── context = { ... }  ← 闭包捕获的
            ├── config = { maxMessagesForSessionEnd: 10 }  ← 闭包捕获的
            │
            └── sendToGraphiti(context, { content: summary, ... })
```

### 为什么用闭包而不是全局变量？

| 方案 | 优点 | 缺点 |
|------|------|------|
| **闭包** | 每个会话独立 context；无全局状态污染；类型安全 | 需要工厂函数模式 |
| 全局变量 | 简单 | 多会话共享状态；难以测试；类型不安全 |
| Hook input 传递 | 最直接 | SDK 不支持自定义参数 |

**结论**: 闭包是最佳方案，因为：
1. 每次 `buildQueryOptions` 调用都创建独立的闭包
2. 不同用户/会话有不同的 `graphitiContext`
3. 闭包保证了 context 的隔离性

### 验证结论 (基于 AgentStudio 源码分析)

**已验证** (2026-02-02):

**项目路径**: `D:\workspace\agentstudio`

1. **闭包机制可以正确实现** ✅
   - `backend/src/routes/a2a.ts` 第 273 行: 每个请求从 `context.graphiti` 提取 `graphitiContext`
   - `backend/src/utils/claudeUtils.ts` 第 455-467 行: 传入 `buildQueryOptions` 的 `extendedOptions.graphitiContext`
   - `backend/src/services/graphiti/graphitiIntegration.ts` 第 89-90 行: `createGraphitiSdkMcpServer(context)` 使用闭包捕获

2. **不同用户不会混乱** ✅
   - 每个 HTTP 请求调用 `buildQueryOptions()` 创建新的 `queryOptions` 对象
   - `graphitiContext.user_id` 通过闭包被捕获，与其他请求隔离
   - SDK `query()` 函数使用传入的 `options`，不与其他请求共享

**调用链验证** (带完整文件路径):
```
backend/src/routes/a2a.ts:273     → const graphitiContext = context?.graphiti
backend/src/routes/a2a.ts:322-326 → buildQueryOptions(..., { graphitiContext })
backend/src/utils/claudeUtils.ts:455   → const weknoraContext = extendedOptions?.weknoraContext
backend/src/utils/claudeUtils.ts:462   → const graphitiContext = extendedOptions?.graphitiContext
backend/src/utils/claudeUtils.ts:464   → integrateGraphitiMcpServer(queryOptions, graphitiContext)
backend/src/services/graphiti/graphitiIntegration.ts:89 → createGraphitiSdkMcpServer(context)  // 闭包捕获
```

---

## claudeUtils.ts 集成

```typescript
// 在 buildQueryOptions 函数中添加

import { createGraphitiHooks } from '../services/graphiti/hooks/index.js';

// ... existing code ...

// Integrate Graphiti Memory Hooks (when context is provided)
const graphitiContext = extendedOptions?.graphitiContext;
if (graphitiContext?.base_url && graphitiContext?.user_id) {
  // 集成 MCP Server (已实现)
  await integrateGraphitiMcpServer(queryOptions, graphitiContext);

  // 集成 Hooks (新增)
  const graphitiHooks = createGraphitiHooks(graphitiContext);
  queryOptions.hooks = {
    ...queryOptions.hooks,
    ...graphitiHooks,
  };

  console.log('✅ [Graphiti] Memory hooks registered');
}
```

---

## 配置选项

```typescript
interface GraphitiHooksConfig {
  /** 启用 UserPromptSubmit hook (默认: true) */
  enableUserPromptHook?: boolean;

  /** 启用 PostToolUse hook (默认: true) */
  enablePostToolUseHook?: boolean;

  /** 启用 SessionEnd hook (默认: true) */
  enableSessionEndHook?: boolean;

  /** 需要记录的工具列表 (PostToolUse 用) */
  importantTools?: string[];

  /** SessionEnd 时最大消息数量 (默认: 10) */
  maxMessagesForSessionEnd?: number;
}
```

---

## 去重机制

**问题**: 如果用户说 "记住我叫张三"，会触发：
1. **UserPromptSubmit Hook** - 写入一次
2. **SessionEnd Hook** - 可能再写入一次（因为包含在 transcript 中）

**解决方案**: 按 `session_id` 隔离已处理的 prompts

```typescript
// hooks/userPromptHook.ts

// 按 session_id 分组的已处理 prompts (避免不同用户互相影响)
const processedUserPromptsBySession = new Map<string, Set<string>>();

export function markUserPromptAsProcessed(sessionId: string, prompt: string): void {
  if (!processedUserPromptsBySession.has(sessionId)) {
    processedUserPromptsBySession.set(sessionId, new Set());
  }
  // 使用 prompt 前 100 字符作为 key
  processedUserPromptsBySession.get(sessionId)!.add(prompt.slice(0, 100));
}

export function getProcessedUserPrompts(sessionId: string): Set<string> {
  return processedUserPromptsBySession.get(sessionId) || new Set();
}

export function clearProcessedUserPrompts(sessionId: string): void {
  processedUserPromptsBySession.delete(sessionId);
}
```

**为什么不能用全局 Set？**

```
用户 A (session_1): "记住我叫张三"
    ↓
processedUserPrompts.add("记住我叫张三")  // 全局 Set

用户 B (session_2): "记住我叫张三"
    ↓
SessionEnd Hook 解析 transcript
    ↓
skipPrompts.has("记住我叫张三") === true  // ❌ 错误跳过！
```

**正确做法: 按 session_id 隔离**

```
用户 A (session_1): "记住我叫张三"
    ↓
processedUserPromptsBySession.get("session_1").add("记住我叫张三")

用户 B (session_2): "记住我叫张三"
    ↓
SessionEnd Hook: getProcessedUserPrompts("session_2")
    ↓
返回空 Set，不会错误跳过 ✅
```

---

## 测试计划

1. **单元测试**
   - 记忆关键词识别 (`containsMemoryKeyword`)
   - Transcript 解析 (`parseTranscriptForMemory`)
   - 工具过滤逻辑

2. **集成测试**
   - Hook 触发验证
   - Graphiti API 调用验证
   - 错误处理和降级

3. **E2E 测试**
   - 完整对话流程: 用户说"记住我叫张三" → 验证 Graphiti 中有记录
   - 工具执行记录: 创建文件 → 验证 Graphiti 中有记录
   - 会话结束记录: 对话结束 → 验证 Graphiti 中有摘要

---

## 待确认事项

1. ~~**SDK Hooks API**: 确认 AgentStudio SDK 版本支持 hooks~~ ✅ **已确认**
   - SDK 版本: `@anthropic-ai/claude-agent-sdk@0.2.29`
   - Hooks 接口: `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`
   - 支持的 Hook 事件: PreToolUse, PostToolUse, PostToolUseFailure, Notification, UserPromptSubmit, SessionStart, SessionEnd, Stop, SubagentStart, SubagentStop, PreCompact, PermissionRequest, Setup

2. **并发安全**: 多个 Hook 同时触发时的处理
3. **性能监控**: Hook 执行时间对响应的影响
4. **错误隔离**: Hook 失败不应影响主对话流程

---

## 附录: 完整文件清单

### 需要创建的文件 (AgentStudio)

| 文件 | 说明 |
|------|------|
| `backend/src/services/graphiti/hooks/index.ts` | Hook 注册入口，导出 `createGraphitiHooks` |
| `backend/src/services/graphiti/hooks/types.ts` | Hook 配置类型定义 |
| `backend/src/services/graphiti/hooks/userPromptHook.ts` | UserPromptSubmit Hook 实现 |
| `backend/src/services/graphiti/hooks/postToolUseHook.ts` | PostToolUse Hook 实现 |
| `backend/src/services/graphiti/hooks/sessionEndHook.ts` | SessionEnd Hook 实现 |
| `backend/src/services/graphiti/hooks/transcriptParser.ts` | Transcript 解析工具 |
| `backend/src/services/graphiti/hooks/graphitiClient.ts` | Graphiti API 客户端 |

### 需要修改的文件 (AgentStudio)

| 文件 | 修改说明 |
|------|----------|
| `backend/src/utils/claudeUtils.ts` | 添加 `createGraphitiHooks` 调用，集成 hooks 到 queryOptions |

### 已存在的文件 (AgentStudio)

| 文件 | 说明 |
|------|------|
| `backend/src/services/graphiti/types.ts` | GraphitiContext 接口定义 |
| `backend/src/services/graphiti/graphitiIntegration.ts` | MCP Server 集成 (已实现) |
| `backend/src/routes/a2a.ts` | A2A 路由，提取 graphitiContext |

---

## 附录: 引用来源总结

### SDK 类型定义

| 类型 | 文件 | 行号 |
|------|------|------|
| `BaseHookInput` | `sdk.d.ts` | 80-85 |
| `HookCallback` | `sdk.d.ts` | 257-259 |
| `HookCallbackMatcher` | `sdk.d.ts` | 264-269 |
| `Options.hooks` | `sdk.d.ts` | 589 |
| `PostToolUseHookInput` | `sdk.d.ts` | 892-898 |
| `SessionEndHookInput` | `sdk.d.ts` | 1557-1560 |
| `UserPromptSubmitHookInput` | `sdk.d.ts` | 1766-1769 |

**完整路径**: `D:\workspace\agentstudio\backend\node_modules\@anthropic-ai\claude-agent-sdk\sdk.d.ts`

### Graphiti API 定义

| 定义 | 文件 | 行号 |
|------|------|------|
| `Message` DTO | `dto/common.py` | 13-28 |
| `AddMessagesRequest` DTO | `dto/ingest.py` | 6-8 |
| `/messages` 端点 | `routers/ingest.py` | 15-36 |

**项目路径**: `D:\workspace\graphiti\server\graph_service`

### claude-mem 参考实现

| 功能 | 文件 |
|------|------|
| Transcript 解析 | `src/shared/transcript-parser.ts` |
| SessionEnd Hook | `src/hooks/summary-hook.ts` |

**项目路径**: `d:\workspace\claude-mem`

### AgentStudio 调用链

| 步骤 | 文件 | 行号 |
|------|------|------|
| 提取 graphitiContext | `backend/src/routes/a2a.ts` | 273 |
| 传递给 buildQueryOptions | `backend/src/routes/a2a.ts` | 322-326 |
| 获取 graphitiContext | `backend/src/utils/claudeUtils.ts` | 462 |
| 集成 MCP Server | `backend/src/utils/claudeUtils.ts` | 464 |
| 闭包捕获 context | `backend/src/services/graphiti/graphitiIntegration.ts` | 89-90 |

**项目路径**: `D:\workspace\agentstudio`
