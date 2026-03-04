import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SearxngConfig } from './types.js';
import { SearXNGClient } from './searxngClient.js';
import { dedupeAndRank } from './resultProcessor.js';

const TOOL_DESCRIPTION = `Search the web using SearXNG meta-search engine (109 engines, 27 categories).

Categories (pass to categories param):
  general, images, videos, news, music, it, science, scientific publications,
  files, social media, map, packages, repos, q&a, translate, dictionaries,
  web, software wikis, weather, currency, icons, books, wikimedia, radio,
  lyrics, movies, shopping

Common engines (pass to engines param):
  General: google, duckduckgo, baidu, sogou, quark, brave
  Chinese: baidu, sogou, quark, sogou wechat(微信公众号), bilibili, chinaso news
  Code: github, stackoverflow, mdn, npm, pypi, docker hub, pkg.go.dev, crates.io
  Academic: google scholar, arxiv, semantic scholar, pubmed, crossref, openalex
  Media: youtube, bilibili, unsplash, pexels, flickr, soundcloud
  News: bing news, google news, baidu news

Tips:
- Use categories for broad search, engines for targeted search
- engines="sogou wechat" for WeChat articles
- language="zh-CN" for Chinese, "en" for English
- categories="it" + engines="github,stackoverflow" for code search

**IMPORTANT - Response format rules:**
1. ALWAYS include clickable source links: [Page Title](URL)
2. For image search results (categories="images"): You MUST output the image markdown EXACTLY as provided in the tool results. Do NOT summarize images as text. Do NOT describe images in words. DIRECTLY copy every [![...](thumbnail)](full_url) line into your response so images render visually in the chat. This is critical - users expect to SEE the images, not read about them.
3. For general/news results: Use numbered list with links and snippets.`;

export async function integrateSearchMcpServer(
  queryOptions: any,
  config: SearxngConfig
): Promise<void> {
  try {
    // Health check (2s timeout, skip if unreachable)
    try {
      await fetch(`${config.base_url}/search?q=ping&format=json`, {
        signal: AbortSignal.timeout(2000),
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
        max_results: z.number().min(1).max(30).optional().default(10).describe('Max results to return (client-side limit)'),
      },
      async (args) => {
        const { query, categories, engines, language, time_range, pageno, safesearch, max_results } = args;

        console.log('🔍 [SearXNG] Tool called:', { query, categories, engines, language, time_range });

        try {
          const response = await client.search({
            q: query,
            categories,
            engines,
            language,
            time_range,
            pageno,
            safesearch,
          });

          const processed = dedupeAndRank(response.results, max_results ?? 10);

          // Detect if this is an image search
          const hasImages = processed.some(r => r.img_src || r.thumbnail);

          let text = '';

          if (hasImages) {
            // Image search: build a ready-to-use visual gallery response
            text += `为你搜索到 ${processed.length} 张「${query}」相关图片：\n\n`;

            for (let i = 0; i < processed.length; i++) {
              const r = processed[i];
              const imgUrl = r.img_src || r.thumbnail || '';
              const thumbUrl = r.thumbnail || r.img_src || '';
              if (imgUrl) {
                text += `[![${r.title}](${thumbUrl})](${imgUrl})\n`;
                text += `**${i + 1}.** [${r.title}](${r.url})\n\n`;
              }
            }

            text += `---\n来源引擎：${[...new Set(processed.flatMap(r => r.engines))].join(', ')}\n`;
            text += `\n[INSTRUCTION TO ASSISTANT: The above is a complete response with inline images. Output it EXACTLY as-is to the user. Do NOT rewrite, summarize, or describe the images in text. The chat UI renders markdown images. If you convert images to text links, the user cannot see the pictures.]`;
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
