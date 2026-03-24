import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { DOMAIN_MAPPING, WRITE_COMMAND_TIMEOUT, DEFAULT_COMMAND_TIMEOUT, CONFIRMATION_TIMEOUT } from './constants.js';
import { formatOpenCliResult, formatOpenCliError } from './outputFormatter.js';
import { isWriteOperation, hasSessionApproval, grantSessionApproval, buildConfirmationPrompt } from './permissionEngine.js';
import { userInputRegistry } from '../askUserQuestion/userInputRegistry.js';
import type { OpenCliContext } from './types.js';

import { bridgeCommandProxy as commandProxy, bridgeRegistry } from './singletons.js';

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
  askUserSessionRef: any,
  agentId: string,
  sessionId?: string
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

          // Permission check for write operations
          if (isWriteOperation(site, args.action)) {
            const effectiveSessionId = askUserSessionRef?.current || sessionId || '';
            if (!effectiveSessionId) {
              return formatOpenCliError(site, args.action, 'No session context — cannot confirm write operation.');
            }
            if (!hasSessionApproval(effectiveSessionId, site, args.action)) {
              const CONFIRM_TIMEOUT = CONFIRMATION_TIMEOUT;
              const prompt = buildConfirmationPrompt(site, args.action, cliArgs);
              const toolUseId = `opencli-confirm-${uuidv4()}`;
              let timeoutId: NodeJS.Timeout | undefined;

              try {
                const response = await Promise.race([
                  userInputRegistry.waitForUserInput(
                    effectiveSessionId,
                    agentId,
                    toolUseId,
                    [{ question: prompt, header: 'OpenCLI Permission', options: [], multiSelect: false }]
                  ),
                  new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(
                      () => reject(new Error('Confirmation timed out (3 min). Please retry the command.')),
                      CONFIRM_TIMEOUT
                    );
                  }),
                ]);
                clearTimeout(timeoutId);

                const lower = response.toLowerCase().trim();
                if (lower.includes('reject') || lower.includes('cancel') || lower === 'no' || lower === 'n') {
                  return formatOpenCliError(site, args.action, 'User rejected the write operation.');
                }

                grantSessionApproval(effectiveSessionId, site, args.action);
              } catch (err) {
                clearTimeout(timeoutId);
                try { userInputRegistry.cancelUserInput(toolUseId); } catch {}
                return formatOpenCliError(site, args.action, (err as Error).message);
              }
            }
          }

          try {
            const timeout = isWriteOperation(site, args.action) ? WRITE_COMMAND_TIMEOUT : DEFAULT_COMMAND_TIMEOUT;
            const stdout = await commandProxy.dispatch(projectId, userId, {
              site,
              action: args.action,
              args: cliArgs,
              timeout,
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
