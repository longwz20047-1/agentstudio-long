# SearXNG + Crawl4AI 搜索质量提升实施方案

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 web_search 工具的内容提取从 Firecrawl 替换为 Crawl4AI + LLM，并可选增加 RRF 多查询融合提升搜索排序质量。

**Architecture:** contentExtractor.ts 移除全部 Firecrawl 依赖，改为调用 Crawl4AI REST API (`/md` endpoint, `f=llm` 模式)。所有页面统一走 LLM 语义提取（gpt-5.1），不分层判断。可选的 P2 阶段在 searchMcp.ts 增加 `queries` 数组参数，并发搜索多个 query 变体后用 RRF 合并排序。

**Tech Stack:** TypeScript, Crawl4AI REST API, Vitest, Zod

**前置条件（已完成）：**
- ✅ queryRouter.ts: AI 覆盖参数 (`searchTypeOverride`, `languageOverride`)
- ✅ searchMcp.ts: `search_type`/`language` 参数 + TOOL_DESCRIPTION
- ✅ queryRouter.ts: news 引擎路由表加 GENERAL_ZH
- ✅ SearXNG settings.yml: 引擎权重/Hostnames 插件/超时优化
- ✅ Crawl4AI Docker 部署: `192.168.100.30:11235`, gpt-5.1

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| **Rewrite** | `backend/src/services/searxng/contentExtractor.ts` | Crawl4AI + LLM 提取，替换 Firecrawl |
| **Rewrite** | `backend/src/services/searxng/__tests__/contentExtractor.test.ts` | 新的测试用例 |
| **Modify** | `backend/src/services/searxng/searchMcp.ts` | P2: 增加 `queries` 参数 + RRF 逻辑 |
| **Modify** | `backend/src/services/searxng/resultProcessor.ts` | P2: 新增 `rrfMerge()` |
| **No change** | `backend/src/services/firecrawl/*` | 不删除（firecrawlIntegration.ts 仍被 claudeUtils.ts 使用） |

---

## Chunk 1: P1 — Crawl4AI 替换 Firecrawl

### Task 1: Rewrite contentExtractor.ts

**Files:**
- Rewrite: `backend/src/services/searxng/contentExtractor.ts`

- [ ] **Step 1: Write the new contentExtractor.ts**

Replace the entire file. Remove all Firecrawl imports. Add Crawl4AI `/md` API call.

