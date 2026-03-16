// agentstudio/backend/src/services/searxng/contentExtractor.ts

import { validateUrl } from '../firecrawl/firecrawlClient.js';

// --- Constants ---

const CRAWL4AI_URL = process.env.CRAWL4AI_URL || 'http://192.168.100.30:11235';
const CRAWL4AI_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_LENGTH = 20_000;
const MAX_HTML_SIZE = 512 * 1024; // 512KB
const FETCH_TIMEOUT_MS = 3000;

// --- Extraction Cache (10-min TTL) ---

const EXTRACTION_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  result: { title: string; content: string } | null;
  expireAt: number;
}

const extractionCache = new Map<string, CacheEntry>();

/** Exported for testing only */
export function _resetExtractionCache(): void {
  extractionCache.clear();
}

// --- Crawl4AI Response ---

interface Crawl4AIResponse {
  success: boolean;
  markdown?: string;
  filter?: string;
  url?: string;
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

  // SSRF protection — block internal/private URLs before sending to any extractor
  try {
    validateUrl(url);
  } catch {
    return null;
  }

  let result: { title: string; content: string } | null = null;

  try {
    // Primary: Crawl4AI fit mode (Playwright render + Markdown cleanup, no LLM)
    result = await crawl4aiExtract(url, maxLength);
  } catch (err) {
    console.warn('[ContentExtractor] Crawl4AI error for', url, err instanceof Error ? err.message : err);
  }

  // Fallback: plain fetch + regex extraction
  if (!result) {
    try {
      result = await fetchFallback(url, maxLength);
    } catch {
      result = null;
    }
  }

  // Store in cache
  extractionCache.set(url, {
    result,
    expireAt: Date.now() + EXTRACTION_CACHE_TTL_MS,
  });

  return result;
}

// --- Crawl4AI Extraction ---

async function crawl4aiExtract(
  url: string,
  maxLength: number,
): Promise<{ title: string; content: string } | null> {
  const resp = await fetch(`${CRAWL4AI_URL}/md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, f: 'fit' }),
    signal: AbortSignal.timeout(CRAWL4AI_TIMEOUT_MS),
  });

  if (!resp.ok) {
    console.warn('[ContentExtractor] Crawl4AI returned', resp.status, 'for', url);
    return null;
  }

  const data: Crawl4AIResponse = await resp.json();

  if (!data.success || !data.markdown || data.markdown.length <= 1) {
    return null;
  }

  return {
    title: '',
    content: data.markdown.slice(0, maxLength),
  };
}

// --- Fetch Fallback ---

async function fetchFallback(
  url: string,
  maxLength: number,
): Promise<{ title: string; content: string } | null> {
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

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_HTML_SIZE) return null;

    const html = await response.text();
    if (html.length > MAX_HTML_SIZE) return null;

    return extractFromHtml(html, maxLength);
  } catch {
    return null;
  }
}

// --- HTML Extraction ---

function extractFromHtml(
  html: string,
  maxLength: number,
): { title: string; content: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);
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
