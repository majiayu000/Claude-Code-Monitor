import { beforeEach, describe, expect, test } from 'bun:test';
import { createLocalApiApp } from '../local-api/app.js';
import { resetDatabase } from '../db/migrations.js';
import { encodeAgentSessionId } from '../domain/work-item/index.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import { taskDispatchRepository } from '../infrastructure/database/repositories/task-dispatch.repository.js';
import { getDatabase } from '../infrastructure/database/sqlite.js';
import { workItemEvidenceRepository } from '../infrastructure/database/repositories/work-item-evidence.repository.js';
import { workItemRepository } from '../infrastructure/database/repositories/work-item.repository.js';
import { setupUser } from '../services/auth.service.js';
import {
  DISPATCH_CORRELATION_TIMEOUT_ERROR,
  DispatchSessionClaimConflictError,
  DispatchIdempotencyConflictError,
  TaskDispatchService,
} from '../services/task-dispatch.service.js';

describe('task dispatch correctness', () => {
  beforeEach(() => resetDatabase());

  test('makes every dispatch ambiguous when multiple tasks match the same new session', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const service = new TaskDispatchService({ now: () => now, launch: () => {} });
    const first = workItemRepository.create({ title: 'First task' });
    const second = workItemRepository.create({ title: 'Second task' });
    const firstDispatch = await service.dispatch(first.id, {
      runtimeId: 'codex', cwd: '/tmp', prompt: 'First prompt', idempotencyKey: 'shared-first',
    });
    const secondDispatch = await service.dispatch(second.id, {
      runtimeId: 'codex', cwd: '/tmp', prompt: 'Second prompt', idempotencyKey: 'shared-second',
    });
    sessionRepository.upsert({
      sessionId: 'codex_shared-new-session',
      client: 'codex',
      directory: '/tmp',
      initialPrompt: 'Shared result',
      title: 'Shared result',
      status: 'running',
      lastActiveAt: new Date(now.getTime() + 1),
    });

    service.reconcilePending();

    for (const id of [firstDispatch.id, secondDispatch.id]) {
      const dispatch = taskDispatchRepository.findById(id)!;
      expect(dispatch.state).toBe('ambiguous');
      expect(dispatch.candidateSessionIds).toEqual(['codex_shared-new-session']);
      expect(dispatch.linkedAgentSessionId).toBeUndefined();
    }
  });

  test('rejects a sequential second manual claim without creating another accepted link', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const service = new TaskDispatchService({ now: () => now, launch: () => {} });
    const first = workItemRepository.create({ title: 'First claimant' });
    const second = workItemRepository.create({ title: 'Second claimant' });
    const firstDispatch = await service.dispatch(first.id, {
      runtimeId: 'codex', cwd: '/tmp', prompt: 'First', idempotencyKey: 'claim-first',
    });
    const secondDispatch = await service.dispatch(second.id, {
      runtimeId: 'codex', cwd: '/tmp', prompt: 'Second', idempotencyKey: 'claim-second',
    });
    sessionRepository.upsert({
      sessionId: 'codex_manual-claim', client: 'codex', directory: '/tmp',
      title: 'Manual claim', status: 'running', lastActiveAt: new Date(now.getTime() + 1),
    });
    service.reconcilePending();

    const linked = service.resolveSession(firstDispatch.id, 'codex_manual-claim');
    expect(linked.state).toBe('linked');
    expect(() => service.resolveSession(secondDispatch.id, 'codex_manual-claim'))
      .toThrow(DispatchSessionClaimConflictError);
    expect(taskDispatchRepository.findById(secondDispatch.id)?.state).toBe('ambiguous');
    expect(() => taskDispatchRepository.updateState(secondDispatch.id, 'linked', {
      linkedAgentSessionId: linked.linkedAgentSessionId,
    })).toThrow();
    expect(taskDispatchRepository.findById(secondDispatch.id)?.state).toBe('ambiguous');
    const links = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM work_item_session_links
      WHERE agent_session_id = ? AND acceptance_status = 'accepted'
    `).get(linked.linkedAgentSessionId!) as { count: number };
    expect(links.count).toBe(1);
  });

  test('returns one success and one 409 when manual resolve requests race', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const service = new TaskDispatchService({ now: () => now, launch: () => {} });
    const first = workItemRepository.create({ title: 'Race first' });
    const second = workItemRepository.create({ title: 'Race second' });
    const dispatches = await Promise.all([
      service.dispatch(first.id, {
        runtimeId: 'codex', cwd: '/tmp', prompt: 'Race first', idempotencyKey: 'race-first',
      }),
      service.dispatch(second.id, {
        runtimeId: 'codex', cwd: '/tmp', prompt: 'Race second', idempotencyKey: 'race-second',
      }),
    ]);
    sessionRepository.upsert({
      sessionId: 'codex_racing-claim', client: 'codex', directory: '/tmp',
      title: 'Racing claim', status: 'running', lastActiveAt: new Date(now.getTime() + 1),
    });
    service.reconcilePending();
    const { token } = await setupUser('dispatch-race-user', 'password123');
    const app = createLocalApiApp();
    const responses = await Promise.all(dispatches.map((dispatch) => app.fetch(new Request(
      `http://localhost/api/v1/dispatches/${dispatch.id}/resolve-session`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'codex_racing-claim' }),
      }
    ))));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const agentSessionId = encodeAgentSessionId('codex', 'codex_racing-claim');
    const claimed = taskDispatchRepository.findLinkedByAgentSessionId(agentSessionId);
    expect(claimed).toHaveLength(1);
    const acceptedLinks = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM work_item_session_links
      WHERE agent_session_id = ? AND acceptance_status = 'accepted'
    `).get(agentSessionId) as { count: number };
    expect(acceptedLinks.count).toBe(1);
  });

  test('reuses only a canonical idempotent payload and returns 409 for conflicts', async () => {
    let launches = 0;
    const service = new TaskDispatchService({ launch: () => { launches++; } });
    const item = workItemRepository.create({ title: 'Canonical payload' });
    const input = {
      runtimeId: 'codex' as const,
      cwd: '/tmp',
      prompt: 'Canonical prompt',
      terminalApp: 'auto' as const,
      idempotencyKey: 'canonical-key',
    };
    const first = await service.dispatch(item.id, input);
    const replay = await service.dispatch(item.id, { ...input, prompt: '  Canonical prompt  ' });
    expect(replay.id).toBe(first.id);
    expect(launches).toBe(1);
    await expect(service.dispatch(item.id, { ...input, prompt: 'Different prompt' }))
      .rejects.toBeInstanceOf(DispatchIdempotencyConflictError);

    const { token } = await setupUser('dispatch-conflict-user', 'password123');
    const response = await createLocalApiApp().fetch(new Request(
      `http://localhost/api/v1/work-items/${item.id}/dispatch`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, prompt: 'Route conflict' }),
      }
    ));
    expect(response.status).toBe(409);
  });

  test('fails an awaiting dispatch after its persisted deadline following restart', async () => {
    let now = new Date('2026-08-30T00:00:00.000Z');
    const item = workItemRepository.create({ title: 'Restart deadline' });
    const firstProcess = new TaskDispatchService({
      now: () => now,
      correlationTimeoutMs: 1_000,
      launch: () => {},
    });
    const created = await firstProcess.dispatch(item.id, {
      runtimeId: 'codex', cwd: '/tmp', prompt: 'Wait for session', idempotencyKey: 'deadline-key',
    });
    expect(created.correlationDeadlineAt.toISOString()).toBe('2026-08-30T00:00:01.000Z');

    now = new Date('2026-08-30T00:00:01.001Z');
    const restartedProcess = new TaskDispatchService({ now: () => now, launch: () => {} });
    restartedProcess.reconcilePending();
    const failed = taskDispatchRepository.findById(created.id)!;
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe(DISPATCH_CORRELATION_TIMEOUT_ERROR);
  });

  test('keeps Stash task status authoritative until the next external upsert', async () => {
    const service = new TaskDispatchService({ launch: () => {} });
    const stashItem = workItemRepository.create({
      title: 'Stash truth',
      status: 'planned',
      externalSource: 'stash',
      externalId: 'stash-truth-1',
    });
    await service.dispatch(stashItem.id, {
      runtimeId: 'codex', cwd: '/tmp', prompt: 'Do work', idempotencyKey: 'stash-truth-dispatch',
    });
    expect(workItemRepository.findById(stashItem.id)?.status).toBe('planned');

    const agentSession = workItemEvidenceRepository.upsertAgentSession({
      runtimeId: 'codex', runtimeSessionId: 'codex_stash-truth-session', cwd: '/tmp',
      status: 'completed', title: 'Finished',
    });
    workItemEvidenceRepository.createSessionLink({
      workItemId: stashItem.id, agentSessionId: agentSession.id, linkSource: 'user',
    });
    const evidence = workItemEvidenceRepository.createProgressEvidence({
      agentSessionId: agentSession.id,
      kind: 'message', outcome: 'completed', confidence: 'explicit', summary: 'Explicitly finished',
    });
    const { token } = await setupUser('stash-truth-user', 'password123');
    const app = createLocalApiApp();
    const review = await app.fetch(new Request(
      `http://localhost/api/v1/work-items/${stashItem.id}/completion-review`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ evidenceId: evidence.id, decision: 'accepted' }),
      }
    ));
    expect(review.status).toBe(200);
    expect(workItemRepository.findById(stashItem.id)?.status).toBe('planned');

    const external = await app.fetch(new Request(
      'http://localhost/api/v1/work-items/external/stash/stash-truth-1',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Stash truth', status: 'done', kind: 'todo' }),
      }
    ));
    expect(external.status).toBe(200);
    expect(workItemRepository.findById(stashItem.id)?.status).toBe('done');
  });
});
