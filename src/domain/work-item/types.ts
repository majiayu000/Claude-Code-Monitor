import { createHash } from 'crypto';
import type { RuntimeId } from '../runtime/index.js';
import type { SessionStatus } from '../session/index.js';

export const WORK_ITEM_STATUSES = [
  'inbox',
  'planned',
  'active',
  'blocked',
  'done',
  'archived',
] as const;

export const WORK_ITEM_KINDS = [
  'todo',
  'idea',
  'note',
  'project_task',
] as const;

export const WORK_ITEM_STATUS_SOURCES = [
  'user',
  'accepted_agent_suggestion',
] as const;

export const WORK_ITEM_LINK_SOURCES = [
  'user',
  'accepted_agent_suggestion',
  'heuristic_suggestion',
] as const;

export const WORK_ITEM_LINK_ACCEPTANCE_STATUSES = [
  'accepted',
  'pending',
  'rejected',
] as const;

export const PROGRESS_EVIDENCE_KINDS = [
  'message',
  'tool_call',
  'file_change',
  'plan_event',
  'test_result',
] as const;

export const PROGRESS_EVIDENCE_OUTCOMES = [
  'progress',
  'blocked',
  'completed',
  'failed',
] as const;

export const PROGRESS_EVIDENCE_CONFIDENCE = [
  'explicit',
  'inferred',
] as const;

export const WORKBOARD_BUCKETS = [
  'now',
  'waiting',
  'stale',
  'done',
] as const;

export type WorkItemStatus = typeof WORK_ITEM_STATUSES[number];
export type WorkItemKind = typeof WORK_ITEM_KINDS[number];
export type WorkItemStatusSource = typeof WORK_ITEM_STATUS_SOURCES[number];
export type WorkItemSessionLinkSource = typeof WORK_ITEM_LINK_SOURCES[number];
export type WorkItemSessionLinkAcceptanceStatus =
  typeof WORK_ITEM_LINK_ACCEPTANCE_STATUSES[number];
export type ProgressEvidenceKind = typeof PROGRESS_EVIDENCE_KINDS[number];
export type ProgressEvidenceOutcome = typeof PROGRESS_EVIDENCE_OUTCOMES[number];
export type ProgressEvidenceConfidence = typeof PROGRESS_EVIDENCE_CONFIDENCE[number];
export type WorkboardBucketId = typeof WORKBOARD_BUCKETS[number];

