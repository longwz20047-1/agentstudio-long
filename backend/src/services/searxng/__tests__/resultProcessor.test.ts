// agentstudio/backend/src/services/searxng/__tests__/resultProcessor.test.ts

import { describe, it, expect } from 'vitest';
import { dedupeAndRank } from '../resultProcessor.js';
import type { SearXNGResult } from '../types.js';

const makeResult = (overrides: Partial<SearXNGResult> = {}): SearXNGResult => ({
  title: 'Test Result',
  url: 'https://example.com/page',
  content: 'Some content',
  engine: 'google',
  engines: ['google'],
  score: 1.0,
  category: 'general',
  ...overrides,
});

describe('dedupeAndRank', () => {
  it('should deduplicate results by URL', () => {
    const results = [
      makeResult({ url: 'https://example.com/a', engines: ['google'], score: 1.0 }),
      makeResult({ url: 'https://example.com/a', engines: ['bing'], score: 0.5 }),
      makeResult({ url: 'https://example.com/b', engines: ['google'], score: 0.8 }),
    ];

    const processed = dedupeAndRank(results, 10);
    expect(processed).toHaveLength(2);
  });

  it('should merge engines and scores for duplicate URLs', () => {
    const results = [
      makeResult({ url: 'https://example.com/a', engines: ['google'], score: 1.0 }),
      makeResult({ url: 'https://example.com/a', engines: ['bing'], score: 0.5 }),
    ];

    const processed = dedupeAndRank(results, 10);
    expect(processed[0].engines).toContain('google');
    expect(processed[0].engines).toContain('bing');
    expect(processed[0].score).toBe(1.5);
  });

  it('should strip tracking params when deduplicating', () => {
    const results = [
      makeResult({ url: 'https://example.com/page?utm_source=google', engines: ['google'], score: 1.0 }),
      makeResult({ url: 'https://example.com/page?fbclid=abc123', engines: ['bing'], score: 0.5 }),
    ];

    const processed = dedupeAndRank(results, 10);
    expect(processed).toHaveLength(1);
    expect(processed[0].score).toBe(1.5);
  });

  it('should sort by score descending', () => {
    const results = [
      makeResult({ url: 'https://a.com', score: 0.5 }),
      makeResult({ url: 'https://b.com', score: 2.0 }),
      makeResult({ url: 'https://c.com', score: 1.0 }),
    ];

    const processed = dedupeAndRank(results, 10);
    expect(processed[0].url).toBe('https://b.com');
    expect(processed[1].url).toBe('https://c.com');
    expect(processed[2].url).toBe('https://a.com');
  });

  it('should truncate snippet to 300 chars', () => {
    const longContent = 'a'.repeat(500);
    const results = [makeResult({ content: longContent })];

    const processed = dedupeAndRank(results, 10);
    expect(processed[0].snippet.length).toBeLessThanOrEqual(303); // 300 + '...'
  });

  it('should respect maxResults limit', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult({ url: `https://example.com/${i}`, score: 20 - i })
    );

    const processed = dedupeAndRank(results, 5);
    expect(processed).toHaveLength(5);
  });

  it('should strip trailing slash when deduplicating', () => {
    const results = [
      makeResult({ url: 'https://example.com/page/', engines: ['google'], score: 1.0 }),
      makeResult({ url: 'https://example.com/page', engines: ['bing'], score: 0.5 }),
    ];

    const processed = dedupeAndRank(results, 10);
    expect(processed).toHaveLength(1);
  });
});
