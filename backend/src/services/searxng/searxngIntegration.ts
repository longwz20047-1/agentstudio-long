import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SearxngConfig } from './types.js';
import { SearXNGClient } from './searxngClient.js';
import { dedupeAndRank } from './resultProcessor.js';

const TOOL_DESCRIPTION = `Search the web using SearXNG meta-search engine (~109 engines).

**CRITICAL: Use ONLY the engines parameter to select search engines. Do NOT pass categories and engines together — categories overrides engines. Choose ONE approach:**
- **Precise search (preferred):** Pass engines only, no categories
- **Broad category search:** Pass categories only, no engines (uses all engines in that category)

## Recommended engines (pass to engines param)

| Search type | engines (copy these) |
|-------------|---------------------|
| General | google,duckduckgo,bing,baidu,sogou,quark,brave,wikipedia |
| News | bing news,google news,yahoo news,duckduckgo news,wikinews,chinaso news |
| Images | google images,bing images,baidu images,quark images,unsplash,pexels,flickr |
| Videos | youtube,bilibili,google videos,bing videos |
| Code/IT | github,github code,gitlab,codeberg,stackoverflow,mdn,npm,pypi,docker hub,pkg.go.dev,crates.io,microsoft learn |
| Academic | google scholar,arxiv,semantic scholar,pubmed,crossref,openalex |
| Music | soundcloud,bandcamp,youtube |
| Social | reddit,hackernews |
| Chinese general | baidu,sogou,quark,bing,google |
| Chinese news | chinaso news,bing news,google news,duckduckgo news |
| WeChat | sogou wechat |

## Usage rules
1. For precise results, pass engines only (no categories)
2. For Chinese users/queries, include Chinese engines (baidu, sogou, chinaso news, bilibili)
3. Set language="zh-CN" for Chinese queries, "en" for English
4. Use time_range="day" for latest news, "week" for recent content

## Example calls
- Chinese news: engines="bing news,google news,chinaso news,yahoo news,duckduckgo news", language="zh-CN", time_range="day"
- English news: engines="google news,bing news,yahoo news,duckduckgo news,wikinews", language="en", time_range="day"
- Images: engines="google images,bing images,baidu images,unsplash,pexels,flickr"
- Videos: engines="youtube,bilibili,google videos,bing videos"
- Code search: engines="github,github code,stackoverflow,mdn,npm,pypi"
- Academic: engines="google scholar,arxiv,semantic scholar,pubmed,crossref"
- General Chinese: engines="google,baidu,sogou,quark,duckduckgo,bing,wikipedia", language="zh-CN"

## Response format
1. ALWAYS include clickable source links: [Page Title](URL)
2. For image results: Output image markdown EXACTLY as provided. Do NOT describe images in text.
3. For general/news results: Use numbered list with links and snippets.`;

