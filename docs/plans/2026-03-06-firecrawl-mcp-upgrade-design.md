# Firecrawl MCP 全面升级设计

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 全面升级 Firecrawl MCP 工具集，从 2 工具扩展到 4 工具，增强 AI 网页抓取和数据提取能力。

**Architecture:** 保持单一 MCP Server `firecrawl`，增强现有 `scrape`/`map`，新增 `interact`（浏览器交互）和 `extract`（LLM 结构化提取）。引入共享熔断器、重试增强和前端可视化卡片。

**Tech Stack:** Claude Agent SDK MCP, Firecrawl V1 API (自托管), Zod schema, Vue 3 + TDesign (前端卡片)

---

## 一、背景与动机

### 1.1 当前状态

- 1 个 MCP Server，2 个工具：`firecrawl_scrape` + `firecrawl_map`
- `scrape` 默认 max_length=8000（太小），描述引用不存在的旧工具名 `searxng_search`
- 未暴露 Firecrawl 的 actions（浏览器交互）、screenshot（截图）、extract（结构化提取）能力
- 直接工具调用无熔断保护（与 contentExtractor 内部使用不一致）
- 无前端专用卡片（使用通用 McpToolCard）

### 1.2 已验证的 Firecrawl 自托管能力

**部署信息**（192.168.100.30）：
- 镜像：`ghcr.io/firecrawl/firecrawl:latest`
- 端口：3002（通过 AgentStudio `FIRECRAWL_URL=http://192.168.100.30:3002`）
- Playwright 服务：已部署（`WeKnora-firecrawl-playwright`）
- 认证：`USE_DB_AUTHENTICATION=false`（自托管模式，API Key 为 placeholder）

**已验证可用的 API（来源：Firecrawl 官方文档 + GitHub 源码）**：

| 端点 | 可用性 | 前置条件 |
|------|--------|----------|
| POST `/v1/scrape` | ✅ 可用 | 无 |
| POST `/v1/map` | ✅ 可用 | 无 |
| POST `/v1/scrape` (actions) | ✅ 可用 | Playwright 服务运行（已部署） |
| POST `/v1/scrape` (screenshot) | ✅ 可用 | Playwright 服务运行（已部署） |
| POST `/v1/extract` | ⚠️ 条件可用 | 需配置 `OPENAI_API_KEY` 或 `OLLAMA_BASE_URL` |
| POST `/v1/crawl` | ✅ 可用 | 无（但为异步任务，不适合交互场景） |

**不可用（云端专属）**：
- `/agent`、`/browser` 端点
- Fire-engine（高级反爬/IP 轮换）

### 1.3 决策记录

| 决策 | 结论 | 理由 |
|------|------|------|
| 暴露 `/v1/crawl` | **否** | 异步长任务，不适合 Agent 交互；map + 批量 scrape 可替代 |
| 暴露 `/v1/extract` | **是（Phase 2）** | 需先配置 LLM 环境变量 |
| actions 暴露方式 | **独立工具 `firecrawl_interact`** | 与 scrape 职责清晰分离 |
| screenshot 暴露方式 | **scrape + interact 都支持** | formats 参数自然扩展 |
| 架构模式 | **单 MCP Server** | 避免 SearXNG 拆分带来的 session resume 风险 |

---

## 二、工具设计

### 2.1 工具总览

```
MCP Server: firecrawl (v2.0.0)
├── firecrawl_scrape      — 网页内容抓取（增强版）
├── firecrawl_interact    — 浏览器交互后抓取（新）
├── firecrawl_map         — 站点 URL 发现（描述优化）
└── firecrawl_extract     — LLM 结构化提取（Phase 2，条件注册）
```

### 2.2 `firecrawl_scrape`（增强）

**API**：POST `/v1/scrape`

**参数变更**：

