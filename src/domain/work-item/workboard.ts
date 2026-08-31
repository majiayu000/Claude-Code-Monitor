import type {
  AgentSession,
  CompletionReview,
  ProgressEvidence,
  WorkboardAgentSessionSummary,
  WorkboardBucketId,
  WorkboardItemProjection,
  WorkboardProjection,
  WorkItem,
  WorkItemSessionLink,
} from './types.js';

export const DEFAULT_WORKBOARD_STALE_WINDOW_HOURS = 72;

export interface BuildWorkboardProjectionInput {
  items: WorkItem[];
  links: WorkItemSessionLink[];
  agentSessions: AgentSession[];
  evidence: ProgressEvidence[];
  reviews?: CompletionReview[];
  now?: Date;
  staleWindowHours?: number;
}

interface WorkboardEvaluation {
  projection: WorkboardItemProjection;
  bucket?: WorkboardBucketId;
}

export function buildWorkboardProjection(
  input: BuildWorkboardProjectionInput
): WorkboardProjection {
  const now = input.now ?? new Date();
  const staleWindowHours = input.staleWindowHours ?? DEFAULT_WORKBOARD_STALE_WINDOW_HOURS;
  const staleCutoffMs = now.getTime() - staleWindowHours * 60 * 60 * 1000;
  const sessionsById = new Map(input.agentSessions.map((session) => [session.id, session]));
  const linksByWorkItemId = groupBy(input.links, (link) => link.workItemId);
  const evidenceById = new Map(input.evidence.map((record) => [record.id, record]));
  const allEvidence = [...evidenceById.values()];

  const projection: WorkboardProjection = {
    now: [],
    waiting: [],
    stale: [],
    done: [],
    suggestions: [],
    staleWindowHours,
    generatedAt: now,
  };

  for (const item of input.items) {
    if (item.status === 'archived') continue;

    const evaluated = evaluateWorkItem({
      item,
      links: linksByWorkItemId.get(item.id) ?? [],
      sessionsById,
      evidence: allEvidence,
      reviews: input.reviews ?? [],
      staleCutoffMs,
    });

    if (evaluated.bucket) {
      projection[evaluated.bucket].push({
        ...evaluated.projection,
        bucket: evaluated.bucket,
      });
      continue;
    }

    if (evaluated.projection.suggestions.length > 0) {
      projection.suggestions.push(evaluated.projection);
    }
  }

  for (const bucket of ['now', 'waiting', 'stale', 'done', 'suggestions'] as const) {
    projection[bucket].sort(compareProjectionItems);
  }

  return projection;
}

function evaluateWorkItem(input: {
  item: WorkItem;
  links: WorkItemSessionLink[];
  sessionsById: Map<string, AgentSession>;
  evidence: ProgressEvidence[];
  reviews: CompletionReview[];
  staleCutoffMs: number;
}): WorkboardEvaluation {
  const acceptedLinks = input.links.filter((link) => link.acceptanceStatus === 'accepted');
  const pendingLinks = input.links.filter((link) => link.acceptanceStatus === 'pending');
  const acceptedSessions = acceptedLinks
    .map((link) => input.sessionsById.get(link.agentSessionId))
    .filter((session): session is AgentSession => !!session);
  const acceptedSessionIds = new Set(acceptedSessions.map((session) => session.id));
  const relevantEvidence = input.evidence.filter((record) =>
    isEvidenceRelevantToItem(record, input.item.id, acceptedSessionIds)
  );
  const progressEvidence = [...relevantEvidence].sort(compareEvidenceByRecency)[0];
  const reviewedEvidenceIds = new Set(
    input.reviews
      .filter((review) => review.workItemId === input.item.id)
      .map((review) => review.evidenceId)
  );
  const completionEvidence = [...relevantEvidence]
    .filter((record) =>
      record.outcome === 'completed' &&
      record.confidence === 'explicit' &&
      !reviewedEvidenceIds.has(record.id)
    )
    .sort(compareEvidenceByRecency)[0];
  const activityDates = [
    ...acceptedSessions.map((session) => session.lastActiveAt),
    ...relevantEvidence.map((record) => record.occurredAt),
  ];
  const lastActivityAt = maxDate(activityDates);
  const mostRecentSession = [...acceptedSessions].sort(compareSessionsByRecency)[0];
  const suggestions = pendingLinks
    .map((link) => {
      const session = input.sessionsById.get(link.agentSessionId);
      if (!session) return undefined;
      return {
        linkId: link.id,
        agentSession: summarizeSession(session),
        suggestedAt: link.createdAt,
      };
    })
    .filter((suggestion): suggestion is NonNullable<typeof suggestion> => !!suggestion)
    .sort((a, b) => b.suggestedAt.getTime() - a.suggestedAt.getTime());

  const projection: WorkboardItemProjection = {
    item: input.item,
    progressSummary: progressEvidence?.summary,
    lastActivityAt,
    acceptedSessions: acceptedSessions.map(summarizeSession).sort(compareSessionSummaries),
    suggestions,
    completionSuggestion: completionEvidence ? {
      evidenceId: completionEvidence.id,
      summary: completionEvidence.summary,
      occurredAt: completionEvidence.occurredAt,
    } : undefined,
  };

  if (input.item.status === 'done') {
    return { projection, bucket: 'done' };
  }

  if (input.item.status === 'blocked') {
    return { projection, bucket: 'waiting' };
  }

  if (mostRecentSession?.status === 'waiting' &&
    !hasNewerExplicitCompletion(input.item.id, mostRecentSession.id, mostRecentSession.lastActiveAt, input.evidence)) {
    return {
      projection: {
        ...projection,
        waitingOnSession: summarizeSession(mostRecentSession),
      },
      bucket: 'waiting',
    };
  }

  const canBeStale = input.item.status === 'planned' || input.item.status === 'active';
  if (canBeStale && activityDates.length > 0 &&
    activityDates.every((date) => date.getTime() < input.staleCutoffMs)) {
    return { projection, bucket: 'stale' };
  }

  if (input.item.status === 'active' ||
    (input.item.status === 'planned' && acceptedSessions.some((session) => session.status === 'running'))) {
    return { projection, bucket: 'now' };
  }

  return { projection };
}

