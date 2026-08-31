import { randomUUID } from 'crypto';
import type {
  CompletionReview,
  CompletionReviewDecision,
  TaskDispatch,
  TaskDispatchCreateInput,
  TaskDispatchState,
} from '../../../domain/work-item/index.js';
import { getDatabase, transaction } from '../sqlite.js';

export class DispatchSessionClaimConflictError extends Error {
  constructor() {
    super('Agent session is already claimed by another dispatch');
    this.name = 'DispatchSessionClaimConflictError';
  }
}

interface DispatchRow {
  id: string;
  work_item_id: string;
  runtime_id: string;
  cwd: string;
  prompt: string;
  terminal_app: string;
  idempotency_key: string;
  state: string;
  pre_launch_session_ids: string;
  candidate_session_ids: string;
  linked_agent_session_id: string | null;
  error: string | null;
  launched_at: string | null;
  correlation_deadline_at: string;
  created_at: string;
  updated_at: string;
}

interface CompletionReviewRow {
  id: string;
  work_item_id: string;
  evidence_id: string;
  decision: string;
  created_at: string;
  updated_at: string;
}

function parseDispatchSessionIds(raw: string): string[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('Invalid dispatch session ID list');
  }
  return value;
}

function rowToDispatch(row: DispatchRow): TaskDispatch {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    runtimeId: row.runtime_id,
    cwd: row.cwd,
    prompt: row.prompt,
    terminalApp: row.terminal_app as TaskDispatch['terminalApp'],
    idempotencyKey: row.idempotency_key,
    state: row.state as TaskDispatchState,
    preLaunchSessionIds: parseDispatchSessionIds(row.pre_launch_session_ids),
    candidateSessionIds: parseDispatchSessionIds(row.candidate_session_ids),
    linkedAgentSessionId: row.linked_agent_session_id || undefined,
    error: row.error || undefined,
    launchedAt: row.launched_at ? new Date(row.launched_at) : undefined,
    correlationDeadlineAt: new Date(row.correlation_deadline_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToReview(row: CompletionReviewRow): CompletionReview {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    evidenceId: row.evidence_id,
    decision: row.decision as CompletionReviewDecision,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class TaskDispatchRepository {
  create(input: TaskDispatchCreateInput): TaskDispatch {
    const db = getDatabase();
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO task_dispatches (
        id, work_item_id, runtime_id, cwd, prompt, terminal_app,
        idempotency_key, state, pre_launch_session_ids,
        candidate_session_ids, correlation_deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, '[]', ?, ?, ?)
    `).run(
      id,
      input.workItemId,
      input.runtimeId,
      input.cwd,
      input.prompt,
      input.terminalApp,
      input.idempotencyKey,
      JSON.stringify(input.preLaunchSessionIds),
      input.correlationDeadlineAt.toISOString(),
      now,
      now
    );
    return this.findById(id)!;
  }

  findById(id: string): TaskDispatch | null {
    const row = getDatabase().prepare('SELECT * FROM task_dispatches WHERE id = ?')
      .get(id) as DispatchRow | undefined;
    return row ? rowToDispatch(row) : null;
  }

  findByIdempotencyKey(key: string): TaskDispatch | null {
    const row = getDatabase().prepare('SELECT * FROM task_dispatches WHERE idempotency_key = ?')
      .get(key) as DispatchRow | undefined;
    return row ? rowToDispatch(row) : null;
  }

  findByWorkItemId(workItemId: string): TaskDispatch[] {
    const rows = getDatabase().prepare(`
      SELECT * FROM task_dispatches
      WHERE work_item_id = ?
      ORDER BY created_at ASC
    `).all(workItemId) as DispatchRow[];
    return rows.map(rowToDispatch);
  }

  findPending(): TaskDispatch[] {
    const rows = getDatabase().prepare(`
      SELECT * FROM task_dispatches
      WHERE state IN ('queued', 'launching', 'awaiting_session', 'ambiguous')
      ORDER BY created_at ASC
    `).all() as DispatchRow[];
    return rows.map(rowToDispatch);
  }

  findCorrelationPending(): TaskDispatch[] {
    const rows = getDatabase().prepare(`
      SELECT * FROM task_dispatches
      WHERE state IN ('queued', 'launching', 'awaiting_session')
      ORDER BY created_at ASC
    `).all() as DispatchRow[];
    return rows.map(rowToDispatch);
  }

  findLinkedByAgentSessionId(agentSessionId: string): TaskDispatch[] {
    const rows = getDatabase().prepare(`
      SELECT * FROM task_dispatches
      WHERE state = 'linked' AND linked_agent_session_id = ?
      ORDER BY created_at ASC
    `).all(agentSessionId) as DispatchRow[];
    return rows.map(rowToDispatch);
  }

  updateState(
    id: string,
    state: TaskDispatchState,
    values: {
      candidateSessionIds?: string[];
      linkedAgentSessionId?: string | null;
      error?: string | null;
      launchedAt?: Date;
    } = {}
  ): TaskDispatch | null {
    const existing = this.findById(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    getDatabase().prepare(`
      UPDATE task_dispatches
      SET state = ?, candidate_session_ids = ?, linked_agent_session_id = ?,
          error = ?, launched_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      state,
      JSON.stringify(values.candidateSessionIds ?? existing.candidateSessionIds),
      values.linkedAgentSessionId === undefined
        ? existing.linkedAgentSessionId ?? null
        : values.linkedAgentSessionId,
      values.error === undefined ? existing.error ?? null : values.error,
      (values.launchedAt ?? existing.launchedAt)?.toISOString() ?? null,
      now,
      id
    );
    return this.findById(id);
  }

  /** Atomically claim one Agent session, accept its work-item link, and link the dispatch. */
  claimAgentSession(
    id: string,
    workItemId: string,
    agentSessionId: string,
    runtimeSessionId: string
  ): TaskDispatch {
    const db = getDatabase();
    try {
      return transaction(() => {
        const dispatch = this.findById(id);
        if (!dispatch) throw new Error('Dispatch not found');
        if (dispatch.workItemId !== workItemId) throw new Error('Dispatch work item mismatch');
        if (dispatch.linkedAgentSessionId === agentSessionId && dispatch.state === 'linked') {
          return dispatch;
        }
        const claimant = db.prepare(`
          SELECT id FROM task_dispatches
          WHERE linked_agent_session_id = ? AND id != ?
          LIMIT 1
        `).get(agentSessionId, id) as { id: string } | undefined;
        if (claimant) throw new DispatchSessionClaimConflictError();

        const now = new Date().toISOString();
        // Claim first: the partial unique index is the cross-process race arbiter.
        db.prepare(`
          UPDATE task_dispatches
          SET state = 'linked', candidate_session_ids = ?, linked_agent_session_id = ?,
              error = NULL, updated_at = ?
          WHERE id = ?
        `).run(JSON.stringify([runtimeSessionId]), agentSessionId, now, id);

        const existingLink = db.prepare(`
          SELECT id FROM work_item_session_links
          WHERE work_item_id = ? AND agent_session_id = ?
        `).get(workItemId, agentSessionId) as { id: string } | undefined;
        if (existingLink) {
          db.prepare(`
            UPDATE work_item_session_links
            SET link_source = 'user', acceptance_status = 'accepted',
                accepted_at = ?, updated_at = ?
            WHERE id = ?
          `).run(now, now, existingLink.id);
        } else {
          db.prepare(`
            INSERT INTO work_item_session_links (
              id, work_item_id, agent_session_id, link_source, acceptance_status,
              accepted_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'user', 'accepted', ?, ?, ?)
          `).run(randomUUID(), workItemId, agentSessionId, now, now, now);
        }

        return this.findById(id)!;
      });
    } catch (error) {
      if (error instanceof DispatchSessionClaimConflictError ||
          (error instanceof Error &&
            error.message.includes('task_dispatches.linked_agent_session_id'))) {
        throw new DispatchSessionClaimConflictError();
      }
      throw error;
    }
  }

  saveCompletionReview(
    workItemId: string,
    evidenceId: string,
    decision: CompletionReviewDecision
  ): CompletionReview {
    const db = getDatabase();
    const now = new Date().toISOString();
    const existing = this.findCompletionReview(workItemId, evidenceId);
    if (existing) {
      db.prepare(`
        UPDATE completion_reviews SET decision = ?, updated_at = ? WHERE id = ?
      `).run(decision, now, existing.id);
      return this.findCompletionReview(workItemId, evidenceId)!;
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO completion_reviews (
        id, work_item_id, evidence_id, decision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, workItemId, evidenceId, decision, now, now);
    return this.findCompletionReview(workItemId, evidenceId)!;
  }

  findCompletionReview(workItemId: string, evidenceId: string): CompletionReview | null {
    const row = getDatabase().prepare(`
      SELECT * FROM completion_reviews WHERE work_item_id = ? AND evidence_id = ?
    `).get(workItemId, evidenceId) as CompletionReviewRow | undefined;
    return row ? rowToReview(row) : null;
  }

  findCompletionReviewsForWorkItems(workItemIds: string[]): CompletionReview[] {
    const ids = [...new Set(workItemIds)].filter(Boolean);
    if (ids.length === 0) return [];
    const rows = getDatabase().prepare(`
      SELECT * FROM completion_reviews
      WHERE work_item_id IN (${ids.map(() => '?').join(', ')})
    `).all(...ids) as CompletionReviewRow[];
    return rows.map(rowToReview);
  }
}

export const taskDispatchRepository = new TaskDispatchRepository();
