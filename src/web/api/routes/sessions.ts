/**
 * Session Routes
 *
 * Handles all /api/sessions/* endpoints
 */

import { Hono } from 'hono';
import { syncSessions, getAllSessions } from '../../../services/session.service.js';
import { getSessionStats } from '../../../services/session.aggregator.js';
import { isProcessRunning } from '../../../adapters/process/scanner.js';
import {
  getSessionById as getClaudeSessionById,
  getAllSessions as getAllClaudeParsedSessions,
} from '../../../adapters/claude/scanner.js';
import { getCodexSessionById } from '../../../adapters/codex/scanner.js';
import { getRecoveryInfo } from '../../../services/recovery.service.js';
import { logger } from '../../../lib/logger.js';
import { authMiddleware } from '../middleware/auth.js';
import { isValidSessionId } from '../middleware/validation.js';
import { broadcast } from '../websocket.js';
import { serializeBasicSessions } from '../session-response.js';
import { matchesProjectFilter } from '../../../services/project.aggregator.js';
import {
  clientForRuntimeId,
  getRuntimeScanStatus,
  parseRuntimeFilter,
  runtimeIdForClient,
} from '../../../services/runtime-status.js';
import {
  getWebSessions,
  getWebSessionsBasic,
  getWebSessionSource,
} from '../session-source.js';

const app = new Hono();
app.use('*', authMiddleware);

// Track last sync time for smart sync
let lastSyncTime = 0;
const SYNC_INTERVAL_MS = 30000; // Only auto-sync every 30 seconds
let isSyncingInBackground = false;

async function getParsedSessionById(sessionId: string) {
  if (sessionId.startsWith('codex_')) {
    return getCodexSessionById(sessionId);
  }

  return getClaudeSessionById(sessionId);
}

type SearchableSession = {
  sessionId?: string;
  client?: string;
  runtimeId?: string;
  directory?: string;
  status?: string;
  title?: string;
  initialPrompt?: string;
  lastTool?: string;
  currentFile?: string;
};

const VALID_STATUSES = new Set(['running', 'waiting', 'idle', 'lost', 'completed']);
const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 100;

function parseStatusFilters(url: string): { filters: Set<string>; invalid: string[] } {
  const params = new URL(url).searchParams;
  const filters = new Set<string>();
  const invalid = new Set<string>();

  for (const value of params.getAll('status').flatMap((entry) => entry.split(','))) {
    const status = value.trim();
    if (!status) continue;
    if (VALID_STATUSES.has(status)) {
      filters.add(status);
    } else {
      invalid.add(status);
    }
  }

  return { filters, invalid: [...invalid] };
}

