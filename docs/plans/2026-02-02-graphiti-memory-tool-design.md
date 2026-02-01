# Graphiti Memory Tool 设计文档

**日期**: 2026-02-02
**状态**: 待实现
**作者**: Claude

## 概述

将 Graphiti REST API (`http://192.168.100.30:8000/search`) 封装为 AgentStudio 的记忆工具，与 WeKnora、AskUserQuestion 工具采用相同的 SDK MCP Server 模式集成。

## 需求

1. 支持用户级别的记忆隔离（通过 `user_id` 自动转换为 `group_id`）
2. 与 WeKnora 采用相同的集成模式
3. 支持可选的额外 `group_ids`（用于共享记忆）

## 设计

### 1. Context 接口定义

**文件**: `backend/src/services/graphiti/types.ts`

```typescript
/**
 * Graphiti Memory Context
 *
 * 与 WeKnora 类似的结构，但针对记忆系统增加了 user_id
 */
export interface GraphitiContext {
  /** Graphiti REST API 地址 */
  base_url: string;           // 例: "http://192.168.100.30:8000"

  /** 用户 ID（必需，用于记忆隔离）*/
  user_id: string;            // 自动转换为 group_id = "user_{user_id}"

  /** 额外的 group_ids（可选，用于共享记忆）*/
  group_ids?: string[];       // 例: ["shared", "project_abc"]

  /** API 认证密钥（可选，当前 Graphiti 无认证）*/
  api_key?: string;
}
```

### 2. Graphiti API 规格（源码验证）

**端点**: `POST /search`

**请求参数** (来自 `server/graph_service/dto/retrieve.py:8-13`):
```typescript
{
  group_ids?: string[] | null,  // 可选，记忆分组 ID 列表
  query: string,                 // 必需，搜索查询文本
  max_facts?: number             // 可选，默认 10，最大返回数量
}
```

**响应格式** (来自 `server/graph_service/dto/retrieve.py:16-30`):
```typescript
{
  facts: Array<{
    uuid: string,               // 事实唯一标识
    name: string,               // 关系类型（如 WORKS_AT, PREFERS）
    fact: string,               // 事实的自然语言描述
    valid_at: string | null,    // ISO 8601，事实生效时间
    invalid_at: string | null,  // ISO 8601，事实失效时间
    created_at: string,         // ISO 8601，记录创建时间
    expired_at: string | null   // ISO 8601，被新信息取代时间
  }>
}
```

### 3. MCP Server 实现

**文件**: `backend/src/services/graphiti/graphitiIntegration.ts`

```typescript
/**
 * Graphiti Memory MCP Server Integration
 *
 * Provides an SDK MCP server for Graphiti memory search.
 * The server is created dynamically with credentials captured via closure.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { GraphitiContext } from './types.js';

// 类型定义（与 Graphiti API 响应对应）
interface FactResult {
  uuid: string;
  name: string;
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
  created_at: string;
  expired_at: string | null;
}

interface SearchResults {
  facts: FactResult[];
}

/**
 * Integrate Graphiti MCP Server into queryOptions
 */
export async function integrateGraphitiMcpServer(
  queryOptions: any,
  context: GraphitiContext
): Promise<void> {
  try {
    const { server } = await createGraphitiSdkMcpServer(context);

    queryOptions.mcpServers = {
      ...queryOptions.mcpServers,
      "graphiti": server
    };

    const toolName = getGraphitiToolName();
    if (!queryOptions.allowedTools) {
      queryOptions.allowedTools = [toolName];
    } else if (!queryOptions.allowedTools.includes(toolName)) {
      queryOptions.allowedTools.push(toolName);
    }
  } catch (error) {
    console.error('❌ [Graphiti] Failed to integrate SDK MCP server:', error);
  }
}

/**
 * Get the full tool name as it appears to Claude
 */
export function getGraphitiToolName(): string {
  return 'mcp__graphiti__graphiti_search_memory';
}

/**
 * Create Graphiti SDK MCP Server
 */
async function createGraphitiSdkMcpServer(context: GraphitiContext) {
  const { base_url, user_id, group_ids = [], api_key } = context;

  // 合并 group_ids：用户专属 + 额外分组
  const allGroupIds = [`user_${user_id}`, ...group_ids];

  const graphitiSearchTool = tool(
    'graphiti_search_memory',
    `Search long-term memory for relevant facts and context.

