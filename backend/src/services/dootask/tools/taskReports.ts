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
import { DootaskApiError, makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

export function buildTaskReportsTools(ctx: ToolContext) {
  const saveTaskReport = tool(
    'save_task_report',
    [
      '提交任务上报（DooTask 任务级别，含动态字段值）。spec §3.1 + Sprint 1.7 endpoint = project/report/save。',
      '',
      '【关于触发块拒绝（response.blocked === true）】',
      '若返回 {blocked: true, reason: ..., template_block: ..., hint: ...}，说明 dootask 后端 TriggerEngine',
      '按规则拒绝了本次提交（如 spec §21 的 block on_complete + min_count 阻塞策略）。',
      '- 不要重复试错，先告知用户拒绝原因（reason 字段，是中文消息如"需补两次完成上报后再标记完成"）',
      '- template_block.fields 是必填字段定义；template_block 还含 task_id / template_id 等上下文',
      '- 若用户确认要补救，可串联再调一次 save_task_report：传完整 task_id + values 完成上报',
      '- 不要把 blocked 当成 error 报给用户 — 它是预期的业务约束响应',
      '',
      '【常规成功响应】',
      '不阻塞时直接返回 dootask 写入的 report 详情（id/values/work_date 等）。',
    ].join('\n'),
    {
      task_id: z.number().int().positive().describe('任务 ID'),
      values: z.record(z.string(), z.any()).describe('字段值 JSON, e.g. {hours: 4, note: "..."}'),
      work_date: z.string().optional().describe('归属日期 yyyy-mm-dd（默认今日）'),
      report_id: z.number().int().nonnegative().optional().describe('编辑场景：报告 ID'),
    },
    async (args) => {
      const token = await ctx.getToken();
      try {
        const data = await makeDootaskRequest(token, 'POST', 'project/report/save', args as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        // 识别 spec §21.3.1 trigger block 拒绝（ret=-4001 + data.template_block）
        if (err instanceof DootaskApiError && err.ret === -4001 && err.data?.template_block) {
          const block = err.data.template_block;
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                blocked: true,
                reason: err.msg,
                template_block: block,
                // 给 LLM 易读的摘要（让其无需自己解析）
                hint: '此任务被汇报触发规则阻塞。请告知用户原因(reason)，并根据 template_block.fields 引导其补充上报（可串联再调一次 save_task_report 传 task_id + values 完成补救）。',
              }, null, 2),
            }],
          };
        }
        // 其他 error 继续抛（保持原行为，不掩盖 bug）
        throw err;
      }
    },
  );

  return [saveTaskReport];
}
