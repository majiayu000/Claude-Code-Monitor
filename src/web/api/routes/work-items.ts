import { Hono } from 'hono';
import { taskDispatchRepository } from '../../../infrastructure/database/repositories/task-dispatch.repository.js';
import { workItemEvidenceRepository } from '../../../infrastructure/database/repositories/work-item-evidence.repository.js';
import { workItemRepository } from '../../../infrastructure/database/repositories/work-item.repository.js';
import {
  DEFAULT_WORKBOARD_STALE_WINDOW_HOURS,
  buildWorkboardProjection,
  isWorkItemKind,
  isWorkItemStatus,
  isWorkItemStatusSource,
  type WorkboardItemProjection,
  type WorkboardProjection,
  type WorkItem,
  type WorkItemCreateInput,
  type WorkItemFilters,
  type WorkItemKind,
  type WorkItemStatus,
  type WorkItemStatusSource,
  type WorkItemUpdateInput,
  type CompletionReviewDecision,
} from '../../../domain/work-item/index.js';
import { logger } from '../../../lib/logger.js';
import { authMiddleware } from '../middleware/auth.js';
import { readJsonObject } from '../../../local-api/http.js';

const app = new Hono();
app.use('*', authMiddleware);

function serializeWorkItem(item: WorkItem) {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    completedAt: item.completedAt?.toISOString(),
  };
}

function serializeWorkboardProjection(projection: WorkboardProjection) {
  return {
    now: projection.now.map(serializeWorkboardItem),
    waiting: projection.waiting.map(serializeWorkboardItem),
    stale: projection.stale.map(serializeWorkboardItem),
    done: projection.done.map(serializeWorkboardItem),
    suggestions: projection.suggestions.map(serializeWorkboardItem),
    staleWindowHours: projection.staleWindowHours,
    generatedAt: projection.generatedAt.toISOString(),
  };
}

function serializeWorkboardItem(projection: WorkboardItemProjection) {
  return {
    ...projection,
    item: serializeWorkItem(projection.item),
    lastActivityAt: projection.lastActivityAt?.toISOString(),
    waitingOnSession: projection.waitingOnSession
      ? serializeWorkboardSession(projection.waitingOnSession)
      : undefined,
    acceptedSessions: projection.acceptedSessions.map(serializeWorkboardSession),
    suggestions: projection.suggestions.map((suggestion) => ({
      ...suggestion,
      agentSession: serializeWorkboardSession(suggestion.agentSession),
      suggestedAt: suggestion.suggestedAt.toISOString(),
    })),
    completionSuggestion: projection.completionSuggestion ? {
      ...projection.completionSuggestion,
      occurredAt: projection.completionSuggestion.occurredAt.toISOString(),
    } : undefined,
  };
}

function serializeWorkboardSession(session: WorkboardItemProjection['acceptedSessions'][number]) {
  return {
    ...session,
    lastActiveAt: session.lastActiveAt.toISOString(),
  };
}

function readString(
  data: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxLength?: number } = {}
): { value?: string; error?: string } {
  const raw = data[key];
  if (raw == null) {
    return options.required ? { error: `${key} is required` } : {};
  }
  if (typeof raw !== 'string') {
    return { error: `${key} must be a string` };
  }
  const value = raw.trim();
  if (options.required && !value) {
    return { error: `${key} is required` };
  }
  if (options.maxLength && value.length > options.maxLength) {
    return { error: `${key} must be ${options.maxLength} characters or fewer` };
  }
  return { value: value || undefined };
}

function parseKind(value: unknown, fallback?: WorkItemKind): { value?: WorkItemKind; error?: string } {
  if (value == null) return { value: fallback };
  return isWorkItemKind(value)
    ? { value }
    : { error: `Invalid work item kind: ${String(value)}` };
}

function parseStatus(value: unknown, fallback?: WorkItemStatus): {
  value?: WorkItemStatus;
  error?: string;
} {
  if (value == null) return { value: fallback };
  return isWorkItemStatus(value)
    ? { value }
    : { error: `Invalid work item status: ${String(value)}` };
}

function parseStatusSource(value: unknown, fallback?: WorkItemStatusSource): {
  value?: WorkItemStatusSource;
  error?: string;
} {
  if (value == null) return { value: fallback };
  if (!isWorkItemStatusSource(value)) {
    return { error: 'statusSource must be user' };
  }
  if (value !== 'user') {
    return {
      error: 'accepted_agent_suggestion requires an explicit suggestion acceptance endpoint',
    };
  }
  return { value };
}

function parseStaleWindowHours(raw: string | undefined): { value?: number; error?: string } {
  if (raw == null || raw.trim() === '') {
    return { value: DEFAULT_WORKBOARD_STALE_WINDOW_HOURS };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 24 * 365) {
    return { error: 'staleWindowHours must be between 0 and 8760' };
  }

  return { value: parsed };
}

