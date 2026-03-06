# SearXNG MCP 拆分重构设计方案 v2

> **日期**: 2026-03-06
> **状态**: 设计方案（已通过实测验证）
> **目标**: 将单一 `searxng_search` 工具拆分为 3 个专职 MCP，引入搜索+抓取 pipeline 和确定性意图路由
> **前置文档**: `2026-03-05-searxng-mcp-split-design.md`（v1，已废弃）
> **v1 → v2 变更**: 修正 3 个捏造引擎、加权投票改为确定性规则、引擎路由表基于实测修正
> **v2 评审修订 (2026-03-06)**: 追加 sogou wechat 到 news 路由、修正 TOOL_DESCRIPTION 引擎名、修正并发描述、明确 health check 归属、精简 CODE_ACTION_WORDS、补充 fallback fetch 并发说明

---

## 一、现状分析

### 当前架构

```
searxng MCP (1 个 Server, 1 个工具)
└── mcp__searxng__searxng_search
    ├── 通用搜索 (general/news/code/academic)
    ├── 图片搜索 (images)
    └── 视频搜索 (videos)
```

**代码位置**: `backend/src/services/searxng/searxngIntegration.ts`

### 现有问题

| 问题 | 说明 | 代码证据 |
|------|------|---------|
| **工具职责过重** | 一个工具承担文本/图片/视频三种搜索，TOOL_DESCRIPTION 长达 47 行 | `searxngIntegration.ts:7-47` |
| **AI 选引擎困难** | AI 需要从 109 个引擎中手动挑选，TOOL_DESCRIPTION 列出 11 组推荐引擎表 | `searxngIntegration.ts:16-27` |
| **文本结果信息量不足** | 只返回 SearXNG snippet（<=300 字），AI 无法获取页面全文 | `resultProcessor.ts:59` snippet 截断 300 字 |
| **图片/视频混在文本流** | 媒体结果用 `[SEARXNG_GALLERY]` 标记嵌入文本，依赖前端正则解析 | `searxngIntegration.ts:149` |
| **前端卡片复杂** | `SearxngSearchToolCard.vue` 同时处理文本/图片/视频三种渲染 | weknora-ui 前端代码 |

---

## 二、目标架构

```
┌──────────────────────────────────────────────────────────┐
│  3 个独立 MCP Server                                      │
│                                                           │
│  searxng-search MCP           searxng-images MCP          │
│  └── web_search               └── image_search            │
│                                                           │
│  searxng-videos MCP                                       │
│  └── video_search                                         │
└──────────────────────────────────────────────────────────┘
```

### MCP Server 命名

遵循项目现有 SDK MCP 命名惯例（连字符）：

| MCP Server Name | mcpServers key | 工具全名 |
|----------------|---------------|---------|
| `searxng-search` | `'searxng-search'` | `mcp__searxng-search__web_search` |
| `searxng-images` | `'searxng-images'` | `mcp__searxng-images__image_search` |
| `searxng-videos` | `'searxng-videos'` | `mcp__searxng-videos__video_search` |

> 参考现有命名：`firecrawl` -> `mcp__firecrawl__*`, `a2a-client` -> `mcp__a2a-client__*`

### 核心改进

1. **web_search = 搜索 + 抓取 pipeline** — AI 拿到页面正文，不再只有 snippet
2. **image_search / video_search 独立工具** — 返回结构化 JSON，不再混入文本流
3. **AI 不需要选引擎** — queryRouter 基于确定性规则自动路由

---

## 三、工具详细设计

### 3.1 searxng-search MCP

#### 工具: `web_search`

**设计哲学**: 搜索 + 浅层抓取，让 AI 拿到有实质内容的结果。

```typescript
// 输入
interface WebSearchInput {
  query: string           // 搜索关键词 (必填)
  time_range?: 'day' | 'week' | 'month' | 'year'  // 时间过滤
  search_type?: 'general' | 'news' | 'code' | 'academic'  // 可选 override，通常不需要传
  max_results?: number    // 返回数量, 默认 5, 最大 10
}

// 输出
interface WebSearchOutput {
  query: string
  intent: string          // 自动识别的意图
  results: Array<{
    title: string
    url: string
    snippet: string       // SearXNG 返回的摘要
    content?: string      // 抓取提取的正文 (动态截断)
    publishedDate?: string
    engines: string[]
  }>
  suggestions?: string[]
  answers?: string[]
}
```

**内部 Pipeline**:

```
query + time_range + search_type(可选)
       │
       v
┌──────────────────────────────────────────┐
│  Step 1: queryRouter.analyzeQuery()      │
│                                          │
│  (1) 语言检测: CJK -> zh, ASCII -> en   │
│  (2) 确定性规则链意图识别 (详见 三.5 节) │
│  (3) search_type 传了则强制 override     │
│  -> 输出: { intent, engines,            │
│             languageCode }              │
└──────────┬───────────────────────────────┘
           │
           v
┌──────────────────────────────────────────┐
│  Step 2: SearXNG 搜索                    │
│                                          │
│  请求 pageno=1 (SearXNG 默认返回 ~10 条) │
│  dedupeAndRank -> Top N                  │
│                                          │
│  注: SearXNG API 无 max_results 参数，   │
│  返回数量由实例配置决定 (默认 10 条/页)。 │
│  客户端 dedupeAndRank 截断到 max_results。│
└──────────┬───────────────────────────────┘
           │
           v
┌──────────────────────────────────────────┐
│  Step 3: 并发抓取 Top N 页面             │
│                                          │
│  Promise.allSettled + 共享 AbortController│
│  - 优先 Firecrawl (JS渲染+反爬+SSRF防护)│
│  - Firecrawl 不可用时 fallback 轻量 fetch│
│  - searchMcp.ts 中限制最大并发 5          │
│    (Firecrawl 客户端内部再限 max 3,      │
│     超出的在 Firecrawl semaphore 排队)    │
│  - fallback fetch 并发也受外部限制       │
│  - 每页独立超时 (Firecrawl 5s / fetch 3s)│
│  - 失败静默跳过 (仍有 snippet)           │
│  - 跳过非 HTML 响应 (PDF 等)             │
└──────────┬───────────────────────────────┘
           │
           v
┌──────────────────────────────────────────┐
│  Step 4: 正文提取                        │
│                                          │
│  Firecrawl: 直接返回 markdown            │
│  Fallback: 正则移除标签 + 段落保留       │
│  按 Token 预算截断 (见下方)              │
└──────────┬───────────────────────────────┘
           │
           v
┌──────────────────────────────────────────┐
│  Step 5: 组装返回                        │
│                                          │
│  每条结果 = snippet + content            │
│  返回纯结构化 JSON (非 markdown)         │
│                                          │
│  Token 预算 (总输出 ~12000 字以内):      │
│  max_results <= 5 -> content 截断 2000 字│
│  max_results 6-8 -> content 截断 1200 字 │
│  max_results 9-10 -> content 截断 800 字 │
└──────────────────────────────────────────┘
```

