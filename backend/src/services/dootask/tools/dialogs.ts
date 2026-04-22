/**
 * DooTask 对话工具（3 个）
 * 迁移源：dootask/electron/lib/mcp.js:1170-1381
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest, DootaskApiError } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

export function buildDialogsTools(ctx: ToolContext) {
  const searchDialogs = tool(
    'search_dialogs',
    '按名称搜索群聊或联系人对话。',
    { keyword: z.string().min(1).describe('搜索关键词') },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'GET', 'dialog/search', {
        key: args.keyword,
        dialog_only: 1,
      });
      const dialogs = Array.isArray(data) ? data : [];
      const simplified = dialogs.map((d: any) => {
        const item: Record<string, unknown> = {
          type: d.type,
          name: d.name,
          last_at: d.last_at,
        };
        if (typeof d.id === 'string' && d.id.startsWith('u:')) {
          item.userid = parseInt(d.id.slice(2), 10);
        } else {
          item.dialog_id = d.id;
          if (d.type === 'user' && d.dialog_user?.userid) {
            item.userid = d.dialog_user.userid;
          }
        }
        return item;
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ count: simplified.length, dialogs: simplified }, null, 2),
        }],
      };
    },
  );

  const sendMessage = tool(
    'send_message',
    '发送消息到指定对话（私聊或群聊）。',
    {
      dialog_id: z.number().optional().describe('对话ID，群聊或已有私聊时使用'),
      userid: z.number().optional().describe('用户ID，私聊时使用'),
      text: z.string().min(1).describe('消息内容'),
      text_type: z.enum(['md', 'html']).optional().describe('消息格式，默认 md'),
      silence: z.boolean().optional().describe('静默发送，不触发提醒'),
    },
    async (args) => {
      const token = await ctx.getToken();
      let dialogId = args.dialog_id;
      if (!dialogId && args.userid) {
        const openData = await makeDootaskRequest(token, 'GET', 'dialog/open/user', { userid: args.userid });
        dialogId = openData?.id;
        if (!dialogId) throw new Error('无法创建对话');
      }
      if (!dialogId) throw new Error('请提供 dialog_id 或 userid');

      const payload: Record<string, unknown> = {
        dialog_id: dialogId,
        text: args.text,
        text_type: args.text_type || 'md',
      };
      if (args.silence !== undefined) payload.silence = args.silence ? 'yes' : 'no';

      const sendData = await makeDootaskRequest(token, 'POST', 'dialog/msg/sendtext', payload);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            dialog_id: dialogId,
            message: sendData,
          }, null, 2),
        }],
      };
    },
  );

  const getMessageList = tool(
    'get_message_list',
    '获取指定对话的消息记录。',
    {
      dialog_id: z.number().optional().describe('对话ID'),
      userid: z.number().optional().describe('用户ID，获取与该用户的私聊记录'),
      msg_id: z.number().optional().describe('围绕某条消息加载'),
      prev_id: z.number().optional().describe('获取此消息之前的历史'),
      next_id: z.number().optional().describe('获取此消息之后的记录'),
      msg_type: z.enum(['tag', 'todo', 'link', 'text', 'image', 'file', 'record', 'meeting']).optional()
        .describe('按类型筛选'),
      take: z.number().optional().describe('数量，最大 100'),
    },
    async (args) => {
      const token = await ctx.getToken();
      let dialogId = args.dialog_id;
      if (!dialogId && args.userid) {
        try {
          const openData = await makeDootaskRequest(token, 'GET', 'dialog/open/user', { userid: args.userid });
          dialogId = openData?.id;
        } catch (err) {
          if (err instanceof DootaskApiError) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ userid: args.userid, count: 0, messages: [] }, null, 2),
              }],
            };
          }
          throw err;
        }
        if (!dialogId) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ userid: args.userid, count: 0, messages: [] }, null, 2),
            }],
          };
        }
      }
      if (!dialogId) throw new Error('请提供 dialog_id 或 userid');

      const requestData: Record<string, unknown> = { dialog_id: dialogId };
      if (args.msg_id !== undefined) requestData.msg_id = args.msg_id;
      if (args.prev_id !== undefined) requestData.prev_id = args.prev_id;
      if (args.next_id !== undefined) requestData.next_id = args.next_id;
      if (args.msg_type !== undefined) requestData.msg_type = args.msg_type;
      if (args.take !== undefined) requestData.take = Math.min(Math.max(args.take, 1), 100);

      const data = await makeDootaskRequest(token, 'GET', 'dialog/msg/list', requestData);
      const messages = Array.isArray(data?.list) ? data.list : [];

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            dialog_id: dialogId,
            count: messages.length,
            messages,
          }, null, 2),
        }],
      };
    },
  );

  return [searchDialogs, sendMessage, getMessageList];
}