app.get('/', (c) => {
  try {
    const filters: WorkItemFilters = {};
    const statuses = c.req.queries('status') ?? [];
    if (statuses.length > 0) {
      const parsed: WorkItemStatus[] = [];
      for (const status of statuses) {
        if (!isWorkItemStatus(status)) {
          return c.json({ success: false, error: `Invalid work item status: ${status}` }, 400);
        }
        parsed.push(status);
      }
      filters.status = parsed;
    }

    const kind = c.req.query('kind');
    if (kind) {
      if (!isWorkItemKind(kind)) {
        return c.json({ success: false, error: `Invalid work item kind: ${kind}` }, 400);
      }
      filters.kind = kind;
    }

    const projectRoot = c.req.query('projectRoot');
    if (projectRoot) {
      filters.projectRoot = projectRoot;
    }
    filters.includeArchived = c.req.query('includeArchived') === 'true';
    const staleWindowHours = parseStaleWindowHours(c.req.query('staleWindowHours'));
    if (staleWindowHours.error) {
      return c.json({ success: false, error: staleWindowHours.error }, 400);
    }

    const items = workItemRepository.findAll(filters);
    const evidence = workItemEvidenceRepository.findProjectionDataForWorkItems(
      items.map((item) => item.id)
    );
    const workboard = buildWorkboardProjection({
      items,
      ...evidence,
      reviews: taskDispatchRepository.findCompletionReviewsForWorkItems(
        items.map((item) => item.id)
      ),
      staleWindowHours: staleWindowHours.value,
    });
    return c.json({
      success: true,
      data: {
        items: items.map(serializeWorkItem),
        stats: workItemRepository.getOverviewStats(),
        workboard: serializeWorkboardProjection(workboard),
      },
    });
  } catch (error) {
    logger.error('Failed to list work items', error);
    return c.json({ success: false, error: 'Failed to list work items' }, 500);
  }
});

app.put('/external/:source/:externalId', async (c) => {
  const source = c.req.param('source').trim();
  const externalId = c.req.param('externalId').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(source) || externalId.length === 0 || externalId.length > 200) {
    return c.json({ success: false, error: 'Invalid external work item identity' }, 400);
  }
  const parsedBody = await readJsonObject(c);
  if (parsedBody.response) return parsedBody.response;
  const data = parsedBody.data!;
  const title = readString(data, 'title', { required: true, maxLength: 200 });
  if (title.error) return c.json({ success: false, error: title.error }, 400);
  const body = readString(data, 'body', { maxLength: 10000 });
  if (body.error) return c.json({ success: false, error: body.error }, 400);
  const projectRoot = readString(data, 'projectRoot', { maxLength: 2048 });
  if (projectRoot.error) return c.json({ success: false, error: projectRoot.error }, 400);
  const kind = parseKind(data.kind, 'todo');
  if (kind.error) return c.json({ success: false, error: kind.error }, 400);
  const status = parseStatus(data.status, 'planned');
  if (status.error) return c.json({ success: false, error: status.error }, 400);

  try {
    const existing = workItemRepository.findByExternalIdentity(source, externalId);
    const item = existing
      ? workItemRepository.update(existing.id, {
          title: title.value!,
          body: body.value ?? null,
          projectRoot: projectRoot.value ?? null,
          kind: kind.value,
          status: status.value,
          statusSource: 'user',
        })!
      : workItemRepository.create({
          title: title.value!,
          body: body.value,
          projectRoot: projectRoot.value,
          kind: kind.value,
          status: status.value,
          statusSource: 'user',
          externalSource: source,
          externalId,
        });
    return c.json({ success: true, data: { item: serializeWorkItem(item) } }, existing ? 200 : 201);
  } catch (error) {
    logger.error('Failed to upsert external work item', error);
    return c.json({ success: false, error: 'Failed to upsert external work item' }, 500);
  }
});

app.post('/:id/completion-review', async (c) => {
  const item = workItemRepository.findById(c.req.param('id'));
  if (!item) return c.json({ success: false, error: 'Work item not found' }, 404);
  const parsedBody = await readJsonObject(c);
  if (parsedBody.response) return parsedBody.response;
  const data = parsedBody.data!;
  const evidenceId = readString(data, 'evidenceId', { required: true, maxLength: 64 });
  if (evidenceId.error) return c.json({ success: false, error: evidenceId.error }, 400);
  const decision = data.decision;
  if (decision !== 'accepted' && decision !== 'rejected') {
    return c.json({ success: false, error: 'decision must be accepted or rejected' }, 400);
  }
  const evidence = workItemEvidenceRepository.findEvidenceById(evidenceId.value!);
  const evidenceProjection = evidence
    ? workItemEvidenceRepository.findProjectionDataForWorkItems([item.id])
    : undefined;
  const belongsThroughAcceptedSession = !!evidence?.agentSessionId &&
    !evidence.workItemId &&
    evidenceProjection?.links.some((link) =>
      link.workItemId === item.id &&
      link.agentSessionId === evidence.agentSessionId &&
      link.acceptanceStatus === 'accepted'
    );
  if (!evidence || (evidence.workItemId !== item.id && !belongsThroughAcceptedSession)) {
    return c.json({ success: false, error: 'Completion evidence not found for work item' }, 404);
  }
  if (evidence.outcome !== 'completed' || evidence.confidence !== 'explicit') {
    return c.json({ success: false, error: 'Evidence is not an explicit completion signal' }, 400);
  }
  const review = taskDispatchRepository.saveCompletionReview(
    item.id,
    evidence.id,
    decision as CompletionReviewDecision
  );
  const updatedItem = decision === 'accepted' && item.externalSource !== 'stash'
    ? workItemRepository.update(item.id, {
        status: 'done',
        statusSource: 'accepted_agent_suggestion',
      })!
    : item;
  return c.json({
    success: true,
    data: {
      review: { ...review, createdAt: review.createdAt.toISOString(), updatedAt: review.updatedAt.toISOString() },
      item: serializeWorkItem(updatedItem),
    },
  });
});