| 参数 | 当前 | 升级后 | 说明 |
|------|------|--------|------|
| `url` | string.url() | 不变 | 目标 URL |
| `max_length` | 默认 8000 | **默认 20000** | 与 contentExtractor 一致 |
| `formats` | `['markdown']` | 默认 `['markdown']`，增加 `'screenshot'` | 截图格式 |
| `only_main_content` | boolean, 默认 true | 不变 | 仅主内容 |
| `wait_for` | number, 无默认 | 不变 | JS 渲染等待 |
| `include_tags` | **无** | **新增** string[], 可选 | CSS 选择器白名单 |
| `exclude_tags` | **无** | **新增** string[], 可选 | CSS 选择器黑名单 |

**输入 Schema (Zod)**：
```typescript
{
  url: z.string().url().describe('The URL to fetch (must be public internet)'),
  max_length: z.number().min(500).max(50000).optional().default(20000)
    .describe('Max characters to return (default: 20000)'),
  formats: z.array(z.enum(['markdown', 'html', 'links', 'screenshot']))
    .optional().default(['markdown'])
    .describe('Output formats. Use "screenshot" to capture page image'),
  only_main_content: z.boolean().optional().default(true)
    .describe('Extract main content only, removing nav/footer/sidebar'),
  wait_for: z.number().min(0).max(10000).optional()
    .describe('Wait ms for JS rendering (use 2000-5000 for SPA/React/Vue pages)'),
  include_tags: z.array(z.string()).optional()
    .describe('CSS selectors to include (e.g., ["article", ".main-content"])'),
  exclude_tags: z.array(z.string()).optional()
    .describe('CSS selectors to exclude (e.g., [".ads", ".cookie-banner"])'),
}
```

**输出格式**：
```
# Page Title

> Source: https://example.com/page
> Language: en | Status: 200

[markdown content...]

[... content truncated at 20000 chars]
```

当 `formats` 包含 `'screenshot'` 时，返回多个 content blocks：
```typescript
{
  content: [
    { type: 'text', text: '# Page Title\n\n...' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }
  ]
}
```

**工具描述**：
```
Fetch a web page and return clean content (Markdown, HTML, links, or screenshot).

Capabilities:
- JavaScript rendering (waits for dynamic content to load)
- Main content extraction (strips nav, footer, ads)
- Page screenshots (use formats: ["screenshot"])
- CSS selector filtering (include/exclude specific elements)
- SSRF protection (internal networks blocked automatically)

When to use:
- Read full text of a URL found via web_search
- Extract content from documentation, blog posts, or articles
- Capture a visual snapshot of a page (screenshot format)
- Get only specific page sections (include_tags/exclude_tags)

Note: web_search already extracts top result content automatically.
Only use firecrawl_scrape when you need:
- More content (web_search extracts ~20K chars; scrape supports up to 50K)
- Screenshot capture
- CSS-targeted extraction
- A specific URL not from search results

Parameters:
- url: Public internet URL to fetch
- max_length: Max output characters (default 20000, max 50000)
- formats: Output formats - "markdown" (default), "html", "links", "screenshot"
- only_main_content: Strip nav/footer (default true)
- wait_for: Wait ms for JS rendering (2000-5000 for React/Vue/Angular SPAs)
- include_tags: CSS selectors to keep (e.g., ["article", ".content"])
- exclude_tags: CSS selectors to remove (e.g., [".ads", ".sidebar"])
```

### 2.3 `firecrawl_interact`（新增）

**API**：POST `/v1/scrape`（复用 scrape 端点，传入 `actions` 参数）

**核心场景**：
- 登录后抓取受保护内容
- 点击"加载更多"展开完整列表
- 关闭弹窗/Cookie 横幅后获取干净内容
- 表单提交后获取结果页
- 翻页加载更多结果

