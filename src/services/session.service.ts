/**
 * Session service - business logic for session management
 *
 * Optimized to use cached process data during sync cycles.
 * Includes sync lock to prevent concurrent sync operations.
 */

import type { Session } from '../domain/session/index.js';
import { generateTitle } from '../domain/session/index.js';
import type { ISessionRepository } from '../domain/session/repository.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import { emit } from '../lib/events.js';
import { getCachedProcesses, clearProcessCache } from '../adapters/process/scanner.js';
import { detectSessionStatus } from '../adapters/process/detector.js';
import {
  clearSessionCache,
  getAllSessionsWithFailures as getClaudeSessionsWithFailures,
} from '../adapters/claude/scanner.js';
import {
  clearCodexSessionCache,
  getAllCodexSessionsWithFailures,
} from '../adapters/codex/scanner.js';
import { logger } from '../lib/logger.js';
import { isValidSessionId } from '../lib/session-id.js';
import type { CreateSessionInput, UpdateSessionInput, AggregatedSession } from './session.types.js';
import { matchProcessesToSessions } from './session.process-matcher.js';
import {
  recordRuntimeScanFailures,
  type RuntimeScanFailure,
  type SessionRuntimeId,
} from './runtime-status.js';

/** Options for sync operation */
export interface SyncOptions {
  maxAgeDays?: number; // Only sync files modified within this many days (default: 7 for fast sync)
  fullSync?: boolean; // Force full sync of all files
  includeSubAgents?: boolean; // Include Claude sub-agent transcripts (default: true)
}

export interface RuntimeSessionScan<T> {
  sessions: T[];
  failures: RuntimeScanFailure[];
}

function isGeneratedContextTitle(title: string): boolean {
  return title === 'Unknown task' ||
    /^继续[。.!！]?$/.test(title) ||
    /^<recommended_plugins(?:\s|>)/i.test(title) ||
    /^<environment_context(?:\s|>)/i.test(title) ||
    /^#\s*AGENTS\.md instructions for(?:\s|$)/i.test(title) ||
    /^AGENTS\.md: [^\n]+$/i.test(title) ||
    /^AGENTS\.md instructions$/i.test(title);
}

export async function scanRuntimeSessions<T>(
  runtimeId: SessionRuntimeId,
  scan: () => Promise<RuntimeSessionScan<T>>
): Promise<RuntimeSessionScan<T>> {
  try {
    const result = await scan();
    recordRuntimeScanFailures(runtimeId, result.failures);
    return result;
  } catch (error) {
    const failure: RuntimeScanFailure = {
      code: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      recoverable: true,
    };
    recordRuntimeScanFailures(runtimeId, [failure]);
    logger.error('Runtime session scan failed', {
      runtimeId,
      message: failure.message,
    });
    return { sessions: [], failures: [failure] };
  }
}

export class SessionService {
  private isSyncing = false;

  constructor(private readonly repository: ISessionRepository) {}

  /** Create a new session */
  createSession(input: CreateSessionInput): Session {
    const session = this.repository.upsert({
      sessionId: input.sessionId,
      client: input.client,
      directory: input.directory,
      initialPrompt: input.initialPrompt,
      title: input.title || generateTitle(input.initialPrompt),
      status: 'running',
      pid: input.pid,
      tty: input.tty,
      lastActiveAt: new Date(),
      startedAt: new Date(),
      toolCount: 0,
      messageCount: 1,
    });

    emit('session:discovered', { session });
    logger.info(`Session created: ${session.sessionId}`);
    return session;
  }

  /** Update an existing session */
  updateSession(sessionId: string, input: UpdateSessionInput): Session {
    const existing = this.repository.findBySessionId(sessionId);
    const previousStatus = existing?.status;

    // Explicit completion is durable. Live hooks and later scans may refresh
    // activity fields, but they cannot reopen a completed session implicitly.
    const safeInput = existing?.status === 'completed' && input.status !== 'completed'
      ? { ...input, status: 'completed' as const }
      : input;

    const session = this.repository.upsert({
      sessionId,
      ...safeInput,
    });

    if (previousStatus && previousStatus !== session.status) {
      emit('session:updated', { session, previousStatus });
      logger.debug(`Session ${sessionId} status: ${previousStatus} -> ${session.status}`);
    }

    return session;
  }

  /** Get all sessions */
  getAllSessions(): Session[] {
    return this.repository.findAll();
  }

  /** Get session by ID */
  getSession(sessionId: string): Session | null {
    return this.repository.findBySessionId(sessionId);
  }

  /** Get active sessions (not completed) */
  getActiveSessions(): Session[] {
    return this.repository.findActive();
  }

