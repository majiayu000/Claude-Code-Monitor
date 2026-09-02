import { existsSync } from 'fs';
import type { AgentClient, SessionStatus } from '../domain/session/index.js';
import type { SerializableSessionDigest, SessionDigest } from '../domain/orchestrator/index.js';
import { serializeSessionDigest } from '../domain/orchestrator/index.js';
import type { AggregatedSession } from './session.types.js';
import { resolveProjectIdentity, type ProjectIdentity } from './project.identity.js';

export type AttentionReasonCode =
  | 'waiting_for_human'
  | 'recoverable_lost'
  | 'high_cost'
  | 'stale_activity'
  | 'idle_activity'
  | 'active_session';

export type AttentionSeverity = 'critical' | 'warning' | 'info';

export type RecommendedAction = 'review' | 'recover' | 'monitor' | 'none';

export type AgentBoardLane = 'needs_you' | 'working' | 'finished' | 'paused';

export const AGENT_BOARD_LANE_ORDER: readonly AgentBoardLane[] = [
  'needs_you',
  'working',
  'finished',
  'paused',
];

export interface AttentionReason {
  code: AttentionReasonCode;
  severity: AttentionSeverity;
  message: string;
  score: number;
}

export interface AttentionSessionContext {
  initialPrompt?: string;
  lastMessage?: string;
  lastTool?: string;
  currentFile?: string;
  messageCount: number;
  toolCount: number;
}

export type AttentionIntentConfidence = 'high' | 'medium' | 'low';
export type AttentionIntentTaskSource =
  | 'initial_prompt'
  | 'digest'
  | 'title'
  | 'last_message'
  | 'current_file'
  | 'none';
export type AttentionIntentNoiseFlag =
  | 'instructions_heavy'
  | 'missing_user_goal'
  | 'derived_from_last_message'
  | 'derived_from_file';

export interface AttentionIntent {
  task?: string;
  taskSource: AttentionIntentTaskSource;
  currentState?: string;
  nextAction: string;
  whyAttention: string;
  confidence: AttentionIntentConfidence;
  noiseFlags: AttentionIntentNoiseFlag[];
  evidence: {
    promptExcerpt?: string;
    lastMessage?: string;
    lastTool?: string;
    currentFile?: string;
  };
}

export interface AttentionQueueItem {
  rank: number;
  lane: AgentBoardLane;
  sessionId: string;
  client: AgentClient;
  status: SessionStatus;
  title: string;
  directory: string;
  project: ProjectIdentity;
  lastActiveAt: Date;
  score: number;
  reasons: AttentionReason[];
  recommendedAction: RecommendedAction;
  canRecover: boolean;
  processRunning: boolean;
  pid?: number;
  context: AttentionSessionContext;
  intent: AttentionIntent;
  usageCost?: number;
  digest?: SerializableSessionDigest;
}

export interface AttentionOverviewStats {
  totalCandidates: number;
  needingAttention: number;
  critical: number;
  warning: number;
  hiddenOldLost: number;
  lostWindowHours?: number;
}

export interface AttentionOverview {
  generatedAt: Date;
  items: AttentionQueueItem[];
  stats: AttentionOverviewStats;
}

export interface AttentionOverviewOptions {
  includeCompleted?: boolean;
  limit?: number;
  now?: Date;
  highCostThreshold?: number;
  staleHours?: number;
  includeOldLost?: boolean;
  lostHours?: number;
  digests?: Map<string, SessionDigest>;
  ordering?: 'attention' | 'board';
}

export const DEFAULT_ATTENTION_LIMIT = 20;
export const MAX_ATTENTION_LIMIT = 100;
export const DEFAULT_HIGH_COST_THRESHOLD = 1;
export const DEFAULT_STALE_HOURS = 24;
export const DEFAULT_LOST_HOURS = 1;
export const MAX_ATTENTION_CONTEXT_LENGTH = 700;
export const MAX_ATTENTION_PATH_LENGTH = 260;
export const MAX_ATTENTION_INTENT_LENGTH = 260;

