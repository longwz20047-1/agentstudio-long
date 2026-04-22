/**
 * DooTask 工作汇报工具（6 个）
 * 迁移源：dootask/electron/lib/mcp.js:1384-1800
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import { htmlToMarkdown, markdownToHtml } from '../htmlMd.js';
import type { ToolContext } from './types.js';

/** 将 YYYY-MM-DD 转为 keys.created_at 数组（原 mcp.js 行为：new Date().getTime()，毫秒级 epoch） */
function toDateRange(start?: string, end?: string): number[] | null {
  if (!start && !end) return null;
  return [
    start ? new Date(start).getTime() : 0,
    end ? new Date(end).getTime() : 0,
  ];
}

export function buildReportsTools(ctx: ToolContext) {
  const listReceivedReports = tool(
    'list_received_reports',
    '获取我接收的工作汇报列表，支持按类型、状态、部门、时间筛选。',
    {
      search: z.string().optional().describe('搜索关键词（可搜索标题、汇报人邮箱或用户ID）'),
      type: z.enum(['weekly', 'daily', 'all']).optional()
        .describe('汇报类型: weekly(周报), daily(日报), all(全部)，默认 all'),
      status: z.enum(['read', 'unread', 'all']).optional()
        .describe('已读状态: read(已读), unread(未读), all(全部)，默认 all'),
      department_id: z.number().optional().describe('部门ID，筛选指定部门的汇报'),
      created_at_start: z.string().optional().describe('开始时间 YYYY-MM-DD'),
      created_at_end: z.string().optional().describe('结束时间 YYYY-MM-DD'),
      page: z.number().optional().describe('页码，默认 1'),
      pagesize: z.number().optional().describe('每页数量，默认 20，最大 50'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const page = args.page && args.page > 0 ? args.page : 1;
      const pagesize = args.pagesize && args.pagesize > 0 ? Math.min(args.pagesize, 50) : 20;

      const keys: Record<string, unknown> = {};
      if (args.search) keys.key = args.search;
      if (args.type && args.type !== 'all') keys.type = args.type;
      if (args.status && args.status !== 'all') keys.status = args.status;
      if (args.department_id !== undefined) keys.department_id = args.department_id;
      const dateRange = toDateRange(args.created_at_start, args.created_at_end);
      if (dateRange) keys.created_at = dateRange;

      const requestData: Record<string, unknown> = { page, pagesize };
      if (Object.keys(keys).length > 0) requestData.keys = keys;

      const data = await makeDootaskRequest(token, 'GET', 'report/receive', requestData) || {};
      const reports = Array.isArray(data.data) ? data.data : [];

      const simplified = reports.map((r: any) => {
        const myReceive = Array.isArray(r.receives_user)
          ? r.receives_user.find((u: any) => u.pivot && u.pivot.userid)
          : null;
        return {
          report_id: r.id,
          title: r.title,
          type: r.type === 'daily' ? '日报' : '周报',
          sender_id: r.userid,
          is_read: myReceive && myReceive.pivot ? (myReceive.pivot.read === 1) : false,
          receive_at: r.receive_at || r.created_at,
          created_at: r.created_at,
        };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: data.total || reports.length,
            page: data.current_page || page,
            pagesize: data.per_page || pagesize,
            reports: simplified,
          }, null, 2),
        }],
      };
    },
  );

  const getReportDetail = tool(
    'get_report_detail',
    '获取工作汇报详情，包括内容、汇报人、接收人等。支持报告ID或分享码。',
    {
      report_id: z.number().optional().describe('报告ID'),
      share_code: z.string().optional().describe('报告分享码'),
    },
    async (args) => {
      if (!args.report_id && !args.share_code) {
        throw new Error('必须提供 report_id 或 share_code 参数之一');
      }
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = {};
      if (args.report_id) requestData.id = args.report_id;
      else if (args.share_code) requestData.code = args.share_code;

      const report = await makeDootaskRequest(token, 'GET', 'report/detail', requestData);
      const markdownContent = htmlToMarkdown(report.content || '');

      const detail = {
        report_id: report.id,
        title: report.title,
        type: report.type === 'daily' ? '日报' : '周报',
        type_value: report.type_val || report.type,
        content: markdownContent,
        sender_id: report.userid,
        receivers: Array.isArray(report.receives_user)
          ? report.receives_user.map((u: any) => ({
              userid: u.userid,
              nickname: u.nickname || u.email,
              is_read: u.pivot ? (u.pivot.read === 1) : false,
            }))
          : [],
        ai_analysis: report.ai_analysis ? {
          text: report.ai_analysis.text,
          model: report.ai_analysis.model,
          updated_at: report.ai_analysis.updated_at,
        } : null,
        created_at: report.created_at,
        updated_at: report.updated_at,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] };
    },
  );

  const generateReportTemplate = tool(
    'generate_report_template',
    '基于任务完成情况自动生成工作汇报模板。',
    {
      type: z.enum(['weekly', 'daily']).describe('汇报类型: weekly(周报), daily(日报)'),
      offset: z.number().optional()
        .describe('时间偏移量，0 当前周期，-1 上一周期，以此类推。默认 0'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const offset = args.offset !== undefined ? Math.abs(args.offset) : 0;
      const template = await makeDootaskRequest(token, 'GET', 'report/template', {
        type: args.type,
        offset,
      });
      const markdownContent = htmlToMarkdown(template.content || '');
      const data = {
        sign: template.sign,
        title: template.title,
        content: markdownContent,
        existing_report_id: template.id || null,
        message: template.id
          ? '该时间周期已有报告，如需修改请使用 update_report 或在界面中编辑'
          : '模板已生成，可以直接使用或编辑 content 字段，然后使用 create_report 提交',
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  const createReport = tool(
    'create_report',
    '创建并提交工作汇报。通常先使用 generate_report_template 生成模板，然后使用此工具提交。',
    {
      type: z.enum(['weekly', 'daily']).describe('汇报类型: weekly(周报), daily(日报)'),
      title: z.string().describe('报告标题'),
      content: z.string().describe('报告内容（Markdown 格式）'),
      receive: z.array(z.number()).optional().describe('接收人用户ID数组，不包含自己'),
      sign: z.string().optional().describe('唯一签名，从 generate_report_template 返回的 sign 字段获取'),
      offset: z.number().optional().describe('时间偏移量，应与生成模板时保持一致。默认 0'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = {
        id: 0,
        title: args.title,
        type: args.type,
        content: markdownToHtml(args.content),
        offset: args.offset !== undefined ? Math.abs(args.offset) : 0,
      };
      if (args.receive && Array.isArray(args.receive)) requestData.receive = args.receive;
      if (args.sign) requestData.sign = args.sign;

      const report = await makeDootaskRequest(token, 'POST', 'report/store', requestData) || {};
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: '工作汇报创建成功',
            report: {
              report_id: report.id,
              title: report.title,
              type: report.type === 'daily' ? '日报' : '周报',
              created_at: report.created_at,
            },
          }, null, 2),
        }],
      };
    },
  );

  const listMyReports = tool(
    'list_my_reports',
    '获取我发送的工作汇报列表，支持按类型、时间筛选和搜索。适用于查看自己的历史汇报。',
    {
      search: z.string().optional().describe('搜索关键词（可搜索标题）'),
      type: z.enum(['weekly', 'daily', 'all']).optional()
        .describe('汇报类型: weekly(周报), daily(日报), all(全部)，默认 all'),
      created_at_start: z.string().optional().describe('开始时间 YYYY-MM-DD'),
      created_at_end: z.string().optional().describe('结束时间 YYYY-MM-DD'),
      page: z.number().optional().describe('页码，默认 1'),
      pagesize: z.number().optional().describe('每页数量，默认 20，最大 50'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const page = args.page && args.page > 0 ? args.page : 1;
      const pagesize = args.pagesize && args.pagesize > 0 ? Math.min(args.pagesize, 50) : 20;

      const keys: Record<string, unknown> = {};
      if (args.search) keys.key = args.search;
      if (args.type && args.type !== 'all') keys.type = args.type;
      const dateRange = toDateRange(args.created_at_start, args.created_at_end);
      if (dateRange) keys.created_at = dateRange;

      const requestData: Record<string, unknown> = { page, pagesize };
      if (Object.keys(keys).length > 0) requestData.keys = keys;

      const data = await makeDootaskRequest(token, 'GET', 'report/my', requestData) || {};
      const reports = Array.isArray(data.data) ? data.data : [];

      const simplified = reports.map((r: any) => ({
        report_id: r.id,
        title: r.title,
        type: r.type === 'daily' ? '日报' : '周报',
        receivers: Array.isArray(r.receives) ? r.receives : [],
        receiver_count: Array.isArray(r.receives) ? r.receives.length : 0,
        created_at: r.created_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: data.total || reports.length,
            page: data.current_page || page,
            pagesize: data.per_page || pagesize,
            reports: simplified,
          }, null, 2),
        }],
      };
    },
  );

  const markReportsRead = tool(
    'mark_reports_read',
    '批量标记工作汇报为已读或未读状态。支持单个或多个报告的状态管理。',
    {
      report_ids: z.union([z.number(), z.array(z.number())]).describe('报告ID或ID数组，最多 100 个'),
      action: z.enum(['read', 'unread']).optional()
        .describe('操作类型: read(标记已读), unread(标记未读)，默认 read'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const action = args.action || 'read';
      const ids = Array.isArray(args.report_ids) ? args.report_ids : [args.report_ids];
      if (ids.length > 100) throw new Error('最多只能操作 100 条数据');

      await makeDootaskRequest(token, 'GET', 'report/mark', { id: ids, action });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `已将 ${ids.length} 个报告标记为${action === 'read' ? '已读' : '未读'}`,
            action,
            affected_count: ids.length,
            report_ids: ids,
          }, null, 2),
        }],
      };
    },
  );

  return [
    listReceivedReports,
    getReportDetail,
    generateReportTemplate,
    createReport,
    listMyReports,
    markReportsRead,
  ];
}
