# OpenCLI Bridge Phase 5: Tool Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a single intelligent `OpenCliCard.vue` in weknora-ui that renders OpenCLI tool results with 6 context-aware rendering modes (list/table/content/status/finance/desktop).

**Architecture:** One Vue component with internal mode switching via `v-if`. A utility module (`opencli-utils.ts`) handles JSON extraction and site classification. ToolCallRenderer routes `mcp__opencli-*` tools to OpenCliCard. No new dependencies needed — `marked`, `dompurify`, `tdesign-vue-next` already in project.

**Tech Stack:** Vue 3.5, TDesign, marked, dompurify, vue-i18n

**Design Doc:** `docs/superpowers/specs/2026-03-24-opencli-bridge-phase5-tool-cards-design.md`

**Scope:** weknora-ui only. No backend changes.

**Projects affected:**
- `weknora-ui/` — new component + utility + i18n updates (~330 lines)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/components/a2a-tools/tools/opencli-utils.ts` | `parseOpenCliResult()`, `parseOpenCliToolName()`, site constants (FINANCE_SITES, DESKTOP_SITES) |
| `src/components/a2a-tools/tools/OpenCliCard.vue` | Single intelligent card with 6 rendering modes |

### Modified Files

| File | Changes |
|------|---------|
| `src/components/a2a-tools/ToolCallRenderer.vue` | Import OpenCliCard + add `mcp__opencli-` prefix routing before McpToolCard fallback |
| `src/i18n/locales/zh-CN.ts` | Add `opencli` section to `builtinTools` + `a2aTools` |
| `src/i18n/locales/en-US.ts` | Same |
| `src/i18n/locales/ko-KR.ts` | Same |
| `src/i18n/locales/ru-RU.ts` | Same |

---

## Task Dependency Graph

```
Task 1 (opencli-utils.ts + tests) ──→ Task 2 (OpenCliCard.vue)
                                              │
                                              ↓
                                      Task 3 (ToolCallRenderer routing)
                                              │
                                              ↓
                                      Task 4 (i18n)
                                              │
                                              ↓
                                      Task 5 (type-check + visual verification)
```

---

## Task 1: Utility Module

**Files:**
- Create: `weknora-ui/src/components/a2a-tools/tools/opencli-utils.ts`

- [ ] **Step 1: Create opencli-utils.ts**

```typescript
// weknora-ui/src/components/a2a-tools/tools/opencli-utils.ts

export const FINANCE_SITES = ['xueqiu', 'yahoo-finance', 'barchart', 'sinafinance', 'bloomberg'];
export const DESKTOP_SITES = ['cursor', 'codex', 'chatwise', 'antigravity', 'notion', 'discord-app', 'chatgpt', 'grok'];

export type RenderMode = 'list' | 'table' | 'content' | 'status' | 'finance' | 'desktop';

/**
 * Extract JSON from outputFormatter's markdown format.
 * Handles: direct JSON, ```json code blocks, plain ``` code blocks.
 * Returns null for error messages (no code block) — routes to StatusSection.
 */
export function parseOpenCliResult(result: string): unknown | null {
  if (!result) return null;
  try { return JSON.parse(result); } catch {}
  const match = result.match(/```(?:json)?\n([\s\S]*?)\n```/);
  if (match) {
    try { return JSON.parse(match[1]); } catch {}
  }
  return null;
}

/**
 * Extract site name from MCP tool name.
 * Format: mcp__opencli-{domain}__{site}
 */
export function parseOpenCliToolName(toolName: string): { site: string } | null {
  const match = toolName.match(/^mcp__opencli-[\w-]+__([\w][\w-]*)$/);
  if (!match) return null;
  return { site: match[1] };
}

/**
 * Detect rendering mode based on site name and parsed data shape.
 * Priority: finance > desktop > list > content > table > status (fallback).
 */
export function detectRenderMode(site: string, data: unknown): RenderMode {
  if (FINANCE_SITES.includes(site)) return 'finance';
  if (DESKTOP_SITES.includes(site)) return 'desktop';
  if (data === null || data === undefined) return 'status';
  if (Array.isArray(data) && data.length > 0 && (data[0] as Record<string, unknown>)?.url) return 'list';
  if (Array.isArray(data)) return 'table';
  if (typeof data === 'object' && data !== null && ('content' in data || 'text' in data)) return 'content';
  return 'status';
}

