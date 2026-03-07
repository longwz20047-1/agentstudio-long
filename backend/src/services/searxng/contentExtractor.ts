// agentstudio/backend/src/services/searxng/contentExtractor.ts

import { FirecrawlClient, validateUrl } from '../firecrawl/firecrawlClient.js';
import { getFirecrawlConfigFromEnv } from '../firecrawl/types.js';
import { firecrawlCircuitBreaker } from '../firecrawl/circuitBreaker.js';

// --- Module-level Firecrawl setup ---

const firecrawlConfig = getFirecrawlConfigFromEnv();
const firecrawlClient = firecrawlConfig
  ? new FirecrawlClient(firecrawlConfig.base_url, firecrawlConfig.api_key)
  : null;

// --- Circuit Breaker (shared) ---

/** Exported for testing only */
export function _resetCircuitBreaker(): void {
  firecrawlCircuitBreaker.reset();
}

// --- Constants ---

const DEFAULT_MAX_LENGTH = 20000;
const MAX_HTML_SIZE = 512 * 1024; // 512KB
const FIRECRAWL_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 3000;

// --- Extraction Cache (10-min TTL) ---

const EXTRACTION_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CacheEntry {
  result: { title: string; content: string } | null;
  expireAt: number;
}

const extractionCache = new Map<string, CacheEntry>();

/** Exported for testing only */
export function _resetExtractionCache(): void {
  extractionCache.clear();
}

// --- Main Function ---

export async function fetchAndExtract(
  url: string,
  options?: { maxLength?: number }
): Promise<{ title: string; content: string } | null> {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;

  // Check cache
  const cached = extractionCache.get(url);
  if (cached && Date.now() < cached.expireAt) {
    return cached.result;
  }

  let result: { title: string; content: string } | null = null;

  try {
    // Try Firecrawl first
    if (firecrawlClient && !firecrawlCircuitBreaker.isOpen()) {
      try {
        const scrapeResult = await Promise.race([
          firecrawlClient.scrape(url, {
            onlyMainContent: true,
            formats: ['markdown'],
            timeout: 5000,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Firecrawl client timeout (5s)')), FIRECRAWL_TIMEOUT_MS)
          ),
        ]);

        firecrawlCircuitBreaker.recordSuccess();
        result = {
          title: scrapeResult.metadata?.title || '',
          content: scrapeResult.markdown.slice(0, maxLength),
        };
      } catch {
        firecrawlCircuitBreaker.recordFailure();
        // Fall through to fetch fallback
      }
    }

    // Fallback: plain fetch (only if Firecrawl didn't succeed)
    if (!result) {
      result = await fetchFallback(url, maxLength);
    }
  } catch {
    result = null;
  }

  // Store in cache
  extractionCache.set(url, {
    result,
    expireAt: Date.now() + EXTRACTION_CACHE_TTL_MS,
  });

  return result;
}

// --- Fetch Fallback ---

async function fetchFallback(
  url: string,
  maxLength: number
): Promise<{ title: string; content: string } | null> {
  try {
    validateUrl(url);
  } catch {
    return null;
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AgentStudio/1.0)',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });

    if (!response.ok) return null;

    // Content-Type check
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    // Content-Length check
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_HTML_SIZE) return null;

    const html = await response.text();

    // Body size check
    if (html.length > MAX_HTML_SIZE) return null;

    return extractFromHtml(html, maxLength);
  } catch {
    return null;
  }
}

// --- HTML Extraction ---

function extractFromHtml(
  html: string,
  maxLength: number
): { title: string; content: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  // Remove unwanted tags (with content)
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Collapse whitespace and blank lines
  text = text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n');

  return {
    title,
    content: text.slice(0, maxLength),
  };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}
