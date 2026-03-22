# OpenCLI Integration Design Spec

> AgentStudio x OpenCLI: Platform-Level Deep Integration
>
> Date: 2026-03-22
> Status: Approved (design phase)
> Affects: agentstudio, weknora-ui, agentstudio-deploy

## 1. Overview

### 1.1 What is OpenCLI

[OpenCLI](https://github.com/jackwener/opencli) (v1.1.1) is an open-source CLI tool that turns websites, Electron apps, and local binaries into standardized command-line interfaces. It reuses Chrome login sessions (zero API keys) and is designed for AI Agent discovery.

Key stats (verified 2026-03-22):
- 244 commands across 44 sites
- 195 browser-dependent, 49 public API
- Strategy distribution: cookie(106), ui(82), public(49), intercept(6), header(1)
- npm package: `@jackwener/opencli`, Node.js >= 20
- 3,471 GitHub stars, Apache-2.0 license

### 1.2 Integration Goal

Make OpenCLI a **platform-level external world interface** for AgentStudio, enabling all AI Agents to perceive and interact with external platforms (social media, news, finance, desktop apps, dev tools) through A2A conversations.

### 1.3 Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tool granularity | Site-level composite (1 tool per site) | 244 commands -> 44 site tools. Keeps per-domain MCP server <= 11 tools for LLM selection accuracy |
| Domain split | 7 domains (social, media, finance, news, desktop, devtools, jobs) | Natural categorization, each domain independently toggleable |
| Tool generation | Dynamic from `opencli list -f json` metadata | Auto-adapts to opencli updates, no hardcoding per command |
| Security model | Read-write separation | Read: auto-execute. Write: user confirmation via AskUserQuestion. 47 write ops whitelisted |
| Deployment | Local + remote dual mode | Local: direct Chrome Bridge. Remote: OPENCLI_REMOTE_URL env var |
| Frontend | 4 generic + 2 special cards + management console | Data-shape driven routing, not per-site cards |

## 2. Architecture

### 2.1 System Architecture

```
AgentStudio Backend
  |
  +-- services/opencli/  (NEW - OpenCLI Gateway Service)
  |   |
  |   +-- PlatformRegistry      Parse & cache `opencli list -f json`
  |   +-- CommandExecutor        Execute commands via child_process
  |   +-- PermissionEngine       Read/write classification + confirmation
  |   +-- BridgeManager          Chrome daemon/extension health check
  |   +-- OutputFormatter        JSON -> Markdown + structured data
  |   +-- OpenCliMcpFactory      Dynamic MCP tool generation
  |   +-- constants.ts           DOMAIN_MAPPING, WRITE_OPERATIONS, ENRICHMENT
  |   +-- types.ts               OpenCliContext, OpenCliCommand, etc.
  |   +-- historyStore.ts        Operation history persistence
  |   +-- index.ts               Export integrateOpenCliMcpServers()
  |
  +-- utils/claudeUtils.ts       (MODIFIED - add opencli integration block)
  +-- routes/opencli.ts          (NEW - REST API for management console)

weknora-ui Frontend
  |
  +-- components/a2a-tools/tools/  (NEW - 6 card components)
  |   +-- OpenCliListCard.vue       List with title+URL+meta
  |   +-- OpenCliTableCard.vue      Structured table (TDesign t-table)
  |   +-- OpenCliContentCard.vue    Markdown article/conversation
  |   +-- OpenCliStatusCard.vue     Write operation results
  |   +-- OpenCliFinanceCard.vue    Stock quotes with indicators
  |   +-- OpenCliDesktopCard.vue    Terminal-style output
  |   +-- opencli-utils.ts          parseOpenCliResult, normalizeItem
  |
  +-- components/a2a-tools/ToolCallRenderer.vue  (MODIFIED - add opencli routing)
  +-- components/a2a-tools/types.ts              (MODIFIED - add icons/colors)
  +-- views/opencli/                             (NEW - management console)
  +-- stores/opencli.ts                          (NEW - Pinia store)

agentstudio-deploy
  +-- docker-compose.yml    (MODIFIED - add OPENCLI_* env vars)
  +-- .env.example          (MODIFIED)
```

### 2.2 Data Flow (Single Tool Call Lifecycle)

```
User: "Search Bilibili for LLM tutorials"
  |
  v  SSE POST /api/a2a/{agentId}/stream
  |
AgentStudio Backend:
  |
  +-- buildQueryOptions()
  |     opencliContext.enabledDomains = ['media']
  |     -> integrateOpenCliMcpServers()
  |     -> MCP Server 'opencli-media' registers 6 site tools
  |
  +-- Claude SDK reasoning
  |     Selects: mcp__opencli-media__bilibili
  |     Args: { action: "search", query: "LLM", limit: 10 }
  |
  +-- MCP Tool Handler
  |     1. PermissionEngine: "bilibili/search" -> "read" -> allow
  |     2. CommandExecutor: opencli bilibili search --keyword "LLM" --limit 10 -f json
  |     3. OutputFormatter: JSON array -> Markdown table
  |     4. Return: { content: [{ type: 'text', text: markdownTable }] }
  |
  +-- Claude continues reasoning with Markdown table
  |
  v  SSE push to frontend
  |
weknora-ui Frontend:
  +-- ToolCallRenderer detects mcp__opencli-media__ prefix
  +-- Extracts site='bilibili' from tool name, action='search' from toolCall.input
  +-- JSON.parse(toolCall.result) -> array with url field -> OpenCliListCard
  +-- OpenCliListCard renders video list with titles, view counts, links
```

### 2.3 Integration Point in buildQueryOptions

Position: after Firecrawl integration, before AskUserQuestion.

```typescript
// claudeUtils.ts - new block
const opencliContext = extendedOptions?.opencliContext;
if (opencliContext?.enabled && opencliContext?.enabledDomains?.length > 0) {
  await integrateOpenCliMcpServers(
    queryOptions, opencliContext, sessionRef, agentId
  );
  console.log(`[OpenCLI] Integrated domains: ${opencliContext.enabledDomains.join(', ')}`);
}
```

## 3. Site-Level Composite Tool Design

### 3.1 Why Not One Tool Per Command

With 244 individual tools, even split into 7 domains, social domain would have 66 tools and desktop 70+. Claude's tool selection accuracy degrades significantly above ~20-30 tools per MCP server.

### 3.2 Solution: One Tool Per Site

244 commands -> 44 site tools -> 7 domain MCP servers -> max 11 tools per server.

Each site tool uses an `action` enum parameter to route to specific commands.

### 3.3 Domain Mapping (Verified, all command counts from `opencli list -f json`)

```
opencli-social   10 tools: twitter(24), reddit(15), jike(10), xiaohongshu(10),
                           zhihu(4), weibo(1), v2ex(6), coupang(2), smzdm(1), ctrip(1)
                           Total: 74 commands
opencli-media     6 tools: bilibili(12), youtube(3), weread(7), xiaoyuzhou(3),
                           apple-podcasts(3), jimeng(2)
                           Total: 30 commands
opencli-finance   5 tools: xueqiu(6), yahoo-finance(1), bloomberg(10),
                           barchart(4), sinafinance(1)
                           Total: 22 commands
opencli-news     10 tools: hackernews(1), bbc(1), reuters(1), arxiv(2),
                           wikipedia(2), stackoverflow(4), linux-do(6),
                           steam(1), hf(1), chaoxing(2)
                           Total: 21 commands
opencli-desktop  11 tools: cursor(12), codex(11), antigravity(8), chatgpt(5),
                           chatwise(9), notion(8), discord-app(7), feishu(5),
                           wechat(6), neteasemusic(10), grok(1)
                           Total: 82 commands
opencli-devtools  passthrough: gh, docker, kubectl, obsidian, readwise
                           (direct CLI forwarding, no site-composite wrapping)
opencli-jobs      2 tools: boss(14), linkedin(1)
                           Total: 15 commands

Grand total: 10+6+5+10+11+2 = 44 site tools, 74+30+22+21+82+15 = 244 commands
```

### 3.4 Tool Description Generation

Three-layer enrichment from opencli metadata:

**Layer 1: Site-level structured description**

Generated from command metadata. Example for `twitter` tool:

```
twitter platform operations.

READ actions:
- timeline: Get home timeline. Params: limit
- trending: Get Twitter/X trending topics. Params: limit
- search: Search tweets/users. Params: query (required), limit
- bookmarks: Fetch your saved/bookmarked tweets. Params: limit
- thread: Read a tweet thread. Params: tweet-id (required)
- profile: Get user profile info. Params: username (required)
- followers: Get accounts following a user. Params: username (required), limit
- following: Get accounts a user is following. Params: username (required), limit
- notifications: Get your notifications. Params: limit
- article: Fetch a Twitter Article as Markdown. Params: tweet-id (required)

WRITE actions (user confirmation required):
- post: Post a new tweet/thread. Params: text (required)
- reply: Reply to a specific tweet. Params: tweet-url (required), text (required)
- delete: Delete a specific tweet. Params: tweet-url (required)
- like: Like a specific tweet. Params: tweet-url (required)
- follow: Follow a Twitter user. Params: username (required)
- unfollow: Unfollow a Twitter user. Params: username (required)
- bookmark: Bookmark a tweet. Params: tweet-url (required)
- unbookmark: Remove bookmark. Params: tweet-url (required)
- accept: Auto-accept DM requests by keyword. Params: query (required), max
- reply-dm: Send message to recent DM conversations. Params: text (required)
- block: Block a Twitter user. Params: username (required)
- unblock: Unblock a Twitter user. Params: username (required)
- hide-reply: Hide a reply to your tweet. Params: tweet-url (required)

DOWNLOAD:
- download: Download media (images/videos). Params: id, limit

Platform: x.com | Requires Chrome login session
```

**Layer 2: Domain context prefix**

Each domain MCP server tools share a domain context that helps Claude understand the tool category.

**Layer 3: Static enrichment for ambiguous commands**

~10 commands that need disambiguation (e.g., `bilibili/following` is a read operation, not a follow action).

### 3.5 Tool Schema

```typescript
{
  action: z.enum([...actionNames]).describe('Action to perform'),
  query: z.string().optional().describe('Search query, text content, or URL'),
  limit: z.number().int().optional().describe('Max results to return'),
  id: z.string().optional().describe('Target ID (tweet/post/user/video ID)'),
  options: z.record(z.string()).optional().describe('Additional action-specific params'),
}
```

Parameter coverage analysis (verified):
- Universal params (query+limit+id+common) cover 179/244 commands (73%)
- Options catch-all needed for 56 commands (23%)
- 3+ special params needed for 9 commands (4%) - params listed in description

### 3.6 New Site Auto-Detection

When `opencli list` returns sites not in DOMAIN_MAPPING, PlatformRegistry logs a warning and assigns them to a default domain. Management console can reassign.

## 4. Gateway Service Components

### 4.1 PlatformRegistry

- Parses `opencli list -f json` output (244 commands)
- 5-minute TTL cache (avoid re-executing on every Agent call)
- Groups commands by site and domain
- Detects new sites after opencli updates
- Fallback: if opencli is not installed, returns empty list (graceful degradation)

### 4.2 CommandExecutor

- Executes `opencli <site> <action> <args> -f json` via `child_process.exec` with `shell: true`
- Forces `-f json` output (verified stable; `-f table` has bugs in some commands)
- Cross-platform: uses `shell: true` for consistent behavior on Windows (dev env) and Linux (server). Argument values double-quoted and escaped
- Timeout tiers: read 30s, write 60s, download 120s
- Error classification into 5 standard types:
  - `BRIDGE_DISCONNECTED`: Chrome daemon/extension not running
  - `LOGIN_EXPIRED`: Chrome session expired on target site
  - `TIMEOUT`: Command execution timed out
  - `CLI_NOT_FOUND`: opencli not installed
  - `EXEC_ERROR`: Other errors
- Shell injection prevention: argument values quoted and escaped
- **Positional arguments**: 79 of 329 args are positional (`opencli twitter search <query>` not `--query`). CommandExecutor must check `arg.positional` and emit bare values before named flags
- Remote mode: passes `OPENCLI_CDP_ENDPOINT` environment variable for remote Chrome CDP connection (verified env var: `OPENCLI_CDP_ENDPOINT`, `OPENCLI_DAEMON_PORT`, `OPENCLI_CDP_TARGET`, `OPENCLI_HEADLESS`)

### 4.3 PermissionEngine

Read-write separation with verified whitelist.

**Operation classification (verified totals):**
- Read: 193 commands (auto-execute)
- Write: 47 commands (require user confirmation)
- Download: 4 commands (auto-execute, disk-only impact)

**Write operations whitelist (47 commands, all verified to exist):**

```
twitter:      post, reply, delete, like, follow, unfollow, bookmark, unbookmark, accept, reply-dm, block, unblock, hide-reply (13)
reddit:       comment, upvote, save, subscribe (4)
boss:         greet, batchgreet, send, invite, mark, exchange (6)
jike:         create, comment, like, repost (4)
cursor:       send, new, composer (3)
codex:        send, new (2)
antigravity:  send, new (2)
chatgpt:      send, new (2)
chatwise:     send, new (2)
notion:       write, new (2)
discord-app:  send (1)
wechat:       send (1)
feishu:       send, new (2)
grok:         ask (1)
jimeng:       generate (1)
neteasemusic: like (1)
```

**Confirmation mechanism:** Reuses existing `userInputRegistry.waitForUserInput()` from AskUserQuestion MCP infrastructure. Zero additional UI development for the confirmation dialog.

### 4.4 BridgeManager

- Runs `opencli doctor` to check daemon (:19825) and extension status
- Determines mode: local (direct Chrome) / remote (`OPENCLI_CDP_ENDPOINT` set) / disconnected
- Assesses per-platform availability (public commands always available, browser commands depend on Bridge)
- Exposes status via REST API for management console

### 4.5 OutputFormatter

**Design decision**: Return **pure Markdown** to Claude (not JSON). Frontend determines card type from `toolCall.input` (which contains `action` and site info from the MCP tool name), then parses `toolCall.result` as JSON for rich rendering. This matches existing patterns (WebSearchToolCard parses result string, FirecrawlScrapeCard parses JSON from result).

Rationale: Existing MCP tools all return plain text/Markdown. Embedding JSON metadata in the result string would degrade Claude's reasoning quality (it would see JSON instead of a readable table).

**For Claude** (MCP tool return value):
```typescript
return {
  content: [{
    type: 'text',
    text: markdownTable  // Pure Markdown table, Claude reads this
  }]
};
```

**For frontend** (card routing):
```typescript
// ToolCallRenderer.vue
if (toolName.startsWith('mcp__opencli-')) {
  // Extract site name from tool name: mcp__opencli-media__bilibili → bilibili
  const site = toolName.split('__')[2];
  // Extract action from toolCall.input.action
  const action = toolCall.input?.action;
  // Try JSON.parse(toolCall.result) for structured data
  // Fall back to text display if parse fails
}
```

**Markdown generation** (OutputFormatter):
- Array data -> Markdown table (columns from command metadata, values truncated at 80 chars)
- Object data -> Key-value list
- Error data -> Error message with classification

### 4.6 OpenCliMcpFactory

Orchestrates all components to dynamically generate and register MCP servers:

1. For each enabled domain, get sites from DOMAIN_MAPPING
2. For each site, get commands from PlatformRegistry
3. Generate site-level composite tool (description + schema + handler)
4. Create domain MCP server via `createSdkMcpServer()`
5. Register to `queryOptions.mcpServers` and `queryOptions.allowedTools`
6. Error handling: skip failed domains, continue others (graceful degradation)

### 4.7 OpenCliContext (Frontend -> Backend)

```typescript
interface OpenCliContext {
  enabled: boolean;
  enabledDomains: string[];      // e.g., ['social', 'news', 'media']
  cdpEndpoint?: string;          // e.g., 'ws://192.168.1.100:9222/devtools/browser/...'
  daemonPort?: number;           // Override daemon port (default 19825)
}

// Added to BuildQueryExtendedOptions
interface BuildQueryExtendedOptions {
  weknoraContext?: WeknoraContext;
  graphitiContext?: GraphitiContext;
  opencliContext?: OpenCliContext;   // NEW
  effort?: 'low' | 'medium' | 'high' | 'max';
}
```

## 5. Frontend Design

### 5.1 Tool Card System

6 card types routed by data shape, not by site:

| Card | Trigger Condition | Coverage |
|------|------------------|----------|
| OpenCliListCard | Array data + has url/link column | ~29% commands |
| OpenCliTableCard | Array data + no url column | ~20% commands |
| OpenCliContentCard | Has content/text field | ~18% commands |
| OpenCliStatusCard | Status/message fields (write results) | ~35% commands |
| OpenCliFinanceCard | Site in finance domain (xueqiu, yahoo-finance, barchart) | ~5% commands |
| OpenCliDesktopCard | Site in desktop domain | ~28% commands |

Note: percentages overlap as some commands match multiple patterns. Routing priority: Finance > Desktop > List > Content > Table > Status.

**Routing in ToolCallRenderer.vue:**

This introduces **prefix-based routing**, a new pattern. The existing codebase uses exact tool name matching (e.g., `name === 'mcp__firecrawl__firecrawl_scrape'`). Since opencli has 44 site tools across 7 domain servers, exact matching would require 44 entries. Instead:

```typescript
// New pattern: prefix-based routing for opencli tools
if (toolName.startsWith('mcp__opencli-')) {
  // Extract site from tool name: mcp__opencli-media__bilibili → bilibili
  const site = toolName.split('__')[2];
  const action = toolCall.input?.action as string;

  // Try parsing result as JSON (opencli -f json output)
  let data: any = null;
  try { data = JSON.parse(toolCall.result || ''); } catch {}

  // Route by site (finance/desktop) or by data shape
  if (['xueqiu', 'yahoo-finance', 'barchart'].includes(site)) return OpenCliFinanceCard;
  if (['cursor', 'codex', 'chatgpt', ...desktopSites].includes(site)) return OpenCliDesktopCard;
  if (Array.isArray(data) && data[0]?.url) return OpenCliListCard;
  if (Array.isArray(data)) return OpenCliTableCard;
  if (data?.content || data?.text) return OpenCliContentCard;
  return OpenCliStatusCard;
}
```

Card components receive `toolCall` and extract structured data from `toolCall.result` via `JSON.parse()`. If parse fails, they fall back to plain text display. This matches the pattern used by McpToolCard (L105-118) which also attempts `JSON.parse(result)`.

**All cards extend BaseToolCard** using the slot pattern (verified from WebSearchToolCard/FirecrawlScrapeCard).

### 5.2 Card Implementation Patterns

**OpenCliListCard** (primary card):
- Ranked list with title (linked if URL available), author, metrics (score/views/likes/comments)
- Initial display: 5 items, expandable
- Smart field normalization: maps varying field names (title/name/text, url/link/href, etc.) to unified display

**OpenCliFinanceCard** (special):
- Stock symbol + price + change percentage (red/green)
- Key metrics grid (open, high, low, volume, etc.)

**OpenCliDesktopCard** (special):
- Terminal-style display (dark background, monospace font)
- Reuses BashToolCard's visual language
- App emoji + name header

### 5.3 Management Console

Route: `/opencli` (new page in weknora-ui)

5 tabs following Settings.vue's modal + left-nav + right-content pattern:

1. **Connection Status** (default): Bridge mode, daemon/extension status, platform availability grid
2. **Platform Manager**: 44 sites listed with command counts, expandable details, test button
3. **Domain Config**: Toggle switches per domain, affects Agent's MCP tool loading
4. **Permission Settings**: Write operation permission matrix (confirm/allow/deny per command)
5. **Operation History**: Timestamped log of all opencli calls, filterable, paginated

**Backend API (routes/opencli.ts):**

```
GET    /opencli/status       BridgeManager health check
GET    /opencli/platforms     PlatformRegistry grouped by site
GET    /opencli/domains       Domain configuration
PUT    /opencli/domains       Update enabled domains
POST   /opencli/test          Test single command execution
GET    /opencli/history       Operation history (paginated)
GET    /opencli/permissions   Write operation permission matrix
PUT    /opencli/permissions   Update permissions
```

**Pinia Store (stores/opencli.ts):** Manages connection status, domain config, permissions, and history with API calls.

## 6. Deployment

### 6.1 Local Development

Prerequisites:
- `npm install -g @jackwener/opencli` (Node.js >= 20)
- Chrome with Browser Bridge extension installed
- opencli daemon auto-starts on first browser command

Configuration in AgentStudio:
- Management console -> Domain Config -> enable desired domains
- Or via A2A chat Agent configuration

### 6.2 Server Deployment (192.168.100.30)

**Option A (recommended): Remote Chrome on local desktop**

```
Server: OPENCLI_CDP_ENDPOINT=ws://<desktop-ip>:9222/devtools/browser/<id>
Desktop: Chrome launched with --remote-debugging-port=9222
```

Pros: Reuses desktop Chrome login sessions, no server-side cookie management.
Cons: Requires desktop online, Chrome with remote debugging enabled, network reachable.

**Option B: Headless Chrome in Docker**

```yaml
# docker-compose.yml addition
services:
  opencli-chrome:
    image: browserless/chrome
    ports: ["19825:19825"]
    # Pre-configured cookies required
```

Pros: Self-contained.
Cons: Cookie management complexity.

**Environment variables:**

```
OPENCLI_ENABLED=true
OPENCLI_DOMAINS=social,media,finance,news,desktop,devtools,jobs
OPENCLI_CDP_ENDPOINT=              # Optional, ws:// or http:// for remote Chrome
OPENCLI_DAEMON_PORT=19825          # Optional, override daemon port
OPENCLI_HEADLESS=0                 # Optional, set 1 for headless mode
OPENCLI_HISTORY_ENABLED=true
OPENCLI_HISTORY_MAX=1000
```

## 7. Modular Implementation Plan

### Phase Dependencies

```
Phase 1 (Gateway Core)
  |
  +---> Phase 2 (Permission + Bridge)
  |       |
  |       +---> Phase 4 (Management Console)
  |
  +---> Phase 3 (Tool Cards) [parallel with Phase 2]
          |
          +---> Phase 5 (Server Deploy)
```

### Phase 1: Gateway Core Engine

**Goal:** AI Agent can call opencli public API commands via A2A chat.

**Deliverables:**
- `backend/src/services/opencli/` (7 new files)
- `backend/src/utils/claudeUtils.ts` (modified)
- `backend/src/types/` (modified - BuildQueryExtendedOptions)

**Scope:** Only `strategy: 'public'` commands (49 of 244). No permission engine. No Browser Bridge. Frontend uses generic McpToolCard.

**Verification:**
1. "HackerNews top stories" -> mcp__opencli-news__hackernews { action: "top" } -> returns news list
2. "Search arXiv for RAG papers" -> mcp__opencli-news__arxiv { action: "search", query: "RAG" } -> returns papers
3. opencli not installed -> CLI_NOT_FOUND error, AgentStudio continues (graceful degradation)

**Estimate:** ~700 lines of code.

### Phase 2: Permission Engine + Browser Bridge

**Goal:** Support all 244 commands including browser commands and write operations.

**Depends on:** Phase 1.

**Deliverables:**
- `backend/src/services/opencli/permissionEngine.ts` (new)
- `backend/src/services/opencli/bridgeManager.ts` (new)
- `backend/src/routes/opencli.ts` (new - basic API)
- Modified: opencliMcpFactory.ts, constants.ts

**Verification:**
1. bilibili search (read + browser) -> returns results when Bridge connected
2. twitter post (write) -> triggers user confirmation dialog -> execute or cancel
3. Bridge disconnected -> browser commands return BRIDGE_DISCONNECTED error

**Estimate:** ~400 lines of code.

### Phase 3: Specialized Tool Cards

**Goal:** Rich card rendering for opencli results in A2A chat.

**Depends on:** Phase 1. **Can run parallel with Phase 2.**

**Deliverables:**
- 6 new Vue card components + 1 utility file (7 new files)
- Modified: ToolCallRenderer.vue, types.ts

**Verification:**
1. hackernews top -> OpenCliListCard (rank + title + score + link)
2. xueqiu stock -> OpenCliFinanceCard (price + change)
3. cursor ask -> OpenCliDesktopCard (terminal style)
4. Unknown site -> fallback to McpToolCard

**Estimate:** ~800 lines of code.

### Phase 4: Management Console

**Goal:** Visual configuration and monitoring page.

**Depends on:** Phase 2 (needs BridgeManager API).

**Deliverables:**
- `weknora-ui/src/views/opencli/` (6 new files)
- `weknora-ui/src/stores/opencli.ts` (new)
- `weknora-ui/src/router/` (modified)
- `weknora-ui/src/locales/` (modified - 4 languages)
- `backend/src/routes/opencli.ts` (extended)
- `backend/src/services/opencli/historyStore.ts` (new)

**Verification:**
1. /opencli page loads -> shows Bridge status
2. Domain toggle -> affects Agent tool loading
3. Permission change -> twitter/post set to "deny" -> AI call rejected
4. History shows all opencli operations

**Estimate:** ~1200 lines of code.

### Phase 5: Server Deployment

**Goal:** Run on production server (192.168.100.30) with remote Chrome support.

**Depends on:** Phase 1-4.

**Deliverables:**
- `agentstudio-deploy/docker-compose.yml` (modified)
- `agentstudio-deploy/.env.example` (modified)
- `agentstudio-deploy/docs/opencli-deploy.md` (new)

**Verification:**
1. docker compose up -> AgentStudio starts -> opencli tools available
2. Public commands work immediately
3. Browser commands via remote Chrome -> returns results
4. Management console shows remote mode

**Estimate:** ~100 lines of code + documentation.

### Overall Scale

| Phase | New Files | Modified Files | Code Lines | Projects |
|-------|-----------|---------------|------------|----------|
| 1. Gateway Core | 7 | 2 | ~700 | agentstudio |
| 2. Permission+Bridge | 3 | 2 | ~400 | agentstudio |
| 3. Tool Cards | 7 | 2 | ~800 | weknora-ui |
| 4. Management Console | 10 | 4 | ~1200 | weknora-ui + agentstudio |
| 5. Server Deploy | 1 | 2 | ~100 | agentstudio-deploy |
| **Total** | **28** | **12** | **~3200** | **3 projects** |

## 8. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| opencli CLI bug (e.g., -f table crash) | High | Low | Force -f json; classify errors |
| Chrome login session expiration | High | Medium | BridgeManager detects, UI shows re-login prompt |
| Too many tools in description confuses Claude | Medium | High | Site-level composite (max 10 tools/domain, verified) |
| Platform bot detection on write operations | Medium | Medium | User confirmation adds human-in-the-loop delay |
| opencli breaking API changes | Low | High | PlatformRegistry caches; pin opencli version in production |
| Shell injection via tool parameters | Low | Critical | Quote + escape all argument values; no eval |
| Desktop app adapters macOS-only | Certain | Low | Desktop domain degradation on non-macOS; clearly documented |
| Windows shell compatibility | Medium | Medium | Use `shell: true` in child_process.exec; test argument quoting on Windows (dev env is Windows). opencli itself is cross-platform Node.js |
| Concurrent Chrome session contention | Medium | Medium | opencli daemon serializes browser access internally. For high concurrency, add a semaphore in CommandExecutor (max 3 parallel browser commands) |

## 9. Testing Strategy

Each phase includes tests co-located with source code, following existing patterns (`__tests__/` directories, Vitest).

| Phase | Test Scope | Examples |
|-------|-----------|----------|
| 1. Gateway Core | Unit tests for PlatformRegistry, CommandExecutor, OutputFormatter, tool generation | Parse `opencli list` output; build CLI args with quoting; format JSON to Markdown |
| 2. Permission+Bridge | Unit tests for PermissionEngine whitelist; BridgeManager health check parsing | Classify read/write/download; parse `opencli doctor` output |
| 3. Tool Cards | Component tests with Vitest + Testing Library | Render OpenCliListCard with mock data; test card routing in ToolCallRenderer |
| 4. Management Console | Component tests + API route tests | Domain toggle state; permission matrix CRUD |
| 5. Server Deploy | Manual verification checklist | Docker env vars; remote Chrome connectivity |

Phase estimates include test code (~30% of implementation code).

## 10. Future Considerations (Not In Scope)

- **Scheduled monitoring**: Periodic opencli commands for stock alerts, news digests
- **Multi-user Chrome sessions**: Different users with different login states
- **opencli adapter authoring**: Using AgentStudio to create new opencli adapters
- **Result caching**: Cache frequently queried data (e.g., stock prices) with TTL
- **Batch operations**: Execute multiple opencli commands in parallel
