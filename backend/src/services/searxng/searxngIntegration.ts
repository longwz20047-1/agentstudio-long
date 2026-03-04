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

**IMPORTANT - Source citation format:**
When presenting search results in your response, ALWAYS include clickable source links.
Format: [Page Title](URL) or numbered list with links.
Example:
  1. [Docker 官方文档](https://docs.docker.com/get-started/) - 容器化入门指南
  2. [Kubernetes 教程](https://kubernetes.io/docs/tutorials/) - K8s 官方教程
Always cite the original URL so users can click to visit the source page.`;

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

          let text = `## Search Results\n\n`;
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
              // Render image thumbnail for image search results
              if (r.img_src) {
                text += `\n[![${r.title}](${r.thumbnail || r.img_src})](${r.img_src})\n`;
              } else if (r.thumbnail) {
                text += `\n![${r.title}](${r.thumbnail})\n`;
              }
              if (r.snippet) text += `\n> ${r.snippet}\n`;
              text += '\n';
            }
          } else {
            text += '_No results found. Try different keywords, categories, or engines._\n';
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