```typescript
// agentstudio/backend/src/services/searxng/contentExtractor.ts

import { validateUrl } from '../firecrawl/firecrawlClient.js';

// --- Constants ---

const CRAWL4AI_URL = process.env.CRAWL4AI_URL || 'http://192.168.100.30:11235';
const CRAWL4AI_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LENGTH = 20_000;
const MAX_HTML_SIZE = 512 * 1024; // 512KB
const FETCH_TIMEOUT_MS = 3000;

const CRAWL4AI_DEFAULT_PROMPT =
  'Extract the core content of this page: titles, body text, key information. ' +
  'Output clean Markdown. Remove navigation, ads, sidebars, and other irrelevant content.';

// --- Extraction Cache (10-min TTL) ---

const EXTRACTION_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  result: { title: string; content: string } | null;
  expireAt: number;
}

const extractionCache = new Map<string, CacheEntry>();

/** Exported for testing only */
export function _resetExtractionCache(): void {
  extractionCache.clear();
}

// --- Crawl4AI Response ---

interface Crawl4AIResponse {
  success: boolean;
  markdown?: string;
  filter?: string;
  url?: string;
}

// --- Main Function ---

export async function fetchAndExtract(
  url: string,
  options?: { maxLength?: number; query?: string }
): Promise<{ title: string; content: string } | null> {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;

  // Check cache (keyed by url + query for context-dependent LLM extraction)
  const cacheKey = options?.query ? `${url}|${options.query}` : url;
  const cached = extractionCache.get(cacheKey);
  if (cached && Date.now() < cached.expireAt) {
    return cached.result;
  }

  // SSRF protection — block internal/private URLs before sending to any extractor
  try {
    validateUrl(url);
  } catch {
    return null;
  }

  let result: { title: string; content: string } | null = null;

  try {
    // Primary: Crawl4AI + LLM extraction
    result = await crawl4aiExtract(url, maxLength, options?.query);
  } catch (err) {
    console.warn('[ContentExtractor] Crawl4AI error for', url, err instanceof Error ? err.message : err);
  }

  // Fallback: plain fetch + regex extraction
  if (!result) {
    try {
      result = await fetchFallback(url, maxLength);
    } catch {
      result = null;
    }
  }

  // Store in cache
  extractionCache.set(cacheKey, {
    result,
    expireAt: Date.now() + EXTRACTION_CACHE_TTL_MS,
  });

  return result;
}

// --- Crawl4AI Extraction ---

async function crawl4aiExtract(
  url: string,
  maxLength: number,
  query?: string,
): Promise<{ title: string; content: string } | null> {
  const resp = await fetch(`${CRAWL4AI_URL}/md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      f: 'llm',
      q: query || CRAWL4AI_DEFAULT_PROMPT,
      temperature: 0.2,
      c: '0', // Disable Crawl4AI server-side cache (always fresh crawl)
    }),
    signal: AbortSignal.timeout(CRAWL4AI_TIMEOUT_MS),
  });

  if (!resp.ok) {
    console.warn('[ContentExtractor] Crawl4AI returned', resp.status, 'for', url);
    return null;
  }

  const data: Crawl4AIResponse = await resp.json();

  if (!data.success || !data.markdown || data.markdown.length <= 1) {
    return null;
  }

  return {
    title: '',
    content: data.markdown.slice(0, maxLength),
  };
}

// --- Fetch Fallback (unchanged from original) ---

async function fetchFallback(
  url: string,
  maxLength: number,
): Promise<{ title: string; content: string } | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AgentStudio/1.0)',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_HTML_SIZE) return null;

    const html = await response.text();
    if (html.length > MAX_HTML_SIZE) return null;

    return extractFromHtml(html, maxLength);
  } catch {
    return null;
  }
}

// --- HTML Extraction (unchanged from original) ---

function extractFromHtml(
  html: string,
  maxLength: number,
): { title: string; content: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);
  text = text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n');

  return {
    title,
    content: text.slice(0, maxLength),
  };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd agentstudio && npx tsc --noEmit --pretty 2>&1 | grep -E "(contentExtractor|error TS)"`
Expected: No errors

- [ ] **Step 2.5: Update searchMcp.ts to pass query to Crawl4AI**

In `searchMcp.ts`, update the `fetchAndExtract` call (line ~177) to pass the search query for contextual LLM extraction:

```typescript
// Before:
r => fetchAndExtract(r.url, { maxLength: contentMaxLength }),

// After:
r => fetchAndExtract(r.url, { maxLength: contentMaxLength, query }),
```

This ensures Crawl4AI's LLM uses the search query as context instead of a generic prompt, producing more relevant extractions.

- [ ] **Step 3: Commit**

```bash
cd agentstudio
git add backend/src/services/searxng/contentExtractor.ts
git commit -m "refactor: replace Firecrawl with Crawl4AI LLM extraction in contentExtractor"
```

---

### Task 2: Rewrite contentExtractor tests

**Files:**
- Rewrite: `backend/src/services/searxng/__tests__/contentExtractor.test.ts`

- [ ] **Step 1: Write the new test file**

```typescript
// agentstudio/backend/src/services/searxng/__tests__/contentExtractor.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAndExtract, _resetExtractionCache } from '../contentExtractor.js';

