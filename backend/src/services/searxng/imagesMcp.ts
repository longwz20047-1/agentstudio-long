// imagesMcp.ts — image_search MCP tool with CJK detection and deduplication

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SearxngConfig } from './types.js';
import { SearXNGClient } from './searxngClient.js';

const SERVER_NAME = 'searxng-images';
const TOOL_NAME = 'image_search';

const TOOL_DESCRIPTION = `Search for images across multiple search engines.
Use this tool when the user explicitly asks for images, photos,
illustrations, screenshots, diagrams, or visual references.

Parameters:
- query: Short, descriptive keywords focused on the visual subject.
  Use concrete nouns and adjectives rather than abstract concepts.
  For technical diagrams, prefer English terms for better results.
- max_results: 1-30, default 12

Examples:
- "给我看看北极光的照片" → query: "aurora borealis photography"
- "React 组件生命周期图" → query: "React component lifecycle diagram"
- "柴犬表情包" → query: "shiba inu meme"

Results are displayed as a visual gallery card automatically.
You do NOT need to describe each image. Instead:
- Briefly mention how many results were found
- If the user asked for something specific, point out which
  result(s) best match their request
- If results seem irrelevant, suggest a refined query
- If zero results, suggest alternative keywords`;

const BASE_ENGINES = 'google images,bing images,duckduckgo images,flickr,pexels,unsplash';
const ZH_ENGINES = BASE_ENGINES + ',baidu images,quark images';

const CJK_REGEX = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;

function isCJK(query: string): boolean {
  return CJK_REGEX.test(query);
}

function fixImageUrl(url: string | undefined): string {
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  return url;
}

export async function integrateImagesMcp(
  queryOptions: any,
  config: SearxngConfig
): Promise<void> {
  const client = new SearXNGClient(config.base_url);

  const imageSearchTool = tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    {
      query: z.string().describe('Descriptive search keywords for images'),
      max_results: z.number().min(1).max(30).optional().describe('Max results (default 12)'),
    },
    async (args) => {
      const startTime = Date.now();
      const { query, max_results = 12 } = args;

      try {
        // Step 1: Detect language and select engines
        const engines = isCJK(query) ? ZH_ENGINES : BASE_ENGINES;

        // Step 2: Search via SearXNG with images category
        const response = await client.search({
          q: query,
          engines,
          categories: 'images',
          pageno: 1,
          safesearch: 0,
        });

        // Step 3: Deduplicate by img_src or url
        const seen = new Set<string>();
        const unique = response.results.filter((r) => {
          const key = r.img_src || r.url;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Step 4: Limit to max_results
        const limited = unique.slice(0, max_results);

        // Step 5: Map to output format with URL fixing
        const images = limited.map((r) => {
          const result: Record<string, unknown> = {
            title: r.title,
            thumbnail: fixImageUrl(r.thumbnail),
            fullUrl: fixImageUrl(r.img_src || r.url),
            sourceUrl: r.url,
          };

          const imgWidth = r.img_width;
          const imgHeight = r.img_height;

          if (imgWidth) result.width = imgWidth;
          if (imgHeight) result.height = imgHeight;
          if (r.img_format) result.format = r.img_format;

          return result;
        });

        const totalMs = Date.now() - startTime;
        const engineList = engines.split(',').map((e) => e.trim());

        console.log('[ImageSearch]', JSON.stringify({
          query,
          engines,
          resultCount: images.length,
          totalMs,
        }));

        const output = {
          query,
          images,
          engines: engineList,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Image search error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    tools: [imageSearchTool],
  });

  queryOptions.mcpServers = { ...queryOptions.mcpServers, [SERVER_NAME]: server };

  const fullToolName = `mcp__${SERVER_NAME}__${TOOL_NAME}`;
  if (!queryOptions.allowedTools) {
    queryOptions.allowedTools = [fullToolName];
  } else if (!queryOptions.allowedTools.includes(fullToolName)) {
    queryOptions.allowedTools.push(fullToolName);
  }
}

export function getImagesToolNames(): string[] {
  return [`mcp__${SERVER_NAME}__${TOOL_NAME}`];
}