**TOOL_DESCRIPTION**:

```
Search the web and fetch page content for comprehensive results.
The search engine is automatically selected based on query content.
Most queries work well with auto-detection; use search_type only if results seem off-topic.

Parameters:
- query: Search keywords
- search_type (optional): Override auto-detection. "general", "news", "code", "academic"
- time_range: "day", "week", "month", "year"
- max_results: 1-10, default 5

Auto-detection examples:
- "React useEffect bug" -> code engines (GitHub, StackOverflow, MDN)
- "今天新闻" -> news engines (Google News, Bing News)
- "transformer paper arxiv" -> academic engines (Google Scholar, arXiv)
- "好吃的餐厅" -> general engines (Google, Baidu, DuckDuckGo)

Returns structured results with page content excerpts.
```

---

### 3.2 searxng-images MCP

#### 工具: `image_search`

```typescript
// 输入
interface ImageSearchInput {
  query: string           // 搜索关键词
  max_results?: number    // 默认 12, 最大 30
}

// 输出 (结构化 JSON, 不嵌入 markdown)
interface ImageSearchOutput {
  query: string
  images: Array<{
    title: string
    thumbnail: string     // 缩略图 URL (优先 SearXNG 代理)
    fullUrl: string       // 原图 URL
    sourceUrl: string     // 来源页面 URL
    width?: number
    height?: number
    format?: string       // jpeg, png, gif, webp
  }>
  engines: string[]       // 使用的引擎
}
```

**内部逻辑**:

- 引擎列表（固定，与 queryRouter 无关）:
  - base: `google images,bing images,duckduckgo images,flickr,pexels,unsplash`
  - 中文 query 追加: `baidu images,quark images`
- 图片 URL 修复: `//` 前缀补 `https:`
- 通过 SearXNG `image_proxy=true` 代理缩略图避免防盗链
- **不需要抓取页面**

> 注: 实例中还有 `brave.images`, `startpage images`, `qwant images`, `pinterest`, `openverse`, `deviantart`, `artic`, `devicons`, `lucide`, `wikicommons.images` 等图片引擎。上述列表选取了主流通用引擎，避免过多引擎导致响应慢或结果噪音大。

**TOOL_DESCRIPTION**:

```
Search for images across multiple engines.

Parameters:
- query: What to search for
- max_results: 1-30, default 12

Returns image thumbnails, full URLs, and source pages.
Results are displayed in a visual gallery card.
```

---

### 3.3 searxng-videos MCP

#### 工具: `video_search`

```typescript
// 输入
interface VideoSearchInput {
  query: string           // 搜索关键词
  max_results?: number    // 默认 8, 最大 20
}

// 输出
interface VideoSearchOutput {
  query: string
  videos: Array<{
    title: string
    thumbnail: string     // 视频缩略图
    url: string           // 视频播放页 URL
    platform: string      // youtube, bilibili, etc.
    duration?: string     // "3:42"
    author?: string
    publishedDate?: string
  }>
  engines: string[]
}
```

**内部逻辑**:

- 引擎列表（固定，与 queryRouter 无关）:
  - base: `youtube,google videos,bing videos,duckduckgo videos`
  - 中文 query 追加: `bilibili`
- 从 URL 推断 platform (youtube.com -> youtube, bilibili.com -> bilibili)
- **不需要抓取页面**

> 注: 实例中还有 `brave.videos`, `qwant videos`, `sepiasearch`, `vimeo`, `dailymotion`, `wikicommons.videos` 等视频引擎。

**TOOL_DESCRIPTION**:

```
Search for videos on YouTube, Bilibili, and other platforms.

Parameters:
- query: What to search for
- max_results: 1-20, default 8

Returns video thumbnails, URLs, platform info, and metadata.
Results are displayed in a visual video gallery card.
```

---

## 三.5 查询意图识别与引擎智能路由

### 设计目标

旧方案：AI 从 109 个引擎中手动挑选 -> 经常选错、漏选。
新方案：**系统自动识别查询意图，确定性路由到引擎组合**。`search_type` 降级为可选 override。

### v1 -> v2 变更说明

v1 使用加权投票 + confidence 分数。实测发现结构性缺陷：confidence 值高度依赖正则的分组方式（实现细节），而非查询的语义强度。例如"华为今天发布了什么"中"今天"和"发布"命中同一个 RegExp，matchCount=1 而非 2，导致 confidence=0.3 fallback 到 general，无法走 news 引擎。

v2 改用**确定性优先级链**：命中即停止，无分数、无权重、无灰度混合。行为可预测、易调试。

### 确定性规则链

