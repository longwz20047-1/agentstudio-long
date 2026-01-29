/**
 * A2A Protocol Routes
 *
 * Implements A2A (Agent-to-Agent) protocol HTTP endpoints for external agent communication.
 *
 * Endpoints:
 * - GET  /.well-known/agent-card.json - Retrieve Agent Card (discovery)
 * - POST /messages - Send synchronous message
 * - POST /tasks - Create asynchronous task
 * - GET  /tasks/:taskId - Query task status
 * - DELETE /tasks/:taskId - Cancel task
 *
 * All endpoints require API key authentication via Authorization header.
 */

import express, { Router, Response } from 'express';
import { a2aAuth, type A2ARequest } from '../middleware/a2aAuth.js';
import { a2aRateLimiter, a2aStrictRateLimiter } from '../middleware/rateLimiting.js';
import {
  A2AMessageRequestSchema,
  A2ATaskRequestSchema,
  validateSafe,
} from '../schemas/a2a.js';
import { generateAgentCard, type ProjectContext } from '../services/a2a/agentCardService.js';
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

    // Load agent configuration
    const agentConfig = agentStorage.getAgent(a2aContext.agentType);

    if (!agentConfig) {
      return res.status(404).json({
        error: `Agent '${a2aContext.agentType}' not found`,
        code: 'AGENT_NOT_FOUND',
      });
    }

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

    // Try to get from cache first
    let agentCard = agentCardCache.get(agentConfig, projectContext);

    // Safety check: verify cached card matches the requested agent
    // If there's a mismatch (e.g., due to hash collision), invalidate and regenerate
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

    const { message, sessionId, sessionMode = 'new', context, images } = validation.data;
    const stream = req.query.stream === 'true' || req.headers.accept === 'text/event-stream';

    console.info('[A2A] Message received:', {
      a2aAgentId: a2aContext.a2aAgentId,
      projectId: a2aContext.projectId,
      agentType: a2aContext.agentType,
      messageLength: message.length,
      sessionId,
      sessionMode,
      stream,
      imagesCount: images?.length || 0,
      hasImages: !!images && images.length > 0,
    });

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
    const { queryOptions, askUserSessionRef } = await buildQueryOptions(
      {
        systemPrompt: agentConfig.systemPrompt || undefined,
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
      weknoraContext ? { weknoraContext } : undefined // extendedOptions
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
              content: buildUserMessageContent(message, images)
            },
            sessionId: sessionId,
            timestamp: Date.now(),
          };
          a2aHistoryService.appendEvent(a2aContext.workingDirectory, sessionId, userHistoryEvent)
            .catch(err => console.error('[A2A] Failed to write user message to history:', err));
        }

        // 用于新会话时保存用户消息（等待 SDK 返回 session_id）
        const userMessageEventForNewSession = {
          type: 'user',
          message: {
            role: 'user',
            content: buildUserMessageContent(message, images)
          },
          sessionId: 'pending',
          timestamp: Date.now(),
        };

        try {
          const result = await executeA2AQueryStreaming(
            message,
            images, // 传递图片数组
            queryOptions,
            (sdkMessage: SDKMessage) => {
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
                a2aHistoryService.appendEvent(
                  a2aContext.workingDirectory,
                  capturedSessionId!,
                  userMessageEventForNewSession
                ).catch(err => console.error('[A2A] Failed to write user message to history:', err));
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

              // Check for completion
              if (sdkMessage.type === 'result') {
                res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
              }
            }
          );

          capturedSessionId = result.sessionId || capturedSessionId;
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
                content: buildUserMessageContent(message, images)
              },
              sessionId: sessionId,
              timestamp: Date.now(),
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
            images, // 传递图片数组
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
                      content: buildUserMessageContent(message, images)
                    },
                    sessionId: capturedSessionId!,
                    timestamp: Date.now() - 1, // slightly before to ensure ordering
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

        const userMessage = {
          type: 'user',
          message: {
            role: 'user',
            content: buildUserMessageContent(message, images)
          }
        };

        // Save user message to history first
        if (actualSessionId) {
          const userHistoryEvent = {
            ...userMessage,
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
          await claudeSession.sendMessage(userMessage, async (sdkMessage: SDKMessage) => {
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
          // Save user message to history first
          const userMessage = {
            type: 'user',
            message: {
              role: 'user',
              content: buildUserMessageContent(message, images)
            }
          };

          if (actualSessionId) {
            const userHistoryEvent = {
              ...userMessage,
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
            claudeSession.sendMessage(userMessage, async (sdkMessage: SDKMessage) => {
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

    const { message, timeout, context, pushNotificationConfig } = validation.data;

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
// Export Router
// ============================================================================

export default router;
