// queryRouter.ts — Deterministic rule-chain intent detection for SearXNG

export type SearchIntent = 'general' | 'code' | 'academic' | 'news' | 'social';
export type QueryLanguage = 'zh' | 'en' | 'other';

export interface QueryAnalysis {
  intent: SearchIntent;
  lang: QueryLanguage;
  languageCode: string;
  engines: string;
  matchedRule?: string;
}

// ── Language Detection ──────────────────────────────────────────────

const CJK_RANGE = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7f]/;

function detectLanguage(query: string): QueryLanguage {
  if (CJK_RANGE.test(query)) return 'zh';
  if (!NON_ASCII.test(query)) return 'en';
  return 'other';
}

// ── Engine Tables ───────────────────────────────────────────────────

const GENERAL_BASE = 'google,duckduckgo,brave,startpage,wikipedia';
const GENERAL_ZH   = 'google,duckduckgo,brave,startpage,wikipedia,baidu,sogou,quark';

const CODE_ENGINES     = 'github,stackoverflow,mdn,npm,pypi,docker hub,pkg.go.dev,crates.io,codeberg,hackernews';
const ACADEMIC_ENGINES = 'google scholar,arxiv,semantic scholar,pubmed,crossref,openalex';
const NEWS_ENGINES     = 'google news,bing news,yahoo news,duckduckgo news,wikinews,startpage news,brave.news,reuters';
const NEWS_ENGINES_ZH  = NEWS_ENGINES + ',qwant news,sogou wechat';
const SOCIAL_ENGINES   = 'reddit,hackernews,stackoverflow';

const INTENT_ENGINE_MAP: Record<SearchIntent, { zh: string; en: string }> = {
  general:  { zh: GENERAL_ZH,                              en: GENERAL_BASE },
  code:     { zh: GENERAL_ZH + ',' + CODE_ENGINES,         en: GENERAL_BASE + ',' + CODE_ENGINES },
  academic: { zh: GENERAL_ZH + ',' + ACADEMIC_ENGINES,     en: ACADEMIC_ENGINES },
  news:     { zh: GENERAL_ZH + ',' + NEWS_ENGINES_ZH,      en: GENERAL_BASE + ',' + NEWS_ENGINES },
  social:   { zh: GENERAL_ZH + ',' + SOCIAL_ENGINES,       en: GENERAL_BASE + ',' + SOCIAL_ENGINES },
};

// ── Tier 1: Structural Patterns ─────────────────────────────────────

interface StructureRule {
  name: string;
  pattern: RegExp;
  intent: SearchIntent;
}