```
查询文本
    │
    v
┌─ Tier 1: 结构特征（最高优先级，无歧义）──────────────┐
│  arXiv ID (arXiv:dddd.ddddd)        -> academic      │
│  DOI (10.xxxx/)                      -> academic      │
│  错误堆栈 (Traceback, Error:,                        │
│    Cannot find, Module not found)    -> code          │
│  包名@版本 (xxx@1.2.3, ==1.2.3,                     │
│    v1.2.3)                           -> code          │
│  GitHub/SO URL (github.com/,                         │
│    stackoverflow.com/)               -> code          │
└──────────────┬───────────────────────────────────────┘
               │ 未命中
               v
┌─ Tier 2: 代码意图（需要 tech 上下文 + 代码动作）─────┐
│  API/函数引用:                                        │
│    useEffect, useState, useRef, useMemo,             │
│    useCallback, useContext, useReducer,               │
│    defineProps, defineEmits, watchEffect,             │
│    onMounted, ref(), reactive(), computed()           │
│    -> code                                            │
│                                                       │
│  技术名词 + 代码动作词组合:                            │
│    技术名词: react, vue, angular, svelte, nextjs,     │
│      nuxt, express, nestjs, fastapi, django, flask,   │
│      spring, laravel, tailwind, prisma, graphql,      │
│      redis, postgres, mysql, mongodb, docker,         │
│      kubernetes, terraform, nginx, python, java,      │
│      golang, rust, typescript 等                      │
│    代码动作词: 报错, 错误, 安装, 依赖, 配置, 部署,    │
│      编译, 调试, error, bug, install, import,         │
│      function, class, api, sdk, debug, deploy,        │
│      config 等                                        │
│    (注: 框架/代码/函数/接口 是名词非动作词，          │
│     已从动作词列表移除，避免过度触发)                  │
│    两者同时出现 -> code                               │
│                                                       │
│  工具命令上下文:                                       │
│    npm/pip/yarn/pnpm/docker/git + 动词               │
│    -> code                                            │
└──────────────┬───────────────────────────────────────┘
               │ 未命中
               v
┌─ Tier 3: 学术意图 ──────────────────────────────────┐
│  学术关键词: 论文, 研究, 算法, 综述, 学术, 引用,      │
│    paper, research, study, algorithm, thesis,         │
│    survey, journal, citation, SOTA, benchmark,        │
│    dataset                                            │
│  -> academic                                          │
└──────────────┬───────────────────────────────────────┘
               │ 未命中
               v
┌─ Tier 4: 新闻意图（仅在无 tech 名词时触发）──────────┐
│  时间敏感词: 最新, 今日, 今天, 昨天, 发布, 宣布,     │
│    事件, 事故, 政策, 声明, 通报, 突发, 官宣,          │
│    latest, breaking, announced, released, news,       │
│    today, yesterday                                   │
│  OR time_range = 'day' | 'week'                      │
│                                                       │
│  且查询中无 tech 名词 -> news                         │
│  有 tech 名词 + 时间词 -> 跳过（歧义，交给 general） │
└──────────────┬───────────────────────────────────────┘
               │ 未命中
               v
┌─ Tier 5: 社区意图 ──────────────────────────────────┐
│  社区关键词: 讨论, 评价, 推荐, 体验, 吐槽, 测评,     │
│    口碑, 对比, reddit, review, opinion, experience,   │
│    recommend, vs, comparison, alternative             │
│  -> social                                            │
└──────────────┬───────────────────────────────────────┘
               │ 未命中
               v
          Tier 6: general（兜底）
```

### 引擎路由表

> **所有引擎名均已在 192.168.100.30:8888 实例验证存在且启用（109 个引擎，2026-03-06 验证）。**

#### 实测发现：中文查询必须包含 general 引擎

| 测试 | 纯专用引擎 | 纯 general | 混合 (general + 专用) |
|------|-----------|-----------|---------------------|
| "React useEffect 无限循环" (zh, code) | 10条，仅 MDN，**全部无关** | 50条，精准命中 | 59条，**最优** |
| "论文 transformer 注意力机制" (zh, academic) | 62条，质量差 | — | 58条，**精准命中** |
| "华为今天发布" (zh, news) | — | — | 7条，相关 | news 独立有效 |
| "React useEffect infinite loop" (en, code) | 60条，一般 | — | 61条，精准 |
| "transformer paper" (en, academic) | 68条，尚可 | — | — |

**原因**: Code/Academic 专用引擎（github, stackoverflow, arxiv 等）是英文生态，对中文查询几乎无效。中文技术/学术内容在通用平台（CSDN、掘金、博客园、知乎、腾讯云），只有 general 引擎能索引。

#### 路由表定义

```typescript
// 仅服务于 web_search。image_search 和 video_search 各自维护引擎列表。

const GENERAL_BASE = 'google,duckduckgo,brave,startpage,wikipedia';
const GENERAL_ZH   = 'google,duckduckgo,brave,startpage,wikipedia,baidu,sogou,quark';

const CODE_ENGINES     = 'github,stackoverflow,mdn,npm,pypi,docker hub,pkg.go.dev,crates.io,codeberg';
const ACADEMIC_ENGINES = 'google scholar,arxiv,semantic scholar,pubmed,crossref,openalex';
const SOCIAL_ENGINES   = 'reddit,hackernews,stackoverflow';

const INTENT_ENGINE_MAP: Record<SearchIntent, { zh: string; en: string }> = {
  general:  { zh: GENERAL_ZH,                              en: GENERAL_BASE },
  code:     { zh: GENERAL_ZH + ',' + CODE_ENGINES,         en: GENERAL_BASE + ',' + CODE_ENGINES },
  academic: { zh: GENERAL_ZH + ',' + ACADEMIC_ENGINES,     en: ACADEMIC_ENGINES },
  news:     {
    zh: 'google news,bing news,yahoo news,duckduckgo news,wikinews,startpage news,brave.news,reuters,qwant news,sogou wechat',
    en: 'google news,bing news,yahoo news,duckduckgo news,wikinews,startpage news,brave.news',
  },
  social:   { zh: GENERAL_ZH + ',' + SOCIAL_ENGINES,       en: GENERAL_BASE + ',' + SOCIAL_ENGINES },
};
```

> 注: `google scholar` 在所有实测中均 unresponsive，但保留在列表中（有时可用）。

