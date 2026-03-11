import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { FirecrawlConfig } from './types.js';
import { FirecrawlClient } from './firecrawlClient.js';
import { firecrawlCircuitBreaker } from './circuitBreaker.js';

const MAX_SCREENSHOT_BASE64_LENGTH = 1_400_000; // ~1MB — JPEG compression makes most screenshots fit

const annotations = { readOnlyHint: true, openWorldHint: true };

const SCRAPE_DESCRIPTION = `Fetch a web page and return clean content (Markdown, HTML, links, or screenshot).

Capabilities:
- JavaScript rendering (waits for dynamic content to load)
- Main content extraction (strips nav, footer, ads)
- Page screenshots (use formats: ["screenshot"])
- CSS selector filtering (include/exclude specific elements)
- SSRF protection (internal networks blocked automatically)

When to use:
- Read full text of a URL found via web_search
- Extract content from documentation, blog posts, or articles
- Capture a visual snapshot of a page (screenshot format)
- Get only specific page sections (include_tags/exclude_tags)

Note: web_search already extracts top result content automatically.
Only use firecrawl_scrape when you need:
- More content (web_search extracts ~20K chars; scrape supports up to 50K)
- Screenshot capture
- CSS-targeted extraction
- A specific URL not from search results

Parameters:
- url: Public internet URL to fetch
- max_length: Max output characters (default 20000, max 50000)
- formats: Output formats - "markdown" (default), "html", "links", "screenshot"
- only_main_content: Strip nav/footer (default true)
- wait_for: Wait ms for JS rendering (2000-5000 for React/Vue/Angular SPAs)
- include_tags: CSS selectors to keep (e.g., ["article", ".content"])
- exclude_tags: CSS selectors to remove (e.g., [".ads", ".sidebar"])`;

const INTERACT_DESCRIPTION = `Interact with a web page (click, type, scroll) then scrape its content.
Uses a real browser (Playwright) to execute actions before extracting content.

When to use:
- Page requires clicking "Load More" or "Show All" to reveal content
- Need to close cookie banners or popups before reading
- Content is behind a tab, accordion, or expandable section
- Need to scroll to trigger lazy-loading content
- Want a screenshot after performing interactions

Supported actions (executed in order):
- click: Click an element (requires CSS selector)
- write: Type text into focused input
- press: Press a keyboard key (Enter, Tab, Escape, etc.)
- wait: Pause for specified milliseconds, or wait for element to appear (use selector)
- scroll: Scroll the page (up/down)
- screenshot: Capture page image at this point
- executeJavascript: Run custom JS code and get return value

Tips:
- Always add a "wait" action (1000-3000ms) after "click" for content to render
- Maximum 25 actions per call to prevent abuse
- Use browser DevTools to find CSS selectors (right-click → Inspect)

Example - Load more comments:
  actions: [
    { type: "click", selector: "#load-more-btn" },
    { type: "wait", milliseconds: 2000 },
    { type: "screenshot", fullPage: true }
  ]`;


const EXTRACT_DESCRIPTION = `Extract structured data from web pages using AI.
Powered by LLM-based analysis of page content.

When to use:
- Extract product details (name, price, rating) from multiple product pages
- Pull contact information from company websites
- Gather event details (date, location, speaker) from event pages
- Extract table data into structured JSON format

Parameters:
- urls: List of URLs to extract from (max 10, supports glob: "https://shop.com/products/*")
- prompt: What data to extract (e.g., "Extract product name, price, and availability")
- system_prompt: Optional system prompt to guide extraction behavior
- schema: Optional JSON Schema for output structure

Example:
  urls: ["https://shop.com/product/1", "https://shop.com/product/2"]
  prompt: "Extract product name, price, and customer rating"
  schema: {
    "type": "object",
    "properties": {
      "products": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "price": { "type": "number" },
            "rating": { "type": "number" }
          }
        }
      }
    }
  }`;

