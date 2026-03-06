// videosMcp.ts — video_search MCP tool with CJK detection, platform inference, and deduplication

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SearxngConfig } from './types.js';
import { SearXNGClient } from './searxngClient.js';

const SERVER_NAME = 'searxng-videos';
const TOOL_NAME = 'video_search';

const TOOL_DESCRIPTION = `Search for videos on YouTube, Bilibili, and other platforms.
Use this tool when the user asks to find video tutorials,
talks, demos, or any video content.

Parameters:
- query: Keywords describing the video topic.
  Include platform name if the user specifies one.
  For technical tutorials, prefer English terms for broader results.
- max_results: 1-20, default 8

Examples:
- "有没有 Docker 入门教程" → query: "Docker tutorial for beginners"
- "bilibili上的机器学习课程" → query: "机器学习 课程 教程", (bilibili auto-included for Chinese)
- "React Server Components 演讲" → query: "React Server Components talk conference"

Results are displayed as a visual video gallery card automatically.
You do NOT need to list each video. Instead:
- Briefly mention how many results were found
- If the user wants a recommendation, suggest the most relevant
  video based on title, duration, and author
- If results seem irrelevant, suggest a refined query
- If zero results, suggest alternative keywords`;

const BASE_ENGINES = 'youtube,google videos,bing videos,duckduckgo videos';
const ZH_ENGINES = BASE_ENGINES + ',bilibili';

const CJK_REGEX = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;

function isCJK(query: string): boolean {
  return CJK_REGEX.test(query);
}

const PLATFORM_MAP: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /youtube\.com|youtu\.be/i, name: 'youtube' },
  { pattern: /bilibili\.com|b23\.tv/i, name: 'bilibili' },
  { pattern: /vimeo\.com/i, name: 'vimeo' },
  { pattern: /dailymotion\.com/i, name: 'dailymotion' },
];

function inferPlatform(url: string): string {
  for (const { pattern, name } of PLATFORM_MAP) {
    if (pattern.test(url)) return name;
  }
  return 'other';
}

export async function integrateVideosMcp(
  queryOptions: any,
  config: SearxngConfig
): Promise<void> {
  const client = new SearXNGClient(config.base_url);

  const videoSearchTool = tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    {
      query: z.string().describe('Keywords describing the video topic'),
      max_results: z.number().min(1).max(20).optional().describe('Max results (default 8)'),
    },
    async (args) => {
      const startTime = Date.now();
      const { query, max_results = 8 } = args;

      try {
        // Step 1: Detect language and select engines
        const engines = isCJK(query) ? ZH_ENGINES : BASE_ENGINES;

        // Step 2: Search via SearXNG with videos category
        const response = await client.search({
          q: query,
          engines,
          categories: 'videos',
          pageno: 1,
          safesearch: 0,
        });

        // Step 3: Deduplicate by url
        const seen = new Set<string>();
        const unique = response.results.filter((r) => {
          const key = r.url;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Step 4: Limit to max_results
        const limited = unique.slice(0, max_results);

        // Step 5: Map to output format with platform inference
        const videos = limited.map((r) => {
          const result: Record<string, unknown> = {
            title: r.title,
            thumbnail: r.thumbnail || '',
            url: r.url,
            platform: inferPlatform(r.url),
          };

          const duration = r.length;
          const author = r.author;

          if (duration) result.duration = duration;
          if (author) result.author = author;
          if (r.publishedDate) result.publishedDate = r.publishedDate;

          return result;
        });

        const totalMs = Date.now() - startTime;
        const engineList = engines.split(',').map((e) => e.trim());

        console.log('[VideoSearch]', JSON.stringify({
          query,
          engines,
          resultCount: videos.length,
          totalMs,
        }));

        const output = {
          query,
          videos,
          engines: engineList,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Video search error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    tools: [videoSearchTool],
  });

  queryOptions.mcpServers = { ...queryOptions.mcpServers, [SERVER_NAME]: server };

  const fullToolName = `mcp__${SERVER_NAME}__${TOOL_NAME}`;
  if (!queryOptions.allowedTools) {
    queryOptions.allowedTools = [fullToolName];
  } else if (!queryOptions.allowedTools.includes(fullToolName)) {
    queryOptions.allowedTools.push(fullToolName);
  }
}

export function getVideosToolNames(): string[] {
  return [`mcp__${SERVER_NAME}__${TOOL_NAME}`];
}
