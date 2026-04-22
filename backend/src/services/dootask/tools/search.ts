/**
 * DooTask 智能搜索工具（1 个）
 * 迁移源：dootask/electron/lib/mcp.js:2025-2216
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

type SearchType = 'task' | 'project' | 'file' | 'contact' | 'message';

export function buildSearchTools(ctx: ToolContext) {
  const intelligentSearch = tool(
    'intelligent_search',
    '统一搜索工具，可搜索任务、项目、文件、联系人、消息。支持语义搜索。',
    {
      keyword: z.string().min(1).describe('搜索关键词'),
      types: z.array(z.enum(['task', 'project', 'file', 'contact', 'message'])).optional()
        .describe('搜索类型数组，不传则搜索全部类型'),
      search_type: z.enum(['text', 'vector', 'hybrid']).optional()
        .describe('搜索模式: text(文本匹配), vector(语义搜索), hybrid(混合搜索，默认)'),
      take: z.number().optional().describe('每种类型获取数量，默认 10，最大 50'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const keyword = args.keyword;
      const searchType = args.search_type || 'hybrid';
      const take = args.take && args.take > 0 ? Math.min(args.take, 50) : 10;
      const types: SearchType[] = args.types && args.types.length > 0
        ? args.types
        : ['task', 'project', 'file', 'contact', 'message'];

      const results: Record<string, any[]> = {
        tasks: [],
        projects: [],
        files: [],
        contacts: [],
        messages: [],
      };

      const requestData = { key: keyword, search_type: searchType, take };

      const safeSearch = async (endpoint: string, bucket: string, mapper: (x: any) => any) => {
        try {
          const data = await makeDootaskRequest(token, 'GET', endpoint, requestData);
          if (Array.isArray(data)) {
            results[bucket] = data.map(mapper);
          }
        } catch (err: any) {
          console.warn(`[intelligent_search] ${endpoint} failed:`, err?.message || err);
        }
      };

      const promises: Array<Promise<void>> = [];
      if (types.includes('task')) {
        promises.push(safeSearch('search/task', 'tasks', (t: any) => ({
          task_id: t.id,
          name: t.name,
          desc: t.desc || '',
          content_preview: t.content_preview || '',
          status: t.complete_at ? '已完成' : '未完成',
          project_id: t.project_id,
          parent_id: t.parent_id || 0,
          project_name: t.project_name || '',
          end_at: t.end_at || '',
          relevance: t.relevance || 0,
        })));
      }
      if (types.includes('project')) {
        promises.push(safeSearch('search/project', 'projects', (p: any) => ({
          project_id: p.id,
          name: p.name,
          desc: p.desc || '',
          desc_preview: p.desc_preview || '',
          archived: !!p.archived_at,
          relevance: p.relevance || 0,
        })));
      }
      if (types.includes('file')) {
        promises.push(safeSearch('search/file', 'files', (f: any) => ({
          file_id: f.id,
          name: f.name,
          type: f.type,
          ext: f.ext || '',
          size: f.size || 0,
          content_preview: f.content_preview || '',
          relevance: f.relevance || 0,
        })));
      }
      if (types.includes('contact')) {
        promises.push(safeSearch('search/contact', 'contacts', (u: any) => ({
          userid: u.userid,
          nickname: u.nickname || '',
          email: u.email || '',
          profession: u.profession || '',
          introduction_preview: u.introduction_preview || '',
          relevance: u.relevance || 0,
        })));
      }
      if (types.includes('message')) {
        promises.push(safeSearch('search/message', 'messages', (m: any) => ({
          msg_id: m.id,
          dialog_id: m.dialog_id,
          userid: m.userid,
          nickname: m.user?.nickname || '',
          type: m.type || '',
          content_preview: m.content_preview || m.msg || '',
          created_at: m.created_at || '',
          relevance: m.relevance || 0,
        })));
      }

      await Promise.all(promises);

      const totalCount =
        results.tasks.length +
        results.projects.length +
        results.files.length +
        results.contacts.length +
        results.messages.length;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            keyword,
            search_type: searchType,
            types_searched: types,
            results,
            total_count: totalCount,
            summary: {
              tasks: results.tasks.length,
              projects: results.projects.length,
              files: results.files.length,
              contacts: results.contacts.length,
              messages: results.messages.length,
            },
          }, null, 2),
        }],
      };
    },
  );

  return [intelligentSearch];
}
