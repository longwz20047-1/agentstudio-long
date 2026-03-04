// agentstudio/backend/src/services/searxng/searxngClient.ts

import type { SearXNGSearchParams, SearXNGResponse } from './types.js';

export class SearXNGClient {
  constructor(private baseUrl: string) {}

  async search(params: SearXNGSearchParams): Promise<SearXNGResponse> {
    const url = new URL('/search', this.baseUrl);
    const fullParams: Record<string, string | number> = { ...params, format: 'json' };
    for (const [k, v] of Object.entries(fullParams)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const resp = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      throw new Error(`SearXNG ${resp.status}: ${resp.statusText}`);
    }

    return resp.json() as Promise<SearXNGResponse>;
  }
}
