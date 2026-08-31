import { Hono } from 'hono';
import type { Context } from 'hono';
import { sessionRepository } from '../../../infrastructure/database/repositories/session.repository.js';
import { workItemEvidenceRepository } from '../../../infrastructure/database/repositories/work-item-evidence.repository.js';
import { workItemRepository } from '../../../infrastructure/database/repositories/work-item.repository.js';
import {
  isProgressEvidenceConfidence,
  isProgressEvidenceKind,
  isProgressEvidenceOutcome,
  isWorkItemSessionLinkSource,
  type AgentSessionUpsertInput,
  type ProgressEvidenceCreateInput,
  type WorkItemSessionLinkCreateInput,
} from '../../../domain/work-item/index.js';
import type { SessionStatus } from '../../../domain/session/index.js';
import type { RuntimeId } from '../../../domain/runtime/index.js';
import { isValidSessionId } from '../../../lib/session-id.js';
import { logger } from '../../../lib/logger.js';
import { runtimeIdForClient } from '../../../services/runtime-status.js';
import { authMiddleware } from '../middleware/auth.js';
import { readJsonObject } from '../../../local-api/http.js';

const app = new Hono();
app.use('*', authMiddleware);

const AGENT_SESSION_STATUSES = [
  'running',
  'waiting',
  'idle',
  'lost',
  'completed',
  'unknown',
] as const;

function serializeDate(date: Date | undefined): string | undefined {
  return date?.toISOString();
}

