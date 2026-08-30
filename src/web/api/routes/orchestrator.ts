import { Hono } from 'hono';
import {
  buildAttentionOverview,
  MAX_ATTENTION_LIMIT,
  type AttentionOverview,
  type AttentionQueueItem,
} from '../../../services/attention.prioritizer.js';
import {
  generateDeterministicSessionDigest,
  generateDeterministicSessionDigests,
  getSessionDigest,
  getSessionDigestMap,
} from '../../../services/session-digest.service.js';
import {
  generateLocalModelSessionDigest,
  getLocalSummarizerConfig,
  LOCAL_SUMMARIZER_DISABLED_ERROR,
  type LocalSummarizerConfig,
} from '../../../services/orchestrator.summarizer.js';
import {
  isSessionDigestSource,
  serializeSessionDigest,
} from '../../../domain/orchestrator/index.js';
import { logger } from '../../../lib/logger.js';
import { authMiddleware } from '../middleware/auth.js';
import { getWebSessions } from '../session-source.js';

const app = new Hono();
app.use('*', authMiddleware);

app.get('/overview', (c) => {
  const limitResult = parsePositiveNumber(c.req.query('limit'), 'limit');
  if (limitResult.error) {
    return c.json({ success: false, error: limitResult.error }, 400);
  }
  const highCostResult = parsePositiveNumber(
    c.req.query('highCostThreshold'),
    'highCostThreshold'
  );
  if (highCostResult.error) {
    return c.json({ success: false, error: highCostResult.error }, 400);
  }
  const staleHoursResult = parsePositiveNumber(c.req.query('staleHours'), 'staleHours');
  if (staleHoursResult.error) {
    return c.json({ success: false, error: staleHoursResult.error }, 400);
  }
  const lostHoursResult = parsePositiveNumber(c.req.query('lostHours'), 'lostHours');
  if (lostHoursResult.error) {
    return c.json({ success: false, error: lostHoursResult.error }, 400);
  }

  try {
    const sessions = getWebSessions();
    const overview = buildAttentionOverview(sessions, {
      includeCompleted: c.req.query('includeCompleted') === 'true',
      includeOldLost: c.req.query('includeOldLost') === 'true',
      limit: limitResult.value,
      highCostThreshold: highCostResult.value,
      staleHours: staleHoursResult.value,
      lostHours: lostHoursResult.value,
      digests: getSessionDigestMap(sessions.map((session) => session.sessionId)),
    });

    return c.json({
      success: true,
      data: serializeOverview(overview),
    });
  } catch (error) {
    logger.error('Failed to build orchestrator overview', error);
    return c.json({ success: false, error: 'Failed to build orchestrator overview' }, 500);
  }
});

app.get('/digests/:sessionId', (c) => {
  const digest = getSessionDigest(c.req.param('sessionId'));
  if (!digest) {
    return c.json({ success: false, error: 'Session digest not found' }, 404);
  }

  return c.json({
    success: true,
    data: { digest: serializeSessionDigest(digest) },
  });
});

app.post('/digests/generate', async (c) => {
  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    body = {};
  }

  const source = body.source ?? 'deterministic';
  if (!isSessionDigestSource(source)) {
    return c.json({ success: false, error: 'Invalid digest source' }, 400);
  }

  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
    ? body.sessionId.trim()
    : undefined;
  const sessions = getWebSessions();
  const matchingSessions = sessionId
    ? sessions.filter((session) => session.sessionId === sessionId)
    : sessions;

  if (sessionId && matchingSessions.length === 0) {
    return c.json({ success: false, error: 'Session not found' }, 404);
  }

  let localSummarizerConfig: LocalSummarizerConfig | null = null;
  if (source === 'local_model') {
    try {
      localSummarizerConfig = getLocalSummarizerConfig();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return c.json({ success: false, error: errorMessage }, 400);
    }

    if (!localSummarizerConfig) {
      return c.json({ success: false, error: LOCAL_SUMMARIZER_DISABLED_ERROR }, 400);
    }
  }

  try {
    const digests = source === 'deterministic'
      ? sessionId
        ? [generateDeterministicSessionDigest(matchingSessions[0])]
        : generateDeterministicSessionDigests(matchingSessions)
      : await Promise.all(
          matchingSessions.map((session) =>
            generateLocalModelSessionDigest(session, { config: localSummarizerConfig })
          )
        );

    return c.json({
      success: true,
      data: { digests: digests.map(serializeSessionDigest) },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to generate session digest', { message: errorMessage, source });
    return c.json({ success: false, error: 'Failed to generate session digest' }, 500);
  }
});

function parsePositiveNumber(
  value: string | undefined,
  name: string
): { value?: number; error?: string } {
  if (value == null || value.trim() === '') return {};
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { error: `${name} must be a positive number` };
  }
  if (name === 'limit' && parsed > MAX_ATTENTION_LIMIT) {
    return { error: `limit must be ${MAX_ATTENTION_LIMIT} or less` };
  }
  return { value: parsed };
}

function serializeOverview(overview: AttentionOverview) {
  return {
    generatedAt: overview.generatedAt.toISOString(),
    items: overview.items.map(serializeItem),
    stats: overview.stats,
  };
}

function serializeItem(item: AttentionQueueItem) {
  return {
    ...item,
    lastActiveAt: item.lastActiveAt.toISOString(),
  };
}

export default app;
