# WeKnora MCP Server 设计文档

## 概述

本文档描述 WeKnora MCP Server 的完整设计方案，包括 WeKnora-UI 前端修改和 AgentStudio 后端集成。该方案将 WeKnora 的知识库搜索能力封装为 MCP 工具，使 AgentStudio 中的 Claude Agent 能够通过 A2A 协议调用 WeKnora 进行知识检索。

## 1. 整体架构

### 1.1 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        WeKnora-UI                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ @ 选择知识库  │    │  登录获取     │    │   A2A Chat      │  │
│  │ MentionSelector│   │  api_key     │    │   index.vue     │  │
│  └──────┬───────┘    └──────┬───────┘    └────────┬─────────┘  │
│         │                   │                      │            │
│         └───────────────────┼──────────────────────┘            │
│                             │                                   │
│                             ▼                                   │
│     sendMessage(config, { message, context: { weknora: {...} }})│
└─────────────────────────────┼───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       AgentStudio                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  a2a.ts: POST /a2a/{agentId}/messages?stream=true        │  │
│  │  提取 context.weknora → 传递给 buildQueryOptions          │  │
│  └──────────────────────────┬───────────────────────────────┘  │
│                             │                                   │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  claudeUtils.ts: buildQueryOptions(..., extendedOptions) │  │
│  │  集成 WeKnora SDK MCP Server                              │  │
│  └──────────────────────────┬───────────────────────────────┘  │
│                             │                                   │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  weknoraIntegration.ts: createWeKnoraSdkMcpServer        │  │
│  │  weknora_search tool（闭包捕获 api_key, kb_ids, base_url）│  │
│  └──────────────────────────┬───────────────────────────────┘  │
│                             │                                   │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Claude Agent 调用 mcp__weknora__weknora_search          │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     WeKnora Backend                             │
│  POST /api/v1/knowledge-search                                  │
│  Authorization: Bearer ${api_key}                               │
│  Body: { question, knowledge_base_ids, ... }                    │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 架构模式 | SDK MCP 进程内 | 无需外部进程，部署简单，与 A2A 模式兼容 |
| 认证方式 | 动态参数传递（context.weknora） | 每次调用传入 api_key 和 kb_ids，支持多租户 |
| API 选择 | /api/v1/knowledge-search | 纯搜索 API，支持 HybridSearch，可控性强 |
| 参数传递 | 闭包捕获 | 安全，不暴露在 system prompt 中 |
| 兼容性 | extendedOptions 可选参数 | 不影响现有 buildQueryOptions 调用 |

## 2. 数据来源

| 数据 | 来源 | 获取方式 |
|------|------|----------|
| `api_key` | WeKnora 登录时返回 | `authStore.tenant?.api_key` |
| `kb_ids` | 用户通过 @ Mention 选择 | `selectedKnowledgeBases.map(kb => kb.id)` |
| `base_url` | 环境变量 | `import.meta.env.VITE_WEKNORA_API_URL` |

## 3. WeKnora-UI 修改

### 3.1 修改文件清单

```
weknora-ui/
├── .env.development              # 新增
├── .env.production               # 新增
├── src/
│   ├── utils/
│   │   └── weknora.ts            # 新增
│   └── views/
│       └── a2a-chat/
│           └── index.vue         # 修改
```

### 3.2 环境变量配置

**.env.development**
```bash
VITE_WEKNORA_API_URL=http://192.168.100.30:8080
```

**.env.production**
```bash
VITE_WEKNORA_API_URL=https://your-weknora-domain.com
```

### 3.3 工具函数

**src/utils/weknora.ts**
```typescript
/**
 * WeKnora 配置工具函数
 */

export interface WeknoraContext {
  api_key: string
  kb_ids: string[]
  base_url: string
}

/**
 * 获取 WeKnora API 基地址
 */
export function getWeknoraBaseUrl(): string {
  return import.meta.env.VITE_WEKNORA_API_URL || 'http://192.168.100.30:8080'
}

/**
 * 构建 WeKnora Context
 */
export function buildWeknoraContext(
  apiKey: string | undefined,
  kbIds: string[]
): WeknoraContext | undefined {
  if (!apiKey || kbIds.length === 0) {
    return undefined
  }

  return {
    api_key: apiKey,
    kb_ids: kbIds,
    base_url: getWeknoraBaseUrl()
  }
}
```

