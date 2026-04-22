/**
 * DooTask 项目工具（4 个）
 * 迁移源：dootask/electron/lib/mcp.js:902-1167
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

export function buildProjectsTools(ctx: ToolContext) {
  const listProjects = tool(
    'list_projects',
    '获取当前用户可访问的项目列表，支持按归档状态筛选、搜索项目名称。',
    {
      archived: z.enum(['no', 'yes', 'all']).optional()
        .describe('归档状态: no(未归档), yes(已归档), all(全部)，默认 no'),
      search: z.string().optional().describe('搜索关键词（可搜索项目名称）'),
      page: z.number().optional().describe('页码，默认 1'),
      pagesize: z.number().optional().describe('每页数量，默认 20'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = {
        archived: args.archived || 'no',
        page: args.page || 1,
        pagesize: args.pagesize || 20,
      };
      if (args.search) requestData.keys = { name: args.search };

      const data = await makeDootaskRequest(token, 'GET', 'project/lists', requestData);

      const projects = (data.data || []).map((p: any) => ({
        project_id: p.id,
        name: p.name,
        desc: p.desc || '无描述',
        dialog_id: p.dialog_id,
        archived_at: p.archived_at || '未归档',
        owner_userid: p.owner_userid || 0,
        created_at: p.created_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: data.total,
            page: data.current_page,
            pagesize: data.per_page,
            projects,
          }, null, 2),
        }],
      };
    },
  );

  const getProject = tool(
    'get_project',
    '获取指定项目的完整详细信息，包括项目描述、所有看板列、成员列表及权限等。比 list_projects 返回更详细的信息。',
    { project_id: z.number().min(1).describe('项目ID') },
    async (args) => {
      const token = await ctx.getToken();
      // 并行获取项目 + columns（任一失败不阻塞另一个）
      const [project, columnsResult] = await Promise.all([
        makeDootaskRequest(token, 'GET', 'project/one', { project_id: args.project_id }),
        makeDootaskRequest(token, 'GET', 'project/column/lists', { project_id: args.project_id })
          .catch((err: any) => {
            console.warn(`[dootask/get_project] columns fetch failed: ${err?.message}`);
            return null;
          }),
      ]);

      const columns = columnsResult?.data || [];

      const detail = {
        project_id: project.id,
        name: project.name,
        desc: project.desc || '无描述',
        dialog_id: project.dialog_id,
        archived_at: project.archived_at || '未归档',
        owner_userid: project.owner_userid,
        columns: columns.map((c: any) => ({
          column_id: c.id,
          name: c.name,
          sort: c.sort,
        })),
        members: project.project_user?.map((u: any) => ({
          userid: u.userid,
          owner: u.owner === 1 ? '管理员' : '成员',
        })) || [],
        created_at: project.created_at,
        updated_at: project.updated_at,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] };
    },
  );

  const createProject = tool(
    'create_project',
    '创建新项目，可选设置项目描述、初始化列及流程状态。',
    {
      name: z.string().min(2).describe('项目名称，至少 2 个字符'),
      desc: z.string().optional().describe('项目描述'),
      columns: z.union([z.string(), z.array(z.string())]).optional()
        .describe('初始化列名称，字符串使用逗号分隔，也可直接传字符串数组'),
      flow: z.enum(['open', 'close']).optional().describe('是否开启流程，open/close，默认 close'),
      personal: z.boolean().optional().describe('是否创建个人项目，仅支持创建一个个人项目'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = { name: args.name };
      if (args.desc !== undefined) requestData.desc = args.desc;
      if (args.columns !== undefined) {
        requestData.columns = Array.isArray(args.columns) ? args.columns.join(',') : args.columns;
      }
      if (args.flow !== undefined) requestData.flow = args.flow;
      if (args.personal !== undefined) requestData.personal = args.personal ? 1 : 0;

      const project = await makeDootaskRequest(token, 'POST', 'project/add', requestData) || {};
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project: {
              id: project.id,
              name: project.name,
              desc: project.desc || '',
              columns: project.projectColumn || [],
              created_at: project.created_at,
            },
          }, null, 2),
        }],
      };
    },
  );

  const updateProject = tool(
    'update_project',
    '修改项目信息（名称、描述、归档策略等）。若未传 name 将自动沿用项目当前名称。',
    {
      project_id: z.number().min(1).describe('项目ID'),
      name: z.string().optional().describe('项目名称'),
      desc: z.string().optional().describe('项目描述'),
      archive_method: z.string().optional().describe('归档方式'),
      archive_days: z.number().optional().describe('自动归档天数'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = { project_id: args.project_id };

      if (args.name && args.name.trim().length > 0) {
        requestData.name = args.name;
      } else {
        const current = await makeDootaskRequest(token, 'GET', 'project/one', { project_id: args.project_id });
        const currentName = current?.name;
        if (!currentName) throw new Error('无法获取项目名称，请手动提供 name 参数');
        requestData.name = currentName;
      }

      if (args.desc !== undefined) requestData.desc = args.desc;
      if (args.archive_method !== undefined) requestData.archive_method = args.archive_method;
      if (args.archive_days !== undefined) requestData.archive_days = args.archive_days;

      // mcp.js 原实现用 GET（非 REST，Dootask 约定非 REST 路由见 InvokeController）
      const project = await makeDootaskRequest(token, 'GET', 'project/update', requestData) || {};

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project: {
              id: project.id,
              name: project.name,
              desc: project.desc || '',
              archived_at: project.archived_at || null,
              archive_method: project.archive_method ?? requestData.archive_method ?? null,
              archive_days: project.archive_days ?? requestData.archive_days ?? null,
              updated_at: project.updated_at,
            },
          }, null, 2),
        }],
      };
    },
  );

  return [listProjects, getProject, createProject, updateProject];
}
