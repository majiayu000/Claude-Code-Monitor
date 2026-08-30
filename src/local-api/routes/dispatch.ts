import { Hono } from 'hono';
import { taskDispatchRepository } from '../../infrastructure/database/repositories/task-dispatch.repository.js';
import { workItemEvidenceRepository } from '../../infrastructure/database/repositories/work-item-evidence.repository.js';
import { workItemRepository } from '../../infrastructure/database/repositories/work-item.repository.js';
import {
  DispatchSessionClaimConflictError,
  DispatchIdempotencyConflictError,
  taskDispatchService,
} from '../../services/task-dispatch.service.js';
import { authMiddleware } from '../../web/api/middleware/auth.js';
import { readJsonObject } from '../http.js';

const app = new Hono();
app.use('*', authMiddleware);

function serializeDispatch(dispatch: NonNullable<ReturnType<typeof taskDispatchRepository.findById>>) {
  const linkedSession = dispatch.linkedAgentSessionId
    ? workItemEvidenceRepository.findAgentSessionById(dispatch.linkedAgentSessionId)
    : null;
  return {
    ...dispatch,
    // candidateSessionIds and linkedSessionId are native Codex/Claude runtime session IDs.
    linkedSessionId: linkedSession?.runtimeSessionId,
    launchedAt: dispatch.launchedAt?.toISOString(),
    correlationDeadlineAt: dispatch.correlationDeadlineAt.toISOString(),
    createdAt: dispatch.createdAt.toISOString(),
    updatedAt: dispatch.updatedAt.toISOString(),
  };
}

app.post('/work-items/:id/dispatch', async (c) => {
  if (!workItemRepository.findById(c.req.param('id'))) {
    return c.json({ success: false, error: 'Work item not found' }, 404);
  }
  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const body = parsed.data!;
  if (typeof body.runtimeId !== 'string' || typeof body.cwd !== 'string' ||
      typeof body.prompt !== 'string' || typeof body.idempotencyKey !== 'string') {
    return c.json({ success: false, error: 'runtimeId, cwd, prompt, and idempotencyKey are required' }, 400);
  }
  const terminalApp = body.terminalApp ?? 'auto';
  if (!['Terminal', 'iTerm', 'Warp', 'auto'].includes(String(terminalApp))) {
    return c.json({ success: false, error: 'Invalid terminalApp' }, 400);
  }
  try {
    const dispatch = await taskDispatchService.dispatch(c.req.param('id'), {
      runtimeId: body.runtimeId,
      cwd: body.cwd,
      prompt: body.prompt,
      terminalApp: terminalApp as 'Terminal' | 'iTerm' | 'Warp' | 'auto',
      idempotencyKey: body.idempotencyKey,
    });
    return c.json({ success: true, data: { dispatch: serializeDispatch(dispatch) } }, 202);
  } catch (error) {
    if (error instanceof DispatchIdempotencyConflictError) {
      return c.json({ success: false, error: error.message }, 409);
    }
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Dispatch failed',
    }, 400);
  }
});

app.get('/dispatches/:id', (c) => {
  const dispatch = taskDispatchRepository.findById(c.req.param('id'));
  if (!dispatch) return c.json({ success: false, error: 'Dispatch not found' }, 404);
  return c.json({ success: true, data: { dispatch: serializeDispatch(dispatch) } });
});

app.post('/dispatches/:id/resolve-session', async (c) => {
  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const sessionId = parsed.data!.sessionId;
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return c.json({ success: false, error: 'sessionId is required' }, 400);
  }
  try {
    const dispatch = taskDispatchService.resolveSession(c.req.param('id'), sessionId.trim());
    return c.json({ success: true, data: { dispatch: serializeDispatch(dispatch) } });
  } catch (error) {
    if (error instanceof DispatchSessionClaimConflictError) {
      return c.json({ success: false, error: error.message }, 409);
    }
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to resolve dispatch',
    }, 400);
  }
});

export default app;