### 3.4 index.vue 修改

#### 3.4.1 新增导入

```typescript
import { useAuthStore } from '@/stores/auth'
import MentionSelector from '@/components/MentionSelector.vue'
import { listKnowledgeBases } from '@/api/knowledge-base'
import { getCaretCoordinates } from '@/utils/caret'
import { buildWeknoraContext, type WeknoraContext } from '@/utils/weknora'
```

#### 3.4.2 新增状态变量

```typescript
// Auth Store
const authStore = useAuthStore()

// Mention 相关状态
const showMention = ref(false)
const mentionQuery = ref('')
const mentionItems = ref<Array<{ id: string; name: string; type: 'kb' | 'file'; kbType?: 'document' | 'faq'; count?: number }>>([])
const mentionActiveIndex = ref(0)
const mentionStyle = ref<Record<string, string>>({})
const mentionStartPos = ref(0)
const isComposing = ref(false)

// 当前会话选中的知识库
const selectedKnowledgeBases = ref<Array<{ id: string; name: string }>>([])

// 知识库列表缓存
const knowledgeBaseList = ref<Array<{ id: string; name: string; type?: 'document' | 'faq'; knowledge_count?: number }>>([])
```

#### 3.4.3 新增函数

```typescript
// 加载知识库列表
async function loadKnowledgeBases() {
  try {
    const res = await listKnowledgeBases()
    if (res.success && res.data) {
      knowledgeBaseList.value = res.data
    }
  } catch (e) {
    console.error('加载知识库列表失败:', e)
  }
}

// 过滤 mention 选项
function filterMentionItems(query: string) {
  const lowerQuery = query.toLowerCase()
  mentionItems.value = knowledgeBaseList.value
    .filter(kb => kb.name.toLowerCase().includes(lowerQuery))
    .filter(kb => !selectedKnowledgeBases.value.some(s => s.id === kb.id))
    .map(kb => ({
      id: kb.id,
      name: kb.name,
      type: 'kb' as const,
      kbType: kb.type || 'document',
      count: kb.knowledge_count || 0
    }))
    .slice(0, 10)
  mentionActiveIndex.value = 0
}

// 处理 mention 选择
function onMentionSelect(item: { id: string; name: string; type: string }) {
  if (item.type === 'kb') {
    selectedKnowledgeBases.value.push({ id: item.id, name: item.name })
  }

  const textarea = document.querySelector('.rich-input-container textarea') as HTMLTextAreaElement
  if (textarea) {
    const cursor = textarea.selectionStart
    const textBefore = inputText.value.slice(0, mentionStartPos.value)
    const textAfter = inputText.value.slice(cursor)
    inputText.value = textBefore + textAfter

    nextTick(() => {
      textarea.setSelectionRange(mentionStartPos.value, mentionStartPos.value)
      textarea.focus()
    })
  }

  showMention.value = false
}

// 移除已选知识库
function removeKnowledgeBase(id: string) {
  selectedKnowledgeBases.value = selectedKnowledgeBases.value.filter(kb => kb.id !== id)
}

// 处理输入事件（检测 @）
function handleInput(event: Event) {
  if (isComposing.value) return

  const textarea = event.target as HTMLTextAreaElement
  const value = textarea.value
  const cursor = textarea.selectionStart

  const lastAtIndex = value.lastIndexOf('@', cursor - 1)
  if (lastAtIndex !== -1 && (lastAtIndex === 0 || /\s/.test(value[lastAtIndex - 1]))) {
    const query = value.slice(lastAtIndex + 1, cursor)
    if (!/\s/.test(query)) {
      mentionStartPos.value = lastAtIndex
      mentionQuery.value = query
      filterMentionItems(query)

      const coords = getCaretCoordinates(textarea, lastAtIndex)
      const rect = textarea.getBoundingClientRect()
      mentionStyle.value = {
        position: 'fixed',
        left: `${rect.left + coords.left}px`,
        top: `${rect.top + coords.top - 200}px`,
        zIndex: '9999'
      }

      showMention.value = true
      return
    }
  }

  showMention.value = false
}

function handleCompositionStart() {
  isComposing.value = true
}

function handleCompositionEnd() {
  isComposing.value = false
}
```

#### 3.4.4 修改 handleKeydown

