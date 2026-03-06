# SearXNG MCP 拆分重构设计方案

> **日期**: 2026-03-05
> **状态**: ~~设计方案~~ **已废弃** — 被 `2026-03-06-searxng-mcp-split-design-v2.md` 取代
> **废弃原因**: 3 个捏造引擎 (chinaso news, github code, bing)、加权投票算法有结构性缺陷、引擎路由表未经实测验证
> **目标**: 将单一 `searxng_search` 工具拆分为 3 个专职 MCP，引入 **搜索+抓取** pipeline 提升文本搜索质量

---

## 一、现状分析

### 当前架构

```
searxng MCP (1 个工具)
└── searxng_search
    ├── 通用搜索 (general/news/code/academic)
    ├── 图片搜索 (images)
    └── 视频搜索 (videos)
```

### 现有问题

| 问题 | 说明 |
|------|------|
| **工具职责过重** | 一个工具承担文本/图片/视频三种完全不同的搜索，TOOL_DESCRIPTION 长达 40+ 行 |
| **AI 选择引擎困难** | AI 需要从 100+ 引擎中自行挑选，经常选错（如搜新闻时忘了加 news 后缀） |
| **文本结果信息量不足** | 只返回 SearXNG 的 snippet（150-300 字），AI 无法获取页面全文，回答浅薄 |
| **图片/视频混在文本流** | 媒体结果用 `[SEARXNG_GALLERY]` 标记嵌入文本，依赖前端正则解析，脆弱 |
| **前端卡片复杂** | SearxngSearchToolCard 同时处理文本/图片/视频三种渲染，逻辑臃肿 |

---

## 二、目标架构

```
┌─────────────────────────────────────────────────────────┐
│  3 个独立 MCP Server                                     │
│                                                          │
│  searxng-search MCP          searxng-images MCP          │
│  ├── web_search              ├── image_search            │
│  └── web_fetch (Phase 3)     └── (无需 fetch)            │
│                                                          │
│  searxng-videos MCP                                      │
│  └── video_search                                        │
└─────────────────────────────────────────────────────────┘
```

### MCP Server 命名规范

遵循项目现有 SDK MCP 命名惯例（连字符）：

| MCP Server Name | mcpServers key | 工具全名 |
|----------------|---------------|---------|
| `searxng-search` | `'searxng-search'` | `mcp__searxng-search__web_search` (Phase 1), `mcp__searxng-search__web_fetch` (Phase 3) |
| `searxng-images` | `'searxng-images'` | `mcp__searxng-images__image_search` |
| `searxng-videos` | `'searxng-videos'` | `mcp__searxng-videos__video_search` |

> 参考现有命名：`firecrawl`→`mcp__firecrawl__*`, `a2a-client`→`mcp__a2a-client__*`, `ask-user-question`→`mcp__ask-user-question__*`

### 核心改进

1. **web_search = 搜索 + 抓取 pipeline**（参考 Claude Code WebSearch 设计）
2. **image_search / video_search 独立工具**，返回结构化媒体数据
3. **AI 不需要选引擎**，工具内部自动识别查询意图 + 按语言智能路由

---

## 三、工具详细设计

### 3.1 searxng-search MCP

#### 工具 1: `web_search`

**设计哲学**: 搜索 + 浅层抓取，让 AI 拿到有实质内容的结果。

```typescript
// 输入
interface WebSearchInput {
  query: string           // 搜索关键词 (必填)
  time_range?: 'day' | 'week' | 'month' | 'year'  // 时间过滤
  search_type?: 'general' | 'news' | 'code' | 'academic'  // 可选 override，通常不需要传（系统自动识别意图）
  max_results?: number    // 返回数量, 默认 5, 最大 10
}

// 输出
interface WebSearchOutput {
  query: string
  intent: string          // 自动识别的意图 (general/news/code/academic/social)
  results: Array<{
    title: string
    url: string
    snippet: string       // SearXNG 返回的摘要
    content?: string      // 抓取提取的正文 (动态截断，见 Token 预算)
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
       ▼
┌──────────────────────────────────────────┐
│  Step 1: queryRouter.analyzeQuery()      │
│                                          │
│  ① 语言检测: CJK→zh, ASCII→en, 混合→other│
│  ② 意图自动识别 (关键词+结构+time_range) │
│  ③ search_type 传了则强制 override       │
│  → 输出: { intent, confidence, engines,  │
│            languageCode }                │
│                                          │
│  详见 三.5 节                             │
└──────────┬───────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│  Step 2: SearXNG 搜索                    │
│                                          │
│  请求 pageno=1 (SearXNG 默认返回 ~10 条) │
│  dedupeAndRank → Top N                   │
│                                          │
│  注: SearXNG API 无 max_results 参数，   │
│  返回数量由实例配置决定 (默认 10 条/页)。 │
│  客户端 dedupeAndRank 截断到 max_results。│
└──────────┬───────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│  Step 3: 并发抓取 Top N 页面             │
│                                          │
│  Promise.allSettled + 共享 AbortController│
│  - 优先 Firecrawl (JS渲染+反爬+SSRF防护)│
│  - Firecrawl 不可用时 fallback 轻量 fetch│
│  - 最大并发 5 (超出排队等待)             │
│  - 每页独立超时 (Firecrawl 5s / fetch 3s)│
│  - 失败静默跳过 (仍有 snippet)           │
│  - 跳过非 HTML 响应 (PDF 等)             │
└──────────┬───────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│  Step 4: 正文提取                        │
│                                          │
│  Firecrawl: 直接返回 markdown            │
│  Fallback: 正则移除标签 + 段落保留       │
│  按 Token 预算截断 (见下方)              │
└──────────┬───────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│  Step 5: 组装返回                        │
│                                          │
│  每条结果 = snippet + content            │
│  返回纯结构化 JSON (非 markdown)         │
│                                          │
│  Token 预算 (总输出 ~12000 字以内):      │
│  max_results ≤ 5 → content 截断 2000 字  │
│  max_results 6-8 → content 截断 1200 字  │
│  max_results 9-10 → content 截断 800 字  │
└──────────────────────────────────────────┘
```

