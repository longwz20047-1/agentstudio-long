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
      // Start 3 slow scrapes (at the concurrency limit)
      mockFetch.mockImplementation(() => new Promise(resolve =>
        setTimeout(() => resolve({
          ok: true,
          json: async () => ({ success: true, data: { markdown: 'ok', metadata: { url: 'x', sourceURL: 'x', statusCode: 200 } } }),
        }), 100)
      ));

      const p1 = client.scrape('https://a.com');
      const p2 = client.scrape('https://b.com');
      const p3 = client.scrape('https://c.com');

      // 4th should be rejected
      await expect(client.scrape('https://d.com')).rejects.toThrow('concurrent scrape limit');

      await Promise.all([p1, p2, p3]);
    });
  });

  describe('mapSite', () => {
    it('should POST to /v1/map', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, links: ['https://a.com', 'https://b.com'] }),
      });

      const links = await client.mapSite('https://example.com');
      expect(links).toEqual(['https://a.com', 'https://b.com']);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://firecrawl.test:3002/v1/map');
    });
  });
});
