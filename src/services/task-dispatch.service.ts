import { existsSync, realpathSync, statSync } from 'fs';
import type { Session } from '../domain/session/index.js';
import type { RuntimeId } from '../domain/runtime/index.js';
import { encodeAgentSessionId, type TaskDispatch } from '../domain/work-item/index.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import {
  DispatchSessionClaimConflictError,
  taskDispatchRepository,
} from '../infrastructure/database/repositories/task-dispatch.repository.js';
import { workItemEvidenceRepository } from '../infrastructure/database/repositories/work-item-evidence.repository.js';
import { workItemRepository } from '../infrastructure/database/repositories/work-item.repository.js';
import { runtimeIdForClient } from './runtime-status.js';
import { emit } from '../lib/events.js';

const SUPPORTED_RUNTIMES = new Set<RuntimeId>(['codex', 'claude-code']);
export const DEFAULT_DISPATCH_CORRELATION_TIMEOUT_MS = 2 * 60_000;
export const DISPATCH_CORRELATION_TIMEOUT_ERROR =
  'No unique Agent session appeared before the correlation deadline. ' +
  'Check the opened terminal for project trust or login prompts, then retry.';

export class DispatchIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key is already associated with a different dispatch payload');
    this.name = 'DispatchIdempotencyConflictError';
  }
}

export { DispatchSessionClaimConflictError };

export interface DispatchWorkItemInput {
  runtimeId: RuntimeId;
  cwd: string;
  prompt: string;
  terminalApp?: TaskDispatch['terminalApp'];
  idempotencyKey: string;
}

interface TaskDispatchServiceOptions {
  now?: () => Date;
  correlationTimeoutMs?: number;
  launch?: LaunchTerminal;
}

type LaunchTerminal = (
  executable: string,
  args: string[],
  cwd: string,
  terminalApp: TaskDispatch['terminalApp']
) => void | Promise<void>;

function canonicalDirectory(directory: string): string {
  if (!directory || directory.length > 2048) throw new Error('cwd is required');
  const canonical = realpathSync(directory);
  if (!statSync(canonical).isDirectory()) throw new Error('cwd must be a directory');
  return canonical;
}

function isRootSession(session: Pick<Session, 'isSubAgent' | 'sessionId'>): boolean {
  return !session.isSubAgent && !session.sessionId.startsWith('agent-');
}

function matchesRuntime(session: Session, runtimeId: RuntimeId): boolean {
  return runtimeIdForClient(session.client) === runtimeId;
}

function buildLaunch(
  runtimeId: RuntimeId,
  prompt: string,
  workItemId: string
): { executable: string; args: string[] } {
  if (runtimeId === 'codex') return { executable: 'codex', args: [prompt] };
  if (runtimeId === 'claude-code') {
    const completionContract =
      'Only after the task is fully complete and verified, end your final response with this exact line:\n' +
      `KEEPLINE_COMPLETE_WORK_ITEM:${workItemId}\n` +
      'Do not output that line when blocked, waiting for input, or incomplete.';
    return { executable: 'claude', args: [`${prompt}\n\n${completionContract}`] };
  }
  throw new Error(`Unsupported runtime: ${runtimeId}`);
}

function serializeRuntimeSession(session: Session) {
  return workItemEvidenceRepository.upsertAgentSession({
    runtimeId: runtimeIdForClient(session.client),
    runtimeSessionId: session.sessionId,
    cwd: session.directory,
    projectRoot: session.directory,
    status: session.status,
    title: session.title,
    lastActiveAt: session.lastActiveAt,
    evidenceSummary: session.lastMessage,
  });
}

export class TaskDispatchService {
  private readonly now: () => Date;
  private readonly correlationTimeoutMs: number;
  private readonly launch?: LaunchTerminal;

  constructor(options: TaskDispatchServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.correlationTimeoutMs = options.correlationTimeoutMs ??
      DEFAULT_DISPATCH_CORRELATION_TIMEOUT_MS;
    this.launch = options.launch;
  }