**输入 Schema (Zod)**：
```typescript
{
  url: z.string().url()
    .describe('The page URL to interact with'),
  actions: z.array(z.object({
    type: z.enum(['click', 'write', 'press', 'wait', 'scroll', 'screenshot'])
      .describe('Action type'),
    selector: z.string().optional()
      .describe('CSS selector for click target (required for click)'),
    text: z.string().optional()
      .describe('Text to type (required for write)'),
    key: z.string().optional()
      .describe('Key to press, e.g. "Enter", "Tab", "Escape" (required for press)'),
    milliseconds: z.number().optional()
      .describe('Wait duration in ms (required for wait, recommended: 1000-3000)'),
    direction: z.enum(['up', 'down']).optional()
      .describe('Scroll direction (for scroll action, default: down)'),
    fullPage: z.boolean().optional()
      .describe('Capture full page screenshot (for screenshot action)'),
  })).min(1).max(10)
    .describe('Sequence of browser actions to perform before scraping'),
  max_length: z.number().min(500).max(50000).optional().default(20000)
    .describe('Max characters in output'),
  only_main_content: z.boolean().optional().default(true)
    .describe('Extract main content only'),
}
```

**输出格式**：
```
## Interaction Summary

Executed 3 actions on https://example.com:
1. ✅ click: #load-more
2. ✅ wait: 2000ms
3. ✅ screenshot: full page captured

---

# Page Title After Interaction

[markdown content of page after actions completed...]
```

如果 actions 中包含 `screenshot`，额外返回 base64 截图（同 scrape）。

**工具描述**：
```
Interact with a web page (click, type, scroll) then scrape its content.
Uses a real browser (Playwright) to execute actions before extracting content.

When to use:
- Page requires clicking "Load More" or "Show All" to reveal content
- Need to close cookie banners or popups before reading
- Content is behind a tab, accordion, or expandable section
- Need to scroll to trigger lazy-loading content
- Want a screenshot after performing interactions

Supported actions (executed in order):
- click: Click an element (requires CSS selector)
- write: Type text into focused input
- press: Press a keyboard key (Enter, Tab, Escape, etc.)
- wait: Pause for specified milliseconds (use after click for content to load)
- scroll: Scroll the page (up/down)
- screenshot: Capture page image at this point

Tips:
- Always add a "wait" action (1000-3000ms) after "click" for content to render
- Maximum 10 actions per call to prevent abuse
- Use browser DevTools to find CSS selectors (right-click → Inspect)

Example - Load more comments:
  actions: [
    { type: "click", selector: "#load-more-btn" },
    { type: "wait", milliseconds: 2000 },
    { type: "screenshot", fullPage: true }
  ]
```

**安全约束**：
- 最多 10 个 actions
- 共享 SSRF 保护
- 共享并发限制（3 个并发）
- 共享熔断器
- 工具级超时 90s（交互页面需更长时间，Firecrawl 端超时 60s）

### 2.4 `firecrawl_map`（描述优化）

参数不变，仅优化描述：

**工具描述**：
```
Discover all URLs on a website without fetching their content.
Returns a list of URLs found by crawling the site's links and sitemap.

When to use:
- Explore a site's structure before scraping specific pages
- Find all documentation pages, blog posts, or API references
- Locate specific pages by keyword filtering (use search parameter)
- Plan targeted scraping of multiple pages

Parameters:
- url: The root URL to explore (e.g., "https://docs.example.com")
- search: Filter results by keyword (e.g., "api", "tutorial", "getting-started")
- limit: Maximum URLs to return (1-1000, default 50)

Note: Includes subdomains by default. For targeted scraping after map,
use firecrawl_scrape on individual URLs from the results.
```

### 2.5 `firecrawl_extract`（Phase 2，条件注册）

**API**：POST `/v1/extract`

**前置条件**：
在 WeKnora `docker-compose.yml` 的 `firecrawl-api` 服务 environment 中添加 3 个变量：

```yaml
# docker-compose.yml → firecrawl-api → environment 新增：
- OPENAI_BASE_URL=${OPENAI_BASE_URL}       # 中转 API 地址，如 https://your-transit.com/v1
- OPENAI_API_KEY=${OPENAI_API_KEY}         # 中转 API Key
- MODEL_NAME=${FIRECRAWL_MODEL_NAME:-gpt-4o-mini}  # 模型名称
```

