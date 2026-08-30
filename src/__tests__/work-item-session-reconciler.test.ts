import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetDatabase } from '../db/migrations.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import { workItemEvidenceRepository } from '../infrastructure/database/repositories/work-item-evidence.repository.js';
import { workItemRepository } from '../infrastructure/database/repositories/work-item.repository.js';
import { reconcileLinkedAgentSessions } from '../services/work-item-session-reconciler.js';

describe('linked agent session reconciliation', () => {
  beforeEach(() => resetDatabase());
  afterEach(() => closeDatabase());

  test('refreshes accepted links and deduplicates genuinely explicit completion evidence', () => {
    const runtimeSessionId = 'codex_runtime-session-12345678';
    const item = workItemRepository.create({ title: 'Reconcile linked work', status: 'active' });
    const linked = workItemEvidenceRepository.upsertAgentSession({
      runtimeId: 'codex',
      runtimeSessionId,
      cwd: '/tmp/old',
      title: 'Old title',
      status: 'running',
    });
    workItemEvidenceRepository.createSessionLink({
      workItemId: item.id,
      agentSessionId: linked.id,
      linkSource: 'user',
    });
    sessionRepository.upsert({
      sessionId: runtimeSessionId,
      client: 'codex',
      directory: '/tmp/current',
      title: 'Canonical title',
      initialPrompt: 'Canonical prompt',
      status: 'running',
      lastMessage: '  Running   the final checks.  ',
      lastActiveAt: new Date('2026-08-30T10:00:00Z'),
    });

    const runningResult = reconcileLinkedAgentSessions();
    expect(runningResult).toEqual({ updated: 1, missing: 0, evidenceCreated: 0 });
    expect(workItemEvidenceRepository.findAgentSessionById(linked.id)).toMatchObject({
      cwd: '/tmp/current',
      title: 'Canonical title',
      status: 'running',
      evidenceSummary: 'Running the final checks.',
    });
    expect(workItemEvidenceRepository.findLatestExplicitCompletionForAgentSession(linked.id)).toBeNull();

    const completedAt = new Date('2026-08-30T10:05:00Z');
    sessionRepository.upsert({
      sessionId: runtimeSessionId,
      status: 'completed',
      completedAt,
      lastMessage: 'All checks passed explicitly.',
    });
    const firstCompletion = reconcileLinkedAgentSessions();
    const evidence = workItemEvidenceRepository.findLatestExplicitCompletionForAgentSession(linked.id);
    expect(firstCompletion.evidenceCreated).toBe(1);
    expect(evidence).toMatchObject({
      outcome: 'completed',
      confidence: 'explicit',
      summary: 'All checks passed explicitly.',
      metadata: {
        source: 'canonical_session_completed',
        completedAt: completedAt.toISOString(),
      },
    });

    const secondCompletion = reconcileLinkedAgentSessions();
    expect(secondCompletion.evidenceCreated).toBe(0);
    expect(workItemEvidenceRepository.findLatestExplicitCompletionForAgentSession(linked.id)?.id)
      .toBe(evidence?.id);
  });

  test('never treats lost status or completed-without-timestamp as explicit completion', () => {
    const item = workItemRepository.create({ title: 'Do not infer completion', status: 'active' });
    for (const [runtimeSessionId, status] of [
      ['codex_lost-session-12345678', 'lost'],
      ['codex_missing-time-12345678', 'completed'],
    ] as const) {
      const linked = workItemEvidenceRepository.upsertAgentSession({
        runtimeId: 'codex', runtimeSessionId, cwd: '/tmp', title: runtimeSessionId, status: 'running',
      });
      workItemEvidenceRepository.createSessionLink({
        workItemId: item.id, agentSessionId: linked.id, linkSource: 'user',
      });
      sessionRepository.upsert({
        sessionId: runtimeSessionId,
        client: 'codex',
        directory: '/tmp',
        title: runtimeSessionId,
        initialPrompt: runtimeSessionId,
        status,
        lastActiveAt: new Date(),
      });
    }

    const result = reconcileLinkedAgentSessions();
    expect(result.evidenceCreated).toBe(0);
  });
});
