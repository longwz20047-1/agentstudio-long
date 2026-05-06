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

【两个语义匹配两步链路（项目 + 标签）— LLM 不确定标识符场景必走】

dootask 后端按精确匹配查询（tag.name = 单值，project_id = 单值）。但 LLM 生成的标签和
项目名都存在不确定性（同义词、命名差异）。本工具支持 **tag** 和 **project_id** 都传数组，
内部对每个组合做笛卡尔积后端调用 → 按 task.id 合并去重。

(A) 标签语义两步链路：
1. list_project_tags(project_id) 拿项目全部已有标签 name 列表
2. LLM 语义识别相关名（"金融" → ["金融","金融行业","金融科技"]）
3. list_tasks(tag=数组) 一次性查询

(B) 项目语义两步链路：
1. list_projects(search='关键词') 拿候选项目（dootask LIKE 模糊匹配）
2. LLM 从候选中识别真正相关的项目（排除假阳性如"售前归档-2024"）
3. list_tasks(project_id=数组) 跨项目查询

(C) 项目 + 标签组合：两个数组同时传，工具内部做笛卡尔积调用合并去重
   例 N=2 项目 × M=2 标签 → 4 次后端调用 → 合并

例：
- "需求调研的任务完成得怎么样" → list_project_tags + 语义识别 → list_tasks(tag=['需求调研','需求分析'])
- "我所有售前项目的任务" → list_projects(search='售前') + 语义识别 → list_tasks(project_id=[12,15,18])
- "所有售前项目里金融客户的紧急任务" → 双语义识别 → list_tasks(project_id=[12,15], tag=['金融','金融客户'], status='uncompleted')

【列维度过滤（原生支持）】

dootask 后端现已支持按 column_id 单值或数组过滤。配合 list_project_columns
（或 get_project 嵌套 columns）的语义匹配两步链路：

1. list_project_columns(project_id) 或 get_project(project_id) 拿项目全部 columns
2. LLM 用列名语义识别相关列（如"调研阶段" → ["客户调研","需求调研"] → [18, 22]）
3. list_tasks(project_id=X, column_id=[18, 22]) 一次性精确过滤，无需 client-side filter

例：
- "调研阶段的任务" → list_project_columns + 语义识别 → list_tasks(column_id=[18,22])
- "需求调研列的进度" → list_tasks(column_id=18) → 看 status 字段
- "项目 X 商务报价列的核心客户任务" → 三维语义识别 → list_tasks(project_id=X, column_id=[Y], tag=['核心客户'])

