/**
 * HTTP server for receiving hook events
 *
 * Integrates with the compression queue for async memory processing.
 */

import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import { logger } from '../../lib/logger.js';
import { config } from '../../lib/config.js';
import { emit } from '../../lib/events.js';
import { isValidSessionId } from '../../lib/session-id.js';
import {
  isAllowedFetchMetadata,
  isLoopbackHostHeader,
  isLoopbackOrigin,
} from '../../web/api/request-security.js';
import { createSession, getSession, updateSession } from '../../services/session.service.js';
import {
  getCompressionQueue,
  startCompressionQueue,
  stopCompressionQueue,
} from '../../services/compression.queue.js';
import { generateSessionContext } from '../../services/context.injection.js';
import { generateTitle, isGeneratedSessionTitle } from '../../domain/session/index.js';
import { scopeCodexSessionId } from '../codex/parser.js';
import type {
  HookEvent,
  ToolUseHookEvent,
  UserPromptSubmitHookEvent,
  HookEventType,
} from './types.js';

let server: FastifyInstance | null = null;

/** Valid hook event types */
const VALID_EVENT_TYPES: Set<HookEventType> = new Set([
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
]);

/** Track first prompts per session for context injection */
const sessionFirstPrompts: Map<string, boolean> = new Map();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getHookEventType(event: Record<string, unknown>): HookEventType | null {
  const eventType = event.event_type ?? event.hook_event_name;
  if (typeof eventType !== 'string' || !VALID_EVENT_TYPES.has(eventType as HookEventType)) {
    return null;
  }
  return eventType as HookEventType;
}

function stringifyToolOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) {
    return undefined;
  }
  if (typeof output === 'string') {
    return output;
  }
  return JSON.stringify(output);
}

function normalizeKnownHookEvent(
  event: Record<string, unknown>,
  eventType: HookEventType,
  now: Date
): HookEvent | null {
  if (!isValidSessionId(event.session_id)) {
    return null;
  }

  const base = {
    event_type: eventType,
    session_id: event.session_id,
    cwd: typeof event.cwd === 'string' ? event.cwd : '',
    timestamp: typeof event.timestamp === 'string' ? event.timestamp : now.toISOString(),
    transcript_path: typeof event.transcript_path === 'string' ? event.transcript_path : undefined,
  };

  if (eventType === 'PreToolUse' || eventType === 'PostToolUse') {
    if (typeof event.tool_name !== 'string' || event.tool_name.length === 0) {
      return null;
    }
    if (!isRecord(event.tool_input)) {
      return null;
    }

    return {
      ...base,
      event_type: eventType,
      tool_name: event.tool_name,
      tool_input: event.tool_input,
      tool_output: stringifyToolOutput(
        event.tool_output ?? event.tool_response ?? event.tool_result
      ),
    };
  }

  if (eventType === 'Notification') {
    if (typeof event.message !== 'string') {
      return null;
    }
    return {
      ...base,
      event_type: 'Notification',
      message: event.message,
    };
  }

  if (eventType === 'SessionStart') {
    return {
      ...base,
      event_type: 'SessionStart',
      source: typeof event.source === 'string' ? event.source : undefined,
    };
  }

  if (eventType === 'Stop') {
    return {
      ...base,
      event_type: 'Stop',
      reason:
        typeof event.stop_reason === 'string'
          ? event.stop_reason
          : typeof event.reason === 'string'
            ? event.reason
            : undefined,
    };
  }

  if (typeof event.prompt !== 'string') {
    return null;
  }
  return {
    ...base,
    event_type: 'UserPromptSubmit',
    prompt: event.prompt,
  };
}

/**
 * Parse Claude Code's native hook payload only. This intentionally requires
 * `hook_event_name`; use `normalizeHookEvent()` for the compatibility parser.
 */
export function parseHookEvent(raw: unknown, now: Date = new Date()): HookEvent | null {
  if (!isRecord(raw)) {
    return null;
  }

  const eventType = raw.hook_event_name;
  if (typeof eventType !== 'string' || !VALID_EVENT_TYPES.has(eventType as HookEventType)) {
    return null;
  }

  return normalizeKnownHookEvent(raw, eventType as HookEventType, now);
}

/** Normalize Claude Code stdin payloads and legacy Keepline payloads. */
export function normalizeHookEvent(event: unknown, now: Date = new Date()): HookEvent | null {
  if (!isRecord(event)) {
    return null;
  }

  const eventType = getHookEventType(event);
  if (!eventType) {
    return null;
  }

  return normalizeKnownHookEvent(event, eventType, now);
}

function getHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function isAllowedHookServerRequest(request: FastifyRequest): boolean {
  if (!isLoopbackHostHeader(getHeader(request, 'host'))) {
    return false;
  }

  const origin = getHeader(request, 'origin');
  if (origin && !isLoopbackOrigin(origin)) {
    return false;
  }

  const syntheticRequest = new Request('http://127.0.0.1/', {
    headers: {
      'sec-fetch-site': getHeader(request, 'sec-fetch-site') ?? '',
    },
  });
  return isAllowedFetchMetadata(syntheticRequest);
}

/** Validate hook event payload */
export function isValidHookEvent(event: unknown): event is HookEvent {
  if (!isRecord(event)) {
    return false;
  }

  if (!isValidSessionId(event.session_id)) {
    return false;
  }

  return normalizeHookEvent(event) !== null;
}

/** Handle incoming hook event */
async function handleHookEvent(
  event: HookEvent,
  runtimeHint: 'claude' | 'codex' = 'claude'
): Promise<void> {
  const sessionId = runtimeHint === 'codex'
    ? scopeCodexSessionId(event.session_id)
    : event.session_id;
  logger.debug('Hook event received', { type: event.event_type, session: sessionId });

  const ensureSession = (initialPrompt: string) => {
    const existing = getSession(sessionId);
    if (existing) {
      if (initialPrompt !== 'Unknown task' && isGeneratedSessionTitle(existing.title)) {
        return updateSession(sessionId, {
          title: generateTitle(initialPrompt),
          initialPrompt,
        });
      }
      return existing;
    }
    return createSession({
      sessionId,
      client: runtimeHint,
      directory: event.cwd,
      initialPrompt,
      statusSource: 'hook',
    });
  };

  switch (event.event_type) {
    case 'PreToolUse':
    case 'PostToolUse': {
      const toolEvent = event as ToolUseHookEvent;
      ensureSession('Unknown task');

      // Emit tool event
      emit(event.event_type === 'PreToolUse' ? 'tool:pre' : 'tool:post', {
        sessionId,
        tool: toolEvent.tool_name,
        input: toolEvent.tool_input,
        output: toolEvent.tool_output,
        timestamp: new Date(toolEvent.timestamp),
      });

      // Update session with tool info
      updateSession(sessionId, {
        lastTool: toolEvent.tool_name,
        lastToolInput: JSON.stringify(toolEvent.tool_input),
        lastActiveAt: new Date(toolEvent.timestamp),
        status: 'running',
        statusSource: 'hook',
      });

      // Extract current file if applicable
      const fileKeys = ['file_path', 'path', 'filePath', 'notebook_path'];
      for (const key of fileKeys) {
        const value = toolEvent.tool_input[key];
        if (typeof value === 'string') {
          updateSession(sessionId, { currentFile: value });
          break;
        }
      }

      // Enqueue PostToolUse events for async compression (if output exists)
      if (event.event_type === 'PostToolUse' && toolEvent.tool_output) {
        const queue = getCompressionQueue();
        if (queue.isActive()) {
          queue.enqueue({
            toolName: toolEvent.tool_name,
            toolInput: toolEvent.tool_input,
            toolOutput: toolEvent.tool_output,
            sessionId,
          });
        }
      }
      break;
    }

    case 'Notification':
      // Just log notifications for now
      logger.info(`Notification from ${sessionId}: ${(event as { message: string }).message}`);
      break;

    case 'SessionStart':
      ensureSession('Unknown task');
      updateSession(sessionId, {
        status: 'running',
        statusSource: 'hook',
        lastActiveAt: new Date(event.timestamp),
      });
      break;

    case 'Stop':
      // Claude finished one response turn. This is not evidence that the task completed.
      updateSession(sessionId, {
        status: 'waiting',
        statusSource: 'hook',
        lastActiveAt: new Date(event.timestamp),
      });
      sessionFirstPrompts.delete(sessionId);
      emit('session:turn-ended', {
        sessionId,
        timestamp: new Date(event.timestamp),
        reason: (event as { reason?: string }).reason,
      });
      break;

    case 'UserPromptSubmit': {
      const promptEvent = event as UserPromptSubmitHookEvent;
      ensureSession(promptEvent.prompt);
      updateSession(sessionId, {
        status: 'running',
        statusSource: 'hook',
        lastActiveAt: new Date(event.timestamp),
      });

      // Check if this is the first prompt for this session
      const isFirstPrompt = !sessionFirstPrompts.has(sessionId);
      if (isFirstPrompt) {
        sessionFirstPrompts.set(sessionId, true);

        // Generate and log context for first prompt (async, don't block)
        generateSessionContext(event.cwd, promptEvent.prompt)
          .then((context) => {
            if (context.observations.length > 0) {
              logger.info(
                `Context injection available for ${sessionId}: ` +
                `${context.observations.length} observations, ${context.totalTokens} tokens`
              );
              // Note: Actual injection into CLAUDE.md would require file system access
              // For now, we log the context for debugging
              logger.debug('Generated context block:', context.contextBlock);
            }
          })
          .catch((error) => {
            logger.error('Failed to generate session context', error);
          });
      }

      break;
    }
  }
}

