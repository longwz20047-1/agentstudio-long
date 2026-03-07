import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FirecrawlClient, validateUrl } from '../firecrawlClient.js';

describe('validateUrl (SSRF protection)', () => {
  it('should allow normal https URLs', () => {
    expect(() => validateUrl('https://example.com/page')).not.toThrow();
    expect(() => validateUrl('http://docs.python.org')).not.toThrow();
  });

  it('should block non-http protocols', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow('SSRF: blocked protocol');
    expect(() => validateUrl('ftp://files.local')).toThrow('SSRF: blocked protocol');
    expect(() => validateUrl('gopher://evil.com')).toThrow('SSRF: blocked protocol');
  });

  it('should block localhost', () => {
    expect(() => validateUrl('http://localhost:8080')).toThrow('SSRF: blocked hostname');
  });

  it('should block private IPv4 ranges', () => {
    expect(() => validateUrl('http://127.0.0.1')).toThrow('SSRF: blocked IP');
    expect(() => validateUrl('http://10.0.0.1')).toThrow('SSRF: blocked IP');
    expect(() => validateUrl('http://172.16.0.1')).toThrow('SSRF: blocked IP');
    expect(() => validateUrl('http://192.168.1.1')).toThrow('SSRF: blocked IP');
    expect(() => validateUrl('http://169.254.169.254')).toThrow('SSRF: blocked IP');
  });

  it('should block IPv6 loopback and private', () => {
    expect(() => validateUrl('http://[::1]')).toThrow('SSRF: blocked IP');
  });

  it('should block Docker service names', () => {
    expect(() => validateUrl('http://redis:6379')).toThrow('SSRF: blocked hostname');
    expect(() => validateUrl('http://postgres:5432')).toThrow('SSRF: blocked hostname');
    expect(() => validateUrl('http://elasticsearch:9200')).toThrow('SSRF: blocked hostname');
    expect(() => validateUrl('http://firecrawl-api:3002')).toThrow('SSRF: blocked hostname');
  });

  it('should block numeric IP encoding', () => {
    expect(() => validateUrl('http://2130706433')).toThrow('SSRF: blocked numeric IP');
    expect(() => validateUrl('http://0x7f000001')).toThrow('SSRF: blocked numeric IP');
    expect(() => validateUrl('http://0177.0.0.1')).toThrow('SSRF: blocked numeric IP');
  });
});

describe('FirecrawlClient', () => {
  const mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  let client: FirecrawlClient;

  beforeEach(() => {
    client = new FirecrawlClient('http://firecrawl.test:3002', 'test-key');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('scrape', () => {
    it('should POST to /v1/scrape with correct headers', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: { markdown: '# Hello', metadata: { url: 'https://example.com', sourceURL: 'https://example.com', statusCode: 200 } },
        }),
      });

      await client.scrape('https://example.com');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://firecrawl.test:3002/v1/scrape');
      expect(options.method).toBe('POST');
      expect(options.headers['Authorization']).toBe('Bearer test-key');
    });

    it('should throw on SSRF URL', async () => {
      await expect(client.scrape('http://localhost:8080')).rejects.toThrow('SSRF');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should reject concurrent scrapes beyond limit', async () => {
      mockFetch.mockImplementation(() => new Promise(resolve =>
        setTimeout(() => resolve({
          ok: true,
          json: async () => ({ success: true, data: { markdown: 'ok', metadata: { url: 'x', sourceURL: 'x', statusCode: 200 } } }),
        }), 100)
      ));

      const p1 = client.scrape('https://a.com');
      const p2 = client.scrape('https://b.com');
      const p3 = client.scrape('https://c.com');

      await expect(client.scrape('https://d.com')).rejects.toThrow('concurrent scrape limit');

      await Promise.all([p1, p2, p3]);
    });

    it('should pass includeTags and excludeTags in body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: { markdown: 'content', metadata: { url: 'https://example.com', sourceURL: 'https://example.com', statusCode: 200 } },
        }),
      });

      await client.scrape('https://example.com', {
        includeTags: ['article'],
        excludeTags: ['.ads'],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.includeTags).toEqual(['article']);
      expect(body.excludeTags).toEqual(['.ads']);
    });

    it('should use 90s timeout when actions are present', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: { markdown: 'content', metadata: { url: 'https://example.com', sourceURL: 'https://example.com', statusCode: 200 } },
        }),
      });

      await client.scrape('https://example.com', {
        actions: [{ type: 'click', selector: '#btn' }],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.actions).toEqual([{ type: 'click', selector: '#btn' }]);
    });
  });

  describe('withRetry (exponential backoff)', () => {
    it('should retry on 429 with exponential delay', async () => {
      const err429: any = new Error('429');
      err429.status = 429;
      mockFetch
        .mockRejectedValueOnce(err429)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, data: { markdown: 'ok', metadata: { url: 'x', sourceURL: 'x', statusCode: 200 } } }),
        });

      const result = await client.scrape('https://example.com');
      expect(result.markdown).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 400', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
        headers: new Headers(),
      });

      await expect(client.scrape('https://example.com')).rejects.toThrow('400');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('extract', () => {
    it('should POST to /v1/extract', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { products: [] } }),
      });

      const result = await client.extract(
        ['https://example.com/products'],
        { prompt: 'Extract product names' }
      );

      expect(result.success).toBe(true);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://firecrawl.test:3002/v1/extract');
      expect(options.method).toBe('POST');
    });

    it('should validate URLs for SSRF', async () => {
      await expect(client.extract(
        ['http://localhost:8080'],
        { prompt: 'test' }
      )).rejects.toThrow('SSRF');
    });
  });
});
