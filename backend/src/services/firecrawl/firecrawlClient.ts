import type { ScrapeResult, ScrapeResponse, ExtractResponse } from './types.js';

// --- SSRF Protection ---

const BLOCKED_HOSTS = new Set([
  'localhost',
  'searxng', 'firecrawl-api', 'firecrawl-playwright',
  'firecrawl-redis', 'firecrawl-rabbitmq', 'firecrawl-nuq-postgres',
  'redis', 'postgres', 'neo4j', 'elasticsearch', 'qdrant',
  'weknora-app', 'weknora-frontend', 'weknora-docreader',
  'docreader', 'browserless',
]);

const BLOCKED_IP_PATTERNS = [
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  /^::ffff:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/i,
];

export function validateUrl(url: string): void {
  const parsed = new URL(url);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`SSRF: blocked protocol "${parsed.protocol}"`);
  }

  // Extract raw hostname from the original URL before URL constructor normalizes it.
  // URL constructor resolves numeric IPs (e.g., 2130706433 -> 127.0.0.1), so we
  // need the raw input to detect obfuscated numeric IP encodings.
  const rawHostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const rawHostMatch = url.match(/^https?:\/\/([^/:]+)/i);
  const originalHost = rawHostMatch ? rawHostMatch[1].toLowerCase().replace(/^\[|\]$/g, '') : rawHostname;

  // Check numeric IP encoding against the original URL input (before URL normalization)
  if (/^\d+$/.test(originalHost) || /^0x[0-9a-f]+$/i.test(originalHost) || /^0\d+/.test(originalHost)) {
    throw new Error(`SSRF: blocked numeric IP "${originalHost}"`);
  }

  if (BLOCKED_HOSTS.has(rawHostname)) {
    throw new Error(`SSRF: blocked hostname "${rawHostname}"`);
  }

  if (BLOCKED_IP_PATTERNS.some(p => p.test(rawHostname))) {
    throw new Error(`SSRF: blocked IP address "${rawHostname}"`);
  }
}

// --- Client ---

export class FirecrawlClient {
  private concurrentScrapes = 0;
  private readonly maxConcurrentScrapes = 3;

  constructor(
    private baseUrl: string,
    private apiKey: string = 'placeholder'
  ) {}

  private async withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.concurrentScrapes >= this.maxConcurrentScrapes) {
      throw new Error('Firecrawl concurrent scrape limit reached, try again later');
    }
    this.concurrentScrapes++;
    try {
      return await fn();
    } finally {
      this.concurrentScrapes--;
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        if (attempt === MAX_RETRIES) throw error;
        const status = error?.status || 0;
        if (status !== 429 && status !== 503) throw error;

        const retryAfter = error?.retryAfter;
        const delay = (retryAfter && !isNaN(retryAfter))
          ? Math.min(retryAfter * 1000, 10000)
          : Math.pow(2, attempt + 1) * 1000; // 2s, 4s
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error('Unreachable');
  }

  async scrape(url: string, options?: {
    onlyMainContent?: boolean;
    timeout?: number;
    formats?: string[];
    waitFor?: number;
    includeTags?: string[];
    excludeTags?: string[];
    actions?: Array<{
      type: string;
      selector?: string;
      text?: string;
      key?: string;
      milliseconds?: number;
      direction?: string;
      fullPage?: boolean;
      quality?: number;
      all?: boolean;
      script?: string;
    }>;
  }): Promise<ScrapeResult> {
    validateUrl(url);

    return this.withConcurrencyLimit(() => this.withRetry(async () => {
      const body: any = {
        url,
        formats: options?.formats ?? ['markdown'],
        onlyMainContent: options?.onlyMainContent ?? true,
        timeout: options?.timeout ?? 30000,
      };
      if (options?.waitFor !== undefined) body.waitFor = options.waitFor;
      if (options?.includeTags) body.includeTags = options.includeTags;
      if (options?.excludeTags) body.excludeTags = options.excludeTags;
      if (options?.actions) body.actions = options.actions;

      const resp = await fetch(`${this.baseUrl}/v1/scrape`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options?.actions ? 90000 : 60000),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        let errorMsg = `Firecrawl scrape failed (${resp.status})`;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed.error) errorMsg = parsed.error;
        } catch { /* not JSON, use default */ }
        const err: any = new Error(errorMsg);
        err.status = resp.status;
        const retryAfterHeader = resp.headers.get('Retry-After');
        if (retryAfterHeader) err.retryAfter = parseInt(retryAfterHeader, 10);
        throw err;
      }

      const data: ScrapeResponse = await resp.json();
      if (!data.success) throw new Error('Firecrawl scrape returned success=false');
      return data.data;
    }));
  }

  async extract(urls: string[], options: {
    prompt: string;
    systemPrompt?: string;
    schema?: Record<string, unknown>;
  }): Promise<ExtractResponse> {
    for (const url of urls) {
      validateUrl(url);
    }

    return this.withConcurrencyLimit(() => this.withRetry(async () => {
      const body: any = {
        urls,
        prompt: options.prompt,
      };
      if (options.systemPrompt) body.systemPrompt = options.systemPrompt;
      if (options.schema) body.schema = options.schema;

      const resp = await fetch(`${this.baseUrl}/v1/extract`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        let errorMsg = `Firecrawl extract failed (${resp.status})`;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed.error) errorMsg = parsed.error;
        } catch { /* not JSON, use default */ }
        const err: any = new Error(errorMsg);
        err.status = resp.status;
        const retryAfterHeader = resp.headers.get('Retry-After');
        if (retryAfterHeader) err.retryAfter = parseInt(retryAfterHeader, 10);
        throw err;
      }

      const data: ExtractResponse = await resp.json();
      if (!data.success) throw new Error('Firecrawl extract returned success=false');
      return data;
    }));
  }
}
