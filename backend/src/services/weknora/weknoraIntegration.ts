/**
 * WeKnora MCP Server Integration
 *
 * Provides an SDK MCP server for WeKnora knowledge base search.
 * The server is created dynamically with credentials captured via closure.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * WeKnora context passed from client
 */
export interface WeknoraContext {
  api_key: string;
  kb_ids: string[];
  base_url: string;
}

/**
 * Integrate WeKnora MCP Server into queryOptions
 *
 * @param queryOptions - The query options object to modify
 * @param context - WeKnora context with credentials
 */
export async function integrateWeKnoraMcpServer(
  queryOptions: any,
  context: WeknoraContext
): Promise<void> {
  try {
    const { server } = await createWeKnoraSdkMcpServer(context);

    // Add to mcpServers
    queryOptions.mcpServers = {
      ...queryOptions.mcpServers,
      "weknora": server
    };

    // Add tool to allowedTools
    const toolName = getWeknoraToolName();
    if (!queryOptions.allowedTools) {
      queryOptions.allowedTools = [toolName];
    } else if (!queryOptions.allowedTools.includes(toolName)) {
      queryOptions.allowedTools.push(toolName);
    }
  } catch (error) {
    console.error('❌ [WeKnora] Failed to integrate SDK MCP server:', error);
    // Continue without WeKnora support rather than failing
  }
}

/**
 * Create WeKnora SDK MCP Server
 *
 * Credentials are captured via closure at creation time.
 */
async function createWeKnoraSdkMcpServer(context: WeknoraContext) {
  const { api_key, kb_ids, base_url } = context;

  const weknoraSearchTool = tool(
    'weknora_search',
    `Search WeKnora knowledge bases for relevant information using hybrid search.

This tool queries the configured knowledge bases to find documents matching your query.

**When to use:**
- Answer questions requiring specific knowledge from documents
- Find relevant context for complex topics
- Look up information in the organization's knowledge base

**Query strategies:**
- Use specific keywords for precise matches
- Use natural language for semantic search
- Break complex queries into smaller, focused searches

**Configured knowledge bases:** ${kb_ids.length} selected

If results are insufficient, try rephrasing the query or breaking it into smaller parts.`,

    {
      query: z
        .string()
        .min(1, 'Query cannot be empty')
        .max(2000, 'Query too long (max 2000 characters)')
        .describe('Search query. Can be natural language or keywords.'),

      search_mode: z
        .enum(['hybrid', 'vector', 'keyword'])
        .optional()
        .default('hybrid')
        .describe('Search mode: hybrid (recommended, combines vector + keyword), vector (semantic only), or keyword (exact match).'),

      top_k: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe('Maximum number of results to return (1-50).'),

      min_score: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.5)
        .describe('Minimum relevance score threshold (0-1).'),

      rerank: z
        .boolean()
        .optional()
        .default(true)
        .describe('Apply reranking for better relevance ordering.'),
    },

    async (args) => {
      const { query, search_mode, top_k, min_score, rerank } = args;

      try {
        const response = await fetch(`${base_url}/api/v1/knowledge-search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${api_key}`,
          },
          body: JSON.stringify({
            question: query,
            knowledge_base_ids: kb_ids,
            search_mode: search_mode,
            top_k: top_k,
            min_score: min_score,
            rerank: rerank,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [{
              type: 'text',
              text: `Search failed: HTTP ${response.status} - ${errorText}`
            }],
            isError: true,
          };
        }

        const data = await response.json();
        const results = data.results || [];

        // Build formatted response
        let text = `## Search Results\n\n`;
        text += `**Query:** ${query}\n`;
        text += `**Mode:** ${search_mode}\n`;
        text += `**Found:** ${results.length} results\n\n`;

        if (results.length > 0) {
          text += '### Matched Documents\n\n';
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            text += `#### [${i + 1}] ${r.knowledge_title || 'Untitled'}\n`;
            text += `- **Score:** ${(r.score * 100).toFixed(1)}%\n`;
            text += `- **Source:** ${r.knowledge_filename || 'Unknown'}\n`;
            if (r.match_type) {
              text += `- **Match Type:** ${r.match_type}\n`;
            }
            text += `\n> ${r.content?.substring(0, 500)}${r.content?.length > 500 ? '...' : ''}\n\n`;
          }
        } else {
          text += '_No results found. Try different keywords or rephrasing your query._\n';
        }

        return { content: [{ type: 'text', text }] };

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[WeKnora] Search error:', error);

        return {
          content: [{
            type: 'text',
            text: `Search error: ${errorMessage}`
          }],
          isError: true,
        };
      }
    }
  );

  const server = createSdkMcpServer({
    name: 'weknora',
    version: '1.0.0',
    tools: [weknoraSearchTool],
  });

  return { server, tool: weknoraSearchTool };
}

/**
 * Get the full tool name as it appears to Claude
 */
export function getWeknoraToolName(): string {
  return 'mcp__weknora__weknora_search';
}
