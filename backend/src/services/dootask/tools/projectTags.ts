/**
 * DooTask 项目标签工具（4 个）
 *
 * 哲学定位：标签是任务的**多维画像**，与"用户画像/客户画像"同源。
 * 一个任务可贴 0-N 个标签，每个标签从一个独立侧面刻画该任务的属性，
 * 彼此正交、可任意组合。区别于看板列（单选互斥状态）和优先级（系统档位）。
 *
 * 端点参考：dootask/app/Http/Controllers/Api/ProjectController.php
 *   - tag__list   (line 3985, GET)  入 project_id
 *   - tag__save   (line 3767, POST) id=0 创建 / id>0 修改；project_id+name+color 三字段后端硬校验非空
 *   - tag__delete (line 3928, GET)  入 id（联级清理 ProjectTaskTag）
 *
 * 已知约束：
 *   - 单项目最多 100 标签（controller line 3839）
 *   - 同项目内 name 不可重复（controller line 3842）
 *   - 修改/删除权限：项目负责人 OR 标签创建者
 *   - tag__save 后端硬校验 project_id+name+color 必传非空（即使是 update 也要回填）
 *   - sort 字段交由前端管理（拖拽），本批不实施 sort_project_tags
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

export function buildProjectTagsTools(ctx: ToolContext) {
  const listProjectTags = tool(
    'list_project_tags',
    '获取指定项目的全部标签列表。返回数组，每项含 id/name/color/desc/sort/userid/project_id。'
    + '在 create_task / update_task 设置 task_tag 前应先调本工具，看现有标签是否覆盖用户语义；'
    + '若现有标签都不贴切，再调 create_project_tag 新建（建议先告知用户拟新建的标签名+颜色，征得同意）。'
    + '在 update_project_tag 前也必须先调本工具拿到 project_id+name+color 的当前值（dootask 后端要求三字段全传非空）。',
    { project_id: z.number().min(1).describe('项目ID') },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'GET', 'project/tag/list', {
        project_id: args.project_id,
      });

      const tags = (Array.isArray(data) ? data : []).map((t: any) => ({
        id: t.id,
        name: t.name,
        color: t.color || '',
        desc: t.desc || '',
        sort: t.sort,
        userid: t.userid,
        project_id: t.project_id,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            project_id: args.project_id,
            total: tags.length,
            tags,
          }, null, 2),
        }],
      };
    },
  );

  const createProjectTag = tool(
    'create_project_tag',
    '在指定项目下新建标签（标签是任务的画像维度，可任意刻画任务属性）。'
    + 'name 与 color 必填，desc 可选；name 在同项目内不可重复，单项目最多 100 个标签。'
    + '⚠️ 建议在新建前先告知用户拟创建的标签 name + 用途，征得同意；避免创建语义近似的重复标签污染画像体系。'
    + '常见画像维度举例（仅示意，不限于此）：模块归属、客户归属、技术栈、环境、阶段子分解、来源渠道、风险注解……'
    + '⛔ 不要把"紧急/高/普通"做成标签——那是 task.p_level；也不要把"待办/进行中/已完成"做成标签——那是看板列。',
    {
      project_id: z.number().min(1).describe('项目ID'),
      name: z.string().min(1).describe('标签名称（同项目内唯一，刻画任务的某个画像维度）'),
      color: z.string().min(1).describe('标签颜色 hex（如 "#3B82F6"，必填，dootask 后端不接受空色）'),
      desc: z.string().optional().describe('标签描述（可选，方便协作者理解此标签的语义）'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = {
        id: 0, // 0 表示创建
        project_id: args.project_id,
        name: args.name,
        color: args.color,
      };
      if (args.desc !== undefined) requestData.desc = args.desc;

      const tag = await makeDootaskRequest(token, 'POST', 'project/tag/save', requestData) || {};

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: '标签已创建',
            tag: {
              id: tag.id,
              name: tag.name,
              color: tag.color || '',
              desc: tag.desc || '',
              sort: tag.sort,
              project_id: tag.project_id,
              userid: tag.userid,
            },
          }, null, 2),
        }],
      };
    },
  );

  const updateProjectTag = tool(
    'update_project_tag',
    '修改已有项目标签的 name/color/desc。'
    + '⚠️ **强制 chain call**：dootask 后端硬校验 project_id+name+color 三字段非空（即使只想改 desc 也要全传），'
    + '所以本工具的所有 4 个字段（除 desc）都是必填——LLM 应先调 list_project_tags 拿到该 tag 的当前 project_id/name/color，'
    + '在内存中只覆盖要改的字段，再把完整 4 字段（id/project_id/name/color，desc 可选）传回本工具。'
    + '⚠️ 修改 name 会联级更新所有关联任务的 task_tag.name 字段（dootask 后端事务保证）。'
    + '权限：仅项目负责人或该标签创建者可修改。',
    {
      id: z.number().min(1).describe('标签ID'),
      project_id: z.number().min(1).describe('项目ID（必传，后端硬校验）'),
      name: z.string().min(1).describe('标签名称（必传非空，要保留原名时回填原值）'),
      color: z.string().min(1).describe('标签颜色 hex（必传非空，要保留原色时回填原值）'),
      desc: z.string().optional().describe('标签描述（可选；不传则后端按空字符串处理）'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const requestData: Record<string, unknown> = {
        id: args.id,
        project_id: args.project_id,
        name: args.name,
        color: args.color,
      };
      if (args.desc !== undefined) requestData.desc = args.desc;

      const tag = await makeDootaskRequest(token, 'POST', 'project/tag/save', requestData) || {};

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: '标签已更新',
            tag: {
              id: tag.id,
              name: tag.name,
              color: tag.color || '',
              desc: tag.desc || '',
              sort: tag.sort,
              project_id: tag.project_id,
            },
          }, null, 2),
        }],
      };
    },
  );

  const deleteProjectTag = tool(
    'delete_project_tag',
    '删除指定项目标签。⚠️ **联级清理**：删除标签时 dootask 后端会自动从所有关联任务的 task_tag 中移除此标签（事务内执行）。'
    + '权限：仅项目负责人或该标签创建者可删除。此操作不可恢复。'
    + '调用前应告知用户："删除标签 XXX 后，使用此标签的 N 个任务画像会丢失该维度"。',
    { id: z.number().min(1).describe('要删除的标签ID') },
    async (args) => {
      const token = await ctx.getToken();
      const data = await makeDootaskRequest(token, 'GET', 'project/tag/delete', {
        id: args.id,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: '标签已删除（已联级清理所有关联任务的 task_tag）',
            id: args.id,
            data,
          }, null, 2),
        }],
      };
    },
  );

  return [listProjectTags, createProjectTag, updateProjectTag, deleteProjectTag];
}
