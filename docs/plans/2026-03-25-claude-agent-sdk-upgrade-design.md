# Claude Agent SDK 0.2.84 Upgrade Design

> Date: 2026-03-25 (updated 2026-03-26)
> Status: Draft (Rev 6 - Sandbox Split Out)
> Scope: agentstudio (backend) + weknora-ui (PC + Mobile)
> Review: Architecture + Frontend + Security + A2A Impact + Divergence Audit + 0.2.84 Delta + Sandbox Design + Scope Split (8-dimensional)

## Background

AgentStudio backend uses `@anthropic-ai/claude-agent-sdk@^0.2.84` (latest). SDK has added several new capabilities that the project hasn't adopted yet. This document is based on **code-level verification** of both the SDK official docs (platform.claude.com) and the project codebase.

## SDK Version Status

- **Current**: `^0.2.84` in `backend/package.json`
- **SDK Docs**: https://platform.claude.com/docs/en/agent-sdk/typescript
- **Options type verified**: All fields in Phase 1-3 confirmed in official SDK TypeScript reference
- **Changelog source**: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md

### 0.2.83 → 0.2.84 Delta

| Version | Change | Impact |
|---------|--------|--------|
| 0.2.83 | `seed_read_state` control subtype for Edit after Read snipped | SDK internal, auto-handled |
| 0.2.83 | `session_state_changed` events opt-in (env var) | No action needed |
| 0.2.84 | **`taskBudget`** — API-side token budget awareness (@alpha) | **New Phase 1.4** |
| 0.2.84 | Exported `EffortLevel` type | **New Phase 1.5** |
| 0.2.84 | `enableChannel()` + MCP capabilities | Internal CLI, no public API |
| 0.2.84 | Fix: "[Request interrupted by user]" false positive | Auto-fixed on upgrade |

---

## Phase 1: Low-Risk Config Upgrades

### 1.1 Adaptive Thinking

**Current**: `claudeUtils.ts:384-404` buildQueryOptions does NOT set any thinking config.

**Change**: Add `thinking: { type: 'adaptive' }` to queryOptions.

**File**: `backend/src/utils/claudeUtils.ts`

```typescript
// In buildQueryOptions(), add to queryOptions:
thinking: { type: 'adaptive' },
```

**Why**: SDK deprecated `maxThinkingTokens`. `adaptive` lets Claude decide when and how much to reason (Opus 4.6+). Cursor engine's AGUI adapter (`engines/cursor/a2aAdapter.ts:417-444`) already handles thinking blocks for Cursor path; Claude SDK path auto-forwards thinking via `...sdkMessage` spread.

**Cost Impact**: Adaptive thinking generates additional thinking tokens (~10-30% overhead for complex tasks). These count toward `maxBudgetUsd` if configured. Monitor actual spend in production.

**Risk**: Minimal. Backward compatible. Token cost increase is the only consideration.

---

### 1.2 Fallback Model

**Current**: `claudeUtils.ts:296-363` model resolution falls back to hardcoded `'sonnet'`.

**Change**: Add `fallbackModel` to queryOptions.

**File**: `backend/src/utils/claudeUtils.ts`

```typescript
// In buildQueryOptions(), add to queryOptions:
fallbackModel: 'haiku',
```

**Why**: SDK-level fallback is more robust than hardcoded default. If primary model fails (rate limit, unavailable), SDK auto-retries with fallback.

**Silent Degradation Risk** (from security review):
- Haiku capability is significantly lower than Opus/Sonnet
- Users won't know model was downgraded unless we tell them
- Different users hitting same Agent may get inconsistent quality

**Mitigation Required**:
1. Check SDK `result` event's `modelUsage` field — if actual model differs from requested, emit warning
2. Frontend should display model fallback warning in chat (yellow banner)
3. Consider per-agent `allowModelFallback: boolean` config (default true)

**A2A Backend Change Required** (from A2A impact analysis):

The A2A SSE callback in `routes/a2a.ts` processes result events at two locations:
- **One-shot mode**: ~line 934-946
- **Reuse mode**: ~line 1405-1420

Both need model fallback detection added:

