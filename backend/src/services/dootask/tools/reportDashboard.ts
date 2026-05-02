/**
 * DooTask 报告仪表盘工具（3 个）
 * Sprint 7-B Pass 2 Task 7.5：闭环统计层 — 多维聚合 / 下钻 / 导出
 *
 * Endpoints:
 *   - project/report_dashboard/data    多维聚合查询（dimensions × metric × filters）
 *   - project/report_dashboard/drill   下钻明细（按维度值返 reports 列表）
 *   - project/report_dashboard/export  聚合数据 CSV/JSON 导出
 *
 * 跳过端点（dootask 后端 retError 占位，Sprint 9 ECharts 仪表盘启动时落表）：
 *   - report_dashboard/charts、save_chart、delete_chart
 *
 * 权限：filters.project_ids 任一非项目成员抛错；不传 project_ids = 跨项目查 = 仅 admin 可调
 *      （dootask 后端校验，MCP 透传即可）
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

export function buildReportDashboardTools(ctx: ToolContext) {
  const queryReportDashboardData = tool(
    'query_report_dashboard_data',
    [
      '【报告仪表盘聚合查询】对 task_report 数据按维度切片做聚合（spec §11.8）。',
      '',
      '场景示例：',
      '  - "统计上月 X 项目的总工时" → dimensions=["project"], metric="sum_hours", filters={project_ids:[X], date_range:["2026-04-01","2026-04-30"]}',
      '  - "按用户维度看本季度报告数量 top 10" → dimensions=["user"], metric="count", top_n=10',
      '  - "看每天的报告提交数趋势" → dimensions=["time/day"], metric="count"',
      '  - "按模板看平均工时" → dimensions=["template"], metric="avg_hours"',
      '',
      'dimensions（拆分维度，可多个）：time/day | user | project | task | template',
      'metric（聚合指标）：count | sum_<code> | avg_<code> | max_<code> | min_<code> | count_distinct_<code>',
      '  → 其中 <code> 是字段 code（如 hours）；先调 list_report_fields 看哪些 code 标记了 aggregatable=true 才能用 sum/avg/max/min',
      'filters（缩小范围）：{user_ids?, project_ids?, task_ids?, template_ids?, date_range?(["start","end"])}',
      'sort：[{field: "metric_value" 或 维度列名, order: "asc"|"desc"}]',
      'top_n：限制返回行数',
      '',
      '权限：传 filters.project_ids 任一非成员抛错；不传 project_ids = 跨项目查 = 仅管理员可调。',
      '响应：{rows: [{...}], warning?: string}',
    ].join('\n'),
    {
      dimensions: z.array(z.string())
        .describe('拆分维度数组，可选值：time/day | user | project | task | template'),
      metric: z.string()
        .describe('聚合指标：count / sum_<code> / avg_<code> / max_<code> / min_<code> / count_distinct_<code>，<code> 为字段 code（先用 list_report_fields 查 aggregatable 字段）'),
      filters: z.object({
        user_ids: z.array(z.number().int().positive()).optional(),
        project_ids: z.array(z.number().int().positive()).optional()
          .describe('不传 = 跨项目查（仅 admin）；传 = 项目成员校验'),
        task_ids: z.array(z.number().int().positive()).optional(),
        template_ids: z.array(z.number().int().positive()).optional(),
        date_range: z.array(z.string()).length(2).optional()
          .describe('[start, end] e.g. ["2026-04-01","2026-04-30"]'),
      }).passthrough().optional(),
      sort: z.array(z.object({
        field: z.string().describe('"metric_value" 或维度列名'),
        order: z.enum(['asc', 'desc']),
      })).optional(),
      top_n: z.number().int().positive().optional()
        .describe('限制返回行数（top N 排行）'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_dashboard/data', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  const drillReportDashboard = tool(
    'drill_report_dashboard',
    [
      '【报告仪表盘下钻明细】看到聚合数据后想看具体某个维度值的明细 reports（Sprint 9 onDrillDown 链路）。',
      '',
      '场景示例：',
      '  - "按用户聚合发现 user_id=5 工时最高，看他的明细" → drill_by={user_id:5}, filters={date_range:[...]}',
      '  - "某天 (2026-04-15) 报告数飙升，看是哪些报告" → drill_by={day:"2026-04-15"}',
      '  - "X 项目的全部报告" → drill_by={project_id:X}',
      '',
      '入参：',
      '  drill_by（必填）：{user_id?, project_id?, task_id?, day?(YYYY-MM-DD)} — 任意组合作为下钻条件',
      '  filters（可选）：原 query_report_dashboard_data 同款 filters，沿用以缩小集合',
      '  limit：默认 50，最大 200',
      '',
      '权限规则同 query_report_dashboard_data。响应：{reports: [{...}]}',
    ].join('\n'),
    {
      drill_by: z.object({
        user_id: z.number().int().positive().optional(),
        project_id: z.number().int().positive().optional(),
        task_id: z.number().int().positive().optional(),
        day: z.string().optional().describe('YYYY-MM-DD'),
      }).describe('下钻维度值，任意组合'),
      filters: z.object({
        user_ids: z.array(z.number().int().positive()).optional(),
        project_ids: z.array(z.number().int().positive()).optional(),
        task_ids: z.array(z.number().int().positive()).optional(),
        template_ids: z.array(z.number().int().positive()).optional(),
        date_range: z.array(z.string()).length(2).optional(),
      }).passthrough().optional()
        .describe('沿用原聚合 filters 缩小集合'),
      limit: z.number().int().min(1).max(200).optional()
        .describe('默认 50，最大 200'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_dashboard/drill', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  const exportReportDashboardCsv = tool(
    'export_report_dashboard_csv',
    [
      '【报告仪表盘导出】把聚合数据导出 CSV 给老板看 / 入 Excel 二次分析。',
      '',
      '场景示例：',
      '  - "导出本月各项目工时统计 CSV" → dimensions=["project"], metric="sum_hours", filters={date_range:[...]}, format="csv"',
      '  - "下载用户报告排行" → dimensions=["user"], metric="count", format="csv"',
      '',
      '入参与 query_report_dashboard_data 一致，额外 format（csv / xlsx，Pass 2 后端实际仅返 rows JSON，',
      'Sprint 9 切到 stream download）。',
      '',
      '权限规则同 query_report_dashboard_data。响应：{format, rows: [{...}], note}（前端可基于 rows 触发 CSV 下载）',
    ].join('\n'),
    {
      dimensions: z.array(z.string())
        .describe('拆分维度数组，可选值：time/day | user | project | task | template'),
      metric: z.string()
        .describe('聚合指标：count / sum_<code> / avg_<code> / max_<code> / min_<code> / count_distinct_<code>'),
      filters: z.object({
        user_ids: z.array(z.number().int().positive()).optional(),
        project_ids: z.array(z.number().int().positive()).optional(),
        task_ids: z.array(z.number().int().positive()).optional(),
        template_ids: z.array(z.number().int().positive()).optional(),
        date_range: z.array(z.string()).length(2).optional(),
      }).passthrough().optional(),
      format: z.enum(['csv', 'xlsx']).optional()
        .describe('默认 csv（Pass 2 后端简化返 rows JSON，Sprint 9 切流式下载）'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/report_dashboard/export', args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  return [
    queryReportDashboardData,
    drillReportDashboard,
    exportReportDashboardCsv,
  ];
}
