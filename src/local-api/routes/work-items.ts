import { Hono } from 'hono';
import {
  buildWorkboardProjection,
  DEFAULT_WORKBOARD_STALE_WINDOW_HOURS,
  isWorkItemKind,
  isWorkItemStatus,
  type CompletionReviewDecision,
  type WorkItem,
} from '../../domain/work-item/index.js';
import { taskDispatchRepository } from '../../infrastructure/database/repositories/task-dispatch.repository.js';
import { workItemEvidenceRepository } from '../../infrastructure/database/repositories/work-item-evidence.repository.js';
import { workItemRepository } from '../../infrastructure/database/repositories/work-item.repository.js';
import { authMiddleware } from '../../web/api/middleware/auth.js';
import { readJsonObject, readOptionalString, readRequiredString } from '../http.js';

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

app.get('/', (c) => {
  const includeArchived = c.req.query('includeArchived') === 'true';
  const items = workItemRepository.findAll({ includeArchived });
  const data = workItemEvidenceRepository.findProjectionDataForWorkItems(items.map((item) => item.id));
  const reviews = taskDispatchRepository.findCompletionReviewsForWorkItems(items.map((item) => item.id));
  const workboard = buildWorkboardProjection({
    items,
    ...data,
    reviews,
    staleWindowHours: DEFAULT_WORKBOARD_STALE_WINDOW_HOURS,
  });
  const serializeProjection = (entry: (typeof workboard.now)[number]) => ({
    ...entry,
    item: serializeWorkItem(entry.item),
    lastActivityAt: entry.lastActivityAt?.toISOString(),
    waitingOnSession: entry.waitingOnSession ? {
      ...entry.waitingOnSession,
      lastActiveAt: entry.waitingOnSession.lastActiveAt.toISOString(),
    } : undefined,
    acceptedSessions: entry.acceptedSessions.map((session) => ({
      ...session,
      lastActiveAt: session.lastActiveAt.toISOString(),
    })),
    suggestions: entry.suggestions.map((suggestion) => ({
      ...suggestion,
      suggestedAt: suggestion.suggestedAt.toISOString(),
      agentSession: {
        ...suggestion.agentSession,
        lastActiveAt: suggestion.agentSession.lastActiveAt.toISOString(),
      },
    })),
    completionSuggestion: entry.completionSuggestion ? {
      ...entry.completionSuggestion,
      occurredAt: entry.completionSuggestion.occurredAt.toISOString(),
    } : undefined,
  });
  return c.json({
    success: true,
    data: {
      items: items.map(serializeWorkItem),
      stats: workItemRepository.getOverviewStats(),
      workboard: {
        now: workboard.now.map(serializeProjection),
        waiting: workboard.waiting.map(serializeProjection),
        stale: workboard.stale.map(serializeProjection),
        done: workboard.done.map(serializeProjection),
        suggestions: workboard.suggestions.map(serializeProjection),
        staleWindowHours: workboard.staleWindowHours,
        generatedAt: workboard.generatedAt.toISOString(),
      },
    },
  });
});

app.put('/external/:source/:externalId', async (c) => {
  const source = c.req.param('source').trim();
  const externalId = c.req.param('externalId').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(source) || !externalId || externalId.length > 200) {
    return c.json({ success: false, error: 'Invalid external work item identity' }, 400);
  }
  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const data = parsed.data!;
  const title = readRequiredString(c, data, 'title', 200);
  if (title.response) return title.response;
  const body = readOptionalString(c, data, 'body', 10_000);
  if (body.response) return body.response;
  const projectRoot = readOptionalString(c, data, 'projectRoot', 2_048);
  if (projectRoot.response) return projectRoot.response;
  const kind = data.kind ?? 'todo';
  const status = data.status ?? 'planned';
  if (!isWorkItemKind(kind)) return c.json({ success: false, error: 'Invalid work item kind' }, 400);
  if (!isWorkItemStatus(status)) return c.json({ success: false, error: 'Invalid work item status' }, 400);

  const existing = workItemRepository.findByExternalIdentity(source, externalId);
  const item = existing
    ? workItemRepository.update(existing.id, {
        title: title.value!,
        body: body.value ?? null,
        projectRoot: projectRoot.value ?? null,
        kind,
        status,
        statusSource: 'user',
      })!
    : workItemRepository.create({
        title: title.value!,
        body: body.value,
        projectRoot: projectRoot.value,
        kind,
        status,
        statusSource: 'user',
        externalSource: source,
        externalId,
      });
  return c.json({ success: true, data: { item: serializeWorkItem(item) } }, existing ? 200 : 201);
});

app.post('/:id/completion-review', async (c) => {
  const item = workItemRepository.findById(c.req.param('id'));
  if (!item) return c.json({ success: false, error: 'Work item not found' }, 404);
  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const evidenceId = readRequiredString(c, parsed.data!, 'evidenceId', 64);
  if (evidenceId.response) return evidenceId.response;
  const decision = parsed.data!.decision;
  if (decision !== 'accepted' && decision !== 'rejected') {
    return c.json({ success: false, error: 'decision must be accepted or rejected' }, 400);
  }
  const evidence = workItemEvidenceRepository.findEvidenceById(evidenceId.value!);
  const projection = evidence
    ? workItemEvidenceRepository.findProjectionDataForWorkItems([item.id])
    : undefined;
  const linked = !!evidence?.agentSessionId && !evidence.workItemId &&
    projection?.links.some((link) =>
      link.workItemId === item.id &&
      link.agentSessionId === evidence.agentSessionId &&
      link.acceptanceStatus === 'accepted'
    );
  if (!evidence || (evidence.workItemId !== item.id && !linked)) {
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
  // Stash owns the task status. Review records a decision; its next external upsert syncs truth.
  const updated = decision === 'accepted' && item.externalSource !== 'stash'
    ? workItemRepository.update(item.id, {
        status: 'done',
        statusSource: 'accepted_agent_suggestion',
      })!
    : item;
  return c.json({
    success: true,
    data: {
      review: {
        ...review,
        createdAt: review.createdAt.toISOString(),
        updatedAt: review.updatedAt.toISOString(),
      },
      item: serializeWorkItem(updated),
    },
  });
});

export default app;
