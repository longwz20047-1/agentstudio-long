# OpenCLI Bridge Phase 5: Tool Cards Design

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-24
**Depends on:** Phase 1 (Core Channel) — completed
**Blocks:** Nothing

---

## 1. Goal

Create a single intelligent `OpenCliCard.vue` component in weknora-ui that renders OpenCLI tool results with rich, context-aware formatting. The card auto-detects the data shape and site type, switching between 6 internal rendering modes.

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Component architecture | Single intelligent component with internal mode switching | 6 separate components is over-engineering for ~200 lines total. v-if switching in one file is simpler and easier to maintain. Extract sub-components only if file exceeds 300 lines. |
| Section rendering | All inline in OpenCliCard.vue | Each section is 20-40 lines of template. Total stays under 300 lines. |
| Data extraction | Parse JSON from markdown code block (Firecrawl pattern) | Backend outputFormatter already wraps results in `## site/action results\n\`\`\`json\n...\n\`\`\`` format |

## 3. Architecture

### 3.1 Data Flow

```
Backend outputFormatter.ts          Frontend
─────────────────────────           ────────
                                    ToolCallRenderer.vue
"## bilibili/search (3 found)         │
                                      ├─ toolName.startsWith('mcp__opencli-') ?
```json                               │   → extract site from toolName
[{url, title, views}]                 │   → parseOpenCliResult(toolCall.result)
```                                    │   → <OpenCliCard :toolCall :isDark />
"                                     │
                                      └─ else → other tool cards
```

