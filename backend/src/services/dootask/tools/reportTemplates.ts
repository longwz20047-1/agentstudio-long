/**
 * DooTask 报告模板工具（6 个）
 * Sprint 5a Task 5a.2：模板 CRUD + 解析 + 触发日志
 *
 * Endpoints:
 *   - project/report_template/list      列出（含 4 档优先级 spec §6.5）
 *   - project/report_template/save      创建/编辑（含 trigger_rules 84 状态机）
 *   - project/report_template/resolve   为某任务解析模板
 *   - project/report_template/delete    删除（builtin/global default 拒删）
 *   - project/report_template/clone     复制（不复制 is_default + is_builtin）
 *   - project/trigger_log/list          触发日志（spec §3.8）
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

export function buildReportTemplatesTools(ctx: ToolContext) {
  const listReportTemplates = tool(
    'list_report_templates',
    '列出报告模板（含 global default / builtin / project scope，spec §6.5 4 档优先级）。',
    {
      scope: z.enum(['global', 'project']).optional()
        .describe('global / project / 留空=both'),
      scope_id: z.number().int().nonnegative().optional()
        .describe('scope=project 时 = project_id'),
      include_disabled: z.boolean().optional()
        .describe('含禁用模板，默认 false'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_template/list', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  const saveReportTemplate = tool(
    'save_report_template',
    '创建/编辑报告模板（含 trigger_rules 84 状态机，admin/PM only）。',
    {
      id: z.number().int().nonnegative().optional().describe('编辑场景：模板 ID'),
      scope: z.enum(['global', 'project']).describe('global 仅 admin / project mustOwner'),
      scope_id: z.number().int().nonnegative().optional().describe('scope=project 时 = project_id'),
      name: z.string().describe('模板名称'),
      description: z.string().optional(),
      is_default: z.boolean().optional().describe('仅 scope=global 内允许 1 个 is_default=true'),
      enabled: z.boolean().optional(),
      trigger_rules: z.array(z.record(z.string(), z.any())).optional()
        .describe('触发规则数组，84 状态机自动校验'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_template/save', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  const resolveReportTemplate = tool(
    'resolve_report_template',
    '为某任务解析对应的报告模板（spec §6.5 TemplateResolver 4 档优先级查找）。',
    {
      task_id: z.number().int().positive().describe('任务 ID'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_template/resolve', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  const deleteReportTemplate = tool(
    'delete_report_template',
    '删除报告模板（builtin / global default 拒删，admin/PM only）。',
    {
      id: z.number().int().positive().describe('模板 ID'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_template/delete', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  const cloneReportTemplate = tool(
    'clone_report_template',
    '复制报告模板创建新模板（不复制 is_default + is_builtin）。',
    {
      id: z.number().int().positive().describe('源模板 ID'),
      name: z.string().optional().describe('新模板名称（默认源名 + (副本)）'),
      target_scope: z.enum(['global', 'project']).optional(),
      target_scope_id: z.number().int().nonnegative().optional(),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_template/clone', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  const listTriggerLogs = tool(
    'list_trigger_logs',
    '列出触发日志（spec §3.8 trigger_log 表，去重唯一索引）。',
    {
      task_id: z.number().int().positive().optional(),
      template_id: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).optional()
        .describe('返回条数，默认 50，最大 200'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/trigger_log/list', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  return [
    listReportTemplates,
    saveReportTemplate,
    resolveReportTemplate,
    deleteReportTemplate,
    cloneReportTemplate,
    listTriggerLogs,
  ];
}
