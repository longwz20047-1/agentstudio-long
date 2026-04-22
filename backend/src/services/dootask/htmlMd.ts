/**
 * HTML ↔ Markdown 双向转换
 *
 * 迁移自 dootask/electron/lib/mcp.js:119-166。
 * 用于：
 *   - `create_task` / `update_task`：用户输入 markdown → html 发给 Dootask API
 *   - `get_task` / `get_task_content`：Dootask 返回 html → markdown 展示给 LLM
 */

import TurndownService from 'turndown';
import { marked } from 'marked';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
  strongDelimiter: '**',
  linkStyle: 'inlined',
  preformattedCode: true,
});

/** HTML → Markdown。转换失败时降级为去标签纯文本。 */
export function htmlToMarkdown(html: unknown): string {
  if (!html) return '';
  if (typeof html !== 'string') {
    console.warn(`[htmlMd] HTML to Markdown: expected string, got ${typeof html}`);
    return '';
  }
  try {
    return turndownService.turndown(html).trim();
  } catch (error: any) {
    console.error(`[htmlMd] HTML to Markdown conversion failed: ${error?.message}`, {
      html: html.substring(0, 100),
    });
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

/** Markdown → HTML。转换失败时降级为 \n → <br>。 */
export function markdownToHtml(markdown: unknown): string {
  if (!markdown) return '';
  if (typeof markdown !== 'string') {
    console.warn(`[htmlMd] Markdown to HTML: expected string, got ${typeof markdown}`);
    return '';
  }
  try {
    const html = marked.parse(markdown, { async: false }) as string;
    return html;
  } catch (error: any) {
    console.error(`[htmlMd] Markdown to HTML conversion failed: ${error?.message}`, {
      markdown: markdown.substring(0, 100),
    });
    return markdown.replace(/\n/g, '<br>');
  }
}
