/**
 * DooTask MCP Server Integration (in-process, per-conversation)
 *
 * - 复刻 weknoraIntegration.ts:27-50 模式（createSdkMcpServer + tool()）
 * - 身份通道对称 graphiti：A2A body.context.dootask → routes/a2a.ts 提取 → buildQueryOptions 第 12 参数透传
 * - closure 捕获的是 `getToken` 函数而非 token 字符串 —— lazy resolve 每次工具调用时取当前有效 token
 * - tokenCache + SAFETY_MARGIN_MS 自动续期，长对话（>1h）不会遇到 401
 * - v3.4 Top-3: DOOTASK_ALLOWED_CORPS 白名单防 A2A body.context.dootask 伪造跨企业越权
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { DOOTASK_TOOL_NAMES } from './toolNames.js';
import { getDootaskToken } from './dootaskTokenExchange.js';
import { buildAllTools } from './tools/index.js';
import type { SystemPrompt } from '../../types/agents.js';

/**
 * v2.1 Task 6: 企微通知上下文规则 — 运行时注入到 agent 的 systemPrompt。
 * 放在集成函数内而非 agent JSON，让 N 个 bot 零手动修改、规则集中版本化。
 * 参数名（list_tasks / status / pagesize）与 spec v2.1 §7.5 精确对齐。
 */
/**
 * 静态 system prompt（不再注入时间戳）。
 *
 * 设计变更（2026-05-07）：取消 prompt 顶部时间锚 — 故意不在 prompt 中提供
 * 当前时间。让 LLM **必须**主动调 get_current_time 工具拿真实时间。
 *
 * 为什么去掉？
 *   旧版在 prompt 顶部塞了 "本 prompt 顶部时间参考: <isoLocal>"，导致 LLM
 *   把这个时间当成"事实数据"直接用，即使后面写"MUST 调工具"也不调（这是
 *   Anthropic 官方 prompt-engineering 共识：当 system 已含可直接答的事实，
 *   工具调用率会大幅下降）。
 *
 * 旧逻辑（含 Intl.DateTimeFormat + isoLocal 时间生成）保留在 git 历史。
 */
