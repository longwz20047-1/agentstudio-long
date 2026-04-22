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

    console.log(`✅ [dootask] MCP Server integrated for ${corpId}:${wecomUserId} (28 tools)`);
  } catch (error) {
    // 集成失败不挂对话（参考 weknoraIntegration.ts:47-50）
    console.error('❌ [dootask] Failed to integrate MCP server:', error);
  }
}
