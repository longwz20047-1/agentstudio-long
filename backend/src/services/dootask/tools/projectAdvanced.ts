/**
 * DooTask 项目高级管理工具（3 个）
 *
 * 覆盖项目转让 + 权限矩阵读 + 权限矩阵改 — 项目管理员专属操作。
 * 端点对应 dootask/app/Http/Controllers/Api/ProjectController.php:
 *   - transfer_project_owner   → project/transfer        (line 581)
 *   - get_project_permission   → project/permission      (line 3472)
 *   - update_project_permission→ project/permission/update (line 3504)
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

/**
 * Dootask 项目权限的 11 个 key（与 ProjectPermission 模型常量严格对应）
 */
const PERMISSION_KEYS = [
  'task_list_add',
  'task_list_update',
  'task_list_remove',
  'task_list_sort',
  'task_add',
  'task_update',
  'task_time',
  'task_status',
  'task_remove',
  'task_archived',
  'task_move',
] as const;

/**
 * Dootask 角色枚举（来自 ProjectPermission::PERMISSIONS_DESC）
 *   1 = 项目负责人, 2 = 项目成员, 3 = 任务负责人, 4 = 任务协助人
 */
const RoleSchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4),
]);

/**
 * 完整权限矩阵 schema：11 个 key，每个 key 是允许角色 ID 数组
 * 全部字段均为必填——这是为了在 update 时强制 LLM 传入完整矩阵（避免误清空）
 */
const PermissionMatrixSchema = z.object({
  task_list_add: z.array(RoleSchema).describe('添加列权限：允许的角色 ID 列表'),
  task_list_update: z.array(RoleSchema).describe('修改列权限'),
  task_list_remove: z.array(RoleSchema).describe('删除列权限'),
  task_list_sort: z.array(RoleSchema).describe('列表排序权限'),
  task_add: z.array(RoleSchema).describe('添加任务权限'),
  task_update: z.array(RoleSchema).describe('更新任务权限'),
  task_time: z.array(RoleSchema).describe('修改任务时间权限'),
  task_status: z.array(RoleSchema).describe('修改任务状态权限'),
  task_remove: z.array(RoleSchema).describe('删除任务权限'),
  task_archived: z.array(RoleSchema).describe('归档任务权限'),
  task_move: z.array(RoleSchema).describe('移动任务权限'),
});

export function buildProjectAdvancedTools(ctx: ToolContext) {
  const transferProjectOwner = tool(
    'transfer_project_owner',
    '转让项目负责人。⚠️ **不可逆操作**：转让后原项目负责人将降级为普通项目成员，新负责人将获得管理员所有权限（含归档、删除项目、改权限矩阵等）。' +
    '调用前请务必向用户明确确认目标 owner_userid 正确无误，并告知用户此操作不可撤销。' +
    '仅当前项目负责人可调用。' +
    '入参示例：{ project_id: 123, owner_userid: 4567 }',
    {
      project_id: z.number().min(1).describe('项目ID'),
      owner_userid: z.number().min(1).describe('新的项目负责人用户ID（必须是已存在的 dootask 用户）'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'POST', 'project/transfer', {
        project_id: args.project_id,
        owner_userid: args.owner_userid,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project_id: data?.id ?? args.project_id,
            new_owner_userid: args.owner_userid,
            message: '项目负责人已转让；原负责人已降级为普通成员',
          }, null, 2),
        }],
      };
    },
  );

  const getProjectPermission = tool(
    'get_project_permission',
    '读取项目权限矩阵。返回 11 项操作权限 × 4 种角色（1=项目负责人, 2=项目成员, 3=任务负责人, 4=任务协助人）的映射。' +
    '11 项权限：task_list_add（添加列）、task_list_update（修改列）、task_list_remove（删除列）、task_list_sort（列排序）、' +
    'task_add（添加任务）、task_update（更新任务）、task_time（改时间）、task_status（改状态）、' +
    'task_remove（删任务）、task_archived（归档任务）、task_move（移任务）。' +
    '⚠️ **在调用 update_project_permission 前必须先调本工具拿到当前完整矩阵**，否则 update 会清空未传字段。' +
    '本工具任何项目成员均可调用（用于查看自己的权限边界）。',
    { project_id: z.number().min(1).describe('项目ID') },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'GET', 'project/permission', {
        project_id: args.project_id,
      });
      // dootask 返回 ProjectPermission model：{ id, project_id, permissions: {...11 keys}, ... }
      const permissions = data?.permissions || {};
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            project_id: args.project_id,
            permissions,
            roles_legend: {
              '1': '项目负责人 (project_leader)',
              '2': '项目成员 (project_member)',
              '3': '任务负责人 (task_leader)',
              '4': '任务协助人 (task_assist)',
            },
          }, null, 2),
        }],
      };
    },
  );

  const updateProjectPermission = tool(
    'update_project_permission',
    '更新项目权限矩阵。⚠️ **全量覆盖**：未传字段会被清空（与 dootask digest §9.3 列出的 project/user、task/update 的 owner+assist、flow__save 同模式）。' +
    '⚠️ **强制 chain call 流程**：必须先调用 get_project_permission 拿到当前完整 11 项权限矩阵 → 在内存中增量修改你想改的字段 → 把完整 11 项矩阵全部传回本工具。' +
    '直接调本工具而不先 get 会导致未传字段（例如忘记传 task_update）的权限被清空（变成空数组 = 无任何角色可执行该操作）。' +
    '11 项权限 key 必须全部传：task_list_add / task_list_update / task_list_remove / task_list_sort / task_add / task_update / task_time / task_status / task_remove / task_archived / task_move。' +
    '每项 value 是允许的角色 ID 数组：1=项目负责人、2=项目成员、3=任务负责人、4=任务协助人。' +
    '仅项目负责人可调用本工具。',
    {
      project_id: z.number().min(1).describe('项目ID'),
      permissions: PermissionMatrixSchema.describe(
        '完整 11 项权限矩阵（必须全传，否则未传项被清空）。建议先调 get_project_permission 取当前值再修改。',
      ),
    },
    async (args) => {
      const token = await ctx.getToken();
      // 显式校验：每个 key 必须存在（zod 已保证，这里再防御一次给出明确错误）
      const missing = PERMISSION_KEYS.filter((k) => !(k in args.permissions));
      if (missing.length > 0) {
        throw new Error(
          `缺少权限字段 [${missing.join(', ')}]。update_project_permission 是全量覆盖语义，` +
          `必须先调 get_project_permission 拿到完整 11 项矩阵后再修改回写。`,
        );
      }

      // controller 用 GET（apiName 注释 "@api {get}"）且 Request::only 直接读 query
      const requestData: Record<string, unknown> = { project_id: args.project_id };
      for (const k of PERMISSION_KEYS) {
        requestData[k] = args.permissions[k];
      }

      const data = await makeDootaskRequest(token, 'GET', 'project/permission/update', requestData);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project_id: args.project_id,
            permissions: data?.permissions || args.permissions,
            message: '项目权限矩阵已全量更新',
          }, null, 2),
        }],
      };
    },
  );

  return [transferProjectOwner, getProjectPermission, updateProjectPermission];
}