function parseIntegerQueryParam(
  value: string | undefined,
  defaultValue: number
): number | null {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePaginationParams(limitParam: string | undefined, offsetParam: string | undefined):
  | { valid: true; limit: number; offset: number }
  | { valid: false; error: string } {
  const rawLimit = parseIntegerQueryParam(limitParam, DEFAULT_SESSION_LIMIT);
  if (rawLimit === null || rawLimit < 1) {
    return { valid: false, error: 'Invalid limit. Must be an integer between 1 and 100.' };
  }

  const offset = parseIntegerQueryParam(offsetParam, 0);
  if (offset === null) {
    return { valid: false, error: 'Invalid offset. Must be a non-negative integer.' };
  }

  return {
    valid: true,
    limit: Math.min(rawLimit, MAX_SESSION_LIMIT),
    offset,
  };
}

function matchesSessionQuery(session: SearchableSession, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  const searchableValues = [
    session.title,
    session.directory,
    session.initialPrompt,
    session.sessionId,
    session.client,
    session.runtimeId,
    session.status,
    session.lastTool,
    session.currentFile,
  ];

  return searchableValues.some((value) => value?.toLowerCase().includes(normalizedQuery));
}

// Background sync function (non-blocking)
async function backgroundSync() {
  if (isSyncingInBackground) return;
  isSyncingInBackground = true;
  try {
    await syncSessions();
    lastSyncTime = Date.now();
    // Broadcast update to WebSocket clients after sync
    broadcast('sync:complete', { timestamp: new Date().toISOString() });
  } catch (error) {
    // Better error logging
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error('Background sync failed', { message: errorMessage, stack: errorStack });
  } finally {
    isSyncingInBackground = false;
  }
}

// GET /api/sessions - List all sessions with pagination
app.get('/', async (c) => {
  try {
    // Parse pagination parameters
    const pagination = parsePaginationParams(c.req.query('limit'), c.req.query('offset'));
    if (!pagination.valid) {
      return c.json({
        success: false,
        error: pagination.error,
      }, 400);
    }
    const { limit, offset } = pagination;
    const statusParseResult = parseStatusFilters(c.req.url);
    if (statusParseResult.invalid.length > 0) {
      return c.json({
        success: false,
        error: `Invalid status filter: ${statusParseResult.invalid.join(', ')}`,
      }, 400);
    }
    const statusFilters = statusParseResult.filters;
    const sort = c.req.query('sort') || 'lastActiveAt';
    const order = c.req.query('order') === 'asc' ? 'asc' : 'desc';
    const fields = c.req.query('fields') || 'full'; // 'basic' or 'full'
    const skipSync = c.req.query('skipSync') === 'true'; // Skip sync for pagination requests
    const client = c.req.query('client');
    const runtimeParseResult = parseRuntimeFilter(c.req.query('runtime'));
    if (runtimeParseResult.invalid) {
      return c.json({
        success: false,
        error: `Invalid runtime filter: ${runtimeParseResult.invalid}`,
      }, 400);
    }
    const projectRoot = c.req.query('projectRoot');
    const projectId = c.req.query('projectId');
    const query = c.req.query('q') || c.req.query('query') || '';

    // Smart sync: trigger background sync if needed (non-blocking)
    const now = Date.now();
    if (getWebSessionSource() === 'standalone' &&
        !skipSync && (now - lastSyncTime > SYNC_INTERVAL_MS)) {
      // Don't await - let it run in background
      backgroundSync();
    }

    // Return data immediately from database (fast)
    let sessions = query.trim()
      ? getWebSessions()
      : fields === 'basic'
      ? getWebSessionsBasic()
      : getWebSessions();
    if (projectRoot || projectId) {
      sessions = sessions.filter(s => matchesProjectFilter(s, { projectRoot, projectId }));
    }

    // Filter by status if provided
    if (statusFilters.size > 0) {
      sessions = sessions.filter(s => statusFilters.has(s.status));
    }

    if (client === 'claude' || client === 'codex') {
      sessions = sessions.filter(s => s.client === client);
    }

    if (runtimeParseResult.runtimeId) {
      const runtimeClient = clientForRuntimeId(runtimeParseResult.runtimeId);
      sessions = sessions.filter(s => s.client === runtimeClient);
    }

    if (query.trim()) {
      sessions = sessions.filter(s => matchesSessionQuery({
        ...s,
        runtimeId: runtimeIdForClient(s.client),
      }, query));
    }

    const stats = getSessionStats(sessions);

    // Sort sessions
    sessions.sort((a, b) => {
      let comparison = 0;
      if (sort === 'lastActiveAt') {
        comparison = a.lastActiveAt.getTime() - b.lastActiveAt.getTime();
      } else if (sort === 'directory') {
        comparison = a.directory.localeCompare(b.directory);
      } else if (sort === 'status') {
        comparison = a.status.localeCompare(b.status);
      } else if (sort === 'client') {
        comparison = a.client.localeCompare(b.client);
      }
      return order === 'desc' ? -comparison : comparison;
    });

    // Get total count before pagination
    const total = sessions.length;

    // Apply pagination
    const paginatedSessions = sessions.slice(offset, offset + limit);

    // For 'basic' mode, skip expensive usageStats calculation
    if (fields === 'basic') {
      return c.json({
        success: true,
        data: {
          sessions: serializeBasicSessions(paginatedSessions),
          stats,
          runtimeScan: getRuntimeScanStatus(),
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + limit < total,
          },
        },
      });
    }

    // Full mode: include all fields already persisted during sync.
    return c.json({
      success: true,
      data: {
        sessions: paginatedSessions.map(s => ({
          ...s,
          runtimeId: runtimeIdForClient(s.client),
          lastActiveAt: s.lastActiveAt.toISOString(),
          startedAt: s.startedAt?.toISOString(),
          completedAt: s.completedAt?.toISOString(),
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          usageStats: 'usageStats' in s ? s.usageStats : undefined,
        })),
        stats,
        runtimeScan: getRuntimeScanStatus(),
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to get sessions', error);
    return c.json({ success: false, error: 'Failed to get sessions' }, 500);
  }
});

// GET /api/sessions/:id - Get a single session
app.get('/:id', async (c) => {
  const sessionId = c.req.param('id');
  const sessions = getAllSessions();
  const session = sessions.find(s => s.sessionId === sessionId);

  if (!session) {
    return c.json({ success: false, error: 'Session not found' }, 404);
  }

  const recoveryInfo = getRecoveryInfo(sessionId);

  return c.json({
    success: true,
    data: {
      session: {
        ...session,
        runtimeId: runtimeIdForClient(session.client),
        lastActiveAt: session.lastActiveAt.toISOString(),
        startedAt: session.startedAt?.toISOString(),
        completedAt: session.completedAt?.toISOString(),
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      },
      recovery: recoveryInfo,
    },
  });
});

// GET /api/sessions/:id/subagents - Get sub-agents for a session
app.get('/:id/subagents', async (c) => {
  const sessionId = c.req.param('id');

  // Validate session ID format
  if (!isValidSessionId(sessionId)) {
    return c.json({ success: false, error: 'Invalid session ID format' }, 400);
  }

  try {
    // Get all sessions including sub-agents
    const allSessions = await getAllClaudeParsedSessions({ includeSubAgents: true });

    // Find sub-agents that belong to this parent session
    const subAgents = allSessions
      .filter(s => s.parentSessionId === sessionId)
      .map(s => ({
        sessionId: s.sessionId,
        agentId: s.agentId,
        directory: s.directory,
        firstMessage: s.firstMessage,
        lastMessage: s.lastMessage,
        messageCount: s.messageCount,
        toolCount: s.toolCount,
        lastTool: s.lastTool,
        startedAt: s.startedAt?.toISOString(),
        lastActiveAt: s.lastActiveAt.toISOString(),
        usageStats: s.usageStats,
      }));

    return c.json({
      success: true,
      data: {
        parentSessionId: sessionId,
        subAgents,
        count: subAgents.length,
      },
    });
  } catch (error) {
    logger.error('Failed to get sub-agents', error);
    return c.json({ success: false, error: 'Failed to get sub-agents' }, 500);
  }
});

// GET /api/sessions/:id/process - Get process status for a session
app.get('/:id/process', async (c) => {
  const sessionId = c.req.param('id');

  const sessions = getAllSessions();
  const session = sessions.find(s => s.sessionId === sessionId);

  if (!session) {
    return c.json({ success: false, error: 'Session not found' }, 404);
  }

  const processRunning = session.pid ? isProcessRunning(session.pid) : false;

  return c.json({
    success: true,
      data: {
        client: session.client,
        pid: session.pid,
        running: processRunning,
        status: session.status,
    }
  });
});

// GET /api/sessions/:id/tools - Get tool calls for a session
app.get('/:id/tools', async (c) => {
  const sessionId = c.req.param('id');

  try {
    const parsedSession = await getParsedSessionById(sessionId);

    if (!parsedSession) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        toolCalls: parsedSession.toolCalls || [],
        toolCount: parsedSession.toolCount,
      },
    });
  } catch (error) {
    logger.error('Failed to get tool calls', error);
    return c.json({ success: false, error: 'Failed to get tool calls' }, 500);
  }
});

