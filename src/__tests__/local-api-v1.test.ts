import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createLocalApiApp } from '../local-api/app.js';
import { resetDatabase } from '../db/migrations.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';
import { setupUser } from '../services/auth.service.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import { workItemEvidenceRepository } from '../infrastructure/database/repositories/work-item-evidence.repository.js';
import { taskDispatchRepository } from '../infrastructure/database/repositories/task-dispatch.repository.js';
import { workItemRepository } from '../infrastructure/database/repositories/work-item.repository.js';

describe('Local API v1', () => {
  beforeEach(() => resetDatabase());
  afterEach(() => closeDatabase());

  test('serves health and capability metadata without authentication', async () => {
    const app = createLocalApiApp();
    const health = await app.fetch(new Request('http://localhost/api/v1/health'));
    expect(health.status).toBe(200);
    const healthBody = await health.json() as { data: { status: string; mode: string } };
    expect(healthBody.data).toMatchObject({ status: 'ok', mode: 'service' });

    const meta = await app.fetch(new Request('http://localhost/api/v1/meta'));
    expect(meta.status).toBe(200);
    const metaBody = await meta.json() as {
      data: { apiVersion: string; capabilities: string[]; runtimes: Array<{ id: string }> };
    };
    expect(metaBody.data.apiVersion).toBe('1.0');
    expect(metaBody.data.capabilities).toContain('work-items.external-upsert');
    expect(metaBody.data.runtimes.map((runtime) => runtime.id)).toEqual(
      expect.arrayContaining(['codex', 'claude-code'])
    );
  });

  test('returns session summaries with explicit completion evidence IDs', async () => {
    const app = createLocalApiApp();
    const { token } = await setupUser('local-api-session-user', 'password123');
    const session = sessionRepository.upsert({
      sessionId: 'session-12345678',
      client: 'codex',
      directory: '/tmp/local-api-project',
      title: 'Run integration checks',
      initialPrompt: 'Run integration checks',
      status: 'completed',
      lastActiveAt: new Date('2026-08-30T10:00:00.123Z'),
    });
    const agentSession = workItemEvidenceRepository.upsertAgentSession({
      runtimeId: 'codex',
      runtimeSessionId: session.sessionId,
      cwd: session.directory,
      title: session.title,
      status: session.status,
      lastActiveAt: session.lastActiveAt,
      evidenceSummary: 'Checks completed',
    });
    const evidence = workItemEvidenceRepository.createProgressEvidence({
      agentSessionId: agentSession.id,
      runtimeId: 'codex',
      kind: 'test_result',
      outcome: 'completed',
      confidence: 'explicit',
      summary: 'Checks completed',
    });

    const response = await app.fetch(new Request('http://localhost/api/v1/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: { sessions: Array<{ sessionId: string; runtimeId: string; completionEvidenceId?: string }> };
    };
    expect(body.data.sessions).toContainEqual(expect.objectContaining({
      sessionId: session.sessionId,
      runtimeId: 'codex',
      completionEvidenceId: evidence.id,
    }));
  });

  test('serializes a linked dispatch with its native runtime session ID', async () => {
    const app = createLocalApiApp();
    const { token } = await setupUser('local-api-dispatch-user', 'password123');
    const item = workItemRepository.create({ title: 'Dispatch contract', kind: 'todo' });
    const agentSession = workItemEvidenceRepository.upsertAgentSession({
      runtimeId: 'codex',
      runtimeSessionId: 'runtime-session-87654321',
      cwd: '/tmp/local-api-project',
      title: 'Dispatched session',
      status: 'running',
    });
    let dispatch = taskDispatchRepository.create({
      workItemId: item.id,
      runtimeId: 'codex',
      cwd: '/tmp/local-api-project',
      prompt: 'Run the task',
      terminalApp: 'auto',
      idempotencyKey: 'local-api-dispatch-key',
      preLaunchSessionIds: [],
      correlationDeadlineAt: new Date(Date.now() + 60_000),
    });
    dispatch = taskDispatchRepository.updateState(dispatch.id, 'linked', {
      candidateSessionIds: [agentSession.runtimeSessionId],
      linkedAgentSessionId: agentSession.id,
    })!;

    const response = await app.fetch(new Request(`http://localhost/api/v1/dispatches/${dispatch.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: { dispatch: { candidateSessionIds: string[]; linkedAgentSessionId: string; linkedSessionId: string } };
    };
    expect(body.data.dispatch).toMatchObject({
      candidateSessionIds: [agentSession.runtimeSessionId],
      linkedAgentSessionId: agentSession.id,
      linkedSessionId: agentSession.runtimeSessionId,
    });
  });
});
