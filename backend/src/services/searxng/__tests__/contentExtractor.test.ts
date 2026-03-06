// agentstudio/backend/src/services/searxng/__tests__/contentExtractor.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so mockScrape is available when vi.mock factories run (they are hoisted)
const { mockScrape } = vi.hoisted(() => ({
  mockScrape: vi.fn(),
}));

vi.mock('../../firecrawl/types.js', () => ({
  getFirecrawlConfigFromEnv: vi.fn(() => ({
    base_url: 'http://firecrawl:3002',
    api_key: 'test-key',
  })),
}));

vi.mock('../../firecrawl/firecrawlClient.js', () => ({
  FirecrawlClient: vi.fn().mockImplementation(() => ({
    scrape: mockScrape,
  })),
  validateUrl: vi.fn((url: string) => {
    if (url.includes('192.168.') || url.includes('localhost')) {
      throw new Error(`SSRF: blocked`);
    }
  }),
}));

// Now import the module under test
import { fetchAndExtract, _resetCircuitBreaker } from '../contentExtractor.js';
import { getFirecrawlConfigFromEnv } from '../../firecrawl/types.js';

describe('contentExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCircuitBreaker();
    // Reset global fetch mock
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Firecrawl path', () => {
    it('should return content from Firecrawl when available', async () => {
      mockScrape.mockResolvedValue({
        markdown: '# Hello World\n\nThis is content.',
        metadata: { title: 'Hello World' },
      });

      const result = await fetchAndExtract('https://example.com');
      expect(result).toEqual({
        title: 'Hello World',
        content: '# Hello World\n\nThis is content.',
      });
      expect(mockScrape).toHaveBeenCalledWith('https://example.com', {
        onlyMainContent: true,
        formats: ['markdown'],
        timeout: 5000,
      });
    });

    it('should truncate content to maxLength', async () => {
      const longContent = 'A'.repeat(2000);
      mockScrape.mockResolvedValue({
        markdown: longContent,
        metadata: { title: 'Long' },
      });

      const result = await fetchAndExtract('https://example.com', { maxLength: 100 });
      expect(result).not.toBeNull();
      expect(result!.content.length).toBe(100);
    });

    it('should fallback to fetch when Firecrawl fails', async () => {
      mockScrape.mockRejectedValue(new Error('Firecrawl error'));

      const htmlBody = '<html><head><title>Fallback Title</title></head><body><p>Fallback content</p></body></html>';
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Headers({
          'content-type': 'text/html; charset=utf-8',
        }),
        text: () => Promise.resolve(htmlBody),
      });

      const result = await fetchAndExtract('https://example.com');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Fallback Title');
      expect(result!.content).toContain('Fallback content');
    });
  });

  describe('Circuit breaker', () => {
    it('should skip Firecrawl after 3 consecutive failures', async () => {
      mockScrape.mockRejectedValue(new Error('fail'));

      const htmlBody = '<html><head><title>FB</title></head><body><p>content</p></body></html>';
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(htmlBody),
      });

      // 3 failures to open circuit
      await fetchAndExtract('https://example.com/1');
      await fetchAndExtract('https://example.com/2');
      await fetchAndExtract('https://example.com/3');

      expect(mockScrape).toHaveBeenCalledTimes(3);

      // 4th call should skip Firecrawl entirely
      mockScrape.mockClear();
      await fetchAndExtract('https://example.com/4');
      expect(mockScrape).not.toHaveBeenCalled();
    });

    it('should reset circuit breaker with _resetCircuitBreaker', async () => {
      mockScrape.mockRejectedValue(new Error('fail'));

      const htmlBody = '<html><head><title>T</title></head><body><p>c</p></body></html>';
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(htmlBody),
      });

      // Open circuit
      await fetchAndExtract('https://example.com/1');
      await fetchAndExtract('https://example.com/2');
      await fetchAndExtract('https://example.com/3');

      _resetCircuitBreaker();

      // Should try Firecrawl again
      mockScrape.mockClear();
      mockScrape.mockResolvedValue({
        markdown: 'recovered',
        metadata: { title: 'Recovered' },
      });

      const result = await fetchAndExtract('https://example.com/5');
      expect(mockScrape).toHaveBeenCalledTimes(1);
      expect(result!.content).toBe('recovered');
    });
  });

  describe('Fallback fetch', () => {
    beforeEach(() => {
      // Disable Firecrawl for fallback tests
      (getFirecrawlConfigFromEnv as ReturnType<typeof vi.fn>).mockReturnValue(null);
      // Re-import won't help since module is cached, so open circuit breaker instead
      // Actually, let's just make Firecrawl fail
      (getFirecrawlConfigFromEnv as ReturnType<typeof vi.fn>).mockReturnValue({
        base_url: 'http://firecrawl:3002',
        api_key: 'test-key',
      });
      // Open circuit to skip Firecrawl
      _resetCircuitBreaker();
    });

    // Helper to force fallback path by opening circuit breaker
    async function openCircuit() {
      mockScrape.mockRejectedValue(new Error('fail'));
      const htmlBody = '<html><head><title>T</title></head><body><p>c</p></body></html>';
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(htmlBody),
      });
      await fetchAndExtract('https://example.com/1');
      await fetchAndExtract('https://example.com/2');
      await fetchAndExtract('https://example.com/3');
      vi.mocked(globalThis.fetch).mockReset();
    }

    it('should return null for non-HTML content-type', async () => {
      await openCircuit();

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        text: () => Promise.resolve('binary'),
      });

      const result = await fetchAndExtract('https://example.com/file.pdf');
      expect(result).toBeNull();
    });

    it('should return null when SSRF validation fails', async () => {
      await openCircuit();

      const result = await fetchAndExtract('http://192.168.1.1/secret');
      expect(result).toBeNull();
    });

    it('should return null on fetch timeout', async () => {
      await openCircuit();

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new DOMException('The operation was aborted', 'AbortError')
      );

      const result = await fetchAndExtract('https://example.com/slow');
      expect(result).toBeNull();
    });

    it('should strip script, style, nav, footer, header tags', async () => {
      await openCircuit();

      const html = `<html><head><title>Clean</title></head><body>
        <script>alert('xss')</script>
        <style>.hide{display:none}</style>
        <nav>Navigation</nav>
        <header>Header stuff</header>
        <main><p>Real content here</p></main>
        <footer>Footer stuff</footer>
      </body></html>`;

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(html),
      });

      const result = await fetchAndExtract('https://example.com/page');
      expect(result).not.toBeNull();
      expect(result!.content).toContain('Real content here');
      expect(result!.content).not.toContain('alert');
      expect(result!.content).not.toContain('xss');
      expect(result!.content).not.toContain('Navigation');
      expect(result!.content).not.toContain('Header stuff');
      expect(result!.content).not.toContain('Footer stuff');
      expect(result!.content).not.toContain('display:none');
    });

    it('should return null for oversized response (Content-Length > 512KB)', async () => {
      await openCircuit();

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Headers({
          'content-type': 'text/html',
          'content-length': String(600 * 1024),
        }),
        text: () => Promise.resolve('<html><body>big</body></html>'),
      });

      const result = await fetchAndExtract('https://example.com/huge');
      expect(result).toBeNull();
    });

    it('should return null for oversized HTML body (> 512KB)', async () => {
      await openCircuit();

      const bigHtml = '<html><body>' + 'x'.repeat(600 * 1024) + '</body></html>';
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(bigHtml),
      });

      const result = await fetchAndExtract('https://example.com/huge2');
      expect(result).toBeNull();
    });
  });

  describe('Firecrawl timeout', () => {
    it('should fallback when Firecrawl exceeds 5s timeout', async () => {
      // Simulate Firecrawl hanging
      mockScrape.mockImplementation(() => new Promise((resolve) => {
        setTimeout(() => resolve({ markdown: 'late', metadata: { title: 'Late' } }), 10000);
      }));

      const htmlBody = '<html><head><title>Fast</title></head><body><p>Fast content</p></body></html>';
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(htmlBody),
      });

      // Use fake timers for the Promise.race timeout
      vi.useFakeTimers();
      const promise = fetchAndExtract('https://example.com');
      // Advance past the 5s timeout
      await vi.advanceTimersByTimeAsync(5100);
      const result = await promise;
      vi.useRealTimers();

      expect(result).not.toBeNull();
      expect(result!.title).toBe('Fast');
    });
  });
});