**TOOL_DESCRIPTION** (最终版):

```
Search the web and fetch page content for comprehensive results.
The search engine is automatically selected based on query content.
Most queries work well with auto-detection; use search_type only if results seem off-topic.

Parameters:
- query: Search keywords
- search_type (optional): Override auto-detection when results are not relevant. "general", "news", "code", "academic"
- time_range: "day", "week", "month", "year"
- max_results: 1-10, default 5

Auto-detection examples:
- "React useEffect bug" → code engines (GitHub, StackOverflow, MDN)
- "今天新闻" → news engines (Google News, Bing News, ChinaSo)
- "transformer paper arxiv" → academic engines (Google Scholar, arXiv)
- "好吃的餐厅" → general engines (Google, Baidu, Bing)

Returns structured results with page content excerpts.
```

#### 工具 2: `web_fetch` (Phase 3 实现)

当 AI 需要深入阅读某个搜索结果的完整页面时使用。

```typescript
interface WebFetchInput {
  url: string             // 要抓取的 URL
  max_length?: number     // 最大字符数, 默认 10000
}

interface WebFetchOutput {
  url: string
  title: string
  content: string         // 完整正文 (截断)
  byline?: string         // 作者
  publishedDate?: string
}
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

- 引擎列表（唯一数据源，与 queryRouter 无关）:
  - base: `google images,bing images,baidu images,unsplash,pexels,flickr`
  - 中文 query 追加: `quark images`
- 图片 URL 修复: `//` 前缀补 `https:`
- 通过 SearXNG `image_proxy=true` 代理缩略图避免防盗链
- **不需要抓取页面** — 图片搜索只需元数据

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

- 引擎列表（唯一数据源，与 queryRouter 无关）:
  - base: `youtube,google videos,bing videos`
  - 中文 query 追加: `bilibili`
- 从 URL 推断 platform (youtube.com → youtube, bilibili.com → bilibili)
- **不需要抓取页面**

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

旧方案：AI 从 109 个引擎中手动挑选，或传 `search_type` 参数 → 经常选错、漏选。

新方案：**系统自动识别查询意图，智能路由到最优引擎组合**。`search_type` 降级为可选 override，绝大多数场景 AI 不需要传。

### 意图识别策略

采用 **规则优先 + 多信号融合** 的轻量方案（不依赖 LLM，零延迟）：

```
query 输入
    │
    ▼
┌───────────────────────────────────────────────────┐
│  Step 1: 语言检测                                   │
│  CJK → zh | ASCII → en | 混合 → other              │
└───────────────┬───────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────┐
│  Step 2: 意图分类 (多信号投票)                       │
│                                                     │
│  信号源:                                            │
│  ① 关键词模式匹配 (权重 0.6)                        │
│  ② time_range 参数暗示 (权重 0.2)                   │
│  ③ 查询结构特征 (权重 0.2)                          │
│                                                     │
│  → 输出: { intent, confidence }                     │
│  → confidence < 0.4 时 fallback 到 general          │
└───────────────┬───────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────┐
│  Step 3: 引擎路由                                   │
│                                                     │
│  intent + lang → 引擎组合                           │
│  如果 AI 传了 search_type → 以 search_type 为准     │
│  (search_type 是强制 override)                      │
└───────────────────────────────────────────────────┘
```

### 意图分类详细规则

#### ① 关键词模式匹配

| 意图 | 中文关键词 | 英文关键词 | 说明 |
|------|-----------|-----------|------|
| **news** | 最新、今日、今天、昨天、发布、宣布、事件、事故、政策、声明、通报 | latest, breaking, announced, released, news, today, yesterday, update, report | 时事新闻 |
| **code** | 报错、错误、安装、依赖、配置、框架、代码、函数、接口、部署 | error, bug, install, npm, pip, import, function, class, API, SDK, debug, deploy, config, docker, git, regex + 框架名(react, vue, angular, next.js, django, express...) + React/Vue API(useEffect, useState, composable, ref()...) | 编程技术 |
| **academic** | 论文、研究、算法、实验、模型、综述、学术 | paper, research, study, algorithm, thesis, survey, arxiv, doi, journal, citation | 学术研究 |
| **social** | 讨论、评价、推荐、体验、吐槽、测评 | reddit, review, opinion, experience, recommend, vs, comparison | 社区讨论 |