const WAITING_SCORE = 1000;
const LOST_SCORE = 850;
const HIGH_COST_SCORE = 600;
const STALE_SCORE = 350;
const IDLE_SCORE = 150;
const RUNNING_SCORE = 25;

export function buildAttentionOverview(
  sessions: AggregatedSession[],
  options: AttentionOverviewOptions = {}
): AttentionOverview {
  const now = options.now ?? new Date();
  const limit = clampLimit(options.limit);
  const highCostThreshold = options.highCostThreshold ?? DEFAULT_HIGH_COST_THRESHOLD;
  const staleHours = options.staleHours ?? DEFAULT_STALE_HOURS;
  const lostHours = options.includeOldLost ? undefined : options.lostHours ?? DEFAULT_LOST_HOURS;
  const staleCutoffMs = now.getTime() - staleHours * 60 * 60 * 1000;
  const lostCutoffMs = lostHours == null
    ? Number.NEGATIVE_INFINITY
    : now.getTime() - lostHours * 60 * 60 * 1000;
  let hiddenOldLost = 0;
  const candidates = sessions.filter((session) => {
    if (!options.includeCompleted && session.status === 'completed') return false;
    if (session.status === 'lost' && session.lastActiveAt.getTime() < lostCutoffMs) {
      hiddenOldLost += 1;
      return false;
    }
    return true;
  });
  const rankedItems = candidates
    .map((session) => buildAttentionItem(session, {
      highCostThreshold,
      staleCutoffMs,
      digest: options.digests?.get(session.sessionId),
    }))
    .sort(options.ordering === 'board' ? compareBoardItems : compareAttentionItems)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  const items = rankedItems.slice(0, limit);

  return {
    generatedAt: now,
    items,
    stats: {
      totalCandidates: candidates.length,
      needingAttention: rankedItems.filter(hasCriticalOrWarningReason).length,
      critical: rankedItems.filter(hasCriticalReason).length,
      warning: rankedItems.filter(hasWarningReason).length,
      hiddenOldLost,
      lostWindowHours: lostHours,
    },
  };
}

function buildAttentionItem(
  session: AggregatedSession,
  options: {
    highCostThreshold: number;
    staleCutoffMs: number;
    digest?: SessionDigest;
  }
): AttentionQueueItem {
  const reasons: AttentionReason[] = [];

  if (session.status === 'waiting') {
    reasons.push({
      code: 'waiting_for_human',
      severity: 'critical',
      message: 'Waiting for human input',
      score: WAITING_SCORE,
    });
  }

  if (session.status === 'lost') {
    reasons.push({
      code: 'recoverable_lost',
      severity: 'critical',
      message: 'Session is lost and may be recoverable',
      score: LOST_SCORE,
    });
  }

  const usageCost = session.usageStats?.totalCost;
  if (usageCost != null && usageCost >= options.highCostThreshold) {
    const costBonus = Math.min(
      Math.floor((usageCost / Math.max(options.highCostThreshold, 0.01)) * 50),
      200
    );
    reasons.push({
      code: 'high_cost',
      severity: 'warning',
      message: `Session cost is $${usageCost.toFixed(2)}`,
      score: HIGH_COST_SCORE + costBonus,
    });
  }

  const stale = session.lastActiveAt.getTime() < options.staleCutoffMs;
  if ((session.status === 'running' || session.status === 'idle') && stale) {
    reasons.push({
      code: 'stale_activity',
      severity: 'warning',
      message: 'No recent activity',
      score: STALE_SCORE,
    });
  }

  if (session.status === 'idle') {
    reasons.push({
      code: 'idle_activity',
      severity: 'info',
      message: 'Session is idle',
      score: IDLE_SCORE,
    });
  }

  if (session.status === 'running') {
    reasons.push({
      code: 'active_session',
      severity: 'info',
      message: 'Session is running',
      score: RUNNING_SCORE,
    });
  }

  const canRecover = session.status === 'lost' && existsSync(session.directory);

  return {
    rank: 0,
    lane: getAgentBoardLane(session.status),
    sessionId: session.sessionId,
    client: session.client,
    status: session.status,
    title: session.title,
    directory: session.directory,
    project: resolveProjectIdentity(session.directory),
    lastActiveAt: session.lastActiveAt,
    score: getPriorityScore(reasons),
    reasons,
    recommendedAction: getRecommendedAction(reasons, canRecover),
    canRecover,
    processRunning: session.processRunning,
    pid: session.pid,
    context: buildSessionContext(session),
    intent: buildSessionIntent(session, reasons, canRecover, options.digest),
    usageCost,
    digest: options.digest ? serializeSessionDigest(options.digest) : undefined,
  };
}

