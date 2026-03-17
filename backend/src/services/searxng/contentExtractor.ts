// agentstudio/backend/src/services/searxng/contentExtractor.ts

import { validateUrl } from '../firecrawl/firecrawlClient.js';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

// --- Constants ---

const CRAWL4AI_URL = process.env.CRAWL4AI_URL || 'http://192.168.100.30:11235';
const CRAWL4AI_TIMEOUT_MS = 15_000;
const READABILITY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LENGTH = 20_000;
const MAX_HTML_SIZE = 512 * 1024; // 512KB
const FETCH_TIMEOUT_MS = 3000;
const MIN_CONTENT_LENGTH = 50; // Minimum chars to consider extraction valid

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

// --- Turndown instance (reuse, stateless) ---

const turndown = new TurndownService({ headingStyle: 'atx' });

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

  // Dual extraction: Crawl4AI + Readability in parallel
  const [crawl4aiResult, readabilityResult] = await Promise.allSettled([
    crawl4aiExtract(url, maxLength),
    readabilityExtract(url, maxLength),
  ]);

  const a = crawl4aiResult.status === 'fulfilled' ? crawl4aiResult.value : null;
  const b = readabilityResult.status === 'fulfilled' ? readabilityResult.value : null;

  // Merge dual extraction results
  let result = mergeExtractions(a, b, maxLength);

  // Level 3 fallback: regex extraction if both extractors failed
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

// --- Merge Strategy ---

function mergeExtractions(
  a: { title: string; content: string } | null,  // Crawl4AI
  b: { title: string; content: string } | null,  // Readability
  maxLength: number,
): { title: string; content: string } | null {
  const hasA = a && a.content.length > MIN_CONTENT_LENGTH;
  const hasB = b && b.content.length > MIN_CONTENT_LENGTH;

  if (hasA && hasB) {
    const separator = '\n---\n';
    const halfLen = Math.floor((maxLength - separator.length) / 2);
    return {
      title: a.title || b.title,
      content: a.content.slice(0, halfLen) + separator + b.content.slice(0, halfLen),
    };
  }
  if (hasA) return { ...a, content: a.content.slice(0, maxLength) };
  if (hasB) return { ...b, content: b.content.slice(0, maxLength) };
  return null;
}

// --- Crawl4AI Extraction (existing, unchanged) ---

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

// --- Readability Extraction (new, replicates mcp-server-fetch core logic) ---

async function readabilityExtract(
  url: string,
  maxLength: number,
): Promise<{ title: string; content: string } | null> {
  try {
    // 1. HTTP fetch
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(READABILITY_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AgentStudio/1.0)',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });

    if (!resp.ok) return null;

    // 2. HTML detection
    const contentType = resp.headers.get('content-type') || '';
    const contentLength = resp.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_HTML_SIZE) return null;

    const html = await resp.text();
    if (html.length > MAX_HTML_SIZE) return null;

    const isHtml = contentType.includes('text/html') || html.slice(0, 100).includes('<html');
    if (!isHtml) return null;

    // 3. DOM parse + Readability extraction
    const { document } = parseHTML(html);

    // linkedom doesn't auto-set baseURI — inject <base> for relative URL resolution
    const base = document.createElement('base');
    base.setAttribute('href', url);
    if (document.head) {
      document.head.appendChild(base);
    }

    const article = new Readability(document as any).parse();
    if (!article?.content) return null;

    // 4. Turndown HTML → Markdown
    const markdown = turndown.turndown(article.content);

    return {
      title: article.title || '',
      content: markdown.slice(0, maxLength),
    };
  } catch (err) {
    console.warn('[ContentExtractor] Readability error for', url, err instanceof Error ? err.message : err);
    return null;
  }
}

// --- Fetch Fallback (Level 3, regex extraction — safety net) ---

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

// --- HTML Extraction (regex-based, unchanged) ---

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
