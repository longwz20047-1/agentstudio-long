# WeKnora MCP Server 设计文档

## 概述

本文档描述 WeKnora MCP Server 的设计方案，该服务器将 WeKnora 的知识库搜索能力封装为 MCP 工具，使 AgentStudio 中的 Claude Agent 能够调用 WeKnora 进行知识检索。

## 1. 整体架构

### 1.1 架构选择：独立 MCP Server（SDK MCP 进程内模式）

```
┌─────────────────────────────────────────────────────────────────┐
│                        WeKnora-UI                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ @ 选择知识库  │    │  登录获取     │    │   A2A Chat      │  │
│  │   kb_ids     │    │  api_key     │    │   Interface     │  │
│  └──────┬───────┘    └──────┬───────┘    └────────┬─────────┘  │
│         │                   │                      │            │
│         └───────────────────┼──────────────────────┘            │
│                             │                                   │
│                             ▼                                   │
│              POST /a2a/:agentId/messages                        │
│              { message, context: { api_key, kb_ids } }          │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       AgentStudio                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    A2A Routes                             │  │
│  │  1. 接收请求，提取 context                                │  │
│  │  2. buildQueryOptions(context)                            │  │
│  └──────────────────────────┬───────────────────────────────┘  │
│                             │                                   │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              WeKnora SDK MCP Server                       │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │  weknora_search tool                               │  │  │
│  │  │  - 闭包捕获: api_key, kb_ids, weknora_base_url     │  │  │
│  │  │  - 调用 WeKnora /api/v1/knowledge-search           │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────┬───────────────────────────────┘  │
│                             │                                   │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Claude Agent                            │  │
│  │  - 分析用户问题                                           │  │
│  │  - 调用 mcp__weknora__weknora_search                      │  │
│  │  - 根据结果决定是否重试                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     WeKnora Backend                             │
│  POST /api/v1/knowledge-search                                  │
│  - HybridSearch (向量 + 关键词)                                 │
│  - Rerank                                                       │
│  - 返回结构化结果                                               │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 架构模式 | SDK MCP 进程内 | 无需外部进程，部署简单，与 A2A 模式兼容 |
| 认证方式 | 动态参数传递 | 每次调用传入 api_key 和 kb_ids，支持多租户 |
| API 选择 | /knowledge-search | 纯搜索 API，支持 HybridSearch，可控性强 |
| 重试策略 | 结构化反馈 | 返回 total_count 和 suggestion，引导 Claude 智能重试 |

## 2. MCP Tool 定义

### 2.1 工具规范

```typescript
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const weknoraSearchTool = tool(
  'weknora_search',
  `Search knowledge bases for relevant information using hybrid search (vector + keyword).

This tool queries WeKnora knowledge bases to find documents and chunks matching your query.
It supports both semantic understanding and keyword matching for comprehensive results.

**When to use:**
- Answer questions requiring specific knowledge from documents
- Find relevant context for complex topics
- Verify facts against stored knowledge

**Query strategies:**
- Use specific keywords for precise matches
- Use natural language for semantic search
- Combine both for best results

**Response interpretation:**
- High relevance (score > 0.8): Directly relevant content
- Medium relevance (0.5-0.8): Related but may need verification
- Low relevance (< 0.5): Tangentially related

If results are insufficient, consider:
1. Rephrasing with different keywords
2. Breaking complex queries into simpler parts
3. Using more specific terminology from the domain`,

  {
    query: z
      .string()
      .min(1)
      .max(2000)
      .describe('Search query. Can be natural language question or keywords. For best results, include domain-specific terms.'),

    search_mode: z
      .enum(['hybrid', 'vector', 'keyword'])
      .optional()
      .default('hybrid')
      .describe('Search mode: "hybrid" (recommended) combines vector and keyword search, "vector" for semantic similarity, "keyword" for exact matches.'),

    top_k: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe('Maximum number of results to return (1-50). Use smaller values for focused queries, larger for exploratory searches.'),

    min_score: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.5)
      .describe('Minimum relevance score threshold (0-1). Higher values return more relevant but fewer results.'),

    rerank: z
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to apply reranking for improved relevance ordering. Recommended for important queries.'),
  },

  async (args, context) => {
    // Implementation - see section 2.2
  }
);
```

### 2.2 工具实现

```typescript
async (args) => {
  const { query, search_mode, top_k, min_score, rerank } = args;

  // api_key, kb_ids, baseUrl 通过闭包从服务器创建时捕获
  // 这些值来自 A2A context

  try {
    const response = await fetch(`${baseUrl}/api/v1/knowledge-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${api_key}`,
      },
      body: JSON.stringify({
        question: query,
        knowledge_base_ids: kb_ids,
        search_mode: search_mode,
        top_k: top_k,
        min_score: min_score,
        rerank: rerank,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        content: [{
          type: 'text',
          text: `Search failed: ${response.status} - ${error}`
        }],
        isError: true,
      };
    }

    const data = await response.json();
    const results = data.results || [];

    // 构建结构化响应
    const content: any[] = [];

    // 1. 搜索摘要
    content.push({
      type: 'text',
      text: `## Search Results\n\n` +
            `**Query:** ${query}\n` +
            `**Total Found:** ${data.total_count || results.length}\n` +
            `**Returned:** ${results.length}\n` +
            `**Search Mode:** ${search_mode}\n\n`
    });

    // 2. 结果列表
    if (results.length > 0) {
      let resultText = '### Matched Documents\n\n';

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        resultText += `#### [${i + 1}] ${r.knowledge_title || 'Untitled'}\n`;
        resultText += `- **Score:** ${(r.score * 100).toFixed(1)}%\n`;
        resultText += `- **Source:** ${r.knowledge_filename || 'Unknown'}\n`;
        resultText += `- **Match Type:** ${r.match_type || 'hybrid'}\n\n`;
        resultText += `> ${r.content?.substring(0, 500)}${r.content?.length > 500 ? '...' : ''}\n\n`;
      }

      content.push({ type: 'text', text: resultText });
    }

    // 3. 智能建议（当结果不足时）
    if (results.length < 3) {
      let suggestion = '\n### Suggestions for Better Results\n\n';

      if (results.length === 0) {
        suggestion += '- Try different keywords or rephrase your query\n';
        suggestion += '- Use more general terms if query is too specific\n';
        suggestion += '- Check if the topic exists in the knowledge bases\n';
      } else {
        suggestion += '- Consider lowering min_score to get more results\n';
        suggestion += '- Try breaking the query into smaller parts\n';
        suggestion += '- Use "keyword" mode if looking for exact terms\n';
      }

      content.push({ type: 'text', text: suggestion });
    }

    return { content };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Search error: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true,
    };
  }
}
```

## 3. Context 传递机制

### 3.1 数据流

```
┌─────────────────┐
│   WeKnora-UI    │
│                 │
│ 1. 用户登录     │──→ tenant.api_key
│ 2. @ 选择知识库 │──→ kb_ids[]
│ 3. 发送消息     │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│        A2A Request Body                 │
│                                         │
│ {                                       │
│   "message": "用户问题",                │
│   "context": {                          │
│     "api_key": "xxx",                   │
│     "kb_ids": ["kb1", "kb2"],           │
│     "weknora_base_url": "https://..."   │
│   }                                     │
│ }                                       │
└────────┬────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│     AgentStudio A2A Routes              │
│                                         │
│ // a2a.ts                               │
│ const { message, context } = req.body;  │
│                                         │
│ // 传递给 buildQueryOptions             │
│ buildQueryOptions(..., {                │
│   weknoraContext: context               │
│ });                                     │
└────────┬────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│     integrateWeKnoraMcpServer           │
│                                         │
│ // 通过闭包捕获 context                 │
│ const server = createWeKnoraSdkMcp({    │
│   api_key: context.api_key,             │
│   kb_ids: context.kb_ids,               │
│   baseUrl: context.weknora_base_url     │
│ });                                     │
└────────┬────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│     Tool Handler (闭包访问)             │
│                                         │
│ async (args) => {                       │
│   // api_key, kb_ids, baseUrl           │
│   // 来自闭包，不在 args 中             │
│   fetch(`${baseUrl}/api/v1/...`, {      │
│     headers: { Authorization: api_key } │
│   });                                   │
│ }                                       │
└─────────────────────────────────────────┘
```

### 3.2 安全考虑

- `api_key` 不暴露在 system prompt 中
- `api_key` 不作为工具参数，Claude 无法直接访问
- 通过闭包安全传递，仅在 HTTP 请求时使用

## 4. 部署与注册

### 4.1 SDK MCP 进程内模式

**实现位置：** `backend/src/services/weknora/weknoraIntegration.ts`

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

interface WeKnoraContext {
  api_key: string;
  kb_ids: string[];
  weknora_base_url: string;
}

export async function createWeKnoraSdkMcpServer(context: WeKnoraContext) {
  const { api_key, kb_ids, weknora_base_url } = context;

  const weknoraSearchTool = tool(
    'weknora_search',
    // ... description ...
    // ... schema ...
    async (args) => {
      // 闭包访问 api_key, kb_ids, weknora_base_url
      // ... implementation ...
    }
  );

  const server = createSdkMcpServer({
    name: 'weknora',
    version: '1.0.0',
    tools: [weknoraSearchTool],
  });

  return { server, tool: weknoraSearchTool };
}

export function getWeKnoraToolName(): string {
  return 'mcp__weknora__weknora_search';
}
```