**匹配规则**：
- 单个关键词命中 → confidence += 0.3
- 两个及以上命中 → confidence += 0.6（如 code 的 4 个 patterns 中命中 2 个以上）
- 技术名词（如 `React`, `Python`, `Docker`）+ 动作词（如 `安装`, `error`）组合 → 自然命中多个 patterns，confidence 累加到 0.6

#### ② time_range 参数暗示

| time_range | 暗示意图 | confidence 加成 |
|-----------|---------|----------------|
| `day` | news | +0.3 |
| `week` | news | +0.2 |
| `month` | general | +0.0 |
| `year` | general / academic | +0.0 |

#### ③ 查询结构特征

| 特征 | 识别方法 | 意图 | confidence 加成 |
|------|---------|------|----------------|
| 错误堆栈 | 包含 `at line`, `Traceback`, `Exception`, `Error:` | code | +0.5 |
| 包名/版本号 | 匹配 `xxx@1.2.3`, `xxx==1.2.3`, `v1.2.3` | code | +0.4 |
| DOI/arXiv ID | 匹配 `10.xxxx/`, `arXiv:xxxx` | academic | +0.8 |
| URL 片段 | 包含 `github.com`, `stackoverflow.com` | code | +0.3 |
| 问句 | 以 `怎么`/`如何`/`为什么`/`how`/`why`/`what is` 开头 | general | +0.1 |

### 意图到引擎路由表

> 路由表定义在 `queryRouter.ts` 的 `INTENT_ENGINE_MAP` 中（见下方代码），仅服务于 `web_search`。
> `image_search` 和 `video_search` 各自维护引擎列表（见三.2/三.3节），不走 queryRouter。

### 混合路由策略

当意图置信度处于中间地带时，使用混合引擎组合：

| confidence 区间 | 路由策略 |
|----------------|---------|
| **≥ 0.6** | 纯意图引擎（如纯 code 引擎） |
| **0.4 ~ 0.6** | 意图引擎 + general 前 3 引擎混合 |
| **< 0.4** | 纯 general 引擎 |

**示例**：

| 查询 | 检测意图 | confidence | 实际引擎 |
|------|---------|-----------|---------|
| `"React useEffect 无限循环"` | code | 0.6 | github,stackoverflow,mdn,npm,pypi,docker hub |
| `"华为 今天 发布"` | news | 0.3→general | google,duckduckgo,bing,baidu,sogou,quark |
| `"transformer attention mechanism paper"` | academic | 0.9 | google scholar,arxiv,semantic scholar,pubmed,crossref |
| `"arXiv:2401.12345"` | academic | 0.8 | google scholar,arxiv,semantic scholar,pubmed,crossref |
| `"Python 最新版本"` | code+news 混合 | code 0.6, news 0.3 → code | github,stackoverflow,mdn,npm,pypi,docker hub |
| `"React useEffect 最新版本今天发布了吗"` | code+news 混合 | code 0.6, news 0.3 → code | github,stackoverflow,mdn,npm,pypi,docker hub |
| `"好吃的火锅店"` | general | 0.0 | google,duckduckgo,bing,baidu,sogou,quark |

### `queryRouter.ts` 实现（替代 `searxngIntegration.ts` 中的引擎选择逻辑）

```typescript
// agentstudio/backend/src/services/searxng/queryRouter.ts

// web_search 的 Zod search_type 枚举 (暴露给 AI 的可选 override)
export type SearchTypeOverride = 'general' | 'news' | 'code' | 'academic';

// 内部意图 (包含 social，但 social 不暴露给 AI，仅自动检测触发)
export type SearchIntent = 'general' | 'news' | 'code' | 'academic' | 'social';
export type QueryLanguage = 'zh' | 'en' | 'other';

export interface QueryAnalysis {
  lang: QueryLanguage;
  intent: SearchIntent;
  confidence: number;
  engines: string;
  languageCode: string;
}

// ─── 语言检测 ───

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f]/;

export function detectLanguage(query: string): QueryLanguage {
  if (CJK_REGEX.test(query)) return 'zh';
  if (/^[a-zA-Z0-9\s\-_.,:;!?'"()\[\]{}@#$%^&*+=<>/\\|`~]+$/.test(query)) return 'en';
  return 'other';
}

// ─── 意图识别 ───

