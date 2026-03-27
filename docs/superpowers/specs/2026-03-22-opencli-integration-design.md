# OpenCLI Integration Design Spec

> AgentStudio x OpenCLI: Platform-Level Deep Integration with Remote Bridge Architecture
>
> Date: 2026-03-22
> Status: Approved (design phase)
> Affects: agentstudio (backend), weknora-ui (frontend), new project opencli-bridge (Electron)
>
> Workspace location: `D:\workspace\agent-weknora\opencli-bridge/` — the 6th sub-project in the workspace, alongside WeKnora, weknora-ui, agentstudio, agentstudio-deploy, graphiti. Independent git repo.

## 1. Overview

### 1.1 What is OpenCLI

[OpenCLI](https://github.com/jackwener/opencli) (v1.3.1) is an open-source CLI tool that turns websites, Electron apps, and local binaries into standardized command-line interfaces. It reuses Chrome login sessions (zero API keys) and is designed for AI Agent discovery.

Key stats (verified 2026-03-23 via `opencli list -f json`, v1.3.1):
- 293 commands across 51 sites
- 241 browser-dependent, 52 public API
- Strategy distribution: cookie(161), ui(72), public(53), intercept(6), header(1)
- npm package: `@jackwener/opencli`, Node.js >= 20
- ~2,300 GitHub stars, Apache-2.0 license

### 1.2 Integration Goal

Make OpenCLI a **platform-level external world interface** for AgentStudio, enabling all AI Agents to perceive and interact with external platforms (social media, news, finance, desktop apps) through A2A conversations.

### 1.3 Why Bridge Architecture

AgentStudio runs on a server (e.g., 192.168.100.30). opencli requires:
- A local Chrome browser with login sessions (241 of 293 commands)
- Optionally local desktop apps — Cursor, Notion, etc. (72 ui-strategy commands)

**Problem**: Server cannot access user's local machine (NAT/firewall). Server-side `spawn opencli` only works for 52 public commands (18%).

**Solution**: A generic Electron desktop app (`opencli-bridge`) that:
- Runs on the user's local machine alongside Chrome
- Connects **outbound** to AgentStudio servers via WebSocket (NAT-friendly)
- Receives opencli commands from server, executes locally, returns results
- Supports multiple AgentStudio servers and multiple projects per server
- Requires zero CLI knowledge — system tray icon only, all management on server web UI

This unlocks all 293 commands (100%) including browser and desktop app commands.

### 1.4 Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tool granularity | Site-level composite (1 tool per site) | 293 commands → 51 site tools. Max 13 tools per domain MCP server (social); within Claude's effective range with site-level composite |
| Domain split | 6 domains (social, media, finance, news, desktop, jobs) | Natural categorization, each domain independently toggleable per project. Note: opencli's `domain` field is the website URL — this mapping is AgentStudio-level |
| Tool generation | Dynamic from opencli metadata | Bridge reports `capabilities.availableSites`; server generates tools accordingly |
| Security model | One-time pairing token + read-write separation | Pairing: `obp_` token (10min TTL, single-use) exchanges for long-lived `obk_` key on first WS handshake — plaintext key never in clipboard/URL. Read: auto-execute. Write: user confirmation via AskUserQuestion (3min timeout). Bridge executes blindly; server decides |
| Execution model | Remote bridge via WebSocket | Electron app on user's machine, outbound WS to server. Promise+ID Map for async command dispatch (same pattern as AskUserQuestion). Independent WebSocketServer instance, decoupled from existing /ws endpoint |
| Bridge technology | Electron (tray-only) | Bundles Node.js (opencli needs it), cross-platform tray/updater/installer, team uses TypeScript. ~120-150MB |
| Distribution | Generic public download | One universal installer. Users add servers via config strings (paste or `obk://` protocol link) |
| Bridge registry key | projectId + userId | Server tracks per-project-per-user for routing. projectId = `proj_xxx` short hash from a2aContext (NOT the filesystem path) |
| Frontend | 4 generic + 2 special cards + bridge management tab | Data-shape driven card routing; management in project settings |

## 2. Architecture

### 2.1 System Overview

```
User's Local Machine                         Server (e.g., 192.168.100.30)
─────────────────────                        ───────────────────────────────

Electron App (opencli-bridge)                weknora-ui (Frontend)
  ├── TrayManager        ●/○ 托盘图标         ├── A2A Chat (SSE 流式)
  ├── ConnectionManager  多服务器 WS 管理      │   └── opencli / cli-apps 工具卡片渲染
  ├── CommandRunner      spawn any CLI         ├── 项目设置 → OpenCLI Bridge tab
  ├── ProductInstaller   pip install/uninstall │   ├── 连接状态 / 配置串生成
  ├── ConfigStore        本地配置持久化         │   ├── 域配置 / 诊断 / 历史
  ├── ProtocolHandler    obk:// 链接处理       │   ├── CLI Products (安装/卸载)
  ├── AutoStart          开机自启               │   └── 离线黄色横幅提醒
  └── AutoUpdater        静默更新              │
                                              AgentStudio Backend (Express, port 4936)
Chrome ←→ opencli daemon ←→ Extension          ├── routes/a2a.ts        A2A 聊天入口
(用户已登录的各网站)                             │   ├── 解出 projectId (a2aContext)
                                               │   ├── 解出 userId (graphitiContext.user_id)
                                               │   └── buildQueryOptions →
                                               │       └── integrateOpenCliMcpServers()
  ...                                          │
                                               │
  ┌─── WS 长连接（本地主动发起）──────────→    │
  │    穿 NAT ✅                               ├── routes/opencliWs.ts   WS 端点 /api/opencli/bridge
  │                                            │   ├── API key 认证
  │    ←── command (server 下发) ───────       │   ├── 心跳 30s / 断线检测
  │    ──── result (bridge 返回) ──────→       │   ├── 命令转发 + 配置推送
  │    ←── config_update ──────────────        │   └── 产品安装/卸载指令 (§12)
  │    ──── diagnose_result ───────────→       │
  │    ←── install_product ────────────        ├── routes/opencli.ts     REST API (管理台)
  │    ──── install_result ────────────→       │   ├── POST /api/opencli/pairing-token
  └──────────────────────────────────────       │   ├── GET/DELETE /api/opencli/bridges
                                               │   ├── PUT /api/opencli/domains
                                               │   └── CLI Products 管理 (§12.6)
                                               │
                                               ├── services/opencli/
                                               │   ├── bridgeRegistry.ts      在线 bridge 注册表
                                               │   ├── bridgeCommandProxy.ts   MCP → WS 异步调度
                                               │   ├── bridgeKeyService.ts     obk_ API key 管理
                                               │   ├── bridgeHistoryStore.ts   执行历史
                                               │   ├── opencliMcpFactory.ts    OpenCLI 动态 MCP 工具生成 (6 域 51 站点)
                                               │   ├── cliAnythingMcpFactory.ts  CLI-Anything MCP 工具生成 (自发现, §12.3)
                                               │   ├── permissionEngine.ts     读写权限分类
                                               │   ├── outputFormatter.ts      结果格式化
                                               │   ├── constants.ts            域映射 + 写操作白名单
                                               │   └── types.ts                类型定义
                                               │
                                               └── utils/claudeUtils.ts
                                                   └── integrateOpenCliMcpServers()
                                                       bridge 在线 → 注册 OpenCLI MCP 工具
                                                       bridge 离线 → 跳过 + systemPrompt 提示
```

### 2.2 Data Flow (Complete Command Lifecycle)

```
Prerequisite: Bridge already paired and connected (see §6 Pairing Protocol for initial setup flow:
  config string with obp_ token → WS handshake → exchange for obk_ key → persistent connection)

User asks in A2A chat: "Search Bilibili for LLM tutorials"

1. weknora-ui → POST /api/a2a/{agentId}/stream
   body: { message: "...", context: { graphiti: { user_id: "alice@example.com" } } }

2. a2a.ts:
   - projectId = a2aContext.projectId                    (deterministic hash: proj_ + base64(workingDirectory).slice(-12), from agentMappingService)
   - graphitiContext.user_id = "alice@example.com"          (from request body)
   - resolveUserWorkspacePath() → /project/.workspaces/u_alice_example_com

3. buildQueryOptions() → integrateOpenCliMcpServers():
   - bridgeRegistry.isOnline("proj_001", "alice@example.com") → true ✅
   - 项目 "proj_001" 启用了 media 域
   - → 注册 MCP Server 'opencli-media' with 8 site tools (bilibili, youtube, ...)

4. Claude SDK reasoning:
   - 选择工具: mcp__opencli-media__bilibili
   - 参数: { action: "search", query: "LLM", limit: 10 }

5. MCP tool handler:
   a. permissionEngine: "bilibili/search" → read → auto-allow
   b. bridgeCommandProxy.dispatch("proj_001", "alice@example.com", {
        site: "bilibili", action: "search", args: ["LLM", "--limit", "10"]
      })
      → 生成 cmd_uuid, 存入 pendingCommands Map
      → ws.send({ type: "command", id: "cmd_uuid", ... })
      → await Promise...

6. Electron app (alice 的电脑):
   - ConnectionManager 收到 command 消息
   - CommandRunner: spawn('opencli', ['bilibili', 'search', 'LLM', '--limit', '10', '-f', 'json'])
   - opencli 通过 Chrome daemon + Extension 拿到 B 站搜索结果
   - ws.send({ type: "result", id: "cmd_uuid", success: true, stdout: "[{...}]" })

7. AgentStudio 收到 result:
   - bridgeCommandProxy.onResult() → pendingCommands.get("cmd_uuid").resolve(stdout)
   - outputFormatter: Markdown header + JSON code block
   - → 返回给 Claude: { content: [{ type: 'text', text: '## bilibili/search results...' }] }

8. Claude 继续推理 → SSE 推送 → weknora-ui:
   - ToolCallRenderer: toolName.startsWith('mcp__opencli-') → prefix routing
   - parseOpenCliJsonResult() → JSON array with url → OpenCliListCard
   - 渲染视频列表: 标题、播放量、链接
```

### 2.3 User Identity & Workspace Isolation

The user identity for bridge routing comes from `context.graphiti.user_id` — the same field that drives per-user workspace isolation. The project identity comes from `a2aContext.projectId` — a deterministic short hash (`proj_` + 12 chars) derived from the project path, distinct from `a2aContext.workingDirectory` (the raw filesystem path).

```
weknora-ui POST /api/a2a/{agentId}/stream
  body.context.graphiti.user_id = "alice@example.com"
    ↓
a2a.ts:687   const graphitiContext = context?.graphiti
a2a.ts:727   const userId = graphitiContext?.user_id
    ↓
a2aContext fields (from a2aAuth middleware):
  - a2aContext.projectId       = "proj_jqxrFlXe5b9c"  (short hash, for storage/routing)
  - a2aContext.workingDirectory = "/home/user/projects" (filesystem path, for SDK cwd)
    ↓
Three uses of userId + projectId:
  1. Workspace: resolveUserWorkspacePath(workingDir, userId)
     → /project/.workspaces/u_alice_example_com (Claude SDK cwd)
  2. Bridge routing: bridgeRegistry.get(projectId, userId)
     → Find alice's bridge WS connection for this project
  3. Graphiti memory: per-user knowledge graph sessions
```

If `graphitiContext.user_id` is absent, opencli bridge routing falls back to the API key owner's userId (from `a2aAuth` middleware → `a2aContext.apiKeyId` → resolve to userId). This avoids hard coupling with graphiti config.

### 2.4 Integration Point in buildQueryOptions

Position: after Firecrawl and AskUserQuestion integration, before return.

```typescript
// claudeUtils.ts — new block (after AskUserQuestion integration at ~L587)
const opencliContext = extendedOptions?.opencliContext;
if (opencliContext?.enabled && opencliContext?.enabledDomains?.length > 0) {
  if (bridgeRegistry.isOnline(opencliContext.projectId, opencliContext.userId)) {
    await integrateOpenCliMcpServers(
      queryOptions, opencliContext, askUserSessionRef, agentIdForAskUser || ''
    );
    console.log(`[OpenCLI] Integrated domains: ${opencliContext.enabledDomains.join(', ')}`);
  } else {
    // Bridge offline — don't register tools, add systemPrompt hint
    queryOptions.systemPrompt = (queryOptions.systemPrompt || '') + '\n\n[OpenCLI Bridge is not connected. External platform access unavailable.]';
  }
}
```

`askUserSessionRef` is shared with AskUserQuestion integration for write operation confirmation dialogs.

## 3. Site-Level Composite Tool Design

### 3.1 Why Not One Tool Per Command

With 293 individual tools, even split into 6 domains, social domain would have 113 tools. Claude's tool selection accuracy degrades significantly above ~20-30 tools per MCP server.

### 3.2 Solution: One Tool Per Site

293 commands → 51 site tools → 6 domain MCP servers → max 13 tools per server (social).

Each site tool uses an `action` enum parameter to route to specific commands.

### 3.3 Domain Mapping (Verified via `opencli list -f json`, v1.3.1)

```
opencli-social   13 tools: twitter(24), reddit(15), tiktok(15), instagram(14),
                           jike(10), xiaohongshu(10), v2ex(6), coupang(2),
                           zhihu(4), weibo(1), smzdm(1), ctrip(1), facebook(10)
                           Total: 113 commands
opencli-media     8 tools: bilibili(12), weread(7), douban(7), youtube(3),
                           xiaoyuzhou(3), apple-podcasts(3), medium(3), jimeng(2)
                           Total: 40 commands
opencli-finance   5 tools: bloomberg(10), xueqiu(7), barchart(4),
                           yahoo-finance(1), sinafinance(1)
                           Total: 23 commands
opencli-news     15 tools: linux-do(6), stackoverflow(4), wikipedia(4),
                           lobsters(4), sinablog(4), google(4), devto(3),
                           substack(3), arxiv(2), chaoxing(2), hackernews(1),
                           bbc(1), reuters(1), steam(1), hf(1)
                           Total: 41 commands
opencli-desktop   8 tools: cursor(12), codex(11), chatwise(9),
                           antigravity(8), notion(8), discord-app(7),
                           chatgpt(5), grok(1)
                           Total: 61 commands
opencli-jobs      2 tools: boss(14), linkedin(1)
                           Total: 15 commands

Grand total: 13+8+5+15+8+2 = 51 site tools,
             113+40+23+41+61+15 = 293 commands
```

> **Note**: `doubao(5)` is not listed in the v1.3.1 domain mapping above. Verify via `opencli list -f json | jq '.[] | select(.site=="doubao")'` before Phase 1. If present, assign to `opencli-desktop` (AI assistant category, same as chatgpt/grok). If absent in v1.3.1, remove this reference.
>
> `tiktok` is assigned to `opencli-social` above. All other sites from `opencli list` are accounted for in the 6 domains. New sites added in future opencli versions are auto-assigned via §3.6 fallback mechanism.
>
> opencli v1.3.1 does not include devtools CLI passthrough (gh, docker, kubectl, etc.).
> When available in a future version, they can be registered as a 7th domain.

### 3.4 Tool Description Generation

Three-layer enrichment from opencli metadata:

**Layer 1: Site-level structured description** — Generated from command metadata. Example for `twitter` tool:

```
twitter platform operations.

READ actions:
- timeline: Get home timeline. Params: limit
- trending: Get trending topics. Params: limit
- search: Search tweets/users. Params: query (required), limit
- bookmarks: Fetch bookmarked tweets. Params: limit
- thread: Read a tweet thread. Params: tweet-id (required)
- profile: Get user profile. Params: username (required)
- followers/following: Get user's followers/following. Params: username (required), limit
- notifications: Get notifications. Params: limit
- article: Fetch Twitter Article as Markdown. Params: tweet-id (required)

WRITE actions (user confirmation required):
- post: Post a tweet. Params: text (required)
- reply: Reply to tweet. Params: tweet-url (required), text (required)
- delete/like/follow/unfollow/bookmark/unbookmark/block/unblock/hide-reply
- accept: Auto-accept DM requests. Params: query (required), max
- reply-dm: Send DM. Params: text (required)

Platform: x.com | Requires Chrome login session
```

**Layer 2: Domain context prefix** — Each domain MCP server shares a domain context.

**Layer 3: Static enrichment** — ~10 ambiguous commands (e.g., `bilibili/following` is read, not follow).

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

Parameter coverage (verified): universal params cover ~215/293 (73%), options catch-all for ~67 (23%), 3+ special params for ~11 (4%).

### 3.6 New Site Auto-Detection

When bridge reports `availableSites` containing sites not in DOMAIN_MAPPING, server logs a warning and assigns them to a default domain. Management console can reassign.

**Removed sites**: When DOMAIN_MAPPING contains sites that bridge's `availableSites` does NOT report, those sites are simply not generated as tools (§4.6 already uses intersection filtering: `DOMAIN_MAPPING[domain] ∩ capabilities.availableSites`). No error, no warning — the tool set naturally adapts to the bridge's actual capabilities.

## 4. Server-Side Components

### 4.1 File Structure

```
backend/src/
├── routes/
│   ├── opencliWs.ts                     # NEW — WebSocket endpoint /api/opencli/bridge
│   │                                    # API key 认证 + bridge 注册 + 命令转发 + 心跳
│   │                                    # + 产品安装/卸载指令转发 (§12.2)
│   └── opencli.ts                       # NEW — REST API for management console
│       │                                # Auth: JWT (via existing auth middleware,
│       │                                # same pattern as other Express routes like projects, agents)
│       │                                # projectId from query/body params
│       ├── POST   /api/opencli/pairing-token    生成配对令牌 (Auth: JWT, Body: projectId, userId)
│       ├── GET    /api/opencli/bridges?projectId=xxx          在线 bridge 列表 (Auth: JWT)
│       ├── DELETE /api/opencli/bridges/:id?projectId=xxx      吊销 bridge + revoke API key (Auth: JWT)
│       ├── POST   /api/opencli/bridges/:id/diagnose  触发远程诊断 (Auth: JWT, Body: projectId)
│       ├── GET    /api/opencli/bridges/:id/history?projectId=xxx   执行历史 paginated (Auth: JWT)
│       ├── PUT    /api/opencli/domains          项目级域配置 (Auth: JWT, Body: projectId, enabledDomains[])
│       ├── GET    /api/opencli/cli-products?projectId=xxx        已安装产品 (Auth: JWT, §12.6)
│       ├── POST   /api/opencli/cli-products/install     远程安装 (Auth: JWT, Body: projectId, §12.6)
│       └── DELETE /api/opencli/cli-products/:name?projectId=xxx       远程卸载 (Auth: JWT, §12.6)
│
├── services/opencli/
│   ├── bridgeRegistry.ts                # NEW — Map<projectId||userId, BridgeEntry>
│   │                                    # 一个 WS 可被多个 entry 共享引用
│   ├── bridgeCommandProxy.ts            # NEW — MCP tool → WS 下发 → Promise 等待结果
│   │                                    # 复用 AskUserQuestion 的 Promise+Map 模式
│   │                                    # 支持自定义 binary (opencli / cli-anything-*)
│   ├── bridgeKeyService.ts              # NEW — obk_ API key 生成/验证/吊销
│   │                                    # 复用 apiKeyService 的 bcrypt+AES-256-GCM 模式
│   ├── bridgeHistoryStore.ts            # NEW — 命令执行历史 (.a2a/opencli-history/)
│   ├── opencliMcpFactory.ts             # NEW — OpenCLI 动态 MCP 工具生成 (6 域 51 站点)
│   │                                    # tool handler 调 bridgeCommandProxy.dispatch()
│   ├── cliAnythingMcpFactory.ts         # FUTURE (RFC) — CLI-Anything MCP 工具生成
│   │                                    # SKILL.md 解析 → 动态生成 tools → cli-apps 域
│   ├── permissionEngine.ts              # NEW — 读写分类 (OpenCLI: 51 write whitelist;
│   │                                    #   CLI-Anything: 全部默认 write require confirmation — see RFC)
│   ├── outputFormatter.ts               # NEW — Firecrawl pattern: Markdown header + JSON block
│   ├── constants.ts                     # NEW — DOMAIN_MAPPING, WRITE_OPERATIONS, ENRICHMENT
│   ├── types.ts                         # NEW — OpenCliContext, BridgeCommand, BridgeResult, etc.
│   └── index.ts                         # NEW — export integrateOpenCliMcpServers()
│
├── utils/claudeUtils.ts                 # MODIFIED — 添加 opencli 集成块 (§2.4)
├── routes/a2a.ts                        # MODIFIED — 从 a2aContext + graphitiContext 构造 opencliContext
├── app.ts                               # MODIFIED — 添加 setupOpenCliBridgeWs(server) 调用 (§7.1)
└── services/websocketService.ts         # MODIFIED — 1. upgrade handler: `socket.destroy()` → `return` for non-/ws paths (§7.1)
                                         #            2. 新增 broadcastOpenCliBridgeEvent() 导出函数 (§8.3)
```

### 4.2 bridgeRegistry

```typescript
type RegistryKey = `${string}||${string}`;  // "projectId||userId" (projectId is proj_xxx short hash, not a path)
// IMPORTANT: userId MUST be normalized to lowercase before use as key.
// Bridge config userId and A2A graphitiContext.user_id come from different sources —
// case mismatch (e.g., "Alice@example.com" vs "alice@example.com") causes silent routing failure.
// Normalization: userId.trim().toLowerCase() in both register() and get().

interface BridgeEntry {
  bridgeId: string;
  deviceName: string;
  userId: string;
  projectId: string;
  ws: WebSocket;                    // Shared: same ws for same server+user
  status: 'online' | 'offline';
  connectedAt: Date;
  lastHeartbeat: Date;
  capabilities: BridgeCapabilities;
}

interface BridgeCapabilities {
  opencliVersion: string;
  nodeVersion: string;
  platform: string;
  daemonRunning: boolean;
  extensionConnected: boolean;
  availableSites: string[];
}

class BridgeRegistry {
  private entries: Map<RegistryKey, BridgeEntry>;

  register(ws: WebSocket, msg: RegisterMessage): void;   // Creates N entries for N projects
  unregister(ws: WebSocket): void;                        // Removes all entries for this ws
  get(projectId: string, userId: string): BridgeEntry | undefined;
  isOnline(projectId: string, userId: string): boolean;
  getAllForProject(projectId: string): BridgeEntry[];
  getAllForUser(userId: string): BridgeEntry[];
}
```

**One WS, multiple entries**: When a bridge registers with `projects: ["proj_001", "proj_002"]`, two entries are created, both referencing the same `ws`.

**Multi-device same user+project: device takeover** (Phase 1-6):

RegistryKey is `projectId||userId` — only one device per user per project is active. When a second device registers for the same key:

```typescript
register(ws: WebSocket, msg: RegisterMessage): void {
  for (const project of msg.projects) {
    const key: RegistryKey = `${project.projectId}||${msg.userId}`;
    const existing = this.entries.get(key);

    if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
      // Phase 1: last-wins — notify old device, then replace
      existing.ws.send(JSON.stringify({
        type: 'device_replaced',
        projectId: project.projectId,
        replacedBy: msg.deviceName,
      }));
      // Old device's WS stays open but entry is overwritten — no commands dispatched to it
    }

    this.entries.set(key, {
      bridgeId: msg.bridgeId, deviceName: msg.deviceName,
      userId: msg.userId, projectId: project.projectId,
      ws, status: 'online', connectedAt: new Date(),
      lastHeartbeat: new Date(), capabilities: msg.capabilities,
    });
  }
}
```

**Old device behavior** on receiving `device_replaced`:
1. Tray turns yellow: "⚠ {projectName}: taken over by {replacedBy}"
2. WS stays connected but idle — no commands dispatched to it
3. User can manually re-register by restarting bridge or reconnecting from tray menu

**Phase 1 `unregister()`** (simple — no standby fallback):
```typescript
unregister(ws: WebSocket): void {
  for (const [key, entry] of this.entries) {
    if (entry.ws === ws) {
      this.entries.delete(key);
      bridgeCommandProxy.rejectAllForBridge(entry.projectId, entry.userId);
    }
  }
}
```

> **Future (Phase 7+): Standby fallback** — Upgrade to `standbyEntries: Map<RegistryKey, BridgeEntry[]>` to track replaced-but-still-connected devices. When the active device disconnects, auto-promote from standby via `findStandbyDevice()`. This adds ~80 lines and requires `device_promoted` WS message. Deferred because Phase 1 single-device-per-user covers >95% of use cases.

### 4.3 bridgeCommandProxy

Async command dispatch using Promise + request ID Map (same pattern as `userInputRegistry.waitForUserInput()`):

```typescript
class BridgeCommandProxy {
  private pending: Map<string, PendingCommand>;

  async dispatch(
    projectId: string, userId: string,
    command: { site: string; action: string; args: string[]; timeout?: number }
  ): Promise<string> {
    const entry = bridgeRegistry.get(projectId, userId);
    if (!entry) throw new BridgeError('BRIDGE_OFFLINE');
    if (entry.ws.readyState !== WebSocket.OPEN) throw new BridgeError('BRIDGE_DISCONNECTED');

    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('BRIDGE_TIMEOUT'));
      }, command.timeout || 30000);

      this.pending.set(id, { resolve, reject, timer, projectId, userId });
      entry.ws.send(JSON.stringify({ type: 'command', id, ...command }));
    });
  }

  onResult(msg: ResultMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    msg.success ? pending.resolve(msg.stdout) : pending.reject(new BridgeError(msg.error));
  }

  // Called by bridgeRegistry.unregister() when WS disconnects
  rejectAllForBridge(projectId: string, userId: string): void {
    for (const [id, cmd] of this.pending) {
      if (cmd.projectId === projectId && cmd.userId === userId) {
        clearTimeout(cmd.timer);
        this.pending.delete(id);
        cmd.reject(new BridgeError('BRIDGE_DISCONNECTED'));
      }
    }
  }
}
```

### 4.4 permissionEngine

Read-write separation with verified whitelist.

**Classification**: Read 214 (auto-execute) | Write 75 (user confirmation) | Download 4 (auto-execute)

> Note: 4 `export` commands (chatwise, codex, cursor, notion) are classified as **read** — they extract/export data without side effects. The 4 `download` commands (bilibili, twitter, xiaohongshu, zhihu) download media files — also auto-execute.

**Write operations whitelist (75 commands, 64 explicitly listed below + 11 pending audit):**

```
twitter:      post, reply, delete, like, follow, unfollow, bookmark, unbookmark, accept, reply-dm, block, unblock, hide-reply (13)
reddit:       comment, upvote, save, subscribe (4)
tiktok:       comment, follow, like, save, unfollow, unlike, unsave (7)
instagram:    comment, follow, like, save, unfollow, unlike, unsave, add-friend (8)
facebook:     add-friend, join-group (2)
boss:         greet, batchgreet, send, invite, mark, exchange (6)
jike:         create, comment, like, repost (4)
cursor:       send, new, composer, ask (4)
codex:        send, new, ask (3)
antigravity:  send, new (2)
chatgpt:      send, new, ask (3)
chatwise:     send, new, ask (3)
notion:       write, new (2)
discord-app:  send (1)
grok:         ask (1)
jimeng:       generate (1)
                                        Subtotal: 64 listed
```

> **11 commands pending audit**: New sites (douban, sinablog, medium, substack, lobsters, google, devto, etc.)
> may contain write-like operations (e.g., douban/marks, sinablog/article). Run `opencli list -f json | jq`
> to audit each action's semantics. Default to **write (require confirmation)** for ambiguous commands.
> Update this whitelist before Phase 3 (Permission Engine) implementation.

> `ask` in desktop apps = "send prompt + wait response" → write.
> `jike/post` = "view post details" → read (despite the name).

**Confirmation**: Reuses `userInputRegistry.waitForUserInput()` from AskUserQuestion MCP infrastructure.

**Timeout coordination for write operations**:

Write flow: MCP handler → `waitForUserInput()` (user confirms in browser) → `bridgeCommandProxy.dispatch()` (bridge executes).

Three timeouts overlap:
1. Claude SDK tool execution timeout (~5-10 min, platform-controlled)
2. `waitForUserInput()` — currently no timeout (max 24h cleanup)
3. `bridgeCommandProxy.dispatch()` — 60s for write ops

**Rule**: Set `waitForUserInput()` timeout to **3 minutes** for write confirmations. If user doesn't respond within 3 min, reject with "Confirmation expired. Please retry." Combined with bridge execution (max 60s), total write flow ≤ 4 min — safely within Claude SDK's ~5-10 min tool timeout. This prevents orphaned Promises and avoids timeout boundary collisions.

**Implementation**: The existing `userInputRegistry.waitForUserInput()` has no timeout parameter and should NOT be modified globally (other AskUserQuestion flows depend on unlimited wait). Instead, wrap with `Promise.race()` in the opencli tool handler:

```typescript
// In opencliMcpFactory.ts tool handler for write operations
const WRITE_CONFIRMATION_TIMEOUT = 3 * 60 * 1000; // 3 minutes

try {
  const userResponse = await Promise.race([
    userInputRegistry.waitForUserInput(sessionId, agentId, toolUseId, confirmQuestions),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Confirmation expired. Please retry the command.')),
      WRITE_CONFIRMATION_TIMEOUT)
    ),
  ]);
  // User confirmed — proceed with bridge dispatch
} catch (err) {
  // Timeout or user rejected — clean up the orphaned pending entry
  userInputRegistry.cancelPendingInput(toolUseId);  // Removes entry from pendingInputs Map
  throw err;
}
```

### 4.5 outputFormatter

Follows **Firecrawl pattern** (see `services/firecrawl/firecrawlIntegration.ts:395-399`):

```typescript
let text = `## ${site}/${action} results (${data.length} found)\n\n`;
text += '```json\n' + JSON.stringify(data, null, 2) + '\n```';
return { content: [{ type: 'text', text }] };
```

Frontend extraction:
```typescript
export function parseOpenCliJsonResult(result: string): any {
  try { return JSON.parse(result); } catch {}
  const match = result.match(/```json\n([\s\S]*?)\n```/);
  if (match) { try { return JSON.parse(match[1]); } catch {} }
  return null;
}
```

### 4.6 opencliMcpFactory

Orchestrates tool generation per domain:

1. Get bridge capabilities (available sites) from bridgeRegistry
2. For each enabled domain, filter sites by **intersection**: `DOMAIN_MAPPING[domain] ∩ capabilities.availableSites`. Only generate tools for sites the bridge can actually execute — different bridges may produce different tool sets per session.
3. Generate site-level composite tool (description from §3.4 + schema from §3.5)
4. Tool handler: permissionEngine check → bridgeCommandProxy.dispatch() → outputFormatter
5. Create domain MCP server via `createSdkMcpServer()`
6. Register to `queryOptions.mcpServers` and `queryOptions.allowedTools`
7. Graceful degradation: skip failed domains, continue others

**Edge case: opencli not installed on bridge machine**:

If `capabilities.availableSites` is empty (opencli not installed or daemon not running):
- Do NOT register any MCP tools for this session
- Append to systemPrompt: `[OpenCLI Bridge connected but no commands available. The user may need to install opencli: npm install -g @jackwener/opencli]`
- Management console (`OpenCliBridgeSettings.vue`) shows installation guidance with one-click copy command

### 4.7 OpenCliContext

```typescript
interface OpenCliContext {
  enabled: boolean;
  enabledDomains: string[];      // e.g., ['social', 'news', 'media']
  projectId: string;             // From a2aContext.projectId (proj_xxx short hash)
  userId: string;                // From graphitiContext.user_id or a2aAuth fallback
}

// Added to BuildQueryExtendedOptions
interface BuildQueryExtendedOptions {
  weknoraContext?: WeknoraContext;
  graphitiContext?: GraphitiContext;
  opencliContext?: OpenCliContext;
  effort?: 'low' | 'medium' | 'high' | 'max';
}
```

**Context passing** (in `a2a.ts`):

OpenCliContext is constructed **server-side** (not from client request body) — all 4 fields are available on the server, and this avoids requiring weknora-ui to pre-fetch opencli config before each A2A request:

```typescript
// Construct opencli context server-side (after resolving a2aContext at ~L684-687)
const opencliConfig = await loadProjectOpenCliConfig(a2aContext.workingDirectory); // from projectMetadataStorage
const opencliUserId = graphitiContext?.user_id || resolveApiKeyOwner(a2aContext.apiKeyId); // fallback to API key owner
const opencliContext: OpenCliContext | undefined = opencliConfig?.enabled
  ? {
      enabled: true,
      enabledDomains: opencliConfig.enabledDomains,
      projectId: a2aContext.projectId,              // proj_xxx short hash (NOT workingDirectory path)
      userId: opencliUserId,
    }
  : undefined;

// Pass into extendedOptions (modify L795-801):
(weknoraContext || graphitiContext || effort || opencliContext)
  ? {
      ...(weknoraContext ? { weknoraContext } : {}),
      ...(graphitiContext ? { graphitiContext } : {}),
      ...(effort ? { effort } : {}),
      ...(opencliContext ? { opencliContext } : {}),
    }
  : undefined, // extendedOptions
```

### 4.8 OpenCLI Config Storage

OpenCLI configuration is stored per-project in a **dedicated file**, following the same per-project storage pattern as `apiKeyService` (which stores in `.a2a/api-keys.json`).

> **Note**: `projectMetadataStorage` uses a centralized `~/.agentstudio/data/projects.json` — NOT suitable for opencli config. We use a separate per-project file to avoid coupling with the centralized ProjectMetadata interface.

**Storage location**: `{workingDirectory}/.a2a/opencli-config.json` (new file, per-project).

```typescript
// NEW: services/opencli/opencliConfigStorage.ts
// Pattern: same as apiKeyService's getProjectApiKeysFile() for per-project .a2a/ storage

import { getProjectA2ADir } from '../config/paths.js';  // resolves {workingDir}/.a2a/

interface OpenCliProjectConfig {
  enabled: boolean;                    // Master toggle. Default: false
  enabledDomains: string[];            // Default: all 6 domains when enabled
  // Per-domain write permission overrides (future, Phase 3+)
  // domainWriteOverrides?: Record<string, boolean>;
}

const CONFIG_FILENAME = 'opencli-config.json';

export function loadProjectOpenCliConfig(workingDirectory: string): OpenCliProjectConfig | undefined {
  const configPath = path.join(getProjectA2ADir(workingDirectory), CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return undefined;  // opencli disabled by default
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

export function saveProjectOpenCliConfig(workingDirectory: string, config: OpenCliProjectConfig): void {
  const dir = getProjectA2ADir(workingDirectory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(config, null, 2));
}
```

**`PUT /api/opencli/domains`** writes via dedicated storage:
```typescript
// In opencli.ts route handler
const config = loadProjectOpenCliConfig(workingDirectory) || { enabled: false, enabledDomains: [] };
config.enabled = true;
config.enabledDomains = req.body.enabledDomains;
saveProjectOpenCliConfig(workingDirectory, config);
```

**Default behavior**: Projects without `.a2a/opencli-config.json` → opencli disabled. First time enabling via management console creates the file.

## 5. Electron Bridge App

### 5.1 Project Structure

**Workspace path**: `D:\workspace\agent-weknora\opencli-bridge/`

```
agent-weknora/
├── WeKnora/              # existing
├── weknora-ui/           # existing
├── agentstudio/          # existing
├── agentstudio-deploy/   # existing
├── graphiti/             # existing
└── opencli-bridge/       # NEW — Electron Bridge App (独立 git repo)
```

Project layout:

```
opencli-bridge/
├── package.json                 # electron, cross-spawn, auto-launch, electron-updater
├── electron-builder.yml         # 3-platform build: .exe (NSIS), .dmg, .AppImage
├── src/
│   ├── main.ts                  # Electron main process entry
│   ├── tray.ts                  # System tray (icon states + right-click menu)
│   ├── trayFallback.ts          # Linux tray detection + fallback mini-window
│   ├── connectionManager.ts     # Multi-server WS lifecycle + reconnect + health monitor
│   ├── commandRunner.ts         # spawn opencli via cross-spawn
│   ├── productInstaller.ts      # FUTURE (RFC) — pip install/uninstall cli-anything-*
│   ├── capabilityScanner.ts     # Scan installed opencli → report capabilities
│   ├── configStore.ts           # ~/.opencli-bridge/config.json persistence
│   ├── protocolHandler.ts       # obk:// custom protocol handler (best-effort on Linux)
│   ├── autoStart.ts             # Boot auto-start via auto-launch
│   ├── updater.ts               # Silent auto-update via electron-updater
│   ├── uninstaller.ts           # Clean uninstall: remove config, autostart, protocol reg
│   └── types.ts                 # Shared type definitions
├── assets/
│   ├── tray-connected.png       # Green (all connected)
│   ├── tray-partial.png         # Yellow (some disconnected)
│   └── tray-disconnected.png    # Red (all disconnected / no servers)
└── build/                       # electron-builder resources
```

### 5.2 Local Configuration

```jsonc
// ~/.opencli-bridge/config.json
{
  "bridgeId": "b_7f3a...",              // Auto-generated UUID on first launch
  "deviceName": "Alice-PC",             // Auto from os.hostname()
  "autoStart": true,
  "servers": [
    {
      "id": "srv_abc",
      "name": "Company AgentStudio",
      "wsUrl": "ws://192.168.100.30:4936/api/opencli/bridge",
      "apiKey": "obk_xxx...",           // Long-lived key, obtained via pairing handshake (NOT from config string)
      "userId": "alice@example.com",
      "projects": [
        { "projectId": "proj_001", "projectName": "Social Media Ops" },
        { "projectId": "proj_002", "projectName": "Finance Analysis" }
      ],
      "paired": true,                   // false during initial pairing attempt
      "addedAt": "2026-03-22T10:00:00Z"
    }
  ]
}
```

### 5.3 System Tray & Linux Fallback

```
Right-click menu:
  ● Company AgentStudio — Connected (2 projects)
  ○ Test Server — Disconnected
  ──────────────
  Add Server...          → Paste dialog
  ──────────────
  Device Name: Alice-PC  → Editable
  Auto-Start: ✓          → Toggle
  ──────────────
  About (v1.0.0)
  Quit
```

**Linux Tray Detection & Fallback** (Phase 1 requirement, not deferred):

GNOME 3.26+ removed legacy system tray. Electron only supports StatusNotifier/AppIndicator.
Without `gnome-shell-extension-appindicator`, tray icon is invisible on: Fedora, Arch, Debian (vanilla GNOME), i3/Sway/Polybar.

```typescript
// trayFallback.ts — called from main.ts after Tray creation
async function ensureTrayVisibility(tray: Tray): Promise<void> {
  if (process.platform !== 'linux') return; // Windows/macOS tray always works

  // Detection: create tray, wait 800ms, check if bounds are non-zero
  await new Promise(r => setTimeout(r, 800));
  const bounds = tray.getBounds();
  const trayWorking = bounds.width > 0 && bounds.height > 0;

  if (!trayWorking) {
    console.warn('[Tray] System tray not supported on this Linux DE, falling back to mini-window');
    // Fallback 1: Tiny always-on-top status window (200x80px)
    createStatusWindow(); // shows connection status + "Manage via web UI" link
    // Fallback 2: stdout message for headless/terminal users
    console.log('opencli-bridge running. Manage at: http://server:4936/settings → OpenCLI Bridge tab');
  }
}
```

**Fallback priority**: tray icon → mini status window → console output.

**macOS note**: Use `LSUIElement=1` in `Info.plist` (not `app.dock.hide()`) to avoid dock icon flicker.

### 5.4 Install & Uninstall

**Install** (electron-builder):

| Platform | Format | Behavior |
|----------|--------|----------|
| Windows | NSIS `.exe` | Standard installer with options; registers `obk://` protocol; adds Start Menu entry |
| macOS | `.dmg` | Drag-to-Applications; `Info.plist` registers `obk://` + `LSUIElement` |
| Linux | `.AppImage` + `.deb` | AppImage for universal; `.deb` for Ubuntu/Debian with desktop integration |

**Code signing**: Authenticode (Windows) + Apple notarization (macOS). Linux unsigned (standard for AppImage).

**Uninstall** (`uninstaller.ts` — called on explicit uninstall or via system uninstaller):

```typescript
async function cleanUninstall(): Promise<void> {
  // 1. Disconnect all WS connections gracefully (send close frame)
  await connectionManager.disconnectAll();

  // 2. Remove auto-start registration
  await autoLaunch.disable(); // removes registry/plist/desktop file

  // 3. Remove custom protocol registration (Windows registry, Linux xdg-mime)
  if (process.platform === 'win32') {
    app.removeAsDefaultProtocolClient('obk');
  }

  // 4. Remove config directory (optional — prompt user)
  // ~/.opencli-bridge/config.json contains server URLs and API keys
  // Default: keep config for re-install. Add --purge flag for full removal.

  // 5. Remove native messaging host registration if applicable
  // Chrome: ~/.config/google-chrome/NativeMessagingHosts/
  // Chromium: ~/.config/chromium/NativeMessagingHosts/
}
```

**NSIS uninstaller** (Windows): electron-builder auto-generates. Custom script adds `cleanUninstall()` call before file removal.

**Linux AppImage**: No system uninstaller. Provide `opencli-bridge --uninstall` CLI flag that runs `cleanUninstall()` then deletes the AppImage file.

### 5.5 CommandRunner

```typescript
import spawn from 'cross-spawn';

async function execute(command: BridgeCommand): Promise<BridgeResult> {
  const args = [command.site, command.action, ...command.args, '-f', 'json'];
  // Remove Electron-specific env vars that could affect opencli's Node.js runtime
  const env = { ...process.env, ...command.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn('opencli', args, {
    env,
    timeout: command.timeout || 30000,
  });
  // Collect stdout + stderr, resolve on close
}
```

**Concurrency**: Semaphore (max 3 parallel browser commands). Public API commands bypass.

**Error classification** (from stderr): `BRIDGE_DISCONNECTED` | `LOGIN_EXPIRED` | `TIMEOUT` | `CLI_NOT_FOUND` | `EXEC_ERROR`

**Positional arguments**: 79 of 329 args are positional. The MCP tool handler on the server maps `query`/`limit`/`id`/`options` parameters to the correct CLI args format (positional values before named flags), then sends the pre-formatted `args: string[]` to the bridge. CommandRunner simply passes them through to `spawn`.

### 5.6 Auto-Update & Auto-Start

**Auto-update**: `electron-updater` with GitHub Releases. Silent download, install on next restart.

**Auto-start** via `auto-launch` (no admin rights):

| Platform | Mechanism |
|----------|-----------|
| Windows | Registry `HKCU\...\Run` |
| macOS | `~/Library/LaunchAgents/com.opencli-bridge.plist` |
| Linux | `~/.config/autostart/opencli-bridge.desktop` (XDG Autostart — works on GNOME/KDE/XFCE; niche Wayland compositors may not honor) |

## 6. Pairing Protocol

### 6.1 Config String Format

Config strings use a **one-time pairing token** (not the long-lived API key) for security:

```jsonc
// Config string = "obk://" + base64url(JSON)
{
  "v": 1,
  "server": "ws://192.168.100.30:4936/api/opencli/bridge",
  "serverName": "Company AgentStudio",
  "pairingToken": "obp_7f3a9b2c...",        // One-time token, NOT the obk_ key
  "userId": "alice@example.com",
  "project": { "id": "proj_001", "name": "Social Media Ops" }
}
```

**Pairing token vs API key separation**:

| | Pairing Token (`obp_`) | Bridge API Key (`obk_`) |
|---|---|---|
| **Purpose** | One-time credential exchange | Long-lived WS authentication |
| **Lifetime** | 10 minutes from generation | Until explicitly revoked |
| **Usage limit** | Single use (consumed on first WS connect) | Unlimited |
| **Exposure** | In config string / `obk://` URL / clipboard | Only stored locally in `~/.opencli-bridge/config.json` |
| **Format** | `obp_` + 32 hex chars | `obk_` + 32 hex chars |

**Pairing flow**:
1. weknora-ui calls `POST /api/opencli/pairing-token` → server generates `obp_` token (10 min TTL, stored in memory with `setTimeout` cleanup)
2. User pastes config string into bridge (or clicks `obk://` link)
3. Bridge connects WS with `X-Bridge-Pairing-Token: obp_xxx` header (instead of `X-Bridge-Key`)
4. Server validates token → if valid: generates `obk_` key, returns it in WS `paired` message, deletes token
5. Bridge stores `obk_` key in `~/.opencli-bridge/config.json`, reconnects with `X-Bridge-Key: obk_xxx`
6. Subsequent connections always use `obk_` key (token no longer needed)

**Security benefits**: Intercepting the config string (clipboard/screen share) only yields a 10-min single-use token. The real `obk_` key never leaves the bridge machine after initial exchange.

**API key** (long-lived `obk_`): prefix `obk_`, bcrypt hash on server (复用 apiKeyService 的 bcrypt+AES-256-GCM 模式), per server+user (reused across projects), revocable.

**API key lifecycle**:
- **Generation**: Server creates `obk_` key during first successful pairing handshake. Same user pairing again from a different device generates a new key (old key stays valid — multi-device support).
- **Storage**: Server-side in `{workingDirectory}/.a2a/opencli-bridge-keys.json` (separate from A2A `agt_proj_` keys). Format matches apiKeyService: `{ keys: [{ keyHash, userId, createdAt, lastUsedAt }] }`.
- **No expiration**: `obk_` keys are long-lived (bridge needs persistent access). Revocation is the invalidation mechanism.
- **Revocation**: `DELETE /api/opencli/bridges/:id` revokes the `obk_` key AND sends WS close frame (code 4001). Bridge receives close code 4001 → does NOT reconnect (marks server as "key revoked" in tray).
- **Scope**: One `obk_` key authenticates one user on one device for one server. Project-level isolation is handled by the `register` message's `projects[]` array, not by the key itself.

> **Protocol handler reliability**: `obk://` links are reliable on Windows and macOS (packaged app only). On Linux, protocol handler depends on DE + `xdg-mime` and may fail on Flatpak/Snap browsers. **Paste config string is the primary pairing mechanism**; `obk://` is a convenience shortcut.

### 6.2 Config String Parsing (Electron App)

```
Receive config string (paste or obk:// link)
  → base64url decode → validate v=1 + required fields
  → Check servers[]: same wsUrl + userId?
    → Found: merge project into existing entry's projects[] (deduplicate)
    → Not found: create new server entry with { paired: false, pairingToken: obp_xxx }
  → Save to disk → update tray
  → ConnectionManager: connect WS with X-Bridge-Pairing-Token header
    → Server validates token → sends { type: "paired", obkKey: "obk_xxx..." }
    → Bridge stores obk_ key in config, sets paired: true, removes pairingToken
    → Reconnect WS with X-Bridge-Key header (normal authenticated flow)
    → If token expired/invalid: tray shows "Pairing failed — request new config string"
```

### 6.3 Server-Side Pairing API

```
POST /api/opencli/pairing-token
  Auth: JWT (via auth middleware, user logged in to weknora-ui)
  Body: { projectId: string, userId: string }
  Response: { configString, protocolLink, userId, expiresAt }
           // expiresAt: ISO 8601 string, e.g., "2026-03-22T10:10:00.000Z" (10 min from now)

  Logic:
  1. Validate JWT token (via auth middleware)
  2. userId from request body (weknora-ui passes context.graphiti.user_id)
  3. Generate one-time pairing token (obp_ prefix, 10 min TTL, stored in memory Map)
  4. Construct config JSON (with obp_ token, NOT obk_ key) → base64url encode → return
  5. Token auto-deleted after 10 min or after first successful bridge handshake
```

## 7. WebSocket Protocol

### 7.1 Connection

```
Bridge → Server:
  WS CONNECT ws://server:4936/api/opencli/bridge   (or wss:// for TLS)
  Headers (first connect — pairing):
    X-Bridge-Pairing-Token: obp_xxx, X-Bridge-Id: b_7f3a, X-Device-Name: Alice-PC
  Headers (subsequent connects — authenticated):
    X-Bridge-Key: obk_xxx, X-Bridge-Id: b_7f3a, X-Device-Name: Alice-PC
```

**Server-side WS endpoint** — **independent WebSocketServer instance**, decoupled from the existing `/ws` endpoint:

The existing `websocketService.ts` uses `noServer: true` with JWT auth for `/ws`. The opencli bridge uses `obk_` key auth — mixing them in one handler risks auth confusion. Solution: create a separate `WebSocketServer` in `opencliWs.ts` and register it as a second upgrade handler.

```typescript
// In opencliWs.ts — independent WS server
const wssOpenCLI = new WebSocketServer({ noServer: true });

export function setupOpenCliBridgeWs(server: Server): void {
  // Register upgrade handler — called from app.ts alongside websocketService setup
  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname === '/api/opencli/bridge') {
      // Rate limit check (per API key, max 10 upgrade requests/min)
      const pairingToken = request.headers['x-bridge-pairing-token'] as string;
      const apiKey = request.headers['x-bridge-key'] as string;

      if (pairingToken) {
        // Pairing flow: validate one-time token
        if (!await validatePairingToken(pairingToken)) { socket.destroy(); return; }
        wssOpenCLI.handleUpgrade(request, socket, head, (ws) => {
          wssOpenCLI.emit('connection', ws, request, { type: 'pairing', token: pairingToken });
        });
      } else if (apiKey) {
        // Normal flow: validate obk_ key
        if (!await validateBridgeKey(apiKey)) { socket.destroy(); return; }
        if (isRateLimited(apiKey)) { socket.destroy(); return; }
        wssOpenCLI.handleUpgrade(request, socket, head, (ws) => {
          wssOpenCLI.emit('connection', ws, request, { type: 'authenticated', apiKey });
        });
      } else {
        socket.destroy(); return;
      }
    }
    // NOTE: Do NOT handle '/ws' here — that's websocketService.ts's responsibility.
    // Node.js allows multiple 'upgrade' listeners; each checks its own path and ignores others.
  });
}
```

**Integration in `app.ts`** (or server initialization):
```typescript
import { setupWebSocket } from './services/websocketService.js';
import { setupOpenCliBridgeWs } from './routes/opencliWs.js';

const server = app.listen(PORT);
setupWebSocket(server);        // existing: handles /ws with JWT
setupOpenCliBridgeWs(server);  // new: handles /api/opencli/bridge with obk_ key
```

**WebSocket upgrade handler coexistence** requires a one-line change in the existing `websocketService.ts`:

```typescript
// websocketService.ts line 56-58 — BEFORE (blocks all non-/ws upgrades):
if (url.pathname !== '/ws') {
  socket.destroy();  // ← This kills opencli bridge connections before the new handler can fire
  return;
}

// AFTER (allow other handlers to process non-/ws paths):
if (url.pathname !== '/ws') {
  return;  // Don't destroy — let other upgrade listeners handle their own paths
}
```

Node.js `EventEmitter` calls `'upgrade'` listeners in registration order. Since `setupWebSocket` is registered first, it fires first. Without this change, it destroys the socket for `/api/opencli/bridge` before `setupOpenCliBridgeWs` ever sees it. With this change, it simply returns, and the next listener handles the opencli path. Unhandled paths (neither `/ws` nor `/api/opencli/bridge`) are destroyed by the opencli handler's fallback.

> **Impact**: This is a one-line change (`socket.destroy()` → no-op return) with no effect on existing `/ws` behavior — the handler still returns without processing non-`/ws` requests.

**WS vs WSS**: Internal deployments (192.168.x.x) use `ws://`. Public deployments MUST use `wss://` via reverse proxy (nginx TLS termination) or direct Node.js TLS. The bridge config stores the full URL — server decides protocol.

**Electron WS known issues** (verified via Electron GitHub issues):

| Issue | Workaround |
|-------|-----------|
| WSS + self-signed cert rejected ([#37887](https://github.com/electron/electron/issues/37887)) | Use main process WS (not renderer); or add cert to system trust store |
| WS bypasses proxy settings ([#34810](https://github.com/electron/electron/issues/34810)) | WS from main process; document proxy limitations |
| Windows WS stalling ([#25099](https://github.com/electron/electron/issues/25099)) | Implement connection timeout (10s) + force reconnect |

### 7.2 Messages

**Bridge → Server**:

| Type | When | Payload |
|------|------|---------|
| `register` | After connect | bridgeId, deviceName, userId, projects[], capabilities |
| `result` | After command execution | id, success, stdout, stderr, exitCode, durationMs |
| `diagnose_result` | After diagnose request | opencliVersion, daemonRunning, extensionConnected, availableSites |
| `pong` | Heartbeat response | ts |

**Server → Bridge**:

| Type | When | Payload |
|------|------|---------|
| `paired` | After successful pairing handshake | obkKey (the real `obk_` API key for future connections) |
| `command` | MCP tool dispatched | id, site, action, args[], timeout, env |
| `ping` | Every 30s | ts |
| `config_update` | Admin changes domain config | projectId, enabledDomains, writePermissions. **Broadcast to all connected devices** for same projectId+userId. **Bridge-side handling**: log receipt, update local display (tray tooltip shows enabled domains), but take no execution action — domain filtering is server-side (MCP tool registration). Bridge does not need to cache or enforce domain config. If Bridge cannot parse the message (version mismatch), it logs a warning and ignores. |
| `diagnose` | Admin requests diagnostics | (empty) |
| `device_replaced` | Another device registered same project+user | projectId, replacedBy (deviceName) |
| `device_promoted` | _(Phase 7+ only)_ Previous device disconnected, standby promoted | projectId |

### 7.3 Heartbeat, Reconnection & Robustness

**Heartbeat**:
- Server pings every 30s; bridge responds within 10s
- 3 missed pongs → server marks offline, closes WS, calls `bridgeCommandProxy.rejectAllForBridge()`
- Bridge: if no server message received for 90s, assume connection dead → force close + reconnect

**Reconnection** (connectionManager.ts):

```typescript
class ConnectionManager {
  private backoff = { initial: 1000, max: 60000, current: 1000, factor: 2 };
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionAttempt = 0;
  private maxConsecutiveFailures = 20; // after 20 failures, pause 5 minutes

  async connect(serverConfig: ServerConfig): Promise<void> {
    const ws = new WebSocket(serverConfig.wsUrl, {
      headers: { 'X-Bridge-Key': serverConfig.apiKey, ... },
      handshakeTimeout: 10000, // 10s connection timeout (mitigates Windows stalling bug)
    });

    ws.on('open', () => {
      this.backoff.current = this.backoff.initial; // reset on success
      this.connectionAttempt = 0;
      this.sendRegister(ws, serverConfig);
    });

    ws.on('close', (code, reason) => {
      console.warn(`[WS] Disconnected: ${code} ${reason}. Reconnecting...`);
      this.scheduleReconnect(serverConfig);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error: ${err.message}`);
      // Don't schedule reconnect here — 'close' event follows 'error'
    });
  }

  private scheduleReconnect(config: ServerConfig): void {
    if (this.reconnectTimer) return; // already scheduled

    this.connectionAttempt++;
    if (this.connectionAttempt >= this.maxConsecutiveFailures) {
      console.warn('[WS] Too many failures. Pausing 5 minutes before retry.');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectionAttempt = 0;
        this.connect(config);
      }, 300000);
      return;
    }

    const jitter = Math.random() * 1000; // ±1s jitter to prevent thundering herd
    const delay = Math.min(this.backoff.current + jitter, this.backoff.max);
    this.backoff.current *= this.backoff.factor;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(config);
    }, delay);
  }
}
```

**Robustness guarantees**:

| Scenario | Behavior |
|----------|----------|
| Server restarts | Bridge auto-reconnects via exponential backoff |
| Network blip (<10s) | Heartbeat tolerates; no disconnect triggered |
| Network down (>90s) | Bridge detects silence, force-closes, starts reconnect |
| Bridge process crash | Auto-start on boot restores; OS process manager can supervise |
| Server rejects connection (bad API key) | Bridge gets `close` with code 4001; does NOT reconnect (revoked key) |
| 20 consecutive failures | Pause 5 minutes, then reset counter and retry |
| Windows WS stalling | `handshakeTimeout: 10000` forces close after 10s |
| In-flight commands during disconnect | `rejectAllForBridge()` immediately rejects all pending Promises |
| Resume after reconnect | Re-send `register` with fresh `capabilities.availableSites` |

**Server-side rate limiting** (new, in `opencliWs.ts`):

```typescript
// Per API key: max 10 WS upgrade attempts per minute
const wsRateLimiter = new Map<string, { count: number; resetAt: number }>();
function isRateLimited(apiKey: string): boolean {
  const now = Date.now();
  const entry = wsRateLimiter.get(apiKey);
  if (!entry || now > entry.resetAt) {
    wsRateLimiter.set(apiKey, { count: 1, resetAt: now + 60000 });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}
```

## 8. Frontend Design

### 8.1 Tool Card System (weknora-ui)

6 card types routed by data shape (prefix-based routing in ToolCallRenderer.vue):

> **Note**: Coverage percentages below are theoretical match rates **before priority resolution** (i.e., how many commands would match each card if it were the only card). With priority, actual distribution is mutually exclusive. Percentages sum to >100% due to overlap.

| Card | Trigger | Coverage |
|------|---------|----------|
| OpenCliListCard | Array + has url field | ~29% |
| OpenCliTableCard | Array, no url | ~20% |
| OpenCliContentCard | Has content/text field | ~18% |
| OpenCliStatusCard | Status/message fields | ~35% |
| OpenCliFinanceCard | Stock-quote sites only (xueqiu, yahoo-finance, barchart) | ~5% |
| OpenCliDesktopCard | Site in desktop domain | ~28% |

Priority: Finance > Desktop > List > Content > Table > Status. All extend `BaseToolCard`.

> **FinanceCard scope**: Only 3 of 5 finance sites use the specialized card. Bloomberg (10 commands, article-heavy) and sinafinance (1 command, list format) produce data better suited to ContentCard and ListCard respectively.

```typescript
if (toolName.startsWith('mcp__opencli-')) {
  const site = toolName.split('__')[2];
  const data = parseOpenCliJsonResult(toolCall.result || '');
  if (['xueqiu', 'yahoo-finance', 'barchart'].includes(site)) return OpenCliFinanceCard;
  if (desktopSites.includes(site)) return OpenCliDesktopCard;
  if (data === null) return OpenCliStatusCard;
  if (Array.isArray(data) && data[0]?.url) return OpenCliListCard;
  if (Array.isArray(data)) return OpenCliTableCard;
  if (data?.content || data?.text) return OpenCliContentCard;
  return OpenCliStatusCard;
}
```

### 8.2 Bridge Management Console

Located in project settings page as **"OpenCLI Bridge" tab**.

| Feature | Description |
|---------|-------------|
| Connection Status | Green/red dot, device name, user, uptime, last heartbeat |
| Config String Generator | One-click generate: text + `obk://` link + QR code |
| Domain Configuration | Per-project toggle for 6 domains, pushed to bridge via `config_update` |
| Remote Diagnostics | Trigger `opencli doctor` on bridge, display results |
| Offline Alert | Yellow banner in A2A chat when bridge disconnects |
| Execution History | Table with timestamp, site/action, duration, result |
| Revoke | Kick bridge, revoke API key, force disconnect |

### 8.3 Offline Alert Mechanism

**Level 1 — MCP registration** (`integrateOpenCliMcpServers`):
- Bridge online → register tools normally
- Bridge offline → don't register tools + append systemPrompt hint

**Level 2 — Real-time frontend** (new `broadcastOpenCliBridgeEvent` in websocketService):
- websocketService currently has channel-specific broadcast functions (e.g., `broadcastCronEvent`), not a generic `broadcast()` method. Add new `broadcastOpenCliBridgeEvent()` export following the same pattern.
- Bridge disconnects → `broadcastOpenCliBridgeEvent(projectId, { status: 'offline', userId })`
- weknora-ui receives → shows yellow banner in A2A chat if current user matches
- Banner auto-dismisses on reconnect

**Frontend WS subscription protocol** (follows existing `cron` channel pattern in websocketService.ts):

```typescript
// weknora-ui subscribes when entering A2A chat with opencli-enabled project:
ws.send(JSON.stringify({
  type: 'subscribe',
  channel: 'opencli-bridge',
  projectId: currentProjectId,   // proj_xxx short hash
}));

// Server-side handleClientMessage() adds branch:
} else if (msg.channel === 'opencli-bridge' && typeof msg.projectId === 'string') {
  client.opencliProjectId = msg.projectId;
}

// broadcastOpenCliBridgeEvent() sends to matching clients:
export function broadcastOpenCliBridgeEvent(projectId: string, event: BridgeStatusEvent): void {
  for (const client of clients) {
    if (client.opencliProjectId === projectId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: 'opencli-bridge-event', ...event }));
    }
  }
}
```

### 8.4 Frontend Components

```
weknora-ui/src/
├── components/a2a-tools/tools/
│   ├── OpenCliListCard.vue          # Ranked list + links
│   ├── OpenCliTableCard.vue         # Structured table (TDesign)
│   ├── OpenCliContentCard.vue       # Markdown article
│   ├── OpenCliStatusCard.vue        # Write results
│   ├── OpenCliFinanceCard.vue       # Stock quotes
│   ├── OpenCliDesktopCard.vue       # Terminal-style
│   └── opencli-utils.ts             # parseOpenCliJsonResult
├── components/a2a-tools/
│   ├── ToolCallRenderer.vue         # MODIFIED: add prefix routing
│   ├── BridgeStatusBanner.vue       # NEW: offline alert banner
│   └── types.ts                     # MODIFIED: add icons/colors
├── views/a2a-project/components/
│   └── OpenCliBridgeSettings.vue    # NEW: bridge management tab
├── api/agentstudio/
│   └── opencli-bridge.ts            # NEW: API calls
├── locales/
│   └── {zh-CN,en-US,ru-RU,ko-KR}.ts # MODIFIED: i18n
└── vite.config.ts                   # MODIFIED: add proxy rule
```

**vite.config.ts proxy addition** (must be declared BEFORE the `/api` wildcard):
```typescript
// Add before '/api': { target: 'http://192.168.100.30:8080' }
'/api/opencli': {
  target: 'http://localhost:4936',
  changeOrigin: true,
  ws: true,  // Required for /api/opencli/bridge WebSocket upgrade
},
```

## 9. Implementation Phases

```
Phase 1 (Core Channel)
  ├──→ Phase 2 (Pairing Flow)
  │      ├──→ Phase 4 (Management Console)
  │      │      └──→ Phase 6 (Production Polish)
  │      └──→ Phase 5 (Tool Cards) [parallel with P4]
  └──→ Phase 3 (Permission Engine) [parallel with P2]
```

### Phase 1: Core Channel

**Goal**: End-to-end: A2A chat → MCP tool → WS → bridge → opencli → result → Claude

**Deliverables**:
- Electron app skeleton: tray + single server WS + CommandRunner
- Server: `opencliWs.ts`, `bridgeRegistry.ts`, `bridgeCommandProxy.ts`
- Server: `opencliMcpFactory.ts`, `outputFormatter.ts`, `constants.ts`, `types.ts`
- Modified: `claudeUtils.ts` integration block
- Manual config in Electron (hardcoded URL/key for testing)
  - Phase 1 bypasses pairing: manually generate an `obk_` key via `bridgeKeyService.generateKey(userId)` and hardcode in Electron config. This is replaced by the pairing flow in Phase 2.

**Verification**:
1. Start Electron → connects via WS → registry shows online
2. A2A chat: "HackerNews top" → bridge executes → result renders
3. Kill Electron → next opencli call returns BRIDGE_OFFLINE

**Estimate**: ~1200 lines (Electron ~400, server ~800)

### Phase 2: Pairing Flow

**Goal**: Users add servers via config strings, zero manual config.

**Deliverables**:
- Server: `bridgeKeyService.ts`, `POST /api/opencli/pairing-token`
- Electron: ConfigStore, ProtocolHandler (`obk://`), paste dialog, multi-server ConnectionManager
- weknora-ui: Config string generator in project settings

**Estimate**: ~800 lines

### Phase 3: Permission Engine

**Goal**: Write operations require user confirmation.

**Deliverables**:
- Server: `permissionEngine.ts` (51-command whitelist, read/write/download classification)
- Modified: tool handler adds confirmation step for write ops via askUserSessionRef

**Estimate**: ~400 lines

### Phase 4: Management Console

**Goal**: Full server-side management and monitoring.

**Deliverables**:
- Server: REST API endpoints, `bridgeHistoryStore.ts`
- weknora-ui: `OpenCliBridgeSettings.vue`, `BridgeStatusBanner.vue`, API module
- i18n: 4 languages

**Estimate**: ~1500 lines

### Phase 5: Tool Cards

**Goal**: Rich rendering of opencli results in A2A chat.

**Deliverables**: 6 Vue card components + `opencli-utils.ts` + ToolCallRenderer routing

**Estimate**: ~800 lines

### Phase 6: Production Polish

**Goal**: Distributable to non-technical users.

**Deliverables**:
- electron-updater + GitHub Releases CI
- auto-launch integration
- electron-builder CI for 3 platforms
- Error recovery, installer signing

**Estimate**: ~600 lines + CI config

### Overall Scale

| Phase | Code Lines | Projects |
|-------|------------|----------|
| 1. Core Channel | ~1200 | opencli-bridge + agentstudio |
| 2. Pairing Flow | ~800 | opencli-bridge + agentstudio + weknora-ui |
| 3. Permission Engine | ~400 | agentstudio |
| 4. Management Console | ~1500 | weknora-ui + agentstudio |
| 5. Tool Cards | ~800 | weknora-ui |
| 6. Production Polish | ~600 | opencli-bridge |
| **Phase 1-6 Total** | **~5300** | **3 projects** |
| 7. Unified Client (後續) | ~200 | opencli-bridge + weknora-ui |

### Phase 7: Unified Desktop Client (Post-Phase 6)

**Goal**: Upgrade opencli-bridge from headless bridge to unified desktop client — embed weknora-ui in Electron BrowserWindow.

**Approach**: Remote URL mode — `BrowserWindow.loadURL(serverUrl)`. weknora-ui code unchanged, Electron is pure shell.

```typescript
// main.ts — Phase 7 addition (~200 lines)
function openWeKnoraUI(serverConfig: ServerConfig): void {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  // Load weknora-ui from the AgentStudio server's frontend build
  win.loadURL(serverConfig.wsUrl.replace('/api/opencli/bridge', '').replace('ws', 'http'));
  // Inject auth token from bridge config
}
```

**Tray menu addition**:
```
  ● Company AgentStudio — Connected
    └── Open WeKnora UI          → BrowserWindow
  ○ Test Server — Disconnected
```

**Not included in Phase 7**: Local build bundling (offline mode), native file drag-drop, deep OS integration. These are Phase 8+ if demand justifies.

### Mobile Strategy: PWA (Approved)

weknora-ui already works in mobile browsers. Add PWA support to weknora-ui (~500 lines):
- `manifest.json` with app icons + display: standalone
- Service worker for static asset caching
- "Add to Home Screen" prompt

**Limitation**: opencli commands unavailable on mobile (requires desktop Chrome + Extension). Mobile users access A2A chat + knowledge base management only.

**Not planned**: Capacitor/React Native native app — ROI insufficient given opencli limitation on mobile.

## 10. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| WebSocket disconnects frequently | Medium | Medium | Exponential backoff + jitter; heartbeat 30s; 90s silence detection; 20-failure pause |
| Electron app ~150MB size | Low | Low | Acceptable in 2026 (Slack 300MB+, VS Code 400MB+) |
| Bridge timeout on slow commands | Medium | Medium | Configurable timeout tiers: read 30s, write 60s, download 120s |
| Chrome login session expiration | High | Medium | Bridge diagnose detects; management console shows re-login guidance |
| Too many tools confuses Claude | Medium | High | Site-level composite (max 13 tools/domain); within effective range with action enum |
| Shell injection via tool parameters | Low | Critical | `cross-spawn` with args array; no shell, no string interpolation |
| API key leaked | Low | Medium | **Mitigated by one-time pairing token (§6.1)**: config strings contain `obp_` token (10min TTL, single-use), not the long-lived `obk_` key. Real key only stored in bridge local config. Revocable from console; per-user isolation |
| Chrome extension not installed | High | Medium | Diagnose detects; shows guidance; public commands still work |
| AV false positives on Electron | Medium | Medium | Code signing (Authenticode/notarization); whitelist instructions |
| Platform bot detection on writes | Medium | Medium | User confirmation adds human-in-the-loop delay |
| Desktop app adapters macOS-only | Certain | Medium | Desktop domain (61/293 = 21% commands) degradation on non-macOS; documented. Consider platform detection in bridge capabilities |
| `graphitiContext.user_id` absent | Medium | Medium | Falls back to API key owner userId; systemPrompt hints if both absent |
| `ELECTRON_RUN_AS_NODE` env leak | Medium | Medium | CommandRunner strips Electron-specific env vars before spawning opencli |
| WS endpoint DoS via reconnect flood | Low | Medium | Rate limiting: max 10 WS upgrades per API key per minute |
| Pending commands on WS disconnect | Medium | Medium | `bridgeCommandProxy.rejectAllForBridge()` immediately rejects pending Promises |
| **Linux tray invisible** | **High** | **High** | **GNOME 3.26+ removed tray. Phase 1: tray detection + fallback mini-window + console output. See §5.3** |
| **Electron WS + corporate proxy** | **Medium** | **High** | **WS in main process (not renderer); document proxy limitations; consider HTTP long-polling fallback in future** |
| **Electron WS + self-signed cert** | **Medium** | **Medium** | **Public deploy: use proper TLS cert via Let's Encrypt. Internal: document cert trust setup** |
| **Windows WS connection stalling** | **Low** | **Medium** | **`handshakeTimeout: 10000` forces close after 10s; auto-reconnect** |
| **Linux `obk://` protocol unreliable** | **Medium** | **Low** | **Paste config string is primary path; `obk://` is best-effort on Linux. See §6.1** |
| **Uninstall leaves orphan files** | **Medium** | **Low** | **`uninstaller.ts` removes autostart, protocol reg, native messaging host. See §5.4** |

## 11. Testing Strategy

| Phase | Test Scope | Examples |
|-------|-----------|----------|
| 1. Core Channel | Unit: bridgeRegistry, bridgeCommandProxy, outputFormatter, MCP tool generation | Register/unregister bridge; dispatch+timeout; format JSON→Markdown |
| 2. Pairing | Unit: config string parse/validate; pairing token lifecycle; Integration: pairing API → token exchange → obk_ key issuance round-trip | Decode obk://; token expiry after 10min; token single-use rejection; merge project; WS connect with obp_ → receive obk_ → reconnect with obk_ |
| 3. Permission | Unit: classify all 293 commands; write confirmation flow | Assert 75 write, 214 read, 4 download |
| 4. Management | Component: settings tab; API route tests | Domain toggle → bridge receives config_update |
| 5. Tool Cards | Component: render with mock data; routing logic | OpenCliListCard with bilibili data; finance card with xueqiu |
| 6. Polish | E2E: install → pair → execute → update | Full lifecycle on Windows/macOS/Linux |

## 12. Future Considerations (Not In Scope)

- **Scheduled monitoring**: Periodic opencli commands for stock alerts, news digests
- **Multi-device per user**: Phase 1-6 uses device takeover (last-wins, no standby fallback — see §4.2). Phase 7+: add standby fallback (`standbyEntries` Map, auto-promote on disconnect). Beyond that: multi-device co-existence with intelligent routing — route to most recently active device, or by capability match (e.g., device A has Chrome logged into Twitter, device B has Bilibili). Requires `Map<RegistryKey, BridgeEntry[]>` promotion to primary data structure, round-robin or affinity-based dispatcher, and management console showing all connected devices per user.
- **Shared bridge mode**: One bridge serves multiple users (shared kiosk)
- **Bridge-side caching**: Cache frequently queried results with TTL
- **opencli adapter authoring**: Using AgentStudio to create new opencli adapters
- **Unified client offline mode** (Phase 8+): Bundle weknora-ui local build in Electron for offline access
- **CLI-Anything integration**: Reuse Bridge channel for local desktop software CLIs (GIMP, Blender, LibreOffice). See separate RFC: [`2026-03-22-cli-anything-bridge-rfc.md`](2026-03-22-cli-anything-bridge-rfc.md). Status: RFC/Exploration — core value chain (file artifact return) unresolved.
