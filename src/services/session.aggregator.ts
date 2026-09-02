/**
 * Session aggregator - combines data from multiple sources
 *
 * Uses cached process data for efficiency
 */

import type { SessionStatus } from '../domain/session/index.js';
import type { ISessionRepository } from '../domain/session/repository.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import { getCachedProcesses } from '../adapters/process/scanner.js';
import { detectSessionStatus } from '../adapters/process/detector.js';
import type { ClaudeProcessInfo } from '../adapters/process/types.js';
import type {
  AggregatedSession,
  BasicAggregatedSession,
  SessionFilter,
  SessionSort,
} from './session.types.js';
import { matchProcessesToSessions } from './session.process-matcher.js';

export function resolveAggregatedStatus(
  session: Pick<AggregatedSession, 'status' | 'lastActiveAt'>,
  process: ClaudeProcessInfo | undefined
): SessionStatus {
  if (session.status === 'completed') return 'completed';
  if (process && (session.status === 'running' || session.status === 'waiting')) {
    return session.status;
  }
  return detectSessionStatus(process ?? null, session.lastActiveAt);
}

export class SessionAggregator {
  constructor(private readonly repository: ISessionRepository) {}

  /** Get all sessions with aggregated process info (uses cached processes) */
  getAggregatedSessions(): AggregatedSession[] {
    const sessions = this.repository.findOperational();
    const processes = getCachedProcesses();
    const processMatches = matchProcessesToSessions(sessions, processes);

    return sessions.map((session) => {
      const process = processMatches.get(session.sessionId);
      const liveStatus = resolveAggregatedStatus(session, process);

      return {
        ...session,
        // Update status based on live process info
        status: liveStatus,
        processRunning: !!process,
        cpuUsage: process?.cpu,
        memoryUsage: process?.memory,
      };
    });
  }

  /** Get lightweight sessions with aggregated process info for dashboard list/realtime updates */
  getAggregatedSessionsBasic(): BasicAggregatedSession[] {
    const sessions = this.repository.findOperationalLightweight();
    const processes = getCachedProcesses();
    const processMatches = matchProcessesToSessions(sessions, processes);

    return sessions.map((session) => {
      const process = processMatches.get(session.sessionId);
      const liveStatus = resolveAggregatedStatus(session, process);

      return {
        ...session,
        status: liveStatus,
        processRunning: !!process,
        cpuUsage: process?.cpu,
        memoryUsage: process?.memory,
      };
    });
  }

  /**
   * Read the service-owned snapshot without running a second process scan.
   * Service Mode persists live status and pid data during its isolated scan.
   */
  getPersistedSessionsBasic(): BasicAggregatedSession[] {
    return this.repository.findOperationalLightweight().map((session) => ({
      ...session,
      processRunning: Boolean(session.pid) &&
        session.status !== 'completed' && session.status !== 'lost',
    }));
  }

  getPersistedSessions(): AggregatedSession[] {
    return this.repository.findOperational().map((session) => ({
      ...session,
      processRunning: Boolean(session.pid) &&
        session.status !== 'completed' && session.status !== 'lost',
    }));
  }
}

export const sessionAggregator = new SessionAggregator(sessionRepository);

export const getAggregatedSessions =
  sessionAggregator.getAggregatedSessions.bind(sessionAggregator);
export const getAggregatedSessionsBasic =
  sessionAggregator.getAggregatedSessionsBasic.bind(sessionAggregator);
export const getPersistedSessionsBasic =
  sessionAggregator.getPersistedSessionsBasic.bind(sessionAggregator);
export const getPersistedSessions =
  sessionAggregator.getPersistedSessions.bind(sessionAggregator);

/** Filter sessions */
export function filterSessions(
  sessions: AggregatedSession[],
  filter: SessionFilter
): AggregatedSession[] {
  let result = sessions;

  if (filter.status && filter.status.length > 0) {
    result = result.filter((s) => filter.status!.includes(s.status));
  }

  if (filter.client) {
    result = result.filter((s) => s.client === filter.client);
  }

  if (filter.directory) {
    result = result.filter((s) => s.directory.includes(filter.directory!));
  }

  if (filter.hasProcess !== undefined) {
    result = result.filter((s) => s.processRunning === filter.hasProcess);
  }

  if (filter.limit && filter.limit > 0) {
    result = result.slice(0, filter.limit);
  }

  return result;
}

/** Sort sessions */
export function sortSessions(
  sessions: AggregatedSession[],
  sort: SessionSort
): AggregatedSession[] {
  const sorted = [...sessions];

  sorted.sort((a, b) => {
    let comparison = 0;

    switch (sort.field) {
      case 'lastActiveAt':
        comparison = a.lastActiveAt.getTime() - b.lastActiveAt.getTime();
        break;
      case 'startedAt':
        const aStart = a.startedAt?.getTime() || 0;
        const bStart = b.startedAt?.getTime() || 0;
        comparison = aStart - bStart;
        break;
      case 'directory':
        comparison = a.directory.localeCompare(b.directory);
        break;
      case 'status':
        comparison = a.status.localeCompare(b.status);
        break;
      case 'client':
        comparison = a.client.localeCompare(b.client);
        break;
    }

    return sort.order === 'desc' ? -comparison : comparison;
  });

  return sorted;
}

/** Group sessions by status */
export function groupByStatus(
  sessions: AggregatedSession[]
): Map<SessionStatus, AggregatedSession[]> {
  const grouped = new Map<SessionStatus, AggregatedSession[]>();

  for (const session of sessions) {
    const existing = grouped.get(session.status) || [];
    existing.push(session);
    grouped.set(session.status, existing);
  }

  return grouped;
}

/** Group sessions by directory */
export function groupByDirectory(
  sessions: AggregatedSession[]
): Map<string, AggregatedSession[]> {
  const grouped = new Map<string, AggregatedSession[]>();

  for (const session of sessions) {
    const existing = grouped.get(session.directory) || [];
    existing.push(session);
    grouped.set(session.directory, existing);
  }

  return grouped;
}

/** Get session statistics - single pass O(n) for efficiency */
export function getSessionStats(
  sessions: Array<Pick<AggregatedSession, 'status' | 'processRunning'>>
): {
  total: number;
  running: number;
  waiting: number;
  idle: number;
  lost: number;
  completed: number;
  withProcess: number;
} {
  const stats = {
    total: sessions.length,
    running: 0,
    waiting: 0,
    idle: 0,
    lost: 0,
    completed: 0,
    withProcess: 0,
  };

  // Single pass through sessions
  for (const session of sessions) {
    // Count by status
    switch (session.status) {
      case 'running':
        stats.running++;
        break;
      case 'waiting':
        stats.waiting++;
        break;
      case 'idle':
        stats.idle++;
        break;
      case 'lost':
        stats.lost++;
        break;
      case 'completed':
        stats.completed++;
        break;
    }

    // Count processes
    if (session.processRunning) {
      stats.withProcess++;
    }
  }

  return stats;
}