// 关键词模式 (编译一次，复用)
const INTENT_PATTERNS: Array<{ intent: SearchIntent; patterns: RegExp[]; weight: number }> = [
  {
    intent: 'news',
    patterns: [
      /最新|今[日天]|昨天|发布|宣布|事[件故]|政策|声明|通报|突发|官宣/,
      /\b(latest|breaking|announced|released|news|today|yesterday|update[ds]?|report[s]?)\b/i,
    ],
    weight: 0.3,
  },
  {
    intent: 'code',
    patterns: [
      /报错|错误|安装|依赖|配置|框架|代码|函数|接口|部署|编译|调试/,
      /\b(error|bug|install|npm|pip|yarn|pnpm|import|function|class|api|sdk|debug|deploy|config|docker|git|regex|webpack|vite|eslint|typescript|python|java|golang|rust)\b/i,
      // 常见框架/库名 — 单独匹配，作为第三信号源
      /\b(react|vue|angular|svelte|nextjs|next\.js|nuxt|astro|remix|express|nestjs|fastapi|django|flask|spring|laravel|rails|tailwind|prisma|drizzle|mongoose|sequelize|graphql|redis|postgres|mysql|mongodb|sqlite|supabase|firebase|aws|gcp|azure|vercel|netlify|kubernetes|k8s|terraform|ansible|nginx|caddy|linux|macos|ubuntu|centos|homebrew|apt|brew)\b/i,
      // React/Vue 常见 API — 增强技术查询识别
      /\b(use[A-Z]\w+|useState|useEffect|useRef|useMemo|useCallback|useContext|useReducer|composable|defineProps|defineEmits|watchEffect|onMounted|ref\(|reactive\(|computed\()\b/,
    ],
    weight: 0.3,
  },
  {
    intent: 'academic',
    patterns: [
      /论文|研究|算法|实验|模型|综述|学术|引用/,
      /\b(paper|research|study|algorithm|thesis|survey|arxiv|doi|journal|citation|SOTA|benchmark|dataset)\b/i,
    ],
    weight: 0.3,
  },
  {
    intent: 'social',
    patterns: [
      /讨论|评价|推荐|体验|吐槽|测评|口碑|对比/,
      /\b(reddit|review|opinion|experience|recommend|vs|comparison|alternative)\b/i,
    ],
    weight: 0.3,
  },
];

// 结构特征
const STRUCTURE_PATTERNS: Array<{ intent: SearchIntent; pattern: RegExp; weight: number }> = [
  // 错误堆栈
  { intent: 'code', pattern: /at line|Traceback|Exception|Error:|FAILED|Cannot find|Module not found|No module named/i, weight: 0.5 },
  // 包名@版本
  { intent: 'code', pattern: /\S+@\d+\.\d+|==\d+\.\d+|\bv\d+\.\d+\.\d+\b/, weight: 0.4 },
  // DOI / arXiv ID
  { intent: 'academic', pattern: /10\.\d{4,}\/|arXiv:\d{4}\.\d+/i, weight: 0.8 },
  // GitHub URL
  { intent: 'code', pattern: /github\.com\/|stackoverflow\.com\/|npmjs\.com\//i, weight: 0.3 },
];

function detectIntent(
  query: string,
  timeRange?: string
): { intent: SearchIntent; confidence: number } {
  const scores = new Map<SearchIntent, number>();

  // ① 关键词模式匹配
  for (const { intent, patterns, weight } of INTENT_PATTERNS) {
    let matchCount = 0;
    for (const p of patterns) {
      if (p.test(query)) matchCount++;
    }
    if (matchCount > 0) {
      const bonus = matchCount >= 2 ? weight * 2 : weight;
      scores.set(intent, (scores.get(intent) || 0) + bonus);
    }
  }

  // ② 结构特征
  for (const { intent, pattern, weight } of STRUCTURE_PATTERNS) {
    if (pattern.test(query)) {
      scores.set(intent, (scores.get(intent) || 0) + weight);
    }
  }

  // ③ time_range 暗示
  if (timeRange === 'day') {
    scores.set('news', (scores.get('news') || 0) + 0.3);
  } else if (timeRange === 'week') {
    scores.set('news', (scores.get('news') || 0) + 0.2);
  }

  // 取最高分 (clamp 到 [0, 1])
  let bestIntent: SearchIntent = 'general';
  let bestScore = 0;
  for (const [intent, score] of scores) {
    if (score > bestScore) {
      bestIntent = intent;
      bestScore = score;
    }
  }

  return { intent: bestIntent, confidence: Math.min(bestScore, 1.0) };
}

// ─── 引擎路由 ───

// 仅包含 web_search 的意图。images/videos 有各自 MCP 的引擎列表，不在此处。
const INTENT_ENGINE_MAP: Record<SearchIntent, { base: string; zh: string }> = {
  general:  { base: 'google,duckduckgo,bing,brave,wikipedia', zh: ',baidu,sogou,quark' },
  news:     { base: 'google news,bing news,yahoo news,duckduckgo news,wikinews', zh: ',chinaso news' },
  code:     { base: 'github,github code,stackoverflow,mdn,npm,pypi,docker hub', zh: '' },
  academic: { base: 'google scholar,arxiv,semantic scholar,pubmed,crossref', zh: '' },
  social:   { base: 'reddit,hackernews,stackoverflow,google,bing', zh: '' },
};

// 混合路由时追加的 general 引擎（显式列出，不依赖 slice 截取）
const GENERAL_FALLBACK_ENGINES = {
  base: 'google,duckduckgo,bing',
  zh: ',baidu',
};

function resolveEngines(intent: SearchIntent, confidence: number, lang: QueryLanguage): string {
  // 置信度太低，直接用 general
  if (confidence < 0.4) {
    const general = INTENT_ENGINE_MAP.general;
    return general.base + (lang === 'zh' ? general.zh : '');
  }

  const target = INTENT_ENGINE_MAP[intent];
  let engines = target.base + (lang === 'zh' ? target.zh : '');

  // 混合路由: 置信度不高时，追加 general 兜底引擎
  if (confidence < 0.6 && intent !== 'general') {
    engines += ',' + GENERAL_FALLBACK_ENGINES.base + (lang === 'zh' ? GENERAL_FALLBACK_ENGINES.zh : '');
  }

  return engines;
}

// ─── 主入口 ───

export function analyzeQuery(
  query: string,
  options?: { searchType?: SearchTypeOverride; timeRange?: string }
): QueryAnalysis {
  const lang = detectLanguage(query);

  // 如果 AI 显式传了 search_type，直接使用（强制 override）
  if (options?.searchType) {
    const engines = resolveEngines(options.searchType, 1.0, lang);
    const result: QueryAnalysis = {
      lang,
      intent: options.searchType,
      confidence: 1.0,
      engines,
      languageCode: lang === 'zh' ? 'zh-CN' : lang === 'en' ? 'en' : 'all',
    };
    console.log(`[QueryRouter] "${query}" → override=${options.searchType} lang=${lang} engines=${engines}`);
    return result;
  }

  // 否则自动识别意图
  const { intent, confidence } = detectIntent(query, options?.timeRange);
  const engines = resolveEngines(intent, confidence, lang);

  console.log(`[QueryRouter] "${query}" → intent=${intent}(${confidence.toFixed(2)}) lang=${lang} engines=${engines}`);

  return {
    lang,
    intent,
    confidence,
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
├── queryRouter.ts              # [新增] 查询意图识别 + 引擎智能路由 (替代 searxngIntegration 中的引擎选择逻辑)
├── searchMcp.ts                # [新增] web_search MCP (web_fetch 留 Phase 3)
├── imagesMcp.ts                # [新增] image_search MCP
├── videosMcp.ts                # [新增] video_search MCP
├── index.ts                    # [改] 导出 3 个 MCP 集成函数
├── searxngIntegration.ts       # [删除] 被 3 个 MCP 文件替代
└── __tests__/
    ├── contentExtractor.test.ts  # [新增]
    ├── queryRouter.test.ts       # [新增] 意图识别 + 引擎路由测试
    ├── searchMcp.test.ts         # [新增]
    ├── imagesMcp.test.ts         # [新增]
    └── videosMcp.test.ts         # [新增]
```

### 关键新文件

#### `contentExtractor.ts` — 页面正文提取（复用 Firecrawl + 轻量 fallback）

**设计决策**：项目已有 Firecrawl 服务（`services/firecrawl/`），具备 JS 渲染、反爬绕过、SSRF 防护、并发控制。`web_search` 的页面抓取应优先复用 Firecrawl，而非用 cheerio 重新造轮子。

**双层策略**：
- **Firecrawl 可用时**：调用 `FirecrawlClient.scrape()` 获取 markdown，质量高
- **Firecrawl 不可用时**：fallback 到轻量 fetch + 正则提取（无需 cheerio 依赖）

```typescript
import { FirecrawlClient, validateUrl } from '../firecrawl/firecrawlClient.js';
import type { FirecrawlConfig } from '../firecrawl/types.js';
import { getFirecrawlConfigFromEnv } from '../firecrawl/types.js';

// 复用 Firecrawl 配置 (环境变量驱动)
const firecrawlConfig = getFirecrawlConfigFromEnv();
const firecrawlClient = firecrawlConfig
  ? new FirecrawlClient(firecrawlConfig.base_url, firecrawlConfig.api_key)
  : null;

export async function fetchAndExtract(
  url: string,
  options?: { maxLength?: number }
): Promise<{ title: string; content: string } | null> {
  const { maxLength = 2000 } = options || {};

  // 优先使用 Firecrawl (JS 渲染 + 反爬 + SSRF 防护 + 主内容提取)
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
      // Firecrawl 失败，fallback 到轻量方案
    }
  }

  // Fallback: 轻量 fetch + 简单文本提取 (无 cheerio 依赖)
  try {
    // SSRF 防护：复用 Firecrawl 的 validateUrl
    try { validateUrl(url); } catch { return null; }

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });
    if (!resp.ok) return null;

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const html = await resp.text();

    // 轻量提取：正则移除标签 + 保留段落结构
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

**优势**：
- Firecrawl 可用时：JS 渲染、反爬绕过、SSRF 防护、干净 markdown，质量远超 cheerio
- Firecrawl 不可用时：零依赖 fallback（正则提取，质量略低但可用）
- **无需新增 cheerio 依赖**
```

#### `queryRouter.ts` — 查询意图识别 + 引擎智能路由

> 详见 **三.5 节**完整设计。替代原 `searxngIntegration.ts` 中的 `DEFAULT_ENGINES` + TOOL_DESCRIPTION 引擎选择逻辑，核心入口函数：

```typescript
import { analyzeQuery } from './queryRouter.js';

// web_search 工具内调用:
const analysis = analyzeQuery(query, { searchType, timeRange });
// analysis = { lang, intent, confidence, engines, languageCode }

// 直接用 analysis.engines 传给 SearXNGClient
const response = await client.search({
  q: query,
  engines: analysis.engines,
  language: analysis.languageCode,
  time_range,
});
```

---

## 五、`index.ts` 集成入口 (改造后)

```typescript
export { integrateSearchMcp } from './searchMcp.js';
export { integrateImagesMcp } from './imagesMcp.js';
export { integrateVideosMcp } from './videosMcp.js';
export { getSearxngConfigFromEnv } from './types.js';

export function getSearxngToolNames(): string[] {
  return [
    'mcp__searxng-search__web_search',
    // 'mcp__searxng-search__web_fetch',  // Phase 3 追加
    'mcp__searxng-images__image_search',
    'mcp__searxng-videos__video_search',
  ];
}
```

### 调用方 (`claudeUtils.ts`) 改造

Health check 提取到调用方，避免 3 个 MCP 各做一次（共享同一个 SearXNG 实例）：

```typescript
// Before:
import { integrateSearchMcpServer, getSearxngConfigFromEnv } from '../services/searxng/index.js';
const searxngConfig = getSearxngConfigFromEnv();
if (searxngConfig) {
  await integrateSearchMcpServer(queryOptions, searxngConfig);
}

// After:
import {
  integrateSearchMcp,
  integrateImagesMcp,
  integrateVideosMcp,
  getSearxngConfigFromEnv,
} from '../services/searxng/index.js';

let searxngConfig = getSearxngConfigFromEnv();
if (searxngConfig) {
  // Health check 一次，3 个 MCP 共享结果
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

### 重要：MCP 工具与内置工具的映射区别

`ToolCallRenderer.vue` 中，内置工具（如 `WebSearch`、`WebFetch`）和 MCP 工具（如 `mcp__searxng-search__web_search`）走不同的分支：

```typescript
// 内置工具 — 直接匹配 name
const toolComponents = {
  WebSearch: WebSearchToolCard,   // Claude Code 内置 WebSearch
  WebFetch: WebFetchToolCard,     // Claude Code 内置 WebFetch
  // ...
};

// MCP 工具 — 走 mcp__ 前缀分支
if (name.startsWith('mcp__')) {
  // 需要在此处添加新映射，否则会落入通用 McpToolCard
}
```

因此**不能直接"复用"WebSearchToolCard/WebFetchToolCard**，需要在 MCP 分支中显式映射。且新的 JSON 结构化输出格式与旧的 markdown 解析逻辑不兼容，需要新建卡片。

### 改造计划

| 工具全名 | 前端卡片 | 改动 |
|--------|---------|------|
| `mcp__searxng-search__web_search` | `SearxngWebSearchToolCard.vue` | **新建**: 渲染 JSON 结构化搜索结果 + 正文摘要 |
| `mcp__searxng-search__web_fetch` | `WebFetchToolCard.vue` | **MCP 分支映射**: 输出格式与内置 WebFetch 兼容，可复用 |
| `mcp__searxng-images__image_search` | `ImageSearchToolCard.vue` | **新建**: 图片画廊 |
| `mcp__searxng-videos__video_search` | `VideoSearchToolCard.vue` | **新建**: 视频画廊 |

### `SearxngWebSearchToolCard.vue` 设计

解析 JSON 输出的 `results` 数组，渲染为搜索结果卡片列表：

- 每条结果：标题（可点击链接）+ URL 域名 + snippet 灰色摘要
- content 有值时：展开按钮显示抓取的正文摘要（默认折叠）
- 底部显示 engines 标签和 suggestions 建议词
- 空结果显示"未找到相关结果"

### `ImageSearchToolCard.vue` 设计

- 布局：CSS Grid 画廊 (3 列, gap 8px)
- 每张图片：缩略图（thumbnail）+ hover 时显示标题
- 点击行为：新标签页打开 sourceUrl（来源页面）
- 空结果：显示"未找到相关图片"

### `VideoSearchToolCard.vue` 设计

- 布局：CSS Grid (2 列, gap 12px)
- 每个视频卡片：缩略图 + duration overlay（右下角半透明黑底白字）+ 标题 + platform 标签 + author
- 点击行为：新标签页打开视频 URL
- 空结果：显示"未找到相关视频"

### `ToolCallRenderer.vue` 映射更新

在 MCP 分支中添加映射表（与现有 `toolComponents` 风格一致）：

```typescript
// MCP 工具 → 专用卡片映射表 (新增)
const mcpToolMapping: Record<string, string> = {
  'mcp__searxng-search__web_search': 'SearxngWebSearch',
  // 'mcp__searxng-search__web_fetch': 'WebFetch',  // Phase 3
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

> **注意**: `web_fetch` 的卡片复用需验证 — 内置 WebFetch 卡片解析 markdown 格式，而 MCP `web_fetch` 返回 JSON。如格式不兼容，需新建 `SearxngWebFetchToolCard.vue` 或在 WebFetch 卡片中增加 JSON 解析分支。此问题在 Phase 3 实现 `web_fetch` 时解决。
```

### 旧文件处理

| 文件 | 处置 |
|------|------|
| `SearxngSearchToolCard.vue` | **保留 fallback** — 历史对话中 `mcp__searxng__searxng_search` 仍需渲染，保留映射 |
| `ToolCallRenderer.vue` | **修改** — 添加新 MCP 映射，保留旧 SearxngSearch 映射 |
| `types.ts` | **修改** — 添加 SearxngWebSearch/ImageSearch/VideoSearch 的图标/颜色映射 |

---

## 七、输出格式对比

### Before (文本搜索 — 纯 markdown 文本)

```
## Search Results

**Query:** Vue 3 composable best practices
**Found:** 12,345 total, showing 10 (deduplicated)

### [1] [Vue 3 Composition API Guide](https://vuejs.org/guide/)
- **Engines:** google, bing | **Score:** 4.50

> The Composition API is a set of APIs that allows...
```

**问题**: AI 只看到 snippet，无法深入回答。

### After (文本搜索 — 结构化 JSON + 正文)

```json
{
  "query": "Vue 3 composable best practices",
  "results": [
    {
      "title": "Vue 3 Composition API Guide",
      "url": "https://vuejs.org/guide/",
      "snippet": "The Composition API is a set of APIs...",
      "content": "The Composition API is a set of function-based APIs that allow flexible composition of component logic. Unlike the Options API, the Composition API organizes code by logical concern rather than option type. Key patterns include: 1) Composables for reusable stateful logic... [2000 chars of actual page content]",
      "engines": ["google", "bing"]
    }
  ],
  "suggestions": ["vue 3 composable patterns", "vue 3 hooks"]
}
```

**改进**: AI 拿到了完整页面内容，可以深入准确地回答。

### Before (图片搜索 — 嵌入标记)

```
搜索到 12 个「猫」相关图片，结果已在工具卡片中展示，无需重复描述。
[SEARXNG_GALLERY][{"title":"...","thumbnail":"..."}][/SEARXNG_GALLERY]
来源引擎：google images, bing images
```

**问题**: 文本和结构化数据混在一起，依赖正则解析。

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

**改进**: 纯 JSON 输出，前端直接解析，不需要正则。

---

## 八、实施阶段

### Phase 1: 后端 MCP 拆分 (核心)

1. 新建 `contentExtractor.ts`（复用 Firecrawl + 轻量 fallback）+ `queryRouter.ts`（含意图识别 + 引擎智能路由）
2. 新建 `searchMcp.ts` (web_search)
3. 新建 `imagesMcp.ts` (image_search)
4. 新建 `videosMcp.ts` (video_search)
5. 改造 `index.ts` 导出
6. 改造 `claudeUtils.ts`：health check 外提 + 调用 3 个 integrate 函数
7. 删除 `searxngIntegration.ts`（确认新工具正常后）
8. 测试: 全部工具调用测试

### Phase 2: 前端卡片拆分

1. 新建 `SearxngWebSearchToolCard.vue`（JSON 结构化结果 + 正文摘要）
2. 新建 `ImageSearchToolCard.vue`（图片画廊 grid）
3. 新建 `VideoSearchToolCard.vue`（视频画廊 grid + duration overlay）
4. 更新 `ToolCallRenderer.vue` MCP 分支添加新映射（保留旧 SearxngSearch 映射）
5. 更新 `types.ts` 添加新工具的图标/颜色
6. **不删除** `SearxngSearchToolCard.vue`（历史对话 fallback）

> **注意**: 前端改造在 **weknora-ui** 项目（`weknora-ui/src/components/a2a-tools/`），不在 agentstudio。

### Phase 3: 增强 (可选)

1. `web_fetch` 工具实现（`searchMcp.ts` 中追加第二个 tool，`getSearxngToolNames()` 追加工具名）
2. `web_fetch` 前端卡片（验证是否可复用 WebFetchToolCard 或需新建）
3. 搜索结果缓存（相同 query + type 5 分钟内复用）
4. 抓取结果缓存（相同 URL 10 分钟内复用）

---

## 九、依赖

| 依赖 | 用途 | 当前状态 |
|------|------|---------|
| `@anthropic-ai/claude-agent-sdk` | SDK MCP Server | 已有 |
| `zod` | 参数校验 | 已有 |
| Firecrawl 服务 | 页面抓取（JS 渲染 + 反爬 + SSRF 防护） | 已有（`services/firecrawl/`） |

> **不再需要 cheerio**。页面抓取优先复用 Firecrawl；Firecrawl 不可用时 fallback 到正则提取（零新增依赖）。

---

## 十、迁移与向后兼容

### 后端迁移

| 步骤 | 操作 |
|------|------|
| 1 | 创建新文件（queryRouter、contentExtractor、3 个 MCP）|
| 2 | 修改 `index.ts` 导出新函数，同时保留旧的 `integrateSearchMcpServer` 导出（deprecated 标记）|
| 3 | 修改 `claudeUtils.ts` 调用新函数（health check 外提）|
| 4 | 验证新工具正常工作后，删除 `searxngIntegration.ts` 和 `index.ts` 中的旧导出 |

### 前端迁移

| 步骤 | 操作 |
|------|------|
| 1 | 添加新卡片组件（SearxngWebSearch、ImageSearch、VideoSearch）|
| 2 | `ToolCallRenderer.vue` MCP 分支添加新映射 |
| 3 | **保留** `SearxngSearchToolCard.vue` 和 `mcp__searxng__searxng_search` 映射 |
| 4 | 历史对话中旧格式工具调用仍使用旧卡片渲染，新对话使用新卡片 |

> **原则**：新旧共存，不破坏历史对话的渲染。等确认无旧格式数据后再清理。

---

## 十一、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 抓取超时导致搜索变慢 | web_search 响应时间从 ~2s 增至 ~5s | 严格 3s/页超时（AbortSignal.timeout），失败只返回 snippet |
| 并发抓取过多 | 目标网站封 IP，抓取成功率下降 | 最大并发 5，超出排队等待 |
| 被目标网站封禁 | 抓取失败率上升 | Firecrawl 内置反爬绕过；fallback 用常见浏览器 UA |
| 正文提取噪音 | content 包含无关内容 | Firecrawl `onlyMainContent` 精确提取；fallback 用正则粗提取 |
| 非 HTML 响应浪费请求 | PDF/图片 URL 无法提取正文 | content-type 检查，非 text/html 立即返回 null |
| 重定向链接 | URL 可能是聚合器重定向 | fetch 默认 redirect:'follow' 自动跟随 |
| SPA 页面无法提取 | 需要 JS 渲染的页面内容为空 | Firecrawl 支持 JS 渲染（`waitFor`）；fallback 降级到 snippet |
| 3 个 MCP 增加内存 | MCP Server 实例增多 | 共享 SearXNGClient 实例 |
| 3 次 health check | 启动延迟增加 | health check 提取到 claudeUtils.ts 调用方，只做一次 |
| 前端旧卡片兼容 | 历史对话中旧格式需渲染 | 保留 SearxngSearchToolCard.vue + 旧映射作为 fallback |
| 意图识别错误 | 路由到错误引擎 | queryRouter 输出日志便于排查；search_type override 作为兜底 |
| Token 预算超标 | max_results=10 时输出过大 | 动态 content 截断：≤5→2000字, 6-8→1200字, 9-10→800字 |
| 非 UTF-8 编码页面 | 中文网站使用 gb2312/gbk 导致乱码 | Phase 1 已知限制，降级到 snippet；Phase 3 可加 charset 检测 |

---

## 十二、测试策略

### 关键测试用例

#### `queryRouter.test.ts`

| 用例 | 输入 | 预期 |
|------|------|------|
| 中文新闻 | `"华为今天发布"` | intent=news, confidence=0.3→fallback general, lang=zh |
| 英文代码 | `"React useEffect infinite loop"` | intent=code, lang=en, engines 含 github,stackoverflow |
| 中文代码+框架名 | `"React useEffect 无限循环"` | intent=code, confidence≥0.6, lang=zh |
| 代码+新闻混合 | `"React useEffect 最新版本今天发布"` | intent=code (code 0.6 > news 0.3) |
| 错误堆栈 | `"Error: Cannot find module 'xxx'"` | intent=code, confidence≥0.5 |
| arXiv ID | `"arXiv:2401.12345"` | intent=academic, confidence≥0.8 |
| 纯生活查询 | `"好吃的火锅店"` | intent=general, confidence<0.4, engines 为 general 集 |
| search_type override | `query="python", searchType="news"` | intent=news, confidence=1.0 |
| time_range=day | `query="技术", timeRange="day"` | news confidence 加成 |
| confidence clamp | `"Error: Cannot find module at line 5"` | confidence≤1.0 |
| 混合路由 | `"Python 最新版本"` | confidence 0.4~0.6, engines 含 general 兜底 |

#### `contentExtractor.test.ts`

- Mock `FirecrawlClient.scrape`，验证 Firecrawl 优先调用
- Mock Firecrawl 抛异常，验证 fallback 到 fetch + 正则
- Mock `fetch` 返回预制 HTML，验证标题/正文提取
- 验证 maxLength 截断
- 验证非 HTML content-type 返回 null
- 验证超时返回 null
- 验证 SSRF 防护（内网 URL 返回 null）

#### `searchMcp.test.ts` / `imagesMcp.test.ts` / `videosMcp.test.ts`

- Mock SearXNGClient，验证工具参数传递
- 验证 Token 预算（max_results 不同值对应不同截断长度）
- 验证图片 URL `//` 前缀修复
- 验证视频 platform 推断

---

## 十三、日志规范

`web_search` 工具返回时，输出结构化日志便于监控和调试：

```typescript
console.log('[WebSearch]', JSON.stringify({
  query,
  intent: analysis.intent,
  confidence: analysis.confidence,
  lang: analysis.lang,
  engines: analysis.engines,
  resultCount: results.length,
  fetchedCount: results.filter(r => r.content).length,
  failedCount: results.filter(r => !r.content).length,
  totalMs: Date.now() - startTime,
}));
```