```typescript
// In result event handling (both one-shot and reuse mode):
if (isSDKResultMessage(sdkMessage)) {
  const resultMsg = sdkMessage as SDKResultMessage
  // Check if model was downgraded
  if (resultMsg.modelUsage) {
    const requestedModel = queryOptions.model  // e.g. 'sonnet', 'opus', 'claude-sonnet-4-6'
    const usedModels = Object.keys(resultMsg.modelUsage)  // e.g. ['claude-sonnet-4-6']
    const primaryUsed = usedModels[0]
    // Normalize comparison: SDK modelUsage keys are full model IDs (e.g. 'claude-sonnet-4-6'),
    // while queryOptions.model may be short name (e.g. 'sonnet') or full ID.
    // Use bidirectional includes to handle both cases.
    const isMatch = primaryUsed && requestedModel && (
      primaryUsed.includes(requestedModel) || requestedModel.includes(primaryUsed)
    )
    if (primaryUsed && requestedModel && !isMatch) {
      connMgr.safeWrite(`data: ${JSON.stringify({
        type: 'model_fallback_warning',
        requestedModel,
        actualModel: primaryUsed,
        sessionId: effectiveSessionId,
      })}\n\n`)
    }
  }
}
```

Frontend (`weknora-ui/src/api/a2a/stream.ts`) needs to handle this new event:
```typescript
case 'model_fallback_warning':
  // Store warning for UI display
  if (currentMessage.value) {
    currentMessage.value.modelFallback = {
      requested: event.requestedModel,
      actual: event.actualModel
    }
  }
  break
```

Frontend type (`types.ts` A2AChatMessage) needs:
```typescript
modelFallback?: { requested: string; actual: string };
```

Frontend rendering (PC + Mobile) — yellow warning banner:
```html
<div v-if="msg.modelFallback" class="tm-model-fallback-warning">
  Model degraded: {{ msg.modelFallback.actual }} (requested: {{ msg.modelFallback.requested }})
</div>
```

**Risk**: Low for SDK integration. Medium for UX if silent degradation is not surfaced.

---

### 1.3 1M Context Beta (Per-Agent, Not Global)

**Current**: No `betas` config.

**Change**: Enable 1M context **per-agent** for Sonnet 4.5/4 (Opus 4.6 and Sonnet 4.6 already have 1M natively).

**Files**:
- `backend/src/types/agents.ts` - Add `enableLargeContext?: boolean` to AgentConfig
- `backend/src/utils/claudeUtils.ts` - Conditionally add betas

```typescript
// types/agents.ts - AgentConfig:
enableLargeContext?: boolean;  // Default: false

// claudeUtils.ts - buildQueryOptions():
if (agent.enableLargeContext) {
  queryOptions.betas = ['context-1m-2025-08-07']
}
```

**Why NOT global** (from security review):
- 1M context consumes ~100MB memory per active session
- In A2A multi-user: N concurrent users x 100MB = significant memory pressure
- Cost increase ~10-20% for longer context processing
- Most chat tasks don't need 1M; only large document analysis benefits

**Risk**: None if per-agent. Medium if global (memory + cost).

---

### 1.4 Task Budget (Per-Agent Token Limit) — NEW in 0.2.84

**Current**: No token-level budget control. Only `maxBudgetUsd` (USD-based, in SDK) and `effort` (hints to model).

**SDK type** (`sdk.d.ts:1052-1060`):
```typescript
/**
 * API-side task budget in tokens. When set, the model is made aware of
 * its remaining token budget so it can pace tool use and wrap up before
 * the limit. Sent as `output_config.task_budget` with the
 * `task-budgets-2026-03-13` beta header.
 * @alpha
 */
taskBudget?: {
    total: number;
};
```

**Change**: Enable per-agent token budget. SDK automatically injects the required beta header.

**Files**:
- `backend/src/types/agents.ts` — Add `taskBudgetTokens?: number` to AgentConfig (after `maxTurns`)
- `frontend/src/types/agents.ts` — Sync `taskBudgetTokens?: number` to frontend AgentConfig (after `maxTurns`)
- `backend/src/utils/claudeUtils.ts` — Pass to queryOptions + extend `BuildQueryExtendedOptions`
- `backend/src/schemas/a2a.ts` — Add to A2A request schema (optional per-request override)

