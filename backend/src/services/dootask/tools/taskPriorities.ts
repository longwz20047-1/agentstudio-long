/**
 * DooTask 任务优先级工具（1 个）
 *
 * dootask 任务优先级是**系统级配置档位**（管理员维护），不同于项目维度的标签。
 * 每个档位由 4 个字段组成：priority（数值，越小越紧急） + name + color + days。
 *
 * 端点参考：dootask/app/Http/Controllers/Api/SystemController.php:730
 *   system/priority (POST)
 *     - 入参 type=get（默认）/save（限管理员）
 *     - 返回 Array<{priority,name,color,days}>
 *
 * 与 create_task / update_task 的关系：
 *   1. LLM 接到"紧急/高优"等用户描述 → 先调本工具拿系统档位
 *   2. 推理出最贴近的档位 → 三字段 p_level + p_name + p_color 一起回填到 task
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { makeDootaskRequest } from '../dootaskClient.js';
import type { ToolContext } from './types.js';

export function buildTaskPrioritiesTools(ctx: ToolContext) {
  const listTaskPriorities = tool(
    'list_task_priorities',
    '获取系统任务优先级档位列表（系统级配置，管理员维护）。'
    + '返回数组，每项含 priority(数值，越小越紧急)、name(档位名称如"重要且紧急"/"紧急"/"高优"等)、color(hex 颜色)。'
    + '⚠️ 当用户在 create_task / update_task 中提及紧急度（"紧急"、"高优"、"重要"、"低"）时，'
    + '应先调本工具拿到当前系统档位，再从中挑选最贴近用户语义的一项，'
    + '把该项的 priority/name/color 三字段一起原样传到 create_task / update_task（dootask 后端不会自动补色名/名称，必须三字段一致）。'
    + '注意：用户语义"紧急"未必等于档位 name="紧急"；不同租户系统档位可能叫"高优"/"P0"/"红色"/"重要且紧急"等，应按颜色和数值大小综合判断。'
    + '⚠️ 任务实际截止时间用 end_at 字段（必问用户），与优先级档位无关——不要在解释优先级档位时附带"X 天内完成"措辞。',
    {},
    async () => {
      const token = await ctx.getToken();
      // 与前端 store/actions.js::getTaskPriority 同模式：不传 type，走 controller 的 else 分支返回当前档位
      const data = await makeDootaskRequest(token, 'POST', 'system/priority', {});

      // ⚠️ 不返回 days 字段：days 是字典内部 SLA 参考值，
      // 历史经验表明 LLM 看到 days 会自动转成"X 天内完成"展示给用户，
      // 误导用户以为是任务硬性截止时间（实际任务截止时间走 end_at 字段，
      // 由用户在 create_task/update_task 时主动指定，不是字典自动决定）。
      const priorities = (Array.isArray(data) ? data : []).map((p: any) => ({
        priority: p.priority,
        name: p.name,
        color: p.color,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: priorities.length,
            priorities,
            usage_hint: '在 create_task / update_task 中传 p_level=priority、p_name=name、p_color=color，三字段必须一致传。⚠️ 任务截止时间走 end_at 字段（必问用户），不要因优先级档位附带"X 天内"措辞。',
          }, null, 2),
        }],
      };
    },
  );

  return [listTaskPriorities];
}