/** Format large numbers: 12345 → "12.3k", 1234567 → "1.2M" */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
```

- [ ] **Step 2: Write unit tests for utility functions**

Create test file (co-located):

```typescript
// weknora-ui/src/components/a2a-tools/tools/__tests__/opencli-utils.test.ts
import { describe, it, expect } from 'vitest';
import { parseOpenCliResult, parseOpenCliToolName, detectRenderMode, formatCount } from '../opencli-utils';

describe('parseOpenCliResult', () => {
  it('parses direct JSON', () => {
    expect(parseOpenCliResult('[{"url":"https://x.com"}]')).toEqual([{ url: 'https://x.com' }]);
  });
  it('extracts from ```json code block', () => {
    const input = '## bilibili/search results\n\n```json\n[{"title":"test"}]\n```';
    expect(parseOpenCliResult(input)).toEqual([{ title: 'test' }]);
  });
  it('extracts from plain ``` code block', () => {
    const input = '## hackernews/top results\n\n```\n{"items":[]}\n```';
    expect(parseOpenCliResult(input)).toEqual({ items: [] });
  });
  it('returns null for error format', () => {
    expect(parseOpenCliResult('## twitter/post Error\n\nRate limited')).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(parseOpenCliResult('')).toBeNull();
  });
});

describe('parseOpenCliToolName', () => {
  it('extracts site from valid tool name', () => {
    expect(parseOpenCliToolName('mcp__opencli-social__twitter')).toEqual({ site: 'twitter' });
  });
  it('handles hyphenated domain', () => {
    expect(parseOpenCliToolName('mcp__opencli-social-media__tiktok')).toEqual({ site: 'tiktok' });
  });
  it('handles hyphenated site', () => {
    expect(parseOpenCliToolName('mcp__opencli-finance__yahoo-finance')).toEqual({ site: 'yahoo-finance' });
  });
  it('returns null for non-opencli tool', () => {
    expect(parseOpenCliToolName('mcp__firecrawl__scrape')).toBeNull();
  });
  it('returns null for built-in tool', () => {
    expect(parseOpenCliToolName('Bash')).toBeNull();
  });
});

describe('detectRenderMode', () => {
  it('returns finance for xueqiu', () => {
    expect(detectRenderMode('xueqiu', [{ price: 100 }])).toBe('finance');
  });
  it('returns desktop for cursor', () => {
    expect(detectRenderMode('cursor', { response: 'hi' })).toBe('desktop');
  });
  it('returns list for array with url', () => {
    expect(detectRenderMode('bilibili', [{ url: 'https://...', title: 'test' }])).toBe('list');
  });
  it('returns table for array without url', () => {
    expect(detectRenderMode('unknown', [{ name: 'a', value: 1 }])).toBe('table');
  });
  it('returns content for object with text', () => {
    expect(detectRenderMode('medium', { text: 'article content' })).toBe('content');
  });
  it('returns status for null data', () => {
    expect(detectRenderMode('twitter', null)).toBe('status');
  });
});

describe('formatCount', () => {
  it('formats thousands', () => { expect(formatCount(12345)).toBe('12.3k'); });
  it('formats millions', () => { expect(formatCount(1234567)).toBe('1.2M'); });
  it('passes small numbers through', () => { expect(formatCount(999)).toBe('999'); });
});
```

- [ ] **Step 3: Run tests**

Run: `cd weknora-ui && npx vitest run src/components/a2a-tools/tools/__tests__/opencli-utils.test.ts`
Expected: All PASS

- [ ] **Step 4: Verify no TypeScript errors**

Run: `cd weknora-ui && npx vue-tsc --noEmit --pretty 2>&1 | grep opencli-utils || echo "No errors"`
Expected: No errors related to opencli-utils

- [ ] **Step 5: Commit**

```bash
cd weknora-ui
git add src/components/a2a-tools/tools/opencli-utils.ts src/components/a2a-tools/tools/__tests__/opencli-utils.test.ts
git commit -m "feat: add opencli-utils with JSON extraction and render mode detection"
```

---

## Task 2: OpenCliCard Component

**Files:**
- Create: `weknora-ui/src/components/a2a-tools/tools/OpenCliCard.vue`

- [ ] **Step 1: Create OpenCliCard.vue**

```vue
<!-- weknora-ui/src/components/a2a-tools/tools/OpenCliCard.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import BaseToolCard from '../BaseToolCard.vue'
import type { A2AToolCall } from '@/types/a2a'
import {
  parseOpenCliResult,
  parseOpenCliToolName,
  detectRenderMode,
  formatCount,
  FINANCE_SITES,
  DESKTOP_SITES,
  type RenderMode,
} from './opencli-utils'