export function getAgentBoardLane(status: SessionStatus): AgentBoardLane {
  switch (status) {
    case 'waiting':
    case 'lost':
      return 'needs_you';
    case 'running':
      return 'working';
    case 'completed':
      return 'finished';
    case 'idle':
      return 'paused';
  }
}

function getPriorityScore(reasons: AttentionReason[]): number {
  if (reasons.length === 0) return 0;
  return Math.max(...reasons.map((reason) => reason.score));
}

function clampLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_ATTENTION_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_ATTENTION_LIMIT;
  return Math.min(Math.floor(limit), MAX_ATTENTION_LIMIT);
}

function getRecommendedAction(
  reasons: AttentionReason[],
  canRecover: boolean
): RecommendedAction {
  if (reasons.some((reason) => reason.code === 'waiting_for_human')) return 'review';
  if (reasons.some((reason) => reason.code === 'recoverable_lost')) {
    return canRecover ? 'recover' : 'review';
  }
  if (reasons.some((reason) => reason.code === 'high_cost')) return 'review';
  if (reasons.some((reason) => reason.code === 'stale_activity')) return 'review';
  if (reasons.some((reason) => reason.code === 'idle_activity')) return 'monitor';
  if (reasons.some((reason) => reason.code === 'active_session')) return 'monitor';
  return 'none';
}

function buildSessionContext(session: AggregatedSession): AttentionSessionContext {
  return {
    initialPrompt: compactText(session.initialPrompt, MAX_ATTENTION_CONTEXT_LENGTH),
    lastMessage: compactText(session.lastMessage, MAX_ATTENTION_CONTEXT_LENGTH),
    lastTool: compactText(session.lastTool, MAX_ATTENTION_PATH_LENGTH),
    currentFile: compactText(session.currentFile, MAX_ATTENTION_PATH_LENGTH),
    messageCount: session.messageCount,
    toolCount: session.toolCount,
  };
}

function compactText(value: string | undefined, maxLength: number): string | undefined {
  const compacted = value?.trim().replace(/\s+/g, ' ');
  if (!compacted) return undefined;
  if (compacted.length <= maxLength) return compacted;
  return compacted.slice(0, maxLength - 3) + '...';
}

