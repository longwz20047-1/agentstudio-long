/**
 * DooTask 文件工具（4 个）
 * 迁移源：dootask/electron/lib/mcp.js:1803-2022
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

interface FileSummary {
  file_id: any;
  name: string;
  type: string;
  ext: string;
  size: number;
  pid: number;
  userid: number;
  created_id: number;
  share: boolean;
  created_at: string;
  updated_at: string;
}

function summarizeFile(f: any): FileSummary {
  return {
    file_id: f.id,
    name: f.name,
    type: f.type,
    ext: f.ext || '',
    size: f.size || 0,
    pid: f.pid,
    userid: f.userid,
    created_id: f.created_id,
    share: !!f.share,
    created_at: f.created_at,
    updated_at: f.updated_at,
  };
}

export function buildFilesTools(ctx: ToolContext) {
  const listFiles = tool(
    'list_files',
    '获取用户文件列表，支持按父级文件夹筛选。',
    { pid: z.number().optional().describe('父级文件夹ID，0 或不传表示根目录') },
    async (args) => {
      const token = await ctx.getToken();
      const pid = args.pid !== undefined ? args.pid : 0;
      const data = await makeDootaskRequest(token, 'GET', 'file/lists', { pid });
      const files = Array.isArray(data) ? data : [];
      const simplified = files.map(summarizeFile);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ pid, total: simplified.length, files: simplified }, null, 2),
        }],
      };
    },
  );

  const searchFiles = tool(
    'search_files',
    '按关键词搜索用户文件系统中的文件，支持搜索文件名称、文件ID或分享链接。搜索范围：自己创建的文件和共享给自己的文件。',
    {
      keyword: z.string().min(1).describe('搜索关键词'),
      take: z.number().optional().describe('返回数量，默认 50，最大 100'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const take = args.take && args.take > 0 ? Math.min(args.take, 100) : 50;
      const data = await makeDootaskRequest(token, 'GET', 'file/search', {
        key: args.keyword,
        take,
      });
      const files = Array.isArray(data) ? data : [];
      const simplified = files.map(summarizeFile);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            keyword: args.keyword,
            total: simplified.length,
            files: simplified,
          }, null, 2),
        }],
      };
    },
  );

  const getFileDetail = tool(
    'get_file_detail',
    '获取文件详情，包括类型、大小、正文内容、共享状态等。',
    {
      file_id: z.union([z.number(), z.string()]).describe('文件ID 或分享码'),
      with_content: z.boolean().optional().describe('是否提取文本内容'),
      text_offset: z.number().optional().describe('文本起始位置'),
      text_limit: z.number().optional().describe('获取长度，默认 50000，最大 200000'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = {
        id: args.file_id,
        with_url: 'yes',
      };
      if (args.with_content) {
        requestData.with_text = 'yes';
        if (args.text_offset !== undefined) requestData.text_offset = args.text_offset;
        if (args.text_limit !== undefined) requestData.text_limit = Math.min(args.text_limit, 200000);
      }
      const file = await makeDootaskRequest(token, 'GET', 'file/one', requestData);
      const detail: Record<string, unknown> = {
        ...summarizeFile(file),
        content_url: file.content_url || null,
      };
      if (file.text_content) {
        if (file.text_content.error) {
          detail.text_error = file.text_content.error;
        } else {
          detail.text_content = file.text_content.content;
          detail.text_total_length = file.text_content.total_length;
          detail.text_offset = file.text_content.offset;
          detail.text_limit = file.text_content.limit;
          detail.text_has_more = file.text_content.has_more;
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] };
    },
  );

  const fetchFileContent = tool(
    'fetch_file_content',
    '通过文件路径获取文本内容。',
    {
      path: z.string().describe('系统内文件路径或URL'),
      offset: z.number().optional().describe('起始位置'),
      limit: z.number().optional().describe('获取长度，默认 50000，最大 200000'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = { path: args.path };
      if (args.offset !== undefined) requestData.offset = args.offset;
      if (args.limit !== undefined) requestData.limit = Math.min(args.limit, 200000);

      const data = await makeDootaskRequest(token, 'GET', 'file/fetch', requestData);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  return [listFiles, searchFiles, getFileDetail, fetchFileContent];
}