export function createHookServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', (request, reply, done) => {
    if (isAllowedHookServerRequest(request)) {
      done();
      return;
    }

    logger.warn('Rejected hook server request', {
      host: getHeader(request, 'host') ?? '<missing>',
      origin: getHeader(request, 'origin') ?? '<missing>',
      secFetchSite: getHeader(request, 'sec-fetch-site') ?? '<missing>',
      path: request.url,
    });
    reply.status(403).send({ success: false, error: 'Forbidden' });
  });

  // Health check endpoint
  app.get('/health', async () => {
    const queue = getCompressionQueue();
    return {
      status: 'ok',
      service: 'keepline-hook-receiver',
      compression: {
        active: queue.isActive(),
        stats: queue.getStats(),
      },
    };
  });

  // Hook event endpoint
  app.post<{ Body: unknown }>('/hook', async (request, reply) => {
    try {
      const event = normalizeHookEvent(request.body);

      // Validate input before processing
      if (!event) {
        const body = isRecord(request.body) ? request.body : null;
        logger.warn('Invalid hook event received', {
          hook_event_name: body?.hook_event_name,
          event_type: body?.event_type,
          session_id: body?.session_id,
        });
        reply.status(400);
        return { success: false, error: 'Invalid hook event payload' };
      }

      const runtime = new URL(request.url, 'http://127.0.0.1').searchParams.get('runtime');
      if (runtime !== null && runtime !== 'claude-code' && runtime !== 'codex') {
        reply.status(400);
        return { success: false, error: 'Invalid hook runtime' };
      }
      await handleHookEvent(event, runtime === 'codex' ? 'codex' : 'claude');
      return { success: true };
    } catch (error) {
      logger.error('Failed to handle hook event', error);
      reply.status(500);
      return { success: false, error: (error as Error).message };
    }
  });

  // Compression queue stats endpoint
  app.get('/compression/stats', async () => {
    const queue = getCompressionQueue();
    return queue.getStats();
  });

  // Context injection endpoint - retrieve relevant memories for a project
  app.get<{
    Querystring: { path?: string; prompt?: string };
  }>('/context', async (request, reply) => {
    const { path, prompt } = request.query;

    if (!path) {
      reply.status(400);
      return { success: false, error: 'Missing required "path" query parameter' };
    }

    try {
      const context = await generateSessionContext(path, prompt);
      return {
        success: true,
        data: {
          observationCount: context.observations.length,
          totalTokens: context.totalTokens,
          searchQuery: context.searchQuery,
          contextBlock: context.contextBlock,
          observations: context.observations.map((obs) => ({
            id: obs.id,
            content: obs.content,
            category: obs.category,
            files: obs.files,
            timestamp: obs.timestamp.toISOString(),
          })),
        },
      };
    } catch (error) {
      logger.error('Failed to generate context', error);
      reply.status(500);
      return { success: false, error: (error as Error).message };
    }
  });

  return app;
}

/** Start hook server */
export async function startHookServer(): Promise<void> {
  if (server) {
    logger.warn('Hook server already running');
    return;
  }

  const port = config.get().hookPort;

  server = createHookServer();

  try {
    await server.listen({ port, host: '127.0.0.1' });

    // Start compression queue
    startCompressionQueue();

    logger.info(`Hook server listening on port ${port} with compression queue enabled`);
  } catch (error) {
    logger.error('Failed to start hook server', error);
    throw error;
  }
}

/** Stop hook server */
export async function stopHookServer(): Promise<void> {
  if (!server) return;

  const currentServer = server;
  try {
    // Stop compression queue first (flush pending items)
    await stopCompressionQueue();

    await currentServer.close();
    server = null;
    logger.info('Hook server stopped');
  } catch (error) {
    logger.error('Failed to stop hook server', error);
    // Only clear server reference if close actually succeeded
    // If it failed, server might still be running
    throw error;
  }
}

/** Check if hook server is running */
export function isHookServerRunning(): boolean {
  return server !== null;
}

/** Get hook server URL */
export function getHookServerUrl(): string {
  const port = config.get().hookPort;
  return `http://127.0.0.1:${port}`;
}