const props = defineProps<{
  toolCall: A2AToolCall
  isDark?: boolean
}>()

const { t } = useI18n()

const siteInfo = computed(() => parseOpenCliToolName(props.toolCall.name))
const site = computed(() => siteInfo.value?.site ?? 'unknown')
const action = computed(() => (props.toolCall.input as Record<string, unknown>)?.action as string ?? '')
const parsedData = computed(() => parseOpenCliResult(props.toolCall.result ?? ''))
const renderMode = computed<RenderMode>(() => detectRenderMode(site.value, parsedData.value))

const displayName = computed(() => `${site.value}/${action.value}`)
const subtitle = computed(() => {
  const d = parsedData.value
  if (Array.isArray(d)) return `${d.length} ${t('a2aTools.opencli.found', { count: d.length })}`
  if (props.toolCall.isError) return t('a2aTools.opencli.error')
  if (d !== null) return t('a2aTools.opencli.success')
  return ''
})

// Icon mapping by site category
const icon = computed(() => {
  if (FINANCE_SITES.includes(site.value)) return 'chart-line'
  if (DESKTOP_SITES.includes(site.value)) return 'desktop'
  return 'internet'
})

// Table: auto-generate columns from first item
const tableColumns = computed(() => {
  const d = parsedData.value
  if (!Array.isArray(d) || d.length === 0) return []
  const keys = Object.keys(d[0] as Record<string, unknown>)
  return keys.slice(0, 6).map(key => {
    const firstVal = (d[0] as Record<string, unknown>)[key]
    return {
      colKey: key,
      title: key,
      ellipsis: true,
      width: key === 'url' ? 200 : undefined,
      sorter: typeof firstVal === 'number',
    }
  })
})

// Content: render markdown safely
const renderedContent = computed(() => {
  const d = parsedData.value as Record<string, unknown> | null
  if (!d) return ''
  const text = String(d.content || d.text || '')
  return DOMPurify.sanitize(marked.parse(text) as string)
})

// Finance: normalize to array
const financeItems = computed(() => {
  const d = parsedData.value
  return Array.isArray(d) ? d : d ? [d] : []
})

// Status: extract message
const statusMessage = computed(() => {
  const d = parsedData.value
  if (d === null) {
    // Extract message from raw result (error format: ## site/action Error\n\nmessage)
    const raw = props.toolCall.result ?? ''
    const match = raw.match(/Error\n\n([\s\S]*)/)
    return match ? match[1].trim() : raw.substring(0, 500)
  }
  if (typeof d === 'object' && d !== null) {
    const obj = d as Record<string, unknown>
    return String(obj.message || obj.status || JSON.stringify(d, null, 2))
  }
  return String(d)
})
</script>

