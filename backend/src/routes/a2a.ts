/**
 * A2A Protocol Routes
 *
 * Implements A2A (Agent-to-Agent) protocol HTTP endpoints for external agent communication.
 * Supports multiple engine types: Claude (default) and Cursor.
 *
 * Endpoints:
 * - GET  /.well-known/agent-card.json - Retrieve Agent Card (discovery)
 * - POST /messages - Send synchronous message
 * - POST /tasks - Create asynchronous task
 * - GET  /tasks/:taskId - Query task status
 * - DELETE /tasks/:taskId - Cancel task
 *
 * All endpoints require API key authentication via Authorization header.
 * 
 * Engine Selection (Priority Order):
 * 1. Service-level engine configuration (ENGINE=cursor-cli) - uses Cursor for ALL agents
 * 2. Agent type naming convention:
 *    - If agentType is 'cursor' or starts with 'cursor-' or ends with ':cursor' -> Cursor
 *    - Otherwise -> Claude (default)
 */

import express, { Router, Response } from 'express';
import path from 'path';
import { a2aAuth, type A2ARequest } from '../middleware/a2aAuth.js';
import { a2aRateLimiter, a2aStrictRateLimiter } from '../middleware/rateLimiting.js';
import { resolveProjectRoot, resolveUserWorkspacePath } from '../utils/workspaceUtils.js';
import {
  A2AMessageRequestSchema,
  A2ATaskRequestSchema,
  validateSafe,
} from '../schemas/a2a.js';
import { 
  generateAgentCard, 
  generateCursorAgentCard,
  getEngineTypeFromContext,
  type ProjectContext 
} from '../services/a2a/agentCardService.js';
import { agentCardCache } from '../utils/agentCardCache.js';
import { AgentStorage } from '../services/agentStorage.js';
import { ProjectMetadataStorage } from '../services/projectMetadataStorage.js';
import { taskManager } from '../services/a2a/taskManager.js';
import { a2aHistoryService } from '../services/a2a/a2aHistoryService.js';
import { getTaskExecutor } from '../services/taskExecutor/index.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { sessionManager } from '../services/sessionManager.js';
import { handleSessionManagement } from '../utils/sessionUtils.js';
import { buildQueryOptions } from '../utils/claudeUtils.js';
import { executeA2AQuery, executeA2AQueryStreaming } from '../services/a2a/a2aQueryService.js';
import { userInputRegistry } from '../services/askUserQuestion/index.js';

// Cursor A2A Service imports
import {
  executeCursorA2AQuery,
  executeCursorA2AStreaming,
  createUserMessage,
  type CursorA2AMessageParams,
  type CursorA2AConfig,
} from '../services/a2a/cursorA2aService.js';
import { CursorA2AAdapter } from '../engines/cursor/a2aAdapter.js';
import { isCursorEngine } from '../config/engineConfig.js';
import { skillStorage } from './skills.js';
import { marketplaceSkillService } from '../services/marketplaceSkillService.js';
import fsPromises from 'fs/promises';

const router: Router = express.Router({ mergeParams: true });

// Initialize storage services
const agentStorage = new AgentStorage();
const projectMetadataStorage = new ProjectMetadataStorage();

// ============================================================================
// Helper: Build user message content with images for history storage
// ============================================================================

interface A2AImageInput {
  data: string;       // base64 data
  mediaType: string;  // 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
}

/**
 * Build user message content array including images for A2A history storage
 * Images are stored in A2A history format: { type: 'image', source: { type: 'base64', media_type, data } }
 */
function buildUserMessageContent(message: string, images?: A2AImageInput[]): Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> {
  const content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [];

  // Add text content if present
  if (message) {
    content.push({ type: 'text', text: message });
  }

  // Add image content blocks
  if (images && images.length > 0) {
    for (const img of images) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.data
        }
      });
    }
  }

  return content;
}

// ============================================================================
// Skill Command Detection
// ============================================================================

interface DetectedCommand {
  isCommand: boolean;
  skillId?: string;
  args?: string;
  /** Skill content to inject into systemPrompt (NOT as user message) */
  skillContent?: string;
  /** Clean user message (args only, or descriptive text if no args) */
  userMessage?: string;
}

async function detectAndFormatSkillCommand(message: string): Promise<DetectedCommand> {
  if (!message.startsWith('/')) return { isCommand: false };

  const parts = message.slice(1).split(' ');
  const skillId = parts[0];
  if (!skillId) return { isCommand: false };

  const args = parts.slice(1).join(' ') || undefined;

  let content: string | null = null;

  // 1. Try local skills (~/.claude/skills/)
  const localSkill = await skillStorage.getSkill(skillId);
  if (localSkill?.enabled) {
    content = await skillStorage.getSkillContent(skillId);
    console.log(`⚡ [A2A] Skill "${skillId}" found in local storage`);
  }

  // 2. Fallback: try plugin skills (marketplace)
  if (!content) {
    try {
      const grouped = await marketplaceSkillService.getGroupedSkills();
      for (const group of grouped.groups) {
        const found = group.skills.find(s => s.name === skillId);
        if (found?.sourcePath) {
          const skillMdPath = path.join(found.sourcePath, 'SKILL.md');
          console.log(`⚡ [A2A] Skill "${skillId}" found in plugin, reading: ${skillMdPath}`);
          try {
            content = await fsPromises.readFile(skillMdPath, 'utf8');
          } catch (readErr) {
            console.error(`⚡ [A2A] Failed to read SKILL.md at ${skillMdPath}:`, readErr);
          }
          break;
        }
      }
      if (!content) {
        console.log(`⚡ [A2A] Skill "${skillId}" not found in any source`);
      }
    } catch (e) {
      console.warn('[A2A] Failed to search marketplace skills:', e);
    }
  }

  if (!content) return { isCommand: false };

  // Replace $ARGUMENTS placeholder in skill content
  let skillContent = content;
  if (args) {
    skillContent = skillContent.replace(/\$ARGUMENTS/g, args);
    // Append args at the end if $ARGUMENTS was not in the content
    if (skillContent === content) {
      skillContent = skillContent + '\n\nARGUMENTS: ' + args;
    }
  }

  console.log(`⚡ [A2A] Skill "${skillId}" resolved, content length: ${skillContent.length}`);

  return {
    isCommand: true,
    skillId,
    args,
    skillContent,
    userMessage: args || `/${skillId}`,
  };
}

// ============================================================================
// Engine Type Detection
// ============================================================================