对应 WeKnora `.env` 新增（OPENAI_API_KEY/OPENAI_BASE_URL 复用已有变量，MODEL_NAME 单独配）：
```env
# .env 新增
FIRECRAWL_MODEL_NAME=gpt-4o-mini           # Firecrawl LLM 使用的模型名
# OPENAI_API_KEY 和 OPENAI_BASE_URL 已有，与 WeKnora app 共享
```

**已验证的源码证据**（[generic-ai.ts](https://github.com/mendableai/firecrawl/blob/main/apps/api/src/lib/generic-ai.ts)）：
```typescript
// Firecrawl 内部用法：
openai: createOpenAI({
  apiKey: config.OPENAI_API_KEY,      // ← 读 process.env.OPENAI_API_KEY
  baseURL: config.OPENAI_BASE_URL,    // ← 读 process.env.OPENAI_BASE_URL
})
const modelName = config.MODEL_NAME || name;  // ← 优先 process.env.MODEL_NAME
```

三个变量均在 [config.ts](https://github.com/mendableai/firecrawl/blob/main/apps/api/src/config.ts) 中注册为 `z.string().optional()`。

**`MODEL_NAME` 的行为**：如果不设置，Firecrawl 默认用 `"gpt-4o-mini"`（硬编码在 `getModel` 函数中）。但中转 API 的模型名可能不同（如 `"claude-3-haiku"` 或自定义名称），所以建议显式指定。

LLM 配置影响的功能：
- `/v1/extract` — 结构化数据提取
- scrape `formats: ["json"]` — JSON 格式输出
- Summary / Branding / Change tracking 格式

在 AgentStudio `backend/.env` 中添加：
```env
FIRECRAWL_EXTRACT_ENABLED=true  # 启用 extract 工具注册
```

**输入 Schema (Zod)**：
```typescript
{
  urls: z.array(z.string().url()).min(1).max(5)
    .describe('URLs to extract data from (max 5, supports glob patterns like https://example.com/products/*)'),
  prompt: z.string()
    .describe('Natural language instruction for what data to extract'),
  schema: z.record(z.unknown()).optional()
    .describe('Optional JSON Schema defining the expected output structure'),
}
```

**输出格式**：
```json
{
  "content": [{
    "type": "text",
    "text": "## Extracted Data\n\n```json\n{\"products\": [{\"name\": \"Widget\", \"price\": 9.99}]}\n```\n\nSources: https://example.com/products/1, https://example.com/products/2"
  }]
}
```

**工具描述**：
```
Extract structured data from web pages using AI.
Powered by LLM-based analysis of page content.

When to use:
- Extract product details (name, price, rating) from multiple product pages
- Pull contact information from company websites
- Gather event details (date, location, speaker) from event pages
- Extract table data into structured JSON format

Parameters:
- urls: List of URLs to extract from (max 5, supports glob: "https://shop.com/products/*")
- prompt: What data to extract (e.g., "Extract product name, price, and availability")
- schema: Optional JSON Schema for output structure

Example:
  urls: ["https://shop.com/product/1", "https://shop.com/product/2"]
  prompt: "Extract product name, price, and customer rating"
  schema: {
    "type": "object",
    "properties": {
      "products": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "price": { "type": "number" },
            "rating": { "type": "number" }
          }
        }
      }
    }
  }
```

**条件注册逻辑**：
```typescript
const tools = [scrapeTool, interactTool, mapTool];
if (process.env.FIRECRAWL_EXTRACT_ENABLED === 'true') {
  tools.push(extractTool);
}
```

---

## 三、基础设施升级

### 3.1 共享熔断器

从 `contentExtractor.ts` 提取到独立模块，scrape 工具和 web_search 内部共享同一实例：

**新文件**：`backend/src/services/firecrawl/circuitBreaker.ts`

```typescript
export class FirecrawlCircuitBreaker {
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 5 * 60 * 1000
  ) {}

  isOpen(): boolean { /* 检查是否断开 */ }
  recordSuccess(): void { /* 重置计数 */ }
  recordFailure(): void { /* 递增计数，达到阈值断开 */ }
  reset(): void { /* 测试用重置 */ }
}