<template>
  <BaseToolCard
    :tool-call="toolCall"
    :icon="icon"
    :display-name="displayName"
    :subtitle="subtitle"
    :default-expanded="true"
    :show-input="false"
    :show-output="false"
  >
    <!-- ListSection -->
    <div v-if="renderMode === 'list'" class="opencli-list">
      <div
        v-for="(item, i) in (parsedData as Record<string, unknown>[]).slice(0, 10)"
        :key="i"
        class="opencli-list-item"
      >
        <span class="opencli-list-index">{{ i + 1 }}.</span>
        <div class="opencli-list-content">
          <a :href="String(item.url)" target="_blank" rel="noopener" class="opencli-list-title">
            {{ item.title || item.text || item.name || item.url }}
          </a>
          <div class="opencli-list-meta">
            <span v-if="item.views">👁 {{ formatCount(Number(item.views)) }}</span>
            <span v-if="item.likes">❤ {{ formatCount(Number(item.likes)) }}</span>
            <span v-if="item.duration">⏱ {{ item.duration }}</span>
            <span v-if="item.author">{{ item.author }}</span>
            <span v-if="item.date">{{ item.date }}</span>
          </div>
        </div>
      </div>
      <div v-if="(parsedData as unknown[]).length > 10" class="opencli-show-more">
        {{ t('a2aTools.opencli.showMore') }} ({{ (parsedData as unknown[]).length - 10 }})
      </div>
    </div>

    <!-- TableSection -->
    <div v-else-if="renderMode === 'table'" class="opencli-table">
      <t-table
        :data="(parsedData as Record<string, unknown>[]).slice(0, 20)"
        :columns="tableColumns"
        size="small"
        bordered
        max-height="400"
      />
    </div>

    <!-- ContentSection -->
    <div v-else-if="renderMode === 'content'" class="opencli-content">
      <div class="opencli-content-body" v-html="renderedContent" />
    </div>

    <!-- FinanceSection -->
    <div v-else-if="renderMode === 'finance'" class="opencli-finance">
      <div v-for="(item, i) in financeItems" :key="i" class="opencli-finance-card">
        <div class="opencli-finance-header">
          <strong>{{ (item as Record<string, unknown>).symbol }}</strong>
          <span class="opencli-finance-name">{{ (item as Record<string, unknown>).name }}</span>
        </div>
        <div
          class="opencli-finance-price"
          :class="{
            'is-up': Number((item as Record<string, unknown>).change) > 0,
            'is-down': Number((item as Record<string, unknown>).change) < 0,
          }"
        >
          {{ (item as Record<string, unknown>).price }}
          <span v-if="(item as Record<string, unknown>).change">
            {{ Number((item as Record<string, unknown>).change) > 0 ? '▲' : '▼' }}
            {{ (item as Record<string, unknown>).change }}
            <template v-if="(item as Record<string, unknown>).changePercent">
              ({{ (item as Record<string, unknown>).changePercent }})
            </template>
          </span>
        </div>
        <div class="opencli-finance-meta">
          <span v-if="(item as Record<string, unknown>).high">H: {{ (item as Record<string, unknown>).high }}</span>
          <span v-if="(item as Record<string, unknown>).low">L: {{ (item as Record<string, unknown>).low }}</span>
          <span v-if="(item as Record<string, unknown>).volume">Vol: {{ formatCount(Number((item as Record<string, unknown>).volume)) }}</span>
        </div>
      </div>
    </div>

    <!-- DesktopSection -->
    <div v-else-if="renderMode === 'desktop'" class="opencli-desktop">
      <pre class="opencli-desktop-output">{{ typeof parsedData === 'object' ? JSON.stringify(parsedData, null, 2) : String(parsedData) }}</pre>
    </div>

    <!-- StatusSection (fallback) -->
    <div v-else class="opencli-status">
      <div class="opencli-status-icon">
        {{ toolCall.isError ? '❌' : '✅' }}
      </div>
      <div class="opencli-status-message">{{ statusMessage }}</div>
    </div>
  </BaseToolCard>
</template>

<style scoped>
.opencli-list-item {
  display: flex;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--td-border-level-1-color, #e7e7e7);
}
.opencli-list-item:last-child { border-bottom: none; }
.opencli-list-index { color: var(--td-text-color-placeholder); min-width: 24px; }
.opencli-list-title { color: var(--td-brand-color); text-decoration: none; font-weight: 500; }
.opencli-list-title:hover { text-decoration: underline; }
.opencli-list-meta { font-size: 12px; color: var(--td-text-color-secondary); display: flex; gap: 12px; margin-top: 4px; }
.opencli-show-more { text-align: center; padding: 8px; color: var(--td-brand-color); cursor: pointer; font-size: 13px; }

.opencli-table { overflow-x: auto; }

.opencli-content-body { max-height: 400px; overflow-y: auto; line-height: 1.6; }

