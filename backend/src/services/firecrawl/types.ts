// agentstudio/backend/src/services/firecrawl/types.ts

export interface FirecrawlConfig {
  base_url: string;
  api_key: string;
}

export function getFirecrawlConfigFromEnv(): FirecrawlConfig | null {
  const url = process.env.FIRECRAWL_URL;
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!url) return null;
  if (!apiKey) {
    console.warn('⚠️ [Firecrawl] FIRECRAWL_API_KEY not set, using placeholder (self-hosted mode)');
  }
  return { base_url: url.replace(/\/+$/, ''), api_key: apiKey || 'placeholder' };
}

export interface ScrapeResult {
  markdown: string;
  html?: string;
  links?: string[];
  metadata: {
    title?: string;
    description?: string;
    language?: string;
    url: string;
    sourceURL: string;
    statusCode: number;
    error?: string | null;
  };
}

export interface ScrapeResponse {
  success: boolean;
  data: ScrapeResult;
}

export interface MapResponse {
  success: boolean;
  links: string[];
}
