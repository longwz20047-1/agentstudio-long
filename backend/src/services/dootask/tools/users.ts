/**
 * DooTask 用户工具（2 个）
 * 迁移源：dootask/electron/lib/mcp.js:257-409
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

export function buildUsersTools(ctx: ToolContext) {
  const getUsersBasic = tool(
    'get_users_basic',
    '批量获取用户基础信息（昵称、邮箱、头像等），支持 1-50 个用户。',
    {
      userids: z.array(z.number()).min(1).max(50)
        .describe('用户ID数组，至少1个，最多50个'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const ids = args.userids;
      const requestData = {
        userid: ids.length === 1 ? ids[0] : JSON.stringify(ids),
      };
      const data = await makeDootaskRequest(token, 'GET', 'users/basic', requestData);

      const rawList = Array.isArray(data)
        ? data
        : (Array.isArray((data as any)?.data) ? (data as any).data : []);

      const users = rawList.map((user: any) => ({
        userid: user.userid,
        nickname: user.nickname || '',
        email: user.email || '',
        userimg: user.userimg || '',
        profession: user.profession || '',
        department: user.department || [],
        department_name: user.department_name || '',
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ count: users.length, users }, null, 2),
        }],
      };
    },
  );

  const searchUsers = tool(
    'search_users',
    '按关键词搜索用户，支持按项目/对话范围筛选。用于不知道具体用户 ID 时的查找。',
    {
      keyword: z.string().min(1).describe('搜索关键词，支持昵称、邮箱、拼音等'),
      project_id: z.number().optional().describe('仅返回指定项目的成员'),
      dialog_id: z.number().optional().describe('仅返回指定对话的成员'),
      include_disabled: z.boolean().optional().describe('是否同时包含已离职/禁用用户'),
      include_bot: z.boolean().optional().describe('是否同时包含机器人账号'),
      with_department: z.boolean().optional().describe('是否返回部门信息'),
      page: z.number().optional().describe('页码，默认 1'),
      pagesize: z.number().optional().describe('每页数量，默认 20，最大 100'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const page = args.page && args.page > 0 ? args.page : 1;
      const pagesize = args.pagesize && args.pagesize > 0 ? Math.min(args.pagesize, 100) : 20;

      const keys: Record<string, unknown> = { key: args.keyword };
      if (args.project_id !== undefined) keys.project_id = args.project_id;
      if (args.dialog_id !== undefined) keys.dialog_id = args.dialog_id;
      if (args.include_disabled) keys.disable = 2;
      if (args.include_bot) keys.bot = 2;

      const requestData: Record<string, unknown> = { page, pagesize, keys };
      if (args.with_department) requestData.with_department = 1;

      const data = await makeDootaskRequest(token, 'GET', 'users/search', requestData);

      const d: any = data || {};
      let users: any[] = [];
      let total = 0;
      let perPage = pagesize;
      let currentPage = page;

      if (Array.isArray(d.data)) {
        users = d.data;
        total = d.total ?? users.length;
        perPage = d.per_page ?? perPage;
        currentPage = d.current_page ?? currentPage;
      } else if (Array.isArray(d)) {
        users = d;
        total = users.length;
      }

      const simplified = users.map((user: any) => ({
        userid: user.userid,
        nickname: user.nickname || '',
        email: user.email || '',
        tags: user.tags || [],
        department: user.department_info || user.department || '',
        online: user.online ?? null,
        identity: user.identity || '',
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total,
            page: currentPage,
            pagesize: perPage,
            users: simplified,
          }, null, 2),
        }],
      };
    },
  );

  return [getUsersBasic, searchUsers];
}
