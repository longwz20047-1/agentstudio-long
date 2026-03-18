// searchMcp.ts — web_search MCP tool with queryRouter integration and content extraction

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SearxngConfig } from './types.js';
import { SearXNGClient } from './searxngClient.js';
import { analyzeQuery } from './queryRouter.js';
import { dedupeAndRank } from './resultProcessor.js';
import { fetchAndExtract } from './contentExtractor.js';
import { searchWeKnoraRaw, type WeknoraContext } from '../weknora/weknoraIntegration.js';

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
- search_type: Content type — determines which search engines are used.
  Always provide this based on the user's actual need:
  - "code": Programming errors, API usage, library docs,
    package install, debugging, deployment, DevOps
  - "academic": Papers, research, algorithms, studies,
    surveys, datasets, benchmarks
  - "news": Current events, product launches, announcements,
    policy changes, incidents, market movements
  - "social": Recommendations, reviews, comparisons (X vs Y),
    experiences, community discussions
  - "general": Daily life, knowledge, how-to, everything else
- language: User's language — adds regional search engines.
  Always provide this based on the conversation language:
  - "zh": Chinese-speaking user (adds Baidu, Sogou, Quark)
  - "en": English-speaking user
- time_range: "day", "week", "month", "year" — use when
  the query implies recency (news, releases, incidents)
- max_results: 1-10, default 5. Use 1-3 for precise lookups,
  5 for general queries, 8-10 for broad research

Examples:
- "我的useEffect一直重新渲染停不下来怎么办"
  → query: "React useEffect infinite loop dependency array"
    search_type: "code", language: "zh"
- "那个注意力机制的论文叫什么"
  → query: "Attention Is All You Need transformer paper"
    search_type: "academic", language: "zh"
- "昨天小米出了什么新手机"
  → query: "小米 新品发布 手机"
    search_type: "news", language: "zh", time_range: "week"
- "好吃的火锅店推荐"
  → query: "火锅店 推荐 排名"
    search_type: "social", language: "zh"
- "最近有什么严重的安全漏洞"
  → query: "critical CVE security vulnerability 2026"
    search_type: "news", language: "zh", time_range: "month"

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
  config: SearxngConfig,
  weknoraContext?: WeknoraContext
): Promise<void> {
  const client = new SearXNGClient(config.base_url);

  // Dynamic description: show KB count when available
  const kbCount = weknoraContext?.kb_ids?.length ?? 0;
  const docCount = weknoraContext?.knowledge_ids?.length ?? 0;
  const hasKbSelection = kbCount > 0 || docCount > 0;

  const kbNote = hasKbSelection
    ? `\n\nNOTE: When knowledge bases are selected, this tool also searches ` +
      (kbCount > 0 ? `${kbCount} knowledge base(s)` : '') +
      (kbCount > 0 && docCount > 0 ? ' and ' : '') +
      (docCount > 0 ? `${docCount} specific document(s)` : '') +
      `. Results appear in the \`kb_results\` field. ` +
      `Provide kb_query with the user's original question in their language for better KB matching.`
    : '';

  const webSearchTool = tool(
    TOOL_NAME,
    TOOL_DESCRIPTION + kbNote,
    {
      query: z.string().describe('Optimized search keywords'),
      kb_query: z.string().optional().describe('Original user query in their language for KB search (only when kb_results is enabled)'),
      time_range: z.enum(['day', 'week', 'month', 'year']).optional().describe('Time filter for recency'),
      max_results: z.number().min(1).max(10).optional().describe('Max results (default 5)'),
      search_type: z.enum(['general', 'news', 'code', 'academic', 'social']).optional().describe('Content type — determines which engines are used'),
      language: z.enum(['zh', 'en']).optional().describe('User language for regional engine selection'),
    },
    async (args) => {
      const startTime = Date.now();
      const { query, kb_query, time_range, max_results = 5, search_type, language } = args;

      try {
        // Check search cache
        const kbHash = weknoraContext?.kb_ids?.length
          ? '|kb:' + weknoraContext.kb_ids.slice().sort().join(',')
          : '';
        const kidHash = weknoraContext?.knowledge_ids?.length
          ? '|kid:' + weknoraContext.knowledge_ids.slice().sort().join(',')
          : '';
        const cacheKey = getSearchCacheKey(query, time_range, max_results) + kbHash + kidHash;
        const cached = searchCache.get(cacheKey);
        if (cached && Date.now() < cached.expireAt) {
          console.log('[WebSearch] cache hit:', cacheKey);
          return {
            content: [{ type: 'text' as const, text: cached.output }],
          };
        }

        // Step 1: Analyze query for intent, engines, language
        // AI-provided search_type/language take priority; queryRouter rules as fallback
        const analysis = analyzeQuery(query, {
          timeRange: time_range,
          searchTypeOverride: search_type,
          languageOverride: language,
        });

        // Launch KB search in parallel (if context available)
        const hasKbSelection2 = (weknoraContext?.kb_ids?.length ?? 0) > 0
          || (weknoraContext?.knowledge_ids?.length ?? 0) > 0;
        const kbPromise = (weknoraContext?.api_key && hasKbSelection2)
          ? searchWeKnoraRaw(kb_query || query, weknoraContext, { timeoutMs: 5_000 })
          : null;

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

        // Await KB results (usually already resolved by now)
        const rawKb = kbPromise ? await kbPromise : null;
        const kbResults = rawKb?.map(r => ({
          title: r.title,
          content: r.content.substring(0, contentMaxLength),
          score: r.score,
          match_type: r.match_type,
          doc_link: r.knowledge_id ? `weknora-doc://${r.knowledge_id}` : '',
        }));

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
          kbResultCount: kbResults?.length ?? 0,
          kbEnabled: kbPromise !== null,
          totalMs,
        }));

        const output: Record<string, unknown> = {
          query,
          intent: analysis.intent,
          results,
        };

        if (kbResults?.length) {
          output.kb_results = kbResults;
        }

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

  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    tools: [webSearchTool],
  });

  queryOptions.mcpServers = { ...queryOptions.mcpServers, [SERVER_NAME]: server };

  const searchToolName = `mcp__${SERVER_NAME}__${TOOL_NAME}`;
  if (!queryOptions.allowedTools) {
    queryOptions.allowedTools = [searchToolName];
  } else {
    if (!queryOptions.allowedTools.includes(searchToolName)) {
      queryOptions.allowedTools.push(searchToolName);
    }
  }
}

export function getSearchToolNames(): string[] {
  return [`mcp__${SERVER_NAME}__${TOOL_NAME}`];
}