export async function integrateSearchMcpServer(
  queryOptions: any,
  config: SearxngConfig
): Promise<void> {
  try {
    // Health check (5s timeout, skip if unreachable)
    try {
      await fetch(`${config.base_url}/`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      console.warn('⚠️ [SearXNG] Service unreachable, skipping MCP integration');
      return;
    }

    const client = new SearXNGClient(config.base_url);

    const searchTool = tool(
      'searxng_search',
      TOOL_DESCRIPTION,
      {
        query: z.string().min(1).max(500).describe('Search keywords'),
        categories: z.string().optional().describe('Categories, comma-separated (e.g. "general", "it", "news")'),
        engines: z.string().optional().describe('Engines, comma-separated (e.g. "google,baidu", "sogou wechat")'),
        language: z.string().optional().describe('Language code: "zh-CN", "en", "ja", "all"'),
        time_range: z.enum(['day', 'week', 'month', 'year']).optional().describe('Time filter'),
        pageno: z.number().min(1).optional().describe('Page number'),
        safesearch: z.number().int().min(0).max(2).optional().describe('Safe search: 0=off, 1=moderate, 2=strict'),
        max_results: z.number().min(1).max(50).optional().default(20).describe('Max results to return (client-side limit)'),
      },
      async (args) => {
        const { query, categories, engines, language, time_range, pageno, safesearch, max_results } = args;

        // Default engines per category — used when AI passes categories but no engines
        const DEFAULT_ENGINES: Record<string, string> = {
          general: 'google,duckduckgo,bing,baidu,sogou,quark,brave,wikipedia',
          news: 'bing news,google news,yahoo news,duckduckgo news,wikinews,chinaso news',
          images: 'google images,bing images,baidu images,quark images,unsplash,pexels,flickr',
          videos: 'youtube,bilibili,google videos,bing videos',
          it: 'github,github code,stackoverflow,mdn,npm,pypi,docker hub,pkg.go.dev,crates.io',
          science: 'google scholar,arxiv,semantic scholar,pubmed,crossref,openalex',
          music: 'soundcloud,bandcamp,youtube',
        };

        // Resolve effective engines: explicit engines > auto-fill from category > neither
        let effectiveEngines = engines;
        if (!effectiveEngines && categories) {
          effectiveEngines = DEFAULT_ENGINES[categories.toLowerCase().split(',')[0].trim()];
        }
        // When engines is resolved, drop categories to prevent SearXNG from ignoring engines
        const effectiveCategories = effectiveEngines ? undefined : categories;

        console.log('🔍 [SearXNG] Tool called:', { query, categories: effectiveCategories, engines: effectiveEngines, language, time_range });

        try {
          const response = await client.search({
            q: query,
            categories: effectiveCategories,
            engines: effectiveEngines,
            language,
            time_range,
            pageno,
            safesearch,
          });

          const processed = dedupeAndRank(response.results, max_results ?? 20);

          // Detect media search: check categories param OR engines containing image/video engines
          const requestedCategories = (categories || '').toLowerCase();
          const requestedEngines = (effectiveEngines || '').toLowerCase();
          const isImageSearch = requestedCategories.includes('images')
            || /\b(google images|bing images|baidu images|quark images|unsplash|pexels|flickr)\b/.test(requestedEngines);
          const isVideoSearch = requestedCategories.includes('videos')
            || /\b(youtube|bilibili|google videos|bing videos)\b/.test(requestedEngines);
          const hasMedia = (isImageSearch || isVideoSearch)
            && processed.some(r => r.img_src || r.thumbnail);

          let text = '';

          if (hasMedia) {
            // Image/video search: return structured data for frontend card rendering
            const isVideo = isVideoSearch || processed.some(r => r.category === 'videos');
            const mediaType = isVideo ? '视频' : '图片';
            const fixUrl = (u: string) => u.startsWith('//') ? `https:${u}` : u;

            const galleryItems = processed
              .filter(r => r.thumbnail || r.img_src)
              .map(r => ({
                title: r.title,
                thumbnail: fixUrl(r.thumbnail || r.img_src || ''),
                url: r.category === 'videos' ? r.url : fixUrl(r.img_src || r.thumbnail || ''),
                sourceUrl: r.url,
                isVideo: r.category === 'videos',
              }));

            const enginesUsed = [...new Set(processed.flatMap(r => r.engines))].join(', ');

            // Brief text for AI — nothing to summarize
            text = `搜索到 ${galleryItems.length} 个「${query}」相关${mediaType}，结果已在工具卡片中展示，无需重复描述。`;
            // Structured gallery data for frontend parsing
            text += `\n[SEARXNG_GALLERY]${JSON.stringify(galleryItems)}[/SEARXNG_GALLERY]`;
            text += `\n来源引擎：${enginesUsed}`;
          } else {
            // Non-image search: standard text results
            text += `## Search Results\n\n`;
            text += `**Query:** ${query}\n`;
            text += `**Found:** ${response.number_of_results} total, showing ${processed.length} (deduplicated)\n`;
            if (response.suggestions.length > 0) {
              text += `**Suggestions:** ${response.suggestions.join(', ')}\n`;
            }
            if (response.answers.length > 0) {
              text += `**Answers:** ${response.answers.join('; ')}\n`;
            }
            if (response.unresponsive_engines.length > 0) {
              text += `**Unresponsive engines:** ${response.unresponsive_engines.map(e => e[0]).join(', ')}\n`;
            }
            text += '\n';

            if (processed.length > 0) {
              for (let i = 0; i < processed.length; i++) {
                const r = processed[i];
                text += `### [${i + 1}] [${r.title}](${r.url})\n`;
                text += `- **Engines:** ${r.engines.join(', ')} | **Score:** ${r.score.toFixed(2)}\n`;
                if (r.publishedDate) text += `- **Date:** ${r.publishedDate}\n`;
                if (r.snippet) text += `\n> ${r.snippet}\n`;
                text += '\n';
              }
            } else {
              text += '_No results found. Try different keywords, categories, or engines._\n';
            }
          }

          return { content: [{ type: 'text', text }] };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error('❌ [SearXNG] Search error:', error);
          return {
            content: [{ type: 'text', text: `Search failed: ${msg}` }],
            isError: true,
          };
        }
      }
    );

    const server = createSdkMcpServer({
      name: 'searxng',
      version: '1.0.0',
      tools: [searchTool],
    });

    queryOptions.mcpServers = { ...queryOptions.mcpServers, searxng: server };

    const toolNames = getSearxngToolNames();
    if (!queryOptions.allowedTools) {
      queryOptions.allowedTools = [...toolNames];
    } else {
      for (const name of toolNames) {
        if (!queryOptions.allowedTools.includes(name)) {
          queryOptions.allowedTools.push(name);
        }
      }
    }
  } catch (error) {
    console.error('❌ [SearXNG] Failed to integrate SDK MCP server:', error);
  }
}

export function getSearxngToolNames(): string[] {
  return ['mcp__searxng__searxng_search'];
}
