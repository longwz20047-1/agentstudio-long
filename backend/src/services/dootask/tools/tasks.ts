/**
 * DooTask 任务工具（8 个）
 * 迁移源：dootask/electron/lib/mcp.js:412-900
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import { htmlToMarkdown, markdownToHtml } from '../htmlMd.js';
import type { ToolContext } from './types.js';

export function buildTasksTools(ctx: ToolContext) {
  const listTasks = tool(
    'list_tasks',
    '获取当前用户相关的任务列表（负责/协助/关注），支持按状态、项目、时间范围筛选和搜索。',
    {
      status: z.enum(['all', 'completed', 'uncompleted']).optional()
        .describe('任务状态: all(所有), completed(已完成), uncompleted(未完成)'),
      search: z.string().optional().describe('搜索关键词（可搜索任务ID、名称、描述）'),
      time: z.string().optional()
        .describe('时间范围: today/week/month/year 或自定义 "2025-12-12,2025-12-30"'),
      project_id: z.number().optional().describe('项目ID，只获取指定项目的任务'),
      parent_id: z.number().optional()
        .describe('主任务ID。>0:获取该主任务的子任务；-1:仅获取主任务；不传:所有任务'),
      page: z.number().optional().describe('页码，默认 1'),
      pagesize: z.number().optional().describe('每页数量，默认 20，最大 100'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = {
        page: args.page || 1,
        pagesize: args.pagesize || 20,
      };
      const keys: Record<string, unknown> = {};
      if (args.search) keys.name = args.search;
      if (args.status && args.status !== 'all') keys.status = args.status;
      if (Object.keys(keys).length > 0) requestData.keys = keys;
      if (args.time !== undefined) requestData.time = args.time;
      if (args.project_id !== undefined) requestData.project_id = args.project_id;
      if (args.parent_id !== undefined) requestData.parent_id = args.parent_id;

      const data = await makeDootaskRequest(token, 'GET', 'project/task/lists', requestData);

      const tasks = (data.data || []).map((t: any) => ({
        task_id: t.id,
        name: t.name,
        desc: t.desc || '无描述',
        dialog_id: t.dialog_id,
        status: t.complete_at ? '已完成' : '未完成',
        complete_at: t.complete_at || '未完成',
        end_at: t.end_at || '无截止时间',
        project_id: t.project_id,
        project_name: t.project_name || '',
        column_name: t.column_name || '',
        parent_id: t.parent_id,
        owners: t.task_user?.filter((u: any) => u.owner === 1).map((u: any) => ({ userid: u.userid })) || [],
        sub_num: t.sub_num || 0,
        sub_complete: t.sub_complete || 0,
        percent: t.percent || 0,
        created_at: t.created_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: data.total,
            page: data.current_page,
            pagesize: data.per_page,
            tasks,
          }, null, 2),
        }],
      };
    },
  );

  const getTask = tool(
    'get_task',
    '获取任务的完整详情，包括描述、内容、负责人、协助人、标签等。',
    { task_id: z.number().min(1).describe('任务ID') },
    async (args) => {
      const token = await ctx.getToken();
      const task = await makeDootaskRequest(token, 'GET', 'project/task/one', { task_id: args.task_id });

      let fullContent: string = task.desc || '无描述';
      try {
        const content = await makeDootaskRequest(token, 'GET', 'project/task/content', { task_id: args.task_id });
        if (content) {
          if (typeof content === 'object' && content.content) {
            fullContent = content.content;
          } else if (typeof content === 'string') {
            fullContent = content;
          }
        }
      } catch (err: any) {
        console.warn(`[dootask/get_task] Failed to get content: ${err?.message}`);
      }

      fullContent = htmlToMarkdown(fullContent);

      const detail = {
        task_id: task.id,
        name: task.name,
        desc: task.desc || '无描述',
        dialog_id: task.dialog_id,
        content: fullContent,
        status: task.complete_at ? '已完成' : '未完成',
        complete_at: task.complete_at || '未完成',
        project_id: task.project_id,
        project_name: task.project_name,
        column_id: task.column_id,
        column_name: task.column_name,
        parent_id: task.parent_id,
        start_at: task.start_at || '无开始时间',
        end_at: task.end_at || '无截止时间',
        flow_item_id: task.flow_item_id,
        flow_item_name: task.flow_item_name,
        visibility: task.visibility === 1 ? '公开' : '指定人员',
        owners: task.task_user?.filter((u: any) => u.owner === 1).map((u: any) => ({ userid: u.userid })) || [],
        assistants: task.task_user?.filter((u: any) => u.owner === 0).map((u: any) => ({ userid: u.userid })) || [],
        tags: task.task_tag?.map((t: any) => t.name) || [],
        created_at: task.created_at,
        updated_at: task.updated_at,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] };
    },
  );

  const completeTask = tool(
    'complete_task',
    '快速标记任务完成。主任务需所有子任务完成后才能标记。',
    { task_id: z.number().min(1).describe('要标记完成的任务ID') },
    async (args) => {
      const token = await ctx.getToken();
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const data = await makeDootaskRequest(token, 'POST', 'project/task/update', {
        task_id: args.task_id,
        complete_at: now,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: '任务已标记为完成',
            task_id: args.task_id,
            complete_at: data.complete_at,
          }, null, 2),
        }],
      };
    },
  );

  const createTask = tool(
    'create_task',
    `在指定项目中创建新任务。

【关于 column_id 的智能选择（用户未明确指定时强烈推荐）】
1. 若用户没指定 column_id：先调 get_project(project_id) 获取该项目的 columns 列表（含 column_id/name/sort）。
   列名通常代表项目阶段（如售前项目"线索接洽/方案设计/商务报价/合同签订/交付实施"）
   或工作流状态（"待办/进行中/已完成"）。
2. 根据用户描述的任务内容推理最匹配的列（例："写报价方案" → 商务报价列）。
3. 若现有列均无法合理匹配此任务（例如内容是"POC 演示" 但项目仅有线索/合同/交付列），
   不要擅自落到默认列，应先告知用户："此项目缺少『XX』类列，建议先新增列再创建任务"，
   征得同意后再调 create_column（待实现）或在现有最近似列中新建。
4. 仅当用户明确说"放默认列"或"不分类"时，才省略 column_id 走系统 default。`,
    {
      project_id: z.number().min(1).describe('项目ID'),
      name: z.string().min(1).describe('任务名称'),
      content: z.string().optional().describe('任务内容描述（Markdown 格式）'),
      owner: z.array(z.number()).optional().describe('负责人用户ID数组'),
      assist: z.array(z.number()).optional().describe('协助人员用户ID数组'),
      column_id: z.number().optional().describe(
        '看板列ID。建议先 get_project 查 columns 后选最匹配的传入；'
        + '若无合适列应建议用户新增；缺失则落系统 default 列（不推荐）。'
      ),
      start_at: z.string().optional().describe('开始时间 YYYY-MM-DD HH:mm:ss'),
      end_at: z.string().optional().describe('结束时间 YYYY-MM-DD HH:mm:ss'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = {
        project_id: args.project_id,
        name: args.name,
      };
      if (args.content) requestData.content = markdownToHtml(args.content);
      if (args.owner) requestData.owner = args.owner;
      if (args.assist) requestData.assist = args.assist;
      if (args.column_id) requestData.column_id = args.column_id;
      if (args.start_at) requestData.start_at = args.start_at;
      if (args.end_at) requestData.end_at = args.end_at;

      const task = await makeDootaskRequest(token, 'POST', 'project/task/add', requestData);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: '任务创建成功',
            task: {
              id: task.id,
              name: task.name,
              project_id: task.project_id,
              column_id: task.column_id,
              created_at: task.created_at,
            },
          }, null, 2),
        }],
      };
    },
  );

  const updateTask = tool(
    'update_task',
    `更新任务属性，只需提供要修改的字段。

【移动列（column_id 变更）的最佳实践】
当用户要把任务移动到某列（如"移到已完成"、"放进商务报价"），先调 get_task 拿当前 task 的 project_id，
再调 get_project(project_id) 拿 columns 列表，按用户描述的列名推理出目标 column_id。
若用户提及的列不存在（如"移到 POC 演示列" 但该项目无此列），应告知用户并建议先新增列。`,
    {
      task_id: z.number().min(1).describe('任务ID'),
      name: z.string().optional().describe('任务名称'),
      content: z.string().optional().describe('任务内容描述（Markdown 格式）'),
      owner: z.array(z.number()).optional().describe('负责人用户ID数组'),
      assist: z.array(z.number()).optional().describe('协助人员用户ID数组'),
      column_id: z.number().optional().describe(
        '移动到指定列ID。改变列归属前建议先 get_project 拿 columns 找正确 column_id；'
        + '若用户提及的列不存在应先建议新增列。'
      ),
      start_at: z.string().optional().describe('开始时间 YYYY-MM-DD HH:mm:ss'),
      end_at: z.string().optional().describe('结束时间 YYYY-MM-DD HH:mm:ss'),
      complete_at: z.union([z.string(), z.boolean()]).optional()
        .describe('完成时间。传时间字符串标记完成，传 false 标记未完成'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = { task_id: args.task_id };
      if (args.name !== undefined) requestData.name = args.name;
      if (args.content !== undefined) requestData.content = markdownToHtml(args.content);
      if (args.owner !== undefined) requestData.owner = args.owner;
      if (args.assist !== undefined) requestData.assist = args.assist;
      if (args.column_id !== undefined) requestData.column_id = args.column_id;
      if (args.start_at !== undefined) requestData.start_at = args.start_at;
      if (args.end_at !== undefined) requestData.end_at = args.end_at;
      if (args.complete_at !== undefined) requestData.complete_at = args.complete_at;

      const task = await makeDootaskRequest(token, 'POST', 'project/task/update', requestData);

      const updates: string[] = [];
      if (args.name !== undefined) updates.push('名称');
      if (args.content !== undefined) updates.push('内容');
      if (args.owner !== undefined) updates.push('负责人');
      if (args.assist !== undefined) updates.push('协助人员');
      if (args.column_id !== undefined) updates.push('列');
      if (args.start_at !== undefined || args.end_at !== undefined) updates.push('时间');
      if (args.complete_at !== undefined) updates.push('完成状态');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `任务已更新: ${updates.join('、')}`,
            task: {
              id: task.id,
              name: task.name,
              status: task.complete_at ? '已完成' : '未完成',
              complete_at: task.complete_at || '未完成',
              updated_at: task.updated_at,
            },
          }, null, 2),
        }],
      };
    },
  );

  const createSubTask = tool(
    'create_sub_task',
    '为指定主任务新增子任务，自动继承主任务所属项目与看板列配置。',
    {
      task_id: z.number().min(1).describe('主任务ID'),
      name: z.string().min(1).describe('子任务名称'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const subTask = await makeDootaskRequest(token, 'POST', 'project/task/addsub', {
        task_id: args.task_id,
        name: args.name,
      }) || {};
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            sub_task: {
              id: subTask.id,
              name: subTask.name,
              project_id: subTask.project_id,
              parent_id: subTask.parent_id,
              column_id: subTask.column_id,
              start_at: subTask.start_at,
              end_at: subTask.end_at,
              created_at: subTask.created_at,
            },
          }, null, 2),
        }],
      };
    },
  );

  const getTaskFiles = tool(
    'get_task_files',
    '获取指定任务的附件列表，包含文件名称、大小、下载地址等信息。',
    { task_id: z.number().min(1).describe('任务ID') },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'GET', 'project/task/files', { task_id: args.task_id });
      const files = Array.isArray(data) ? data : [];
      const normalized = files.map((f: any) => ({
        file_id: f.id,
        name: f.name,
        ext: f.ext,
        size: f.size,
        url: f.path,
        thumb: f.thumb,
        userid: f.userid,
        download_count: f.download,
        created_at: f.created_at,
      }));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ task_id: args.task_id, files: normalized }, null, 2),
        }],
      };
    },
  );

  const deleteTask = tool(
    'delete_task',
    '删除或还原任务。默认执行删除，可通过 action=recovery 将任务从回收站恢复。',
    {
      task_id: z.number().min(1).describe('任务ID'),
      action: z.enum(['delete', 'recovery']).optional()
        .describe('操作类型：delete(默认) 删除，recovery 还原'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const action = args.action || 'delete';
      const data = await makeDootaskRequest(token, 'POST', 'project/task/remove', {
        task_id: args.task_id,
        type: action,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            action,
            task_id: args.task_id,
            data,
          }, null, 2),
        }],
      };
    },
  );

  return [listTasks, getTask, completeTask, createTask, updateTask, createSubTask, getTaskFiles, deleteTask];
}