  /** Get sessions needing attention (lost or waiting) */
  getAttentionSessions(): Session[] {
    return this.repository.findOperational().filter(
      (session) => session.status === 'lost' || session.status === 'waiting'
    );
  }

  /** Sync runtime adapter sessions with running processes */
  async syncSessions(options: SyncOptions = {}): Promise<{
    discovered: number;
    updated: number;
    lost: number;
  }> {
    // Prevent concurrent sync operations
    if (this.isSyncing) {
      logger.debug('Sync already in progress, skipping');
      return { discovered: 0, updated: 0, lost: 0 };
    }

    this.isSyncing = true;
    const startTime = Date.now();
    let discovered = 0;
    let updated = 0;
    let lost = 0;

    // Default to 7 days for fast sync, unless fullSync is requested
    const maxAgeDays = options.fullSync ? undefined : (options.maxAgeDays ?? 7);

    try {
      // Clear process cache at start of sync cycle to ensure fresh data
      clearProcessCache();

      // Get current process info (will be cached for duration of sync)
      const processes = getCachedProcesses();
      const runningAgentPids = new Set(processes.map((process) => process.pid));

      // Get sessions from file system (with optional age filter for performance)
      const [claudeScan, codexScan] = await Promise.all([
        scanRuntimeSessions('claude-code', () => getClaudeSessionsWithFailures({
          maxAgeDays,
          includeSubAgents: options.includeSubAgents ?? true,
          includeToolCalls: false,
        })),
        scanRuntimeSessions('codex', () => getAllCodexSessionsWithFailures({
          maxAgeDays,
          includeToolCalls: false,
        })),
      ]);
      const scannedSessions = [...claudeScan.sessions, ...codexScan.sessions];
      const invalidScannedSessions = scannedSessions.filter(
        (session) => !isValidSessionId(session.sessionId)
      );
      if (invalidScannedSessions.length > 0) {
        logger.warn('Skipped scanned sessions with invalid session IDs before persistence', {
          count: invalidScannedSessions.length,
          sample: invalidScannedSessions.slice(0, 5).map((session) => ({
            sessionId: session.sessionId,
            client: session.client ?? 'claude',
            directory: session.directory,
          })),
        });
      }
      const agentSessions = scannedSessions.filter((session) =>
        isValidSessionId(session.sessionId)
      );
      const processMatches = matchProcessesToSessions(agentSessions, processes);
      const existingSessions = this.repository.findBySessionIdsSummary(
        agentSessions.map((session) => session.sessionId)
      );
      const existingSessionMap = new Map(
        existingSessions.map((session) => [session.sessionId, session])
      );

      // Process each scanned session
      for (const agentSession of agentSessions) {
        const client = agentSession.client ?? 'claude';
        const existing = existingSessionMap.get(agentSession.sessionId);
        const process = processMatches.get(agentSession.sessionId);

        const detectedStatus = detectSessionStatus(
          process || null,
          agentSession.lastActiveAt
        );
        // A lifecycle hook is received after the transcript record that caused it.
        // Keep that newer semantic observation while its process is still alive;
        // otherwise the CPU/time heuristic would immediately overwrite it.
        const hasNewerHookObservation = Boolean(
          existing &&
          process &&
          (existing.status === 'running' || existing.status === 'waiting') &&
          existing.lastActiveAt.getTime() > agentSession.lastActiveAt.getTime()
        );
        // `completed` is written only by an explicit hook/user action. A later
        // process scan must not downgrade that durable signal to lost/idle.
        const status = existing?.status === 'completed'
          ? 'completed'
          : hasNewerHookObservation ? existing!.status : detectedStatus;
        const lastActiveAt = hasNewerHookObservation
          ? existing!.lastActiveAt
          : agentSession.lastActiveAt;

        if (existing) {
          const nextStatus = existing.status === 'completed' ? 'completed' : status;
          // Update existing session
          const wasLost = existing.status !== 'lost' && nextStatus === 'lost';

          // Replace only generated context noise; preserve normal and user-edited titles.
          const shouldUpdateTitle =
            isGeneratedContextTitle(existing.title) &&
            agentSession.firstMessage &&
            agentSession.firstMessage !== 'Unknown task';

          const updatedSession = this.repository.upsert({
            sessionId: agentSession.sessionId,
            client,
            status: nextStatus,
            ...(shouldUpdateTitle && {
              title: generateTitle(agentSession.firstMessage!),
              initialPrompt: agentSession.firstMessage,
            }),
            lastTool: agentSession.lastTool,
            lastToolInput: agentSession.lastToolInput
              ? JSON.stringify(agentSession.lastToolInput)
              : undefined,
            currentFile: agentSession.currentFile,
            lastMessage: agentSession.lastMessage,
            lastActiveAt,
            pid: process?.pid,
            tty: process?.tty,
            toolCount: agentSession.toolCount,
            messageCount: agentSession.messageCount,
            agentId: agentSession.agentId,
            parentSessionId: agentSession.parentSessionId,
            isSubAgent: agentSession.isSubAgent,
            usageStats: agentSession.usageStats,
            toolCalls: agentSession.toolCalls,
            ...(process && { wasProcessObserved: true }),
          });
          existingSessionMap.set(agentSession.sessionId, updatedSession);

          updated++;
          if (wasLost) {
            lost++;
            emit('session:lost', { session: updatedSession, previousStatus: existing.status });
          }
        } else {
          // Create new session with all data in single upsert (no redundant calls)
          const title = agentSession.firstMessage
            ? generateTitle(agentSession.firstMessage)
            : 'Unknown task';

          const newSession = this.repository.upsert({
            sessionId: agentSession.sessionId,
            client,
            directory: agentSession.directory,
            initialPrompt: agentSession.firstMessage || 'Unknown task',
            title,
            status,
            lastTool: agentSession.lastTool,
            lastToolInput: agentSession.lastToolInput
              ? JSON.stringify(agentSession.lastToolInput)
              : undefined,
            currentFile: agentSession.currentFile,
            lastMessage: agentSession.lastMessage,
            startedAt: agentSession.startedAt,
            lastActiveAt: agentSession.lastActiveAt,
            pid: process?.pid,
            tty: process?.tty,
            toolCount: agentSession.toolCount,
            messageCount: agentSession.messageCount,
            agentId: agentSession.agentId,
            parentSessionId: agentSession.parentSessionId,
            isSubAgent: agentSession.isSubAgent,
            usageStats: agentSession.usageStats,
            toolCalls: agentSession.toolCalls,
            ...(process && { wasProcessObserved: true }),
          });
          existingSessionMap.set(agentSession.sessionId, newSession);
          emit('session:discovered', { session: newSession });
          discovered++;
        }
      }

      // Check for sessions whose processes have died
      const activeSessions = this.repository.findActiveLightweight();
      for (const session of activeSessions) {
        if (session.pid && !runningAgentPids.has(session.pid)) {
          // Process died, mark as lost unless it was completed
          if (session.status !== 'completed') {
            const lostSession = this.repository.upsert({
              sessionId: session.sessionId,
              status: 'lost',
              pid: undefined,
            });
            lost++;
            emit('session:lost', {
              session: lostSession,
              previousStatus: session.status,
            });
          }
        }
      }

      const duration = Date.now() - startTime;
      if (discovered > 0 || lost > 0) {
        logger.info(`Session sync: ${discovered} new, ${lost} lost`);
      }
      emit('scan:complete', { sessionCount: agentSessions.length, duration });
      logger.debug(`Sync complete: ${discovered} new, ${updated} updated, ${lost} lost (${duration}ms)`);

      return { discovered, updated, lost };
    } finally {
      this.isSyncing = false;
    }
  }