// 模块级单例，所有 Firecrawl 调用共享
export const firecrawlCircuitBreaker = new FirecrawlCircuitBreaker();
```

**使用方**：
- `firecrawlIntegration.ts`：scrape/interact 工具 handler 中检查熔断状态
- `contentExtractor.ts`：web_search 内部 Firecrawl 调用检查同一实例

### 3.2 重试增强

```typescript
private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (attempt === MAX_RETRIES) throw error;
      const status = error?.status || 0;
      if (status !== 429 && status !== 503) throw error;

      // 读取 Retry-After 头（如果有）
      const retryAfter = error?.retryAfter;
      const delay = retryAfter
        ? Math.min(retryAfter * 1000, 10000)
        : Math.pow(2, attempt + 1) * 1000; // 2s, 4s 指数退避
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}
```

### 3.3 Health Check 增强

```typescript
// 改为带认证的 HEAD 请求
try {
  const resp = await fetch(`${config.base_url}/v1/scrape`, {
    method: 'HEAD',
    headers: { 'Authorization': `Bearer ${config.api_key}` },
    signal: AbortSignal.timeout(3000),
  });
  // 405 Method Not Allowed 也算通过（说明端点存在且认证头被接受）
  if (!resp.ok && resp.status !== 405) {
    console.warn(`⚠️ [Firecrawl] Health check failed: ${resp.status}`);
    return;
  }
} catch { ... }
```

### 3.4 MCP 工具注解

```typescript
// scrape, interact, map 都是只读 + 访问外部网络
const annotations = {
  readOnlyHint: true,
  openWorldHint: true,
};
```

### 3.5 map 并发限制

`mapSite` 方法增加并发限制，与 scrape 共享：
```typescript
async mapSite(url: string, options?: { ... }): Promise<string[]> {
  validateUrl(url);
  return this.withConcurrencyLimit(() => this.withRetry(async () => { ... }));
}
```

---

## 四、前端工具卡片

### 4.1 新增组件

| 组件 | 文件 | 说明 |
|------|------|------|
| `FirecrawlInteractCard.vue` | `src/components/a2a-tools/tools/` | 交互步骤可视化 + 结果展示 |
| `FirecrawlExtractCard.vue` | `src/components/a2a-tools/tools/` | JSON 结构化数据表格渲染 |

### 4.2 `FirecrawlInteractCard.vue`

**布局**：
```
┌──────────────────────────────────────────┐
│ 🖱️ Web Interact    https://example.com   │
├──────────────────────────────────────────┤
│ Actions:                                 │
│ 1. ✅ click  →  #load-more              │
│ 2. ✅ wait   →  2000ms                  │
│ 3. ✅ screenshot  →  full page          │
├──────────────────────────────────────────┤
│ [Screenshot Image (if captured)]         │
├──────────────────────────────────────────┤
│ # Page Content After Interaction         │
│ [markdown rendered content...]           │
└──────────────────────────────────────────┘
```

**特性**：
- actions 步骤列表，每步显示类型 + 参数 + 状态图标
- screenshot 展示（如果有 base64 图片数据）
- 抓取内容 Markdown 渲染
- 收起/展开控制

### 4.3 `FirecrawlExtractCard.vue`

**布局**：
```
┌──────────────────────────────────────────┐
│ 📊 Data Extract    3 URLs processed      │
├──────────────────────────────────────────┤
│ Prompt: "Extract product name and price" │
├──────────────────────────────────────────┤
│ ┌──────────┬────────┬────────┐           │
│ │ Name     │ Price  │ Rating │           │
│ ├──────────┼────────┼────────┤           │
│ │ Widget A │ $9.99  │ 4.5    │           │
│ │ Widget B │ $14.99 │ 4.2    │           │
│ └──────────┴────────┴────────┘           │
├──────────────────────────────────────────┤
│ Sources: url1, url2, url3               │
└──────────────────────────────────────────┘
```

**特性**：
- JSON 数据自动检测并渲染为表格（如果是数组）
- 非数组 JSON 渲染为 key-value 列表
- 来源 URL 列表
- prompt 摘要显示

### 4.4 Screenshot 渲染（scrape + interact 共用）

当 scrape 或 interact 返回中包含 `type: 'image'` content block 时，`ToolCallRenderer.vue` 需要能解析并渲染 base64 图片。

方案：在现有 `McpToolCard` 或 `BaseToolCard` 的 output 展示中增加 image content block 支持。

### 4.5 图标/颜色/路由注册

**types.ts 新增**：
```typescript
// TOOL_ICONS
FirecrawlInteract: 'cursor',      // 或 'pointer'
FirecrawlExtract: 'data-display',  // 或 'chart-bar'