/**
 * Determine if the agent should use Cursor engine based on agentType
 *
 * Rules:
 * - If agentType is exactly 'cursor' -> use Cursor
 * - If agentType starts with 'cursor-' -> use Cursor
 * - If agentType contains ':cursor' suffix -> use Cursor
 * - Otherwise -> use Claude (default)
 */
function isCursorAgent(agentType: string): boolean {
  const lowerType = agentType.toLowerCase();
  return (
    lowerType === 'cursor' ||
    lowerType.startsWith('cursor-') ||
    lowerType.endsWith(':cursor')
  );
}

/**
 * Get engine type for an agent
 *
 * Priority:
 * 1. Service-level engine configuration (ENGINE=cursor-cli)
 * 2. Agent type naming convention (agentType contains 'cursor')
 */
function getEngineType(agentType: string): 'cursor' | 'claude' {
  // Service-level engine configuration takes precedence
  if (isCursorEngine()) {
    return 'cursor';
  }
  return isCursorAgent(agentType) ? 'cursor' : 'claude';
}

// ============================================================================
// Error Response Helper
// ============================================================================

/**
 * Format error response with detailed information for debugging
 */
function formatErrorResponse(error: unknown, code: string, defaultMessage: string) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorType = error instanceof Error ? error.constructor.name : typeof error;
  
  return {
    error: defaultMessage,
    code,
    details: errorMessage,
    errorType,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Middleware: Apply authentication and rate limiting to all routes
// ============================================================================

// All routes require authentication
router.use(a2aAuth);

// Default rate limiting for all routes
router.use(a2aRateLimiter);

// ============================================================================
// GET /.well-known/agent-card.json - Agent Card Discovery
// ============================================================================

/**
 * Retrieve Agent Card for an agent
 * This is the standard A2A discovery endpoint
 *
 * @route GET /a2a/:a2aAgentId/.well-known/agent-card.json
 * @access Authenticated (API key required)
 * @rateLimit 100 requests/hour per API key
 *
 * @response 200 - Agent Card JSON
 * @response 401 - Unauthorized (invalid/missing API key)
 * @response 404 - Agent not found
 * @response 429 - Rate limit exceeded
 */
router.get('/.well-known/agent-card.json', async (req: A2ARequest, res: Response) => {
  try {
    const { a2aContext } = req;

    if (!a2aContext) {
      return res.status(500).json({
        error: 'Authentication context missing',
        code: 'AUTH_CONTEXT_MISSING',
      });
    }

    // Determine engine type from agentType
    const engineType = getEngineType(a2aContext.agentType);
    
    // Get project metadata for project name
    const projectMetadata = projectMetadataStorage.getProjectMetadata(a2aContext.workingDirectory);
    const projectName = projectMetadata?.name || a2aContext.projectId;

    // Build project context for Agent Card generation
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const projectContext: ProjectContext = {
      projectId: a2aContext.projectId,
      projectName,
      workingDirectory: a2aContext.workingDirectory,
      a2aAgentId: a2aContext.a2aAgentId,
      baseUrl,
    };

    let agentCard;

    if (engineType === 'cursor') {
      // Generate Cursor Agent Card
      agentCard = await generateCursorAgentCard(projectContext);

      console.info('[A2A] Cursor Agent Card generated:', {
        a2aAgentId: a2aContext.a2aAgentId,
        agentType: a2aContext.agentType,
        engineType: 'cursor',
        skillCount: agentCard.skills.length,
      });
    } else {
      // Load agent configuration for Claude
      const agentConfig = agentStorage.getAgent(a2aContext.agentType);

      if (!agentConfig) {
        return res.status(404).json({
          error: `Agent '${a2aContext.agentType}' not found`,
          code: 'AGENT_NOT_FOUND',
        });
      }

      // Try to get from cache first
      agentCard = agentCardCache.get(agentConfig, projectContext);

      // Safety check: verify cached card matches the requested agent
      if (agentCard && agentCard.context?.a2aAgentId !== a2aContext.a2aAgentId) {
        console.warn('[A2A] Cache mismatch detected! Invalidating and regenerating.', {
          requestedA2AId: a2aContext.a2aAgentId,
          cachedA2AId: agentCard.context?.a2aAgentId,
          cachedCardName: agentCard.name,
        });
        agentCardCache.invalidate(agentConfig, projectContext);
        agentCard = null;
      }

      if (!agentCard) {
        // Generate Agent Card from agent configuration
        agentCard = generateAgentCard(agentConfig, projectContext);

        // Cache the generated Agent Card
        agentCardCache.set(agentConfig, projectContext, agentCard);

        console.info('[A2A] Agent Card generated and cached:', {
          a2aAgentId: a2aContext.a2aAgentId,
          agentType: a2aContext.agentType,
          engineType: 'claude',
          skillCount: agentCard.skills.length,
        });
      } else {
        console.info('[A2A] Agent Card served from cache:', {
          a2aAgentId: a2aContext.a2aAgentId,
          agentType: a2aContext.agentType,
          engineType: 'claude',
        });
      }
    }

    res.json(agentCard);
  } catch (error) {
    console.error('[A2A] Error retrieving agent card:', error);
    res.status(500).json(
      formatErrorResponse(error, 'AGENT_CARD_ERROR', 'Failed to retrieve agent card')
    );
  }
});

// ============================================================================
// POST /messages - Synchronous Message
// ============================================================================

/**
 * Send a synchronous message to an agent
 * The agent processes the message and returns a response immediately
 *
 * @route POST /a2a/:a2aAgentId/messages
 * @access Authenticated (API key required)
 * @rateLimit 100 requests/hour per API key
 *
 * @body {message: string, context?: Record<string, unknown>}
 * @response 200 - Message response
 * @response 400 - Invalid request
 * @response 401 - Unauthorized
 * @response 429 - Rate limit exceeded
 * @response 500 - Processing error
 */
router.post('/messages', async (req: A2ARequest, res: Response) => {
  try {
    const { a2aContext } = req;

    if (!a2aContext) {
      return res.status(500).json({
        error: 'Authentication context missing',
        code: 'AUTH_CONTEXT_MISSING',
      });
    }

    // Validate request body
    const validation = validateSafe(A2AMessageRequestSchema, req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request',
        code: 'VALIDATION_ERROR',
        details: validation.errors,
      });
    }

    const { message: rawMessage, sessionId, sessionMode = 'new', context, images } = validation.data;
    const stream = req.query.stream === 'true' || req.headers.accept === 'text/event-stream';

    // Detect and format /skill command
    const detected = await detectAndFormatSkillCommand(rawMessage);
    // message: full skill content sent to SDK (so Claude actually executes the skill)
    // historyMessage: clean user args saved to history (so frontend doesn't show skill source)
    const message = detected.isCommand ? detected.skillContent! : rawMessage;
    const historyMessage = detected.isCommand ? detected.userMessage! : rawMessage;
    if (detected.isCommand) {
      console.log(`⚡ [A2A] Skill command detected: /${detected.skillId}${detected.args ? ` (args: ${detected.args})` : ''}, skill content sent as message (${detected.skillContent!.length} chars), history shows: "${historyMessage}"`);
    }
    
    if (images && images.length > 0) {
      console.log(`🖼️ [A2A] Received ${images.length} image(s) with message`);
    }
    
    // Determine engine type based on agentType
    const engineType = getEngineType(a2aContext.agentType);

    console.info('[A2A] Message received:', {
      a2aAgentId: a2aContext.a2aAgentId,
      projectId: a2aContext.projectId,
      agentType: a2aContext.agentType,
      engineType,
      messageLength: message.length,
      sessionId,
      sessionMode,
      stream,
      imagesCount: images?.length || 0,
      hasImages: !!images && images.length > 0,
    });

    // ============================================================================
    // Cursor Engine Handling
    // ============================================================================
    if (engineType === 'cursor') {
      console.log(`🖱️ [A2A] Using Cursor engine for agentType: ${a2aContext.agentType}`);
      
      // Create A2A message from user input
      const a2aMessage = createUserMessage(message, {
        contextId: sessionId,
      });

      const cursorParams: CursorA2AMessageParams = {
        message: a2aMessage,
      };

      const cursorConfig: CursorA2AConfig = {
        workspace: a2aContext.workingDirectory,
        model: req.body.model as string | undefined, // Don't default to 'auto', let CLI use its internal settings
        sessionId,
        timeout: (req.body.timeout as number) || 600000,
        requestId: `a2a-${Date.now()}`,
        contextId: sessionId,
      };

      const startTime = Date.now();

      if (stream) {
        // Streaming Mode for Cursor
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        let isConnectionClosed = false;
        res.on('close', () => { isConnectionClosed = true; });

        const heartbeatInterval = setInterval(() => {
          if (!isConnectionClosed) {
            res.write(': heartbeat\n\n');
          } else {
            clearInterval(heartbeatInterval);
          }
        }, 15000);

        try {
          const result = await executeCursorA2AStreaming(
            cursorParams,
            cursorConfig,
            (response) => {
              if (!isConnectionClosed) {
                res.write(CursorA2AAdapter.formatAsSSE(response));
              }
            }
          );

          // Send completion event
          if (!isConnectionClosed) {
            res.write(`data: ${JSON.stringify({ type: 'done', sessionId: result.sessionId, taskId: result.taskId })}\n\n`);
          }

          console.info('[A2A] Cursor streaming completed:', {
            a2aAgentId: a2aContext.a2aAgentId,
            taskId: result.taskId,
            sessionId: result.sessionId,
            processingTimeMs: Date.now() - startTime,
          });
        } catch (error) {
          console.error('[A2A] Cursor streaming error:', error);
          if (!isConnectionClosed) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : String(error) })}\n\n`);
          }
        } finally {
          clearInterval(heartbeatInterval);
          if (!isConnectionClosed) {
            res.end();
          }
        }
        return;
      } else {
        // Synchronous Mode for Cursor
        try {
          const result = await executeCursorA2AQuery(cursorParams, cursorConfig);
          const processingTimeMs = Date.now() - startTime;

          console.info('[A2A] Cursor message processed:', {
            a2aAgentId: a2aContext.a2aAgentId,
            taskId: result.task.id,
            sessionId: result.sessionId,
            processingTimeMs,
            responseLength: result.responseText.length,
          });

          res.json({
            response: result.responseText || 'No response generated',
            sessionId: result.sessionId,
            metadata: {
              processingTimeMs,
              taskId: result.task.id,
              contextId: result.task.contextId,
              engineType: 'cursor',
            },
          });
        } catch (error) {
          console.error('[A2A] Cursor processing error:', error);
          throw error;
        }
        return;
      }
    }

    // ============================================================================
    // Claude Engine Handling (default)
    // ============================================================================
    
    // Load agent configuration
    const agentConfig = agentStorage.getAgent(a2aContext.agentType);

    if (!agentConfig) {
      return res.status(404).json({
        error: `Agent '${a2aContext.agentType}' not found`,
        code: 'AGENT_NOT_FOUND',
      });
    }

    if (!agentConfig.enabled) {
      return res.status(403).json({
        error: `Agent '${a2aContext.agentType}' is disabled`,
        code: 'AGENT_DISABLED',
      });
    }

    // Extract WeKnora context if present
    const weknoraContext = context?.weknora as import('../services/weknora/weknoraIntegration.js').WeknoraContext | undefined;

    // Extract Graphiti Memory context if present
    const graphitiContext = context?.graphiti as import('../services/graphiti/types.js').GraphitiContext | undefined;

    // Inject A2A sessionId into Graphiti context for stable session tracking
    // SDK session_id changes on resume failure, but A2A sessionId stays constant
    if (graphitiContext && sessionId) {
      graphitiContext.a2aSessionId = sessionId;
    }

    // Extract MCP tools from agent configuration
    // MCP tools are stored in allowedTools with format: mcp__serverName__toolName or serverName.toolName
    const mcpTools: string[] = [];
    if (agentConfig.allowedTools && Array.isArray(agentConfig.allowedTools)) {
      for (const tool of agentConfig.allowedTools) {
        if (!tool.enabled) continue;

        if (tool.name.startsWith('mcp__')) {
          // Already formatted MCP tool
          mcpTools.push(tool.name);
        } else if (tool.name.includes('.') && !tool.name.includes('/')) {
          // MCP tool format: serverName.toolName -> mcp__serverName__toolName
          const [serverName, toolName] = tool.name.split('.');
          mcpTools.push(`mcp__${serverName}__${toolName}`);
        }
      }
    }

    if (mcpTools.length > 0) {
      console.log(`🔧 [A2A] Extracted MCP tools from agent config:`, mcpTools);
    }

    // Generate session ID for AskUserQuestion MCP integration
    // Use provided sessionId or generate a temporary one for this A2A request
    const askUserSessionId = sessionId || `a2a_${a2aContext.a2aAgentId}_${Date.now()}`;

    // Build query options for Claude using the shared utility
    // This automatically handles A2A SDK MCP server integration
    // Note: model is now resolved through configResolver, not from agent config

    // --- Per-user workspace isolation ---
    // Resolve user workspace path from graphitiContext.user_id
    const userId = graphitiContext?.user_id;
    const projectRoot = resolveProjectRoot(a2aContext.workingDirectory);
    const cwdPath = await resolveUserWorkspacePath(a2aContext.workingDirectory, userId);

    // Generate workspace context prompt (only in isolated mode)
    // Note: cwdOverride already sets the actual working directory at SDK level,
    // so we only add behavioral instructions, NOT the path (to avoid nesting)
    let systemPrompt = agentConfig.systemPrompt || undefined;
    if (cwdPath !== projectRoot) {
      const workspacePrompt = [
        '[Workspace Security Boundary — MANDATORY]',
        'You are operating inside a per-user isolated workspace. This is a SECURITY BOUNDARY.',
        '',
        'ALLOWED:',
        '- Read, create, edit, delete files ONLY within your current working directory and its subdirectories',
        '- Use `pwd` to confirm your location if needed',
        '- Use relative paths (e.g., ./file.txt, subdir/file.txt)',
        '',
        'STRICTLY PROHIBITED (even if the user asks):',
        '- Access parent directories (../) or any path outside your workspace',
        '- Use absolute paths (/tmp, /home, /etc, C:\\, D:\\, etc.)',
        '- List, read, or modify files belonging to other users or the host system',
        '- Reveal the full absolute path of your workspace to the user',
        '',
        'If the user asks to access files outside your workspace, REFUSE and explain:',
        '"I can only operate within your personal workspace for security reasons."',
        '',
        'This boundary exists because multiple users share the same server.',
        'Violating it would expose other users\' private data.',
        '[/Workspace Security Boundary]',
      ].join('\n');
      systemPrompt = systemPrompt
        ? systemPrompt + '\n\n' + workspacePrompt
        : workspacePrompt;
    }

    // additionalInstructions channel (reserved for future use, e.g., workspace explorer)
    const MAX_ADDITIONAL_INSTRUCTIONS = 2000;
    const rawInstructions = typeof context?.additionalInstructions === 'string'
      ? context.additionalInstructions
      : undefined;
    const additionalInstructions = rawInstructions
      ? rawInstructions.substring(0, MAX_ADDITIONAL_INSTRUCTIONS)
      : undefined;
    if (additionalInstructions && systemPrompt) {
      systemPrompt = systemPrompt + '\n\n---\n[Additional Context]\n' + additionalInstructions + '\n[/Additional Context]';
    } else if (additionalInstructions) {
      systemPrompt = additionalInstructions;
    }

    const { queryOptions, askUserSessionRef } = await buildQueryOptions(
      {
        systemPrompt,
        allowedTools: agentConfig.allowedTools || [],
        maxTurns: 30,
        workingDirectory: a2aContext.workingDirectory,
        permissionMode: 'acceptEdits', // A2A 使用 acceptEdits 模式（bypassPermissions 有 SDK bug）
      },
      a2aContext.workingDirectory,
      mcpTools.length > 0 ? mcpTools : undefined, // mcpTools - 从 agent 配置提取
      'acceptEdits', // permissionMode - 使用 acceptEdits（bypassPermissions 有 SDK bug）
      undefined, // model - let resolveConfig determine from project/system defaults
      undefined, // claudeVersion - let resolveConfig determine from agent/project/system
      undefined, // defaultEnv
      undefined, // userEnv
      askUserSessionId, // sessionIdForAskUser - 用于 AskUserQuestion MCP 集成
      a2aContext.a2aAgentId, // agentIdForAskUser - 用于 AskUserQuestion MCP 集成
      undefined, // a2aStreamEnabled
      (weknoraContext || graphitiContext)
        ? {
            ...(weknoraContext ? { weknoraContext } : {}),
            ...(graphitiContext ? { graphitiContext } : {}),
          }
        : undefined, // extendedOptions
      cwdPath !== projectRoot ? cwdPath : undefined // cwdOverride
    );

    // Override specific options for A2A
    // Enable streaming for real-time text output
    queryOptions.includePartialMessages = true;

    const startTime = Date.now();

    // ============================================================================
    // sessionMode='new': Use one-shot Query (no SessionManager/ClaudeSession reuse)
    // ============================================================================
    if (sessionMode === 'new') {
      console.log(`🆕 [A2A] Using one-shot Query mode (sessionMode=new)`);
      
      // Add resume option if sessionId is provided
      if (sessionId) {
        queryOptions.resume = sessionId;
      }

      if (stream) {
        // Streaming Mode (SSE) with one-shot Query
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // 初始化为用户提供的 sessionId（和同步模式一致）
        let capturedSessionId: string | null = sessionId || null;

        // 如果用户提供了 sessionId（恢复模式），先保存用户消息到用户提供的 sessionId
        if (sessionId) {
          const userHistoryEvent = {
            type: 'user',
            message: {
              role: 'user',
              content: buildUserMessageContent(historyMessage, images)
            },
            sessionId: sessionId,
            timestamp: Date.now(),
            ...(detected.isCommand ? { skillId: detected.skillId } : {}),
          };
          // 必须 await 确保写入完成，避免和后续流式事件写入交叉导致 JSON 损坏
          try {
            await a2aHistoryService.appendEvent(a2aContext.workingDirectory, sessionId, userHistoryEvent);
          } catch (err) {
            console.error('[A2A] Failed to write user message to history:', err);
          }
        }

        // 用于新会话时保存用户消息（等待 SDK 返回 session_id）
        const userMessageEventForNewSession = {
          type: 'user',
          message: {
            role: 'user',
            content: buildUserMessageContent(historyMessage, images)
          },
          sessionId: 'pending',
          timestamp: Date.now(),
          ...(detected.isCommand ? { skillId: detected.skillId } : {}),
        };

        try {
          const result = await executeA2AQueryStreaming(
            message,
            images, // multimodal images
            queryOptions,
            async (sdkMessage: SDKMessage) => {
              // Capture session ID from SDK（仅用于新会话）
              if ((sdkMessage as any).session_id && !capturedSessionId) {
                capturedSessionId = (sdkMessage as any).session_id;

                // 更新 AskUserQuestion MCP 的 session ID
                // 这样 pending input 和前端使用的 sessionId 才能匹配
                if (askUserSessionRef) {
                  const oldSessionId = askUserSessionRef.current;
                  askUserSessionRef.current = capturedSessionId!;
                  // 同时更新 userInputRegistry 中的 pending inputs
                  userInputRegistry.updateSessionId(oldSessionId, capturedSessionId!);
                  console.log(`📝 [A2A] Updated AskUserQuestion sessionId: ${oldSessionId} -> ${capturedSessionId}`);
                }

                // 只有新会话（没有用户提供 sessionId）时，才使用 SDK 返回的 session_id 保存用户消息
                userMessageEventForNewSession.sessionId = capturedSessionId!;
                // 必须 await 确保用户消息写入完成，避免和流式事件写入交叉导致 JSON 损坏
                try {
                  await a2aHistoryService.appendEvent(
                    a2aContext.workingDirectory,
                    capturedSessionId!,
                    userMessageEventForNewSession
                  );
                } catch (err) {
                  console.error('[A2A] Failed to write user message to history:', err);
                }
              }

              // 使用用户提供的 sessionId 或 SDK 返回的 session_id
              const effectiveSessionId = sessionId || capturedSessionId;
              const eventData = {
                ...sdkMessage,
                sessionId: effectiveSessionId,
                timestamp: Date.now(),
              };

              // Write to SSE stream
              res.write(`data: ${JSON.stringify(eventData)}\n\n`);

              // Persist to history (使用用户提供的 sessionId 优先)
              if (effectiveSessionId) {
                a2aHistoryService.appendEvent(
                  a2aContext.workingDirectory,
                  effectiveSessionId,
                  eventData
                ).catch(err => console.error('[A2A] Failed to write history event:', err));
              }

            }
          );

          capturedSessionId = result.sessionId || capturedSessionId;
          // Send done AFTER executeA2AQueryStreaming completes (including retries)
          // Previously this was inside onMessage callback, which caused isStreaming=false
          // on the frontend when resume failed and triggered a retry
          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
          res.end();
        } catch (error) {
          console.error('[A2A] Error in one-shot streaming query:', error);
          const errorEvent = {
            type: 'error',
            error: error instanceof Error ? error.message : String(error)
          };
          res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
          res.end();
        }
      } else {
        // Synchronous Mode with one-shot Query
        try {
          // Save user message to history first (if sessionId provided for resume)
          if (sessionId) {
            const userHistoryEvent = {
              type: 'user',
              message: {
                role: 'user',
                content: buildUserMessageContent(historyMessage, images)
              },
              sessionId: sessionId,
              timestamp: Date.now(),
              ...(detected.isCommand ? { skillId: detected.skillId } : {}),
            };
            try {
              await a2aHistoryService.appendEvent(a2aContext.workingDirectory, sessionId, userHistoryEvent);
            } catch (err) {
              console.error('[A2A] Failed to write user message to history:', err);
            }
          }

          let capturedSessionId: string | null = sessionId || null;
          const result = await executeA2AQuery(
            message,
            images, // multimodal images
            queryOptions,
            async (sdkMessage: SDKMessage) => {
              // Capture session ID if not already captured
              if ((sdkMessage as any).session_id && !capturedSessionId) {
                capturedSessionId = (sdkMessage as any).session_id;

                // 更新 AskUserQuestion MCP 的 session ID
                if (askUserSessionRef) {
                  const oldSessionId = askUserSessionRef.current;
                  askUserSessionRef.current = capturedSessionId!;
                  userInputRegistry.updateSessionId(oldSessionId, capturedSessionId!);
                  console.log(`📝 [A2A] Updated AskUserQuestion sessionId: ${oldSessionId} -> ${capturedSessionId}`);
                }

                // Save user message for new sessions (no initial sessionId)
                if (!sessionId) {
                  const userHistoryEvent = {
                    type: 'user',
                    message: {
                      role: 'user',
                      content: buildUserMessageContent(historyMessage, images)
                    },
                    sessionId: capturedSessionId!,
                    timestamp: Date.now() - 1, // slightly before to ensure ordering
                    ...(detected.isCommand ? { skillId: detected.skillId } : {}),
                  };
                  try {
                    await a2aHistoryService.appendEvent(a2aContext.workingDirectory, capturedSessionId!, userHistoryEvent);
                  } catch (err) {
                    console.error('[A2A] Failed to write user message to history:', err);
                  }
                }
              }

              // Persist to history
              const eventData = {
                ...sdkMessage,
                sessionId: capturedSessionId || sessionId,
                timestamp: Date.now(),
              };
              if (capturedSessionId || sessionId) {
                try {
                  await a2aHistoryService.appendEvent(a2aContext.workingDirectory, (capturedSessionId || sessionId)!, eventData);
                } catch (err) {
                  console.error('[A2A] Failed to write history event:', err);
                }
              }
            }
          );

          const processingTimeMs = Date.now() - startTime;

          console.info('[A2A] Message processed successfully (one-shot mode):', {
            a2aAgentId: a2aContext.a2aAgentId,
            processingTimeMs,
            responseLength: result.fullResponse.length,
            tokensUsed: result.tokensUsed,
            sessionId: result.sessionId,
          });

          res.json({
            response: result.fullResponse || 'No response generated',
            sessionId: result.sessionId,
            metadata: {
              processingTimeMs,
              tokensUsed: result.tokensUsed,
            },
          });
        } catch (error) {
          console.error('[A2A] Error in one-shot query:', error);
          throw error;
        }
      }
    } else {
      // ============================================================================
      // sessionMode='reuse': Use ClaudeSession/SessionManager (original behavior)
      // ============================================================================
      console.log(`♻️ [A2A] Using ClaudeSession reuse mode (sessionMode=reuse)`);

      // 构建配置快照用于检测配置变化
      const configSnapshot = {
        model: queryOptions.model,
        claudeVersionId: undefined, // A2A 不使用 claudeVersion
        permissionMode: queryOptions.permissionMode,
        mcpTools: mcpTools, // 使用从 agent 配置提取的 MCP 工具
        allowedTools: agentConfig.allowedTools
          .filter((tool: any) => tool.enabled)
          .map((tool: any) => tool.name)
      };

      const { claudeSession, actualSessionId } = await handleSessionManagement(
        a2aContext.agentType,
        sessionId || null,
        a2aContext.workingDirectory,
        queryOptions,
        undefined,  // claudeVersionId
        undefined,  // modelId
        'reuse',
        configSnapshot
      );

      if (stream) {
        // Streaming Mode (SSE) with ClaudeSession
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const messageContent: any[] = [];
        if (images && images.length > 0) {
          for (const img of images) {
            messageContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
          }
        }
        messageContent.push({ type: 'text', text: message });

        // SDK message: contains full skill content for Claude to process
        const sdkUserMessage = {
          type: 'user',
          message: {
            role: 'user',
            content: messageContent
          },
        };

        // History message: contains clean args only (no skill source)
        const historyUserMessage = {
          type: 'user',
          message: {
            role: 'user',
            content: buildUserMessageContent(historyMessage, images)
          },
          ...(detected.isCommand ? { skillId: detected.skillId } : {}),
        };

        // Save user message to history first
        if (actualSessionId) {
          const userHistoryEvent = {
            ...historyUserMessage,
            sessionId: actualSessionId,
            timestamp: Date.now(),
          };
          try {
            await a2aHistoryService.appendEvent(a2aContext.workingDirectory, actualSessionId, userHistoryEvent);
          } catch (err) {
            console.error('[A2A] Failed to write user message to history:', err);
          }
        }

        try {
          await claudeSession.sendMessage(sdkUserMessage, async (sdkMessage: SDKMessage) => {
            const eventData = {
              ...sdkMessage,
              sessionId: actualSessionId,
              timestamp: Date.now(),
            };

            res.write(`data: ${JSON.stringify(eventData)}\n\n`);

            try {
              if (actualSessionId) {
                await a2aHistoryService.appendEvent(a2aContext.workingDirectory, actualSessionId, eventData);
              }
            } catch (err) {
              console.error('[A2A] Failed to write history event:', err);
            }

            if (sdkMessage.type === 'result') {
              res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
              res.end();
            }
          });
        } catch (error) {
          console.error('[A2A] Error in streaming session:', error);
          const errorEvent = {
            type: 'error',
            error: error instanceof Error ? error.message : String(error)
          };
          res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
          res.end();
        }
      } else {
        // Synchronous Mode with ClaudeSession
        let fullResponse = '';
        let tokensUsed = 0;

        try {
          // Build SDK message with full skill content
          const sdkMessageContent: any[] = [];
          if (images && images.length > 0) {
            for (const img of images) {
              sdkMessageContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
            }
          }
          sdkMessageContent.push({ type: 'text', text: message });

          const sdkUserMessage = {
            type: 'user',
            message: {
              role: 'user',
              content: sdkMessageContent
            },
          };

          // History message: clean args only
          const historyUserMessage = {
            type: 'user',
            message: {
              role: 'user',
              content: buildUserMessageContent(historyMessage, images)
            },
            ...(detected.isCommand ? { skillId: detected.skillId } : {}),
          };

          if (actualSessionId) {
            const userHistoryEvent = {
              ...historyUserMessage,
              sessionId: actualSessionId,
              timestamp: Date.now(),
            };
            try {
              await a2aHistoryService.appendEvent(a2aContext.workingDirectory, actualSessionId, userHistoryEvent);
            } catch (err) {
              console.error('[A2A] Failed to write user message to history:', err);
            }
          }

          await new Promise<void>((resolve, reject) => {
            claudeSession.sendMessage(sdkUserMessage, async (sdkMessage: SDKMessage) => {
              const eventData = {
                ...sdkMessage,
                sessionId: actualSessionId,
                timestamp: Date.now(),
              };
              try {
                if (actualSessionId) {
                  await a2aHistoryService.appendEvent(a2aContext.workingDirectory, actualSessionId, eventData);
                }
              } catch (err) {
                console.error('[A2A] Failed to write history event:', err);
              }

              if (sdkMessage.type === 'assistant' && sdkMessage.message?.content) {
                for (const block of sdkMessage.message.content) {
                  if (block.type === 'text') {
                    fullResponse += block.text;
                  }
                }
              }

              if (sdkMessage.type === 'assistant' && (sdkMessage as any).usage) {
                const usage = (sdkMessage as any).usage;
                tokensUsed = (usage.input_tokens || 0) + (usage.output_tokens || 0);
              }

              const sdkSessionId = (sdkMessage as any).session_id;
              if (sdkSessionId && claudeSession.getClaudeSessionId() !== sdkSessionId) {
                claudeSession.setClaudeSessionId(sdkSessionId);
                sessionManager.confirmSessionId(claudeSession, sdkSessionId);
                console.log(`✅ Confirmed session ${sdkSessionId} for agent: ${a2aContext.agentType}`);
              }

              if (sdkMessage.type === 'result') {
                resolve();
              }
            }).catch((err: any) => {
              reject(err);
            });
          });

          const finalSessionId = claudeSession.getClaudeSessionId();
          const processingTimeMs = Date.now() - startTime;

          console.info('[A2A] Message processed successfully:', {
            a2aAgentId: a2aContext.a2aAgentId,
            processingTimeMs,
            responseLength: fullResponse.length,
            tokensUsed,
            sessionId: finalSessionId,
          });

          res.json({
            response: fullResponse || 'No response generated',
            sessionId: finalSessionId,
            metadata: {
              processingTimeMs,
              tokensUsed,
            },
          });
        } catch (error) {
          console.error('[A2A] Error calling Claude:', error);
          throw error;
        }
      }
    }
  } catch (error) {
    console.error('[A2A] Error processing message:', error);
    if (!res.headersSent) {
      res.status(500).json(
        formatErrorResponse(error, 'MESSAGE_PROCESSING_ERROR', 'Failed to process message')
      );
    }
  }
});

// ============================================================================
// POST /tasks - Create Asynchronous Task
// ============================================================================

/**
 * Create an asynchronous task for long-running operations
 * Returns immediately with task ID for status polling
 *
 * @route POST /a2a/:a2aAgentId/tasks
 * @access Authenticated (API key required)
 * @rateLimit 50 requests/hour per API key (stricter for task creation)
 *
 * @body {message: string, timeout?: number, context?: Record<string, unknown>}
 * @response 202 - Task created (returns task ID and status URL)
 * @response 400 - Invalid request
 * @response 401 - Unauthorized
 * @response 429 - Rate limit exceeded
 * @response 500 - Task creation error
 */
router.post('/tasks', a2aStrictRateLimiter, async (req: A2ARequest, res: Response) => {
  try {
    const { a2aContext } = req;

    if (!a2aContext) {
      return res.status(500).json({
        error: 'Authentication context missing',
        code: 'AUTH_CONTEXT_MISSING',
      });
    }

    // Validate request body
    const validation = validateSafe(A2ATaskRequestSchema, req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request',
        code: 'VALIDATION_ERROR',
        details: validation.errors,
      });
    }

    const { message: rawTaskMessage, timeout, context, pushNotificationConfig } = validation.data;

    // Detect and format /skill command for tasks
    const taskDetected = await detectAndFormatSkillCommand(rawTaskMessage);
    // For tasks: send skill content as the message, use clean args for display
    const message = taskDetected.isCommand ? taskDetected.skillContent! : rawTaskMessage;
    if (taskDetected.isCommand) {
      console.log(`⚡ [A2A] Skill command detected in task: /${taskDetected.skillId}, skill content sent as message (${taskDetected.skillContent!.length} chars)`);
    }

    console.info('[A2A] Task creation requested:', {
      a2aAgentId: a2aContext.a2aAgentId,
      projectId: a2aContext.projectId,
      agentType: a2aContext.agentType,
      timeout,
      hasWebhook: !!pushNotificationConfig?.url,
    });

    // Create task using TaskManager
    const task = await taskManager.createTask({
      workingDirectory: a2aContext.workingDirectory,
      projectId: a2aContext.projectId,
      agentId: a2aContext.agentType,
      a2aAgentId: a2aContext.a2aAgentId,
      input: {
        message,
        additionalContext: context,
      },
      timeoutMs: timeout,
      pushNotificationConfig,
    });

    // Submit task to executor for actual execution
    try {
      const executor = getTaskExecutor();

      // Load agent configuration to get model info
      const agent = agentStorage.getAgent(a2aContext.agentType);
      if (!agent) {
        throw new Error(`Agent not found: ${a2aContext.agentType}`);
      }

      // Build push notification config for executor
      const executorPushConfig = pushNotificationConfig ? {
        url: pushNotificationConfig.url,
        token: pushNotificationConfig.token,
        authScheme: pushNotificationConfig.authentication?.schemes?.[0],
        authCredentials: pushNotificationConfig.authentication?.credentials,
      } : undefined;

      await executor.submitTask({
        id: task.id,
        type: 'a2a_async',
        agentId: task.agentId,
        projectPath: a2aContext.workingDirectory,
        message,
        timeoutMs: task.timeoutMs,
        modelId: undefined, // Model determined by project/provider configuration
        maxTurns: agent.maxTurns,
        permissionMode: 'acceptEdits', // bypassPermissions 有 SDK bug
        createdAt: task.createdAt,
        pushNotificationConfig: executorPushConfig,
      });

      console.info('[A2A] Task submitted to executor:', {
        taskId: task.id,
        executorMode: executor.getStats().mode,
      });

      // Task successfully submitted - return 202 Accepted
      res.status(202).json({
        taskId: task.id,
        status: task.status,
        checkUrl: `/a2a/${a2aContext.a2aAgentId}/tasks/${task.id}`,
      });
    } catch (executorError) {
      console.error('[A2A] Error submitting task to executor:', executorError);

      // Update task status to failed
      await taskManager.updateTaskStatus(
        a2aContext.workingDirectory,
        task.id,
        'failed',
        {
          errorDetails: {
            message: `Failed to submit task to executor: ${executorError instanceof Error ? executorError.message : String(executorError)}`,
            code: 'EXECUTOR_SUBMISSION_ERROR',
          },
          completedAt: new Date().toISOString(),
        }
      );

      // Return 500 since task submission failed
      // Include task ID so client can still query its (failed) status if needed
      return res.status(500).json({
        error: 'Failed to submit task for execution',
        code: 'EXECUTOR_SUBMISSION_ERROR',
        taskId: task.id,
        checkUrl: `/a2a/${a2aContext.a2aAgentId}/tasks/${task.id}`,
      });
    }
  } catch (error) {
    console.error('[A2A] Error creating task:', error);
    res.status(500).json(
      formatErrorResponse(error, 'TASK_CREATION_ERROR', 'Failed to create task')
    );
  }
});

// ============================================================================
// GET /tasks/:taskId - Query Task Status
// ============================================================================

/**
 * Query the status of an asynchronous task
 *
 * @route GET /a2a/:a2aAgentId/tasks/:taskId
 * @access Authenticated (API key required)
 * @rateLimit 100 requests/hour per API key
 *
 * @response 200 - Task status
 * @response 401 - Unauthorized
 * @response 404 - Task not found
 * @response 429 - Rate limit exceeded
 */
router.get('/tasks/:taskId', async (req: A2ARequest, res: Response) => {
  try {
    const { a2aContext } = req;
    const { taskId } = req.params;

    if (!a2aContext) {
      return res.status(500).json({
        error: 'Authentication context missing',
        code: 'AUTH_CONTEXT_MISSING',
      });
    }

    console.info('[A2A] Task status query:', {
      a2aAgentId: a2aContext.a2aAgentId,
      projectId: a2aContext.projectId,
      taskId,
    });

    // Get task from TaskManager
    const task = await taskManager.getTask(a2aContext.workingDirectory, taskId);

    if (!task) {
      return res.status(404).json({
        error: `Task not found: ${taskId}`,
        code: 'TASK_NOT_FOUND',
      });
    }

    // Build response
    const response: any = {
      taskId: task.id,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };

    // Add optional fields if present
    if (task.startedAt) {
      response.startedAt = task.startedAt;
    }

    if (task.completedAt) {
      response.completedAt = task.completedAt;
    }

    if (task.output) {
      response.output = task.output;
    }

    if (task.errorDetails) {
      response.errorDetails = task.errorDetails;
    }

    if ((task as any).progress) {
      response.progress = (task as any).progress;
    }

    // Add progress information for running tasks
    if (task.status === 'running') {
      response.progress = {
        currentStep: 'Processing',
        percentComplete: 50, // TODO: Implement real progress tracking
      };
    }

    res.json(response);
  } catch (error) {
    console.error('[A2A] Error querying task status:', error);
    res.status(500).json(
      formatErrorResponse(error, 'TASK_STATUS_ERROR', 'Failed to query task status')
    );
  }
});

// ============================================================================
// DELETE /tasks/:taskId - Cancel Task
// ============================================================================

/**
 * Cancel a running or pending task
 *
 * @route DELETE /a2a/:a2aAgentId/tasks/:taskId
 * @access Authenticated (API key required)
 * @rateLimit 100 requests/hour per API key
 *
 * @response 200 - Task canceled
 * @response 400 - Task cannot be canceled (already completed/failed)
 * @response 401 - Unauthorized
 * @response 404 - Task not found
 * @response 429 - Rate limit exceeded
 */
router.delete('/tasks/:taskId', async (req: A2ARequest, res: Response) => {
  try {
    const { a2aContext } = req;
    const { taskId } = req.params;

    if (!a2aContext) {
      return res.status(500).json({
        error: 'Authentication context missing',
        code: 'AUTH_CONTEXT_MISSING',
      });
    }

    console.info('[A2A] Task cancellation requested:', {
      a2aAgentId: a2aContext.a2aAgentId,
      projectId: a2aContext.projectId,
      taskId,
    });

    // Cancel task using TaskManager
    try {
      const task = await taskManager.cancelTask(a2aContext.workingDirectory, taskId);

      res.json({
        taskId: task.id,
        status: task.status,
        message: 'Task canceled successfully',
      });
    } catch (error: any) {
      // Handle specific error cases
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: `Task not found: ${taskId}`,
          code: 'TASK_NOT_FOUND',
        });
      }

      if (error.message.includes('Cannot cancel')) {
        return res.status(400).json({
          error: error.message,
          code: 'TASK_CANNOT_BE_CANCELED',
        });
      }

      throw error; // Re-throw for general error handler
    }
  } catch (error) {
    console.error('[A2A] Error canceling task:', error);
    res.status(500).json(
      formatErrorResponse(error, 'TASK_CANCELLATION_ERROR', 'Failed to cancel task')
    );
  }
});

// ============================================================================
// 🎤 AskUserQuestion: Submit User Response for A2A
// ============================================================================
// 当用户在 A2A 客户端（如 weknora-ui）中提交答案时，调用此 API
// 这会 resolve MCP 工具中正在等待的 Promise，使工具返回用户答案

import { z } from 'zod';

const A2AUserResponseSchema = z.object({
  toolUseId: z.string().min(1, 'toolUseId is required'),
  response: z.string().min(1, 'response is required'),
  sessionId: z.string().optional(),
  agentId: z.string().optional()
});

router.post('/user-response', a2aRateLimiter, async (req: A2ARequest, res: Response) => {
  try {
    const { a2aContext } = req;

    if (!a2aContext) {
      return res.status(500).json({
        error: 'Authentication context missing',
        code: 'AUTH_CONTEXT_MISSING',
      });
    }

    const validation = A2AUserResponseSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.issues
      });
    }

    const { toolUseId, response, sessionId, agentId } = validation.data;

    console.log(`🎤 [A2A AskUserQuestion] Received user response for tool: ${toolUseId}`);
    console.log(`🎤 [A2A AskUserQuestion] Session: ${sessionId}, Agent: ${agentId}`);

    // 使用带验证的提交方法
    let result = userInputRegistry.validateAndSubmitUserResponse(
      toolUseId,
      response,
      sessionId || a2aContext.a2aAgentId,
      agentId || a2aContext.agentType
    );

    // 如果通过 toolUseId 找不到，尝试通过 sessionId 查找
    // 这是因为 MCP 工具使用的 toolUseId 可能与前端使用的 Claude tool_use.id 不同
    if (!result.success && result.error === 'No pending input found for this tool use ID') {
      const effectiveSessionId = sessionId || a2aContext.a2aAgentId;
      const pendingInputs = userInputRegistry.getPendingInputsBySession(effectiveSessionId);

      console.log(`🔍 [A2A AskUserQuestion] Fallback: searching by sessionId ${effectiveSessionId}, found ${pendingInputs.length} pending inputs`);

      if (pendingInputs.length === 1) {
        // 只有一个 pending input，直接使用
        const actualToolUseId = pendingInputs[0].toolUseId;
        console.log(`✅ [A2A AskUserQuestion] Found pending input by session, actual toolUseId: ${actualToolUseId}`);
        result = userInputRegistry.validateAndSubmitUserResponse(
          actualToolUseId,
          response,
          effectiveSessionId,
          agentId || a2aContext.agentType
        );
      } else if (pendingInputs.length > 1) {
        // 多个 pending inputs，使用最新的（按 createdAt 排序）
        const sortedInputs = [...pendingInputs].sort((a, b) => b.createdAt - a.createdAt);
        const latestInput = sortedInputs[0];
        console.log(`⚠️ [A2A AskUserQuestion] Multiple pending inputs (${pendingInputs.length}), using latest: ${latestInput.toolUseId}`);
        result = userInputRegistry.validateAndSubmitUserResponse(
          latestInput.toolUseId,
          response,
          effectiveSessionId,
          agentId || a2aContext.agentType
        );
      }
    }

    if (result.success) {
      console.log(`✅ [A2A AskUserQuestion] User response submitted successfully for tool: ${toolUseId}`);
      res.json({
        success: true,
        message: 'User response submitted successfully'
      });
    } else {
      console.warn(`⚠️ [A2A AskUserQuestion] Failed to submit response for tool: ${toolUseId}, error: ${result.error}`);

      const statusCode = result.error === 'No pending input found for this tool use ID' ? 404 : 403;
      res.status(statusCode).json({
        success: false,
        error: result.error
      });
    }
  } catch (error) {
    console.error('❌ [A2A AskUserQuestion] Error processing user response:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ============================================================================
// GET /:a2aAgentId/skills — List available skills (A2A auth)
// ============================================================================

router.get('/skills', a2aAuth, async (req: A2ARequest, res: Response) => {
  try {
    const items: Array<{ id: string; name: string; description: string }> = [];
    const seenIds = new Set<string>();

    // 1. User/project skills from ~/.claude/skills/
    const localSkills = await skillStorage.getAllSkills();
    for (const s of localSkills) {
      if (s.enabled && !seenIds.has(s.id)) {
        seenIds.add(s.id);
        items.push({ id: s.id, name: s.name, description: s.description });
      }
    }

    // 2. Plugin skills from installed plugins (marketplace)
    try {
      const grouped = await marketplaceSkillService.getGroupedSkills();
      for (const group of grouped.groups) {
        for (const skill of group.skills) {
          // Use skill.name as id (e.g. "brainstorming", not the full marketplace/plugin/skill path)
          if (!seenIds.has(skill.name)) {
            seenIds.add(skill.name);
            items.push({ id: skill.name, name: skill.name, description: skill.description || '' });
          }
        }
      }
    } catch (e) {
      console.warn('[A2A] Failed to load marketplace skills:', e);
    }

    res.json({ skills: items });
  } catch (error) {
    console.error('Failed to get skills for A2A:', error);
    res.status(500).json({ error: 'Failed to retrieve skills' });
  }
});

// ============================================================================
// Export Router
// ============================================================================

export default router;