**Error results** from `formatOpenCliError()` use format `## site/action Error\n\n{message}` (no ```json block). `parseOpenCliResult()` returns `null` for these, which correctly routes to StatusSection.

### 3.2 Rendering Mode Detection

```typescript
// In OpenCliCard.vue computed
function detectRenderMode(site: string, data: unknown): RenderMode {
  // Priority 1: Site-based overrides
  if (FINANCE_SITES.includes(site)) return 'finance';
  if (DESKTOP_SITES.includes(site)) return 'desktop';

  // Priority 2: Data-shape detection
  if (data === null || data === undefined) return 'status';
  if (Array.isArray(data) && data.length > 0 && data[0]?.url) return 'list';
  if (Array.isArray(data)) return 'table';
  if (typeof data === 'object' && (data.content || data.text)) return 'content';

  // Fallback
  return 'status';
}
```

**Site constants:**
```typescript
const FINANCE_SITES = ['xueqiu', 'yahoo-finance', 'barchart', 'sinafinance', 'bloomberg'];
const DESKTOP_SITES = ['cursor', 'codex', 'chatwise', 'antigravity', 'notion', 'discord-app', 'chatgpt', 'grok'];
```

### 3.3 Component Structure

```
OpenCliCard.vue
│
├── <BaseToolCard>           — wraps everything (header, expand/collapse, status)
│   ├── props: toolCall, icon, displayName, subtitle
│   │
│   ├── v-if="mode === 'list'"
│   │   └── ListSection     — numbered URL list with metadata
│   │
│   ├── v-else-if="mode === 'table'"
│   │   └── TableSection    — <t-table> with auto-generated columns
│   │
│   ├── v-else-if="mode === 'content'"
│   │   └── ContentSection  — text/markdown rendering
│   │
│   ├── v-else-if="mode === 'finance'"
│   │   └── FinanceSection  — stock ticker cards (red/green)
│   │
│   ├── v-else-if="mode === 'desktop'"
│   │   └── DesktopSection  — terminal-style dark background
│   │
│   └── v-else
│       └── StatusSection   — success/error icon + message
│
└── <script setup>
    ├── parseOpenCliResult()  — from opencli-utils.ts
    ├── detectRenderMode()    — site + data shape → mode
    ├── computed: site, action, parsedData, renderMode, resultSummary
    └── siteIcon mapping
```

## 4. Rendering Modes

### 4.1 ListSection

**Triggers:** Array with items containing `url` field.
**Sites:** bilibili, hackernews, twitter, reddit, youtube, xiaohongshu, etc.

```
┌─────────────────────────────────────────┐
│ 🔍 bilibili/search · 3 found           │
├─────────────────────────────────────────┤
│ 1. LLM 入门教程                    🔗   │
│    👁 12.3k · ⏱ 15:30 · UP: 技术宅     │
│ 2. Agent 开发实战                   🔗   │
│    👁 8.1k · ⏱ 22:10 · UP: AI研究所    │
│ 3. RAG 架构详解                     🔗   │
│    👁 5.2k · ⏱ 18:45 · UP: 码农日志    │
└─────────────────────────────────────────┘
```

**Implementation notes:**
- Each item: clickable title (opens URL), metadata row below
- Metadata fields vary by site — show whatever exists: views, likes, duration, author, date
- Max 10 items visible, "Show more" button for pagination
- Number formatting: `12345` → `12.3k`

### 4.2 TableSection

**Triggers:** Array without `url` field.
**Sites:** Any site returning structured data without URLs.

```
┌──────────┬──────────┬────────┬──────┐
│ name     │ category │ price  │ qty  │
├──────────┼──────────┼────────┼──────┤
│ Item A   │ Tools    │ ¥29.9  │ 150  │
│ Item B   │ Books    │ ¥59.0  │ 82   │
└──────────┴──────────┴────────┴──────┘
```

**Implementation notes:**
- Auto-generate columns from first item's keys
- Use TDesign `<t-table>` with `sortable` on numeric columns
- Max 20 rows visible, scroll for more
- Cell truncation at 50 chars with tooltip

### 4.3 ContentSection

**Triggers:** Object with `content` or `text` field.
**Sites:** medium, substack, weread, wikipedia, cursor (responses).

```
┌─────────────────────────────────────────┐
│ 📄 medium/read                          │
├─────────────────────────────────────────┤
│ Building RAG Systems in 2026            │
│                                         │
│ The landscape of retrieval-augmented    │
│ generation has evolved significantly... │
│                                         │
│ ## Key Takeaways                        │
│ 1. Hybrid search outperforms...         │
└─────────────────────────────────────────┘
```

**Implementation notes:**
- Render `data.content || data.text` using `marked` (already available in weknora-ui as dependency) + `dompurify` for safe HTML
- Max height 400px with scroll
- Show source URL if present in data

### 4.4 StatusSection

**Triggers:** Fallback for write operations, non-JSON results, errors.
**Sites:** Any site after write operations (post, reply, like, follow, etc.).

```
┌─────────────────────────────────────────┐
│ ✅ twitter/post · success               │
├─────────────────────────────────────────┤
│ Posted successfully                     │
│ ID: 1234567890                          │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ ❌ twitter/post · error                 │
├─────────────────────────────────────────┤
│ Rate limited. Try again in 30 seconds.  │
└─────────────────────────────────────────┘
```

**Implementation notes:**
- Success: green check icon + message + optional ID/URL
- Error: red X icon + error message
- Non-JSON fallback: show raw text in `<pre>` block
- If data is an object: show key-value pairs

### 4.5 FinanceSection

**Triggers:** Site in FINANCE_SITES.
**Sites:** xueqiu, yahoo-finance, barchart, sinafinance, bloomberg.

```
┌─────────────────────────────────────────┐
│ 📈 xueqiu/quote                        │
├─────────────────────────────────────────┤
│ AAPL  Apple Inc.                        │
│ $192.50  ▲ +2.35 (+1.24%)              │
│ High: $193.10  Low: $189.80  Vol: 45M  │
├─────────────────────────────────────────┤
│ TSLA  Tesla Inc.                        │
│ $248.30  ▼ -5.10 (-2.01%)              │
│ High: $255.00  Low: $247.50  Vol: 62M  │
└─────────────────────────────────────────┘
```

**Implementation notes:**
- Green text + ▲ for positive change, red text + ▼ for negative
- If data is array: render each item as a ticker card
- If data is single object: render one ticker card
- Fields: symbol, name, price, change, changePercent, high, low, volume (show whatever exists)

### 4.6 DesktopSection

**Triggers:** Site in DESKTOP_SITES.
**Sites:** cursor, codex, chatwise, antigravity, notion, discord-app, chatgpt, grok.

```
┌─────────────────────────────────────────┐
│ 💻 cursor/ask                           │
├─────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ │
│ │ > cursor ask "explain this code"    │ │
│ │                                     │ │
│ │ The function uses a recursive...    │ │
│ │ It takes O(n log n) time due to...  │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**Implementation notes:**
- Dark background (`#1a1a2e`), monospace font
- If data has `response`/`output`/`result` field: show that
- Else: JSON.stringify with indentation
- Max height 300px with scroll

## 5. Utility Module

### 5.1 opencli-utils.ts

```typescript
// Extract JSON from outputFormatter's markdown format
export function parseOpenCliResult(result: string): unknown | null {
  if (!result) return null;
  // Try direct JSON parse first
  try { return JSON.parse(result); } catch {}
  // Extract from markdown code block (handles both ```json and plain ```)
  const match = result.match(/```(?:json)?\n([\s\S]*?)\n```/);
  if (match) {
    try { return JSON.parse(match[1]); } catch {}
  }
  return null;
}

// Extract site from tool name. Action comes from toolCall.input.action.
export function parseOpenCliToolName(toolName: string): { site: string } | null {
  // Format: mcp__opencli-{domain}__{site} (domain may contain hyphens)
  const match = toolName.match(/^mcp__opencli-[\w-]+__([\w][\w-]*)$/);
  if (!match) return null;
  return { site: match[1] };
}

export const FINANCE_SITES = ['xueqiu', 'yahoo-finance', 'barchart', 'sinafinance', 'bloomberg'];
export const DESKTOP_SITES = ['cursor', 'codex', 'chatwise', 'antigravity', 'notion', 'discord-app', 'chatgpt', 'grok'];
```

**Note on action extraction:** The `action` value comes from `(toolCall.input as Record<string, unknown>)?.action` — it's a parameter of the MCP tool, not part of the tool name.

## 6. ToolCallRenderer Integration

### 6.1 Routing Logic

In `weknora-ui/src/components/a2a-tools/ToolCallRenderer.vue`, add OpenCLI detection **after Firecrawl checks but before the `McpToolCard` fallback**:

```typescript
import OpenCliCard from './tools/OpenCliCard.vue';
import { parseOpenCliToolName } from './tools/opencli-utils';

// In the MCP tool routing logic (after Firecrawl, before McpToolCard fallback):
const openCliInfo = parseOpenCliToolName(toolCall.name);
if (openCliInfo) {
  return OpenCliCard;
}
```

**Props:** OpenCliCard receives only `toolCall` and `isDark` (same interface as all other tool cards). Site, action, and parsed data are extracted internally via computed properties.

## 7. Internationalization

Add to all 4 locale files (`zh-CN`, `en-US`, `ko-KR`, `ru-RU`):

```json
{
  "builtinTools": {
    "opencli": {
      "title": "OpenCLI",
      "found": "{count} found",
      "success": "Success",
      "error": "Error",
      "showMore": "Show more",
      "noData": "No data returned",
      "rawOutput": "Raw output"
    }
  }
}
```

~10 keys × 4 languages = ~40 lines total.

## 8. File Summary

### New Files

| File | Project | Lines (est.) |
|------|---------|-------------|
| `weknora-ui/src/components/a2a-tools/tools/OpenCliCard.vue` | weknora-ui | ~250 (extract sub-components if exceeds 350) |
| `weknora-ui/src/components/a2a-tools/tools/opencli-utils.ts` | weknora-ui | ~30 |

### Modified Files

| File | Project | Changes |
|------|---------|---------|
| `weknora-ui/src/components/a2a-tools/ToolCallRenderer.vue` | weknora-ui | Import + routing (~10 lines) |
| weknora-ui i18n files (4 languages) | weknora-ui | OpenCLI card labels (~40 lines total) |

### Total Estimate: ~330 lines new/modified code

## 9. Testing Strategy

- **Visual testing:** Manual verification with sample data for each rendering mode
- **Unit tests:** `parseOpenCliResult()` and `parseOpenCliToolName()` utility functions
- **Mode detection:** `detectRenderMode()` with various data shapes
- **Edge cases:** Empty results, malformed JSON, very large arrays (>100 items), deeply nested objects