  async dispatch(workItemId: string, input: DispatchWorkItemInput): Promise<TaskDispatch> {
    const item = workItemRepository.findById(workItemId);
    if (!item) throw new Error('Work item not found');
    if (!SUPPORTED_RUNTIMES.has(input.runtimeId)) {
      throw new Error(`Unsupported runtime: ${input.runtimeId}`);
    }
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 240) {
      throw new Error('idempotencyKey is required');
    }
    if (!input.prompt.trim() || input.prompt.length > 20_000) {
      throw new Error('prompt is required');
    }
    const cwd = canonicalDirectory(input.cwd);
    const prompt = input.prompt.trim();
    const terminalApp = input.terminalApp ?? 'auto';
    const idempotencyKey = input.idempotencyKey.trim();
    const existing = taskDispatchRepository.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (
        existing.workItemId !== workItemId ||
        existing.runtimeId !== input.runtimeId ||
        existing.cwd !== cwd ||
        existing.prompt !== prompt ||
        existing.terminalApp !== terminalApp
      ) {
        throw new DispatchIdempotencyConflictError();
      }
      return existing;
    }
    const preLaunchSessionIds = sessionRepository.findAll()
      .filter((session) => isRootSession(session) && matchesRuntime(session, input.runtimeId))
      .map((session) => session.sessionId);
    let dispatch = taskDispatchRepository.create({
      workItemId,
      runtimeId: input.runtimeId,
      cwd,
      prompt,
      terminalApp,
      idempotencyKey,
      preLaunchSessionIds,
      correlationDeadlineAt: new Date(this.now().getTime() + this.correlationTimeoutMs),
    });
    dispatch = taskDispatchRepository.updateState(dispatch.id, 'launching')!;
    const command = buildLaunch(input.runtimeId, prompt, workItemId);
    try {
      if (this.launch) {
        await this.launch(command.executable, command.args, cwd, dispatch.terminalApp);
      } else {
        const { openTerminalWithArgv } = await import('./terminal.js');
        openTerminalWithArgv(command.executable, command.args, cwd, dispatch.terminalApp);
      }
      dispatch = taskDispatchRepository.updateState(dispatch.id, 'awaiting_session', {
        launchedAt: this.now(),
        error: null,
      })!;
      if (item.externalSource !== 'stash') {
        workItemRepository.update(workItemId, { status: 'active', statusSource: 'user' });
      }
      emit('dispatch:created', { dispatchId: dispatch.id });
      return dispatch;
    } catch (error) {
      taskDispatchRepository.updateState(dispatch.id, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  reconcilePending(): TaskDispatch[] {
    const sessions = sessionRepository.findAll();
    const now = this.now();
    const pending = taskDispatchRepository.findPending();
    const candidatesByDispatch = new Map<string, Session[]>();
    const dispatchOwnersBySession = new Map<string, Set<string>>();

    for (const dispatch of pending) {
      if (dispatch.state === 'ambiguous' || !dispatch.launchedAt ||
          now > dispatch.correlationDeadlineAt) continue;
      const preLaunch = new Set(dispatch.preLaunchSessionIds);
      const candidates = sessions.filter((session) => {
        if (!isRootSession(session) || !matchesRuntime(session, dispatch.runtimeId)) return false;
        if (preLaunch.has(session.sessionId)) return false;
        if (session.lastActiveAt.getTime() < dispatch.launchedAt!.getTime()) return false;
        if (!existsSync(session.directory)) return false;
        return canonicalDirectory(session.directory) === dispatch.cwd;
      });
      candidatesByDispatch.set(dispatch.id, candidates);
      for (const candidate of candidates) {
        const owners = dispatchOwnersBySession.get(candidate.sessionId) ?? new Set<string>();
        owners.add(dispatch.id);
        dispatchOwnersBySession.set(candidate.sessionId, owners);
      }
    }

    return pending.map((dispatch) => {
      if (dispatch.state !== 'ambiguous' && now > dispatch.correlationDeadlineAt) {
        return taskDispatchRepository.updateState(dispatch.id, 'failed', {
          error: DISPATCH_CORRELATION_TIMEOUT_ERROR,
        })!;
      }
      if (dispatch.state === 'ambiguous' || !dispatch.launchedAt) return dispatch;
      const candidates = candidatesByDispatch.get(dispatch.id) ?? [];
      const hasSharedCandidate = candidates.some((session) => {
        const owners = dispatchOwnersBySession.get(session.sessionId);
        if ((owners?.size ?? 0) > 1) return true;
        const agentSessionId = encodeAgentSessionId(dispatch.runtimeId, session.sessionId);
        return taskDispatchRepository.findLinkedByAgentSessionId(agentSessionId)
          .some((linked) => linked.id !== dispatch.id);
      });
      if (candidates.length === 1 && !hasSharedCandidate) {
        try {
          return this.link(dispatch, candidates[0]);
        } catch (error) {
          if (!(error instanceof DispatchSessionClaimConflictError)) throw error;
          return taskDispatchRepository.updateState(dispatch.id, 'ambiguous', {
            candidateSessionIds: [candidates[0].sessionId],
            error: error.message,
          })!;
        }
      }
      if (candidates.length > 0) {
        return taskDispatchRepository.updateState(dispatch.id, 'ambiguous', {
          candidateSessionIds: candidates.map((session) => session.sessionId),
        })!;
      }
      return taskDispatchRepository.updateState(dispatch.id, 'awaiting_session', {
        candidateSessionIds: [],
      })!;
    });
  }

  resolveSession(dispatchId: string, sessionId: string): TaskDispatch {
    const dispatch = taskDispatchRepository.findById(dispatchId);
    if (!dispatch) throw new Error('Dispatch not found');
    if (!dispatch.candidateSessionIds.includes(sessionId)) {
      throw new Error('Session is not a dispatch candidate');
    }
    const session = sessionRepository.findBySessionId(sessionId);
    if (!session) throw new Error('Session not found');
    return this.link(dispatch, session);
  }

  private link(dispatch: TaskDispatch, session: Session): TaskDispatch {
    const agentSession = serializeRuntimeSession(session);
    return taskDispatchRepository.claimAgentSession(
      dispatch.id,
      dispatch.workItemId,
      agentSession.id,
      session.sessionId
    );
  }
}

export const taskDispatchService = new TaskDispatchService();