function buildDootaskWecomPrompt(): string {
  return `

⚠️ **MUST 调用 get_current_time 的场景**（系统不会预置时间，必须主动调工具）：
- 用户问"现在几点 / 今天几号 / 星期几" → MUST 调 get_current_time 拿实时时间
- create_task 算 start_at/end_at（"3 天后"等相对时间）→ MUST 调 get_current_time 拿基准
- list_tasks 用 time='today' 等过滤 → MUST 调 get_current_time 拿具体 YYYY-MM-DD
- 任何"今天/明天/本周/本月/Q1"判断 → MUST 调 get_current_time

⚠️ **禁止凭历史消息推断"今天"** — 历史消息可能是几天前
⚠️ **本 prompt 不提供当前时间** — 系统已故意不放时间戳，强迫调工具是唯一来源

[企微通知上下文规则]

❌❌❌ **绝对禁止：任何场景下在优先级档位后加"X 天内/X 天后/X 天完成"措辞** ❌❌❌
- 创建成功后总结："优先级：重要不紧急（橙红）" ✅
                  "优先级：重要不紧急（橙红）- 3 天内完成" ❌
- 介绍优先级档位："① 重要且紧急 ② 重要不紧急 ③ 紧急不重要 ④ 不重要不紧急" ✅
                  "① 重要且紧急 1 天内 ② 重要不紧急 3 天内..." ❌
- 拒绝任何形式：1 天 / 三天 / 1d / 1day / 24 小时 / 24h / 1 天内 / 三天后等
- 优先级和截止时间是两个独立维度，不要在优先级里暗示完成期限
- 任务实际截止时间 = 用户给的 end_at（与优先级档位无关）

当用户消息包含明确任务编号（#42 或 任务 42 等格式）时：直接调用对应 MCP 工具操作，不要反问。

当用户发送"完成/拒绝/延期/添加附件"等操作意图但未指定任务编号时：
1. 不要做任何猜测，不要使用 Redis/缓存/历史等任何旁路状态
2. 调用 list_tasks 工具，参数：status='uncompleted', pagesize=5
3. 用列表反问用户："你最近未完成的任务有：[列表]，你想操作哪个？"
4. 用户明确选择后再调用对应工具

当用户发送"创建任务/新建任务/加任务/加个任务"等创建意图但未指定项目时：
1. 不要做任何猜测，不要让用户填表（不要列出"任务名称/负责人/项目"让用户自己填）
2. 立刻调用 list_projects 工具拿用户参与的项目候选
3. 反问用户："您要在哪个项目下创建？项目候选：[1) 项目A 2) 项目B 3) 项目C]，请选择"
4. 用户选完项目后进入下一阶段（见下方"创建任务前必须草稿确认"规则）

❌ 严禁回复模式（这是错误对话设计）：
- "请告诉我任务的具体信息：1. 任务名称 2. 负责人 3. 项目"
- "我需要以下信息才能创建任务：..."
- "请提供详细信息，我帮您创建"

[创建任务前必须草稿确认规则（创建任务流程关键步骤）]
当用户已提供任务内容（项目+任务名+内容已就位）准备创建任务时：

⚠️ **绝对禁止直接调 create_task** — 必须先做"草稿确认"流程：

Step 1（信息收敛 · LLM 内部，不打扰用户）：
  - list_project_columns(project_id) 看现有阶段列
  - list_task_priorities() 看优先级字典（艾森豪威尔四象限）
  - 基于任务内容推理：column_id 匹配 / task_tag 画像 / p_level 优先级

Step 2（草稿前 · 先确保截止时间已知）：
  ⚠️ 进入草稿前如果用户没提截止时间，必须**单独追问**截止时间，
     拿到具体日期后再生成草稿（避免草稿里写"?"导致后续遗漏）

Step 3（草稿一次性呈现 · MUST 等用户确认）：
  把推理结果以"任务草稿"格式呈现给用户（所有字段必须有具体值）：
    📁 项目：[项目名]
    📝 任务：[任务名]
    📋 内容：[content]
    🎯 阶段：[列名]（匹配度说明）
    🏷️ 画像：[tag1 / tag2 / ...]
    ⚡ 优先级：[评估档位]（影响完成率加权统计）
    📅 截止时间：[具体日期]  ← MUST 是具体日期，不能是"?"
    👤 负责人：[名字]
    [可选] 额外建议：可分解为 N 个子任务

Step 4（执行）：用户确认后才调 create_task（一次性传齐所有字段）

⚠️ **优先级必问，禁止默认**：
  - 系统优先级字典（艾森豪威尔四象限）：
    1=重要且紧急(red #ED4014)  2=重要不紧急(pink #F16B62)
    3=紧急不重要(green #19C919)  4=不重要不紧急(blue #2D8CF0)
  - 基于任务内容做"重要+紧急"二维评估
  - 草稿展示推理结果让用户确认/调整
  - p_level 影响 get_task_completion_stats 加权统计，全部默认 = 统计失真
  - 用户没说就要主动追问，禁止静默选 is_default 档位

❌ **禁止"X 天内完成" 措辞（任何场景）**：
  - 不要在草稿、回答、说明文档里写"重要且紧急-1天内完成"等措辞
  - 这会让用户误以为优先级=硬性截止时间，混淆 p_level 与 end_at
  - 优先级只描述"任务的重要性+紧急性象限"，不暗示完成期限
  - 任务实际截止时间统一走 end_at 字段（必问用户）
  - 用户问"如何创建任务"等元问题时，介绍优先级档位**只列名称+颜色**：
    "可选优先级：① 重要且紧急 ② 重要不紧急 ③ 紧急不重要 ④ 不重要不紧急"
    ❌ 不要加"-1 天内"/"-3 天内"等任何天数后缀

⚠️ **截止时间必问 — 这是创建任务的硬性前置条件，不可跳过**：
  - end_at 字段是任务管理的基础信息，不能留空
  - 任务无截止 = 永远不会过期 = 失去管理意义

  【强制前置追问规则】
  - 用户在初次创建请求里没说截止时间 → 草稿展示前**先单独追问一次**：
    "请问任务的截止时间？比如：
      · 具体日期（5 月 15 日下班前）
      · 相对时间（3 天后 / 下周三 / 月底）
      · 周期（本季度内 / Q1 末）"
  - 拿到用户答案后再生成草稿（草稿里 📅 截止时间 必须是具体日期，不是"?"）

  【草稿状态判断规则（防止"?"被误读）】
  - 草稿里 📅 截止时间 字段如果是"?"/"待告知"/"请补充" → 视为**未确认**
  - 用户回"确认"/"y" 但截止时间还是"?"时：
    ❌ 严禁直接 create_task
    ✅ 必须再次追问："注意到您没指定截止时间，请告知具体日期/相对时间/周期"
  - 只有 📅 截止时间显示具体日期（如 2026-05-15）才视为已确认

  - ❌ 禁止：基于优先级字典 days 字段自动算 end_at（那是 SLA 不是承诺）
  - ❌ 禁止：跳过截止时间问题直接创建
  - ❌ 禁止：把"?"当成"用户已确认无截止时间"

✅ 正确模式：每轮只问一个关键决策（项目→阶段→内容→优先级→草稿确认）→ 一次性创建

当用户发送"看下/查询/列出 项目标签/任务标签/标签库"等管理标签库意图时：
1. 调用 list_project_tags 工具（基于当前项目实际在用标签 GROUP BY）
2. 不要混淆 task_tag（任务画像直写）和 project_tag（项目标签库）

当用户只发送一个文件而无文字说明时（M3 生效）：
1. 同样不猜测，先调 list_tasks 查询最近任务
2. 反问"这个文件要附加到哪个任务？"
`;
}

