import { Hono } from 'hono';
import { encodeAgentSessionId } from '../../domain/work-item/index.js';
import { sessionRepository } from '../../infrastructure/database/repositories/session.repository.js';
import { workItemEvidenceRepository } from '../../infrastructure/database/repositories/work-item-evidence.repository.js';
import { getRuntimeScanStatus, runtimeIdForClient } from '../../services/runtime-status.js';
import { authMiddleware } from '../../web/api/middleware/auth.js';
import { serializeBasicSession } from '../../web/api/session-response.js';
import { isValidSessionId } from '../../lib/session-id.js';
import { emit } from '../../lib/events.js';

const app = new Hono();
app.use('*', authMiddleware);

function getDatabaseSessionStats(
  sessions: Array<{ status: string; processRunning: boolean }>
) {
  const stats = {
    total: sessions.length,
    running: 0,
    waiting: 0,
    idle: 0,
    lost: 0,
    completed: 0,
    withProcess: 0,
  };
  for (const session of sessions) {
    if (session.status in stats && session.status !== 'total' && session.status !== 'withProcess') {
      stats[session.status as 'running' | 'waiting' | 'idle' | 'lost' | 'completed']++;
    }
    if (session.processRunning) stats.withProcess++;
  }
  return stats;
}

app.get('/', (c) => {
  const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 100);
  const offset = Math.max(Number.parseInt(c.req.query('offset') ?? '0', 10) || 0, 0);
  // Service-mode reads must stay DB-only; background scans own process detection.
  const allSessions = sessionRepository.findOperationalLightweight().map((session) => ({
    ...session,
    processRunning: session.status !== 'lost' && session.status !== 'completed' && !!session.pid,
  }));
  const sessions = allSessions.slice(offset, offset + limit).map((session) => {
    const runtimeId = runtimeIdForClient(session.client);
    const agentSessionId = encodeAgentSessionId(runtimeId, session.sessionId);
    const agentSession = workItemEvidenceRepository.findAgentSessionById(agentSessionId);
    const completion = agentSession
      ? workItemEvidenceRepository.findLatestExplicitCompletionForAgentSession(agentSessionId)
      : null;
    return {
      ...serializeBasicSession(session),
      evidenceSummary: agentSession?.evidenceSummary,
      completionEvidenceId: completion?.id,
      completionEvidenceWorkItemId: completion?.workItemId,
      completionEvidenceSource: typeof completion?.metadata?.source === 'string'
        ? completion.metadata.source
        : undefined,
    };
  });
  return c.json({
    success: true,
    data: {
      sessions,
      stats: getDatabaseSessionStats(allSessions),
      runtimeScan: getRuntimeScanStatus(),
      pagination: {
        total: allSessions.length,
        limit,
        offset,
        hasMore: offset + limit < allSessions.length,
      },
    },
  });
});

app.post('/:id/complete', (c) => {
  const sessionId = c.req.param('id');
  if (!isValidSessionId(sessionId)) {
    return c.json({ success: false, error: 'Invalid session ID format' }, 400);
  }
  const existing = sessionRepository.findBySessionId(sessionId);
  if (!existing) return c.json({ success: false, error: 'Session not found' }, 404);
  const session = sessionRepository.upsert({
    sessionId,
    status: 'completed',
    completedAt: new Date(),
    pid: undefined,
  });
  emit('session:completed', { session });
  return c.json({
    success: true,
    data: { session: serializeBasicSession({ ...session, processRunning: false }) },
  });
});

export default app;