// TOOL_COLORS
FirecrawlInteract: {
  light: { text: '#7c3aed', bg: 'rgba(124, 58, 237, 0.1)' },
  dark: { text: '#a78bfa', bg: 'rgba(124, 58, 237, 0.3)' }
},
FirecrawlExtract: {
  light: { text: '#059669', bg: 'rgba(16, 185, 129, 0.1)' },
  dark: { text: '#34d399', bg: 'rgba(16, 185, 129, 0.3)' }
},

// MCP_TOOL_MAP
'mcp__firecrawl__firecrawl_interact': 'FirecrawlInteract',
'mcp__firecrawl__firecrawl_extract': 'FirecrawlExtract',
```

**ToolCallRenderer.vue 新增路由**：
```typescript
if (name === 'mcp__firecrawl__firecrawl_interact') {
  return toolComponents['FirecrawlInteract']
}
if (name === 'mcp__firecrawl__firecrawl_extract') {
  return toolComponents['FirecrawlExtract']
}
```

### 4.6 i18n（4 语言）

```typescript
// builtinTools 新增
FirecrawlInteract: '网页交互' / 'Web Interact' / 'Веб-взаимодействие' / '웹 상호작용'
FirecrawlExtract: '数据提取' / 'Data Extract' / 'Извлечение данных' / '데이터 추출'
```

---

## 五、分阶段实施

### Phase 1（后端 + 前端）

1. **基础设施**：共享熔断器提取、重试增强、health check 增强、工具注解
2. **scrape 增强**：max_length 默认值、screenshot 格式、include/exclude_tags、输出 metadata、描述重写
3. **interact 新增**：工具定义、actions schema、安全约束
4. **map 描述优化**：补充 search 参数说明
5. **前端**：FirecrawlInteractCard.vue、screenshot 渲染、图标/颜色/路由/i18n
6. **测试**：新工具单元测试、增强现有测试覆盖

### Phase 2（需先配置 Firecrawl LLM）

1. **Firecrawl LLM 配置**：docker-compose.yml 添加 `OPENAI_API_KEY` + `OPENAI_BASE_URL`
2. **extract 工具**：工具定义、条件注册
3. **前端**：FirecrawlExtractCard.vue、图标/颜色/路由/i18n
4. **测试**：extract 工具测试

---

## 六、文件变更清单

### Phase 1 后端（agentstudio）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `backend/src/services/firecrawl/circuitBreaker.ts` | 共享熔断器类 |
| 修改 | `backend/src/services/firecrawl/firecrawlClient.ts` | 重试增强（指数退避 + Retry-After）、map 并发限制 |
| 修改 | `backend/src/services/firecrawl/firecrawlIntegration.ts` | scrape 增强、interact 新增、描述重写、熔断集成、health check 增强、工具注解 |
| 修改 | `backend/src/services/firecrawl/types.ts` | 新增 ExtractResponse 类型 |
| 修改 | `backend/src/services/firecrawl/index.ts` | 导出新模块 |
| 修改 | `backend/src/services/searxng/contentExtractor.ts` | 改用共享熔断器 |
| 修改 | `backend/src/utils/claudeUtils.ts` | 更新日志（工具数量） |
| 新建 | `backend/src/services/firecrawl/__tests__/circuitBreaker.test.ts` | 熔断器测试 |
| 修改 | `backend/src/services/firecrawl/__tests__/firecrawlClient.test.ts` | 补充测试 |
| 修改 | `backend/src/services/firecrawl/__tests__/firecrawlIntegration.test.ts` | interact 工具测试 |

### Phase 1 前端（weknora-ui）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/components/a2a-tools/tools/FirecrawlInteractCard.vue` | 交互工具卡片 |
| 修改 | `src/components/a2a-tools/ToolCallRenderer.vue` | 新路由注册 |
| 修改 | `src/components/a2a-tools/types.ts` | 图标/颜色/MCP 映射 |
| 修改 | `src/i18n/locales/zh-CN.ts` | 中文翻译 |
| 修改 | `src/i18n/locales/en-US.ts` | 英文翻译 |
| 修改 | `src/i18n/locales/ru-RU.ts` | 俄文翻译 |
| 修改 | `src/i18n/locales/ko-KR.ts` | 韩文翻译 |

