import { Hono } from 'hono';
import { isValidSessionId } from '../../lib/session-id.js';
import { authMiddleware } from '../../web/api/middleware/auth.js';

const RECOVERY_RESULT_PREFIX = '__KEEPLINE_SERVICE_RECOVERY__';
const TERMINAL_APPS = new Set(['auto', 'Terminal', 'iTerm', 'Warp']);
const CONFIRMATION_ID = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;

export interface LocalRecoveryPreview {
  sessionId: string;
  runtimeId: 'codex' | 'claude-code';
  method: 'resume' | 'continue' | 'new';
  executable: 'codex' | 'claude' | 'claude-code';
  arguments: string[];
  directory: string;
  createsNewSession: boolean;
  confirmationId: string;
}

export type RecoveryRunnerRequest =
  | { action: 'preview'; sessionId: string }
  | {
      action: 'execute';
      sessionId: string;
      confirmationId: string;
      terminalApp: 'auto' | 'Terminal' | 'iTerm' | 'Warp';
    };

export interface RecoveryRunnerResult {
  preview: LocalRecoveryPreview;
  executed: boolean;
}

export type RecoveryRunner = (request: RecoveryRunnerRequest) => Promise<RecoveryRunnerResult>;

class RecoveryRouteError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 500 | 503, message: string) {
    super(message);
  }
}

async function readLimited(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HELPER_OUTPUT_BYTES) {
        throw new RecoveryRouteError(500, 'Recovery helper returned too much output');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createRecoveryProcessRunner(command: string[]): RecoveryRunner {
  if (command.length === 0) {
    return async () => { throw new RecoveryRouteError(503, 'Recovery helper is unavailable'); };
  }
  return async (request) => {
    const args = request.action === 'preview'
      ? ['preview', request.sessionId]
      : ['execute', request.sessionId, request.confirmationId, request.terminalApp];
    const child = Bun.spawn([...command, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (!child.stdout || typeof child.stdout === 'number' ||
        !child.stderr || typeof child.stderr === 'number') {
      child.kill('SIGTERM');
      throw new RecoveryRouteError(500, 'Recovery helper output is unavailable');
    }
    const stdoutPromise = readLimited(child.stdout);
    const stderrPromise = readLimited(child.stderr);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const exitCode = await child.exited;
    clearTimeout(timeout);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const line = stdout.split('\n').find((value) => value.startsWith(RECOVERY_RESULT_PREFIX));
    if (!line) {
      throw new RecoveryRouteError(
        500,
        stderr.trim() || `Recovery helper exited with status ${exitCode}`
      );
    }
    let payload: {
      success?: boolean;
      status?: number;
      error?: string;
      preview?: LocalRecoveryPreview;
      executed?: boolean;
    };
    try {
      payload = JSON.parse(line.slice(RECOVERY_RESULT_PREFIX.length));
    } catch {
      throw new RecoveryRouteError(500, 'Recovery helper returned invalid JSON');
    }
    if (!payload.success || !payload.preview || typeof payload.executed !== 'boolean') {
      const status = [400, 404, 409, 500, 503].includes(payload.status ?? 0)
        ? payload.status as 400 | 404 | 409 | 500 | 503
        : 500;
      throw new RecoveryRouteError(status, payload.error ?? 'Recovery helper failed');
    }
    return { preview: payload.preview, executed: payload.executed };
  };
}

export function createRecoveryRoutes(runRecovery: RecoveryRunner): Hono {
  const app = new Hono();
  const executions = new Map<
    string,
    { fingerprint: string; result: Promise<RecoveryRunnerResult> }
  >();
  app.use('*', authMiddleware);

  app.get('/:id/recovery-preview', async (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ success: false, error: 'Invalid session ID format' }, 400);
    }
    try {
      const result = await runRecovery({ action: 'preview', sessionId });
      return c.json({ success: true, data: { preview: result.preview } });
    } catch (error) {
      return recoveryErrorResponse(c, error);
    }
  });

  app.post('/:id/recover', async (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ success: false, error: 'Invalid session ID format' }, 400);
    }
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const allowedKeys = new Set(['confirmationId', 'terminalApp', 'idempotencyKey']);
    if (!body || Object.keys(body).some((key) => !allowedKeys.has(key)) ||
        typeof body.confirmationId !== 'string' || !CONFIRMATION_ID.test(body.confirmationId) ||
        typeof body.terminalApp !== 'string' || !TERMINAL_APPS.has(body.terminalApp) ||
        typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) {
      return c.json({ success: false, error: 'Invalid recovery confirmation' }, 400);
    }
    const terminalApp = body.terminalApp as 'auto' | 'Terminal' | 'iTerm' | 'Warp';
    const fingerprint = `${sessionId}\0${body.confirmationId}\0${terminalApp}`;
    const existing = executions.get(body.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return c.json({ success: false, error: 'Idempotency key conflicts with another recovery' }, 409);
      }
      try {
        const result = await existing.result;
        return c.json({ success: true, data: result });
      } catch (error) {
        executions.delete(body.idempotencyKey);
        return recoveryErrorResponse(c, error);
      }
    }

    const result = (async () => {
      const current = await runRecovery({ action: 'preview', sessionId });
      if (current.preview.confirmationId !== body.confirmationId) {
        throw new RecoveryRouteError(409, 'Recovery preview changed; review it again');
      }
      const executed = await runRecovery({
        action: 'execute',
        sessionId,
        confirmationId: body.confirmationId,
        terminalApp,
      });
      if (!executed.executed || executed.preview.confirmationId !== body.confirmationId) {
        throw new RecoveryRouteError(500, 'Recovery helper did not confirm execution');
      }
      return executed;
    })();
    executions.set(body.idempotencyKey, { fingerprint, result });
    try {
      return c.json({ success: true, data: await result });
    } catch (error) {
      executions.delete(body.idempotencyKey);
      return recoveryErrorResponse(c, error);
    }
  });

  return app;
}

function recoveryErrorResponse(c: Parameters<typeof authMiddleware>[0], error: unknown) {
  if (error instanceof RecoveryRouteError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  return c.json({ success: false, error: 'Recovery request failed' }, 500);
}