const STRUCTURE_RULES: StructureRule[] = [
  { name: 'DOI', pattern: /\b10\.\d{4,}\/\S+/i, intent: 'academic' },
  { name: 'arXiv', pattern: /arxiv[:\s]*\d{4}\.\d{4,}/i, intent: 'academic' },
  { name: 'error_stack', pattern: /(?:TypeError|ReferenceError|SyntaxError|Error|Traceback|at\s+\S+\s+\()/i, intent: 'code' },
  { name: 'package@version', pattern: /\b[\w@/-]+@\d+\.\d+/i, intent: 'code' },
  { name: 'code_platform_url', pattern: /https?:\/\/(?:github|gitlab|stackoverflow|bitbucket)\.\S+/i, intent: 'code' },
];

// ── Tier 2: Code Intent ─────────────────────────────────────────────

// camelCase with ≥2 lowercase prefix (excludes product names like iPhone, iPad, eCommerce)
// or dot-notation API names with alphabetic segments (excludes IP addresses like 192.168.1.1)
const API_CAMEL = /\b[a-z]{2,}[A-Z][a-zA-Z]*\b/;
const API_DOT   = /\b[a-zA-Z]\w*\.[a-zA-Z]\w*\.[a-zA-Z]\w*\b/;

const TECH_NAMES = new Set([
  // languages
  'python', 'javascript', 'typescript', 'java', 'golang', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala', 'c\\+\\+', 'c#',
  // frameworks/tools
  'react', 'vue', 'angular', 'next.js', 'nextjs', 'nuxt', 'svelte', 'express',
  'django', 'flask', 'fastapi', 'spring', 'rails',
  'docker', 'kubernetes', 'k8s', 'nginx', 'apache',
  'webpack', 'vite', 'rollup', 'esbuild', 'babel',
  'node', 'nodejs', 'deno', 'bun',
  'redis', 'mongodb', 'mysql', 'postgresql', 'postgres', 'elasticsearch',
  'git', 'linux', 'terraform', 'ansible', 'grafana', 'prometheus',
  'tailwind', 'css', 'html', 'sass', 'less',
]);

const TECH_PATTERN = new RegExp(`\\b(?:${[...TECH_NAMES].join('|')})\\b`, 'i');

// Only action words, no nouns (框架/代码/函数/接口 removed)
const CODE_ACTION_WORDS = new Set([
  // zh
  '报错', '错误', '配置', '部署', '安装', '升级', '迁移', '编译', '调试', '优化',
  '实现', '解决', '修复', '运行', '构建', '打包', '集成', '设置',
  // en
  'install', 'deploy', 'configure', 'setup', 'build', 'compile', 'debug', 'fix',
  'migrate', 'upgrade', 'optimize', 'implement', 'resolve', 'run', 'execute',
  'error', 'bug', 'issue', 'crash', 'fail', 'failed',
]);

const CODE_ACTION_PATTERN = new RegExp(
  `(?:${[...CODE_ACTION_WORDS].join('|')})`,
  'i'
);

// Tool command patterns: npm/yarn/pnpm/pip/cargo/go/git/docker/kubectl/brew etc.
const TOOL_COMMAND = /\b(?:npm|yarn|pnpm|pip|pip3|cargo|go|git|docker|kubectl|helm|brew|apt|yum|dnf|pacman|make|cmake|mvn|gradle)\s+\w+/i;

// ── Tier 3: Academic ────────────────────────────────────────────────

const ACADEMIC_KEYWORDS = /(?:论文|paper|research|study|survey|综述|学术|thesis|dissertation|journal|conference|proceedings|arXiv|scholar|学者|引用|citation)/i;

// ── Tier 4: News ────────────────────────────────────────────────────

const NEWS_KEYWORDS = /(?:今天|今日|最新|最近|breaking|latest|recent|yesterday|昨天|本周|this\s+week|刚刚|突发|头条|新闻|headline|election|股市|market)/i;

// ── Tier 5: Social/Community ────────────────────────────────────────

const SOCIAL_KEYWORDS = /(?:reddit|推荐|recommend|review|评测|体验|经验|分享|知乎|forum|community|讨论|discussion|best\s+practices)/i;
const VS_PATTERN = /\b\w+\s+vs\.?\s+\w+/i;

// ── Intent Detection ────────────────────────────────────────────────

function detectIntent(query: string, options?: { timeRange?: string }): { intent: SearchIntent; matchedRule?: string } {
  // Tier 1: Structural patterns
  for (const rule of STRUCTURE_RULES) {
    if (rule.pattern.test(query)) {
      return { intent: rule.intent, matchedRule: `tier1:${rule.name}` };
    }
  }

  // Tier 2: Code intent
  if (API_CAMEL.test(query) || API_DOT.test(query)) {
    return { intent: 'code', matchedRule: 'tier2:api_pattern' };
  }
  if (TECH_PATTERN.test(query) && CODE_ACTION_PATTERN.test(query)) {
    return { intent: 'code', matchedRule: 'tier2:tech+action' };
  }
  if (TOOL_COMMAND.test(query)) {
    return { intent: 'code', matchedRule: 'tier2:tool_command' };
  }

  // Tier 3: Academic
  if (ACADEMIC_KEYWORDS.test(query)) {
    return { intent: 'academic', matchedRule: 'tier3:academic_keyword' };
  }

  // Tier 4: News (skip if tech name present — ambiguous)
  const hasNewsSignal = NEWS_KEYWORDS.test(query) || options?.timeRange === 'day' || options?.timeRange === 'week';
  if (hasNewsSignal) {
    if (TECH_PATTERN.test(query)) {
      // Ambiguous: tech + time → general
      return { intent: 'general', matchedRule: 'tier4:news_ambiguous_tech' };
    }
    return { intent: 'news', matchedRule: 'tier4:news_keyword' };
  }

  // Tier 5: Social/Community
  if (SOCIAL_KEYWORDS.test(query) || VS_PATTERN.test(query)) {
    return { intent: 'social', matchedRule: 'tier5:social_keyword' };
  }

  // Tier 6: Fallback
  return { intent: 'general', matchedRule: 'tier6:fallback' };
}

// ── Public API ──────────────────────────────────────────────────────

const LANGUAGE_CODE_MAP: Record<QueryLanguage, string> = {
  zh: 'zh-CN',
  en: 'en',
  other: 'all',
};

export function analyzeQuery(
  query: string,
  options?: {
    timeRange?: string;
    searchTypeOverride?: SearchIntent;
    languageOverride?: QueryLanguage;
  }
): QueryAnalysis {
  const lang = options?.languageOverride ?? detectLanguage(query);
  const { intent, matchedRule } = options?.searchTypeOverride
    ? { intent: options.searchTypeOverride, matchedRule: 'ai_provided' }
    : detectIntent(query, options);
  const langKey = lang === 'other' ? 'en' : lang;
  const engines = INTENT_ENGINE_MAP[intent][langKey];
  const languageCode = LANGUAGE_CODE_MAP[lang];

  console.log(
    `[queryRouter] query="${query}" → lang=${lang} intent=${intent} rule=${matchedRule} engines=${engines}`
  );

  return { intent, lang, languageCode, engines, matchedRule };
}
