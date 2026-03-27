# SDK 0.2.84 Upgrade Implementation Plan

> Design: `docs/plans/2026-03-25-claude-agent-sdk-upgrade-design.md` (Rev 6)
> Track: A — SDK Upgrade Adoption (Phase 1-3)
> Track B (Sandbox): See `docs/plans/2026-03-26-sandbox-security-design.md`

---

## Stage 1: SDK Config Injection (Backend Only)

**Goal**: Add thinking, EffortLevel, fallbackModel, betas, taskBudget to `buildQueryOptions`

**Success Criteria**:
- `pnpm run type-check` passes (backend)
- All 5 config items present in queryOptions when conditions met
- Existing A2A chat works without regression

**Files**:
- `backend/src/utils/claudeUtils.ts` — 5 changes (thinking, EffortLevel import, fallbackModel, betas, taskBudget)
- `backend/src/types/agents.ts` — add `enableLargeContext`, `taskBudgetTokens`, `outputFormat` fields
- `backend/src/schemas/a2a.ts` — add `taskBudgetTokens` to Zod schema
- `backend/src/routes/a2a.ts` — destructure `taskBudgetTokens`, pass to extendedOptions

**Tests**:
- `cd backend && npx vitest run src/services/a2a/__tests__/buildQueryOptionsIntegration.test.ts`
- Manual: send A2A message, verify no regression in response

**Steps**:
1. `claudeUtils.ts:8` — change import to `import { Options, EffortLevel } from '@anthropic-ai/claude-agent-sdk'`
2. `claudeUtils.ts:243` — change `effort?: 'low' | 'medium' | 'high' | 'max'` to `effort?: EffortLevel`
3. `claudeUtils.ts:240-244` — add `taskBudgetTokens?: number` to `BuildQueryExtendedOptions`
4. `claudeUtils.ts:~399` — add to queryOptions object:
   ```typescript
   thinking: { type: 'adaptive' },
   fallbackModel: 'haiku',
   ```
5. `claudeUtils.ts:~401` — after effort injection, add:
   ```typescript
   ...((extendedOptions?.taskBudgetTokens || agent.taskBudgetTokens) && {
     taskBudget: { total: extendedOptions?.taskBudgetTokens || agent.taskBudgetTokens }
   }),
   ```
6. `claudeUtils.ts:~405` — after queryOptions construction, add:
   ```typescript
   if (agent.enableLargeContext) {
     queryOptions.betas = ['context-1m-2025-08-07'];
   }
   ```
7. `types/agents.ts` — add 3 optional fields to AgentConfig
8. `schemas/a2a.ts:~40` — add `taskBudgetTokens: z.number().int().positive().max(1000000).optional()`
9. `routes/a2a.ts:~520` — add `taskBudgetTokens` to destructuring
10. `routes/a2a.ts:~807` — add `...(taskBudgetTokens ? { taskBudgetTokens } : {})` to extendedOptions

**Status**: Complete

---

## Stage 2: Fallback Model Detection (Backend A2A)

**Goal**: Detect model fallback in result events and emit SSE warning

**Success Criteria**:
- A2A one-shot mode: result event checked for model downgrade
- A2A reuse mode: same check at second location
- SSE `model_fallback_warning` emitted when model differs

**Files**:
- `backend/src/routes/a2a.ts` — 2 locations (~line 934 and ~line 1405)

**Tests**:
- Manual: force fallback by using unavailable model, verify SSE event

**Steps**:
1. `a2a.ts:~934-946` (one-shot result handler) — add fallback detection block after `isSDKResultMessage` check
2. `a2a.ts:~1405-1420` (reuse result handler) — add same block
3. Both use bidirectional `includes` for model name normalization

**Status**: Complete

---

## Stage 3: Frontend Fallback Warning + Structured Output Types

**Goal**: Add `modelFallback` and `structuredOutput` fields to frontend types and stream handler

**Success Criteria**:
- `pnpm run type-check` passes (weknora-ui)
- stream.ts handles `model_fallback_warning` event
- stream.ts extracts `structured_output` from result event

**Files**:
- `weknora-ui/src/api/a2a/types.ts` — add 2 fields to A2AChatMessage
- `weknora-ui/src/api/a2a/stream.ts` — add 2 event handlers

**Tests**:
- `cd weknora-ui && pnpm run type-check`
- `cd weknora-ui && pnpm run build`

**Steps**:
1. `types.ts:~157` — add after `promptSuggestion`:
   ```typescript
   modelFallback?: { requested: string; actual: string };
   structuredOutput?: unknown;
   ```
2. `stream.ts:~340` — add `case 'model_fallback_warning'` handler
3. `stream.ts:~356` — add `structured_output` extraction in result handler

**Status**: Complete

---

## Stage 4: Frontend Rendering (PC + Mobile)

**Goal**: Render fallback warning banner and structured output card in both PC and Mobile views