function buildSessionIntent(
  session: AggregatedSession,
  reasons: AttentionReason[],
  canRecover: boolean,
  digest?: SessionDigest
): AttentionIntent {
  const noiseFlags: AttentionIntentNoiseFlag[] = [];
  const promptText = stripImageAttachments(session.initialPrompt);
  const prompt = compactText(promptText, MAX_ATTENTION_CONTEXT_LENGTH);
  const promptIsNoise = isInstructionNoise(promptText);
  const titleIsNoise = isInstructionNoise(session.title);
  const digestIsNoise = isInstructionNoise(digest?.summary);
  if (promptIsNoise || titleIsNoise || digestIsNoise) noiseFlags.push('instructions_heavy');

  const promptTask = promptIsNoise ? undefined : intentText(promptText);
  const digestTask = digestIsNoise ? undefined : intentText(digest?.summary);
  const titleTask = titleIsNoise ? undefined : intentText(session.title);
  const lastMessage = intentText(session.lastMessage);
  const taskMessage = meaningfulTaskMessage(session.lastMessage);
  const fileTask = session.currentFile
    ? `Working around ${formatPathTail(session.currentFile)}`
    : undefined;

  const taskCandidate = firstNonEmptyTask([
    { task: promptTask, source: 'initial_prompt' },
    { task: digestTask, source: 'digest' },
    { task: titleTask, source: 'title' },
  ]);

  let task = taskCandidate?.task;
  let taskSource: AttentionIntentTaskSource = taskCandidate?.source ?? 'none';
  let confidence: AttentionIntentConfidence = task ? 'high' : 'low';

  if (!task && taskMessage) {
    task = deriveTaskFromLastMessage(taskMessage);
    taskSource = task ? 'last_message' : 'none';
    confidence = 'medium';
    noiseFlags.push('derived_from_last_message');
  }

  if (!task && fileTask) {
    task = fileTask;
    taskSource = 'current_file';
    confidence = 'low';
    noiseFlags.push('derived_from_file');
  }

  if (!promptTask && !titleTask) {
    noiseFlags.push('missing_user_goal');
  }

  return {
    task,
    taskSource,
    currentState: firstNonEmpty([lastMessage, digestTask, titleTask]),
    nextAction: buildNextAction(session, reasons, canRecover),
    whyAttention: buildWhyAttention(reasons),
    confidence,
    noiseFlags: dedupeNoiseFlags(noiseFlags),
    evidence: {
      promptExcerpt: prompt,
      lastMessage,
      lastTool: compactText(session.lastTool, MAX_ATTENTION_PATH_LENGTH),
      currentFile: compactText(session.currentFile, MAX_ATTENTION_PATH_LENGTH),
    },
  };
}

function intentText(value: string | undefined): string | undefined {
  return compactText(value, MAX_ATTENTION_INTENT_LENGTH);
}

function isInstructionNoise(value: string | undefined): boolean {
  if (!value) return false;
  const compact = value.trim();
  const lower = compact.toLowerCase();
  const withoutAttachments = stripImageAttachments(compact) ?? '';
  const hasUnclosedImageTag = lower.startsWith('<image ') && !compact.includes('>');
  return lower.includes('agents.md instructions') ||
    lower.startsWith('agents.md') ||
    lower.startsWith('# agents.md') ||
    lower.includes('<instructions>') ||
    lower.includes('vibeguard-start') ||
    lower.includes('vibeguard') ||
    lower.includes('files called agents.md') ||
    hasUnclosedImageTag ||
    withoutAttachments.length === 0;
}

function stripImageAttachments(value: string | undefined): string | undefined {
  const stripped = value?.replace(/<image\b[^>]*>/giu, '').trim();
  return stripped || undefined;
}

function meaningfulTaskMessage(value: string | undefined): string | undefined {
  const text = intentText(value);
  if (!text) return undefined;
  if (!extractTaskPhrase(text)) {
    return undefined;
  }
  return text;
}

function deriveTaskFromLastMessage(lastMessage: string): string | undefined {
  const phrase = extractTaskPhrase(lastMessage);
  if (!phrase) return undefined;
  const failureLike = /failed|failure|error|stderr|失败|报错|异常|启动失败/i.test(phrase);
  const prefix = failureLike ? 'Investigate' : 'Continue';
  return compactText(`${prefix}: ${phrase}`, MAX_ATTENTION_INTENT_LENGTH) ?? phrase;
}