function isEvidenceRelevantToItem(
  record: ProgressEvidence,
  workItemId: string,
  acceptedSessionIds: Set<string>
): boolean {
  if (record.workItemId && record.workItemId !== workItemId) return false;
  if (record.agentSessionId && !acceptedSessionIds.has(record.agentSessionId)) return false;
  return record.workItemId === workItemId ||
    (!!record.agentSessionId && acceptedSessionIds.has(record.agentSessionId));
}

function hasNewerExplicitCompletion(
  workItemId: string,
  agentSessionId: string,
  lastActiveAt: Date,
  evidence: ProgressEvidence[]
): boolean {
  return evidence.some((record) => {
    if (record.outcome !== 'completed' || record.confidence !== 'explicit') return false;
    if (record.occurredAt.getTime() <= lastActiveAt.getTime()) return false;
    if (record.workItemId && record.workItemId !== workItemId) return false;
    if (record.agentSessionId && record.agentSessionId !== agentSessionId) return false;
    return record.workItemId === workItemId || record.agentSessionId === agentSessionId;
  });
}

function summarizeSession(session: AgentSession): WorkboardAgentSessionSummary {
  return {
    id: session.id,
    runtimeId: session.runtimeId,
    title: session.title,
    status: session.status,
    lastActiveAt: session.lastActiveAt,
  };
}

function maxDate(dates: Date[]): Date | undefined {
  if (dates.length === 0) return undefined;
  return dates.reduce((latest, date) =>
    date.getTime() > latest.getTime() ? date : latest
  );
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const list = grouped.get(key) ?? [];
    list.push(value);
    grouped.set(key, list);
  }
  return grouped;
}

function compareProjectionItems(a: WorkboardItemProjection, b: WorkboardItemProjection): number {
  const aTime = a.lastActivityAt?.getTime() ?? a.item.completedAt?.getTime() ?? a.item.updatedAt.getTime();
  const bTime = b.lastActivityAt?.getTime() ?? b.item.completedAt?.getTime() ?? b.item.updatedAt.getTime();
  if (aTime !== bTime) return bTime - aTime;
  const titleComparison = a.item.title.localeCompare(b.item.title);
  return titleComparison || a.item.id.localeCompare(b.item.id);
}

function compareEvidenceByRecency(a: ProgressEvidence, b: ProgressEvidence): number {
  const timeComparison = b.occurredAt.getTime() - a.occurredAt.getTime();
  return timeComparison || a.id.localeCompare(b.id);
}

function compareSessionsByRecency(a: AgentSession, b: AgentSession): number {
  const timeComparison = b.lastActiveAt.getTime() - a.lastActiveAt.getTime();
  return timeComparison || a.id.localeCompare(b.id);
}

function compareSessionSummaries(
  a: WorkboardAgentSessionSummary,
  b: WorkboardAgentSessionSummary
): number {
  const timeComparison = b.lastActiveAt.getTime() - a.lastActiveAt.getTime();
  return timeComparison || a.id.localeCompare(b.id);
}
