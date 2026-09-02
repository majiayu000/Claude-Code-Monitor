/**
 * Recovery Routes
 *
 * Handles session recovery, completion, and stopping
 */

import { Hono } from 'hono';
import { getAllSessions, completeSession } from '../../../services/session.service.js';
import { buildRecoveryShellCommand, recoverSession, getRecoveryInfo } from '../../../services/recovery.service.js';
import { stopProcess, isProcessRunning } from '../../../adapters/process/scanner.js';
import { logger } from '../../../lib/logger.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  isValidSessionId,
  validateRecoverRequest,
  validateStopRequest,
} from '../middleware/validation.js';

const app = new Hono();
app.use('*', authMiddleware);

// POST /api/sessions/:id/recover - Recover a lost session
app.post('/:id/recover', async (c) => {
  const sessionId = c.req.param('id');

  // Validate session ID format
  if (!isValidSessionId(sessionId)) {
    return c.json({ success: false, error: 'Invalid session ID format' }, 400);
  }

  // Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const validation = validateRecoverRequest(body);
  if (!validation.valid) {
    return c.json({ success: false, error: validation.error }, 400);
  }

  const { method, openTerminal = true, skipPermissions = false, terminalApp = 'auto' } = validation.data;

  const sessions = getAllSessions();
  const session = sessions.find(s => s.sessionId === sessionId);

  if (!session) {
    return c.json({ success: false, error: 'Session not found' }, 404);
  }

  const recoveryInfo = getRecoveryInfo(sessionId);

  if (!recoveryInfo.canRecover) {
    return c.json({ success: false, error: recoveryInfo.reason }, 400);
  }

  const recoveryMethod = method ?? recoveryInfo.recommendedMethod;
  if (!recoveryMethod) {
    return c.json({ success: false, error: 'No recovery method available' }, 400);
  }

  try {
    const result = await recoverSession({
      method: recoveryMethod,
      sessionId,
      directory: session.directory,
      openTerminal: openTerminal ?? true,
      skipPermissions: skipPermissions ?? false,
      terminalApp: terminalApp ?? 'auto',
    });

    return c.json({
      success: result.success,
      error: result.error,
      data: {
        method: result.method,
        command: result.success
          ? undefined
          : buildRecoveryShellCommand(session, recoveryMethod, skipPermissions),
      },
    });
  } catch (error) {
    logger.error('Failed to recover session', error);
    return c.json({ success: false, error: 'Recovery failed' }, 500);
  }
});

// POST /api/sessions/:id/complete - Mark a session as completed
app.post('/:id/complete', async (c) => {
  const sessionId = c.req.param('id');

  try {
    completeSession(sessionId);
    return c.json({ success: true });
  } catch (error) {
    logger.error('Failed to complete session', error);
    return c.json({ success: false, error: 'Failed to complete session' }, 500);
  }
});

// POST /api/sessions/:id/stop - Stop a session process (SIGTERM or SIGKILL)
app.post('/:id/stop', async (c) => {
  const sessionId = c.req.param('id');

  // Validate session ID format
  if (!isValidSessionId(sessionId)) {
    return c.json({ success: false, error: 'Invalid session ID format' }, 400);
  }

  // Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const validation = validateStopRequest(body);
  if (!validation.valid) {
    return c.json({ success: false, error: validation.error }, 400);
  }

  const { force = false } = validation.data;

  const sessions = getAllSessions();
  const session = sessions.find(s => s.sessionId === sessionId);

  if (!session) {
    return c.json({ success: false, error: 'Session not found' }, 404);
  }

  // For lost sessions, just mark as completed (no process to kill)
  if (session.status === 'lost' || !session.pid) {
    completeSession(sessionId);
    return c.json({
      success: true,
      message: 'Session cleared (no process was running)'
    });
  }

  // Check if process is still running
  if (!isProcessRunning(session.pid)) {
    completeSession(sessionId);
    return c.json({
      success: true,
      message: 'Process already terminated, session cleared'
    });
  }

  // Stop the process
  const result = stopProcess(session.pid, force);

  if (result.success) {
    // Mark session as completed after successful stop
    // Note: We do this optimistically - the process should terminate
    setTimeout(() => {
      if (!isProcessRunning(session.pid!)) {
        completeSession(sessionId);
      }
    }, 1000);

    return c.json({
      success: true,
      message: force ? 'Force kill signal sent' : 'Stop signal sent (will force kill in 5s if needed)'
    });
  }

  return c.json({ success: false, error: result.error }, 500);
});

export default app;