function extractTaskPhrase(lastMessage: string): string | undefined {
  const sentences = lastMessage
    .split(/[.!?。！？]/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const meaningfulSentence = sentences.find((sentence) => !isLowInformationSentence(sentence));
  if (meaningfulSentence) return meaningfulSentence;
  if (sentences.length > 0) return undefined;
  return isLowInformationSentence(lastMessage) ? undefined : lastMessage;
}

function isLowInformationSentence(sentence: string): boolean {
  const normalized = sentence
    .replace(/[.!?。！？]+$/u, '')
    .trim();
  const terseFiller =
    normalized.length < 12 &&
    /^(ok|okay|done|hi|hello|hey|看了|好的|收到|完成|继续|继续正常|你好|我在|你好，我在)$/i.test(normalized);
  const memoryFooter = /^memory citations:\s*none$/i.test(normalized);
  return terseFiller || memoryFooter;
}

function buildNextAction(
  session: AggregatedSession,
  reasons: AttentionReason[],
  canRecover: boolean
): string {
  if (reasons.some((reason) => reason.code === 'recoverable_lost')) {
    if (!canRecover) {
      return 'Open details; the original working directory is unavailable.';
    }
    return session.currentFile
      ? `Recover this session and continue around ${formatPathTail(session.currentFile)}.`
      : 'Recover this session and continue from the current state.';
  }
  if (reasons.some((reason) => reason.code === 'waiting_for_human')) {
    return 'Open details and provide the requested human input.';
  }
  if (reasons.some((reason) => reason.code === 'high_cost')) {
    return 'Review recent activity and decide whether to stop, continue, or complete it.';
  }
  if (reasons.some((reason) => reason.code === 'stale_activity')) {
    return 'Open details and decide whether to continue or mark it complete.';
  }
  if (session.status === 'idle' || session.status === 'running') {
    return 'Monitor the session unless it needs manual follow-up.';
  }
  return 'No action needed.';
}

function buildWhyAttention(reasons: AttentionReason[]): string {
  const attentionReasons = reasons.filter((reason) => reason.severity !== 'info');
  if (attentionReasons.length === 0) return 'No critical or warning reason.';
  return attentionReasons.map((reason) => reason.message).join('; ');
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim());
}

function firstNonEmptyTask(
  values: Array<{ task: string | undefined; source: AttentionIntentTaskSource }>
): { task: string; source: AttentionIntentTaskSource } | undefined {
  return values.find((value): value is { task: string; source: AttentionIntentTaskSource } =>
    Boolean(value.task?.trim())
  );
}

function formatPathTail(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join('/');
}

function dedupeNoiseFlags(flags: AttentionIntentNoiseFlag[]): AttentionIntentNoiseFlag[] {
  return [...new Set(flags)];
}

function compareBoardItems(a: AttentionQueueItem, b: AttentionQueueItem): number {
  const laneComparison = AGENT_BOARD_LANE_ORDER.indexOf(a.lane) -
    AGENT_BOARD_LANE_ORDER.indexOf(b.lane);
  if (laneComparison !== 0) return laneComparison;

  if (a.lane === 'needs_you' && a.status !== b.status) {
    if (a.status === 'waiting') return -1;
    if (b.status === 'waiting') return 1;
  }

  const activityComparison = b.lastActiveAt.getTime() - a.lastActiveAt.getTime();
  if (activityComparison !== 0) return activityComparison;
  return a.sessionId.localeCompare(b.sessionId);
}

function compareAttentionItems(a: AttentionQueueItem, b: AttentionQueueItem): number {
  const scoreComparison = b.score - a.score;
  if (scoreComparison !== 0) return scoreComparison;
  const activityComparison = b.lastActiveAt.getTime() - a.lastActiveAt.getTime();
  if (activityComparison !== 0) return activityComparison;
  return a.sessionId.localeCompare(b.sessionId);
}

function hasCriticalReason(item: AttentionQueueItem): boolean {
  return item.reasons.some((reason) => reason.severity === 'critical');
}

function hasWarningReason(item: AttentionQueueItem): boolean {
  return item.reasons.some((reason) => reason.severity === 'warning');
}

function hasCriticalOrWarningReason(item: AttentionQueueItem): boolean {
  return item.reasons.some((reason) => reason.severity !== 'info');
}
