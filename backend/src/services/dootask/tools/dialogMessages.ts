/**
 * DooTask 富消息发送 + 消息管理工具（6 个）
 *
 * 与 dialogs.ts 的 search_dialogs / send_message / get_message_list 互补，覆盖：
 *   - send_file_message:     按 file_id 发已存在文件（不重复传输）
 *   - send_task_card:        发任务卡片到会话（dialog_id + task_id）
 *   - send_location_message: 发位置消息（lng/lat + 标题/地址/地图来源）
 *   - withdraw_message:      撤回自己发的消息（2 分钟内）
 *   - forward_message:       转发单条 / 批量消息到其他会话
 *   - mark_messages_read:    标记已读（按 msg_id 列表）/ 标记未读（dialog 级）
 *
 * 端点参考：dootask/app/Http/Controllers/Api/DialogController.php
 *   dialog/msg/sendfileid    (GET) 行 1502  入参 file_id, dialogids[]?, userids[]?, leave_message?
 *   dialog/msg/sendtaskid    (GET) 行 1542  入参 task_id, dialogids[]?, userids[]?, leave_message?
 *   dialog/msg/sendlocation  (GET) 行 1826  入参 dialog_id, type(baidu|amap|tencent), lng, lat, title, address?, distance?, thumb?
 *   dialog/msg/withdraw      (GET) 行 2014  入参 msg_id  ⚠ 必须本人发的；超时（settings.msg_rev 限制，默认 2 分钟）拒绝
 *   dialog/msg/forward       (GET) 行 2310  入参 msg_id 或 msg_ids[]（≤100），dialogids[]?, userids[]?, show_source?, leave_message?
 *   dialog/msg/read          (GET) 行 777   入参 id（逗号分隔的 msg_id 列表）       —— 按消息粒度标记已读
 *   dialog/msg/mark          (GET) 行 2180  入参 dialog_id, type(read|unread), after_msg_id? —— 整个会话级标记
 *
 * mark_messages_read 双语义设计：
 *   - action='read'   + msg_id[]    → dialog/msg/read   （按消息粒度，最常见用法）
 *   - action='read'   + dialog_id   → dialog/msg/mark type=read   （把整个会话标已读）
 *   - action='unread' + dialog_id   → dialog/msg/mark type=unread （会话级；dootask 不支持单条消息标未读）
 *   暴露给 LLM 的语义：单一工具 + action 字段，与 archive_task 的 archive/restore 翻译范式一致。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

const MAX_FORWARD_MSGS = 100;

export function buildDialogMessagesTools(ctx: ToolContext) {
  const sendFileMessage = tool(
    'send_file_message',
    `把已上传到 dootask 的文件以「文件卡片」形式发送到会话。文件本身不会重复传输 —— 仅引用 file_id（dootask 服务器侧已存在的文件 ID）。

【适用场景】
- 把之前用户上传过的合同/PDF/图片转发给同事或群
- AI 生成报告并保存到文件后，按 file_id 推送到指定对话

【⚠ 前置要求】
file_id 必须是当前用户有权访问的、已上传的文件。如果是新文件，要先经走 dootask 文件上传流程取得 file_id（本工具不负责上传）。

【收件人】
dialog_id（群聊或已有私聊）和 userid（私聊用户）至少传一个；可同时传两个，会一并发送。`,
    {
      file_id: z.number().min(1).describe('文件ID（dootask 文件系统中的 ID）'),
      dialog_id: z.number().optional().describe('目标会话ID（与 userid 至少一个）'),
      userid: z.number().optional().describe('目标用户ID，私聊（与 dialog_id 至少一个）'),
      leave_message: z.string().optional().describe('附带留言（可选，文件卡片下方追加文字）'),
    },
    async (args) => {
      if (args.dialog_id === undefined && args.userid === undefined) {
        throw new Error('send_file_message 至少需要 dialog_id 或 userid 之一');
      }
      const token = await ctx.getToken();
      const payload: Record<string, unknown> = { file_id: args.file_id };
      if (args.dialog_id !== undefined) payload.dialogids = [args.dialog_id];
      if (args.userid !== undefined) payload.userids = [args.userid];
      if (args.leave_message) payload.leave_message = args.leave_message;

      const data = await makeDootaskRequest(token, 'GET', 'dialog/msg/sendfileid', payload);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            file_id: args.file_id,
            dialog_id: args.dialog_id ?? null,
            userid: args.userid ?? null,
            result: data,
          }, null, 2),
        }],
      };
    },
  );

  const sendTaskCard = tool(
    'send_task_card',
    `把一个已存在的任务以「任务卡片」形式发送到会话。卡片可点击跳转到任务详情，常用于工作沟通中引用任务。

【适用场景】
- 用户问"@张三 看下这个任务" → 发送任务卡片到张三的私聊或所在群
- 在群里同步项目进度时引用具体任务，让大家一键打开
- AI 创建完任务后立即推送给负责人

【⚠ 前置要求】
task_id 必须是已存在且当前用户可见的任务。建议先用 get_task / list_tasks 确认 ID 正确。

【收件人】
dialog_id（群聊或已有私聊）和 userid（私聊用户）至少传一个；可同时传两个，会一并发送。`,
    {
      task_id: z.number().min(1).describe('任务ID（必须已存在）'),
      dialog_id: z.number().optional().describe('目标会话ID（与 userid 至少一个）'),
      userid: z.number().optional().describe('目标用户ID，私聊（与 dialog_id 至少一个）'),
      leave_message: z.string().optional().describe('附带留言（可选，任务卡片下方追加文字，例如"@张三 帮忙看下"）'),
    },
    async (args) => {
      if (args.dialog_id === undefined && args.userid === undefined) {
        throw new Error('send_task_card 至少需要 dialog_id 或 userid 之一');
      }
      const token = await ctx.getToken();
      const payload: Record<string, unknown> = { task_id: args.task_id };
      if (args.dialog_id !== undefined) payload.dialogids = [args.dialog_id];
      if (args.userid !== undefined) payload.userids = [args.userid];
      if (args.leave_message) payload.leave_message = args.leave_message;

      const data = await makeDootaskRequest(token, 'GET', 'dialog/msg/sendtaskid', payload);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            task_id: args.task_id,
            dialog_id: args.dialog_id ?? null,
            userid: args.userid ?? null,
            result: data,
          }, null, 2),
        }],
      };
    },
  );

  const sendLocationMessage = tool(
    'send_location_message',
    `发送地理位置消息到会话。位置以地图卡片形式呈现，含名称、地址（可选）、缩略图（可选）。

【必填参数】
- dialog_id, lng, lat, title 都是必填
- map_source 必填：'baidu' | 'amap' | 'tencent'，决定经纬度坐标系（百度/高德/腾讯地图各自坐标偏移不同，传错会导致位置漂移）

【适用场景】
- 同事之间分享聚餐地点 / 客户公司位置
- AI 助手回答"会议室在哪" → 发位置卡片便于导航
- 字段含义：title=位置名称（如"星巴克北京东路店"），address=详细地址（如"上海市黄浦区北京东路 123 号"）`,
    {
      dialog_id: z.number().min(1).describe('目标会话ID（位置消息必须发到具体对话，不支持仅 userid 直发）'),
      lng: z.number().min(-180).max(180).describe('经度，范围 -180~180'),
      lat: z.number().min(-90).max(90).describe('纬度，范围 -90~90'),
      title: z.string().min(1).describe('位置名称，例如"星巴克北京东路店"'),
      map_source: z.enum(['baidu', 'amap', 'tencent']).describe(
        '地图坐标系来源：百度/高德/腾讯。传错会导致位置漂移（不同地图供应商的经纬度偏移规则不同）'
      ),
      address: z.string().optional().describe('详细地址（可选）'),
      distance: z.number().optional().describe('距离当前位置（米，可选）'),
      thumb: z.string().optional().describe('缩略图 URL（可选）'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const payload: Record<string, unknown> = {
        dialog_id: args.dialog_id,
        type: args.map_source,
        lng: args.lng,
        lat: args.lat,
        title: args.title,
      };
      if (args.address !== undefined) payload.address = args.address;
      if (args.distance !== undefined) payload.distance = args.distance;
      if (args.thumb !== undefined) payload.thumb = args.thumb;

      const data = await makeDootaskRequest(token, 'GET', 'dialog/msg/sendlocation', payload);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            dialog_id: args.dialog_id,
            location: {
              title: args.title,
              lng: args.lng,
              lat: args.lat,
              map_source: args.map_source,
              address: args.address ?? null,
            },
            result: data,
          }, null, 2),
        }],
      };
    },
  );

  const withdrawMessage = tool(
    'withdraw_message',
    `撤回一条已发送的消息。撤回后所有人都看不到原内容（仅留"XX 撤回了一条消息"提示）。

【⚠ 严格限制】
- 只能撤回自己发的消息（msg_id 必须是当前 token 用户为发送人）
- 有时间窗口：dootask 默认仅 2 分钟内可撤回（受服务端 settings.msg_rev 限制），超时后端会拒绝并返回错误
- 自己与自己的对话（私聊自己）不受时间限制
- 机器人 token 不受时间限制

【适用场景】
- 用户说"我刚才那条消息发错了，撤回" → 调本工具
- AI 助手发现自己刚推送的消息内容有误时主动撤回

【失败处理】
若返回错误（如"超出可撤回时间"或"消息不存在"），不要重试 —— 时间已过，告知用户改为发更正消息。`,
    {
      msg_id: z.number().min(1).describe('要撤回的消息ID（必须是自己发的）'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'GET', 'dialog/msg/withdraw', {
        msg_id: args.msg_id,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: '消息已撤回',
            msg_id: args.msg_id,
            result: data,
          }, null, 2),
        }],
      };
    },
  );

  const forwardMessage = tool(
    'forward_message',
    `将一条或多条消息转发到其他会话（或私聊给其他用户）。支持单条转发和批量逐条转发。

【两种用法】
- 单条转发：传 msg_id（数字）
- 批量转发：传 msg_ids（数组，最多 100 条）—— 后端按 created_at 排序逐条转发

【收件人】
dialog_ids（多个会话）和 userids（多个用户私聊）至少一个；可同时传两边，会一并转发。

【适用场景】
- 把客户群里的需求消息转发给开发群
- 把领导通知一次性转发给多个下属
- AI 帮用户把"重要会议纪要"消息转发到多个项目群

【⚠ 限制】
- 部分消息类型不可转发（dootask 内部 unforwardable 列表，如某些系统消息）；批量转发时这些消息会被静默跳过
- 批量上限 100 条
- show_source=true 会在转发后的消息附上"转自 XX 群"溯源标记`,
    {
      msg_id: z.number().optional().describe('要转发的单条消息ID（与 msg_ids 二选一）'),
      msg_ids: z.array(z.number()).max(MAX_FORWARD_MSGS).optional().describe(
        `要批量转发的消息ID数组，最多 ${MAX_FORWARD_MSGS} 条（与 msg_id 二选一）`
      ),
      dialog_ids: z.array(z.number()).optional().describe('目标会话ID列表（与 userids 至少一个）'),
      userids: z.array(z.number()).optional().describe('目标用户ID列表，私聊（与 dialog_ids 至少一个）'),
      show_source: z.boolean().optional().describe('是否显示原消息来源（默认 false）'),
      leave_message: z.string().optional().describe('附带留言（仅在第一条转发后追加，批量场景不重复）'),
    },
    async (args) => {
      if (args.msg_id === undefined && (!args.msg_ids || args.msg_ids.length === 0)) {
        throw new Error('forward_message 需要 msg_id 或 msg_ids 之一');
      }
      if ((!args.dialog_ids || args.dialog_ids.length === 0)
        && (!args.userids || args.userids.length === 0)) {
        throw new Error('forward_message 需要 dialog_ids 或 userids 之一');
      }

      const token = await ctx.getToken();
      const payload: Record<string, unknown> = {};
      if (args.msg_ids && args.msg_ids.length > 0) {
        payload.msg_ids = args.msg_ids;
      } else if (args.msg_id !== undefined) {
        payload.msg_id = args.msg_id;
      }
      if (args.dialog_ids && args.dialog_ids.length > 0) payload.dialogids = args.dialog_ids;
      if (args.userids && args.userids.length > 0) payload.userids = args.userids;
      if (args.show_source !== undefined) payload.show_source = args.show_source ? 1 : 0;
      if (args.leave_message) payload.leave_message = args.leave_message;

      const data = await makeDootaskRequest(token, 'GET', 'dialog/msg/forward', payload);
      const forwardedMsgs = Array.isArray(data?.msgs) ? data.msgs : [];

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            forwarded_count: forwardedMsgs.length,
            target_dialog_ids: args.dialog_ids ?? [],
            target_userids: args.userids ?? [],
            result: data,
          }, null, 2),
        }],
      };
    },
  );

  const markMessagesRead = tool(
    'mark_messages_read',
    `标记消息已读 / 未读。

【两种语义】
- 标记已读（最常用）：传 msg_id 数组（一条或多条），action 默认 'read'
  例：用户问"把刚才那 3 条都标已读" → action='read', msg_id=[1,2,3]
- 标记会话已读：只传 dialog_id 不传 msg_id，整个对话内未读消息全部标已读
- 标记会话未读：dialog_id + action='unread'，把会话标"未读"红点（仅会话级，不能单条标未读）

【⚠ 参数约束】
- action='read' 时：msg_id 数组 或 dialog_id 至少传一个
- action='unread' 时：必须传 dialog_id（dootask 不支持单条消息标未读）

【适用场景】
- 用户在 AI 助手里浏览未读消息后，主动让 AI"全部标已读清掉红点"
- 用户说"这个群我先放着，标个未读提醒自己晚点处理" → action='unread' + dialog_id`,
    {
      action: z.enum(['read', 'unread']).optional().describe(
        "操作类型：'read'(默认) 标已读，'unread' 标未读"
      ),
      msg_id: z.array(z.number()).optional().describe(
        '消息ID数组（仅 action=read 有效；批量标已读时填）'
      ),
      dialog_id: z.number().optional().describe(
        '会话ID（action=unread 时必填；action=read 时可选，传则会话级全部已读）'
      ),
    },
    async (args) => {
      const action = args.action || 'read';
      const token = await ctx.getToken();

      if (action === 'unread') {
        if (args.dialog_id === undefined) {
          throw new Error("mark_messages_read action='unread' 必须传 dialog_id（dootask 不支持单条消息标未读）");
        }
        const data = await makeDootaskRequest(token, 'GET', 'dialog/msg/mark', {
          dialog_id: args.dialog_id,
          type: 'unread',
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              action: 'unread',
              message: '会话已标记为未读',
              dialog_id: args.dialog_id,
              result: data,
            }, null, 2),
          }],
        };
      }

      // action === 'read'
      const hasMsgIds = Array.isArray(args.msg_id) && args.msg_id.length > 0;
      const hasDialogId = args.dialog_id !== undefined;
      if (!hasMsgIds && !hasDialogId) {
        throw new Error("mark_messages_read action='read' 至少需要 msg_id 数组 或 dialog_id");
      }

      if (hasMsgIds) {
        // 按消息粒度：dialog/msg/read 接受逗号分隔字符串
        const idStr = args.msg_id!.join(',');
        const data = await makeDootaskRequest(token, 'GET', 'dialog/msg/read', { id: idStr });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              action: 'read',
              message: `已标记 ${args.msg_id!.length} 条消息为已读`,
              msg_id: args.msg_id,
              affected_dialogs: Array.isArray(data) ? data : [],
            }, null, 2),
          }],
        };
      }

      // hasDialogId only：会话级全部已读，走 dialog/msg/mark type=read
      const data = await makeDootaskRequest(token, 'GET', 'dialog/msg/mark', {
        dialog_id: args.dialog_id,
        type: 'read',
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            action: 'read',
            message: '会话内全部消息已标记为已读',
            dialog_id: args.dialog_id,
            result: data,
          }, null, 2),
        }],
      };
    },
  );

  return [
    sendFileMessage,
    sendTaskCard,
    sendLocationMessage,
    withdrawMessage,
    forwardMessage,
    markMessagesRead,
  ];
}
