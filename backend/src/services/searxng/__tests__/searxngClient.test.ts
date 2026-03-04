// agentstudio/backend/src/services/searxng/__tests__/searxngClient.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearXNGClient } from '../searxngClient.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SearXNGClient', () => {
  let client: SearXNGClient;

  beforeEach(() => {
    client = new SearXNGClient('http://searxng.test:8888');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should send GET request with correct query params', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        query: 'test',
        number_of_results: 0,
        results: [],
        suggestions: [],
        answers: [],
        corrections: [],
        infoboxes: [],
        unresponsive_engines: [],
      }),
    });

    await client.search({ q: 'test', language: 'zh-CN' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('/search');
    expect(calledUrl).toContain('q=test');
    expect(calledUrl).toContain('language=zh-CN');
    expect(calledUrl).toContain('format=json');
  });

  it('should not include undefined params in URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        query: 'test', number_of_results: 0, results: [],
        suggestions: [], answers: [], corrections: [],
        infoboxes: [], unresponsive_engines: [],
      }),
    });

    await client.search({ q: 'test' });

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).not.toContain('categories=');
    expect(calledUrl).not.toContain('engines=');
  });

  it('should throw on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    await expect(client.search({ q: 'test' })).rejects.toThrow('SearXNG 503');
  });
});