function serializeAgentSession(session: ReturnType<typeof workItemEvidenceRepository.findAgentSessionById>) {
  if (!session) return undefined;
  return {
    ...session,
    lastActiveAt: session.lastActiveAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function serializeLink(link: ReturnType<typeof workItemEvidenceRepository.findSessionLinkById>) {
  if (!link) return undefined;
  return {
    ...link,
    acceptedAt: serializeDate(link.acceptedAt),
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}

function serializeEvidence(evidence: ReturnType<typeof workItemEvidenceRepository.findEvidenceById>) {
  if (!evidence) return undefined;
  return {
    ...evidence,
    occurredAt: evidence.occurredAt.toISOString(),
    createdAt: evidence.createdAt.toISOString(),
  };
}

function readRequiredString(
  c: Context,
  data: Record<string, unknown>,
  key: string,
  maxLength: number
): { value?: string; response?: Response } {
  const raw = data[key];
  if (typeof raw !== 'string' || !raw.trim()) {
    return { response: c.json({ success: false, error: `${key} is required` }, 400) };
  }
  const value = raw.trim();
  if (value.length > maxLength) {
    return {
      response: c.json({ success: false, error: `${key} must be ${maxLength} characters or fewer` }, 400),
    };
  }
  return { value };
}

function readOptionalString(
  c: Context,
  data: Record<string, unknown>,
  key: string,
  maxLength: number
): { value?: string; response?: Response } {
  const raw = data[key];
  if (raw == null) return {};
  if (typeof raw !== 'string') {
    return { response: c.json({ success: false, error: `${key} must be a string` }, 400) };
  }
  const value = raw.trim();
  if (value.length > maxLength) {
    return {
      response: c.json({ success: false, error: `${key} must be ${maxLength} characters or fewer` }, 400),
    };
  }
  return { value: value || undefined };
}

function isAgentSessionStatus(value: unknown): value is SessionStatus | 'unknown' {
  return typeof value === 'string' &&
    AGENT_SESSION_STATUSES.includes(value as typeof AGENT_SESSION_STATUSES[number]);
}

app.post('/agent-sessions', async (c) => {
  const parsedBody = await readJsonObject(c);
  if (parsedBody.response) return parsedBody.response;
  const data = parsedBody.data!;

  const runtimeId = readRequiredString(c, data, 'runtimeId', 64);
  if (runtimeId.response) return runtimeId.response;
  const runtimeSessionId = readRequiredString(c, data, 'runtimeSessionId', 512);
  if (runtimeSessionId.response) return runtimeSessionId.response;
  const cwd = readRequiredString(c, data, 'cwd', 2048);
  if (cwd.response) return cwd.response;
  const title = readRequiredString(c, data, 'title', 240);
  if (title.response) return title.response;
  const projectRoot = readOptionalString(c, data, 'projectRoot', 2048);
  if (projectRoot.response) return projectRoot.response;
  const evidenceSummary = readOptionalString(c, data, 'evidenceSummary', 1000);
  if (evidenceSummary.response) return evidenceSummary.response;

  if (!isAgentSessionStatus(data.status)) {
    return c.json({ success: false, error: 'Invalid agent session status' }, 400);
  }

  const lastActiveAt = typeof data.lastActiveAt === 'string'
    ? new Date(data.lastActiveAt)
    : new Date();
  if (Number.isNaN(lastActiveAt.getTime())) {
    return c.json({ success: false, error: 'lastActiveAt must be an ISO date' }, 400);
  }

  try {
    const session = workItemEvidenceRepository.upsertAgentSession({
      runtimeId: runtimeId.value! as RuntimeId,
      runtimeSessionId: runtimeSessionId.value!,
      cwd: cwd.value!,
      title: title.value!,
      status: data.status,
      projectRoot: projectRoot.value,
      evidenceSummary: evidenceSummary.value,
      lastActiveAt,
    } satisfies AgentSessionUpsertInput);

    return c.json({
      success: true,
      data: { agentSession: serializeAgentSession(session) },
    }, 201);
  } catch (error) {
    logger.error('Failed to upsert agent session', error);
    return c.json({ success: false, error: 'Failed to save agent session' }, 500);
  }
});

app.post('/:id/session-links', async (c) => {
  const workItemId = c.req.param('id');
  if (!workItemRepository.findById(workItemId)) {
    return c.json({ success: false, error: 'Work item not found' }, 404);
  }

  const parsedBody = await readJsonObject(c);
  if (parsedBody.response) return parsedBody.response;
  const data = parsedBody.data!;
  let agentSessionId: string | undefined;
  if (typeof data.sessionId === 'string' && data.sessionId.trim()) {
    const sessionId = data.sessionId.trim();
    if (!isValidSessionId(sessionId)) {
      return c.json({ success: false, error: 'Invalid sessionId format' }, 400);
    }
    const runtimeSession = sessionRepository.findBySessionId(sessionId);
    if (!runtimeSession) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    const saved = workItemEvidenceRepository.upsertAgentSession({
      runtimeId: runtimeIdForClient(runtimeSession.client),
      runtimeSessionId: runtimeSession.sessionId,
      cwd: runtimeSession.directory,
      status: runtimeSession.status,
      title: runtimeSession.title,
      lastActiveAt: runtimeSession.lastActiveAt,
      evidenceSummary: runtimeSession.lastMessage,
    });
    agentSessionId = saved.id;
  } else {
    const parsedAgentSessionId = readRequiredString(c, data, 'agentSessionId', 64);
    if (parsedAgentSessionId.response) return parsedAgentSessionId.response;
    if (!isValidSessionId(parsedAgentSessionId.value!)) {
      return c.json({ success: false, error: 'Invalid agentSessionId format' }, 400);
    }
    if (!workItemEvidenceRepository.findAgentSessionById(parsedAgentSessionId.value!)) {
      return c.json({ success: false, error: 'Agent session not found' }, 404);
    }
    agentSessionId = parsedAgentSessionId.value!;
  }

  const rawLinkSource = data.linkSource ?? 'user';
  if (!isWorkItemSessionLinkSource(rawLinkSource)) {
    return c.json({ success: false, error: 'Invalid linkSource' }, 400);
  }
  if (rawLinkSource === 'accepted_agent_suggestion') {
    return c.json({
      success: false,
      error: 'accepted_agent_suggestion links must be created by accepting a pending link',
    }, 400);
  }

  try {
    const link = workItemEvidenceRepository.createSessionLink({
      workItemId,
      agentSessionId,
      linkSource: rawLinkSource,
    } satisfies WorkItemSessionLinkCreateInput);

    return c.json({ success: true, data: { link: serializeLink(link) } }, 201);
  } catch (error) {
    logger.error('Failed to create work item session link', error);
    return c.json({ success: false, error: 'Failed to create work item session link' }, 500);
  }
});

app.post('/session-links/:id/accept', (c) => {
  const link = workItemEvidenceRepository.acceptSessionLink(c.req.param('id'));
  if (!link) {
    return c.json({ success: false, error: 'Work item session link not found' }, 404);
  }
  return c.json({ success: true, data: { link: serializeLink(link) } });
});

app.post('/session-links/:id/reject', (c) => {
  const link = workItemEvidenceRepository.rejectSessionLink(c.req.param('id'));
  if (!link) {
    return c.json({ success: false, error: 'Work item session link not found' }, 404);
  }
  return c.json({ success: true, data: { link: serializeLink(link) } });
});

app.post('/evidence', async (c) => {
  const parsedBody = await readJsonObject(c);
  if (parsedBody.response) return parsedBody.response;
  const data = parsedBody.data!;

  const summary = readRequiredString(c, data, 'summary', 1000);
  if (summary.response) return summary.response;
  const sourcePath = readOptionalString(c, data, 'sourcePath', 2048);
  if (sourcePath.response) return sourcePath.response;
  const runtimeId = readOptionalString(c, data, 'runtimeId', 64);
  if (runtimeId.response) return runtimeId.response;

  if (!isProgressEvidenceKind(data.kind)) {
    return c.json({ success: false, error: 'Invalid evidence kind' }, 400);
  }
  if (data.outcome != null && !isProgressEvidenceOutcome(data.outcome)) {
    return c.json({ success: false, error: 'Invalid evidence outcome' }, 400);
  }
  if (data.confidence != null && !isProgressEvidenceConfidence(data.confidence)) {
    return c.json({ success: false, error: 'Invalid evidence confidence' }, 400);
  }

  const workItemId = typeof data.workItemId === 'string' && data.workItemId.trim()
    ? data.workItemId.trim()
    : undefined;
  const agentSessionId = typeof data.agentSessionId === 'string' && data.agentSessionId.trim()
    ? data.agentSessionId.trim()
    : undefined;

  if (!workItemId && !agentSessionId) {
    return c.json({
      success: false,
      error: 'Progress evidence requires workItemId or agentSessionId',
    }, 400);
  }
  if (workItemId && !workItemRepository.findById(workItemId)) {
    return c.json({ success: false, error: 'Work item not found' }, 404);
  }
  if (agentSessionId && !workItemEvidenceRepository.findAgentSessionById(agentSessionId)) {
    return c.json({ success: false, error: 'Agent session not found' }, 404);
  }

  const occurredAt = typeof data.occurredAt === 'string'
    ? new Date(data.occurredAt)
    : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    return c.json({ success: false, error: 'occurredAt must be an ISO date' }, 400);
  }

  if (data.metadata != null && (typeof data.metadata !== 'object' || Array.isArray(data.metadata))) {
    return c.json({ success: false, error: 'metadata must be an object' }, 400);
  }

  const outcome = data.outcome ?? undefined;
  const confidence = data.confidence ?? 'explicit';

  try {
    const evidence = workItemEvidenceRepository.createProgressEvidence({
      workItemId,
      agentSessionId,
      runtimeId: runtimeId.value as RuntimeId | undefined,
      kind: data.kind,
      outcome,
      summary: summary.value!,
      sourcePath: sourcePath.value,
      occurredAt,
      confidence,
      metadata: data.metadata as Record<string, unknown> | undefined,
    } satisfies ProgressEvidenceCreateInput);

    return c.json({ success: true, data: { evidence: serializeEvidence(evidence) } }, 201);
  } catch (error) {
    logger.error('Failed to create progress evidence', error);
    return c.json({ success: false, error: 'Failed to create progress evidence' }, 500);
  }
});

export default app;
