// searchMcp.ts — web_search MCP tool with queryRouter integration and content extraction

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SearxngConfig } from './types.js';
import { SearXNGClient } from './searxngClient.js';
import { analyzeQuery } from './queryRouter.js';
import { dedupeAndRank } from './resultProcessor.js';
import { fetchAndExtract } from './contentExtractor.js';

const SERVER_NAME = 'searxng-search';
const TOOL_NAME = 'web_search';
const MAX_CONCURRENT_FETCHES = 5;

// --- Search Result Cache (5-min TTL) ---

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface SearchCacheEntry {
  output: string; // JSON string of the final output
  expireAt: number;
}

const searchCache = new Map<string, SearchCacheEntry>();

function getSearchCacheKey(query: string, timeRange?: string, maxResults?: number): string {
  return `${query}|${timeRange || ''}|${maxResults || 5}`;
}

/** Exported for testing only */
export function _resetSearchCache(): void {
  searchCache.clear();
}

const WEB_FETCH_TOOL_NAME = 'web_fetch';

const WEB_FETCH_DESCRIPTION = `Fetch and extract the main content of a web page.
Use this tool when you need to read the content of a specific URL
that appeared in search results or was provided by the user.

This is a lightweight alternative to firecrawl_scrape.
It tries Firecrawl first (if available), then falls back to
plain HTTP fetch with HTML parsing.

Parameters:
- url: The full URL to fetch (must be http or https)
- max_length: Maximum characters to return (default 8000)

Returns the page title and main text content.
Navigation, headers, footers, scripts, and styles are stripped.`;

const TOOL_DESCRIPTION = `Search the web and fetch page content for comprehensive results.
Use this tool when the user asks questions that require up-to-date
information, factual lookup, or external knowledge beyond your training.

IMPORTANT: Do NOT pass the user's raw question as query.
Extract and optimize search keywords:
- Remove filler words and conversational language
- Add relevant technical terms the user may have omitted
- Include specific version numbers, error codes, or proper nouns
- For Chinese technical queries, prefer English technical terms
  (e.g., "useEffect" not "副作用钩子")
- For time-sensitive queries, add the current year if relevant

Parameters:
- query: Optimized search keywords (NOT the user's raw question)
- time_range: "day", "week", "month", "year" — use when
  the query implies recency (news, releases, incidents)
- max_results: 1-10, default 5. Use 1-3 for precise lookups,
  5 for general queries, 8-10 for broad research

Examples:
- "我的useEffect一直重新渲染停不下来怎么办"
  → query: "React useEffect infinite loop dependency array"
- "那个注意力机制的论文叫什么"
  → query: "Attention Is All You Need transformer paper"
- "昨天小米出了什么新手机"
  → query: "小米 新品发布 手机", time_range: "week"
- "好吃的火锅店推荐"
  → query: "火锅店 推荐 排名"
- "最近有什么严重的安全漏洞"
  → query: "critical CVE security vulnerability", time_range: "month"

Tip: For Chinese technical/academic queries, if results lack depth,
try searching again with English keywords for broader coverage.`;