### 实测验证：4 个例子完整走查

**例子 1**: "React useEffect 无限循环怎么解决"
- 语言: CJK -> zh
- Tier 1: 无结构特征 -> 继续
- Tier 2: "useEffect" 命中 API/函数引用 -> **code**
- 引擎: code + zh = general_zh + code_engines
- 实测: 59 条结果，Top 3 = 腾讯云、掘金（精准命中解决方案）

**例子 2**: "华为今天发布了什么"
- 语言: CJK -> zh
- Tier 1-2: 无 -> 继续
- Tier 3: 无学术关键词 -> 继续
- Tier 4: "今天" + "发布" 命中时间敏感词，无 tech 名词 -> **news**
- 引擎: news_zh
- 实测: 7 条结果，华为新品发布相关新闻

**例子 3**: "好吃的火锅店"
- 语言: CJK -> zh
- Tier 1-5: 全部未命中
- Tier 6: **general**
- 引擎: general_zh
- 实测: 64 条结果，知乎/百度/火锅推荐

**例子 4**: "Python 最新版本"
- 语言: 混合 -> zh
- Tier 1: 无结构特征 -> 继续
- Tier 2: "Python" 是 tech 名词，但无代码动作词/API 引用 -> 未命中
- Tier 3: 无学术关键词 -> 继续
- Tier 4: "最新" 是时间敏感词，但 "Python" 是 tech 名词 -> 歧义，跳过
- Tier 5: 无社区关键词 -> 继续
- Tier 6: **general**
- 引擎: general_zh
- 实测: 52 条结果，Top 1 = Python 3.14.3 官方文档

### `queryRouter.ts` 实现

```typescript
// agentstudio/backend/src/services/searxng/queryRouter.ts

export type SearchTypeOverride = 'general' | 'news' | 'code' | 'academic';
export type SearchIntent = 'general' | 'news' | 'code' | 'academic' | 'social';
export type QueryLanguage = 'zh' | 'en' | 'other';

export interface QueryAnalysis {
  lang: QueryLanguage;
  intent: SearchIntent;
  engines: string;
  languageCode: string;
}

// --- 语言检测 ---

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f]/;

function detectLanguage(query: string): QueryLanguage {
  if (CJK_REGEX.test(query)) return 'zh';
  if (/^[a-zA-Z0-9\s\-_.,:;!?'"()\[\]{}@#$%^&*+=<>/\\|`~]+$/.test(query)) return 'en';
  return 'other';
}

// --- 引擎路由表 ---

const GENERAL_BASE = 'google,duckduckgo,brave,startpage,wikipedia';
const GENERAL_ZH   = 'google,duckduckgo,brave,startpage,wikipedia,baidu,sogou,quark';
const CODE_ENGINES     = 'github,stackoverflow,mdn,npm,pypi,docker hub,pkg.go.dev,crates.io,codeberg';
const ACADEMIC_ENGINES = 'google scholar,arxiv,semantic scholar,pubmed,crossref,openalex';
const SOCIAL_ENGINES   = 'reddit,hackernews,stackoverflow';

const INTENT_ENGINE_MAP: Record<SearchIntent, { zh: string; en: string }> = {
  general:  { zh: GENERAL_ZH,                              en: GENERAL_BASE },
  code:     { zh: GENERAL_ZH + ',' + CODE_ENGINES,         en: GENERAL_BASE + ',' + CODE_ENGINES },
  academic: { zh: GENERAL_ZH + ',' + ACADEMIC_ENGINES,     en: ACADEMIC_ENGINES },
  news:     {
    zh: 'google news,bing news,yahoo news,duckduckgo news,wikinews,startpage news,brave.news,reuters,qwant news,sogou wechat',
    en: 'google news,bing news,yahoo news,duckduckgo news,wikinews,startpage news,brave.news',
  },
  social:   { zh: GENERAL_ZH + ',' + SOCIAL_ENGINES,       en: GENERAL_BASE + ',' + SOCIAL_ENGINES },
};

function resolveEngines(intent: SearchIntent, lang: QueryLanguage): string {
  const langKey = lang === 'zh' ? 'zh' : 'en';
  return INTENT_ENGINE_MAP[intent][langKey];
}

// --- 确定性规则链 ---

