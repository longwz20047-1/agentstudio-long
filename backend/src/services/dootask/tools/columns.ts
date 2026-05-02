/**
 * DooTask 看板列工具（5 个）
 *
 * dootask 数据模型：project → column → task。本文件补齐 column 写操作能力，
 * 与 create_task / update_task 的 column_id 选择逻辑形成闭环：
 *   1. LLM 用 get_project 查现有列
 *   2. 若无合适列 → create_column / create_columns_batch 新增
 *   3. 再 create_task 落到正确列
 *
 * 端点参考：dootask/app/Http/Controllers/Api/ProjectController.php:820-925
 *   project/column/lists  (GET)  入参 project_id
 *   project/column/add    (GET)  入参 project_id, name —— 每次 1 个，sort 自动末尾
 *   project/column/update (GET)  入参 column_id, name?, color?
 *   project/column/remove (GET)  入参 column_id
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

const MAX_BATCH_COLUMNS = 20;

export function buildColumnsTools(ctx: ToolContext) {
  const listProjectColumns = tool(
    'list_project_columns',
    `获取指定项目的所有看板列（column）。列名通常代表项目阶段或工作流状态（如售前项目「线索接洽/方案设计/商务报价/合同签订/交付实施」或通用「待办/进行中/已完成」）。配合 create_task / update_task 做内容→列匹配时的首选查询工具，比 get_project 更轻量（只返回列信息）。

支持单/多 project_id（数组时每列响应含 project_id + project_name，便于跨项目区分）。

【跨项目列查询场景】
用户问"调研列任务怎么样"、"售前项目商务报价阶段进度"等跨项目场景：
1. list_projects(search='关键词') 拿候选项目
2. list_project_columns(project_id=数组) 一次性拿全部列
3. LLM 语义识别相关列名 → 传 column_id 数组给 list_tasks 或 get_task_completion_stats`,
    {
      project_id: z.union([z.number(), z.array(z.number())])
        .describe('项目ID（单值或数组）。传数组时返回所有项目列的合集，每项含 project_id + project_name。'),
    },
    async (args) => {
      const token = await ctx.getToken();

      const projectIds: number[] = Array.isArray(args.project_id)
        ? args.project_id
        : [args.project_id];

      // 并行拉每个项目的列；失败的项目仅记录，不阻塞其他项目
      const results = await Promise.all(
        projectIds.map(async (pid) => {
          try {
            const data = await makeDootaskRequest(token, 'GET', 'project/column/lists', {
              project_id: pid,
            });
            // 取项目名（带数组场景必须；单值场景也保留以提升 label 可读性）
            let projectName = '';
            try {
              const proj = await makeDootaskRequest(token, 'GET', 'project/one', { project_id: pid });
              projectName = proj?.name || '';
            } catch {
              projectName = '';
            }
            const cols = (data?.data || []).map((c: any) => ({
              column_id: c.id,
              name: c.name,
              color: c.color || '',
              sort: c.sort,
              project_id: pid,
              project_name: projectName,
            }));
            return { pid, ok: true as const, cols };
          } catch (err: any) {
            return { pid, ok: false as const, error: err?.message || String(err) };
          }
        }),
      );

      const allColumns = results.filter((r) => r.ok).flatMap((r) => r.cols);
      const failedProjects = results.filter((r) => !r.ok).map((r) => ({ project_id: r.pid, error: r.error }));

      const isMulti = projectIds.length > 1;
      const responsePayload: Record<string, unknown> = {
        total: allColumns.length,
        columns: allColumns,
      };
      if (isMulti) {
        responsePayload.project_ids = projectIds;
        responsePayload.project_count = projectIds.length;
        if (failedProjects.length > 0) {
          responsePayload.failed_count = failedProjects.length;
          responsePayload.failed_hint = `${failedProjects.length} 个项目您可能无访问权限`;
        }
      } else {
        responsePayload.project_id = projectIds[0];
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(responsePayload, null, 2),
        }],
      };
    },
  );

  const createColumn = tool(
    'create_column',
    '在指定项目末尾新增 1 个看板列（sort 自动递增）。如果用户要一次性创建多个列（如初始化售前项目流程），强烈推荐改用 create_columns_batch 批量创建，避免反复调用。dootask 单项目最多 50 列。',
    {
      project_id: z.number().min(1).describe('项目ID'),
      name: z.string().min(1).describe('列名称（如「方案设计」「待办」）'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const column = await makeDootaskRequest(token, 'GET', 'project/column/add', {
        project_id: args.project_id,
        name: args.name,
      }) || {};

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            column: {
              column_id: column.id,
              name: column.name,
              color: column.color || '',
              sort: column.sort,
              project_id: column.project_id,
            },
          }, null, 2),
        }],
      };
    },
  );

  const createColumnsBatch = tool(
    'create_columns_batch',
    '批量为项目新增多个看板列（最多 20 个）。每个列可选指定 color（hex 颜色）；若提供 color，会在 add 后再调 update 设色。任一列失败不阻塞后续，最终返回 success/failed 双数组。例如售前项目可一次创建 ["线索接洽","需求调研","方案设计","商务报价","合同签订","交付实施"]，开发项目可一次创建 ["待办","进行中","代码评审","测试","已完成"]。',
    {
      project_id: z.number().min(1).describe('项目ID'),
      columns: z.array(z.object({
        name: z.string().min(1).describe('列名称'),
        color: z.string().optional().describe('列颜色 hex（如 "#3B82F6"），可选'),
      })).min(1).max(MAX_BATCH_COLUMNS)
        .describe(`要批量创建的列定义数组，1-${MAX_BATCH_COLUMNS} 个`),
    },
    async (args) => {
      const token = await ctx.getToken();
      const success: Array<{ name: string; column_id: number; color: string; sort: number }> = [];
      const failed: Array<{ name: string; error: string }> = [];

      for (const col of args.columns) {
        try {
          const created = await makeDootaskRequest(token, 'GET', 'project/column/add', {
            project_id: args.project_id,
            name: col.name,
          }) || {};

          let finalColor: string = created.color || '';

          if (col.color && created.id) {
            try {
              const updated = await makeDootaskRequest(token, 'GET', 'project/column/update', {
                column_id: created.id,
                color: col.color,
              }) || {};
              finalColor = updated.color || col.color;
            } catch (colorErr: any) {
              // 颜色设置失败不影响列创建本身，仅记录 warn
              console.warn(`[dootask/create_columns_batch] color update failed for "${col.name}": ${colorErr?.message}`);
            }
          }

          success.push({
            name: created.name || col.name,
            column_id: created.id,
            color: finalColor,
            sort: created.sort,
          });
        } catch (err: any) {
          failed.push({ name: col.name, error: err?.message || String(err) });
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: failed.length === 0,
            project_id: args.project_id,
            total_requested: args.columns.length,
            created_count: success.length,
            failed_count: failed.length,
            created: success,
            failed,
          }, null, 2),
        }],
      };
    },
  );

  const updateColumn = tool(
    'update_column',
    '修改看板列的名称或颜色。例如把「进行中」列改名为「开发中」，或把某列调成红色 (#EF4444) 突出紧急任务。至少要传 name 或 color 之一。',
    {
      column_id: z.number().min(1).describe('列ID'),
      name: z.string().optional().describe('新列名（可选）'),
      color: z.string().optional().describe('新列颜色 hex（如 "#3B82F6"，可选）'),
    },
    async (args) => {
      if (args.name === undefined && args.color === undefined) {
        throw new Error('update_column 至少需要传 name 或 color 之一');
      }

      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = { column_id: args.column_id };
      if (args.name !== undefined) requestData.name = args.name;
      if (args.color !== undefined) requestData.color = args.color;

      const column = await makeDootaskRequest(token, 'GET', 'project/column/update', requestData) || {};

      const updates: string[] = [];
      if (args.name !== undefined) updates.push('名称');
      if (args.color !== undefined) updates.push('颜色');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `列已更新: ${updates.join('、')}`,
            column: {
              column_id: column.id,
              name: column.name,
              color: column.color || '',
              sort: column.sort,
              project_id: column.project_id,
            },
          }, null, 2),
        }],
      };
    },
  );

  const deleteColumn = tool(
    'delete_column',
    '删除指定看板列。删除前应先调 list_project_columns 确认列存在并提示用户列内是否有任务（dootask 后端在列内有任务时可能拒绝删除，视实现而定）。此操作不可恢复。',
    { column_id: z.number().min(1).describe('要删除的列ID') },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'GET', 'project/column/remove', {
        column_id: args.column_id,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: '列已删除',
            column_id: args.column_id,
            data,
          }, null, 2),
        }],
      };
    },
  );

  return [listProjectColumns, createColumn, createColumnsBatch, updateColumn, deleteColumn];
}