  /** Get aggregated session with process info (uses cached processes) */
  getAggregatedSession(sessionId: string): AggregatedSession | null {
    const session = this.repository.findBySessionId(sessionId);
    if (!session) return null;

    const sessions = this.repository.findAll();
    const processes = getCachedProcesses();
    const processMatches = matchProcessesToSessions(sessions, processes);
    const process = processMatches.get(session.sessionId);

    return {
      ...session,
      processRunning: !!process,
      cpuUsage: process?.cpu,
      memoryUsage: process?.memory,
    };
  }

  /** Mark session as completed */
  completeSession(sessionId: string): void {
    const session = this.repository.findBySessionId(sessionId);
    if (!session) return;

    this.repository.upsert({
      sessionId,
      status: 'completed',
      completedAt: new Date(),
      pid: undefined,
    });

    const completedSession = this.repository.findBySessionId(sessionId);
    if (completedSession) {
      emit('session:completed', { session: completedSession });
    }
  }
}

export const sessionService = new SessionService(sessionRepository);

export const createSession = sessionService.createSession.bind(sessionService);
export const updateSession = sessionService.updateSession.bind(sessionService);
export const getAllSessions = sessionService.getAllSessions.bind(sessionService);
export const getSession = sessionService.getSession.bind(sessionService);
export const getActiveSessions = sessionService.getActiveSessions.bind(sessionService);
export const getAttentionSessions = sessionService.getAttentionSessions.bind(sessionService);
export const syncSessions = sessionService.syncSessions.bind(sessionService);
export const getAggregatedSession = sessionService.getAggregatedSession.bind(sessionService);
export const completeSession = sessionService.completeSession.bind(sessionService);

/** Release parsed transcript summaries retained by the bulk scanners. */
export function releaseSessionScanCaches(): void {
  clearSessionCache();
  clearCodexSessionCache();
}
