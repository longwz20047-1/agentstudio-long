import { describe, it, expect, vi, beforeEach } from 'vitest';
import { filterSitesByCapabilities, generateSiteToolDescription } from '../opencliMcpFactory.js';

describe('filterSitesByCapabilities', () => {
  it('returns intersection of domain sites with available sites', () => {
    const result = filterSitesByCapabilities('social', ['twitter', 'reddit', 'bilibili', 'youtube']);
    expect(result).toContain('twitter');
    expect(result).toContain('reddit');
    // bilibili and youtube are in 'media', not 'social'
    expect(result).not.toContain('bilibili');
    expect(result).not.toContain('youtube');
  });

  it('returns empty array when no sites match', () => {
    const result = filterSitesByCapabilities('social', ['bilibili', 'youtube', 'bloomberg']);
    expect(result).toEqual([]);
  });

  it('returns empty array for unknown domain', () => {
    const result = filterSitesByCapabilities('nonexistent', ['twitter', 'reddit']);
    expect(result).toEqual([]);
  });

  it('returns all domain sites when all are available', () => {
    const available = ['bloomberg', 'xueqiu', 'barchart', 'yahoo-finance', 'sinafinance'];
    const result = filterSitesByCapabilities('finance', available);
    expect(result).toEqual(available);
  });

  it('handles partial overlap correctly', () => {
    const result = filterSitesByCapabilities('media', ['bilibili', 'weread', 'twitter']);
    expect(result).toEqual(['bilibili', 'weread']);
  });
});

describe('generateSiteToolDescription', () => {
  it('contains site name', () => {
    const desc = generateSiteToolDescription('twitter');
    expect(desc.toLowerCase()).toContain('twitter');
  });

  it('mentions action parameter', () => {
    const desc = generateSiteToolDescription('reddit');
    expect(desc.toLowerCase()).toContain('action');
  });

  it('works for sites with hyphens', () => {
    const desc = generateSiteToolDescription('yahoo-finance');
    expect(desc.toLowerCase()).toContain('yahoo-finance');
  });
});