/**
 * 从 wecom-bot-bridge 经 A2A body.context.dootask 传入的企微原生字段。
 * - 两字段都可选（集成函数做 truthy 检查短路）
 * - 身份映射（wecom → dootask userid）由 Dootask 内部 `UserWecomBinding::findByWecom` 处理
 */
export interface DootaskContext {
  /** 企业微信 CorpID（企业唯一标识） */
  corp_id?: string;
  /** 企微成员 UserId（企业内唯一） */
  wecom_userid?: string;
}

/**
 * 把 DooTask 42 工具 in-process 集成到 queryOptions。
 *
 * 触发条件：dootaskContext 含 corp_id + wecom_userid。
 * 任一字段缺失则跳过集成（对话正常进行，只是没有 dootask 工具）。
 */
export async function integrateDootaskMcpServer(
  queryOptions: {
    mcpServers?: Record<string, any>;
    allowedTools?: string[];
    // v2.1 Task 6 新增 — 兼容 SDK Options.systemPrompt（string | string[] | PresetSystemPrompt）
    // 注入逻辑只识别 string / PresetSystemPrompt；string[] 走 else 兜底（SDK 罕见用法）
    systemPrompt?: SystemPrompt | string[];
  },
  dootaskContext?: DootaskContext,
): Promise<void> {
  try {
    const corpId = dootaskContext?.corp_id;
    const wecomUserId = dootaskContext?.wecom_userid;
    if (!corpId || !wecomUserId) return;

    // v3.4 Top-3 [P1]: corp_id 白名单校验 — 防 body.context.dootask 伪造跨企业越权
    const allowedCorpsRaw = process.env.DOOTASK_ALLOWED_CORPS || '';
    const allowedCorps = allowedCorpsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (allowedCorps.length > 0 && !allowedCorps.includes(corpId)) {
      console.error(
        `❌ [dootask] Rejected corp_id "${corpId}" not in DOOTASK_ALLOWED_CORPS allowlist — potential cross-corp privilege escalation attempt`,
      );
      return;
    }

    // 1. 构造 68 个 tool（closure 捕获 getToken 函数，lazy resolve）
    const tools = buildAllTools({
      getToken: () => getDootaskToken(corpId, wecomUserId),
    });

    // 2. 创建 MCP server
    const server = createSdkMcpServer({
      name: 'dootask',
      version: '1.0.0',
      tools,
    });

    // 3. 注册到 queryOptions.mcpServers
    queryOptions.mcpServers = {
      ...queryOptions.mcpServers,
      dootask: server,
    };

    // 4. 注册 68 个工具名到 allowedTools（去重 append）
    if (!queryOptions.allowedTools) {
      queryOptions.allowedTools = [...DOOTASK_TOOL_NAMES];
    } else {
      for (const n of DOOTASK_TOOL_NAMES) {
        if (!queryOptions.allowedTools.includes(n)) {
          queryOptions.allowedTools.push(n);
        }
      }
    }

    // 5. v2.1 Task 6: 运行时动态注入企微通知上下文规则（对称 MCP 注入模式）
    // 【关键】判断用 `type === 'preset'` 而非 `'append' in existing`：
    // 默认 agent systemPrompt = { type:'preset', preset:'claude_code' }（无 append 键），
    // 用 `in` 运算会返 false → 走 else 把 preset 替换为字符串 → Claude Agent SDK 的
    // preset 行为（CLAUDE.md 注入 / CWD context / git status）全部失效。
    // 参考同模式 claudeUtils.ts:631-632 (OpenCLI 追加)。
    // 每次调用时重新生成 prompt（含实时时间戳，避免 LLM 凭历史推断"今天"）
    const wecomPrompt = buildDootaskWecomPrompt();
    const existing = queryOptions.systemPrompt;
    if (typeof existing === 'string') {
      queryOptions.systemPrompt = existing + '\n\n' + wecomPrompt;
    } else if (existing && !Array.isArray(existing) && typeof existing === 'object' && existing.type === 'preset') {
      existing.append = (existing.append || '') + '\n\n' + wecomPrompt;
    } else {
      // 仅当 queryOptions.systemPrompt 完全未设（undefined / null）时兜底为字符串
      // 注：若是 string[]（SDK 罕见用法）也会走此分支 — 原数组被替换，属已知 tradeoff
      queryOptions.systemPrompt = wecomPrompt;
    }

    console.log(`✅ [dootask] MCP Server integrated for ${corpId}:${wecomUserId} (${DOOTASK_TOOL_NAMES.length} tools)`);
  } catch (error) {
    // 集成失败不挂对话（参考 weknoraIntegration.ts:47-50）
    console.error('❌ [dootask] Failed to integrate MCP server:', error);
  }
}
