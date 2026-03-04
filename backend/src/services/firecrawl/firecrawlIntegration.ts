import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { FirecrawlConfig } from './types.js';
import { FirecrawlClient } from './firecrawlClient.js';

const SCRAPE_DESCRIPTION = `Fetch a web page and return its content as Markdown.
Supports JavaScript-rendered pages, anti-bot bypass, and main content extraction.

When to use:
- Read full text of a search result found via searxng_search
- Extract content from documentation pages
- Read blog posts or news articles

Parameters:
- url: The URL to fetch (required)
- max_length: Max characters to return (default: 8000, max: 50000)
- only_main_content: Extract body only, skip nav/footer (default: true)
- wait_for: Wait ms for JS rendering (use for slow-loading pages)`;

const MAP_DESCRIPTION = `Discover all URLs on a website without fetching their content.
Returns a list of URLs found on the site.

When to use:
- Explore a site's structure before scraping specific pages
- Find documentation pages, blog posts, or API references
- Build a sitemap for targeted scraping`;

export async function integrateFirecrawlMcpServer(
  queryOptions: any,
  config: FirecrawlConfig
): Promise<void> {
  try {
    // Health check: lightweight connectivity test (2s timeout)
    // Uses GET to root endpoint instead of a real scrape to avoid wasting API credits
    try {
      await fetch(config.base_url, {
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      console.warn('⚠️ [Firecrawl] Service unreachable, skipping MCP integration');
      return;
    }

    const client = new FirecrawlClient(config.base_url, config.api_key);

    const scrapeTool = tool(
      'firecrawl_scrape',
      SCRAPE_DESCRIPTION,
      {
        url: z.string().url().describe('The URL to fetch'),
        max_length: z.number().min(500).max(50000).optional().default(8000).describe('Max characters to return'),
        formats: z.array(z.enum(['markdown', 'html', 'links'])).optional().default(['markdown']).describe('Output formats'),
        only_main_content: z.boolean().optional().default(true).describe('Extract main content only'),
        wait_for: z.number().min(0).max(10000).optional().describe('Wait for JS rendering (ms)'),
      },
      async (args) => {
        const { url, max_length, formats, only_main_content, wait_for } = args;
        console.log('🔍 [Firecrawl] Scrape called:', { url, max_length });

        try {
          const result = await client.scrape(url, {
            formats,
            onlyMainContent: only_main_content,
            waitFor: wait_for,
          });

          // Client-side truncation
          const effectiveMaxLength = max_length ?? 8000;
          const markdown = result.markdown || '';
          const truncated = markdown.length > effectiveMaxLength
            ? markdown.slice(0, effectiveMaxLength) + `\n\n[... content truncated at ${effectiveMaxLength} chars]`
            : markdown;

          let text = '';
          if (result.metadata?.title) text += `# ${result.metadata.title}\n\n`;
          if (result.metadata?.url && result.metadata.url !== url) {
            text += `> Redirected to: ${result.metadata.url}\n\n`;
          }
          text += truncated;

          return { content: [{ type: 'text', text }] };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error('❌ [Firecrawl] Scrape error:', error);
          return {
            content: [{ type: 'text', text: `Scrape failed: ${msg}` }],
            isError: true,
          };
        }
      }
    );

    const mapTool = tool(
      'firecrawl_map',
      MAP_DESCRIPTION,
      {
        url: z.string().url().describe('The site URL to map'),
        search: z.string().optional().describe('Filter URLs by keyword'),
        limit: z.number().min(1).max(1000).optional().default(50).describe('Max URLs to return'),
      },
      async (args) => {
        const { url, search, limit } = args;
        console.log('🗺️ [Firecrawl] Map called:', { url, search, limit });

        try {
          const links = await client.mapSite(url, { search, limit });

          let text = `## Site Map: ${url}\n\n`;
          text += `**Found:** ${links.length} URLs`;
          if (search) text += ` (filtered by "${search}")`;
          text += '\n\n';

          for (const link of links) {
            text += `- ${link}\n`;
          }

          return { content: [{ type: 'text', text }] };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error('❌ [Firecrawl] Map error:', error);
          return {
            content: [{ type: 'text', text: `Map failed: ${msg}` }],
            isError: true,
          };
        }
      }
    );

    const server = createSdkMcpServer({
      name: 'firecrawl',
      version: '1.0.0',
      tools: [scrapeTool, mapTool],
    });

    queryOptions.mcpServers = { ...queryOptions.mcpServers, firecrawl: server };

    const toolNames = getFirecrawlToolNames();
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
    console.error('❌ [Firecrawl] Failed to integrate SDK MCP server:', error);
  }
}

export function getFirecrawlToolNames(): string[] {
  return ['mcp__firecrawl__firecrawl_scrape', 'mcp__firecrawl__firecrawl_map'];
}