.opencli-finance-card { padding: 8px 0; border-bottom: 1px solid var(--td-border-level-1-color); }
.opencli-finance-card:last-child { border-bottom: none; }
.opencli-finance-header { display: flex; gap: 8px; align-items: baseline; }
.opencli-finance-name { color: var(--td-text-color-secondary); font-size: 13px; }
.opencli-finance-price { font-size: 18px; font-weight: 600; margin: 4px 0; }
.opencli-finance-price.is-up { color: #e53e3e; }
.opencli-finance-price.is-down { color: #38a169; }
.opencli-finance-meta { font-size: 12px; color: var(--td-text-color-secondary); display: flex; gap: 16px; }

.opencli-desktop { background: #1a1a2e; border-radius: 6px; padding: 12px; }
.opencli-desktop-output { color: #e2e8f0; font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace; font-size: 13px; white-space: pre-wrap; max-height: 300px; overflow-y: auto; margin: 0; }

.opencli-status { display: flex; gap: 8px; align-items: flex-start; padding: 8px 0; }
.opencli-status-icon { font-size: 18px; }
.opencli-status-message { white-space: pre-wrap; word-break: break-word; }
</style>
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd weknora-ui && npx vue-tsc --noEmit --pretty 2>&1 | grep -i "OpenCliCard\|opencli" | head -5 || echo "No errors"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd weknora-ui
git add src/components/a2a-tools/tools/OpenCliCard.vue
git commit -m "feat: add OpenCliCard with 6 rendering modes (list/table/content/status/finance/desktop)"
```

---

## Task 3: ToolCallRenderer Routing

**Files:**
- Modify: `weknora-ui/src/components/a2a-tools/ToolCallRenderer.vue`

- [ ] **Step 1: Read ToolCallRenderer.vue to find exact insertion point**

Read the file and locate where MCP tools are handled — specifically the Firecrawl section and the McpToolCard fallback.

- [ ] **Step 2: Add OpenCLI import and routing**

Add import at top of `<script setup>`:

```typescript
import { parseOpenCliToolName } from './tools/opencli-utils'
```

Add lazy component definition alongside other tool components:

```typescript
const OpenCliCard = defineAsyncComponent(() => import('./tools/OpenCliCard.vue'))
```

Add routing logic **after Firecrawl checks but before McpToolCard fallback**. Find the section where `mcp__` prefix tools are routed and add:

```typescript
// OpenCLI tools
if (parseOpenCliToolName(toolName)) {
  return OpenCliCard
}
```

- [ ] **Step 3: Verify no regressions**

Run: `cd weknora-ui && npx vue-tsc --noEmit --pretty 2>&1 | tail -5`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
cd weknora-ui
git add src/components/a2a-tools/ToolCallRenderer.vue
git commit -m "feat: route mcp__opencli-* tools to OpenCliCard"
```

---

## Task 4: Internationalization

**Files:**
- Modify: `weknora-ui/src/i18n/locales/zh-CN.ts`
- Modify: `weknora-ui/src/i18n/locales/en-US.ts`
- Modify: `weknora-ui/src/i18n/locales/ko-KR.ts`
- Modify: `weknora-ui/src/i18n/locales/ru-RU.ts`

- [ ] **Step 1: Add opencli i18n keys to all 4 locale files**

In each locale file, find the `a2aTools` section and add an `opencli` subsection. Also add `OpenCliCard` to the `builtinTools` section for tool name display.

**zh-CN (`a2aTools` section):**
```typescript
opencli: {
  found: '{count} 条结果',
  success: '成功',
  error: '错误',
  showMore: '显示更多',
  noData: '无返回数据',
  rawOutput: '原始输出',
},
```

**en-US:**
```typescript
opencli: {
  found: '{count} found',
  success: 'Success',
  error: 'Error',
  showMore: 'Show more',
  noData: 'No data returned',
  rawOutput: 'Raw output',
},
```

**ko-KR:**
```typescript
opencli: {
  found: '{count}개 결과',
  success: '성공',
  error: '오류',
  showMore: '더 보기',
  noData: '반환된 데이터 없음',
  rawOutput: '원본 출력',
},
```

**ru-RU:**
```typescript
opencli: {
  found: '{count} найдено',
  success: 'Успешно',
  error: 'Ошибка',
  showMore: 'Показать ещё',
  noData: 'Нет данных',
  rawOutput: 'Необработанный вывод',
},
```

Also add to `builtinTools` section in each file:

```typescript
// zh-CN
OpenCliCard: 'OpenCLI 工具',
// en-US
OpenCliCard: 'OpenCLI Tool',
// ko-KR
OpenCliCard: 'OpenCLI 도구',
// ru-RU
OpenCliCard: 'Инструмент OpenCLI',
```

- [ ] **Step 2: Commit**

```bash
cd weknora-ui
git add src/i18n/locales/zh-CN.ts src/i18n/locales/en-US.ts src/i18n/locales/ko-KR.ts src/i18n/locales/ru-RU.ts
git commit -m "feat: add opencli tool card i18n (4 languages)"
```

---

## Task 5: Type Check + Visual Verification

**Files:** No new files — verification only.

- [ ] **Step 1: Run full type check**

Run: `cd weknora-ui && pnpm run type-check`
Expected: No errors

- [ ] **Step 2: Run build**

Run: `cd weknora-ui && pnpm run build`
Expected: Build succeeds

- [ ] **Step 3: Visual verification with dev server**

Start: `cd weknora-ui && pnpm run dev`

Then send a message in A2A chat that triggers an OpenCLI tool (e.g., "What's trending on HackerNews?").

Verify:
1. Tool call shows OpenCliCard (not generic McpToolCard)
2. Site name and action display in card header
3. Result renders in appropriate mode (list for HN top stories)
4. Card expand/collapse works
5. No console errors

- [ ] **Step 4: Final commit if any fixes needed**

```bash
cd weknora-ui
git add -A
git commit -m "fix: opencli card visual adjustments"
```