```typescript
function handleKeydown(event: KeyboardEvent) {
  // Mention 键盘导航
  if (showMention.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      mentionActiveIndex.value = Math.min(mentionActiveIndex.value + 1, mentionItems.value.length - 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      mentionActiveIndex.value = Math.max(mentionActiveIndex.value - 1, 0)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (mentionItems.value[mentionActiveIndex.value]) {
        onMentionSelect(mentionItems.value[mentionActiveIndex.value])
      }
      return
    }
    if (event.key === 'Escape') {
      showMention.value = false
      return
    }
  }

  // 现有的发送逻辑
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    handleSend()
  }
}
```

#### 3.4.5 修改 handleSend

```typescript
async function handleSend() {
  const text = inputText.value.trim()
  if (!text || !configStore.isValid || isStreaming.value) return

  if (isNewChat.value && !selectedProject.value) {
    MessagePlugin.warning('请先选择项目')
    return
  }

  // ✅ 构建 WeKnora context
  const weknoraContext = buildWeknoraContext(
    authStore.tenant?.api_key,
    selectedKnowledgeBases.value.map(kb => kb.id)
  )
  const requestContext = weknoraContext
    ? { weknora: weknoraContext }
    : undefined

  const projectSnapshot = selectedProject.value
    ? { ...selectedProject.value }
    : null

  const userMessage: A2AChatMessage = {
    id: generateId(),
    role: 'user',
    content: text,
    timestamp: new Date()
  }
  messages.value.push(userMessage)
  inputText.value = ''
  scrollToBottom()

  // ✅ 发送请求时传入 context
  const response = await sendMessage(
    configStore.config,
    {
      message: text,
      context: requestContext
    },
    async (updatedMessage) => {
      // ...现有逻辑
    },
    async (newSessionId) => {
      // ...现有逻辑
    }
  )
}
```

#### 3.4.6 模板修改

```vue
<!-- 输入区域添加已选知识库标签 -->
<div class="rich-input-container">
  <!-- 已选知识库标签 -->
  <div v-if="selectedKnowledgeBases.length > 0" class="selected-kbs">
    <span
      v-for="kb in selectedKnowledgeBases"
      :key="kb.id"
      class="kb-tag"
    >
      <t-icon name="folder" size="14px" />
      {{ kb.name }}
      <t-icon name="close" size="12px" class="remove-btn" @click="removeKnowledgeBase(kb.id)" />
    </span>
  </div>

  <t-textarea
    v-model="inputText"
    placeholder="输入消息，使用 @ 选择知识库，Enter 发送"
    :autosize="false"
    @keydown="handleKeydown"
    @input="handleInput"
    @compositionstart="handleCompositionStart"
    @compositionend="handleCompositionEnd"
  />
  <!-- control-bar -->
</div>

<!-- Mention 弹出层 -->
<Teleport to="body">
  <MentionSelector
    :visible="showMention"
    :style="mentionStyle"
    :items="mentionItems"
    v-model:activeIndex="mentionActiveIndex"
    @select="onMentionSelect"
  />
</Teleport>
```

## 4. AgentStudio 修改

### 4.1 修改文件清单

```
agentstudio/backend/src/
├── routes/
│   └── a2a.ts                    # 修改：提取 context
├── utils/
│   └── claudeUtils.ts            # 修改：添加 extendedOptions 参数
└── services/
    └── weknora/
        └── weknoraIntegration.ts # 新增：WeKnora MCP Server
```

### 4.2 兼容性设计

为不影响现有功能，使用可选的 `extendedOptions` 参数：

| 调用方 | 是否需要修改 | 说明 |
|--------|-------------|------|
| `agents.ts` | ❌ 不需要 | extendedOptions 默认为 undefined |
| `a2a.ts` | ✅ 仅此处修改 | 传入 `{ weknoraContext }` |
| `slackAIService.ts` | ❌ 不需要 | extendedOptions 默认为 undefined |
| `taskWorker.ts` | ❌ 不需要 | extendedOptions 默认为 undefined |

### 4.3 a2a.ts 修改

