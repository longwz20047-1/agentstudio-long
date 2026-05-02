/**
 * DooTask 任务生命周期工具（3 个）
 *
 * 与 tasks.ts 的 CRUD 工具互补，覆盖：
 *   - archive_task: 归档/还原（隐藏不删，可恢复）
 *   - move_task:    跨项目+跨列+换工作流状态+改 owner/assist+设完成状态（五合一）
 *   - copy_task:    复制任务到目标项目+列（保留原任务）
 *
 * 端点参考：dootask/app/Http/Controllers/Api/ProjectController.php:2796-3210
 *   project/task/archived  (GET)   入参 task_id, type=add|recovery（默认 add）
 *                                   ⚠ 拒绝子任务（parent_id>0）：返"子任务不支持此功能"
 *   project/task/move      (GET)   入参 task_id, project_id, column_id, flow_item_id, owner[], assist[], completed?
 *                                   ⚠ 目标项目有工作流时 flow_item_id 必填，否则 code=102
 *                                   ⚠ project_id+column_id 与原一致 → noop（成功但啥都没动）
 *                                   ⚠ 子任务跟随主任务一起移动，响应是 [main, ...subs]
 *   project/task/copy      (POST)  入参同 move
 *                                   ⚠ 同样的 flow_item_id 约束
 *                                   ⚠ 项目内未完成任务>2000 或单列未完成>500 时拒绝
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

export function buildTaskLifecycleTools(ctx: ToolContext) {
  const archiveTask = tool(
    'archive_task',
    `归档或恢复任务。归档 ≠ 删除：归档后任务从常规列表隐藏但保留所有数据，可随时 restore；delete_task 则进回收站（最终可彻底清理，不可逆）。

【适用场景】
- archive: 任务已完成或暂时搁置，不想再看到但要保留历史（例如已完成的迭代任务、暂缓的 idea）
- restore: 把之前归档的任务从归档区拉回来重新激活

【⚠ 子任务限制】
dootask 后端拒绝对子任务执行此操作（会返回"子任务不支持此功能"）。如果不确定，建议先调 get_task 看 parent_id 字段：parent_id>0 即子任务，需要先用 update_task 或其他方式调整，或直接对父任务归档（子任务会跟随）。

【与 delete_task 区分】
- archive_task: 隐藏不删，可恢复，适合"暂时不看"
- delete_task:  进回收站，可还原但语义上是"要清掉"`,
    {
      task_id: z.number().min(1).describe('任务ID'),
      action: z.enum(['archive', 'restore']).optional()
        .describe('操作类型：archive(默认) 归档，restore 从归档恢复'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const action = args.action || 'archive';
      // dootask 后端用 type='add'/'recovery'，这里翻译成更直观的 archive/restore 暴露给 LLM
      const type = action === 'archive' ? 'add' : 'recovery';

      const data = await makeDootaskRequest(token, 'GET', 'project/task/archived', {
        task_id: args.task_id,
        type,
      }) || {};

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            action,
            message: action === 'archive' ? '任务已归档' : '任务已从归档恢复',
            task: {
              task_id: data.id,
              archived_at: data.archived_at || null,
              archived_userid: data.archived_userid || null,
            },
          }, null, 2),
        }],
      };
    },
  );

  const moveTask = tool(
    'move_task',
    `任务移动 —— 五合一复合操作：跨项目 + 跨列 + 换工作流状态 + 改 owner/assist + 设完成状态。

【适用场景】
- 任务从 A 项目转到 B 项目（跨项目）
- 同项目跨列且需同时改负责人 / 协助人 / 完成状态（复合操作）
- 单纯换列建议改用 update_task(column_id=X)，更轻量

【强烈推荐的调用前置链路】
1. 先 get_task(task_id) 看当前 project_id / column_id / parent_id（确认不是想 noop）
2. 再 get_project(target_project_id) 或 list_project_columns(target_project_id) 找目标 column_id
3. 检查目标项目是否有工作流（get_project 返回的 flow 字段或调 task/flow 端点）：
   - 若有工作流定义，flow_item_id 必填，否则后端返 code=102 "请选择移动后状态"
   - 若无工作流，可省 flow_item_id，并可用 completed 控制完成状态

【⚠ 已知陷阱】
- target_project_id + target_column_id 与当前完全一致时返回 success 但实际 noop —— 应改用 update_task
- 子任务会跟随主任务一起移动到目标项目+列，响应中的 affected_tasks 数组首项是主任务，其余是子任务
- owner 和 assist 数组要传"目标项目里的成员 userid"，后端会过滤掉非项目成员`,
    {
      task_id: z.number().min(1).describe('要移动的任务ID'),
      target_project_id: z.number().min(1).describe('目标项目ID（可与当前同项目）'),
      target_column_id: z.number().min(1).describe(
        '目标列ID。先调 get_project / list_project_columns(target_project_id) 拿正确 column_id'
      ),
      flow_item_id: z.number().optional().describe(
        '目标工作流状态ID。目标项目有工作流时必填（否则返回 code=102）；'
        + '可调 get_project 或 task/flow 端点查可选 flow_items'
      ),
      owner: z.array(z.number()).optional().describe('新负责人 userid 数组（可选，仅传想覆盖时）'),
      assist: z.array(z.number()).optional().describe('新协助人 userid 数组（可选，仅传想覆盖时）'),
      completed: z.boolean().optional()
        .describe('是否标记完成。仅在目标项目无工作流时生效；true=完成，false=未完成，不传=不改'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = {
        task_id: args.task_id,
        project_id: args.target_project_id,
        column_id: args.target_column_id,
      };
      if (args.flow_item_id !== undefined) requestData.flow_item_id = args.flow_item_id;
      if (args.owner !== undefined) requestData.owner = args.owner;
      if (args.assist !== undefined) requestData.assist = args.assist;
      if (args.completed !== undefined) requestData.completed = args.completed;

      const data = await makeDootaskRequest(token, 'GET', 'project/task/move', requestData);

      // dootask 返回 array：[mainTask, ...subTasks]；noop 时返 { id: task_id }
      let mainTask: any = null;
      const subTasks: any[] = [];
      let noop = false;

      if (Array.isArray(data) && data.length > 0) {
        mainTask = data[0];
        for (let i = 1; i < data.length; i++) subTasks.push(data[i]);
      } else if (data && typeof data === 'object') {
        // noop 分支：只有 { id }
        noop = true;
        mainTask = data;
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            noop,
            message: noop
              ? '目标位置与当前一致，未实际移动；如只想改其他属性请用 update_task'
              : `任务已移动到项目 ${args.target_project_id} 列 ${args.target_column_id}`
                + (subTasks.length > 0 ? `，含 ${subTasks.length} 个子任务跟随` : ''),
            main_task: mainTask ? {
              task_id: mainTask.id,
              project_id: mainTask.project_id,
              project_name: mainTask.project_name,
              column_id: mainTask.column_id,
              column_name: mainTask.column_name,
            } : null,
            sub_tasks: subTasks.map((t: any) => ({
              task_id: t.id,
              project_id: t.project_id,
              column_id: t.column_id,
              column_name: t.column_name,
              project_name: t.project_name,
            })),
          }, null, 2),
        }],
      };
    },
  );

  const copyTask = tool(
    'copy_task',
    `复制任务到目标项目+列，原任务保留不动；副本是新任务（新 task_id），含原任务的内容、文件、标签、用户关系。

【与 move_task 的差别】
- copy_task: 保留原任务 + 新建副本 → 适合"模板化"场景（把这个任务复制 N 份分给不同项目用）
- move_task: 原任务被移走 → 适合任务归属变更

【适用场景】
- 把某个标准化任务（如"周会准备 SOP"）复制到多个项目作为模板
- 任务跨项目克隆，原项目保留以便对照
- 同项目内复制一份相似任务，再改动副本

【调用前置链路（同 move_task）】
1. get_project(target_project_id) / list_project_columns(target_project_id) 找 column_id
2. 看目标项目是否有工作流，决定 flow_item_id 是否要传

【⚠ 陷阱】
- 目标项目有工作流时 flow_item_id 必填（否则 code=102）
- 目标项目内未完成任务>2000，或目标列未完成任务>500 时后端会拒绝复制
- owner / assist 会被后端过滤为目标项目成员的 userid（非项目成员会被丢弃）`,
    {
      task_id: z.number().min(1).describe('要复制的源任务ID'),
      target_project_id: z.number().min(1).describe('目标项目ID（可与源同项目）'),
      target_column_id: z.number().min(1).describe(
        '目标列ID。先调 get_project / list_project_columns(target_project_id) 拿正确 column_id'
      ),
      flow_item_id: z.number().optional().describe(
        '目标工作流状态ID。目标项目有工作流时必填（否则返回 code=102）'
      ),
      owner: z.array(z.number()).optional().describe('副本的负责人 userid 数组（可选）'),
      assist: z.array(z.number()).optional().describe('副本的协助人 userid 数组（可选）'),
      completed: z.boolean().optional()
        .describe('副本是否标记完成。仅在目标项目无工作流时生效；不传=保持原状态'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = {
        task_id: args.task_id,
        project_id: args.target_project_id,
        column_id: args.target_column_id,
      };
      if (args.flow_item_id !== undefined) requestData.flow_item_id = args.flow_item_id;
      if (args.owner !== undefined) requestData.owner = args.owner;
      if (args.assist !== undefined) requestData.assist = args.assist;
      if (args.completed !== undefined) requestData.completed = args.completed;

      const newTask = await makeDootaskRequest(token, 'POST', 'project/task/copy', requestData) || {};

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `任务已复制到项目 ${args.target_project_id} 列 ${args.target_column_id}`,
            source_task_id: args.task_id,
            new_task: {
              task_id: newTask.id,
              name: newTask.name,
              project_id: newTask.project_id,
              column_id: newTask.column_id,
              parent_id: newTask.parent_id,
              flow_item_id: newTask.flow_item_id,
              flow_item_name: newTask.flow_item_name,
              start_at: newTask.start_at,
              end_at: newTask.end_at,
              created_at: newTask.created_at,
            },
          }, null, 2),
        }],
      };
    },
  );

  return [archiveTask, moveTask, copyTask];
}