function getContentMaxLength(maxResults: number): number {
  if (maxResults <= 5) return 2000;
  if (maxResults <= 8) return 1200;
  return 800;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

export async function integrateSearchMcp(
  queryOptions: any,
  config: SearxngConfig
): Promise<void> {
  const client = new SearXNGClient(config.base_url);

  const webSearchTool = tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    {
      query: z.string().describe('Optimized search keywords'),
      time_range: z.enum(['day', 'week', 'month', 'year']).optional().describe('Time filter for recency'),
      max_results: z.number().min(1).max(10).optional().describe('Max results (default 5)'),
    },
    async (args) => {
      const startTime = Date.now();
      const { query, time_range, max_results = 5 } = args;

      try {
        // Check search cache
        const cacheKey = getSearchCacheKey(query, time_range, max_results);
        const cached = searchCache.get(cacheKey);
        if (cached && Date.now() < cached.expireAt) {
          console.log('[WebSearch] cache hit:', cacheKey);
          return {
            content: [{ type: 'text' as const, text: cached.output }],
          };
        }

        // Step 1: Analyze query for intent, engines, language
        const analysis = analyzeQuery(query, { timeRange: time_range });

        // Step 2: Search via SearXNG
        const response = await client.search({
          q: query,
          engines: analysis.engines,
          language: analysis.languageCode,
          time_range,
          pageno: 1,
          safesearch: 0,
        });

        // Step 3: Deduplicate and rank
        const ranked = dedupeAndRank(response.results, max_results);

        // Step 4: Concurrent content extraction (max 5 concurrent)
        const contentMaxLength = getContentMaxLength(max_results);
        const fetchResults = await mapWithConcurrency(
          ranked,
          r => fetchAndExtract(r.url, { maxLength: contentMaxLength }),
          MAX_CONCURRENT_FETCHES,
        );

        // Step 5: Assemble output
        const results = ranked.map((r, i) => {
          const fetchResult = fetchResults[i];
          const extracted = fetchResult.status === 'fulfilled' ? fetchResult.value : null;

          return {
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            content: extracted?.content,
            publishedDate: r.publishedDate,
            engines: r.engines,
          };
        });

        const fetchedCount = fetchResults.filter(
          r => r.status === 'fulfilled' && r.value !== null
        ).length;

        const totalMs = Date.now() - startTime;

        console.log('[WebSearch]', JSON.stringify({
          query,
          intent: analysis.intent,
          lang: analysis.lang,
          engines: analysis.engines,
          resultCount: ranked.length,
          fetchedCount,
          totalMs,
        }));

        const output: Record<string, unknown> = {
          query,
          intent: analysis.intent,
          results,
        };

        if (response.suggestions.length > 0) {
          output.suggestions = response.suggestions;
        }
        if (response.answers.length > 0) {
          output.answers = response.answers;
        }

        const outputJson = JSON.stringify(output);

        // Store in cache
        searchCache.set(cacheKey, {
          output: outputJson,
          expireAt: Date.now() + SEARCH_CACHE_TTL_MS,
        });

        return {
          content: [{ type: 'text' as const, text: outputJson }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Search error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  const webFetchTool = tool(
    WEB_FETCH_TOOL_NAME,
    WEB_FETCH_DESCRIPTION,
    {
      url: z.string().url().describe('URL to fetch'),
      max_length: z.number().min(500).max(20000).optional().describe('Max content length (default 8000)'),
    },
    async (args) => {
      const { url, max_length = 8000 } = args;

      try {
        const result = await fetchAndExtract(url, { maxLength: max_length });

        if (!result) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              url,
              error: 'Failed to extract content (non-HTML, timeout, or blocked)',
            }) }],
            isError: true,
          };
        }

        const output = {
          url,
          title: result.title,
          content: result.content,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Web fetch error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    tools: [webSearchTool, webFetchTool],
  });

  queryOptions.mcpServers = { ...queryOptions.mcpServers, [SERVER_NAME]: server };

  const searchToolName = `mcp__${SERVER_NAME}__${TOOL_NAME}`;
  const fetchToolName = `mcp__${SERVER_NAME}__${WEB_FETCH_TOOL_NAME}`;
  if (!queryOptions.allowedTools) {
    queryOptions.allowedTools = [searchToolName, fetchToolName];
  } else {
    if (!queryOptions.allowedTools.includes(searchToolName)) {
      queryOptions.allowedTools.push(searchToolName);
    }
    if (!queryOptions.allowedTools.includes(fetchToolName)) {
      queryOptions.allowedTools.push(fetchToolName);
    }
  }
}

export function getSearchToolNames(): string[] {
  return [
    `mcp__${SERVER_NAME}__${TOOL_NAME}`,
    `mcp__${SERVER_NAME}__${WEB_FETCH_TOOL_NAME}`,
  ];
}
