/**
 * DooTask 任务上报工具（1 个）
 * Sprint 5a Task 5a.1：任务级别上报（dootask `project/report/save`）
 *
 * 注意命名歧义：与同目录 reports.ts（"工作汇报" report/store）名称相近但 endpoint 完全不同。
 * - reports.ts          → report/store  ＝ 周报/日报（个人工作汇报）
 * - taskReports.ts (本) → project/report/save ＝ 任务级别上报（带动态字段、模板触发）
 *
 * `upload_report_attachment`（multipart）暂未实施 — multipart 在 LLM 调用路径很少触发，
 * 推后到 Sprint 8/9 前端 UI 实施时由真实 multipart 路径触发。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

export function buildTaskReportsTools(ctx: ToolContext) {
  const saveTaskReport = tool(
    'save_task_report',
    '提交任务上报（DooTask 任务级别，含动态字段值）。spec §3.1 + Sprint 1.7 endpoint = project/report/save。',
    {
      task_id: z.number().int().positive().describe('任务 ID'),
      values: z.record(z.string(), z.any()).describe('字段值 JSON, e.g. {hours: 4, note: "..."}'),
      work_date: z.string().optional().describe('归属日期 yyyy-mm-dd（默认今日）'),
      report_id: z.number().int().nonnegative().optional().describe('编辑场景：报告 ID'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report/save', args as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  return [saveTaskReport];
}
