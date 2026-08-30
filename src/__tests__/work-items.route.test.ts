import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import workItems from '../web/api/routes/work-items.js';
import workItemEvidence from '../web/api/routes/work-item-evidence.js';
import { setupUser } from '../services/auth.service.js';
import { resetDatabase } from '../db/migrations.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';

async function authedRequest(
  token: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return workItems.fetch(new Request(`http://localhost${path}`, {
    ...options,
    headers,
  }));
}

async function workboardEvidenceRequest(
  token: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return workItemEvidence.fetch(new Request(`http://localhost${path}`, {
    ...options,
    headers,
  }));
}

describe('Work item routes', () => {
  beforeEach(() => {
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
  });

  test('captures a work item without a project', async () => {
    const { token } = await setupUser('work-item-capture-user', 'password123');
    const response = await authedRequest(token, '/', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Triage loose inbox item',
        kind: 'todo',
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json() as {
      success: boolean;
      data: {
        item: {
          id: string;
          title: string;
          kind: string;
          status: string;
          statusSource: string;
          projectRoot?: string;
        };
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.item).toMatchObject({
      title: 'Triage loose inbox item',
      kind: 'todo',
      status: 'inbox',
      statusSource: 'user',
    });
    expect(body.data.item.projectRoot).toBeUndefined();
  });

  test('upserts external work items idempotently by source and external ID', async () => {
    const { token } = await setupUser('work-item-external-user', 'password123');
    const first = await authedRequest(token, '/external/stash/task-42', {
      method: 'PUT',
      body: JSON.stringify({
        title: 'First Stash title',
        body: 'Original body',
        kind: 'todo',
        status: 'planned',
      }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as {
      data: { item: { id: string; externalSource: string; externalId: string } };
    };

    const second = await authedRequest(token, '/external/stash/task-42', {
      method: 'PUT',
      body: JSON.stringify({
        title: 'Updated Stash title',
        kind: 'todo',
        status: 'active',
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as {
      data: { item: { id: string; title: string; status: string } };
    };
    expect(secondBody.data.item).toMatchObject({
      id: firstBody.data.item.id,
      title: 'Updated Stash title',
      status: 'active',
    });
    expect(firstBody.data.item).toMatchObject({
      externalSource: 'stash',
      externalId: 'task-42',
    });

    const list = await authedRequest(token, '/');
    const listBody = await list.json() as { data: { items: Array<{ id: string }> } };
    expect(listBody.data.items.filter((item) => item.id === firstBody.data.item.id)).toHaveLength(1);
  });

  test('requires explicit completion evidence and preserves accept or reject review', async () => {
    const { token } = await setupUser('work-item-review-user', 'password123');
    const createResponse = await authedRequest(token, '/', {
      method: 'POST',
      body: JSON.stringify({ title: 'Review agent completion', kind: 'todo', status: 'active' }),
    });
    const createBody = await createResponse.json() as { data: { item: { id: string } } };
    const workItemId = createBody.data.item.id;

    const evidenceResponse = await workboardEvidenceRequest(token, '/evidence', {
      method: 'POST',
      body: JSON.stringify({
        workItemId,
        kind: 'test_result',
        outcome: 'completed',
        confidence: 'explicit',
        summary: 'All end-to-end checks passed',
      }),
    });
    const evidenceBody = await evidenceResponse.json() as { data: { evidence: { id: string } } };
    const evidenceId = evidenceBody.data.evidence.id;

    const suggestionResponse = await authedRequest(token, '/');
    const suggestionBody = await suggestionResponse.json() as {
      data: { workboard: { now: Array<{ item: { id: string }; completionSuggestion?: { evidenceId: string } }> } };
    };
    expect(suggestionBody.data.workboard.now.find((entry) => entry.item.id === workItemId)?.completionSuggestion)
      .toMatchObject({ evidenceId });

    const reject = await authedRequest(token, `/${workItemId}/completion-review`, {
      method: 'POST',
      body: JSON.stringify({ evidenceId, decision: 'rejected' }),
    });
    expect(reject.status).toBe(200);
    const rejectBody = await reject.json() as { data: { item: { status: string } } };
    expect(rejectBody.data.item.status).toBe('active');

    const accept = await authedRequest(token, `/${workItemId}/completion-review`, {
      method: 'POST',
      body: JSON.stringify({ evidenceId, decision: 'accepted' }),
    });
    expect(accept.status).toBe(200);
    const acceptBody = await accept.json() as {
      data: { review: { id: string; decision: string }; item: { status: string; statusSource: string } };
    };
    expect(acceptBody.data.review.decision).toBe('accepted');
    expect(acceptBody.data.item).toMatchObject({
      status: 'done',
      statusSource: 'accepted_agent_suggestion',
    });
  });

  test('accepts explicit session evidence only through an accepted work item link', async () => {
    const { token } = await setupUser('work-item-linked-review-user', 'password123');
    const createResponse = await authedRequest(token, '/', {
      method: 'POST',
      body: JSON.stringify({ title: 'Linked completion', kind: 'todo', status: 'active' }),
    });
    const createBody = await createResponse.json() as { data: { item: { id: string } } };
    const workItemId = createBody.data.item.id;
    const agentSessionResponse = await workboardEvidenceRequest(token, '/agent-sessions', {
      method: 'POST',
      body: JSON.stringify({
        runtimeId: 'codex',
        runtimeSessionId: 'linked-completion-session',
        cwd: '/tmp/project',
        status: 'completed',
        title: 'Linked completion session',
      }),
    });
    const agentSessionBody = await agentSessionResponse.json() as {
      data: { agentSession: { id: string } };
    };
    const agentSessionId = agentSessionBody.data.agentSession.id;
    await workboardEvidenceRequest(token, `/${workItemId}/session-links`, {
      method: 'POST',
      body: JSON.stringify({ agentSessionId, linkSource: 'user' }),
    });
    const evidenceResponse = await workboardEvidenceRequest(token, '/evidence', {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId,
        kind: 'message',
        outcome: 'completed',
        confidence: 'explicit',
        summary: 'The linked session finished explicitly',
      }),
    });
    const evidenceBody = await evidenceResponse.json() as { data: { evidence: { id: string } } };

    const review = await authedRequest(token, `/${workItemId}/completion-review`, {
      method: 'POST',
      body: JSON.stringify({ evidenceId: evidenceBody.data.evidence.id, decision: 'accepted' }),
    });
    expect(review.status).toBe(200);
    const reviewBody = await review.json() as { data: { item: { status: string } } };
    expect(reviewBody.data.item.status).toBe('done');
  });

  test('rejects suggestion-sourced formal status changes through generic CRUD', async () => {
    const { token } = await setupUser('work-item-agent-user', 'password123');
    const createResponse = await authedRequest(token, '/', {
      method: 'POST',
      body: JSON.stringify({ title: 'Do not silently close', kind: 'idea' }),
    });
    const createBody = await createResponse.json() as {
      data: { item: { id: string } };
    };

    const rejected = await authedRequest(token, `/${createBody.data.item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'done',
        statusSource: 'heuristic_suggestion',
      }),
    });

    expect(rejected.status).toBe(400);
    const rejectedBody = await rejected.json() as { success: boolean; error: string };
    expect(rejectedBody.success).toBe(false);
    expect(rejectedBody.error).toContain('statusSource');

    const acceptedWithoutArtifact = await authedRequest(token, `/${createBody.data.item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'planned',
        statusSource: 'accepted_agent_suggestion',
      }),
    });

    expect(acceptedWithoutArtifact.status).toBe(400);
    const acceptedBody = await acceptedWithoutArtifact.json() as {
      success: boolean;
      error: string;
    };
    expect(acceptedBody.success).toBe(false);
    expect(acceptedBody.error).toContain('explicit suggestion acceptance endpoint');

    const getResponse = await authedRequest(token, `/${createBody.data.item.id}`);
    const getBody = await getResponse.json() as {
      data: { item: { status: string; statusSource: string; completedAt?: string } };
    };
    expect(getBody.data.item).toMatchObject({
      status: 'inbox',
      statusSource: 'user',
    });
    expect(getBody.data.item.completedAt).toBeUndefined();
  });

  test('allows user actions to change formal status explicitly', async () => {
    const { token } = await setupUser('work-item-accepted-user', 'password123');
    const createResponse = await authedRequest(token, '/', {
      method: 'POST',
      body: JSON.stringify({ title: 'Plan manually', kind: 'todo' }),
    });
    const createBody = await createResponse.json() as {
      data: { item: { id: string } };
    };

    const updateResponse = await authedRequest(token, `/${createBody.data.item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'planned',
        statusSource: 'user',
      }),
    });

    expect(updateResponse.status).toBe(200);
    const updateBody = await updateResponse.json() as {
      success: boolean;
      data: { item: { status: string; statusSource: string } };
    };
    expect(updateBody.success).toBe(true);
    expect(updateBody.data.item).toMatchObject({
      status: 'planned',
      statusSource: 'user',
    });
  });

  test('lists items with overview stats and supports deletion', async () => {
    const { token } = await setupUser('work-item-list-user', 'password123');
    const createTodo = await authedRequest(token, '/', {
      method: 'POST',
      body: JSON.stringify({ title: 'Todo item', kind: 'todo' }),
    });
    await authedRequest(token, '/', {
      method: 'POST',
      body: JSON.stringify({ title: 'Idea item', kind: 'idea', area: 'Product' }),
    });
    const todoBody = await createTodo.json() as { data: { item: { id: string } } };

    const listResponse = await authedRequest(token, '/');
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json() as {
      success: boolean;
      data: {
        items: Array<{ title: string; area?: string }>;
        stats: { total: number; inbox: number; todo: number; idea: number };
      };
    };
    expect(listBody.success).toBe(true);
    expect(listBody.data.items).toHaveLength(2);
    expect(listBody.data.items.map((item) => item.title)).toContain('Idea item');
    expect(listBody.data.items.find((item) => item.title === 'Idea item')?.area).toBe('Product');
    expect(listBody.data.stats).toMatchObject({
      total: 2,
      inbox: 2,
      todo: 1,
      idea: 1,
    });

    const deleteResponse = await authedRequest(token, `/${todoBody.data.item.id}`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(200);

    const afterDelete = await authedRequest(token, '/');
    const afterDeleteBody = await afterDelete.json() as {
      data: { items: Array<{ title: string }> };
    };
    expect(afterDeleteBody.data.items.map((item) => item.title)).not.toContain('Todo item');
  });

  test('returns deterministic Workboard buckets and marks pending suggestions', async () => {
    const { token } = await setupUser('workboard-user', 'password123');
    const now = Date.now();
    const oldDate = new Date(now - 72 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date(now - 60 * 1000).toISOString();

    const staleResponse = await authedRequest(token, '/', {
      method: 'POST',
      body: JSON.stringify({ title: 'Stale planned', kind: 'todo', status: 'planned' }),
    });
    const runningResponse = await authedRequest(token, '/', {
      method: 'POST',
      body: JSON.stringify({ title: 'Suggested running', kind: 'todo', status: 'planned' }),
    });
    const doneResponse = await authedRequest(token, '/', {
      method: 'POST',
      body: JSON.stringify({ title: 'Completed by user', kind: 'todo', status: 'done' }),
    });
    const staleBody = await staleResponse.json() as { data: { item: { id: string } } };
    const runningBody = await runningResponse.json() as { data: { item: { id: string } } };
    const doneBody = await doneResponse.json() as { data: { item: { id: string } } };

    const staleSessionResponse = await workboardEvidenceRequest(token, '/agent-sessions', {
      method: 'POST',
      body: JSON.stringify({
        runtimeId: 'codex',
        runtimeSessionId: 'stale-session',
        cwd: '/tmp/project',
        status: 'completed',
        title: 'Old session',
        lastActiveAt: oldDate,
      }),
    });
    const runningSessionResponse = await workboardEvidenceRequest(token, '/agent-sessions', {
      method: 'POST',
      body: JSON.stringify({
        runtimeId: 'codex',
        runtimeSessionId: 'running-session',
        cwd: '/tmp/project',
        status: 'running',
        title: 'Running session',
        lastActiveAt: recentDate,
      }),
    });
    const staleSessionBody = await staleSessionResponse.json() as {
      data: { agentSession: { id: string } };
    };
    const runningSessionBody = await runningSessionResponse.json() as {
      data: { agentSession: { id: string } };
    };

    await workboardEvidenceRequest(token, `/${staleBody.data.item.id}/session-links`, {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId: staleSessionBody.data.agentSession.id,
        linkSource: 'user',
      }),
    });
    await workboardEvidenceRequest(token, `/${runningBody.data.item.id}/session-links`, {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId: runningSessionBody.data.agentSession.id,
        linkSource: 'heuristic_suggestion',
      }),
    });

    const listWithPending = await authedRequest(token, '/?staleWindowHours=24');
    expect(listWithPending.status).toBe(200);
    const pendingBody = await listWithPending.json() as {
      data: {
        workboard: {
          now: Array<{ item: { id: string } }>;
          stale: Array<{ item: { id: string } }>;
          done: Array<{ item: { id: string } }>;
          suggestions: Array<{
            item: { id: string };
            suggestions: Array<{ agentSession: { status: string } }>;
          }>;
        };
      };
    };

    expect(pendingBody.data.workboard.stale.map((entry) => entry.item.id))
      .toEqual([staleBody.data.item.id]);
    expect(pendingBody.data.workboard.done.map((entry) => entry.item.id))
      .toEqual([doneBody.data.item.id]);
    expect(pendingBody.data.workboard.now).toHaveLength(0);
    expect(pendingBody.data.workboard.suggestions.map((entry) => entry.item.id))
      .toEqual([runningBody.data.item.id]);
    expect(pendingBody.data.workboard.suggestions[0].suggestions[0].agentSession.status)
      .toBe('running');

    await workboardEvidenceRequest(token, `/${runningBody.data.item.id}/session-links`, {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId: runningSessionBody.data.agentSession.id,
        linkSource: 'user',
      }),
    });

    const listAfterAccept = await authedRequest(token, '/?staleWindowHours=24');
    const acceptedBody = await listAfterAccept.json() as {
      data: {
        workboard: {
          now: Array<{ item: { id: string } }>;
          suggestions: Array<{ item: { id: string } }>;
        };
      };
    };
    expect(acceptedBody.data.workboard.now.map((entry) => entry.item.id))
      .toEqual([runningBody.data.item.id]);
    expect(acceptedBody.data.workboard.suggestions).toHaveLength(0);
  });
});