app.get('/:id', (c) => {
  try {
    const item = workItemRepository.findById(c.req.param('id'));
    if (!item) {
      return c.json({ success: false, error: 'Work item not found' }, 404);
    }
    return c.json({ success: true, data: { item: serializeWorkItem(item) } });
  } catch (error) {
    logger.error('Failed to get work item', error);
    return c.json({ success: false, error: 'Failed to get work item' }, 500);
  }
});

app.post('/', async (c) => {
  const parsedBody = await readJsonObject(c);
  if (parsedBody.response) return parsedBody.response;
  const data = parsedBody.data!;

  const title = readString(data, 'title', { required: true, maxLength: 200 });
  if (title.error) return c.json({ success: false, error: title.error }, 400);
  const body = readString(data, 'body', { maxLength: 10000 });
  if (body.error) return c.json({ success: false, error: body.error }, 400);
  const projectRoot = readString(data, 'projectRoot', { maxLength: 2048 });
  if (projectRoot.error) return c.json({ success: false, error: projectRoot.error }, 400);
  const area = readString(data, 'area', { maxLength: 120 });
  if (area.error) return c.json({ success: false, error: area.error }, 400);

  const kind = parseKind(data.kind, 'todo');
  if (kind.error) return c.json({ success: false, error: kind.error }, 400);
  const status = parseStatus(data.status, 'inbox');
  if (status.error) return c.json({ success: false, error: status.error }, 400);
  const statusSource = parseStatusSource(data.statusSource, 'user');
  if (statusSource.error) return c.json({ success: false, error: statusSource.error }, 400);

  try {
    const item = workItemRepository.create({
      title: title.value!,
      body: body.value,
      projectRoot: projectRoot.value,
      area: area.value,
      kind: kind.value,
      status: status.value,
      statusSource: statusSource.value,
    } satisfies WorkItemCreateInput);

    return c.json({ success: true, data: { item: serializeWorkItem(item) } }, 201);
  } catch (error) {
    logger.error('Failed to create work item', error);
    return c.json({ success: false, error: 'Failed to create work item' }, 500);
  }
});

app.patch('/:id', async (c) => {
  const parsedBody = await readJsonObject(c);
  if (parsedBody.response) return parsedBody.response;
  const data = parsedBody.data!;

  const input: WorkItemUpdateInput = {};
  const title = readString(data, 'title', { maxLength: 200 });
  if (title.error) return c.json({ success: false, error: title.error }, 400);
  if ('title' in data) {
    if (!title.value) return c.json({ success: false, error: 'title is required' }, 400);
    input.title = title.value;
  }

  const body = readString(data, 'body', { maxLength: 10000 });
  if (body.error) return c.json({ success: false, error: body.error }, 400);
  if ('body' in data) input.body = body.value ?? null;

  const projectRoot = readString(data, 'projectRoot', { maxLength: 2048 });
  if (projectRoot.error) return c.json({ success: false, error: projectRoot.error }, 400);
  if ('projectRoot' in data) input.projectRoot = projectRoot.value ?? null;

  const area = readString(data, 'area', { maxLength: 120 });
  if (area.error) return c.json({ success: false, error: area.error }, 400);
  if ('area' in data) input.area = area.value ?? null;

  const kind = parseKind(data.kind);
  if (kind.error) return c.json({ success: false, error: kind.error }, 400);
  if (kind.value) input.kind = kind.value;

  const status = parseStatus(data.status);
  if (status.error) return c.json({ success: false, error: status.error }, 400);
  if (status.value) input.status = status.value;

  const statusSource = parseStatusSource(data.statusSource, status.value ? 'user' : undefined);
  if (statusSource.error) return c.json({ success: false, error: statusSource.error }, 400);
  if (statusSource.value) input.statusSource = statusSource.value;

  try {
    const item = workItemRepository.update(c.req.param('id'), input);
    if (!item) {
      return c.json({ success: false, error: 'Work item not found' }, 404);
    }
    return c.json({ success: true, data: { item: serializeWorkItem(item) } });
  } catch (error) {
    logger.error('Failed to update work item', error);
    return c.json({ success: false, error: 'Failed to update work item' }, 500);
  }
});

app.delete('/:id', (c) => {
  try {
    const deleted = workItemRepository.delete(c.req.param('id'));
    if (!deleted) {
      return c.json({ success: false, error: 'Work item not found' }, 404);
    }
    return c.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete work item', error);
    return c.json({ success: false, error: 'Failed to delete work item' }, 500);
  }
});

export default app;