```typescript
// types/agents.ts - AgentConfig (BOTH backend + frontend):
maxTurns?: number;
taskBudgetTokens?: number;  // Optional per-agent token budget (@alpha, SDK auto-injects beta header)

// claudeUtils.ts - BuildQueryExtendedOptions (line 240-244):
export interface BuildQueryExtendedOptions {
  weknoraContext?: WeknoraContext;
  graphitiContext?: GraphitiContext;
  effort?: EffortLevel;
  opencliContext?: OpenCliContext;
  taskBudgetTokens?: number;  // A2A per-request override
}

// claudeUtils.ts - buildQueryOptions() (after effort injection, ~line 399):
...(extendedOptions?.effort && { effort: extendedOptions.effort }),
// Token budget: per-request override > agent config
...((extendedOptions?.taskBudgetTokens || agent.taskBudgetTokens) && {
  taskBudget: { total: extendedOptions?.taskBudgetTokens || agent.taskBudgetTokens }
}),

// schemas/a2a.ts - A2A request can override per-request (after effort field):
effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
taskBudgetTokens: z.number().int().positive().max(1000000).optional(),

// a2a.ts - request destructuring (~line 520):
const { ..., effort, taskBudgetTokens } = validation.data;
// a2a.ts - extendedOptions construction (~line 803-810):
...(taskBudgetTokens ? { taskBudgetTokens } : {}),
```

**Dual-source design**: Agent config provides default budget; A2A request can override per-request. Priority: `request override > agent config > no budget`.

**Why per-agent, not global**:
- Different agents have vastly different token needs (KB search: ~10k, code analysis: ~100k)
- Cron tasks benefit most — prevents runaway jobs from burning tokens
- A2A requests can override per-request for flexibility

**Use Cases**:

| Scenario | Suggested Budget | Why |
|----------|-----------------|-----|
| Cron scheduled tasks | 50,000 tokens | Prevent runaway, auto-wrap-up |
| Quick KB search agent | 20,000 tokens | Simple Q&A shouldn't burn more |
| Code analysis agent | 200,000 tokens | Complex tasks need room |
| No budget set | unlimited | Default, backward compatible |

**⚠️ Alpha Status**: Marked `@alpha` in SDK. API may change. Recommended to use in Cron tasks first, expand to A2A after stabilization.

**Risk**: Low. Optional field. Alpha status means potential API churn but no breakage (field simply gets ignored if beta header is removed server-side).

---

### 1.5 EffortLevel Type Import — NEW in 0.2.84

**Current**: Effort type is hardcoded in 3 places:

| File | Line | Current |
|------|------|---------|
| `claudeUtils.ts` | 243 | `effort?: 'low' \| 'medium' \| 'high' \| 'max'` |
| `schemas/a2a.ts` | 39 | `z.enum(['low', 'medium', 'high', 'max'])` |
| SDK Options | — | `effort?: EffortLevel` |

**Change**: Import `EffortLevel` from SDK for TypeScript type consistency.

**File**: `backend/src/utils/claudeUtils.ts`

```typescript
// Import:
import type { Options, EffortLevel } from '@anthropic-ai/claude-agent-sdk';

// ExtendedQueryOptions (line 243):
effort?: EffortLevel;  // Was: 'low' | 'medium' | 'high' | 'max'
```

**Note**: Zod schema (`schemas/a2a.ts:39`) stays as `z.enum(...)` — Zod is runtime validation, cannot use TS types. This is correct and intentional.

**Risk**: Zero. Pure type-level change, no runtime impact.

---

## Phase 2: Structured Output (High Value)

### 2.1 Backend: Agent Config + Query Options + Schema Validation

**Current**: `claudeUtils.ts:buildQueryOptions` does NOT set `outputFormat`.

**Files**:
- `backend/src/types/agents.ts` - Add field to AgentConfig
- `backend/src/utils/claudeUtils.ts` - Pass to queryOptions with validation

```typescript
// types/agents.ts - AgentConfig:
outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
```

**Schema Validation** (from security review — MANDATORY):

User-configurable Agent schemas must be validated before passing to SDK:

```typescript
// claudeUtils.ts - buildQueryOptions():
if (agent.outputFormat) {
  validateOutputSchema(agent.outputFormat.schema)  // throws on invalid
  queryOptions.outputFormat = agent.outputFormat
}

// New validation function:
function validateOutputSchema(schema: Record<string, unknown>): void {
  const serialized = JSON.stringify(schema)
  // 1. Size limit: prevent token explosion
  if (serialized.length > 5000) {
    throw new Error('Output schema exceeds 5KB limit')
  }
  // 2. Depth limit: prevent recursion attacks
  if (calculateSchemaDepth(schema) > 10) {
    throw new Error('Output schema depth exceeds 10 levels')
  }
  // 3. Sensitive field names: prevent data exfiltration prompting
  const sensitiveNames = ['password', 'api_key', 'secret', 'token', 'private_key', 'credential']
  const lower = serialized.toLowerCase()
  for (const name of sensitiveNames) {
    if (lower.includes(`"${name}"`)) {
      throw new Error(`Output schema contains sensitive field name: ${name}`)
    }
  }
}

function calculateSchemaDepth(obj: unknown, depth = 0): number {
  if (depth > 10) return depth
  if (typeof obj !== 'object' || obj === null) return depth
  let maxDepth = depth
  for (const val of Object.values(obj)) {
    maxDepth = Math.max(maxDepth, calculateSchemaDepth(val, depth + 1))
  }
  return maxDepth
}
```

