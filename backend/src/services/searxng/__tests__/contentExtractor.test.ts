// agentstudio/backend/src/services/searxng/__tests__/contentExtractor.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAndExtract, _resetExtractionCache } from '../contentExtractor.js';

describe('contentExtractor (dual extraction)', () => {
  beforeEach(() => {
    _resetExtractionCache();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Route-aware mock: Crawl4AI calls go to /md, Readability calls go to the URL
  function setupDualMock(options: {
    crawl4ai?: { markdown: string; success?: boolean } | 'fail' | 'error';
    readability?: { html: string } | 'fail' | 'error';
    fallback?: { html: string } | 'fail';
  }) {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    mockFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();

      // Crawl4AI: POST to /md endpoint
      if (urlStr.includes('/md') && init?.method === 'POST') {
        if (options.crawl4ai === 'fail') throw new Error('Crawl4AI timeout');
        if (options.crawl4ai === 'error') return { ok: false, status: 500 };
        if (options.crawl4ai) {
          return {
            ok: true,
            json: () => Promise.resolve({
              success: options.crawl4ai !== 'fail' && options.crawl4ai !== 'error'
                ? (options.crawl4ai as any).success ?? true
                : false,
              markdown: (options.crawl4ai as any).markdown,
            }),
          };
        }
        throw new Error('Crawl4AI not configured');
      }

      // Readability or fallback: GET to the target URL
      if (options.readability === 'fail' || options.readability === 'error') {
        if (options.readability === 'fail') throw new Error('fetch timeout');
        return { ok: false, status: 500 };
      }

      if (options.readability) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          get: (name: string) => name === 'content-type' ? 'text/html' : null,
          text: () => Promise.resolve(options.readability !== 'fail' && options.readability !== 'error'
            ? (options.readability as any).html
            : ''),
        };
      }

      // Fallback path
      if (options.fallback === 'fail') throw new Error('fallback fail');
      if (options.fallback) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          text: () => Promise.resolve((options.fallback as any).html),
        };
      }

      throw new Error(`Unexpected fetch: ${urlStr}`);
    });
  }

  describe('SSRF protection', () => {
    it('should return null for private IP URLs', async () => {
      const result = await fetchAndExtract('http://192.168.1.1/secret');
      expect(result).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should return null for localhost URLs', async () => {
      const result = await fetchAndExtract('http://localhost:8080/admin');
      expect(result).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('Dual extraction — both succeed', () => {
    it('should merge Crawl4AI and Readability results', async () => {
      setupDualMock({
        crawl4ai: { markdown: 'Crawl4AI extracted content about Docker networking that is long enough to pass the minimum threshold check for valid extraction' },
        readability: {
          html: '<html><head><title>Docker Guide</title></head><body><article><h1>Docker Networking</h1><p>Readability extracted content about Docker containers that is also long enough to pass the minimum threshold</p></article></body></html>',
        },
      });

      const result = await fetchAndExtract('https://example.com/docker', { maxLength: 2000 });

      expect(result).not.toBeNull();
      // Both contents should be present, separated by ---
      expect(result!.content).toContain('Crawl4AI extracted content');
      expect(result!.content).toContain('---');
      expect(result!.content).toContain('Docker');
    });

    it('should split maxLength between both extractions', async () => {
      const longA = 'A'.repeat(3000);
      const longB = '<html><body><article><p>' + 'B'.repeat(3000) + '</p></article></body></html>';

      setupDualMock({
        crawl4ai: { markdown: longA },
        readability: { html: longB },
      });

      const result = await fetchAndExtract('https://example.com/long', { maxLength: 2000 });

      expect(result).not.toBeNull();
      // Total should not exceed maxLength (2000) — each half ~997 + separator 5
      expect(result!.content.length).toBeLessThanOrEqual(2000);
      expect(result!.content).toContain('---');
    });
  });

  describe('Dual extraction — partial success', () => {
    it('should use only Crawl4AI when Readability fails', async () => {
      setupDualMock({
        crawl4ai: { markdown: 'Crawl4AI only content with enough length to pass threshold' },
        readability: 'fail',
      });

      const result = await fetchAndExtract('https://example.com/crawl-only');

      expect(result).not.toBeNull();
      expect(result!.content).toContain('Crawl4AI only content');
      expect(result!.content).not.toContain('---');
    });

    it('should use only Readability when Crawl4AI fails', async () => {
      setupDualMock({
        crawl4ai: 'fail',
        readability: {
          html: '<html><body><article><h1>Title</h1><p>Readability only content with enough length to pass threshold</p></article></body></html>',
        },
      });

      const result = await fetchAndExtract('https://example.com/read-only');

      expect(result).not.toBeNull();
      expect(result!.content).toContain('Readability only content');
      expect(result!.content).not.toContain('---');
    });

    it('should ignore extraction with content shorter than threshold', async () => {
      setupDualMock({
        crawl4ai: { markdown: 'Short' }, // < 50 chars, below MIN_CONTENT_LENGTH
        readability: {
          html: '<html><body><article><p>Readability has enough content to pass the minimum threshold check</p></article></body></html>',
        },
      });

      const result = await fetchAndExtract('https://example.com/short-crawl');

      expect(result).not.toBeNull();
      // Should not contain separator since Crawl4AI was too short
      expect(result!.content).not.toContain('---');
      expect(result!.content).toContain('Readability has enough content');
    });
  });

  describe('Fallback path (Level 3)', () => {
    it('should use regex fallback when both extractors fail', async () => {
      const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
      let callCount = 0;

      mockFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
        callCount++;
        const urlStr = typeof url === 'string' ? url : url.toString();

        // First two calls: Crawl4AI + Readability both fail
        if (urlStr.includes('/md')) throw new Error('Crawl4AI down');
        if (callCount <= 2) throw new Error('Readability down');

        // Third call: regex fallback succeeds
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('<html><title>Fallback</title><body><p>Regex fallback content here</p></body></html>'),
        };
      });

      const result = await fetchAndExtract('https://example.com/both-fail');

      expect(result).not.toBeNull();
      expect(result!.title).toBe('Fallback');
      expect(result!.content).toContain('Regex fallback content');
    });

    it('should return null when everything fails', async () => {
      const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockRejectedValue(new Error('all fail'));

      const result = await fetchAndExtract('https://example.com/total-fail');
      expect(result).toBeNull();
    });
  });

  describe('Extraction cache', () => {
    it('should cache merged result and return on second call', async () => {
      setupDualMock({
        crawl4ai: { markdown: 'Cached Crawl4AI content that is long enough to pass threshold' },
        readability: {
          html: '<html><body><article><p>Cached Readability content that is long enough to pass threshold</p></article></body></html>',
        },
      });

      const result1 = await fetchAndExtract('https://example.com/cached');
      const result2 = await fetchAndExtract('https://example.com/cached');

      expect(result1).toEqual(result2);
      // fetch called only for first extraction (Crawl4AI + Readability), not for second
      expect(globalThis.fetch).toHaveBeenCalledTimes(2); // 1 Crawl4AI + 1 Readability
    });

    it('should clear cache with _resetExtractionCache', async () => {
      setupDualMock({
        crawl4ai: { markdown: 'First extraction content that is long enough to pass threshold easily' },
        readability: 'fail',
      });

      await fetchAndExtract('https://example.com/reset');
      _resetExtractionCache();

      setupDualMock({
        crawl4ai: { markdown: 'Second extraction content that is different and long enough for threshold' },
        readability: 'fail',
      });

      const result = await fetchAndExtract('https://example.com/reset');
      expect(result!.content).toContain('Second extraction');
    });
  });
});
