// agentstudio/backend/src/services/searxng/types.ts

export interface SearxngConfig {
  base_url: string;
}

export function getSearxngConfigFromEnv(): SearxngConfig | null {
  const url = process.env.SEARXNG_URL;
  return url ? { base_url: url.replace(/\/+$/, '') } : null;
}

export interface SearXNGSearchParams {
  q: string;
  categories?: string;
  engines?: string;
  language?: string;
  time_range?: 'day' | 'week' | 'month' | 'year';
  pageno?: number;
  safesearch?: number;
}

export interface SearXNGResponse {
  query: string;
  number_of_results: number;
  results: SearXNGResult[];
  suggestions: string[];
  answers: string[];
  corrections: string[];
  infoboxes: any[];
  unresponsive_engines: [string, string][];
}

export interface SearXNGResult {
  title: string;
  url: string;
  content: string;
  engine: string;
  engines: string[];
  score: number;
  category: string;
  publishedDate?: string;
  thumbnail?: string;
  img_src?: string;
  img_format?: string;
  img_width?: number;
  img_height?: number;
  iframe_src?: string;
  length?: string;        // video duration e.g. "3:42"
  author?: string;
}

export interface ProcessedResult {
  title: string;
  url: string;
  snippet: string;
  engines: string[];
  score: number;
  category: string;
  publishedDate?: string;
  thumbnail?: string;
  img_src?: string;
}
