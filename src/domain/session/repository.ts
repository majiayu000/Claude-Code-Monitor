/**
 * Session repository interface
 *
 * Defines the contract for session persistence.
 * Implementation is in infrastructure layer.
 */

import type { Session, SessionListItem } from './entity.js';
import type {
  AgentClient,
  SessionStatus,
  ToolCallInfo,
  SessionUsageStats,
} from './value-objects.js';

export interface ActiveSessionRecord {
  sessionId: string;
  client: AgentClient;
  status: SessionStatus;
  pid?: number;
}

export interface ExistingSessionSummary {
  sessionId: string;
  client: AgentClient;
  status: SessionStatus;
  title: string;
}

/** Session upsert data (for create or update) */
export interface SessionUpsertData {
  sessionId: string;
  client?: AgentClient;
  directory?: string;
  status?: SessionStatus;
  title?: string;
  initialPrompt?: string;
  lastTool?: string;
  lastToolInput?: string;
  currentFile?: string;
  lastMessage?: string;
  startedAt?: Date;
  lastActiveAt?: Date;
  completedAt?: Date;
  pid?: number;
  tty?: string;
  toolCount?: number;
  messageCount?: number;
  agentId?: string;
  parentSessionId?: string;
  isSubAgent?: boolean;
  usageStats?: SessionUsageStats;
  toolCalls?: ToolCallInfo[];
  /** Durable provenance for Lost: true only after a process was actually matched. */
  wasProcessObserved?: boolean;
}

/** Session repository interface */
export interface ISessionRepository {
  /** Find session by internal ID */
  findById(id: string): Session | null;

  /** Find session by client-scoped session ID */
  findBySessionId(sessionId: string): Session | null;

  /** Find multiple sessions by client-scoped session ID */
  findBySessionIds(sessionIds: string[]): Session[];

  /** Find multiple sessions by client-scoped session ID with only sync-needed fields */
  findBySessionIdsSummary(sessionIds: string[]): ExistingSessionSummary[];

  /** Find all sessions */
  findAll(): Session[];

  /** Find sessions eligible for the live operational view. */
  findOperational(): Session[];

  /** Find all sessions with only fields needed for list/realtime payloads */
  findAllLightweight(): SessionListItem[];

  /** Find lightweight sessions eligible for the live operational view. */
  findOperationalLightweight(): SessionListItem[];

  /** Find active sessions (not completed or lost) */
  findActive(): Session[];

  /** Find active sessions with only the fields needed for process reconciliation */
  findActiveLightweight(): ActiveSessionRecord[];

  /** Find sessions by status */
  findByStatus(status: SessionStatus): Session[];

  /** Find sessions by directory */
  findByDirectory(directory: string): Session[];

  /** Create or update a session */
  upsert(data: SessionUpsertData): Session;

  /** Delete old sessions based on retention policy */
  deleteOldSessions(retentionDays: number): number;

  /** Get session count by status */
  countByStatus(): Record<SessionStatus, number>;
}