### 2.2 Frontend: Extract structured_output from result event

**Current**: `stream.ts:340-369` result handler extracts usage/error but NOT `structured_output`.

**Files**:
- `weknora-ui/src/api/a2a/types.ts:128-158` - Add field to A2AChatMessage
- `weknora-ui/src/api/a2a/stream.ts:340-369` - Extract field from result event

**Step 1** — types.ts (after line 157 `promptSuggestion?: string;`):
```typescript
/** Structured output from result event (when agent has outputFormat configured) */
structuredOutput?: unknown;
```

**Step 2** — stream.ts (in result event handler, after usage extraction ~line 356, before subtype error check ~line 357):
```typescript
// Extract structured output from result event
if (event.structured_output) {
  currentMessage.value.structuredOutput = event.structured_output
}
```

### 2.3 Frontend: Render structured output

**PC** (`views/a2a-chat/index.vue`):
```html
<!-- After tm-actions (line ~530), before tm-footer (line ~533) -->
<details v-if="msg.structuredOutput && !msg.isStreaming" class="tm-structured-output">
  <summary>Structured Output</summary>
  <pre class="tm-json">{{ JSON.stringify(msg.structuredOutput, null, 2) }}</pre>
</details>
```

**Mobile** (`MobileTerminalMessage.vue`) — with touch-friendly sizing (from frontend review):
```html
<details v-if="message.structuredOutput && !isStreaming" class="tm-structured-output">
  <summary class="tm-structured-output-summary">Structured Output</summary>
  <div class="tm-structured-output-content">
    <pre>{{ JSON.stringify(message.structuredOutput, null, 2) }}</pre>
  </div>
</details>
```

**Mobile CSS** (from frontend review):
```less
.tm-structured-output-summary {
  padding: 8px;
  min-height: 44px;  // iOS touch target standard
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 12px;
  color: var(--td-text-color-secondary);
}

.tm-structured-output-content {
  max-height: 300px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 8px;

  pre {
    font-size: 12px;
    white-space: pre-wrap;    // Prevent horizontal overflow
    word-break: break-word;
  }
}
```

### 2.4 Use Cases

| Scenario | Schema Example | Benefit |
|----------|---------------|---------|
| Cron task results | `{ status, summary, metrics }` | Guaranteed parseable |
| KB overview tool | `{ health, doc_count, issues[] }` | Dashboard-ready data |
| Code analysis | `{ files[], complexity, suggestions[] }` | Structured report |

**Risk**: Low. `outputFormat` is optional per-agent config. Agents without it work unchanged. Schema validation prevents injection attacks.

**⚠ Standard Agent Chat Chain** (from divergence audit):

The A2A route (`routes/a2a.ts`) auto-forwards `structured_output` via `...sdkMessage` spread. However, the standard Agent Chat route (`routes/agents.ts:1061-1077`) uses `as any` type assertion and **extracts fields manually** — `structured_output` is NOT auto-forwarded there. If structured output is needed in standard Agent Chat (non-A2A), add extraction:

```typescript
// routes/agents.ts - in result event handler (~line 1061-1077):
if (isSDKResultMessage(sdkMessage)) {
  const resultMsg = sdkMessage as any;
  // ... existing error handling ...
  // Extract structured output for standard chat
  if (resultMsg.structured_output) {
    // Forward to frontend via SSE
    res.write(`data: ${JSON.stringify({
      type: 'structured_output',
      data: resultMsg.structured_output,
      sessionId: actualSessionId,
    })}\n\n`);
  }
}
```

**Scope note**: This only matters if standard Agent Chat (non-A2A) agents use `outputFormat`. Currently all production chat goes through A2A, so this is **low priority** but documented for completeness.