**Success Criteria**:
- Yellow banner shows when `msg.modelFallback` is set
- Structured output renders as collapsible `<details>` with JSON
- Mobile has 44px touch target + pre-wrap

**Files**:
- `weknora-ui/src/views/a2a-chat/index.vue` — add fallback banner + structured output card
- `weknora-ui/src/components-mobile/MobileTerminalMessage.vue` — same for mobile
- styles (inline or component-scoped)

**Tests**:
- Visual: send message to agent with outputFormat, verify rendering
- Visual: trigger fallback, verify yellow banner

**Steps**:
1. `a2a-chat/index.vue:~530` — add fallback warning div after `tm-actions`
2. `a2a-chat/index.vue:~531` — add structured output `<details>` before `tm-footer`
3. `MobileTerminalMessage.vue` — add same two components with mobile-friendly styles
4. Add CSS: `.tm-model-fallback-warning` (yellow bg) + `.tm-structured-output` (collapsible)

**Status**: Complete

---

## Stage 5: Structured Output Backend (Schema Validation)

**Goal**: Add `outputFormat` support with security validation to `buildQueryOptions`

**Success Criteria**:
- Agent with `outputFormat` config passes schema to SDK
- Schema >5KB rejected
- Schema depth >10 rejected
- Sensitive field names flagged (advisory, not hard block)

**Files**:
- `backend/src/utils/claudeUtils.ts` — add `validateOutputSchema` + `calculateSchemaDepth` functions + outputFormat injection

**Tests**:
- Unit test: schema validation (size, depth, sensitive names)
- Integration: agent with outputFormat produces structured_output in result event

**Steps**:
1. Add `validateOutputSchema()` function (~20 lines)
2. Add `calculateSchemaDepth()` helper (~10 lines)
3. In `buildQueryOptions`, add:
   ```typescript
   if (agent.outputFormat) {
     validateOutputSchema(agent.outputFormat.schema);
     queryOptions.outputFormat = agent.outputFormat;
   }
   ```

**Status**: Complete

---

## Stage 6: SystemInfo Type Alignment

**Goal**: Extend A2ASystemInfo with SDK 0.2.84 fields, update stream handler and PC rendering

**Success Criteria**:
- A2ASystemInfo has 9 fields (was 6)
- stream.ts init handler extracts all 9 fields
- PC details panel shows agents list

**Files**:
- `weknora-ui/src/api/a2a/types.ts` — extend A2ASystemInfo
- `weknora-ui/src/api/a2a/stream.ts` — update init handler
- `weknora-ui/src/views/a2a-chat/index.vue` — add agents row to details

**Tests**:
- `cd weknora-ui && pnpm run type-check && pnpm run build`
- Visual: check system init details panel shows new fields

**Steps**:
1. `types.ts:~189-196` — add `permissionMode`, `agents`, `plugins` to A2ASystemInfo
2. `stream.ts:~425-434` — extract 3 new fields in init handler
3. `a2a-chat/index.vue:~533-544` — add agents row to `system-init-details`

**Status**: Complete

---

## Stage 7: Frontend Type Sync + Final Verification

**Goal**: Sync agentstudio frontend types, run full verification

**Success Criteria**:
- All 20 verification checklist items pass
- All 3 projects type-check and build successfully

**Files**:
- `agentstudio/frontend/src/types/agents.ts` — sync `enableLargeContext`, `taskBudgetTokens`, `outputFormat`

**Tests**:
- Backend: `cd backend && pnpm run type-check`
- weknora-ui: `cd weknora-ui && pnpm run type-check && pnpm run build`
- agentstudio frontend: `cd frontend && pnpm run type-check`
- Manual regression: A2A chat one-shot + reuse mode

**Steps**:
1. Sync 3 new fields to frontend `types/agents.ts`
2. Run all type checks
3. Run all builds
4. Manual A2A regression test
5. Walk through verification checklist

**Status**: Complete

---

## Summary

| Stage | Content | Files | Effort |
|-------|---------|-------|--------|
| 1 | SDK config injection | 4 backend | 30 min |
| 2 | Fallback detection | 1 backend | 15 min |
| 3 | Frontend types + stream | 2 weknora-ui | 20 min |
| 4 | Frontend rendering | 2-3 weknora-ui | 1 hr |
| 5 | Schema validation | 1 backend | 30 min |
| 6 | SystemInfo alignment | 3 weknora-ui | 20 min |
| 7 | Type sync + verification | 1 agentstudio-fe | 15 min |
| **Total** | | **~14 touches** | **~3.5 hr** |

**Dependencies**:
- Stage 2 depends on Stage 1 (fallbackModel must exist in queryOptions)
- Stage 3 depends on Stage 2 (frontend handles event that backend emits)
- Stage 4 depends on Stage 3 (rendering uses fields from types/stream)
- Stage 5 independent (can parallel with 2-4)
- Stage 6 independent (can parallel with 2-5)
- Stage 7 depends on all above
