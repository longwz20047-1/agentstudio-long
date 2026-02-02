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

    // Add tools to allowedTools
    const toolNames = getGraphitiToolNames();
    if (!queryOptions.allowedTools) {
      queryOptions.allowedTools = [...toolNames];
    } else {
      for (const toolName of toolNames) {
        if (!queryOptions.allowedTools.includes(toolName)) {
          queryOptions.allowedTools.push(toolName);
        }
      }
    }
  } catch (error) {
    console.error('❌ [Graphiti] Failed to integrate SDK MCP server:', error);
    // Continue without Graphiti support rather than failing
  }
}

/**
 * Get the full tool name for search as it appears to Claude
 */
export function getGraphitiSearchToolName(): string {
  return 'mcp__graphiti__graphiti_search_memory';
}

/**
 * Get the full tool name for add memory as it appears to Claude
 */
export function getGraphitiAddMemoryToolName(): string {
  return 'mcp__graphiti__graphiti_add_memory';
}

/**
 * Get all Graphiti tool names
 */
export function getGraphitiToolNames(): string[] {
  return [getGraphitiSearchToolName(), getGraphitiAddMemoryToolName()];
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

  // Primary group_id for writing (user-specific)
  const primaryGroupId = `user_${user_id}`;

  const graphitiAddMemoryTool = tool(
    'graphiti_add_memory',
    `Save important information to user's long-term memory.

**MUST use when:**
- User explicitly requests: "记住...", "remember...", "别忘了..."
- User states persistent preferences: "我喜欢...", "我不喜欢...", "我偏好..."
- User shares identity facts: name, job, location, relationships, birthday

**MUST NOT use when:**
- Temporary context (today's task, current conversation topic)
- Sensitive data (passwords, API keys, financial details, health info)
- Opinions about external things (movie reviews, news comments)
- Information that may change frequently

**Role type guide:**
- "user": Facts FROM or ABOUT the user (default, use this most often)
- "assistant": Assistant's conclusions or summaries about user
- "system": Rarely used, only for system-level metadata

**Examples:**
✅ "我叫张三，在北京工作" → content="用户名叫张三，在北京工作", role_type="user"
✅ "记住我喜欢蓝色" → content="用户喜欢蓝色", role_type="user"
❌ "今天天气真好" → Do not save (temporary)
❌ "帮我查一下订单" → Do not save (task, not fact)

**Configured memory scope:** Writing to group "${primaryGroupId}"`,

    {
      content: z
        .string()
        .min(1, 'Content cannot be empty')
        .max(2000, 'Content too long (max 2000 characters)')
        .describe('The information to save to memory. Should be a clear, factual statement.'),
      role_type: z
        .enum(['user', 'assistant', 'system'])
        .default('user')
        .optional()
        .describe('The role type: "user" for user facts (default), "assistant" for AI conclusions, "system" for metadata'),
      role: z
        .string()
        .max(100)
        .optional()
        .describe('Optional role name (e.g., user name, bot name)'),
      source_description: z
        .string()
        .max(500)
        .optional()
        .describe('Optional description of the source of this information'),
    },

    async (args) => {
      const { content, role_type = 'user', role, source_description } = args;

      console.log('📝 [Graphiti] Adding memory:', { content, role_type, group_id: primaryGroupId });

      try {
        const response = await fetch(`${base_url}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(api_key ? { 'Authorization': `Bearer ${api_key}` } : {}),
          },
          body: JSON.stringify({
            group_id: primaryGroupId,
            messages: [{
              content,
              role_type,
              role: role || null,
              source_description: source_description || 'a2a_conversation',
            }],
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ [Graphiti] Add memory API error:', response.status, errorText);
          return {
            content: [{ type: 'text', text: `Failed to save memory: ${response.status} - ${errorText}` }],
            isError: true,
          };
        }

        const data = await response.json();
        console.log('✅ [Graphiti] Memory saved successfully:', data);

        return {
          content: [{
            type: 'text',
            text: `✅ Memory saved successfully.\n\n**Content:** ${content}\n**Group:** ${primaryGroupId}\n**Role:** ${role_type}`
          }],
        };

      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('❌ [Graphiti] Add memory error:', error);
        return {
          content: [{ type: 'text', text: `Memory save error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  const server = createSdkMcpServer({
    name: 'graphiti',
    version: '1.0.0',
    tools: [graphitiSearchTool, graphitiAddMemoryTool],
  });

  return { server, tools: [graphitiSearchTool, graphitiAddMemoryTool] };
}