describe('contentExtractor (Crawl4AI)', () => {
  beforeEach(() => {
    _resetExtractionCache();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Helper: mock Crawl4AI /md response
  function mockCrawl4AI(markdown: string, success = true) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success, markdown }),
    });
  }

  // Helper: mock Crawl4AI failure then HTML fallback
  function mockCrawl4AIFailThenHtml(html: string) {
    // First call: Crawl4AI fails
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Crawl4AI timeout')
    );
    // Second call: fallback fetch succeeds
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: () => Promise.resolve(html),
    });
  }

  describe('SSRF protection', () => {
    it('should return null for private IP URLs', async () => {
      const result = await fetchAndExtract('http://192.168.1.1/secret');
      expect(result).toBeNull();
      // fetch should not be called — blocked before any extraction
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should return null for localhost URLs', async () => {
      const result = await fetchAndExtract('http://localhost:8080/admin');
      expect(result).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('Crawl4AI primary path', () => {
    it('should return LLM-extracted content from Crawl4AI', async () => {
      mockCrawl4AI('# News\n\n1. Breaking news about AI');

      const result = await fetchAndExtract('https://example.com');

      expect(result).toEqual({
        title: '',
        content: '# News\n\n1. Breaking news about AI',
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/md'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"f":"llm"'),
        })
      );
    });

    it('should truncate content to maxLength', async () => {
      mockCrawl4AI('A'.repeat(5000));

      const result = await fetchAndExtract('https://example.com', { maxLength: 200 });

      expect(result).not.toBeNull();
      expect(result!.content.length).toBe(200);
    });

    it('should pass custom query to Crawl4AI', async () => {
      mockCrawl4AI('Custom extraction result');

      await fetchAndExtract('https://example.com', {
        query: 'Extract product prices',
      });

      const callBody = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
      );
      expect(callBody.q).toBe('Extract product prices');
    });

    it('should fallback when Crawl4AI returns empty markdown', async () => {
      // Crawl4AI returns success but empty content (length <= 1)
      mockCrawl4AI(' ', true);

      // Fallback HTML
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<html><title>Fallback</title><body><p>Content</p></body></html>'),
      });

      const result = await fetchAndExtract('https://example.com');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Fallback');
    });

    it('should fallback when Crawl4AI returns HTTP error', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
      });
      // Fallback HTML
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<html><title>Fallback</title><body>content</body></html>'),
      });

      const result = await fetchAndExtract('https://example.com');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Fallback');
    });
  });

  describe('Fallback path', () => {
    it('should use fetch fallback when Crawl4AI fails', async () => {
      const html = '<html><head><title>Fallback Title</title></head><body><p>Fallback content</p></body></html>';
      mockCrawl4AIFailThenHtml(html);

      const result = await fetchAndExtract('https://example.com');

      expect(result).not.toBeNull();
      expect(result!.title).toBe('Fallback Title');
      expect(result!.content).toContain('Fallback content');
    });

    it('should return null for non-HTML content-type in fallback', async () => {
      // Crawl4AI fails
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
      // Fallback: non-HTML
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        text: () => Promise.resolve('binary'),
      });

      const result = await fetchAndExtract('https://example.com/file.pdf');
      expect(result).toBeNull();
    });

    it('should return null for oversized HTML in fallback', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'content-type': 'text/html',
          'content-length': String(600 * 1024),
        }),
        text: () => Promise.resolve('<html>big</html>'),
      });

      const result = await fetchAndExtract('https://example.com/huge');
      expect(result).toBeNull();
    });

    it('should strip script/style/nav/footer/header in fallback HTML', async () => {
      const html = `<html><head><title>Clean</title></head><body>
        <script>alert('xss')</script>
        <style>.hide{display:none}</style>
        <nav>Navigation</nav>
        <header>Header</header>
        <main><p>Real content here</p></main>
        <footer>Footer</footer>
      </body></html>`;

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(html),
      });

      const result = await fetchAndExtract('https://example.com/page');
      expect(result).not.toBeNull();
      expect(result!.content).toContain('Real content here');
      expect(result!.content).not.toContain('alert');
      expect(result!.content).not.toContain('Navigation');
      expect(result!.content).not.toContain('Footer');
    });
  });

  describe('Extraction cache', () => {
    it('should return cached result for same URL and query', async () => {
      mockCrawl4AI('cached content');

      const result1 = await fetchAndExtract('https://example.com/cached');
      const result2 = await fetchAndExtract('https://example.com/cached');

      // Only 1 fetch call (second is cached)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(result1).toEqual(result2);
    });

    it('should not use cache when query differs for same URL', async () => {
      mockCrawl4AI('content for query A');
      mockCrawl4AI('content for query B');

      const result1 = await fetchAndExtract('https://example.com/page', { query: 'query A' });
      const result2 = await fetchAndExtract('https://example.com/page', { query: 'query B' });

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(result1!.content).toBe('content for query A');
      expect(result2!.content).toBe('content for query B');
    });

    it('should not use cache for different URLs', async () => {
      mockCrawl4AI('content A');
      mockCrawl4AI('content B');

      await fetchAndExtract('https://example.com/a');
      await fetchAndExtract('https://example.com/b');

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should cache null results', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));

      const result1 = await fetchAndExtract('https://example.com/fail');
      const result2 = await fetchAndExtract('https://example.com/fail');

      expect(result1).toBeNull();
      expect(result2).toBeNull();
      // Only 2 calls for first attempt (crawl4ai + fallback), 0 for second (cached)
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should clear cache with _resetExtractionCache', async () => {
      mockCrawl4AI('first');
      await fetchAndExtract('https://example.com/reset');

      _resetExtractionCache();

      mockCrawl4AI('second');
      const result = await fetchAndExtract('https://example.com/reset');

      expect(result!.content).toBe('second');
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd agentstudio/backend && npx vitest run src/services/searxng/__tests__/contentExtractor.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd agentstudio
git add backend/src/services/searxng/__tests__/contentExtractor.test.ts
git commit -m "test: rewrite contentExtractor tests for Crawl4AI"
```

---

### Task 3: Add CRAWL4AI_URL environment variable

**Files:**
- Modify: `agentstudio-deploy` 的环境变量配置（用户自行维护）

- [ ] **Step 1: Document the environment variable**

在 `agentstudio/backend/.env` 或部署配置中添加：

```env
# Crawl4AI — 页面内容提取服务 (替代 Firecrawl)
# LLM 模式：Playwright 渲染 + LLM 语义提取
CRAWL4AI_URL=http://192.168.100.30:11235
```

- [ ] **Step 2: Verify end-to-end**

Start backend, trigger a web_search, check logs for `[WebSearch]` output with `fetchedCount > 0`.

---

## Chunk 2: P2 — RRF 多查询融合（可选）

### Task 4: Add rrfMerge to resultProcessor.ts

**Files:**
- Modify: `backend/src/services/searxng/resultProcessor.ts`

- [ ] **Step 1: Add rrfMerge function**

Append to the end of `resultProcessor.ts`:

```typescript
/**
 * Reciprocal Rank Fusion — merge multiple result sets.
 * Results appearing in multiple sets get higher scores.
 * Formula: score(url) = SUM(1 / (k + rank_in_set_i))
 */
export function rrfMerge(
  resultSets: ProcessedResult[][],
  maxResults: number,
  k: number = 60,
): ProcessedResult[] {
  const scores = new Map<string, { result: ProcessedResult; score: number; enginesSet: Set<string> }>();

  for (const results of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const key = normalizeUrl(results[rank].url);
      const existing = scores.get(key);
      const rrfScore = 1 / (k + rank);

      if (existing) {
        existing.score += rrfScore;
        for (const e of results[rank].engines) existing.enginesSet.add(e);
      } else {
        scores.set(key, {
          result: { ...results[rank] },
          score: rrfScore,
          enginesSet: new Set(results[rank].engines),
        });
      }
    }
  }

  return [...scores.values()]
    .map(({ result, score, enginesSet }) => ({
      ...result,
      score,
      engines: Array.from(enginesSet),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd agentstudio && npx tsc --noEmit --pretty 2>&1 | grep "error TS"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd agentstudio
git add backend/src/services/searxng/resultProcessor.ts
git commit -m "feat: add rrfMerge for multi-query fusion in resultProcessor"
```

---

### Task 5: Add queries parameter to searchMcp.ts

**Files:**
- Modify: `backend/src/services/searxng/searchMcp.ts`

- [ ] **Step 1: Add queries to Zod schema**

In the tool parameter definition (line ~131), add after the `language` field:

```typescript
queries: z.array(z.string()).max(3).optional()
  .describe('Multiple query variants for broader coverage (RRF merge)'),
```

- [ ] **Step 2: Update TOOL_DESCRIPTION**

Add to the Parameters section, after `max_results`:

```
- queries: Optional array of 2-3 query variants for broad research.
  When provided, all variants are searched in parallel and results
  are merged by relevance (results appearing in multiple searches
  rank higher). Use for complex or ambiguous topics where a single
  query may miss relevant results.
  Example: ["Docker container networking tutorial",
            "Docker bridge network configuration",
            "Docker compose network setup"]
```

- [ ] **Step 3: Update handler to support multi-query**

In the handler function, add import for `rrfMerge`:

```typescript
import { dedupeAndRank, rrfMerge } from './resultProcessor.js';
```

Replace the single search + deduplication block (current lines ~160-171):

```typescript
const { query, time_range, max_results = 5, search_type, language, queries } = args;

// ...cache check — update getSearchCacheKey to include queries:
const cacheKey = getSearchCacheKey(query, time_range, max_results, queries);

// ...analysis unchanged...

// Step 2: Search — single query or multi-query with RRF
const queryList = queries?.length ? queries : [query];

const searchResponses = await Promise.all(
  queryList.map(q =>
    client.search({
      q,
      engines: analysis.engines,
      language: analysis.languageCode,
      time_range,
      pageno: 1,
      safesearch: 0,
    })
  )
);

// Step 3: Deduplicate and rank (or RRF merge)
const ranked = queryList.length > 1
  ? rrfMerge(
      searchResponses.map(r => dedupeAndRank(r.results, 15)),
      max_results,
    )
  : dedupeAndRank(searchResponses[0].results, max_results);

// Merge suggestions and answers from all responses
const allSuggestions = [...new Set(searchResponses.flatMap(r => r.suggestions))];
const allAnswers = [...new Set(searchResponses.flatMap(r => r.answers))];
```

And update the output assembly to use `allSuggestions` / `allAnswers`:

```typescript
if (allSuggestions.length > 0) {
  output.suggestions = allSuggestions;
}
if (allAnswers.length > 0) {
  output.answers = allAnswers;
}
```

Also update `getSearchCacheKey` to include queries:

```typescript
function getSearchCacheKey(query: string, timeRange?: string, maxResults?: number, queries?: string[]): string {
  const queriesKey = queries?.sort().join(',') || '';
  return `${query}|${timeRange || ''}|${maxResults || 5}|${queriesKey}`;
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd agentstudio && npx tsc --noEmit --pretty 2>&1 | grep "error TS"`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
cd agentstudio
git add backend/src/services/searxng/searchMcp.ts backend/src/services/searxng/resultProcessor.ts
git commit -m "feat: add multi-query RRF fusion support to web_search"
```

---

## Summary

| Task | Files | Description |
|------|-------|-------------|
| Task 1 | `contentExtractor.ts` | Rewrite: Firecrawl → Crawl4AI + LLM |
| Task 2 | `__tests__/contentExtractor.test.ts` | Rewrite: tests for Crawl4AI |
| Task 3 | `.env` / deploy config | Add `CRAWL4AI_URL` env var |
| Task 4 | `resultProcessor.ts` | Add `rrfMerge()` function |
| Task 5 | `searchMcp.ts` | Add `queries` param + RRF integration |

**P1 (Task 1-3)**: 必做，替换 Firecrawl
**P2 (Task 4-5)**: 可选，RRF 多查询融合