export async function integrateFirecrawlMcpServer(
  queryOptions: any,
  config: FirecrawlConfig
): Promise<boolean> {
  try {
    // Health check: lightweight connectivity test (3s timeout)
    try {
      await fetch(config.base_url, {
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      console.warn('⚠️ [Firecrawl] Service unreachable, skipping MCP integration');
      return false;
    }

    const client = new FirecrawlClient(config.base_url, config.api_key);

    // --- scrape tool (enhanced) ---
    const scrapeTool = tool(
      'firecrawl_scrape',
      SCRAPE_DESCRIPTION,
      {
        url: z.string().url().describe('The URL to fetch (must be public internet)'),
        max_length: z.number().min(500).max(50000).optional().default(20000)
          .describe('Max characters to return (default: 20000)'),
        formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'screenshot@fullPage']))
          .optional().default(['markdown'])
          .describe('Output formats. Use "screenshot" for viewport capture, "screenshot@fullPage" for full page'),
        only_main_content: z.boolean().optional().default(true)
          .describe('Extract main content only, removing nav/footer/sidebar'),
        wait_for: z.number().min(0).max(10000).optional()
          .describe('Wait ms for JS rendering (2000-5000 for SPA pages)'),
        include_tags: z.array(z.string()).optional()
          .describe('CSS selectors to include (e.g., ["article", ".main-content"])'),
        exclude_tags: z.array(z.string()).optional()
          .describe('CSS selectors to exclude (e.g., [".ads", ".cookie-banner"])'),
      },
      async (args) => {
        const { url, max_length, formats, only_main_content, wait_for, include_tags, exclude_tags } = args;
        console.log('🔍 [Firecrawl] Scrape called:', { url, max_length, formats });

        if (firecrawlCircuitBreaker.isOpen()) {
          return {
            content: [{ type: 'text', text: 'Firecrawl service temporarily unavailable (circuit breaker open). Try again in a few minutes.' }],
            isError: true,
          };
        }

        try {
          const result = await client.scrape(url, {
            formats,
            onlyMainContent: only_main_content,
            waitFor: wait_for,
            includeTags: include_tags,
            excludeTags: exclude_tags,
          });

          firecrawlCircuitBreaker.recordSuccess();

          const effectiveMaxLength = max_length ?? 20000;
          const markdown = result.markdown || '';
          const truncated = markdown.length > effectiveMaxLength
            ? markdown.slice(0, effectiveMaxLength) + `\n\n[... content truncated at ${effectiveMaxLength} chars]`
            : markdown;

          let text = '';
          if (result.metadata?.title) text += `# ${result.metadata.title}\n\n`;
          text += `> Source: ${result.metadata?.sourceURL || url}\n`;
          if (result.metadata?.language) text += `> Language: ${result.metadata.language} | `;
          else text += '> ';
          text += `Status: ${result.metadata?.statusCode || 'unknown'}\n\n`;
          if (result.metadata?.url && result.metadata.url !== url) {
            text += `> Redirected to: ${result.metadata.url}\n\n`;
          }
          text += truncated;

          const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [{ type: 'text', text }];

          // Screenshot from formats
          const screenshotBase64 = result.screenshot;
          if (screenshotBase64 && screenshotBase64.length > MAX_SCREENSHOT_BASE64_LENGTH) {
            content.push({ type: 'text', text: '⚠️ Screenshot too large (>200KB), omitted to save context.' });
          } else if (screenshotBase64) {
            content.push({ type: 'image' as const, data: screenshotBase64, mimeType: 'image/jpeg' });
          }

          return { content };
        } catch (error) {
          firecrawlCircuitBreaker.recordFailure();
          const msg = error instanceof Error ? error.message : String(error);
          console.warn('[Firecrawl] Scrape failed:', msg);
          return {
            content: [{ type: 'text', text: `Scrape failed: ${msg}` }],
            isError: true,
          };
        }
      },
      { annotations }
    );

    // --- interact tool (new) ---
    const interactTool = tool(
      'firecrawl_interact',
      INTERACT_DESCRIPTION,
      {
        url: z.string().url().describe('The page URL to interact with'),
        actions: z.array(z.object({
          type: z.enum(['click', 'write', 'press', 'wait', 'scroll', 'screenshot', 'executeJavascript'])
            .describe('Action type'),
          selector: z.string().optional()
            .describe('CSS selector for click/scroll target'),
          text: z.string().optional()
            .describe('Text to type (for write action)'),
          key: z.string().optional()
            .describe('Key to press, e.g. "Enter", "Tab" (for press action)'),
          milliseconds: z.number().optional()
            .describe('Wait duration in ms (for wait action)'),
          direction: z.enum(['up', 'down']).optional()
            .describe('Scroll direction (for scroll action)'),
          fullPage: z.boolean().optional()
            .describe('Capture full page screenshot (for screenshot action)'),
          quality: z.number().min(1).max(100).optional()
            .describe('Screenshot quality 1-100 (for screenshot action)'),
          all: z.boolean().optional()
            .describe('Click all matching elements (for click action)'),
          script: z.string().optional()
            .describe('JavaScript code (for executeJavascript action)'),
        })).min(1).max(25)
          .describe('Sequence of browser actions to perform before scraping'),
        max_length: z.number().min(500).max(50000).optional().default(20000)
          .describe('Max characters in output'),
        only_main_content: z.boolean().optional().default(true)
          .describe('Extract main content only'),
      },
      async (args) => {
        const { url, actions: rawActions, max_length, only_main_content } = args;
        console.log('🖱️ [Firecrawl] Interact called:', { url, actionCount: rawActions.length });

        if (firecrawlCircuitBreaker.isOpen()) {
          return {
            content: [{ type: 'text', text: 'Firecrawl service temporarily unavailable (circuit breaker open). Try again in a few minutes.' }],
            isError: true,
          };
        }

        // Sanitize actions to prevent Firecrawl validation errors
        // - wait: must have either milliseconds or selector, not both
        // - Each action type should only include relevant fields
        type ActionObj = typeof rawActions[number];
        const actions: ActionObj[] = rawActions.map(action => {
          switch (action.type) {
            case 'click':
              return { type: action.type, selector: action.selector, all: action.all };
            case 'write':
              return { type: action.type, selector: action.selector, text: action.text };
            case 'press':
              return { type: action.type, key: action.key };
            case 'wait':
              // Firecrawl requires EITHER milliseconds OR selector, not both
              if (action.selector && action.milliseconds) {
                return { type: action.type, selector: action.selector };
              } else if (action.selector) {
                return { type: action.type, selector: action.selector };
              }
              return { type: action.type, milliseconds: action.milliseconds ?? 1000 };
            case 'scroll':
              return { type: action.type, selector: action.selector, direction: action.direction };
            case 'screenshot':
              return { type: action.type, fullPage: action.fullPage, quality: action.quality };
            case 'executeJavascript':
              return { type: action.type, script: action.script };
            default:
              return action;
          }
        });

        try {
          const result = await client.scrape(url, {
            formats: ['markdown'],
            onlyMainContent: only_main_content,
            actions,
            timeout: 60000, // Actions need more time than default 30s
          });

          firecrawlCircuitBreaker.recordSuccess();

          const effectiveMaxLength = max_length ?? 20000;

          // Build interaction summary
          let text = `## Interaction Summary\n\nExecuted ${rawActions.length} actions on ${url}:\n`;
          for (let i = 0; i < rawActions.length; i++) {
            const action = rawActions[i];
            let detail = '';
            if (action.selector) detail = action.selector;
            else if (action.text) detail = `"${action.text}"`;
            else if (action.key) detail = action.key;
            else if (action.milliseconds) detail = `${action.milliseconds}ms`;
            else if (action.direction) detail = action.direction;
            else if (action.fullPage) detail = 'full page';
            else if (action.script) detail = 'custom script';
            text += `${i + 1}. ✅ ${action.type}${detail ? ': ' + detail : ''}\n`;
          }
          text += '\n---\n\n';

          // Page content
          const markdown = result.markdown || '';
          const truncated = markdown.length > effectiveMaxLength
            ? markdown.slice(0, effectiveMaxLength) + `\n\n[... content truncated at ${effectiveMaxLength} chars]`
            : markdown;

          if (result.metadata?.title) text += `# ${result.metadata.title}\n\n`;
          text += truncated;

          const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [{ type: 'text', text }];

          // Screenshot from actions (priority) or formats
          const actionScreenshots = result.actions?.screenshots;
          if (actionScreenshots && actionScreenshots.length > 0) {
            for (const screenshot of actionScreenshots) {
              if (screenshot.length > MAX_SCREENSHOT_BASE64_LENGTH) {
                content.push({ type: 'text', text: '⚠️ Screenshot too large (>200KB), omitted to save context.' });
              } else {
                content.push({ type: 'image' as const, data: screenshot, mimeType: 'image/jpeg' });
              }
            }
          } else if (result.screenshot) {
            if (result.screenshot.length > MAX_SCREENSHOT_BASE64_LENGTH) {
              content.push({ type: 'text', text: '⚠️ Screenshot too large (>200KB), omitted to save context.' });
            } else {
              content.push({ type: 'image' as const, data: result.screenshot, mimeType: 'image/jpeg' });
            }
          }

          return { content };
        } catch (error) {
          firecrawlCircuitBreaker.recordFailure();
          const msg = error instanceof Error ? error.message : String(error);
          console.warn('[Firecrawl] Interact failed:', msg);
          return {
            content: [{ type: 'text', text: `Interact failed: ${msg}` }],
            isError: true,
          };
        }
      },
      { annotations }
    );

    // --- extract tool (conditional) ---
    const tools: any[] = [scrapeTool, interactTool];

    if (process.env.FIRECRAWL_EXTRACT_ENABLED === 'true') {
      const extractTool = tool(
        'firecrawl_extract',
        EXTRACT_DESCRIPTION,
        {
          urls: z.array(z.string().url()).min(1).max(10)
            .describe('URLs to extract data from (max 10)'),
          prompt: z.string()
            .describe('Natural language instruction for what data to extract'),
          system_prompt: z.string().optional()
            .describe('Optional system prompt to guide LLM extraction behavior'),
          schema: z.record(z.string(), z.unknown()).optional()
            .describe('Optional JSON Schema defining expected output structure'),
        },
        async (args) => {
          const { urls, prompt, system_prompt, schema } = args;
          console.log('📊 [Firecrawl] Extract called:', { urls: urls.length, prompt: prompt.slice(0, 80) });

          if (firecrawlCircuitBreaker.isOpen()) {
            return {
              content: [{ type: 'text', text: 'Firecrawl service temporarily unavailable (circuit breaker open). Try again in a few minutes.' }],
              isError: true,
            };
          }

          try {
            const result = await client.extract(urls, {
              prompt,
              systemPrompt: system_prompt,
              schema,
            });

            firecrawlCircuitBreaker.recordSuccess();

            let text = `## Extracted Data\n\n`;
            text += '```json\n' + JSON.stringify(result.data, null, 2) + '\n```\n\n';
            text += `Sources: ${urls.join(', ')}`;

            return { content: [{ type: 'text', text }] };
          } catch (error) {
            firecrawlCircuitBreaker.recordFailure();
            const msg = error instanceof Error ? error.message : String(error);
            console.warn('[Firecrawl] Extract failed:', msg);
            return {
              content: [{ type: 'text', text: `Extract failed: ${msg}` }],
              isError: true,
            };
          }
        },
        { annotations }
      );
      tools.push(extractTool);
    }

    const server = createSdkMcpServer({
      name: 'firecrawl',
      version: '2.0.0',
      tools,
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

    return true;
  } catch (error) {
    console.error('❌ [Firecrawl] Failed to integrate SDK MCP server:', error);
    return false;
  }
}

export function getFirecrawlToolNames(): string[] {
  const names = [
    'mcp__firecrawl__firecrawl_scrape',
    'mcp__firecrawl__firecrawl_interact',
  ];
  if (process.env.FIRECRAWL_EXTRACT_ENABLED === 'true') {
    names.push('mcp__firecrawl__firecrawl_extract');
  }
  return names;
}
