/**
 * Session module types
 */

import type {
  AgentClient,
  Session,
  SessionListItem,
  SessionStatus,
  SessionStatusSource,
} from '../domain/session/index.js';

/** Session creation input */
export interface CreateSessionInput {
  sessionId: string;
  client?: AgentClient;
  directory: string;
  initialPrompt: string;
  title?: string;
  pid?: number;
  tty?: string;
  statusSource?: SessionStatusSource;
}

/** Session update input */
export interface UpdateSessionInput {
  status?: SessionStatus;
  statusSource?: SessionStatusSource;
  title?: string;
  initialPrompt?: string;
  lastTool?: string;
  lastToolInput?: string;
  currentFile?: string;
  lastActiveAt?: Date;
  completedAt?: Date;
  pid?: number;
  tty?: string;
  toolCount?: number;
  messageCount?: number;
}

/** Aggregated session with process info */
export interface AggregatedSession extends Session {
  processRunning: boolean;
  cpuUsage?: number;
  memoryUsage?: number;
}

export interface BasicAggregatedSession extends SessionListItem {
  processRunning: boolean;
  cpuUsage?: number;
  memoryUsage?: number;
}

/** Session filter options */
export interface SessionFilter {
  client?: AgentClient;
  status?: SessionStatus[];
  directory?: string;
  hasProcess?: boolean;
  limit?: number;
}

/** Session sort options */
export type SessionSortField = 'lastActiveAt' | 'startedAt' | 'directory' | 'status' | 'client';
export type SessionSortOrder = 'asc' | 'desc';

export interface SessionSort {
  field: SessionSortField;
  order: SessionSortOrder;
}