**When to use:**
- Recall past conversations or user preferences
- Find relevant context before responding
- Look up previously learned information

**Configured memory scope:** User "${user_id}" + ${group_ids.length} shared groups

If results are insufficient, try rephrasing the query or using different keywords.`,

    {
      query: z
        .string()
        .min(1, 'Query cannot be empty')
        .max(1000, 'Query too long (max 1000 characters)')
        .describe('Natural language search query for memory retrieval'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .optional()
        .describe('Maximum number of results (default: 10)'),
    },

    async (args) => {
      const { query, limit = 10 } = args;

      console.log('🧠 [Graphiti] Memory search:', { query, user_id, group_ids: allGroupIds });

      try {
        const response = await fetch(`${base_url}/search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(api_key ? { 'Authorization': `Bearer ${api_key}` } : {}),
          },
          body: JSON.stringify({
            query: query,
            group_ids: allGroupIds,
            max_facts: limit,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ [Graphiti] API error:', response.status, errorText);
          return {
            content: [{ type: 'text', text: `Memory search failed: ${response.status} - ${errorText}` }],
            isError: true,
          };
        }

        const data: SearchResults = await response.json();
        const facts = data.facts || [];

        console.log('✅ [Graphiti] Found', facts.length, 'memories');

        // 格式化输出
        let text = `## Memory Search Results\n\n`;
        text += `**Query:** ${query}\n`;
        text += `**Found:** ${facts.length} relevant memories\n\n`;

        if (facts.length > 0) {
          for (const fact of facts) {
            const validDate = fact.valid_at
              ? new Date(fact.valid_at).toLocaleDateString('zh-CN')
              : null;
            const isExpired = fact.invalid_at !== null || fact.expired_at !== null;

            text += `- **[${fact.name}]** ${fact.fact}`;
            if (validDate) {
              text += ` _(${validDate})_`;
            }
            if (isExpired) {
              text += ` ⚠️已过期`;
            }
            text += `\n`;
          }
        } else {
          text += `_No relevant memories found for this query._\n`;
        }

        return { content: [{ type: 'text', text }] };

      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('❌ [Graphiti] Error:', error);
        return {
          content: [{ type: 'text', text: `Memory search error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  const server = createSdkMcpServer({
    name: 'graphiti',
    version: '1.0.0',
    tools: [graphitiSearchTool],
  });

  return { server, tool: graphitiSearchTool };
}
```

### 4. claudeUtils.ts 集成

**文件**: `backend/src/utils/claudeUtils.ts`

**修改 1 - 添加 import（第 18 行后）:**
```typescript
import { integrateWeKnoraMcpServer, type WeknoraContext } from '../services/weknora/weknoraIntegration.js';
import { integrateGraphitiMcpServer, type GraphitiContext } from '../services/graphiti/graphitiIntegration.js';
```

**修改 2 - 扩展 BuildQueryExtendedOptions（第 203-205 行）:**
```typescript
export interface BuildQueryExtendedOptions {
  weknoraContext?: WeknoraContext;
  graphitiContext?: GraphitiContext;
}
```

**修改 3 - 添加集成逻辑（第 456 行后）:**
```typescript
  // Integrate WeKnora SDK MCP server (only when context is provided and valid)
  const weknoraContext = extendedOptions?.weknoraContext;
  if (weknoraContext?.api_key && weknoraContext?.kb_ids?.length > 0) {
    await integrateWeKnoraMcpServer(queryOptions, weknoraContext);
    console.log('✅ [WeKnora] MCP Server integrated with', weknoraContext.kb_ids.length, 'knowledge bases');
  }

  // Integrate Graphiti Memory SDK MCP server (only when context is provided and valid)
  const graphitiContext = extendedOptions?.graphitiContext;
  if (graphitiContext?.base_url && graphitiContext?.user_id) {
    await integrateGraphitiMcpServer(queryOptions, graphitiContext);
    const groupCount = (graphitiContext.group_ids?.length || 0) + 1;
    console.log('✅ [Graphiti] Memory MCP Server integrated for user', graphitiContext.user_id, 'with', groupCount, 'groups');
  }
```

### 5. a2a.ts Context 提取

**文件**: `backend/src/routes/a2a.ts`

**修改 1 - 添加 Graphiti context 提取（第 270 行后）:**
```typescript
// Extract WeKnora context if present
const weknoraContext = context?.weknora as import('../services/weknora/weknoraIntegration.js').WeknoraContext | undefined;

// Extract Graphiti Memory context if present
const graphitiContext = context?.graphiti as import('../services/graphiti/graphitiIntegration.js').GraphitiContext | undefined;
```

**修改 2 - 修改 buildQueryOptions 调用（第 319 行）:**
```typescript
// 原代码
weknoraContext ? { weknoraContext } : undefined

// 修改为
(weknoraContext || graphitiContext)
  ? {
      ...(weknoraContext ? { weknoraContext } : {}),
      ...(graphitiContext ? { graphitiContext } : {}),
    }
  : undefined
```

### 6. 前端 Context 构建（可选）

如果需要在前端（如 weknora-ui）添加 Graphiti 支持：

**文件**: `src/utils/graphiti.ts`

```typescript
/**
 * Graphiti Memory Configuration Utilities
 */

export interface GraphitiContext {
  base_url: string
  user_id: string
  group_ids?: string[]
  api_key?: string
}

export function getGraphitiBaseUrl(): string {
  return import.meta.env.VITE_GRAPHITI_API_URL || 'http://192.168.100.30:8000'
}

export function getGraphitiUserId(): string | null {
  return localStorage.getItem('user_id')
}

export function buildGraphitiContext(
  groupIds?: string[]
): GraphitiContext | undefined {
  const userId = getGraphitiUserId()

  if (!userId) {
    return undefined
  }

  return {
    base_url: getGraphitiBaseUrl(),
    user_id: userId,
    group_ids: groupIds,
  }
}
```

**使用示例（a2a-chat/index.vue）:**
```typescript
import { buildWeknoraContext } from '@/utils/weknora'
import { buildGraphitiContext } from '@/utils/graphiti'

const weknoraContext = buildWeknoraContext(knowledgeBaseList.value.map(kb => kb.id))
const graphitiContext = buildGraphitiContext()

const requestContext = {
  ...(weknoraContext ? { weknora: weknoraContext } : {}),
  ...(graphitiContext ? { graphiti: graphitiContext } : {}),
}
```

## 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `backend/src/services/graphiti/types.ts` | 新建 | GraphitiContext 接口 |
| `backend/src/services/graphiti/graphitiIntegration.ts` | 新建 | MCP Server 实现 |
| `backend/src/utils/claudeUtils.ts` | 修改 | 添加 import 和集成逻辑 |
| `backend/src/routes/a2a.ts` | 修改 | 提取 graphiti context |
| `frontend/src/utils/graphiti.ts` | 新建（可选） | 前端 context 构建 |

## 验证来源

- Graphiti API 规格：`server/graph_service/dto/retrieve.py`
- WeKnora 集成模式：`backend/src/services/weknora/weknoraIntegration.ts`
- claudeUtils 集成点：`backend/src/utils/claudeUtils.ts:451-456`
- a2a.ts context 提取：`backend/src/routes/a2a.ts:269-320`

## 测试计划

1. 单元测试：验证 `createGraphitiSdkMcpServer` 创建成功
2. 集成测试：通过 A2A API 发送带 graphiti context 的请求
3. E2E 测试：验证 Claude 能正确调用 `graphiti_search_memory` 工具