### Phase 2 后端（agentstudio）

| 操作 | 文件 | 说明 |
|------|------|------|
| 修改 | `backend/src/services/firecrawl/firecrawlIntegration.ts` | extract 工具定义 + 条件注册 |
| 修改 | `backend/src/services/firecrawl/firecrawlClient.ts` | extract API 调用方法 |
| 新建 | `backend/src/services/firecrawl/__tests__/extract.test.ts` | extract 测试 |

### Phase 2 前端（weknora-ui）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/components/a2a-tools/tools/FirecrawlExtractCard.vue` | 提取结果卡片 |
| 修改 | `src/components/a2a-tools/ToolCallRenderer.vue` | extract 路由 |
| 修改 | `src/components/a2a-tools/types.ts` | extract 图标/颜色 |
| 修改 | `src/i18n/locales/*.ts` | 4 语言 extract 翻译 |

### 部署配置

| 操作 | 文件 | 说明 |
|------|------|------|
| 修改 | `WeKnora/docker-compose.yml` | firecrawl-api 添加 `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `MODEL_NAME`（Phase 2） |
| 修改 | `WeKnora/.env` | 新增 `FIRECRAWL_MODEL_NAME`（OPENAI_API_KEY/BASE_URL 复用已有） |
| 修改 | `WeKnora/.env.example` | 新增 `FIRECRAWL_MODEL_NAME` 模板 |
| 修改 | `agentstudio/backend/.env` | 新增 `FIRECRAWL_EXTRACT_ENABLED` |

---

## 七、风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| actions 在自托管 Playwright 上不稳定 | 中 | interact 工具不可用 | 熔断器自动降级；AI 描述中说明限制 |
| screenshot base64 过大占用 context | 低 | AI context 浪费 | 限制截图质量/分辨率；客户端压缩 |
| extract 中转 API 格式不兼容 | 低 | extract 工具失败 | Phase 2 先手动测试 API 兼容性 |
| 熔断器提取影响现有 web_search | 低 | 回归 bug | 共享实例行为一致；充分测试 |
| 新工具名增加 session resume 风险 | 中 | 老会话恢复失败 | 单 MCP Server 架构不变，只增加 allowedTools |

---

## 八、验证计划

### 后端验证

```bash
cd agentstudio/backend
npx vitest run src/services/firecrawl/  # 全部 Firecrawl 测试
npx vitest run src/services/searxng/    # 确保 contentExtractor 不回归
```

### 前端验证

```bash
cd weknora-ui
pnpm run build                          # 构建验证
pnpm run type-check                     # TypeScript 检查
```

### 手动集成测试

1. **scrape 增强**：请求 screenshot 格式，验证 base64 图片返回
2. **interact**：访问需要点击的页面，验证 actions 执行 + 内容抓取
3. **map 优化**：使用 search 参数过滤 URL
4. **熔断器**：模拟 Firecrawl 服务宕机，验证 3 次失败后自动断开
5. **extract（Phase 2）**：配置 LLM 后，验证结构化提取