### 4.2 集成到 buildQueryOptions

**修改文件：** `backend/src/utils/claudeUtils.ts`

```typescript
import { integrateWeKnoraMcpServer } from '../services/weknora/weknoraIntegration.js';

export async function buildQueryOptions(
  agent: any,
  projectPath?: string,
  // ... other params ...
  weknoraContext?: WeKnoraContext  // 新增参数
): Promise<BuildQueryOptionsResult> {
  // ... existing code ...

  // 集成 WeKnora MCP Server（如果有 context）
  if (weknoraContext?.api_key && weknoraContext?.kb_ids?.length > 0) {
    await integrateWeKnoraMcpServer(queryOptions, weknoraContext);
  }

  return { queryOptions, askUserSessionRef };
}
```

### 4.3 A2A 路由修改

**修改文件：** `backend/src/routes/a2a.ts`

```typescript
// 提取 context
const { message, sessionId, sessionMode, context } = validation.data;

// 传递给 buildQueryOptions
const { queryOptions } = await buildQueryOptions(
  // ... existing params ...
  context?.weknora  // WeKnora specific context
);
```

## 5. 实现计划

### Phase 1: 核心实现

1. 创建 `backend/src/services/weknora/weknoraIntegration.ts`
   - WeKnora SDK MCP Server 创建函数
   - weknora_search 工具定义与实现

