import { describe, it, expect } from 'vitest';
import {
  analyzeQuery,
  SearchIntent,
  QueryLanguage,
} from '../queryRouter.js';

// Helper to get intent from analyzeQuery
function getIntent(query: string, options?: { timeRange?: string }): SearchIntent {
  return analyzeQuery(query, options).intent;
}

// Helper to get language from analyzeQuery
function getLang(query: string): QueryLanguage {
  return analyzeQuery(query).lang;
}

// Helper to get engines from analyzeQuery
function getEngines(query: string, options?: { timeRange?: string }): string {
  return analyzeQuery(query, options).engines;
}

describe('queryRouter', () => {
  describe('language detection', () => {
    it('detects zh for CJK characters', () => {
      expect(getLang('如何使用 Docker 部署')).toBe('zh');
      expect(getLang('日本語テスト')).toBe('zh');
      expect(getLang('한국어 테스트')).toBe('zh');
    });

    it('detects en for pure ASCII text', () => {
      expect(getLang('how to use Docker')).toBe('en');
      expect(getLang('react useEffect cleanup')).toBe('en');
    });

    it('detects other for non-CJK non-ASCII text', () => {
      expect(getLang('café résumé über')).toBe('other');
      expect(getLang('données française')).toBe('other');
    });
  });

  describe('Tier 1: structural patterns', () => {
    it('DOI → academic', () => {
      expect(getIntent('10.1038/nature12373')).toBe('academic');
      expect(getIntent('doi: 10.1145/1234567.1234568')).toBe('academic');
    });

    it('arXiv ID → academic', () => {
      expect(getIntent('arXiv:2301.07041')).toBe('academic');
      expect(getIntent('arxiv 2301.07041v2')).toBe('academic');
    });

    it('error stack → code', () => {
      expect(getIntent('TypeError: Cannot read properties of undefined')).toBe('code');
      expect(getIntent('Traceback (most recent call last):')).toBe('code');
      expect(getIntent('at Object.<anonymous> (/app/index.js:10:5)')).toBe('code');
    });

    it('package@version → code', () => {
      expect(getIntent('lodash@4.17.21')).toBe('code');
      expect(getIntent('react@18.2.0 breaking changes')).toBe('code');
    });

    it('github/gitlab/stackoverflow URL → code', () => {
      expect(getIntent('https://github.com/facebook/react/issues/123')).toBe('code');
      expect(getIntent('https://stackoverflow.com/questions/12345')).toBe('code');
      expect(getIntent('https://gitlab.com/org/repo')).toBe('code');
    });
  });

  describe('Tier 2: code intent', () => {
    it('API reference pattern → code', () => {
      expect(getIntent('useEffect')).toBe('code');
      expect(getIntent('useState hook')).toBe('code');
      expect(getIntent('Array.prototype.map')).toBe('code');
    });

    it('tech name + action word → code', () => {
      expect(getIntent('docker 部署报错')).toBe('code');
      expect(getIntent('nginx 配置 ssl')).toBe('code');
      expect(getIntent('python install pandas')).toBe('code');
    });

    it('tool command pattern → code', () => {
      expect(getIntent('npm install express')).toBe('code');
      expect(getIntent('git rebase --interactive')).toBe('code');
      expect(getIntent('pip install tensorflow')).toBe('code');
    });

    it('tech name alone without action word → NOT code', () => {
      expect(getIntent('Python 最新版本')).not.toBe('code');
    });

    it('product/brand names with camelCase → NOT code', () => {
      expect(getIntent('iPhone 16 Pro')).not.toBe('code');
      expect(getIntent('eCommerce platform')).not.toBe('code');
      expect(getIntent('iPad Air review')).not.toBe('code');
    });

    it('IP-like dot notation → NOT code', () => {
      expect(getIntent('192.168.1.1 network setup')).not.toBe('code');
    });
  });

  describe('Tier 3: academic', () => {
    it('academic keywords → academic', () => {
      expect(getIntent('transformer 论文')).toBe('academic');
      expect(getIntent('machine learning research paper')).toBe('academic');
      expect(getIntent('深度学习综述')).toBe('academic');
    });
  });

  describe('Tier 4: news', () => {
    it('time-sensitive words without tech → news', () => {
      expect(getIntent('今天股市行情')).toBe('news');
      expect(getIntent('latest election results')).toBe('news');
    });

    it('timeRange=day → news', () => {
      expect(getIntent('weather forecast', { timeRange: 'day' })).toBe('news');
    });

    it('timeRange=week → news', () => {
      expect(getIntent('weather forecast', { timeRange: 'week' })).toBe('news');
    });

    it('tech + time word → general (ambiguous, skip)', () => {
      expect(getIntent('React 最新版本发布')).toBe('general');
    });
  });

  describe('Tier 5: social/community', () => {
    it('community keywords → social', () => {
      expect(getIntent('best practices for code review reddit')).toBe('social');
      expect(getIntent('推荐一个好用的笔记软件')).toBe('social');
    });

    it('vs comparison → social', () => {
      expect(getIntent('React vs Vue')).toBe('social');
      expect(getIntent('PostgreSQL vs MySQL 对比')).toBe('social');
    });
  });

  describe('Tier 6: fallback', () => {
    it('no signal → general', () => {
      expect(getIntent('天气预报')).toBe('general');
      expect(getIntent('what is the meaning of life')).toBe('general');
    });
  });

  describe('engine routing', () => {
    it('zh code includes baidu and github', () => {
      const engines = getEngines('docker 部署报错');
      expect(engines).toContain('baidu');
      expect(engines).toContain('github');
    });

    it('en code does not include baidu', () => {
      const engines = getEngines('npm install express');
      expect(engines).not.toContain('baidu');
    });

    it('zh general includes baidu, sogou, quark', () => {
      const engines = getEngines('天气预报');
      expect(engines).toContain('baidu');
      expect(engines).toContain('sogou');
      expect(engines).toContain('quark');
    });

    it('news zh includes sogou wechat as single engine name', () => {
      const engines = getEngines('今天股市行情');
      expect(engines).toContain('sogou wechat');
    });

    it('news en includes reuters but not sogou wechat', () => {
      const engines = getEngines('latest election results');
      expect(engines).toContain('reuters');
      expect(engines).not.toContain('sogou wechat');
    });

    it('languageCode mapping: zh→zh-CN, en→en, other→all', () => {
      expect(analyzeQuery('如何使用Docker').languageCode).toBe('zh-CN');
      expect(analyzeQuery('how to use Docker').languageCode).toBe('en');
      expect(analyzeQuery('café résumé über').languageCode).toBe('all');
    });
  });
});
