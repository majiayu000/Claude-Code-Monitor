import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import workItemEvidence from '../web/api/routes/work-item-evidence.js';
import workItems from '../web/api/routes/work-items.js';
import { setupUser } from '../services/auth.service.js';
import { resetDatabase } from '../db/migrations.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';
import { encodeAgentSessionId } from '../domain/work-item/index.js';
import { isValidSessionId } from '../lib/session-id.js';

async function authedWorkItemsRequest(
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

async function authedEvidenceRequest(
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

async function captureTestWorkItem(token: string, title: string): Promise<string> {
  const response = await authedWorkItemsRequest(token, '/', {
    method: 'POST',
    body: JSON.stringify({ title, kind: 'todo' }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as {
    data: { item: { id: string } };
  };
  return body.data.item.id;
}

async function upsertAgentSession(
  token: string,
  runtimeId: string,
  runtimeSessionId: string
): Promise<string> {
  const response = await authedEvidenceRequest(token, '/agent-sessions', {
    method: 'POST',
    body: JSON.stringify({
      runtimeId,
      runtimeSessionId,
      cwd: '/tmp/project',
      status: 'running',
      title: `${runtimeId} session`,
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as {
    data: { agentSession: { id: string } };
  };
  return body.data.agentSession.id;
}

describe('Work item evidence routes', () => {
  beforeEach(() => {
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
  });

  test('encodes agent session IDs globally and validator-compatibly', async () => {
    const codexId = encodeAgentSessionId('codex', 'same-runtime-session');
    const claudeId = encodeAgentSessionId('claude-code', 'same-runtime-session');

    expect(codexId).not.toBe(claudeId);
    expect(isValidSessionId(codexId)).toBe(true);
    expect(isValidSessionId(claudeId)).toBe(true);

    const { token } = await setupUser('evidence-agent-id-user', 'password123');
    const savedCodexId = await upsertAgentSession(token, 'codex', 'same-runtime-session');
    const savedClaudeId = await upsertAgentSession(token, 'claude-code', 'same-runtime-session');

    expect(savedCodexId).toBe(codexId);
    expect(savedClaudeId).toBe(claudeId);
  });

  test('separates accepted user links from pending heuristic links', async () => {
    const { token } = await setupUser('evidence-link-user', 'password123');
    const workItemId = await captureTestWorkItem(token, 'Trace a runtime session');
    const userSessionId = await upsertAgentSession(token, 'codex', 'user-link-session');
    const heuristicSessionId = await upsertAgentSession(token, 'claude-code', 'heuristic-link-session');

    const userLinkResponse = await authedEvidenceRequest(token, `/${workItemId}/session-links`, {
      method: 'POST',
      body: JSON.stringify({ agentSessionId: userSessionId, linkSource: 'user' }),
    });
    expect(userLinkResponse.status).toBe(201);
    const userLinkBody = await userLinkResponse.json() as {
      data: { link: { linkSource: string; acceptanceStatus: string; acceptedAt?: string } };
    };
    expect(userLinkBody.data.link).toMatchObject({
      linkSource: 'user',
      acceptanceStatus: 'accepted',
    });
    expect(userLinkBody.data.link.acceptedAt).toBeDefined();

    const heuristicLinkResponse = await authedEvidenceRequest(token, `/${workItemId}/session-links`, {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId: heuristicSessionId,
        linkSource: 'heuristic_suggestion',
      }),
    });
    expect(heuristicLinkResponse.status).toBe(201);
    const heuristicLinkBody = await heuristicLinkResponse.json() as {
      data: { link: { id: string; linkSource: string; acceptanceStatus: string; acceptedAt?: string } };
    };
    expect(heuristicLinkBody.data.link).toMatchObject({
      linkSource: 'heuristic_suggestion',
      acceptanceStatus: 'pending',
    });
    expect(heuristicLinkBody.data.link.acceptedAt).toBeUndefined();

    const duplicateHeuristicResponse = await authedEvidenceRequest(token, `/${workItemId}/session-links`, {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId: heuristicSessionId,
        linkSource: 'heuristic_suggestion',
      }),
    });
    expect(duplicateHeuristicResponse.status).toBe(201);
    const duplicateHeuristicBody = await duplicateHeuristicResponse.json() as {
      data: { link: { id: string; acceptanceStatus: string; acceptedAt?: string } };
    };
    expect(duplicateHeuristicBody.data.link).toMatchObject({
      id: heuristicLinkBody.data.link.id,
      acceptanceStatus: 'pending',
    });
    expect(duplicateHeuristicBody.data.link.acceptedAt).toBeUndefined();

    const rejectedDirectAccept = await authedEvidenceRequest(token, `/${workItemId}/session-links`, {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId: heuristicSessionId,
        linkSource: 'accepted_agent_suggestion',
      }),
    });
    expect(rejectedDirectAccept.status).toBe(400);

    const promotedUserLinkResponse = await authedEvidenceRequest(token, `/${workItemId}/session-links`, {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId: heuristicSessionId,
        linkSource: 'user',
      }),
    });
    expect(promotedUserLinkResponse.status).toBe(201);
    const promotedUserLinkBody = await promotedUserLinkResponse.json() as {
      data: { link: { id: string; linkSource: string; acceptanceStatus: string; acceptedAt?: string } };
    };
    expect(promotedUserLinkBody.data.link).toMatchObject({
      id: heuristicLinkBody.data.link.id,
      linkSource: 'user',
      acceptanceStatus: 'accepted',
    });
    expect(promotedUserLinkBody.data.link.acceptedAt).toBeDefined();

    const rejectedSessionId = await upsertAgentSession(token, 'claude-code', 'rejected-link-session');
    const rejectedLinkResponse = await authedEvidenceRequest(token, `/${workItemId}/session-links`, {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId: rejectedSessionId,
        linkSource: 'heuristic_suggestion',
      }),
    });
    const rejectedLinkBody = await rejectedLinkResponse.json() as { data: { link: { id: string } } };
    const rejectedResponse = await authedEvidenceRequest(
      token,
      `/session-links/${rejectedLinkBody.data.link.id}/reject`,
      { method: 'POST' }
    );
    expect(rejectedResponse.status).toBe(200);
    const rejectedBody = await rejectedResponse.json() as {
      data: { link: { acceptanceStatus: string; acceptedAt?: string } };
    };
    expect(rejectedBody.data.link.acceptanceStatus).toBe('rejected');
    expect(rejectedBody.data.link.acceptedAt).toBeUndefined();

    const pendingSessionId = await upsertAgentSession(token, 'codex', 'pending-link-session');
    const pendingLinkResponse = await authedEvidenceRequest(token, `/${workItemId}/session-links`, {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId: pendingSessionId,
        linkSource: 'heuristic_suggestion',
      }),
    });
    expect(pendingLinkResponse.status).toBe(201);
    const pendingLinkBody = await pendingLinkResponse.json() as {
      data: { link: { id: string } };
    };

    const acceptedResponse = await authedEvidenceRequest(
      token,
      `/session-links/${pendingLinkBody.data.link.id}/accept`,
      { method: 'POST' }
    );
    expect(acceptedResponse.status).toBe(200);
    const acceptedBody = await acceptedResponse.json() as {
      data: { link: { linkSource: string; acceptanceStatus: string; acceptedAt?: string } };
    };
    expect(acceptedBody.data.link).toMatchObject({
      linkSource: 'accepted_agent_suggestion',
      acceptanceStatus: 'accepted',
    });
    expect(acceptedBody.data.link.acceptedAt).toBeDefined();
  });

  test('rejects orphan evidence and keeps inferred completion out of WorkItem state', async () => {
    const { token } = await setupUser('evidence-orphan-user', 'password123');
    const orphanResponse = await authedEvidenceRequest(token, '/evidence', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'message',
        summary: 'No anchors',
      }),
    });
    expect(orphanResponse.status).toBe(400);

    const workItemId = await captureTestWorkItem(token, 'Do not silently complete');
    const evidenceResponse = await authedEvidenceRequest(token, '/evidence', {
      method: 'POST',
      body: JSON.stringify({
        workItemId,
        kind: 'message',
        outcome: 'completed',
        confidence: 'inferred',
        summary: 'Agent sounds done, but user did not accept it',
      }),
    });
    expect(evidenceResponse.status).toBe(201);

    const itemResponse = await authedWorkItemsRequest(token, `/${workItemId}`);
    const itemBody = await itemResponse.json() as {
      data: { item: { status: string; statusSource: string; completedAt?: string } };
    };
    expect(itemBody.data.item).toMatchObject({
      status: 'inbox',
      statusSource: 'user',
    });
    expect(itemBody.data.item.completedAt).toBeUndefined();
  });

  test('records all progress evidence kinds against an agent session', async () => {
    const { token } = await setupUser('evidence-kinds-user', 'password123');
    const agentSessionId = await upsertAgentSession(token, 'codex', 'all-evidence-kinds');

    for (const kind of ['message', 'tool_call', 'file_change', 'plan_event', 'test_result']) {
      const response = await authedEvidenceRequest(token, '/evidence', {
        method: 'POST',
        body: JSON.stringify({
          agentSessionId,
          kind,
          outcome: kind === 'test_result' ? 'completed' : 'progress',
          summary: `Recorded ${kind}`,
          metadata: { kind },
        }),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as {
        data: { evidence: { kind: string; agentSessionId: string; metadata: { kind: string } } };
      };
      expect(body.data.evidence).toMatchObject({
        kind,
        agentSessionId,
        metadata: { kind },
      });
    }
  });
});
