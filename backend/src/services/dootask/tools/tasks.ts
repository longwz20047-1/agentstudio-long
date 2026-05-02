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
    `获取当前用户相关的任务列表（负责/协助/关注），支持按状态、项目、时间范围、标签筛选和搜索。

【按标签查任务进度（高频场景）— 必须用语义匹配两步链路】

dootask 后端按 name **完全匹配**查询，但 LLM 生成的标签存在同义词不确定性
（"金融" / "金融行业" / "金融科技" / "金融客户"），单值精确匹配会漏命中。
**正确链路**：

1. 先调 list_project_tags(project_id) 拿该项目全部已有标签 name 列表
2. LLM 用自身语义判断从列表中识别与用户问询相关的所有标签
   （例：用户问"金融"，列表有 ["金融","金融行业","金融科技","制造","医疗"]
        → LLM 判定相关 = ["金融","金融行业","金融科技"]）
3. 把识别到的相关名一次性传给 list_tasks(tag=数组)
   本工具支持 tag: string | string[]，传数组时内部对每项调一次后端，合并任务并按 task.id 去重
4. 综合返回任务的 status/column_name/percent 字段做进度分析

例：
- "需求调研的任务完成得怎么样" → list_project_tags 找相关 → list_tasks(tag=['需求调研','需求分析'])
- "金融客户的紧急任务" → list_project_tags 语义匹配 → list_tasks(tag=['金融','金融客户','金融行业'], status='uncompleted')
- "箱体图纸设计在哪个阶段" → list_project_tags → list_tasks(tag=['箱体图纸设计','图纸设计'])
- 多任务进度问题，几乎都应该走"先 list_project_tags 拿名 → LLM 语义匹配 → 数组传入"路径

【何时可以传单值（不调 list_project_tags）】
仅当用户明确指定唯一精确名（"叫『金融』的标签的任务，其他都不要"）时直接传字符串。
否则默认走两步链路保证命中相关同义标签，避免漏数据。`,
    {
      status: z.enum(['all', 'completed', 'uncompleted']).optional()
        .describe('任务状态: all(所有), completed(已完成), uncompleted(未完成)'),
      search: z.string().optional().describe('搜索关键词（可搜索任务ID、名称、描述）'),
      tag: z.union([z.string(), z.array(z.string())]).optional()
        .describe(
          '按标签名过滤（dootask 后端单次精确匹配 = name）。'
          + '推荐先调 list_project_tags 拿全部名 → LLM 语义识别相关 → 一次性传字符串数组。'
          + '本工具内部对数组循环多次调用并按 task.id 合并去重。'
          + '单值传 string，多值传 string[]'
        ),
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

      // 公共过滤构造器（单次后端调用的 requestData）
      const buildRequest = (tagValue?: string): Record<string, unknown> => {
        const req: Record<string, unknown> = {
          page: args.page || 1,
          pagesize: args.pagesize || 20,
        };
        const keys: Record<string, unknown> = {};
        if (args.search) keys.name = args.search;
        if (args.status && args.status !== 'all') keys.status = args.status;
        if (tagValue) keys.tag = tagValue;
        if (Object.keys(keys).length > 0) req.keys = keys;
        if (args.time !== undefined) req.time = args.time;
        if (args.project_id !== undefined) req.project_id = args.project_id;
        if (args.parent_id !== undefined) req.parent_id = args.parent_id;
        return req;
      };

      // 把 tag 入参规范成数组：
      // - undefined → [undefined]（单次调用，无 tag 过滤）
      // - string → [string]（单次调用，与原行为相同）
      // - string[] → 多次调用 + 合并
      const tagList: (string | undefined)[] = Array.isArray(args.tag)
        ? args.tag
        : args.tag !== undefined ? [args.tag] : [undefined];

      const isMultiTag = Array.isArray(args.tag) && args.tag.length > 1;

      // 并行调用所有 tag 分支
      const responses = await Promise.all(
        tagList.map((t) => makeDootaskRequest(token, 'GET', 'project/task/lists', buildRequest(t)))
      );

      // 合并 + 按 task.id 去重（多 tag 时一个任务可能被多个 tag 命中）
      const taskMap = new Map<number, any>();
      for (const data of responses) {
        for (const t of data.data || []) {
          if (!taskMap.has(t.id)) taskMap.set(t.id, t);
        }
      }
      const mergedTasks = Array.from(taskMap.values());

      // 多 tag 时 total = 去重后数量；单 tag/无 tag 用后端原 total
      const finalTotal = isMultiTag ? mergedTasks.length : (responses[0]?.total ?? mergedTasks.length);

      const tasks = mergedTasks.map((t: any) => ({
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
            total: finalTotal,
            page: responses[0]?.current_page,
            pagesize: responses[0]?.per_page,
            // 多 tag 时回显本次用了哪些标签做并集查询，方便 LLM 自检
            ...(isMultiTag ? { tag_filter: args.tag } : {}),
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
4. 仅当用户明确说"放默认列"或"不分类"时，才省略 column_id 走系统 default。

【关于优先级 p_level/p_name/p_color（用户提到紧急度时强烈推荐）】
1. 用户说"紧急"/"重要"/"高优先级"等紧急度词汇时，先调 list_task_priorities 拿系统档位
2. 根据用户语义推理对应档位（"紧急"通常对应数值最小/红色档；"普通"对应中档；"低"对应数值最大）
3. **三字段 p_level + p_name + p_color 必须一起传**（dootask 后端要求一致），从 priorities 列表中选一项的 priority/name/color 三字段值原样传入
4. 不要拿用户描述当 p_name 直接传（如用户说"紧急"但系统档位叫"高优"，应传系统档位的"高优"）
5. 不要把"紧急/高/普通"做成 task_tag 标签——那是优先级，应该走 p_level 字段

【关于 task_tag（任务画像）】
标签 = 任务的多维画像。一个任务可贴 0-N 个标签，每个标签代表对该任务的一个观察/刻画/属性，
彼此独立、可任意组合。设计哲学和"用户画像"/"客户画像"一脉相承。

【三个本质特征】
- 多维：同一任务可同时贴多个标签，从不同侧面刻画
- 多义：标签语义由用户当下场景定义，不预设固定分类系统
- 自由：用户随时引入新维度，无需提前规划标签体系

【可能的画像维度（仅示意，不限于此）】
• 项目阶段子分解（架构设计 / UI / 数据库 / 接口）
• 模块归属（前端 / 后端 / 运维 / 测试）
• 业务领域（金融 / 制造 / 医疗）
• 客户/合作方（核心客户 / 战略客户 / 合作伙伴 A）
• 来源渠道（销售线索 / 老客户介绍 / 主动开发）
• 技术栈（Java / Go / Vue / React）
• 环境（dev / staging / prod）
• 时序属性（Q1 / V2.0 / 2026 春）
• 风险注解（待跟进 / 阻塞中 / 文档缺失）
• 关键词标记 / 重点关注 / 等等

【LLM 工作原则（轻量直写模式）】
- 用户描述任务时，LLM 自动从内容推理画像标签 {name, color} 直接写入 task_tag，无需先维护项目标签库
- dootask 后端 API 接受任何 {name, color}，无需先调 create_project_tag 注册
- list_project_tags / create_project_tag 等工具仅在用户**明确要管理项目标签库**时才用
  （如"看下这个项目的标签库"、"给这个项目加个『核心客户』标签做标签库选项"）
- 子任务不支持 task_tag，调前先 get_task 看 parent_id

【关于 task_tag 的传参格式】
每项标签必须是完整对象 {name: string, color: string}，不是单纯的 name 字符串。
- 直接传 LLM 推理的对象数组即可，例：[{name:"紧急客户",color:"#f56c6c"},{name:"金融",color:"#5470c6"}]
- 不要拆分成 string 数组（dootask 后端会拒绝）

【color 推理建议（无外部上下文时）】
- 紧急/警告类（Red 系）#f56c6c
- 信息/中性类（Blue 系）#5470c6
- 业务/客户类（Orange 系）#E6A23C
- 安全/通过类（Green 系）#19be6b
- 一般维度（Grey 系）#909399
若用户多次提到同一标签名，复用相同 color 保持视觉一致（可选 list_project_tags 查复用）。

【❌ 不该用标签的场景（与已有字段冲突）】
- 紧急度/优先级（紧急/高/普通）→ 用 task.p_level（list_task_priorities）
- 进行中/已完成/待办 → 用看板列（column_id）或 complete_at
- 单选互斥状态 → 用看板列
- 负责人 → 用 owner / assist`,
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
      p_level: z.number().int().optional().describe(
        '优先级档位 priority 值（数值越小越紧急）。建议先 list_task_priorities 拿系统档位列表，根据用户描述（"紧急"→最高档/红色，"普通"→中档）选合适项，三字段 p_level+p_name+p_color 必须一致传（dootask 后端不会自动补色名）。'
      ),
      p_name: z.string().optional().describe('优先级名称，与 p_level 一致（如"紧急"/"重要"/"普通"）'),
      p_color: z.string().optional().describe('优先级颜色 hex（如 #f56c6c），与 p_level 一致'),
      task_tag: z.array(
        z.object({
          name: z.string().min(1).describe('标签名（LLM 从用户描述自由推理，如"金融"/"核心客户"/"待跟进"）'),
          color: z.string().min(1).describe('标签颜色 hex（如 #f56c6c）。LLM 按维度自由分配（红/橙/蓝/绿/灰系），同名标签复用同色'),
        })
      ).optional().describe(
        '任务画像标签数组，每项 {name, color}。LLM 从任务内容自由推理生成，直写即可（dootask 后端无需先注册）。⚠️ dootask 子任务不支持 task_tag。'
      ),
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
      if (args.p_level !== undefined) requestData.p_level = args.p_level;
      if (args.p_name !== undefined) requestData.p_name = args.p_name;
      if (args.p_color !== undefined) requestData.p_color = args.p_color;
      if (args.task_tag !== undefined) requestData.task_tag = args.task_tag;

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
若用户提及的列不存在（如"移到 POC 演示列" 但该项目无此列），应告知用户并建议先新增列。

【关于优先级 p_level/p_name/p_color（用户提到紧急度时强烈推荐）】
1. 用户说"紧急"/"重要"/"高优先级"等紧急度词汇时，先调 list_task_priorities 拿系统档位
2. 根据用户语义推理对应档位（"紧急"通常对应数值最小/红色档；"普通"对应中档；"低"对应数值最大）
3. **三字段 p_level + p_name + p_color 必须一起传**（dootask 后端要求一致），从 priorities 列表中选一项的 priority/name/color 三字段值原样传入
4. 不要拿用户描述当 p_name 直接传（如用户说"紧急"但系统档位叫"高优"，应传系统档位的"高优"）
5. 不要把"紧急/高/普通"做成 task_tag 标签——那是优先级，应该走 p_level 字段

【关于 task_tag（任务画像）】
标签 = 任务的多维画像。一个任务可贴 0-N 个标签，每个标签代表对该任务的一个观察/刻画/属性，
彼此独立、可任意组合。设计哲学和"用户画像"/"客户画像"一脉相承。

【三个本质特征】
- 多维：同一任务可同时贴多个标签，从不同侧面刻画
- 多义：标签语义由用户当下场景定义，不预设固定分类系统
- 自由：用户随时引入新维度，无需提前规划标签体系

【可能的画像维度（仅示意，不限于此）】
• 项目阶段子分解（架构设计 / UI / 数据库 / 接口）
• 模块归属（前端 / 后端 / 运维 / 测试）
• 业务领域（金融 / 制造 / 医疗）
• 客户/合作方（核心客户 / 战略客户 / 合作伙伴 A）
• 来源渠道（销售线索 / 老客户介绍 / 主动开发）
• 技术栈（Java / Go / Vue / React）
• 环境（dev / staging / prod）
• 时序属性（Q1 / V2.0 / 2026 春）
• 风险注解（待跟进 / 阻塞中 / 文档缺失）
• 关键词标记 / 重点关注 / 等等

【LLM 工作原则（轻量直写模式 + 全量覆盖陷阱）】
- 用户用自然语言修改标签时（如"加个紧急客户标签"、"删掉过时标签"、"改成金融+高优"），
  LLM 从任务内容/用户意图直接推理 {name, color} 数组写入 task_tag，无需先维护项目标签库
- ⚠️ **task_tag 全量覆盖陷阱**：update_task(task_tag=...) 与 owner/assist 同模式，不传=清空（后端没有"保留原值"语义）。
  正确流程：
    - 用户说"加 X 标签" → 先 get_task 拿当前 tags → 在内存中合并 [...current, new] → 回写完整数组
    - 用户说"删除 X 标签" → 先 get_task → filter 掉 X → 回写
    - 用户说"改成 X+Y" → 直接传新数组覆盖（无需 get_task）
    - 用户说"清空标签" → 传空数组 []
  反例：用户说"再加个紧急客户标签"，直接 update_task(task_tag=[{name:"紧急客户"}]) 会把其他原标签全部清空
- list_project_tags / create_project_tag 等工具仅在用户**明确要管理项目标签库**时才用
- 子任务不支持 task_tag，调前先 get_task 看 parent_id

【关于 task_tag 的传参格式】
每项标签必须是完整对象 {name: string, color: string}，不是单纯的 name 字符串。
- 直接传 LLM 推理的对象数组即可，例：[{name:"金融",color:"#5470c6"},{name:"待跟进",color:"#909399"}]
- 不要拆分成 string 数组（dootask 后端会拒绝）

【color 推理建议】
- 紧急/警告类 #f56c6c   信息/中性类 #5470c6
- 业务/客户类 #E6A23C   安全/通过类 #19be6b
- 一般维度   #909399
若用户多次提到同一标签名，复用相同 color 保持视觉一致（同名 dootask 后端会按 name 去重）。

【❌ 不该用标签的场景（与已有字段冲突）】
- 紧急度/优先级（紧急/高/普通）→ 用 task.p_level（list_task_priorities）
- 进行中/已完成/待办 → 用看板列（column_id）或 complete_at
- 单选互斥状态 → 用看板列
- 负责人 → 用 owner / assist`,
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
      p_level: z.number().int().optional().describe(
        '优先级档位 priority 值（数值越小越紧急）。建议先 list_task_priorities 拿系统档位列表，根据用户描述（"紧急"→最高档/红色，"普通"→中档）选合适项，三字段 p_level+p_name+p_color 必须一致传（dootask 后端不会自动补色名）。'
      ),
      p_name: z.string().optional().describe('优先级名称，与 p_level 一致（如"紧急"/"重要"/"普通"）'),
      p_color: z.string().optional().describe('优先级颜色 hex（如 #f56c6c），与 p_level 一致'),
      task_tag: z.array(
        z.object({
          name: z.string().min(1).describe('标签名（LLM 从用户描述自由推理，如"金融"/"核心客户"/"待跟进"）'),
          color: z.string().min(1).describe('标签颜色 hex（如 #f56c6c）。LLM 按维度自由分配（红/橙/蓝/绿/灰系），同名标签复用同色'),
        })
      ).optional().describe(
        '任务画像标签数组，每项 {name, color}。⚠️ **全量覆盖**（不传=清空）。增量改动需先 get_task 拿当前 tags 后回写完整数组。⚠️ dootask 子任务不支持 task_tag。'
      ),
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
      if (args.p_level !== undefined) requestData.p_level = args.p_level;
      if (args.p_name !== undefined) requestData.p_name = args.p_name;
      if (args.p_color !== undefined) requestData.p_color = args.p_color;
      if (args.task_tag !== undefined) requestData.task_tag = args.task_tag;

      const task = await makeDootaskRequest(token, 'POST', 'project/task/update', requestData);

      const updates: string[] = [];
      if (args.name !== undefined) updates.push('名称');
      if (args.content !== undefined) updates.push('内容');
      if (args.owner !== undefined) updates.push('负责人');
      if (args.assist !== undefined) updates.push('协助人员');
      if (args.column_id !== undefined) updates.push('列');
      if (args.start_at !== undefined || args.end_at !== undefined) updates.push('时间');
      if (args.complete_at !== undefined) updates.push('完成状态');
      if (args.p_level !== undefined || args.p_name !== undefined || args.p_color !== undefined) updates.push('优先级');
      if (args.task_tag !== undefined) updates.push('标签');

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