export interface Area {
  id: string;
  name: string;
  projectRoot?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkItem {
  id: string;
  kind: WorkItemKind;
  status: WorkItemStatus;
  title: string;
  body?: string;
  projectRoot?: string;
  areaId?: string;
  area?: string;
  statusSource: WorkItemStatusSource;
  externalSource?: string;
  externalId?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface WorkItemCreateInput {
  kind?: WorkItemKind;
  status?: WorkItemStatus;
  title: string;
  body?: string;
  projectRoot?: string;
  area?: string;
  statusSource?: WorkItemStatusSource;
  externalSource?: string;
  externalId?: string;
}

export interface WorkItemUpdateInput {
  kind?: WorkItemKind;
  status?: WorkItemStatus;
  title?: string;
  body?: string | null;
  projectRoot?: string | null;
  area?: string | null;
  statusSource?: WorkItemStatusSource;
}

export interface WorkItemFilters {
  status?: WorkItemStatus[];
  kind?: WorkItemKind;
  projectRoot?: string;
  includeArchived?: boolean;
}

export interface WorkItemOverviewStats {
  total: number;
  inbox: number;
  planned: number;
  active: number;
  blocked: number;
  done: number;
  archived: number;
  todo: number;
  idea: number;
  note: number;
  projectTask: number;
}

export interface AgentSession {
  id: string;
  runtimeId: RuntimeId;
  runtimeSessionId: string;
  projectRoot?: string;
  cwd: string;
  status: SessionStatus | 'unknown';
  title: string;
  lastActiveAt: Date;
  evidenceSummary?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentSessionUpsertInput {
  runtimeId: RuntimeId;
  runtimeSessionId: string;
  projectRoot?: string;
  cwd: string;
  status: SessionStatus | 'unknown';
  title: string;
  lastActiveAt?: Date;
  evidenceSummary?: string;
}

export interface WorkItemSessionLink {
  id: string;
  workItemId: string;
  agentSessionId: string;
  linkSource: WorkItemSessionLinkSource;
  acceptanceStatus: WorkItemSessionLinkAcceptanceStatus;
  acceptedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkItemSessionLinkCreateInput {
  workItemId: string;
  agentSessionId: string;
  linkSource?: WorkItemSessionLinkSource;
}

export interface ProgressEvidence {
  id: string;
  workItemId?: string;
  agentSessionId?: string;
  runtimeId?: RuntimeId;
  kind: ProgressEvidenceKind;
  outcome?: ProgressEvidenceOutcome;
  summary: string;
  sourcePath?: string;
  occurredAt: Date;
  confidence: ProgressEvidenceConfidence;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface ProgressEvidenceCreateInput {
  workItemId?: string;
  agentSessionId?: string;
  runtimeId?: RuntimeId;
  kind: ProgressEvidenceKind;
  outcome?: ProgressEvidenceOutcome;
  summary: string;
  sourcePath?: string;
  occurredAt?: Date;
  confidence?: ProgressEvidenceConfidence;
  metadata?: Record<string, unknown>;
}

export interface WorkboardAgentSessionSummary {
  id: string;
  runtimeId: RuntimeId;
  title: string;
  status: AgentSession['status'];
  lastActiveAt: Date;
}

export interface WorkboardSuggestion {
  linkId: string;
  agentSession: WorkboardAgentSessionSummary;
  suggestedAt: Date;
}

export interface WorkboardItemProjection {
  item: WorkItem;
  bucket?: WorkboardBucketId;
  progressSummary?: string;
  lastActivityAt?: Date;
  waitingOnSession?: WorkboardAgentSessionSummary;
  acceptedSessions: WorkboardAgentSessionSummary[];
  suggestions: WorkboardSuggestion[];
  completionSuggestion?: WorkItemCompletionSuggestion;
}

export type CompletionReviewDecision = 'accepted' | 'rejected';

export interface CompletionReview {
  id: string;
  workItemId: string;
  evidenceId: string;
  decision: CompletionReviewDecision;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkItemCompletionSuggestion {
  evidenceId: string;
  summary: string;
  occurredAt: Date;
}

export const TASK_DISPATCH_STATES = [
  'queued',
  'launching',
  'awaiting_session',
  'linked',
  'ambiguous',
  'failed',
  'cancelled',
] as const;

export type TaskDispatchState = typeof TASK_DISPATCH_STATES[number];

export interface TaskDispatch {
  id: string;
  workItemId: string;
  runtimeId: RuntimeId;
  cwd: string;
  prompt: string;
  terminalApp: 'Terminal' | 'iTerm' | 'Warp' | 'auto';
  idempotencyKey: string;
  state: TaskDispatchState;
  preLaunchSessionIds: string[];
  candidateSessionIds: string[];
  linkedAgentSessionId?: string;
  error?: string;
  launchedAt?: Date;
  correlationDeadlineAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskDispatchCreateInput {
  workItemId: string;
  runtimeId: RuntimeId;
  cwd: string;
  prompt: string;
  terminalApp: TaskDispatch['terminalApp'];
  idempotencyKey: string;
  preLaunchSessionIds: string[];
  correlationDeadlineAt: Date;
}

export interface WorkboardProjection {
  now: WorkboardItemProjection[];
  waiting: WorkboardItemProjection[];
  stale: WorkboardItemProjection[];
  done: WorkboardItemProjection[];
  suggestions: WorkboardItemProjection[];
  staleWindowHours: number;
  generatedAt: Date;
}

export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return typeof value === 'string' && WORK_ITEM_STATUSES.includes(value as WorkItemStatus);
}

export function isWorkItemKind(value: unknown): value is WorkItemKind {
  return typeof value === 'string' && WORK_ITEM_KINDS.includes(value as WorkItemKind);
}

export function isWorkItemStatusSource(value: unknown): value is WorkItemStatusSource {
  return typeof value === 'string' &&
    WORK_ITEM_STATUS_SOURCES.includes(value as WorkItemStatusSource);
}

export function isWorkItemSessionLinkSource(
  value: unknown
): value is WorkItemSessionLinkSource {
  return typeof value === 'string' &&
    WORK_ITEM_LINK_SOURCES.includes(value as WorkItemSessionLinkSource);
}

export function isProgressEvidenceKind(value: unknown): value is ProgressEvidenceKind {
  return typeof value === 'string' &&
    PROGRESS_EVIDENCE_KINDS.includes(value as ProgressEvidenceKind);
}

export function isProgressEvidenceOutcome(value: unknown): value is ProgressEvidenceOutcome {
  return typeof value === 'string' &&
    PROGRESS_EVIDENCE_OUTCOMES.includes(value as ProgressEvidenceOutcome);
}

export function isProgressEvidenceConfidence(
  value: unknown
): value is ProgressEvidenceConfidence {
  return typeof value === 'string' &&
    PROGRESS_EVIDENCE_CONFIDENCE.includes(value as ProgressEvidenceConfidence);
}

export function encodeAgentSessionId(runtimeId: RuntimeId, runtimeSessionId: string): string {
  const safeRuntimeId = String(runtimeId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24) ||
    'runtime';
  const hash = createHash('sha256')
    .update(`${runtimeId}\0${runtimeSessionId}`)
    .digest('hex')
    .slice(0, 32);
  return `${safeRuntimeId}_${hash}`;
}