```typescript
// 第197行：提取 context
const { message, sessionId, sessionMode = 'new', context } = validation.data;

// 第230行：传入 extendedOptions
const { queryOptions } = await buildQueryOptions(
  {
    systemPrompt: agentConfig.systemPrompt || undefined,
    allowedTools: agentConfig.allowedTools || [],
    maxTurns: 30,
    workingDirectory: a2aContext.workingDirectory,
    permissionMode: 'bypassPermissions',
  },
  a2aContext.workingDirectory,
  undefined,
  'bypassPermissions',
  'sonnet',
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  false,
  context?.weknora ? { weknoraContext: context.weknora as WeknoraContext } : undefined
);
```

### 4.4 claudeUtils.ts 修改

```typescript
import { integrateWeKnoraMcpServer, type WeknoraContext } from '../services/weknora/weknoraIntegration.js';

/**
 * 扩展选项接口
 */
export interface BuildQueryExtendedOptions {
  weknoraContext?: WeknoraContext;
}

export async function buildQueryOptions(
  agent: any,
  projectPath?: string,
  mcpTools?: string[],
  permissionMode?: string,
  model?: string,
  claudeVersion?: string,
  defaultEnv?: Record<string, string>,
  userEnv?: Record<string, string>,
  sessionIdForAskUser?: string,
  agentIdForAskUser?: string,
  a2aStreamEnabled?: boolean,
  extendedOptions?: BuildQueryExtendedOptions  // 新增
): Promise<BuildQueryOptionsResult> {

  // ... 现有逻辑 ...

  // 集成 A2A MCP Server
  await integrateA2AMcpServer(queryOptions, currentProjectId, a2aStreamEnabled ?? false);

  // 集成 WeKnora MCP Server（仅当 context 存在且有效时）
  const weknoraContext = extendedOptions?.weknoraContext;
  if (weknoraContext?.api_key && weknoraContext?.kb_ids?.length > 0) {
    await integrateWeKnoraMcpServer(queryOptions, weknoraContext);
    console.log('✅ [WeKnora] MCP Server integrated with', weknoraContext.kb_ids.length, 'knowledge bases');
  }

  return { queryOptions, askUserSessionRef };
}
```

### 4.5 weknoraIntegration.ts（新建）

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface WeknoraContext {
  api_key: string;
  kb_ids: string[];
  base_url: string;
}

/**
 * 集成 WeKnora MCP Server 到 queryOptions
 */
export async function integrateWeKnoraMcpServer(
  queryOptions: any,
  context: WeknoraContext
) {
  const { server } = await createWeKnoraSdkMcpServer(context);

  queryOptions.mcpServers = {
    ...queryOptions.mcpServers,
    "weknora": server
  };

  const toolName = 'mcp__weknora__weknora_search';
  if (!queryOptions.allowedTools) {
    queryOptions.allowedTools = [toolName];
  } else if (!queryOptions.allowedTools.includes(toolName)) {
    queryOptions.allowedTools.push(toolName);
  }
}

/**
 * 创建 WeKnora SDK MCP Server
 */
