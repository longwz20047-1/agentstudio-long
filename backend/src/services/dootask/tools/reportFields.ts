/**
 * DooTask 报告字段定义工具（4 个）
 * Sprint 5a Task 5a.3：动态字段 CRUD + 聚合索引
 *
 * Endpoints:
 *   - project/report_field/list         列出（含 hours/note builtin + custom）
 *   - project/report_field/save         创建/编辑
 *   - project/report_field/delete       删除（builtin 拒删）
 *   - project/report_field/build_index  启用/禁用聚合索引（admin only 双闸 spec §13.3）
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

export function buildReportFieldsTools(ctx: ToolContext) {
  const listReportFields = tool(
    'list_report_fields',
    '列出报告字段定义（spec §3.2，含 hours/note builtin + custom）。',
    {
      scope: z.enum(['global', 'project']).optional(),
      project_id: z.number().int().positive().optional(),
      include_disabled: z.boolean().optional().describe('含禁用字段，默认 false'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_field/list', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  const saveReportField = tool(
    'save_report_field',
    '创建/编辑字段定义（admin only for global / mustOwner for project）。',
    {
      id: z.number().int().nonnegative().optional().describe('编辑场景：字段 ID'),
      scope: z.enum(['global', 'project']),
      project_id: z.number().int().nonnegative().optional(),
      code: z.string().describe('字段 code，唯一 (scope, project_id, code)'),
      name: z.string().describe('字段名称'),
      type: z.enum([
        'text',
        'textarea',
        'number',
        'date',
        'select',
        'multi_select',
        'attachment',
        'json',
        'user',
      ]),
      options: z.record(z.string(), z.any()).optional()
        .describe('类型配置 e.g. {min, max, step} for number'),
      required: z.boolean().optional(),
      sort: z.number().int().nonnegative().optional(),
      enabled: z.boolean().optional(),
      aggregatable: z.boolean().optional().describe('v3.18 是否可聚合'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_field/save', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  const deleteReportField = tool(
    'delete_report_field',
    '删除字段（builtin 拒删，admin/PM only）。',
    {
      id: z.number().int().positive().describe('字段 ID'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_field/delete', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  const buildReportFieldIndex = tool(
    'build_report_field_index',
    '启用/禁用聚合索引（admin only 双闸 spec §13.3，DDL 锁表风险）。',
    {
      id: z.number().int().positive().describe('字段 ID'),
      op: z.enum(['enable', 'disable']),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_field/build_index', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  return [
    listReportFields,
    saveReportField,
    deleteReportField,
    buildReportFieldIndex,
  ];
}
