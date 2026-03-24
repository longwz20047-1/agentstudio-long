export const DOMAIN_MAPPING: Record<string, string[]> = {
  social: ['twitter', 'reddit', 'tiktok', 'instagram', 'jike', 'xiaohongshu', 'v2ex', 'coupang', 'zhihu', 'weibo', 'smzdm', 'ctrip', 'facebook'],
  media: ['bilibili', 'weread', 'douban', 'youtube', 'xiaoyuzhou', 'apple-podcasts', 'medium', 'jimeng'],
  finance: ['bloomberg', 'xueqiu', 'barchart', 'yahoo-finance', 'sinafinance'],
  news: ['linux-do', 'stackoverflow', 'wikipedia', 'lobsters', 'sinablog', 'google', 'devto', 'substack', 'arxiv', 'chaoxing', 'hackernews', 'bbc', 'reuters', 'steam', 'hf'],
  desktop: ['cursor', 'codex', 'chatwise', 'antigravity', 'notion', 'discord-app', 'chatgpt', 'grok'],
  jobs: ['boss', 'linkedin'],
};

export const ALL_DOMAINS = Object.keys(DOMAIN_MAPPING);

export const WRITE_OPERATIONS: Record<string, string[]> = {
  twitter: ['post', 'reply', 'delete', 'like', 'follow', 'unfollow', 'bookmark', 'unbookmark', 'accept', 'reply-dm', 'block', 'unblock', 'hide-reply'],
  reddit: ['comment', 'upvote', 'save', 'subscribe'],
  tiktok: ['comment', 'follow', 'like', 'save', 'unfollow', 'unlike', 'unsave'],
  instagram: ['comment', 'follow', 'like', 'save', 'unfollow', 'unlike', 'unsave', 'add-friend'],
  facebook: ['add-friend', 'join-group'],
  boss: ['greet', 'batchgreet', 'send', 'invite', 'mark', 'exchange'],
  jike: ['create', 'comment', 'like', 'repost'],
  cursor: ['send', 'new', 'composer', 'ask'],
  codex: ['send', 'new', 'ask'],
  antigravity: ['send', 'new'],
  chatgpt: ['send', 'new', 'ask'],
  chatwise: ['send', 'new', 'ask'],
  notion: ['write', 'new'],
  'discord-app': ['send'],
  grok: ['ask'],
  jimeng: ['generate'],
};

export const DEFAULT_COMMAND_TIMEOUT = 30000;
export const WRITE_COMMAND_TIMEOUT = 60000;
export const CONFIRMATION_TIMEOUT = 3 * 60 * 1000; // 3 minutes for user confirmation
export const HEARTBEAT_INTERVAL = 30000;
export const HEARTBEAT_TIMEOUT = 10000;
export const MAX_MISSED_HEARTBEATS = 3;