---

## Phase 3: SystemInfo Type Alignment

### 3.1 Extend A2ASystemInfo

**Current**: `types.ts:189-196` has 6 fields.

**SDK SDKSystemMessage** has additional: `permissionMode`, `agents`, `plugins`, `apiKeySource`, `slash_commands`, `output_style`.

**File**: `weknora-ui/src/api/a2a/types.ts`

```typescript
export interface A2ASystemInfo {
  model: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  version: string;
  skills: string[];
  cwd?: string;
  // New fields from SDK 0.2.83
  permissionMode?: string;
  agents?: string[];
  plugins?: { name: string; path: string }[];
}
```

### 3.2 Update stream.ts init handler

**Current code** (`stream.ts:425-434`) hardcodes 6 fields in object literal. New fields must be explicitly extracted.

**File**: `weknora-ui/src/api/a2a/stream.ts:425-434`

```typescript
// Replace the system.init handler object literal:
if (event.subtype === 'init') {
  currentMessage.value.systemInfo = {
    model: event.model || '',
    tools: event.tools || [],
    mcpServers: event.mcp_servers || [],
    version: event.claude_code_version || '',
    skills: event.skills || [],
    cwd: event.cwd || '',
    // New fields from SDK 0.2.83
    permissionMode: event.permissionMode,
    agents: event.agents || [],
    plugins: event.plugins || []
  }
}
```

### 3.3 Render in system details

**PC** (`a2a-chat/index.vue:533-544`): Add agents list to the expandable details (in `system-init-details` div after skills row).

**Mobile**: Footer already reads from systemInfo, auto-inherits new fields.

**Risk**: None. All new fields are optional.

---

## Phase 4: Sandbox (Split to Separate Document)

> Sandbox has been extracted to an independent security architecture document per review recommendation.
> See: [`2026-03-26-sandbox-security-design.md`](./2026-03-26-sandbox-security-design.md)
>
> **Reason**: Sandbox involves SDK config + storage model + API + UI + deployment validation — too cross-cutting for a sub-phase of SDK upgrade. Treated as independent security project with dedicated validation gates.

---

## Phase 5: Long-Term (Record Only)

These are recorded for future reference. Do NOT implement now.

### 5.1 Priority Table

| Feature | SDK API | When to Implement | Effort | Notes |
|---------|---------|-------------------|--------|-------|
| V2 Session API | `unstable_v2_createSession/resumeSession` | After SDK removes `unstable_` prefix | **High** | See Migration Note below |
| Session Fork | `forkSession: true` | When Cron needs branching | Low | |
| SDK History API | `listSessions() / getSessionMessages()` | When history service is refactored | High | Replaces a2aHistoryService |
| Programmatic Subagents | `options.agents = { ... }` | When lightweight subagent tasks are needed | Medium | |
| Plugins | `plugins: [{ type: 'local', path }]` | When plugin system is needed | Medium | |
| Dynamic MCP | `query.setMcpServers() / toggleMcpServer()` | When runtime MCP management is needed | Low | |
| File Checkpointing | `enableFileCheckpointing + rewindFiles()` | When undo/rewind feature is needed | Medium | |
| Session State Events | `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` | When real-time agent state display is needed | Low | 0.2.83: opt-in via env var. States: idle/running/requires_action |
| Seed Read State | `query.seedReadState(path, mtime)` | SDK auto-handles; manual use if custom compaction | Low | 0.2.83: fixes Edit after Read snipped by compaction |
| Tools Allowlist | `tools: ['Bash', 'Read'] \| { type: 'preset', preset: 'claude_code' }` | When per-agent tool restrictions are needed | Low | Available since 0.2.78 |

### 5.2 V2 Session API Migration Note (from architecture review)

ClaudeSession (`claudeSession.ts`, ~450 lines) has 5 custom patterns that V2 API cannot trivially replace:

| Custom Pattern | Location | V2 Equivalent | Migration Effort |
|---------------|----------|---------------|-----------------|
| MessageQueue streaming input | lines 132-193 | `session.send()` | Medium — different lifecycle |
| Callback routing + request IDs | lines 270-293 | Unknown | High — V2 may not support |
| Orphan message handler (Cron) | lines 375-381 | Unknown | High — unique to our design |
| Concurrent request prevention | lines 210-215 | Unknown | Medium |
| Resume via queryOptions | line 147 | `resumeSession()` | Low — API change |

