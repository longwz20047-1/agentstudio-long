/**
 * Graphiti Memory MCP Server Integration
 *
 * Provides an SDK MCP server for Graphiti memory search.
 * The server is created dynamically with credentials captured via closure.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { GraphitiContext } from './types.js';

// Type definitions (matching Graphiti API response)
interface FactResult {
  uuid: string;
  name: string;
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
  created_at: string;
  expired_at: string | null;
}

interface SearchResults {
  facts: FactResult[];
}

/**
 * Integrate Graphiti MCP Server into queryOptions
 *
 * @param queryOptions - The query options object to modify
 * @param context - Graphiti context with credentials
 */
export async function integrateGraphitiMcpServer(
  queryOptions: any,
  context: GraphitiContext
): Promise<void> {
  try {
    const { server } = await createGraphitiSdkMcpServer(context);

    // Add to mcpServers
    queryOptions.mcpServers = {
      ...queryOptions.mcpServers,
      "graphiti": server
    };

    // Add tool to allowedTools
    const toolName = getGraphitiToolName();
    if (!queryOptions.allowedTools) {
      queryOptions.allowedTools = [toolName];
    } else if (!queryOptions.allowedTools.includes(toolName)) {
      queryOptions.allowedTools.push(toolName);
    }
  } catch (error) {
    console.error('❌ [Graphiti] Failed to integrate SDK MCP server:', error);
    // Continue without Graphiti support rather than failing
  }
}

/**
 * Get the full tool name as it appears to Claude
 */
export function getGraphitiToolName(): string {
  return 'mcp__graphiti__graphiti_search_memory';
}

/**
 * Create Graphiti SDK MCP Server
 *
 * Credentials are captured via closure at creation time.
 */
async function createGraphitiSdkMcpServer(context: GraphitiContext) {
  const { base_url, user_id, group_ids = [], api_key } = context;

  // Merge group_ids: user-specific + additional groups
  const allGroupIds = [`user_${user_id}`, ...group_ids];

  const graphitiSearchTool = tool(
    'graphiti_search_memory',
    `Search long-term memory for relevant facts and context.

**When to use:**
- Recall past conversations or user preferences
- Find relevant context before responding
- Look up previously learned information

**Configured memory scope:** User "${user_id}" + ${group_ids.length} shared groups

If results are insufficient, try rephrasing the query or using different keywords.`,

    {
      query: z
        .string()
        .min(1, 'Query cannot be empty')
        .max(1000, 'Query too long (max 1000 characters)')
        .describe('Natural language search query for memory retrieval'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .optional()
        .describe('Maximum number of results (default: 10)'),
    },

    async (args) => {
      const { query, limit = 10 } = args;

      console.log('🧠 [Graphiti] Memory search:', { query, user_id, group_ids: allGroupIds });

      try {
        const response = await fetch(`${base_url}/search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(api_key ? { 'Authorization': `Bearer ${api_key}` } : {}),
          },
          body: JSON.stringify({
            query: query,
            group_ids: allGroupIds,
            max_facts: limit,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ [Graphiti] API error:', response.status, errorText);
          return {
            content: [{ type: 'text', text: `Memory search failed: ${response.status} - ${errorText}` }],
            isError: true,
          };
        }

        const data: SearchResults = await response.json();
        const facts = data.facts || [];

        console.log('✅ [Graphiti] Found', facts.length, 'memories');

        // Format output
        let text = `## Memory Search Results\n\n`;
        text += `**Query:** ${query}\n`;
        text += `**Found:** ${facts.length} relevant memories\n\n`;

        if (facts.length > 0) {
          for (const fact of facts) {
            const validDate = fact.valid_at
              ? new Date(fact.valid_at).toLocaleDateString('zh-CN')
              : null;
            const isExpired = fact.invalid_at !== null || fact.expired_at !== null;

            text += `- **[${fact.name}]** ${fact.fact}`;
            if (validDate) {
              text += ` _(${validDate})_`;
            }
            if (isExpired) {
              text += ` ⚠️已过期`;
            }
            text += `\n`;
          }
        } else {
          text += `_No relevant memories found for this query._\n`;
        }

        return { content: [{ type: 'text', text }] };

      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('❌ [Graphiti] Error:', error);
        return {
          content: [{ type: 'text', text: `Memory search error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  const server = createSdkMcpServer({
    name: 'graphiti',
    version: '1.0.0',
    tools: [graphitiSearchTool],
  });

  return { server, tool: graphitiSearchTool };
}
