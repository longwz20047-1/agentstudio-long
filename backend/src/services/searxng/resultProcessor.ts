// agentstudio/backend/src/services/searxng/resultProcessor.ts

import type { SearXNGResult, ProcessedResult } from './types.js';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'gclsrc', 'msclkid', 'ref', 'source', 'spm',
]);

function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param);
    }
    let normalized = url.toString();
    if (normalized.endsWith('/') && url.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return rawUrl;
  }
}

export function dedupeAndRank(results: SearXNGResult[], maxResults: number): ProcessedResult[] {
  const map = new Map<string, ProcessedResult & { enginesSet: Set<string> }>();

  for (const r of results) {
    const key = normalizeUrl(r.url);
    const existing = map.get(key);
    if (existing) {
      existing.score += r.score;
      for (const e of r.engines) existing.enginesSet.add(e);
    } else {
      map.set(key, {
        title: r.title,
        url: r.url,
        snippet: '',
        engines: [],
        enginesSet: new Set(r.engines),
        score: r.score,
        category: r.category,
        publishedDate: r.publishedDate,
      });
      const entry = map.get(key)!;
      entry.snippet = r.content;
    }
  }

  const processed: ProcessedResult[] = [];
  for (const entry of map.values()) {
    const snippet = entry.snippet || '';
    processed.push({
      title: entry.title,
      url: entry.url,
      snippet: snippet.length > 300 ? snippet.slice(0, 300) + '...' : snippet,
      engines: Array.from(entry.enginesSet),
      score: entry.score,
      category: entry.category,
      publishedDate: entry.publishedDate,
    });
  }

  processed.sort((a, b) => b.score - a.score);
  return processed.slice(0, maxResults);
}
