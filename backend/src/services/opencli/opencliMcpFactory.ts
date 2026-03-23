import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { DOMAIN_MAPPING } from './constants.js';
import { bridgeRegistry } from './bridgeRegistry.js';
import { BridgeCommandProxy } from './bridgeCommandProxy.js';
import { formatOpenCliResult, formatOpenCliError } from './outputFormatter.js';
import type { OpenCliContext } from './types.js';

const commandProxy = new BridgeCommandProxy(bridgeRegistry);

/**
 * Returns the intersection of sites defined for a domain with the sites
 * actually available on the connected bridge.
 */
export function filterSitesByCapabilities(domain: string, availableSites: string[]): string[] {
  const domainSites = DOMAIN_MAPPING[domain];
  if (!domainSites) return [];
  const availableSet = new Set(availableSites);
  return domainSites.filter(site => availableSet.has(site));
}

/**
 * Generates a human-readable description for a site tool that the LLM
 * uses to decide when to invoke it.
 */
export function generateSiteToolDescription(site: string): string {
  return `Execute an action on ${site}.

Parameters:
- action (required): The action to perform (e.g. timeline, search, trending, list, info, read, post, comment, like, follow)
- query: Search query or text content (for search/post/comment actions)
- limit: Maximum number of results to return
- id: Target identifier (user ID, post ID, etc.)
- options: Additional key-value parameters for the action`;
}

/**
 * Main integration function. Creates MCP servers for each enabled OpenCLI
 * domain and registers them into queryOptions so Claude Agent SDK can
 * discover and invoke the tools.
 *
 * Pattern: one MCP server per domain (e.g. opencli-social, opencli-media),
 * with one tool per available site inside each server.
 */
export async function integrateOpenCliMcpServers(
  queryOptions: any,
  opencliContext: OpenCliContext,
  _askUserSessionRef: any,
  _agentId: string
): Promise<void> {
  const { projectId, userId, enabledDomains } = opencliContext;

  const entry = bridgeRegistry.get(projectId, userId);
  if (!entry) {
    console.warn('[OpenCLI] No bridge connected for', projectId, userId);
    return;
  }

  const availableSites = entry.capabilities.availableSites;
  const integratedDomains: string[] = [];

  for (const domain of enabledDomains) {
    const sites = filterSitesByCapabilities(domain, availableSites);
    if (sites.length === 0) continue;

    const siteTools = sites.map(site =>
      tool(
        site,
        generateSiteToolDescription(site),
        {
          action: z.string().describe('The action to perform on ' + site),
          query: z.string().optional().describe('Search query or text content'),
          limit: z.number().optional().describe('Maximum number of results'),
          id: z.string().optional().describe('Target identifier (user/post/item ID)'),
          options: z.record(z.string(), z.string()).optional().describe('Additional key-value parameters'),
        },
        async (args) => {
          const cliArgs: string[] = [args.action];
          if (args.query) cliArgs.push(args.query);
          if (args.limit !== undefined) cliArgs.push('--limit', String(args.limit));
          if (args.id) cliArgs.push('--id', args.id);
          if (args.options) {
            for (const [k, v] of Object.entries(args.options)) {
              cliArgs.push(`--${k}`, v);
            }
          }

          try {
            const stdout = await commandProxy.dispatch(projectId, userId, {
              site,
              action: args.action,
              args: cliArgs,
            });
            return formatOpenCliResult(site, args.action, stdout);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(`[OpenCLI] ${site}/${args.action} failed:`, msg);
            return formatOpenCliError(site, args.action, msg);
          }
        },
        { annotations: { readOnlyHint: false, openWorldHint: true } }
      )
    );

    const serverName = `opencli-${domain}`;
    const server = createSdkMcpServer({
      name: serverName,
      version: '1.0.0',
      tools: siteTools,
    });

    queryOptions.mcpServers = { ...queryOptions.mcpServers, [serverName]: server };

    const toolNames = sites.map(site => `mcp__${serverName}__${site}`);
    if (!queryOptions.allowedTools) {
      queryOptions.allowedTools = [...toolNames];
    } else {
      for (const name of toolNames) {
        if (!queryOptions.allowedTools.includes(name)) {
          queryOptions.allowedTools.push(name);
        }
      }
    }

    integratedDomains.push(`${domain}(${sites.length})`);
  }

  if (integratedDomains.length > 0) {
    console.log(`[OpenCLI] Integrated domains: ${integratedDomains.join(', ')}`);
  } else {
    console.log('[OpenCLI] No matching domains/sites found for bridge capabilities');
  }
}