// Tier 1: 结构特征
const STRUCTURE_RULES: Array<{ pattern: RegExp; intent: SearchIntent }> = [
  { pattern: /10\.\d{4,}\//,                                         intent: 'academic' }, // DOI
  { pattern: /arXiv:\d{4}\.\d+/i,                                    intent: 'academic' }, // arXiv ID
  { pattern: /Traceback|Error:|Cannot find|Module not found|FAILED|No module named/i, intent: 'code' }, // 错误堆栈
  { pattern: /\S+@\d+\.\d+|==\d+\.\d+|\bv\d+\.\d+\.\d+\b/,        intent: 'code' },     // 包名@版本
  { pattern: /github\.com\/|stackoverflow\.com\/|npmjs\.com\//i,     intent: 'code' },     // 代码平台 URL
];

// Tier 2: API/函数引用 (命中任一即为 code)
const API_PATTERN = /\b(use[A-Z]\w+|useState|useEffect|useRef|useMemo|useCallback|useContext|useReducer|defineProps|defineEmits|watchEffect|onMounted|ref\(|reactive\(|computed\()\b/;

// Tier 2: 技术名词 + 代码动作词组合
const TECH_NAMES = /\b(react|vue|angular|svelte|nextjs|next\.js|nuxt|astro|remix|express|nestjs|fastapi|django|flask|spring|laravel|rails|tailwind|prisma|drizzle|mongoose|sequelize|graphql|redis|postgres|mysql|mongodb|sqlite|supabase|firebase|aws|gcp|azure|vercel|netlify|kubernetes|k8s|terraform|ansible|nginx|caddy|linux|macos|ubuntu|centos|homebrew|python|java|golang|rust|typescript|webpack|vite|eslint)\b/i;

const CODE_ACTION_WORDS = /报错|错误|安装|依赖|配置|部署|编译|调试|\b(error|bug|install|import|function|class|api|sdk|debug|deploy|config|compile|migrate|setup)\b/i;

// Tier 2: 工具命令上下文
const TOOL_COMMAND = /\b(npm|pip|yarn|pnpm|docker|git|cargo|brew|apt|curl|wget)\s+(install|init|build|run|start|push|pull|add|remove|update|exec|compose)\b/i;

// Tier 3: 学术关键词
const ACADEMIC_KEYWORDS = /论文|研究|算法|综述|学术|引用|实验|模型训练|\b(paper|research|study|algorithm|thesis|survey|journal|citation|SOTA|benchmark|dataset)\b/i;

// Tier 4: 新闻/时间敏感词
const NEWS_KEYWORDS = /最新|今[日天]|昨天|发布|宣布|事[件故]|政策|声明|通报|突发|官宣|\b(latest|breaking|announced|released|news|today|yesterday)\b/i;

// Tier 5: 社区关键词
const SOCIAL_KEYWORDS = /讨论|评价|推荐|体验|吐槽|测评|口碑|对比|\b(reddit|review|opinion|experience|recommend|vs|comparison|alternative)\b/i;

function detectIntent(query: string, timeRange?: string): SearchIntent {
  // Tier 1: 结构特征
  for (const { pattern, intent } of STRUCTURE_RULES) {
    if (pattern.test(query)) return intent;
  }

  // Tier 2: 代码意图
  if (API_PATTERN.test(query)) return 'code';
  if (TECH_NAMES.test(query) && CODE_ACTION_WORDS.test(query)) return 'code';
  if (TOOL_COMMAND.test(query)) return 'code';

  // Tier 3: 学术意图
  if (ACADEMIC_KEYWORDS.test(query)) return 'academic';

  // Tier 4: 新闻意图 (有 tech 名词时跳过)
  const hasNewsSignal = NEWS_KEYWORDS.test(query) || timeRange === 'day' || timeRange === 'week';
  if (hasNewsSignal && !TECH_NAMES.test(query)) return 'news';

  // Tier 5: 社区意图
  if (SOCIAL_KEYWORDS.test(query)) return 'social';

  // Tier 6: 兜底
  return 'general';
}

// --- 主入口 ---

export function analyzeQuery(
  query: string,
  options?: { searchType?: SearchTypeOverride; timeRange?: string }
): QueryAnalysis {
  const lang = detectLanguage(query);

  // search_type 强制 override
  if (options?.searchType) {
    const engines = resolveEngines(options.searchType, lang);
    console.log(`[QueryRouter] "${query}" -> override=${options.searchType} lang=${lang}`);
    return {
      lang,
      intent: options.searchType,
      engines,
      languageCode: lang === 'zh' ? 'zh-CN' : lang === 'en' ? 'en' : 'all',
    };
  }

  // 自动识别
  const intent = detectIntent(query, options?.timeRange);
  const engines = resolveEngines(intent, lang);

  console.log(`[QueryRouter] "${query}" -> intent=${intent} lang=${lang} engines=${engines}`);

  return {
    lang,
    intent,
    engines,
    languageCode: lang === 'zh' ? 'zh-CN' : lang === 'en' ? 'en' : 'all',
  };
}
```

---

## 四、后端文件结构

```
backend/src/services/searxng/
├── types.ts                    # 共享类型 (保留, 扩展)
├── searxngClient.ts            # SearXNG HTTP 客户端 (保留)
├── resultProcessor.ts          # 去重排序 (保留)
├── contentExtractor.ts         # [新增] 页面抓取 (Firecrawl 优先 + 轻量 fallback)
├── queryRouter.ts              # [新增] 确定性规则意图识别 + 引擎路由
├── searchMcp.ts                # [新增] web_search MCP (不含 health check)
├── imagesMcp.ts                # [新增] image_search MCP (不含 health check)
├── videosMcp.ts                # [新增] video_search MCP (不含 health check)
├── index.ts                    # [改] 导出 3 个 MCP 集成函数
├── searxngIntegration.ts       # [删除] 被 3 个 MCP 文件替代
└── __tests__/
    ├── contentExtractor.test.ts  # [新增]
    ├── queryRouter.test.ts       # [新增]
    ├── searchMcp.test.ts         # [新增]
    ├── imagesMcp.test.ts         # [新增]
    └── videosMcp.test.ts         # [新增]
```

### `contentExtractor.ts` — 页面正文提取

**设计决策**: 项目已有 Firecrawl 服务（`services/firecrawl/`），具备 JS 渲染、反爬绕过、SSRF 防护、并发控制。优先复用，而非引入 cheerio。

```typescript
import { FirecrawlClient, validateUrl } from '../firecrawl/firecrawlClient.js';
import { getFirecrawlConfigFromEnv } from '../firecrawl/types.js';

const firecrawlConfig = getFirecrawlConfigFromEnv();
const firecrawlClient = firecrawlConfig
  ? new FirecrawlClient(firecrawlConfig.base_url, firecrawlConfig.api_key)
  : null;

export async function fetchAndExtract(
  url: string,
  options?: { maxLength?: number }
): Promise<{ title: string; content: string } | null> {
  const { maxLength = 2000 } = options || {};

  // 优先使用 Firecrawl
  if (firecrawlClient) {
    try {
      const result = await firecrawlClient.scrape(url, {
        onlyMainContent: true,
        formats: ['markdown'],
        timeout: 5000,
      });

      let content = result.markdown || '';
      if (content.length > maxLength) {
        content = content.slice(0, maxLength) + '...';
      }

      return {
        title: result.metadata?.title || '',
        content,
      };
    } catch {
      // Firecrawl 失败，fallback
    }
  }

  // Fallback: 轻量 fetch + 正则提取 (零新增依赖)
  try {
    try { validateUrl(url); } catch { return null; }

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });
    if (!resp.ok) return null;

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const html = await resp.text();

    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '';
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + '...';
    }

    return { title, content: text };
  } catch {
    return null;
  }
}
```

---

## 五、`index.ts` 集成入口

```typescript
export { integrateSearchMcp } from './searchMcp.js';
export { integrateImagesMcp } from './imagesMcp.js';
export { integrateVideosMcp } from './videosMcp.js';
export { getSearxngConfigFromEnv } from './types.js';

export function getSearxngToolNames(): string[] {
  return [
    'mcp__searxng-search__web_search',
    'mcp__searxng-images__image_search',
    'mcp__searxng-videos__video_search',
  ];
}
```

### 调用方 (`claudeUtils.ts`) 改造

Health check 提取到调用方，3 个 MCP 共享一次检查：

> **设计决策**: 旧代码 health check 在 `integrateSearchMcpServer()` 内部。新架构有 3 个 MCP，health check 移到 `claudeUtils.ts` 调用方只做一次。3 个新的 `integrateXxxMcp()` 函数内部**不包含 health check**，假设调用方已确认 SearXNG 可用。

```typescript
import {
  integrateSearchMcp,
  integrateImagesMcp,
  integrateVideosMcp,
  getSearxngConfigFromEnv,
} from '../services/searxng/index.js';

let searxngConfig = getSearxngConfigFromEnv();
if (searxngConfig) {
  // Health check 一次
  try {
    await fetch(`${searxngConfig.base_url}/`, { signal: AbortSignal.timeout(5000) });
  } catch {
    console.warn('[SearXNG] Service unreachable, skipping all 3 MCPs');
    searxngConfig = null;
  }
}
if (searxngConfig) {
  await integrateSearchMcp(queryOptions, searxngConfig);
  await integrateImagesMcp(queryOptions, searxngConfig);
  await integrateVideosMcp(queryOptions, searxngConfig);
  console.log(`[SearXNG] 3 MCP Servers integrated: ${searxngConfig.base_url}`);
}
```

---

## 六、前端工具卡片 (weknora-ui 项目)

### MCP 工具与内置工具的映射区别

`ToolCallRenderer.vue` 中，内置工具和 MCP 工具走不同分支：

```typescript
// 内置工具 — 直接匹配 name
const toolComponents = {
  WebSearch: WebSearchToolCard,   // Claude Code 内置
  WebFetch: WebFetchToolCard,
  // ...
};

// MCP 工具 — 走 mcp__ 前缀分支
if (name.startsWith('mcp__')) {
  // 需要在此处添加新映射
}
```

新的 JSON 结构化输出格式与旧的 markdown/GALLERY 解析逻辑不兼容，需要新建卡片。

### 改造计划

| 工具全名 | 前端卡片 | 改动 |
|--------|---------|------|
| `mcp__searxng-search__web_search` | `SearxngWebSearchToolCard.vue` | **新建**: JSON 结构化搜索结果 + 正文摘要 |
| `mcp__searxng-images__image_search` | `ImageSearchToolCard.vue` | **新建**: 图片画廊 |
| `mcp__searxng-videos__video_search` | `VideoSearchToolCard.vue` | **新建**: 视频画廊 |

### `SearxngWebSearchToolCard.vue` 设计

解析 JSON 输出的 `results` 数组：

- 每条结果：标题（可点击链接）+ URL 域名 + snippet 灰色摘要
- content 有值时：展开按钮显示抓取的正文摘要（默认折叠）
- 底部显示 engines 标签和 suggestions 建议词
- 空结果显示"未找到相关结果"

### `ImageSearchToolCard.vue` 设计

- 布局：CSS Grid 画廊 (3 列, gap 8px)
- 每张图片：缩略图 (thumbnail) + hover 时显示标题
- 点击行为：新标签页打开 sourceUrl（来源页面）
- 空结果："未找到相关图片"

### `VideoSearchToolCard.vue` 设计

- 布局：CSS Grid (2 列, gap 12px)
- 每个视频卡片：缩略图 + duration overlay（右下角半透明黑底白字）+ 标题 + platform 标签 + author
- 点击行为：新标签页打开视频 URL
- 空结果："未找到相关视频"

### `ToolCallRenderer.vue` 映射更新

```typescript
// MCP 工具 -> 专用卡片映射表 (新增)
const mcpToolMapping: Record<string, string> = {
  'mcp__searxng-search__web_search': 'SearxngWebSearch',
  'mcp__searxng-images__image_search': 'ImageSearch',
  'mcp__searxng-videos__video_search': 'VideoSearch',
};

// MCP 工具分支中:
if (name.startsWith('mcp__')) {
  // 保留旧映射 (历史对话 fallback)
  if (name === 'mcp__searxng__searxng_search') {
    return toolComponents['SearxngSearch']
  }
  // 新 MCP 映射
  const mappedKey = mcpToolMapping[name];
  if (mappedKey && toolComponents[mappedKey]) {
    return toolComponents[mappedKey]
  }
  // ...其他 MCP 工具
}
```

### 旧文件处理

| 文件 | 处置 |
|------|------|
| `SearxngSearchToolCard.vue` | **保留 1-2 个月** — 历史对话中 `mcp__searxng__searxng_search` 仍需渲染 |
| `ToolCallRenderer.vue` | **修改** — 添加新 MCP 映射，保留旧 SearxngSearch 映射 |
| `types.ts` | **修改** — 添加 SearxngWebSearch/ImageSearch/VideoSearch 的图标/颜色映射 |

---

## 七、输出格式对比

### Before (文本搜索 — markdown 文本)

```
## Search Results

**Query:** Vue 3 composable best practices
**Found:** 12,345 total, showing 10 (deduplicated)

### [1] [Vue 3 Composition API Guide](https://vuejs.org/guide/)
- **Engines:** google, bing | **Score:** 4.50

> The Composition API is a set of APIs that allows...
```

**问题**: AI 只看到 snippet (<=300字)，无法深入回答。

### After (文本搜索 — 结构化 JSON + 正文)

```json
{
  "query": "Vue 3 composable best practices",
  "intent": "code",
  "results": [
    {
      "title": "Vue 3 Composition API Guide",
      "url": "https://vuejs.org/guide/",
      "snippet": "The Composition API is a set of APIs...",
      "content": "The Composition API is a set of function-based APIs that allow flexible composition of component logic. Unlike the Options API... [2000 chars of actual page content]",
      "engines": ["google", "duckduckgo"]
    }
  ],
  "suggestions": ["vue 3 composable patterns"]
}
```

**改进**: AI 拿到完整页面内容，可以深入准确地回答。

### Before (图片搜索 — 嵌入标记)

```
搜索到 12 个「猫」相关图片，结果已在工具卡片中展示，无需重复描述。
[SEARXNG_GALLERY][{"title":"...","thumbnail":"..."}][/SEARXNG_GALLERY]
来源引擎：google images, bing images
```

### After (图片搜索 — 纯结构化)

```json
{
  "query": "猫",
  "images": [
    {
      "title": "Cute Cat Photo",
      "thumbnail": "https://proxy/image.jpg",
      "fullUrl": "https://original/image.jpg",
      "sourceUrl": "https://source-page.com/cats",
      "format": "jpeg"
    }
  ],
  "engines": ["google images", "bing images", "baidu images"]
}
```

---

## 八、实施阶段

### Phase 1: 后端 MCP 拆分 (核心)

1. 新建 `queryRouter.ts`（确定性规则 + 引擎路由）
2. 新建 `contentExtractor.ts`（复用 Firecrawl + 轻量 fallback）
3. 新建 `searchMcp.ts` (web_search)
4. 新建 `imagesMcp.ts` (image_search)
5. 新建 `videosMcp.ts` (video_search)
6. 改造 `index.ts` 导出
7. 改造 `claudeUtils.ts`：health check 外提 + 调用 3 个 integrate 函数
8. 删除 `searxngIntegration.ts`（确认新工具正常后）
9. 测试: queryRouter + contentExtractor + 3 个 MCP 工具

### Phase 2: 前端卡片拆分

1. 新建 `SearxngWebSearchToolCard.vue`（JSON 结构化结果 + 正文摘要）
2. 新建 `ImageSearchToolCard.vue`（图片画廊 grid）
3. 新建 `VideoSearchToolCard.vue`（视频画廊 grid + duration overlay）
4. 更新 `ToolCallRenderer.vue` MCP 分支添加新映射（保留旧 SearxngSearch 映射）
5. 更新 `types.ts` 添加新工具的图标/颜色
6. **不删除** `SearxngSearchToolCard.vue`（历史对话 fallback，保留 1-2 个月）

> **注意**: 前端改造在 **weknora-ui** 项目（`weknora-ui/src/components/a2a-tools/`），不在 agentstudio。

### Phase 3: 增强 (可选)

1. `web_fetch` 工具 — Firecrawl 不可用时的轻量备选（`searchMcp.ts` 中追加第二个 tool）
2. `web_fetch` 前端卡片
3. 搜索结果缓存（相同 query + type 5 分钟内复用）
4. 抓取结果缓存（相同 URL 10 分钟内复用）

---

## 九、依赖

| 依赖 | 用途 | 当前状态 |
|------|------|---------|
| `@anthropic-ai/claude-agent-sdk` | SDK MCP Server | 已有 |
| `zod` | 参数校验 | 已有 |
| Firecrawl 服务 (`192.168.100.30:3002`) | 页面抓取 | 已有（`services/firecrawl/`），实测正常 |

> **不需要新增依赖**。页面抓取复用 Firecrawl；fallback 用正则提取（零依赖）。

---

## 十、迁移与向后兼容

### 后端迁移

| 步骤 | 操作 |
|------|------|
| 1 | 创建新文件（queryRouter, contentExtractor, 3 个 MCP） |
| 2 | 修改 `index.ts` 导出新函数，同时保留旧的 `integrateSearchMcpServer` 导出 |
| 3 | 修改 `claudeUtils.ts` 调用新函数 |
| 4 | 验证新工具正常后，删除 `searxngIntegration.ts` 和旧导出 |

### 前端迁移

| 步骤 | 操作 |
|------|------|
| 1 | 添加新卡片组件 |
| 2 | `ToolCallRenderer.vue` MCP 分支添加新映射 |
| 3 | **保留** `SearxngSearchToolCard.vue` + `mcp__searxng__searxng_search` 映射 |
| 4 | 历史对话中旧格式仍使用旧卡片，新对话使用新卡片 |

> **原则**: 新旧共存，不破坏历史对话渲染。1-2 个月后确认无旧数据再清理。

---

## 十一、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 抓取超时导致搜索变慢 | web_search 响应从 ~2s 增至 ~5s | Firecrawl 5s + fetch 3s 严格超时，失败只返回 snippet |
| 并发抓取过多 | 目标网站封 IP | searchMcp.ts 外部限制最大并发 5；Firecrawl 客户端内部再限 max 3 (semaphore 排队)；fallback fetch 也受外部 5 并发限制 |
| 正文提取噪音 | content 包含无关内容 | Firecrawl `onlyMainContent`；fallback 正则去除 nav/footer/header |
| 非 HTML 响应 | PDF/图片无法提取 | content-type 检查，非 text/html 返回 null |
| SPA 页面无法提取 | JS 渲染页面内容为空 | Firecrawl 支持 JS 渲染；fallback 降级到 snippet |
| 确定性规则漏判 | 部分查询路由到次优引擎 | `search_type` override 兜底；规则可迭代扩展 |
| google scholar 不稳定 | 学术搜索少一个引擎 | 实测经常 unresponsive，但保留在列表中 |
| 3 个 MCP 增加内存 | MCP Server 实例增多 | 共享 SearXNGClient 实例 |
| 前端旧卡片兼容 | 历史对话需渲染旧格式 | 保留旧卡片 + 旧映射 1-2 个月 |
| Token 预算超标 | max_results=10 时输出过大 | 动态截断: <=5->2000字, 6-8->1200字, 9-10->800字 |
| 非 UTF-8 编码页面 | 中文网站 gb2312/gbk 乱码 | Phase 1 已知限制，降级到 snippet |
| SearXNG 引擎变更 | 实例更新后引擎增删，路由表失效 | 日志记录 unresponsive 引擎；定期对照 `/config` 端点校验 |

---

## 十二、测试策略

### `queryRouter.test.ts`

| 用例 | 输入 | 预期 intent | 命中规则 |
|------|------|------------|---------|
| API 引用 | `"React useEffect 无限循环"` | code | Tier 2: API_PATTERN |
| tech + 动作词 | `"docker 部署报错"` | code | Tier 2: TECH + ACTION 组合 |
| 工具命令 | `"npm install express"` | code | Tier 2: TOOL_COMMAND |
| 错误堆栈 | `"Error: Cannot find module 'xxx'"` | code | Tier 1: 结构特征 |
| arXiv ID | `"arXiv:2401.12345"` | academic | Tier 1: 结构特征 |
| DOI | `"10.1038/s41586-023"` | academic | Tier 1: 结构特征 |
| 学术关键词 | `"transformer 论文 综述"` | academic | Tier 3 |
| 中文新闻 | `"华为今天发布了什么"` | news | Tier 4 |
| 英文新闻 | `"latest breaking news"` | news | Tier 4 |
| time_range=day | `query="技术", timeRange="day"` | news (无 tech 名词) | Tier 4 |
| tech + 时间词歧义 | `"Python 最新版本"` | general | Tier 4 歧义跳过 -> Tier 6 |
| 纯生活查询 | `"好吃的火锅店"` | general | Tier 6 |
| 社区关键词 | `"React vs Vue 对比"` | social | Tier 2 未命中 (无代码动作词) -> Tier 5: SOCIAL |
| 纯社区 | `"最好用的笔记本电脑 推荐"` | social | Tier 5 |
| search_type override | `query="python", searchType="news"` | news | 强制 override |
| zh code 路由 | `"React useEffect", lang=zh` | engines 含 baidu,sogou,quark | zh 追加 general |
| en code 路由 | `"React useEffect bug", lang=en` | engines 不含 baidu | en 仅 base |

### `contentExtractor.test.ts`

- Mock `FirecrawlClient.scrape`，验证优先调用
- Mock Firecrawl 抛异常，验证 fallback 到 fetch + 正则
- Mock `fetch` 返回预制 HTML，验证标题/正文提取
- 验证 maxLength 截断
- 验证非 HTML content-type 返回 null
- 验证超时返回 null
- 验证 SSRF 防护（内网 URL 返回 null）

### `searchMcp.test.ts` / `imagesMcp.test.ts` / `videosMcp.test.ts`

- Mock SearXNGClient，验证工具参数传递
- 验证 Token 预算（max_results 不同值对应不同截断长度）
- 验证图片 URL `//` 前缀修复
- 验证视频 platform 推断

---

## 十三、日志规范

`web_search` 工具返回时输出结构化日志：

```typescript
console.log('[WebSearch]', JSON.stringify({
  query,
  intent: analysis.intent,
  lang: analysis.lang,
  engines: analysis.engines,
  resultCount: results.length,
  fetchedCount: results.filter(r => r.content).length,
  failedCount: results.filter(r => !r.content).length,
  totalMs: Date.now() - startTime,
}));
```

---

## 附录 A: SearXNG 实例引擎清单

> 以下数据于 2026-03-06 从 `192.168.100.30:8888/config` 实时查询获取，共 109 个启用引擎。

| 分类 | 数量 | 引擎列表 |
|------|------|---------|
| general (12) | 12 | baidu, brave, dictzone, duckduckgo, google, lingva, mymemory translated, quark, sogou, startpage, wikidata, wikipedia |
| news (10) | 10 | bing news, brave.news, duckduckgo news, google news, qwant news, reuters, sogou wechat, startpage news, wikinews, yahoo news |
| it (16) | 16 | arch linux wiki, askubuntu, codeberg, crates.io, docker hub, gentoo, github, hackernews, hoogle, mankier, mdn, microsoft learn, npm, pypi, stackoverflow, superuser |
| science (9) | 9 | arxiv, crossref, google scholar, openairedatasets, openairepublications, openalex, pdbe, pubmed, semantic scholar |
| images (18) | 18 | artic, baidu images, bing images, brave.images, deviantart, devicons, duckduckgo images, flickr, google images, lucide, openverse, pexels, pinterest, quark images, qwant images, startpage images, unsplash, wikicommons.images |
| videos (11) | 11 | bilibili, bing videos, brave.videos, dailymotion, duckduckgo videos, google videos, qwant videos, sepiasearch, vimeo, wikicommons.videos, youtube |
| social media (8) | 8 | lemmy communities, lemmy users, lemmy posts, lemmy comments, mastodon users, mastodon hashtags, reddit, tootfinder |
| music (5) | 5 | bandcamp, genius, mixcloud, radio browser, soundcloud |
| files (8) | 8 | 1337x, annas archive, bt4g, kickass, nyaa, piratebay, solidtorrents, wikicommons.files |
| packages (1) | 1 | pkg.go.dev |
| map (2) | 2 | openstreetmap, photon |
| dictionaries (3) | 3 | etymonline, wiktionary, wordnik |
| currency (1) | 1 | currency |
| weather (1) | 1 | wttr.in |
| other (2) | 2 | chefkoch, podcastindex |

### v1 设计中的错误引擎（已修正）

| v1 写的 | 实际情况 | v2 修正 |
|---------|---------|---------|
| `chinaso news` | 实例中不存在 | 从 news 引擎列表移除 |
| `github code` | 实例中不存在，只有 `github` | 改为 `github` |
| `bing`（通用搜索） | 实例中不存在，只有 bing images/news/videos | 从 general 引擎列表移除 |