2. 修改 `backend/src/utils/claudeUtils.ts`
   - 添加 WeKnora MCP Server 集成逻辑

3. 修改 `backend/src/routes/a2a.ts`
   - 提取并传递 context

### Phase 2: 测试与优化

1. 单元测试
   - 工具参数验证
   - API 调用 mock 测试

2. 集成测试
   - 完整 A2A 流程测试
   - 错误处理测试

3. 性能优化
   - 添加请求超时
   - 结果缓存（可选）

### Phase 3: 扩展功能（未来）

- 支持图谱查询（需 WeKnora 新增 API）
- 支持多轮对话上下文
- 支持搜索结果高亮

## 6. 附录

### 6.1 WeKnora /api/v1/knowledge-search API

**请求：**
```json
{
  "question": "搜索查询",
  "knowledge_base_ids": ["kb1", "kb2"],
  "search_mode": "hybrid",
  "top_k": 10,
  "min_score": 0.5,
  "rerank": true
}
```

**响应：**
```json
{
  "results": [
    {
      "id": "chunk_id",
      "content": "文档内容片段",
      "score": 0.85,
      "knowledge_id": "doc_id",
      "knowledge_title": "文档标题",
      "knowledge_filename": "文件名.pdf",
      "match_type": "hybrid"
    }
  ],
  "total_count": 25
}
```

### 6.2 相关文件引用

- WeKnora 搜索实现: `weknora/internal/application/service/session.go:SearchKnowledge()`
- AgentStudio SDK MCP 参考: `agentstudio/backend/src/services/a2a/a2aSdkMcp.ts`
- AgentStudio MCP 集成: `agentstudio/backend/src/services/a2a/a2aIntegration.ts`