async function createWeKnoraSdkMcpServer(context: WeknoraContext) {
  const { api_key, kb_ids, base_url } = context;

  const weknoraSearchTool = tool(
    'weknora_search',
    `Search knowledge bases for relevant information using hybrid search (vector + keyword).

This tool queries WeKnora knowledge bases to find documents matching your query.

**When to use:**
- Answer questions requiring specific knowledge from documents
- Find relevant context for complex topics

**Query strategies:**
- Use specific keywords for precise matches
- Use natural language for semantic search

If results are insufficient, consider rephrasing or breaking the query into smaller parts.`,

    {
      query: z
        .string()
        .min(1)
        .max(2000)
        .describe('Search query. Can be natural language or keywords.'),

      search_mode: z
        .enum(['hybrid', 'vector', 'keyword'])
        .optional()
        .default('hybrid')
        .describe('Search mode: hybrid (recommended), vector, or keyword.'),

      top_k: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe('Maximum results to return (1-50).'),

      min_score: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.5)
        .describe('Minimum relevance score (0-1).'),

      rerank: z
        .boolean()
        .optional()
        .default(true)
        .describe('Apply reranking for better relevance.'),
    },

    async (args) => {
      const { query, search_mode, top_k, min_score, rerank } = args;

      try {
        const response = await fetch(`${base_url}/api/v1/knowledge-search`, {
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
            content: [{ type: 'text', text: `Search failed: ${response.status} - ${error}` }],
            isError: true,
          };
        }

        const data = await response.json();
        const results = data.results || [];

        // 构建响应
        let text = `## Search Results\n\n`;
        text += `**Query:** ${query}\n`;
        text += `**Found:** ${results.length} results\n\n`;

        if (results.length > 0) {
          text += '### Matched Documents\n\n';
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            text += `#### [${i + 1}] ${r.knowledge_title || 'Untitled'}\n`;
            text += `- **Score:** ${(r.score * 100).toFixed(1)}%\n`;
            text += `- **Source:** ${r.knowledge_filename || 'Unknown'}\n\n`;
            text += `> ${r.content?.substring(0, 500)}${r.content?.length > 500 ? '...' : ''}\n\n`;
          }
        } else {
          text += 'No results found. Try different keywords or rephrasing your query.\n';
        }

        return { content: [{ type: 'text', text }] };

      } catch (error) {
        return {
          content: [{ type: 'text', text: `Search error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  const server = createSdkMcpServer({
    name: 'weknora',
    version: '1.0.0',
    tools: [weknoraSearchTool],
  });

  return { server, tool: weknoraSearchTool };
}

export function getWeknoraToolName(): string {
  return 'mcp__weknora__weknora_search';
}
```

## 5. 完整数据流

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. WeKnora-UI: 用户选择知识库并发送消息                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  - authStore.tenant?.api_key → 从登录信息获取                               │
│  - selectedKnowledgeBases → 用户通过 @ Mention 选择                         │
│  - getWeknoraBaseUrl() → 从环境变量获取                                     │
│                                                                             │
│  sendMessage(config, {                                                      │
│    message: "用户问题",                                                     │
│    context: {                                                               │
│      weknora: { api_key, kb_ids, base_url }                                │
│    }                                                                        │
│  })                                                                         │
└─────────────────────────────────────────┬───────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. AgentStudio a2a.ts: 提取 context                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  const { message, context } = validation.data;                              │
│  // context.weknora = { api_key, kb_ids, base_url }                        │
└─────────────────────────────────────────┬───────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. AgentStudio claudeUtils.ts: 传递 extendedOptions                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  buildQueryOptions(..., { weknoraContext: context.weknora })               │
└─────────────────────────────────────────┬───────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. AgentStudio weknoraIntegration.ts: 创建 MCP Server                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  createWeKnoraSdkMcpServer(context)                                         │
│  // 闭包捕获: api_key, kb_ids, base_url                                    │
└─────────────────────────────────────────┬───────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. Claude Agent 调用 weknora_search tool                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Tool Handler 通过闭包访问 api_key, kb_ids, base_url                        │
│  调用 WeKnora /api/v1/knowledge-search API                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 6. 实现计划

### Phase 1: WeKnora-UI 修改

1. 创建 `.env.development` 和 `.env.production`
2. 创建 `src/utils/weknora.ts`
3. 修改 `src/views/a2a-chat/index.vue`
   - 添加 Mention 状态和函数
   - 修改 handleSend 传入 context
   - 添加模板和样式

### Phase 2: AgentStudio 修改

1. 修改 `backend/src/routes/a2a.ts` - 提取 context
2. 修改 `backend/src/utils/claudeUtils.ts` - 添加 extendedOptions 参数
3. 创建 `backend/src/services/weknora/weknoraIntegration.ts`

### Phase 3: 测试

1. 单元测试
   - weknoraIntegration.ts 工具定义测试
   - buildQueryOptions 兼容性测试

2. 集成测试
   - A2A 端到端流程测试
   - 知识库搜索结果验证

## 7. 附录

### 7.1 WeKnora /api/v1/knowledge-search API

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

### 7.2 相关文件引用

**WeKnora:**
- 搜索实现: `weknora/internal/application/service/session.go:SearchKnowledge()`
- API Handler: `weknora/internal/handler/session/qa.go:SearchKnowledge()`

**WeKnora-UI:**
- MentionSelector 参考: `weknora-ui/src/components/Input-field.vue`
- Auth Store: `weknora-ui/src/stores/auth.ts`

**AgentStudio:**
- SDK MCP 参考: `agentstudio/backend/src/services/a2a/a2aSdkMcp.ts`
- MCP 集成: `agentstudio/backend/src/services/a2a/a2aIntegration.ts`
