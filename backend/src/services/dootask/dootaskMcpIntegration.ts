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
const DOOTASK_WECOM_PROMPT = `

[企微通知上下文规则]
当用户消息包含明确任务编号（#42 或 任务 42 等格式）时：直接调用对应 MCP 工具操作，不要反问。

当用户发送"完成/拒绝/延期/添加附件"等操作意图但未指定任务编号时：
1. 不要做任何猜测，不要使用 Redis/缓存/历史等任何旁路状态
2. 调用 list_tasks 工具，参数：status='uncompleted', pagesize=5
3. 用列表反问用户："你最近未完成的任务有：[列表]，你想操作哪个？"
4. 用户明确选择后再调用对应工具

当用户只发送一个文件而无文字说明时（M3 生效）：
1. 同样不猜测，先调 list_tasks 查询最近任务
2. 反问"这个文件要附加到哪个任务？"
`;

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
 * 把 DooTask 28 工具 in-process 集成到 queryOptions。
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

    // 1. 构造 28 个 tool（closure 捕获 getToken 函数，lazy resolve）
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

    // 4. 注册 28 个工具名到 allowedTools（去重 append）
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
    const existing = queryOptions.systemPrompt;
    if (typeof existing === 'string') {
      queryOptions.systemPrompt = existing + '\n\n' + DOOTASK_WECOM_PROMPT;
    } else if (existing && !Array.isArray(existing) && typeof existing === 'object' && existing.type === 'preset') {
      existing.append = (existing.append || '') + '\n\n' + DOOTASK_WECOM_PROMPT;
    } else {
      // 仅当 queryOptions.systemPrompt 完全未设（undefined / null）时兜底为字符串
      // 注：若是 string[]（SDK 罕见用法）也会走此分支 — 原数组被替换，属已知 tradeoff
      queryOptions.systemPrompt = DOOTASK_WECOM_PROMPT;
    }

    console.log(`✅ [dootask] MCP Server integrated for ${corpId}:${wecomUserId} (28 tools)`);
  } catch (error) {
    // 集成失败不挂对话（参考 weknoraIntegration.ts:47-50）
    console.error('❌ [dootask] Failed to integrate MCP server:', error);
  }
}
