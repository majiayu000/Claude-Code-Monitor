import { afterEach, beforeEach, expect, test } from 'bun:test';
import { resetDatabase } from '../db/migrations.js';
import { createLocalApiApp } from '../local-api/app.js';
import { migration012 } from '../infrastructure/database/migrations/012_unique_dispatch_session_claim.js';
import { rollbackMigration, runMigration } from '../infrastructure/database/migrations/index.js';
import { taskDispatchRepository } from '../infrastructure/database/repositories/task-dispatch.repository.js';
import { workItemEvidenceRepository } from '../infrastructure/database/repositories/work-item-evidence.repository.js';
import { workItemRepository } from '../infrastructure/database/repositories/work-item.repository.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import { closeDatabase, getDatabase } from '../infrastructure/database/sqlite.js';
import { setupUser } from '../services/auth.service.js';

beforeEach(() => resetDatabase());
afterEach(() => closeDatabase());

function linkCount(agentSessionId: string, status: 'accepted' | 'rejected'): number {
  return (getDatabase().prepare(`
    SELECT COUNT(*) AS count FROM work_item_session_links
    WHERE agent_session_id = ? AND acceptance_status = ?
  `).get(agentSessionId, status) as { count: number }).count;
}

test('migration012 revokes historical duplicate evidence ownership before re-resolution', async () => {
  rollbackMigration(migration012);
  const runtimeSessionId = 'codex_historical-duplicate';
  sessionRepository.upsert({
    sessionId: runtimeSessionId,
    client: 'codex',
    directory: '/tmp',
    title: 'Historical duplicate',
    status: 'running',
    lastActiveAt: new Date(),
  });
  const agentSession = workItemEvidenceRepository.upsertAgentSession({
    runtimeId: 'codex',
    runtimeSessionId,
    cwd: '/tmp',
    title: 'Historical duplicate',
    status: 'running',
  });
  const workItems = [
    workItemRepository.create({ title: 'Historical first' }),
    workItemRepository.create({ title: 'Historical second' }),
  ];
  const manualOnlyItem = workItemRepository.create({ title: 'Manual link without dispatch' });
  const dispatches = workItems.map((item, index) => {
    const dispatch = taskDispatchRepository.create({
      workItemId: item.id,
      runtimeId: 'codex',
      cwd: '/tmp',
      prompt: `Historical prompt ${index}`,
      terminalApp: 'auto',
      idempotencyKey: `historical-duplicate-${index}`,
      preLaunchSessionIds: [],
      correlationDeadlineAt: new Date(Date.now() + 60_000),
    });
    taskDispatchRepository.updateState(dispatch.id, 'linked', {
      candidateSessionIds: [runtimeSessionId],
      linkedAgentSessionId: agentSession.id,
      launchedAt: new Date(),
    });
    workItemEvidenceRepository.createSessionLink({
      workItemId: item.id,
      agentSessionId: agentSession.id,
      linkSource: 'user',
    });
    return dispatch;
  });
  workItemEvidenceRepository.createSessionLink({
    workItemId: manualOnlyItem.id,
    agentSessionId: agentSession.id,
    linkSource: 'user',
  });
  expect(linkCount(agentSession.id, 'accepted')).toBe(3);

  runMigration(migration012);

  expect(linkCount(agentSession.id, 'accepted')).toBe(1);
  expect(linkCount(agentSession.id, 'rejected')).toBe(2);
  const duplicateAccepted = getDatabase().prepare(`
    SELECT COUNT(*) AS count FROM work_item_session_links
    WHERE work_item_id IN (?, ?) AND agent_session_id = ?
      AND acceptance_status = 'accepted'
  `).get(workItems[0].id, workItems[1].id, agentSession.id) as { count: number };
  expect(duplicateAccepted.count).toBe(0);
  const manualLink = getDatabase().prepare(`
    SELECT acceptance_status AS status FROM work_item_session_links
    WHERE work_item_id = ? AND agent_session_id = ?
  `).get(manualOnlyItem.id, agentSession.id) as { status: string };
  expect(manualLink.status).toBe('accepted');
  for (const dispatch of dispatches) {
    const migrated = taskDispatchRepository.findById(dispatch.id)!;
    expect(migrated.state).toBe('ambiguous');
    expect(migrated.linkedAgentSessionId).toBeUndefined();
  }

  const { token } = await setupUser('historical-claim-user', 'password123');
  const app = createLocalApiApp();
  const resolve = (dispatchId: string) => app.fetch(new Request(
    `http://localhost/api/v1/dispatches/${dispatchId}/resolve-session`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: runtimeSessionId }),
    }
  ));
  expect((await resolve(dispatches[0].id)).status).toBe(200);
  expect(linkCount(agentSession.id, 'accepted')).toBe(2);
  expect(linkCount(agentSession.id, 'rejected')).toBe(1);
  expect((await resolve(dispatches[1].id)).status).toBe(409);
  expect(linkCount(agentSession.id, 'accepted')).toBe(2);
  expect(linkCount(agentSession.id, 'rejected')).toBe(1);
});