// GET /api/sessions/:id/usage - Get usage stats for a session
app.get('/:id/usage', async (c) => {
  const sessionId = c.req.param('id');

  try {
    const parsedSession = await getParsedSessionById(sessionId);

    if (!parsedSession) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        usageStats: parsedSession.usageStats || {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          apiCalls: 0,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to get usage stats', error);
    return c.json({ success: false, error: 'Failed to get usage stats' }, 500);
  }
});

// GET /api/sessions/:id/details - Get session details (lazy loaded fields)
app.get('/:id/details', async (c) => {
  const sessionId = c.req.param('id');

  // Validate session ID format
  if (!isValidSessionId(sessionId)) {
    return c.json({ success: false, error: 'Invalid session ID format' }, 400);
  }

  try {
    // Get database session for basic fields
    const sessions = getAllSessions();
    const dbSession = sessions.find(s => s.sessionId === sessionId);

    if (!dbSession) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }

    // Get parsed session for detailed fields
    const parsedSession = await getParsedSessionById(sessionId);

    return c.json({
      success: true,
      data: {
        initialPrompt: dbSession.initialPrompt || '',
        lastMessage: dbSession.lastMessage || '',
        lastTool: dbSession.lastTool || '',
        lastToolInput: dbSession.lastToolInput || '',
        currentFile: dbSession.currentFile || '',
        usageStats: parsedSession?.usageStats ?? null,
      },
    });
  } catch (error) {
    logger.error('Failed to get session details', error);
    return c.json({ success: false, error: 'Failed to get session details' }, 500);
  }
});