**Realistic effort**: HIGH (200+ lines rewrite), not a simple class replacement. Wait for V2 stable AND thoroughly review V2 API before planning migration.

---

## Implementation Plan

### A2A Impact Summary (from A2A impact analysis)

| Upgrade Point | A2A Code Change Required? | Affected Files | Reason |
|---------------|--------------------------|----------------|--------|
| 1.1 thinking | No | — | SDK messages auto-forwarded via `...sdkMessage` spread |
| 1.2 fallbackModel | **Yes** | `routes/a2a.ts` (2 locations) | Need model fallback detection in result event |
| 1.3 betas | No | — | Config in `buildQueryOptions`, A2A inherits automatically |
| 1.4 taskBudget | No | — | Config in `buildQueryOptions`, A2A + Cron inherit via same call. A2A schema needs optional `taskBudget` field for per-request override |
| 1.5 EffortLevel | No | — | Pure type-level change, no runtime impact |
| 2.1 outputFormat | No (A2A auto-forwards via spread) | — | `structured_output` included in SDK result message, auto-forwarded via `...sdkMessage`. **Note**: Standard Agent Chat (`routes/agents.ts`) extracts fields manually — needs explicit addition if structured output is needed there (see Phase 2 scope note) |
| 3.1 SystemInfo | No (backend auto-forwards) | — | New fields included via `...sdkMessage` spread |
| **4.x Sandbox** | **Split out** | `2026-03-26-sandbox-security-design.md` | Independent security project — see separate document |
| Cron tasks | No | — | `taskWorker.ts` calls same `buildQueryOptions`, inherits all upgrades. **taskBudget is highest value for Cron** |

**Key finding**: A2A's 16+ service files (`a2aHistoryService`, `a2aQueryService`, `a2aStreamEvents`, `a2aSdkMcp`, `a2aCronService`, `a2aCronStorage`, `loopStorageService`, etc.) are **zero impact**. Only `routes/a2a.ts` needs a small change for model fallback detection.

### Execution Order

| Step | Phase | Files | Effort |
|------|-------|-------|--------|
| 1 | 1.1 thinking | claudeUtils.ts | 5 min |
| 2 | 1.5 EffortLevel type import | claudeUtils.ts | 2 min |
| 3 | 1.2 fallbackModel + A2A detection | claudeUtils.ts + routes/a2a.ts (2 locations) | 20 min |
| 4 | 1.2 Frontend fallback warning | types.ts + stream.ts + a2a-chat + MobileTerminalMessage | 30 min |
| 5 | 1.3 betas per-agent | types/agents.ts + claudeUtils.ts | 15 min |
| 6 | 1.4 taskBudget per-agent | types/agents.ts + claudeUtils.ts + schemas/a2a.ts | 20 min |
| 7 | 2.1 outputFormat + schema validation | types/agents.ts + claudeUtils.ts | 1 hr |
| 8 | 2.2 Frontend extract structured_output | types.ts + stream.ts | 30 min |
| 9 | 2.3 Frontend render structured output | a2a-chat + MobileTerminalMessage + styles | 1 hr |
| 10 | 3.1-3.3 SystemInfo alignment | types.ts + stream.ts + a2a-chat | 30 min |

> **Sandbox** (Phase 4): See separate `2026-03-26-sandbox-security-design.md` for its own execution plan (6 steps).

### Total Estimated Changes

- **Backend**: 4 files (`claudeUtils.ts`, `types/agents.ts`, `routes/a2a.ts`, `schemas/a2a.ts`)
- **Frontend (weknora-ui)**: 5 files (`types.ts`, `stream.ts`, `a2a-chat/index.vue`, `MobileTerminalMessage.vue`, styles)
- **Frontend (agentstudio)**: 1 file (`types/agents.ts` — sync `taskBudgetTokens`)
- **Total**: ~10 files

### Verification Checklist

