/**
 * DooTask 任务完成率统计工具（1 个）
 *
 * 用户场景：自然语言问完成率（"我所有售前项目完成多少了"、"调研列任务怎么样"、
 * "金融客户的进度"），LLM 多维度统计 + 用户全程不接触 ID。
 *
 * 设计参考：
 *   - dootask 任务字段 complete_at / percent / sub_num / sub_complete / column_id /
 *     column_name / project_id / project_name / p_level / p_name / task_user / task_tag
 *   - 系统优先级档位通过 system/priority POST 拿（SystemController.php:730）
 *   - parent_id=-1 强制只取主任务（避免子任务重复计入完成率）
 *
 * 算法：
 *   完成率 = sum(weight × completion) / sum(weight × 100) × 100%
 *   completion: complete_at 非空→100；否则用 task.percent（dootask 自动算 sub_complete/sub_num）
 *   weight (equal): 每任务=1
 *   weight (priority): max_p - p_level + 1（数字小=级别高=权重大）
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

// dootask project/task/lists 后端 pagesize 上限
const MAX_PAGESIZE = 100;
// 拉任务时单维度最大循环页数（防御无限循环；100 页 × 100 任务 = 10000 任务上限）
const MAX_PAGES = 100;

interface RawTask {
  id: number;
  name: string;
  complete_at?: string | null;
  percent?: number;
  project_id: number;
  project_name?: string;
  column_id?: number;
  column_name?: string;
  p_level?: number;
  p_name?: string;
  task_user?: Array<{ userid: number; owner: number }>;
  task_tag?: Array<{ name: string; color?: string }>;
}

interface PriorityEntry {
  priority: number;
  name: string;
  color?: string;
  days?: number;
}

interface GroupAccum {
  key: string;
  label: string;
  count: number;
  completed: number;
  totalWeight: number;
  totalWeighted: number; // sum(weight × completion)
}

export function buildTaskStatsTools(ctx: ToolContext) {
  const getTaskCompletionStats = tool(
    'get_task_completion_stats',
    `统计任务完成率，支持 5 维度分组（项目/列/标签/优先级/负责人）+ 2 种权重模式（等权/按优先级加权）。
LLM 用户视角约束：永远以名称回答（项目名/列名/标签名/优先级名），不要念 ID。

【算法】
完成率 = sum(weight × completion) / sum(weight × 100) × 100%
- completion: complete_at 非空→100；否则用 task.percent（dootask 自动算 sub_complete/sub_num）
- weight (equal): 每任务=1
- weight (priority): max_p - p_level + 1（数字小=级别高=权重大；max_p 来自 system/priority 配置）

【LLM 用户视角约束】
- 永远用项目名/列名/标签名/优先级名回答用户，不要念 ID
- inaccessible_count > 0 时告知"有 N 个项目您无访问权限已排除"，不要列 ID
- 用户问完成率几乎都该走"先拿候选 → LLM 语义识别 → 调本工具 group_by=适合的维度"

【典型场景】
- "项目 X 完成多少" → list_projects + 识别 → 本工具(project_id=X, group_by='project')
- "我所有售前项目进度" → list_projects(search='售前') + 识别 → 本工具(project_id=数组, group_by='project')
- "项目 X 各阶段完成率" → 本工具(project_id=X, group_by='column')
- "金融客户任务完成率" → list_project_tags + 识别 → 本工具(tag=数组, group_by='project')
- "调研阶段进度" → list_project_columns + 语义 → 本工具(column_id=数组, group_by='project')
- "高优 vs 普通完成率对比" → 本工具(group_by='priority')
- "团队各成员完成率" → 本工具(project_id=X, group_by='owner')
- 默认 weight_mode=equal；用户说"按重要程度算"才用 priority

【⚠️ tag 过滤 + group_by='tag' 的展开行为】
当用户传 tag=['金融'] + group_by='tag'：
- 命中"金融"标签的任务可能还有"紧急"/"客户"等其他标签
- groups 会包含**所有命中任务的全部标签**（不仅是 filter 里的"金融"）
- 例：3 个金融任务分别还有标签[紧急]/[客户,V1]/[紧急] → groups = [金融:3, 紧急:2, 客户:1, V1:1]

如何选择正确路径：
- 想看"金融任务的整体完成率"（单一数字） → group_by='project' + tag=['金融']
- 想看"金融任务在不同子标签维度的完成率分布"（当前展开行为） → group_by='tag' + tag=['金融']
- 想看"项目里所有标签维度对比"（不限定 tag filter） → 不传 tag + group_by='tag'

【⚠️ 反模式：不要用 status='completed' + 完成率统计】
status='completed' 过滤后所有任务 complete_at 非空 → completion=100 → overall_completion_rate 必然 100%。
统计完成率请不传 status（默认 all）或传 status='uncompleted'（看未完成的进度）。
若用户想看"已完成的任务列表"，应该用 list_tasks(status='completed') 而不是本工具。

【边界保障】
- 空任务集 → overall=0, groups=[]
- 无优先级配置 → priority 模式退化为 equal
- 任务无 p_level → weight=1（最低权）
- 任务多 tag/多 owner → 在 tag/owner 分组里独立计入（一个任务可能进多组）
- 仅统计主任务（parent_id=-1），避免子任务重复计入`,
    {
      // === 过滤维度（与 list_tasks 同款，限定统计范围）===
      project_id: z.union([z.number(), z.array(z.number())]).optional()
        .describe('项目过滤（不传=用户参与的所有项目；传数组=多项目并集）。LLM 应先 list_projects 拿候选语义识别后传入。'),
      tag: z.union([z.string(), z.array(z.string())]).optional()
        .describe('标签过滤。LLM 应先 list_project_tags 语义识别后传字符串数组。'),
      column_id: z.union([z.number(), z.array(z.number())]).optional()
        .describe('列过滤。LLM 应先 list_project_columns 语义识别后传 column_id 数组。'),
      status: z.enum(['all', 'completed', 'uncompleted']).optional()
        .describe('状态过滤'),

      // === 分组维度（必填）===
      group_by: z.enum(['project', 'column', 'tag', 'priority', 'owner'])
        .describe('分组维度：按项目/按列/按标签/按优先级档位/按负责人聚合。'),

      // === 权重模式 ===
      weight_mode: z.enum(['equal', 'priority']).optional()
        .describe('权重模式（默认 equal）。equal=每任务权重 1；priority=按 p_level 反向加权（紧急任务权重大）。'),
    },
    async (args) => {
      const token = await ctx.getToken();
      const weightMode = args.weight_mode || 'equal';

      // ====== Step 1: 拿系统优先级档位（仅 priority 模式）======
      let maxP = 1;
      let priorityAvailable = false;
      if (weightMode === 'priority') {
        try {
          const priorityResp: PriorityEntry[] | null = await makeDootaskRequest(
            token, 'POST', 'system/priority', {},
          );
          if (Array.isArray(priorityResp) && priorityResp.length > 0) {
            const levels = priorityResp.map((p) => p.priority || 1).filter((n) => n > 0);
            if (levels.length > 0) {
              maxP = Math.max(...levels);
              priorityAvailable = true;
            }
          }
        } catch (err: any) {
          console.warn(`[dootask/task_stats] system/priority fetch failed, fallback to equal: ${err?.message}`);
        }
      }
      // 无优先级配置 → 退化为 equal（即 weight 始终 1）
      const effectiveWeightMode: 'equal' | 'priority' =
        weightMode === 'priority' && priorityAvailable ? 'priority' : 'equal';

      // ====== Step 2: 处理 project_id 入参 + 权限探测 ======
      let accessibleProjectIds: number[] | undefined; // undefined = 不限项目，走默认 authData
      let inaccessibleCount = 0;

      if (args.project_id !== undefined) {
        const requested = Array.isArray(args.project_id) ? args.project_id : [args.project_id];
        const probeResults = await Promise.all(
          requested.map(async (pid) => {
            try {
              await makeDootaskRequest(token, 'GET', 'project/one', { project_id: pid });
              return { pid, ok: true };
            } catch {
              return { pid, ok: false };
            }
          }),
        );
        accessibleProjectIds = probeResults.filter((r) => r.ok).map((r) => r.pid);
        inaccessibleCount = probeResults.filter((r) => !r.ok).length;

        // 全部不可访问 → 早返回（避免 list 调用泄漏数据）
        if (accessibleProjectIds.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                filter_summary: `请求的 ${requested.length} 个项目您均无访问权限`,
                group_by: args.group_by,
                weight_mode: effectiveWeightMode,
                total_tasks: 0,
                overall_completion_rate: 0,
                groups: [],
                inaccessible_count: inaccessibleCount,
                inaccessible_hint: `${inaccessibleCount} 个项目您当前无访问权限已从统计中排除`,
              }, null, 2),
            }],
          };
        }
      }

      // ====== Step 3: 拉任务（笛卡尔积 tag × project_id × column_id，含分页）======
      const tagList: (string | undefined)[] = Array.isArray(args.tag)
        ? args.tag
        : args.tag !== undefined ? [args.tag] : [undefined];
      const projectIdList: (number | undefined)[] = accessibleProjectIds
        ? accessibleProjectIds
        : [undefined]; // undefined → 不传 project_id → dootask 后端用 authData 默认
      const columnIdList: (number | undefined)[] = Array.isArray(args.column_id)
        ? args.column_id
        : args.column_id !== undefined ? [args.column_id] : [undefined];

      const buildRequest = (
        page: number,
        tagValue?: string,
        projectIdValue?: number,
        columnIdValue?: number,
      ): Record<string, unknown> => {
        const req: Record<string, unknown> = {
          page,
          pagesize: MAX_PAGESIZE,
          parent_id: -1, // 仅主任务，避免子任务重复计入
        };
        const keys: Record<string, unknown> = {};
        if (args.status && args.status !== 'all') keys.status = args.status;
        if (tagValue) keys.tag = tagValue;
        if (columnIdValue !== undefined) keys.column_id = columnIdValue;
        if (Object.keys(keys).length > 0) req.keys = keys;
        if (projectIdValue !== undefined) req.project_id = projectIdValue;
        return req;
      };

      // 单 combo 分页拉取（直到拉完所有页或达 MAX_PAGES）
      const fetchAllForCombo = async (
        tagValue?: string,
        projectIdValue?: number,
        columnIdValue?: number,
      ): Promise<RawTask[]> => {
        const allTasks: RawTask[] = [];
        let page = 1;
        while (page <= MAX_PAGES) {
          const data = await makeDootaskRequest(
            token, 'GET', 'project/task/lists',
            buildRequest(page, tagValue, projectIdValue, columnIdValue),
          );
          const batch: RawTask[] = data?.data || [];
          allTasks.push(...batch);
          // dootask 分页：last_page / total / current_page / per_page
          const lastPage = data?.last_page;
          if (typeof lastPage === 'number' && page >= lastPage) break;
          if (batch.length < MAX_PAGESIZE) break;
          page += 1;
        }
        return allTasks;
      };

      // 三维笛卡尔积
      const combos: Array<{ tag?: string; project_id?: number; column_id?: number }> = [];
      for (const t of tagList) {
        for (const p of projectIdList) {
          for (const c of columnIdList) {
            combos.push({ tag: t, project_id: p, column_id: c });
          }
        }
      }

      // 高负载场景告警（仅服务端日志，不影响响应）
      const totalCombos = combos.length;
      if (totalCombos >= 10) {
        console.warn(`[get_task_completion_stats] high combo count: ${totalCombos} (tag×project×column 笛卡尔积)`);
      }

      const responses = await Promise.all(
        combos.map((c) => fetchAllForCombo(c.tag, c.project_id, c.column_id)),
      );

      // ====== Step 4: 合并 + 按 task.id 去重 ======
      const taskMap = new Map<number, RawTask>();
      for (const batch of responses) {
        for (const t of batch) {
          if (t && typeof t.id === 'number' && !taskMap.has(t.id)) {
            taskMap.set(t.id, t);
          }
        }
      }
      const tasks = Array.from(taskMap.values());

      if (tasks.length >= 5000) {
        console.warn(`[get_task_completion_stats] large task set: ${tasks.length} tasks merged from ${totalCombos} combos, perf may degrade`);
      }

      // ====== Step 5: 拉项目名映射（仅 group_by='project' 或需要展示项目名时）======
      // 即使非 project 分组，filter_summary 里也可能想引用项目名 — 但用户视角只在 group label 里看到，
      // 所以只在 group_by='project' 时拉。
      const projectMap = new Map<number, string>();
      if (args.group_by === 'project') {
        const projectIds = Array.from(new Set(tasks.map((t) => t.project_id).filter((id) => typeof id === 'number')));
        const projectInfos = await Promise.all(
          projectIds.map(async (pid) => {
            // 优先用 task 自带的 project_name 避免重复请求
            const fromTask = tasks.find((t) => t.project_id === pid && t.project_name)?.project_name;
            if (fromTask) return { pid, name: fromTask };
            try {
              const proj = await makeDootaskRequest(token, 'GET', 'project/one', { project_id: pid });
              return { pid, name: proj?.name || `项目 ${pid}` };
            } catch {
              return { pid, name: `项目 ${pid}` };
            }
          }),
        );
        for (const p of projectInfos) projectMap.set(p.pid, p.name);
      }

      // ====== Step 5b: 拉 owner 真名映射（仅 group_by='owner' 时执行）======
      const userNameMap = new Map<number, string>();
      if (args.group_by === 'owner') {
        const uniqueOwnerIds = new Set<number>();
        for (const task of tasks) {
          const owners = Array.isArray(task.task_user)
            ? task.task_user.filter((u) => u && u.owner === 1)
            : [];
          for (const u of owners) uniqueOwnerIds.add(u.userid);
        }

        if (uniqueOwnerIds.size > 0) {
          const ids = Array.from(uniqueOwnerIds);
          // dootask users/basic 单批最多 50 → 分批 chunk
          const chunks: number[][] = [];
          for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));

          await Promise.all(chunks.map(async (chunk) => {
            try {
              const data = await makeDootaskRequest(
                token, 'GET', 'users/basic',
                { userid: chunk.length === 1 ? chunk[0] : JSON.stringify(chunk) },
              );
              const rawList = Array.isArray(data)
                ? data
                : (Array.isArray((data as any)?.data) ? (data as any).data : []);
              for (const user of rawList) {
                if (user && user.userid && user.nickname) {
                  userNameMap.set(user.userid, user.nickname);
                }
              }
            } catch (e) {
              // 静默失败 → fallback 到 "用户 N" label（不抛错）
              console.warn(`[get_task_completion_stats] users/basic batch failed: ${(e as Error)?.message}`);
            }
          }));
        }
      }

      // ====== Step 6: 算 weight + completion ======
      const computeWeight = (task: RawTask): number => {
        if (effectiveWeightMode === 'equal') return 1;
        const pLevel = task.p_level;
        if (typeof pLevel !== 'number' || pLevel <= 0) return 1; // 无 p_level → 最低权
        return Math.max(1, maxP - pLevel + 1);
      };
      const computeCompletion = (task: RawTask): number => {
        if (task.complete_at) return 100;
        const pct = task.percent;
        return typeof pct === 'number' && pct >= 0 ? Math.min(100, pct) : 0;
      };

      // ====== Step 7: 按 group_by 聚合 ======
      const groups = new Map<string, GroupAccum>();
      const ensureGroup = (key: string, label: string): GroupAccum => {
        let g = groups.get(key);
        if (!g) {
          g = { key, label, count: 0, completed: 0, totalWeight: 0, totalWeighted: 0 };
          groups.set(key, g);
        }
        return g;
      };

      // overall 累加器（无论分组维度，所有任务等权一次）
      let overallTotalWeight = 0;
      let overallTotalWeighted = 0;

      for (const task of tasks) {
        const weight = computeWeight(task);
        const completion = computeCompletion(task);
        const isCompleted = !!task.complete_at;

        // overall 累加（每任务一次，与分组维度无关）
        overallTotalWeight += weight;
        overallTotalWeighted += weight * completion;

        // 收集该任务进入哪些分组（多 tag/多 owner 会进多组）
        const targets: Array<{ key: string; label: string }> = [];

        switch (args.group_by) {
          case 'project': {
            const pid = task.project_id;
            const label = projectMap.get(pid) || task.project_name || `项目 ${pid}`;
            targets.push({ key: String(pid), label });
            break;
          }
          case 'column': {
            const cid = task.column_id;
            const label = task.column_name || (cid !== undefined ? `列 ${cid}` : '未设列');
            targets.push({ key: cid !== undefined ? String(cid) : 'none', label });
            break;
          }
          case 'tag': {
            const tags = Array.isArray(task.task_tag) ? task.task_tag : [];
            if (tags.length === 0) {
              targets.push({ key: '__no_tag__', label: '无标签' });
            } else {
              for (const t of tags) {
                if (t && t.name) targets.push({ key: t.name, label: t.name });
              }
            }
            break;
          }
          case 'priority': {
            const pl = task.p_level;
            if (typeof pl === 'number' && pl > 0) {
              targets.push({ key: String(pl), label: task.p_name || `优先级 ${pl}` });
            } else {
              targets.push({ key: '__no_priority__', label: '未设优先级' });
            }
            break;
          }
          case 'owner': {
            const owners = Array.isArray(task.task_user)
              ? task.task_user.filter((u) => u && u.owner === 1)
              : [];
            if (owners.length === 0) {
              targets.push({ key: '__no_owner__', label: '无负责人' });
            } else {
              for (const u of owners) {
                const label = userNameMap.get(u.userid) || `用户 ${u.userid}`;
                targets.push({ key: String(u.userid), label });
              }
            }
            break;
          }
        }

        for (const t of targets) {
          const g = ensureGroup(t.key, t.label);
          g.count += 1;
          if (isCompleted) g.completed += 1;
          g.totalWeight += weight;
          g.totalWeighted += weight * completion;
        }
      }

      // ====== Step 8: 算各组完成率 + overall ======
      const groupArr = Array.from(groups.values()).map((g) => ({
        key: g.key,
        label: g.label,
        count: g.count,
        completed: g.completed,
        weighted_pct: g.totalWeight > 0
          ? Number((g.totalWeighted / (g.totalWeight * 100) * 100).toFixed(2))
          : 0,
      }));
      // 按完成率降序，便于 LLM 直观陈述
      groupArr.sort((a, b) => b.weighted_pct - a.weighted_pct);

      const overall = overallTotalWeight > 0
        ? Number((overallTotalWeighted / (overallTotalWeight * 100) * 100).toFixed(2))
        : 0;

      // ====== Step 9: 组装 filter_summary（用户视角）======
      const filterParts: string[] = [];
      if (accessibleProjectIds && accessibleProjectIds.length > 0) {
        filterParts.push(`${accessibleProjectIds.length} 个项目`);
      } else if (args.project_id === undefined) {
        filterParts.push('您参与的所有项目');
      }
      if (args.tag !== undefined) {
        const tagCount = Array.isArray(args.tag) ? args.tag.length : 1;
        filterParts.push(`${tagCount} 个标签筛选`);
      }
      if (args.column_id !== undefined) {
        const colCount = Array.isArray(args.column_id) ? args.column_id.length : 1;
        filterParts.push(`${colCount} 个列筛选`);
      }
      if (args.status && args.status !== 'all') {
        filterParts.push(args.status === 'completed' ? '仅已完成' : '仅未完成');
      }
      const filterSummary = filterParts.length > 0 ? filterParts.join('、') : '全部任务';

      // ====== Step 10: 返回响应 ======
      const result: Record<string, unknown> = {
        filter_summary: filterSummary,
        group_by: args.group_by,
        weight_mode: effectiveWeightMode,
        total_tasks: tasks.length,
        overall_completion_rate: overall,
        groups: groupArr,
      };
      if (weightMode === 'priority' && !priorityAvailable) {
        result.weight_mode_note = '无优先级配置，已退化为 equal 模式';
      }
      if (inaccessibleCount > 0) {
        result.inaccessible_count = inaccessibleCount;
        result.inaccessible_hint = `${inaccessibleCount} 个项目您当前无访问权限已从统计中排除`;
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  return [getTaskCompletionStats];
}