// GET /api/sessions/:id/full - Get full session data (combines details, tools, subagents)
app.get('/:id/full', async (c) => {
  const sessionId = c.req.param('id');

  // Validate session ID format
  if (!isValidSessionId(sessionId)) {
    return c.json({ success: false, error: 'Invalid session ID format' }, 400);
  }

  try {
    // Get database session for basic fields
    const sessions = getAllSessions();
    const dbSession = sessions.find(s => s.sessionId === sessionId);

    if (!dbSession) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }

    // Get parsed session for detailed fields and tool calls
    const parsedSession = await getParsedSessionById(sessionId);

    // Get sub-agents
    const subAgents = dbSession.client === 'claude'
      ? (await getAllClaudeParsedSessions({ includeSubAgents: true }))
          .filter(s => s.parentSessionId === sessionId)
          .map(s => ({
            sessionId: s.sessionId,
            agentId: s.agentId,
            directory: s.directory,
            firstMessage: s.firstMessage,
            lastMessage: s.lastMessage,
            messageCount: s.messageCount,
            toolCount: s.toolCount,
            lastTool: s.lastTool,
            startedAt: s.startedAt?.toISOString(),
            lastActiveAt: s.lastActiveAt.toISOString(),
            usageStats: s.usageStats,
          }))
      : [];

    return c.json({
      success: true,
      data: {
        // Details
        details: {
          initialPrompt: dbSession.initialPrompt || '',
          lastMessage: dbSession.lastMessage || '',
          lastTool: dbSession.lastTool || '',
          lastToolInput: dbSession.lastToolInput || '',
          currentFile: dbSession.currentFile || '',
          usageStats: parsedSession?.usageStats ?? null,
        },
        // Tool calls
        tools: {
          toolCalls: parsedSession?.toolCalls || [],
          toolCount: parsedSession?.toolCount || 0,
        },
        // Sub-agents
        subAgents: {
          subAgents,
          count: subAgents.length,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to get full session data', error);
    return c.json({ success: false, error: 'Failed to get full session data' }, 500);
  }
});

// POST /api/sync - Manual session sync
app.post('/sync', async (c) => {
  try {
    if (getWebSessionSource() === 'service') {
      return c.json({
        success: false,
        error: 'Session refresh is managed by Keepline Service Mode.',
      }, 409);
    }
    // Parse request body for sync options
    let body: { fullSync?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is fine
    }

    // Full sync scans all files, regular sync only scans last 7 days
    const result = await syncSessions({ fullSync: body.fullSync });
    lastSyncTime = Date.now(); // Reset sync timer after manual sync

    return c.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to sync sessions', error);
    return c.json({ success: false, error: 'Sync failed' }, 500);
  }
});

export default app;
