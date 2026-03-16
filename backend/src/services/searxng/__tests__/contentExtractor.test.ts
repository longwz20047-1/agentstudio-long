// agentstudio/backend/src/services/searxng/__tests__/contentExtractor.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAndExtract, _resetExtractionCache } from '../contentExtractor.js';

describe('contentExtractor (Crawl4AI)', () => {
  beforeEach(() => {
    _resetExtractionCache();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Helper: mock Crawl4AI /md response
  function mockCrawl4AI(markdown: string, success = true) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success, markdown }),
    });
  }

  // Helper: mock Crawl4AI failure then HTML fallback
  function mockCrawl4AIFailThenHtml(html: string) {
    // First call: Crawl4AI fails
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Crawl4AI timeout')
    );
    // Second call: fallback fetch succeeds
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: () => Promise.resolve(html),
    });
  }

  describe('SSRF protection', () => {
    it('should return null for private IP URLs', async () => {
      const result = await fetchAndExtract('http://192.168.1.1/secret');
      expect(result).toBeNull();
      // fetch should not be called — blocked before any extraction
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should return null for localhost URLs', async () => {
      const result = await fetchAndExtract('http://localhost:8080/admin');
      expect(result).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('Crawl4AI primary path', () => {
    it('should return LLM-extracted content from Crawl4AI', async () => {
      mockCrawl4AI('# News\n\n1. Breaking news about AI');

      const result = await fetchAndExtract('https://example.com');

      expect(result).toEqual({
        title: '',
        content: '# News\n\n1. Breaking news about AI',
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/md'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"f":"llm"'),
        })
      );
    });

    it('should truncate content to maxLength', async () => {
      mockCrawl4AI('A'.repeat(5000));

      const result = await fetchAndExtract('https://example.com', { maxLength: 200 });

      expect(result).not.toBeNull();
      expect(result!.content.length).toBe(200);
    });

    it('should pass custom query to Crawl4AI', async () => {
      mockCrawl4AI('Custom extraction result');

      await fetchAndExtract('https://example.com', {
        query: 'Extract product prices',
      });

      const callBody = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
      );
      expect(callBody.q).toBe('Extract product prices');
    });

    it('should fallback when Crawl4AI returns empty markdown', async () => {
      // Crawl4AI returns success but empty content (length <= 1)
      mockCrawl4AI(' ', true);

      // Fallback HTML
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<html><title>Fallback</title><body><p>Content</p></body></html>'),
      });

      const result = await fetchAndExtract('https://example.com');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Fallback');
    });

    it('should fallback when Crawl4AI returns HTTP error', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
      });
      // Fallback HTML
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<html><title>Fallback</title><body>content</body></html>'),
      });

      const result = await fetchAndExtract('https://example.com');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Fallback');
    });
  });

  describe('Fallback path', () => {
    it('should use fetch fallback when Crawl4AI fails', async () => {
      const html = '<html><head><title>Fallback Title</title></head><body><p>Fallback content</p></body></html>';
      mockCrawl4AIFailThenHtml(html);

      const result = await fetchAndExtract('https://example.com');

      expect(result).not.toBeNull();
      expect(result!.title).toBe('Fallback Title');
      expect(result!.content).toContain('Fallback content');
    });

    it('should return null for non-HTML content-type in fallback', async () => {
      // Crawl4AI fails
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
      // Fallback: non-HTML
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        text: () => Promise.resolve('binary'),
      });

      const result = await fetchAndExtract('https://example.com/file.pdf');
      expect(result).toBeNull();
    });

    it('should return null for oversized HTML in fallback', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'content-type': 'text/html',
          'content-length': String(600 * 1024),
        }),
        text: () => Promise.resolve('<html>big</html>'),
      });

      const result = await fetchAndExtract('https://example.com/huge');
      expect(result).toBeNull();
    });

    it('should strip script/style/nav/footer/header in fallback HTML', async () => {
      const html = `<html><head><title>Clean</title></head><body>
        <script>alert('xss')</script>
        <style>.hide{display:none}</style>
        <nav>Navigation</nav>
        <header>Header</header>
        <main><p>Real content here</p></main>
        <footer>Footer</footer>
      </body></html>`;

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(html),
      });

      const result = await fetchAndExtract('https://example.com/page');
      expect(result).not.toBeNull();
      expect(result!.content).toContain('Real content here');
      expect(result!.content).not.toContain('alert');
      expect(result!.content).not.toContain('Navigation');
      expect(result!.content).not.toContain('Footer');
    });
  });

  describe('Extraction cache', () => {
    it('should return cached result for same URL and query', async () => {
      mockCrawl4AI('cached content');

      const result1 = await fetchAndExtract('https://example.com/cached');
      const result2 = await fetchAndExtract('https://example.com/cached');

      // Only 1 fetch call (second is cached)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(result1).toEqual(result2);
    });

    it('should not use cache when query differs for same URL', async () => {
      mockCrawl4AI('content for query A');
      mockCrawl4AI('content for query B');

      const result1 = await fetchAndExtract('https://example.com/page', { query: 'query A' });
      const result2 = await fetchAndExtract('https://example.com/page', { query: 'query B' });

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(result1!.content).toBe('content for query A');
      expect(result2!.content).toBe('content for query B');
    });

    it('should not use cache for different URLs', async () => {
      mockCrawl4AI('content A');
      mockCrawl4AI('content B');

      await fetchAndExtract('https://example.com/a');
      await fetchAndExtract('https://example.com/b');

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should cache null results', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));

      const result1 = await fetchAndExtract('https://example.com/fail');
      const result2 = await fetchAndExtract('https://example.com/fail');

      expect(result1).toBeNull();
      expect(result2).toBeNull();
      // Only 2 calls for first attempt (crawl4ai + fallback), 0 for second (cached)
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should clear cache with _resetExtractionCache', async () => {
      mockCrawl4AI('first');
      await fetchAndExtract('https://example.com/reset');

      _resetExtractionCache();

      mockCrawl4AI('second');
      const result = await fetchAndExtract('https://example.com/reset');

      expect(result!.content).toBe('second');
    });
  });
});