【何时传单值（不走两步链路）】
仅当用户明确指定唯一精确名/ID 时直接传字符串/数字。否则默认走两步链路。`,
    {
      status: z.enum(['all', 'completed', 'uncompleted']).optional()
        .describe('任务状态: all(所有), completed(已完成), uncompleted(未完成)'),
      search: z.string().optional().describe('搜索关键词（可搜索任务ID、名称、描述）'),
      tag: z.union([z.string(), z.array(z.string())]).optional()
        .describe(
          '按标签名过滤（dootask 后端单次精确匹配）。'
          + '推荐先 list_project_tags 拿全部名 → LLM 语义识别相关 → 传字符串数组。'
          + '工具内部对数组每项 + project_id 数组每项做笛卡尔积调用并按 task.id 合并去重。'
          + '单值传 string，多值传 string[]'
        ),
      time: z.string().optional()
        .describe('时间范围: today/week/month/year 或自定义 "2025-12-12,2025-12-30"'),
      project_id: z.union([z.number(), z.array(z.number())]).optional()
        .describe(
          '项目ID过滤（dootask 后端单次单值）。'
          + '推荐先 list_projects(search=关键词) 拿候选 → LLM 语义识别相关项目 → 传数字数组跨项目查询。'
          + '工具内部对每项 + tag 数组每项做笛卡尔积调用并按 task.id 合并去重。'
          + '单值传 number，多值传 number[]'
        ),
      column_id: z.union([z.number(), z.array(z.number())]).optional()
        .describe(
          '按看板列ID过滤（dootask 后端 keys.column_id 支持单值/数组，本工具内部 wrap 数组并行调用合并去重）。'
          + '推荐先调 list_project_columns 或 get_project 拿 column_id（基于用户描述的列名做语义匹配后传入）。'
          + '单值传 number，多值传 number[]'
        ),
      parent_id: z.number().optional()
        .describe('主任务ID。>0:获取该主任务的子任务；-1:仅获取主任务；不传:所有任务'),
      page: z.number().optional().describe('页码，默认 1'),
      pagesize: z.number().optional().describe('每页数量，默认 20，最大 100'),
    },
    async (args) => {
      const token = await ctx.getToken();

      // 公共过滤构造器（单次后端调用的 requestData）
      const buildRequest = (tagValue?: string, projectIdValue?: number, columnIdValue?: number): Record<string, unknown> => {
        const req: Record<string, unknown> = {
          page: args.page || 1,
          pagesize: args.pagesize || 20,
        };
        const keys: Record<string, unknown> = {};
        if (args.search) keys.name = args.search;
        if (args.status && args.status !== 'all') keys.status = args.status;
        if (tagValue) keys.tag = tagValue;
        if (columnIdValue !== undefined) keys.column_id = columnIdValue;
        if (Object.keys(keys).length > 0) req.keys = keys;
        if (args.time !== undefined) req.time = args.time;
        if (projectIdValue !== undefined) req.project_id = projectIdValue;
        if (args.parent_id !== undefined) req.parent_id = args.parent_id;
        return req;
      };

      // 把 tag / project_id / column_id 入参规范成数组（undefined→[undefined] 表示该维度不过滤）
      const tagList: (string | undefined)[] = Array.isArray(args.tag)
        ? args.tag
        : args.tag !== undefined ? [args.tag] : [undefined];
      const projectIdList: (number | undefined)[] = Array.isArray(args.project_id)
        ? args.project_id
        : args.project_id !== undefined ? [args.project_id] : [undefined];
      const columnIdList: (number | undefined)[] = Array.isArray(args.column_id)
        ? args.column_id
        : args.column_id !== undefined ? [args.column_id] : [undefined];

      const isMultiTag = Array.isArray(args.tag) && args.tag.length > 1;
      const isMultiProject = Array.isArray(args.project_id) && args.project_id.length > 1;
      const isMultiColumn = Array.isArray(args.column_id) && args.column_id.length > 1;

      // 三维笛卡尔积：tag × project_id × column_id
      const combos: Array<{ tag?: string; project_id?: number; column_id?: number }> = [];
      for (const t of tagList) {
        for (const p of projectIdList) {
          for (const c of columnIdList) {
            combos.push({ tag: t, project_id: p, column_id: c });
          }
        }
      }

      // 并行调用所有组合
      const responses = await Promise.all(
        combos.map((c) =>
          makeDootaskRequest(token, 'GET', 'project/task/lists', buildRequest(c.tag, c.project_id, c.column_id))
        )
      );

      // 合并 + 按 task.id 去重（多 tag/多 project 时一个任务可能被多个组合命中）
      const taskMap = new Map<number, any>();
      for (const data of responses) {
        for (const t of data.data || []) {
          if (!taskMap.has(t.id)) taskMap.set(t.id, t);
        }
      }
      const mergedTasks = Array.from(taskMap.values());

      // 多 combo 时 total = 去重后数量；单 combo 用后端原 total
      const isMultiCombo = isMultiTag || isMultiProject || isMultiColumn;
      const finalTotal = isMultiCombo ? mergedTasks.length : (responses[0]?.total ?? mergedTasks.length);

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
            // 多值过滤时回显本次用了哪些标签/项目/列做并集查询，方便 LLM 自检
            ...(isMultiTag ? { tag_filter: args.tag } : {}),
            ...(isMultiProject ? { project_filter: args.project_id } : {}),
            ...(isMultiColumn ? { column_filter: args.column_id } : {}),
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

═══════════════════════════════════════════════════════════════
【完整工作流总览（Phase 1 → 2 → 3）】
═══════════════════════════════════════════════════════════════

⚠️ create_task 不是简单字段填充——是产品化任务管理流程的终点。
调用前必须分两阶段引导，不要一上来就调 create_task。

▼ Phase 1（信息收敛 · LLM 内部推理 + 工具调用，不打扰用户）
  1. 确定 project_id（用户没说 → list_projects 让选）
  2. 收敛 name + content（用户给得简单 → LLM 丰富）
  3. list_project_columns 看现有阶段列
  4. list_task_priorities 看系统优先级档位
  5. 推理 column_id 匹配 / task_tag 画像 / p_level 优先级
  6. 评估子任务分解可能

▼ Phase 2（草稿一次性呈现 · MUST 等用户确认）
  把 Phase 1 推理的全部字段组成"任务草稿卡片"
  让用户一次确认或调整（避免 5 次往返追问）

▼ Phase 3（执行 · 草稿确认后才调）
  - 用户同意建新列 → create_column / create_columns_batch
  - 然后 create_task（所有字段就位）
  - 用户同意分解 → 循环 create_sub_task × N

❌ 严禁：跳过 Phase 1 直接 create_task / 草稿没确认就创建 /
        全部字段用默认 / 凭上下文猜测必给字段

═══════════════════════════════════════════════════════════════
【字段规则（按依赖顺序）】
═══════════════════════════════════════════════════════════════

═══ project_id（用户必给，不能猜）═══

⚠️ MUST：用户没明确指定项目时，禁止凭"上下文猜"（即使用户上次提过）。
  → list_projects 拿到用户参与的项目
  → "您要在哪个项目下创建？以下是您参与的项目：[列表]"
  → 等用户选择 / 模糊则继续追问

═══ name + content（内容收敛 · 简单则丰富 + 用户确认）═══

判断"简单"的标准：
  · content 字数 < 30 + 缺具体技术词/业务词/子项 → 简单 → MUST 丰富
  · content 含具体子项/技术栈/业务场景 → 完整 → 直接用

LLM 丰富 content 的指导：
  · 围绕用户输入的关键词扩展技术细节
  · 不要凭空增加用户未提的功能（避免过度脑补）
  · 丰富后必须放到草稿卡片让用户审阅（不要直接传）

═══ column_id（项目阶段）═══

⚠️ **看板列严格定义** = 项目阶段（Kanban 列）
- 不是任务状态、不是优先级、不是分类
- 是"项目走到哪一步"（需求→设计→开发→测试→上线 这种）
- 不管什么类型的项目，**一定有项目阶段** → 一定有看板列

⚠️ **看板列严格定义** = 项目阶段（Kanban 列）
- 不是任务状态、不是优先级、不是分类
- 是"项目走到哪一步"（需求→设计→开发→测试→上线 这种）
- 不管什么类型的项目，**一定有项目阶段** → 一定有看板列

⚠️ **MUST 流程（任何创建任务前必跑）**：

【Step 1】list_project_columns(project_id) 看现有阶段列。

【Step 2】根据**任务内容**评估和现有列的匹配度（这是关键判断）：

  ① 高匹配（任务名/内容直接命中某列语义）：
     例：项目阶段=[需求,设计,开发,测试,上线]
        任务="用户中心 UI 设计" → 直接命中"设计"列（高匹配）
        任务="登录模块开发" → 直接命中"开发"列（高匹配）
     → 选这个列做 column_id，无需追问

  ② 中匹配（任务勉强能放某列但语义不直接）：
     例：项目阶段=[需求,设计,开发,测试,上线]
        任务="撰写 API 文档" → "开发"也行但单独"文档"列更合适
     → ❌ 不要硬塞！主动追问用户：
        "任务『撰写 API 文档』可以放到现有『开发』列，
          也可以新增『文档』列单独管理。建议新增列以便追踪文档进度。
          您选哪种？(a) 放现有列 (b) 新增『文档』列"

  ③ 低匹配（任务明显不属于任何现有列）：
     例：项目阶段=[线索,合同,交付]（销售流程）
        任务="POC 演示" → 销售流程没有"演示"或"POC"阶段
     → ❌ 必须建议新增列：
        "任务『POC 演示』和现有列（线索/合同/交付）匹配度低。
          建议新增『POC』列。是否同意？"

  ④ 仅 1 个 Default 列（项目阶段未规划）：
     → ❌ 禁止直接落 Default！必须先引导用户规划阶段：
        "这个项目还没规划阶段（仅有 Default 列），
          请问这是什么类型的项目？（软件/销售/产品研发/咨询/其他）"
        → 用户答 → 给阶段方案让用户确认 → create_columns_batch 建列
        → 选最匹配的新列做 column_id

【Step 3】当 ②/③/④ 用户同意建新列时，**必须 chain call**：
  a) create_column(project_id, name='新列名')  或  create_columns_batch(...)
     → 工具返回的 response 含新列的 column_id
  b) ⚠️ 把上一步返回的 column_id **真的传给** create_task！
     不要在新建列后又 skip column_id 落 Default → 那是 bug 行为

【Step 4】仅当用户**明确**说"暂时不分阶段"/"先丢 Default"/"占位先放着"
  才允许 column_id=Default 列 id。沉默不算同意，必须用户主动豁免。

⚠️ **常见项目类型阶段模板**（无外部上下文时引导用户用）：
- 软件开发：需求分析 / 设计 / 开发 / 测试 / 上线
- 销售流程：线索接洽 / 需求调研 / 方案设计 / 商务报价 / 合同签订 / 交付实施
- 产品研发：调研 / 设计 / 开发 / 灰度 / 正式发布
- 咨询服务：需求洽谈 / 方案撰写 / 评审 / 实施 / 复盘
- 内容运营：选题 / 撰稿 / 审核 / 发布 / 效果评估
- 招聘：JD 撰写 / 简历筛选 / 初面 / 复试 / Offer / 入职

❌ **禁止行为**：
- 直接 create_task 不传 column_id（任务落 Default 破坏看板可视化）
- 看到只有 Default 列就直接选 → 必须先引导规划阶段
- 任务和现有列匹配度低还硬塞 → 必须建议新增列
- 建了新列却没把新列 column_id 传给 create_task（chain call 断裂）
- 用 task_tag 替代项目阶段（task_tag 是任务画像维度，不是阶段）

【对话样例 1：高匹配 → 直接选】
User: "测试产品开发项目加个任务：登录模块开发"
LLM: [list_project_columns(9)] → [需求,设计,开发,测试,上线]
LLM: → create_task(column_id=开发列id, task_tag=[...])（无需追问，高匹配直接选）

【对话样例 2：中匹配 → 追问让用户选】
User: "测试产品开发项目加个任务：撰写用户手册"
LLM: [list_project_columns(9)] → [需求,设计,开发,测试,上线]
LLM: "任务『撰写用户手册』可以放到现有『上线』列（视为发布前准备），
      也可以新增『文档』列单独管理。建议新增列以便追踪文档进度。您选哪种？
      (a) 放『上线』列  (b) 新增『文档』列"
User: "新增"
LLM: → create_column(project_id=9, name='文档') → 拿到新列 column_id=N
     → create_task(column_id=N, task_tag=[...])  ← MUST 用新列 id

【对话样例 3：低匹配 → 必须建议新增】
User: "招商客户项目加任务：POC 演示"
LLM: [list_project_columns(X)] → [线索,合同,交付]
LLM: "任务『POC 演示』和现有阶段（线索/合同/交付）匹配度低，
      销售流程通常 POC 演示属于"方案设计→商务报价"之间。
      建议新增『方案设计』和『商务报价』两列。是否同意？"
User: "同意"
LLM: → create_columns_batch(project_id=X, columns=[
        {name:'方案设计'}, {name:'商务报价'}
      ]) → 拿到新列 column_id 数组
     → create_task(column_id=方案设计列id, task_tag=[...])

【对话样例 4：仅 Default 列 → 引导规划阶段】
User: "测试产品开发项目加个任务：消息推送系统优化"
LLM: [list_project_columns(9)] → 仅 [Default]
LLM: "这个项目还没规划阶段（仅有 Default 列）。请问这是什么类型的项目？
      软件开发？产品研发？我会根据类型为您规划项目阶段列。"
User: "软件开发"
LLM: "建议为该项目建立 5 个阶段：需求/设计/开发/测试/上线。是否确认？"
User: "可以"
LLM: → create_columns_batch(project_id=9, columns=[
        {name:'需求'},{name:'设计'},{name:'开发'},{name:'测试'},{name:'上线'}
      ]) → 5 列建好，拿到新列 column_id 数组
     → 推理"消息推送系统优化"匹配"开发"列
     → create_task(column_id=新开发列id, task_tag=[...])

═══ p_level（优先级 · 系统字典 + MUST 引导）═══

⚠️ **优先级是任务管理的核心属性，不是装饰品**：
- get_task_completion_stats 工具用 p_level 做**加权完成率统计**
- 全部默认 = 统计失真 = "项目完成率"无业务意义
- 不能 skip，不能默认按 dootask 后端 is_default 档位

⚠️ **优先级是系统字典**（管理员可配置，不是 LLM 假设）：
- 调 list_task_priorities → 返回 Array<{priority, name, color, days, is_default}>
- 不同租户可能配置不同档位（4 档/5 档/自定义名称）
- LLM 必须**从字典实际返回值**里选档位，不要自己假设档位名

⚠️ **典型字典示例（艾森豪威尔四象限，本系统当前值）**：
  priority=1  name="重要且紧急"     color=#ED4014  days=1  ← is_default
  priority=2  name="重要不紧急"     color=#F16B62  days=3
  priority=3  name="紧急不重要"     color=#19C919  days=5
  priority=4  name="不重要不紧急"   color=#2D8CF0  days=0

⚠️ **判断维度（这个矩阵需要 2 维评估，不是简单 4 档）**：
  · 重要性：任务是否影响业务关键目标 / 是否无法跳过
  · 紧急性：是否有明确截止时间 / 是否阻塞下游

【MUST 流程】

Step 1：list_task_priorities 拿真实字典（不假设档位名）

Step 2：基于任务内容做"重要 + 紧急"二维评估：
  · "线上 P0 故障 / 客户投诉立刻处理" → 重要且紧急（priority=1）
  · "下季度战略规划 / 架构重构" → 重要不紧急（priority=2）
  · "临时帮同事查个数据 / 临时会议纪要" → 紧急不重要（priority=3）
  · "可有可无的优化 / 内部演示装饰" → 不重要不紧急（priority=4）

Step 3：草稿展示推理结果让用户确认/调整：
  "我评估这个任务为『重要且紧急』（priority=1，红色，
    建议 1 天完成）— 影响完成率加权统计。请确认或调整。"

Step 4：用户没说紧急度时（最常见）：MUST 主动追问，列出字典实际档位
  让用户选，禁止默默用 is_default 档位
  "字典中可选档位：① 重要且紧急 ② 重要不紧急 ③ 紧急不重要 ④ 不重要不紧急。
    您选哪个？"

Step 5：用户确认后传 p_level + p_name + p_color 三字段（**必须从字典原样取**，
  不能拿用户口语化描述当 p_name）

❌ 禁止：跳过 list_task_priorities 凭"我以为有 紧急/高/普通/低 4 档"硬编码
❌ 禁止：用用户原话当 p_name（用户说"紧急"但字典叫"重要且紧急"，传"重要且紧急"）
❌ 禁止：单独传 p_level 不传 p_name/p_color（三字段必须从字典同一项原样取）
❌ 禁止：把"紧急/重要"做成 task_tag——那是 p_level 维度
❌ 禁止：用户没说就静默用 is_default 档位（破坏完成率加权统计）

═══ task_tag（任务画像 · 内容丰富后画 + 用户确认）═══

⚠️ **MUST 时机**：在 content 收敛完整后才推理（基于丰富后版本画像，
不要基于用户初始简短输入）。

⚠️ **MUST 推理**：当 content 含 ≥2 个画像信号词（业务领域/技术栈/
模块/客户/环境/紧急性）时，必须推理 task_tag（≥2 项）。

⚠️ **MUST 用户确认**：推理结果必须放到 Phase 2 草稿卡片让用户确认/调整。
不要直接传给 create_task 视为"已经确认"。

【画像维度（仅示意，不限于此）】
- 项目阶段子分解（架构 / UI / 数据库 / 接口）
- 模块归属（前端 / 后端 / 运维 / 测试）
- 业务领域（金融 / 制造 / 医疗）
- 客户/合作方（核心客户 / 战略客户）
- 技术栈（Java / Go / Vue / React）
- 环境（dev / staging / prod）
- 时序属性（Q1 / V2.0）
- 风险注解（待跟进 / 阻塞中）

【格式 + color 推理】
- 每项必须 {name: string, color: string}（不是 string 数组，dootask 后端拒绝）
- color 系：红 #f56c6c（紧急/警告）/ 蓝 #5470c6（信息/中性）/ 橙 #E6A23C（业务/客户）/
           绿 #67C23A（安全/通过）/ 灰 #909399（一般）
- 同名标签复用同色（保持视觉一致）

【❌ 不该用标签的场景】
- 紧急度/优先级（紧急/高/普通）→ 用 p_level
- 任务状态（进行中/完成/待办）→ 用 column_id 或 complete_at
- 单选互斥状态 → 用 column_id
- 负责人 → 用 owner / assist

仅当 content 完全无画像信号（如"测试"/"占位"）时才允许 task_tag 留空。

═══ 子任务分解（任务明确含子项时主动建议）═══

【判断信号】

强信号（应主动建议分解）：
- content 含编号列表（"1./2./3."）
- 含"包括/分为/几个/和/、" 等并列词
- 多个明确独立子项（如"实时性/分类/重试/并发/日志/文档"6 项）

弱信号（可选询问）：
- 任务粒度大（"重构整个 X 模块"）但子项不清晰

不应分解：
- 任务清晰单一（"修复登录 bug"）
- 用户明确说"先建主任务"

【流程】
强信号场景：
  在 Phase 2 草稿卡片下方加建议：
  "此任务包含 N 个子项（[列表]），建议同时分解为子任务，是否一并创建？"
  · 用户同意 → 主任务 create_task 后循环 create_sub_task × N
  · 用户拒绝 → 仅创建主任务

【子任务字段约束】
- column_id：默认继承父任务（dootask 后端自动）
- task_tag：dootask UI 不渲染子任务 tag（API 可写但 UI 看不到，慎用）
- p_level：可省（继承父任务的紧急度语义）

═══ owner / 时间字段 ═══

owner：
- 用户提到 "@xxx"/具体人名 → search_users 找 userid → 传 owner
- 用户说"我自己"/没提 → 用 caller userid（默认）

start_at / end_at：
- 用户提到时间词（"明天/下周/X 月底"）→ 推理具体时间传
- 没提 → 留空（dootask 后端不强制）

═══════════════════════════════════════════════════════════════
【Phase 2 草稿卡片格式（用户确认模板）】
═══════════════════════════════════════════════════════════════

Phase 1 信息收敛完成后，用以下格式呈现草稿等用户确认：

┌─ 任务草稿（确认创建？）───────────────────┐
│  📁 项目：[项目名]                          │
│  📝 任务：[任务名]                          │
│  📋 内容：[content 丰富版本]               │
│  🎯 阶段：[列名]（[匹配度说明]）             │
│  🏷️ 画像：[tag1 / tag2 / tag3 / ...]       │
│  ⚡ 优先级：[档位名]（权重 N，[颜色]）       │
│  👤 负责人：[名字]                          │
│  📅 时间：[start ~ end]（如有）              │
│                                             │
│  [可选] 额外建议：可分解为 N 个子任务        │
│                                             │
│  请确认 ✅ / 调整字段 ✏️ / 取消             │
└────────────────────────────────────────────┘

用户回复：
- ✅ / "确认" / "y" → 执行 Phase 3
- "调整 X 为 Y" → 修改字段后重新呈现草稿
- "取消" → 不创建

═══════════════════════════════════════════════════════════════
【完整流程对话样例】
═══════════════════════════════════════════════════════════════

【样例 5：完整 Phase 1→2→3（用户输入简单 + 没指定项目）】

User: "新建任务：用户中心"
LLM:
  Phase 1：project_id 缺失
  → list_projects → 拿到候选
LLM: "您要在哪个项目下创建？以下是您参与的项目：
      1) 测试产品开发  2) 招商客户跟进  3) 内容运营 2026Q1"
User: "1"
LLM:
  Phase 1（继续）：
    - content="用户中心" 简单 → MUST 丰富
    - list_project_columns(1) → [需求,设计,开发,测试,上线]
    - list_task_priorities → 系统档位
    - 推理 column_id="开发"列（高匹配，"用户中心"是开发任务）
    - 推理 task_tag=[用户中心,前端,用户管理]
    - p_level 用户没说 → MUST 草稿里追问
  Phase 2 草稿：
    "📁 项目：测试产品开发
     📝 任务：用户中心
     📋 内容（建议丰富版本）：实现用户中心模块，包括：
        1) 用户信息展示  2) 资料编辑  3) 头像上传  4) 密码修改
     🎯 阶段：开发列（高匹配）
     🏷️ 画像：用户中心 / 前端 / 用户管理
     ⚡ 优先级：?（请告知，影响完成率统计权重 — 紧急/高/普通/低）
     👤 负责人：您
     额外建议：可分解为 4 个子任务（信息展示/资料编辑/头像/密码），
              是否一并创建？
     请调整或确认。"
User: "我评估为重要不紧急吧，分解子任务"
LLM:
  Phase 3：
    - create_task(project_id=1, name="用户中心", content="...",
                  column_id=开发列id, task_tag=[用户中心,前端,用户管理],
                  p_level=2, p_name="重要不紧急", p_color="#F16B62"
                  ← 三字段从 list_task_priorities 字典 priority=2 项原样取)
    - 循环 4 次 create_sub_task

═══════════════════════════════════════════════════════════════
【❌ 禁止行为汇总（按层级）】
═══════════════════════════════════════════════════════════════

⛔ 流程层（最严重）：
- 跳过 Phase 1 信息收敛直接 create_task
- 跳过 Phase 2 草稿确认直接执行
- 草稿呈现后用户没回复就执行（沉默不算同意）
- 用户没指定项目就凭"上下文猜"

⛔ 字段层：
- create_task 不传 column_id 落 Default（破坏看板可视化）
- 草稿没确认就把 task_tag 直接传给 create_task
- p_level 用户没说就默认填"普通"（破坏完成率加权）
- 单独传 p_level 不传 p_name/p_color（三字段必须一致）
- task_tag 拆成 string 数组（必须是 {name,color} 对象数组）

⛔ Chain call 层：
- 建了新列没把新 column_id 传给 create_task（chain call 断裂）
- 用户同意分解但只创建主任务（漏 create_sub_task）

⛔ 语义层：
- 用 task_tag 替代项目阶段（task_tag 是画像维度，不是阶段）
- 把"紧急/高/普通"做成 task_tag（那是 p_level）
- 任务和现有列匹配度低还硬塞（应建议新增列）`,
    {
      project_id: z.number().min(1).describe('项目ID'),
      name: z.string().min(1).describe('任务名称'),
      content: z.string().optional().describe('任务内容描述（Markdown 格式）'),
      owner: z.array(z.number()).optional().describe('负责人用户ID数组'),
      assist: z.array(z.number()).optional().describe('协助人员用户ID数组'),
      column_id: z.number().optional().describe(
        '看板列ID = 项目阶段（不是任务状态/优先级/分类）。⚠️ MUST 流程：'
        + '① 先 list_project_columns(project_id) → ② 评估列状态 → ③ '
        + '若仅 Default 列必须先引导规划阶段+create_columns_batch 建列，'
        + '若现有阶段匹配则选最近列，若不匹配则建议新增列。'
        + '❌ 禁止落 Default（除非用户明确豁免）。'
      ),
      start_at: z.string().optional().describe('开始时间 YYYY-MM-DD HH:mm:ss'),
      end_at: z.string().optional().describe('结束时间 YYYY-MM-DD HH:mm:ss'),
      p_level: z.number().int().optional().describe(
        '⚠️ 优先级 priority 值（系统字典维护，不是 LLM 假设）。MUST 流程：'
        + '① list_task_priorities 拿真实字典 → ② 基于"重要 + 紧急"二维评估 → '
        + '③ 草稿确认 → ④ 三字段从字典同一项原样取（不能用用户口语化词当 p_name）。'
        + '影响 get_task_completion_stats 加权统计，不能默认。'
      ),
      p_name: z.string().optional().describe(
        '优先级名称，⚠️ MUST 从 list_task_priorities 返回字典中某项 name 原样取。'
        + '当前系统典型字典："重要且紧急"/"重要不紧急"/"紧急不重要"/"不重要不紧急"（艾森豪威尔四象限）。'
        + '禁止用用户口语化词（如"紧急"/"高"）当 p_name 直接传——必须用字典中真实 name。'
      ),
      p_color: z.string().optional().describe(
        '优先级颜色 hex，必须和 p_level/p_name 来自字典同一项（如 priority=1 项的 color 是 #ED4014）。'
        + '不能 LLM 自己生成颜色。'
      ),
      task_tag: z.array(
        z.object({
          name: z.string().min(1).describe('标签名（LLM 推理画像维度，如"金融"/"核心客户"/"待跟进"）'),
          color: z.string().min(1).describe('标签颜色 hex（红 #f56c6c / 蓝 #5470c6 / 橙 #E6A23C / 绿 #67C23A / 灰 #909399），同名复用同色'),
        })
      ).optional().describe(
        '任务画像标签数组，每项 {name, color}。⚠️ MUST 流程：'
        + '① content 收敛完整后再推理（基于丰富版内容）；'
        + '② content 含 ≥2 画像信号词时必须 ≥2 个 tag；'
        + '③ MUST 在 Phase 2 草稿卡片让用户确认后才传（不要直接传跳过确认）。'
        + '⚠️ dootask UI 不渲染子任务 tag（虽 API 可写）。'
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