- [ ] `pnpm run type-check` passes (backend)
- [ ] `pnpm run type-check` passes (frontend)
- [ ] `pnpm run build` passes (frontend)
- [ ] Existing A2A chat still works (no regression)
- [ ] A2A one-shot mode: result event includes structured_output when configured
- [ ] A2A reuse mode: result event includes structured_output when configured
- [ ] Model fallback: A2A SSE emits `model_fallback_warning` when model degrades
- [ ] Frontend: yellow banner shown on model fallback
- [ ] Structured output renders when agent has outputFormat configured
- [ ] Schema validation rejects: >5KB, >10 depth, sensitive field names
- [ ] SystemInfo shows new fields in PC details panel
- [ ] Mobile structured output has 44px touch target + pre-wrap
- [ ] Cron task execution inherits thinking/fallbackModel/taskBudget (verify via logs)
- [ ] Model fallback detection: bidirectional name matching handles both short ('sonnet') and full ('claude-sonnet-4-6') model IDs
- [ ] Standard Agent Chat (`routes/agents.ts`): structured_output forwarded if outputFormat is used (low priority, A2A is primary path)
- [ ] taskBudget: Cron agent with `taskBudgetTokens: 50000` wraps up before limit
- [ ] taskBudget: A2A request with `taskBudgetTokens` field overrides agent default
- [ ] taskBudget: frontend `types/agents.ts` synced with backend (taskBudgetTokens field)
- [ ] taskBudget: BuildQueryExtendedOptions includes taskBudgetTokens for A2A override path
- [ ] EffortLevel import compiles without error (`import type { EffortLevel }` from SDK)

> **Sandbox verification items**: See `2026-03-26-sandbox-security-design.md` verification checklist.

---

## Review History

| Date | Reviewer | Dimension | Key Findings |
|------|----------|-----------|-------------|
| 2026-03-26 | Architecture Agent | Compatibility | Phase 4 V2 migration underestimated; ClaudeSession has 5 unmappable patterns |
| 2026-03-26 | Frontend Agent | Rendering | stream.ts init handler hardcodes fields; mobile `<details>` needs touch-friendly sizing |
| 2026-03-26 | Security Agent | Safety | Schema injection risk (RISK); Sandbox should be elevated priority (RISK); fallback model silent degradation (WARN) |
| 2026-03-26 | A2A Impact Agent | A2A chain | 14 A2A service files zero impact; only routes/a2a.ts needs model fallback detection at 2 locations; Cron auto-inherits |
| 2026-03-26 | Divergence Audit (4-Agent) | Full chain | aguiAdapter line 250-260→417-444; fallback model name matching needs normalization; routes/agents.ts manual extraction misses structured_output; A2A services 16+ not 14; reuse mode line 1416→1420 |
| 2026-03-26 | SDK 0.2.84 Delta Analysis | Version upgrade | taskBudget (@alpha) high-value for Cron; EffortLevel export enables type cleanup; seed_read_state auto-handled; enableChannel no public API |
| 2026-03-26 | 0.2.84 Audit (2-Agent) | taskBudget + EffortLevel | EffortLevel 5/5 pass; taskBudget found 2 gaps: BuildQueryExtendedOptions needs extension, frontend agents.ts needs sync |
| 2026-03-26 | Sandbox Promotion | Security architecture | Promoted from Phase 4 Long-Term to active Phase 4; full implementation plan with filesystem + network isolation, system prompt simplification, platform guards |
| 2026-03-26 | Sandbox A2A Impact | Session chain | Agent found 3 "CRITICAL" issues → corrected to 0: Node.js backend ops (history/agentStorage/watcher) not sandboxed; SDK default rules allow ~/.claude/; only MCP stdio inheritance needs post-deploy verify |
| 2026-03-26 | Sandbox Control Design | Granularity | Rewritten: project=global switch (all users), user=individual switch (only that user), OR logic; tool restriction details + whitelist config; UI wireframe with project toggle + per-user table |
| 2026-03-26 | Sandbox Storage Design | Code-fact based | Storage based on actual code: ProjectMetadata.sandbox (typed field, not metadata bag), ProjectUserMapping.userSandboxConfig; system prompt kept for non-sandboxed users; sandboxEnabled returned to a2a.ts for prompt selection |
| 2026-03-26 | Scope Split | Track separation | Phase 4 Sandbox extracted to `2026-03-26-sandbox-security-design.md`; SDK upgrade doc now covers Phase 1-3 only (10 steps, 10 files) |

---

## References

- SDK TypeScript Docs: https://platform.claude.com/docs/en/agent-sdk/typescript
- SDK V2 Preview: https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview
- SDK Structured Outputs: https://platform.claude.com/docs/en/agent-sdk/structured-outputs
- SDK Sessions: https://platform.claude.com/docs/en/agent-sdk/sessions
- SDK Changelog: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
- Sandbox Design: [`2026-03-26-sandbox-security-design.md`](./2026-03-26-sandbox-security-design.md)
