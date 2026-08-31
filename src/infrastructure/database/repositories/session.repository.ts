/**
 * Session repository implementation
 */

import { randomUUID } from 'crypto';
import { getDatabase, transaction } from '../sqlite.js';
import type {
  ActiveSessionRecord,
  ExistingSessionSummary,
  Session,
  SessionListItem,
  SessionStatus,
  ToolCallInfo,
} from '../../../domain/session/index.js';
import type { ISessionRepository, SessionUpsertData } from '../../../domain/session/repository.js';

/** Database row type */
interface SessionRow {
  id: string;
  session_id: string;
  client: string;
  directory: string;
  status: string;
  title: string | null;
  initial_prompt: string;
  last_tool: string | null;
  last_tool_input: string | null;
  current_file: string | null;
  last_message: string | null;
  started_at: string | null;
  last_active_at: string;
  completed_at: string | null;
  pid: number | null;
  tty: string | null;
  tool_count: number;
  message_count: number;
  agent_id: string | null;
  parent_session_id: string | null;
  is_sub_agent: number;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_tokens: number | null;
  total_cost: number | null;
  api_calls: number | null;
  tool_calls: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionListRow {
  id: string;
  session_id: string;
  client: string;
  directory: string;
  status: string;
  title: string | null;
  started_at: string | null;
  last_active_at: string;
  completed_at: string | null;
  pid: number | null;
  tty: string | null;
  tool_count: number;
  message_count: number;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_tokens: number | null;
  total_cost: number | null;
  api_calls: number | null;
  created_at: string;
  updated_at: string;
}

interface ActiveSessionRow {
  session_id: string;
  client: string;
  status: string;
  pid: number | null;
}

interface ExistingSessionSummaryRow {
  session_id: string;
  client: string;
  status: string;
  title: string | null;
}

/** Safely parse the tool_calls JSON column (returns undefined on missing/corrupt data). */
function parseToolCalls(raw: string | null): ToolCallInfo[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ToolCallInfo[]) : undefined;
  } catch {
    return undefined;
  }
}

type UsageStatsRow = Pick<
  SessionRow,
  'total_input_tokens' | 'total_output_tokens' | 'total_tokens' | 'total_cost' | 'api_calls'
>;

function rowToUsageStats(row: UsageStatsRow): Session['usageStats'] {
  return row.total_tokens != null
    ? {
        totalInputTokens: row.total_input_tokens ?? 0,
        totalOutputTokens: row.total_output_tokens ?? 0,
        totalTokens: row.total_tokens ?? 0,
        totalCost: row.total_cost ?? 0,
        apiCalls: row.api_calls ?? 0,
      }
    : undefined;
}

/** Convert database row to Session entity */
function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    sessionId: row.session_id,
    client: row.client === 'codex' ? 'codex' : 'claude',
    directory: row.directory,
    status: row.status as SessionStatus,
    title: row.title || '',
    initialPrompt: row.initial_prompt,
    lastTool: row.last_tool || undefined,
    lastToolInput: row.last_tool_input || undefined,
    currentFile: row.current_file || undefined,
    lastMessage: row.last_message || undefined,
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    lastActiveAt: new Date(row.last_active_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    pid: row.pid || undefined,
    tty: row.tty || undefined,
    toolCount: row.tool_count,
    messageCount: row.message_count,
    agentId: row.agent_id || undefined,
    parentSessionId: row.parent_session_id || undefined,
    isSubAgent: row.is_sub_agent === 1,
    usageStats: rowToUsageStats(row),
    toolCalls: parseToolCalls(row.tool_calls),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToSessionListItem(row: SessionListRow): SessionListItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    client: row.client === 'codex' ? 'codex' : 'claude',
    directory: row.directory,
    status: row.status as SessionStatus,
    title: row.title || '',
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    lastActiveAt: new Date(row.last_active_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    pid: row.pid || undefined,
    tty: row.tty || undefined,
    toolCount: row.tool_count,
    messageCount: row.message_count,
    usageStats: rowToUsageStats(row),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToActiveSessionRecord(row: ActiveSessionRow): ActiveSessionRecord {
  return {
    sessionId: row.session_id,
    client: row.client === 'codex' ? 'codex' : 'claude',
    status: row.status as SessionStatus,
    pid: row.pid || undefined,
  };
}

function rowToExistingSessionSummary(row: ExistingSessionSummaryRow): ExistingSessionSummary {
  return {
    sessionId: row.session_id,
    client: row.client === 'codex' ? 'codex' : 'claude',
    status: row.status as SessionStatus,
    title: row.title || '',
  };
}

/** Session repository implementation */
class SessionRepository implements ISessionRepository {
  findById(id: string): Session | null {
    const db = getDatabase();
    const row = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  findBySessionId(sessionId: string): Session | null {
    const db = getDatabase();
    const row = db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get(sessionId) as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  findBySessionIds(sessionIds: string[]): Session[] {
    if (sessionIds.length === 0) {
      return [];
    }

    const db = getDatabase();
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT * FROM sessions WHERE session_id IN (${placeholders})`)
      .all(...sessionIds) as SessionRow[];

    return rows.map(rowToSession);
  }

  findBySessionIdsSummary(sessionIds: string[]): ExistingSessionSummary[] {
    if (sessionIds.length === 0) {
      return [];
    }

    const db = getDatabase();
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT session_id, client, status, title FROM sessions WHERE session_id IN (${placeholders})`)
      .all(...sessionIds) as ExistingSessionSummaryRow[];

    return rows.map(rowToExistingSessionSummary);
  }

  findAll(): Session[] {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT * FROM sessions ORDER BY last_active_at DESC')
      .all() as SessionRow[];

    return rows.map(rowToSession);
  }

  findOperational(): Session[] {
    const db = getDatabase();
    const rows = db
      .prepare(`
        SELECT * FROM sessions
        WHERE status != 'lost' OR was_process_observed = 1
        ORDER BY last_active_at DESC
      `)
      .all() as SessionRow[];

    return rows.map(rowToSession);
  }

  findAllLightweight(): SessionListItem[] {
    const db = getDatabase();
    const rows = db
      .prepare(`
        SELECT
          id,
          session_id,
          client,
          directory,
          status,
          title,
          started_at,
          last_active_at,
          completed_at,
          pid,
          tty,
          tool_count,
          message_count,
          total_input_tokens,
          total_output_tokens,
          total_tokens,
          total_cost,
          api_calls,
          created_at,
          updated_at
        FROM sessions
        ORDER BY last_active_at DESC
      `)
      .all() as SessionListRow[];

    return rows.map(rowToSessionListItem);
  }

  findOperationalLightweight(): SessionListItem[] {
    const db = getDatabase();
    const rows = db
      .prepare(`
        SELECT
          id,
          session_id,
          client,
          directory,
          status,
          title,
          started_at,
          last_active_at,
          completed_at,
          pid,
          tty,
          tool_count,
          message_count,
          total_input_tokens,
          total_output_tokens,
          total_tokens,
          total_cost,
          api_calls,
          created_at,
          updated_at
        FROM sessions
        WHERE status != 'lost' OR was_process_observed = 1
        ORDER BY last_active_at DESC
      `)
      .all() as SessionListRow[];

    return rows.map(rowToSessionListItem);
  }

  findActive(): Session[] {
    const db = getDatabase();
    const rows = db
      .prepare(`
        SELECT * FROM sessions
        WHERE status NOT IN ('completed', 'lost')
        ORDER BY last_active_at DESC
      `)
      .all() as SessionRow[];

    return rows.map(rowToSession);
  }

  findActiveLightweight(): ActiveSessionRecord[] {
    const db = getDatabase();
    const rows = db
      .prepare(`
        SELECT session_id, client, status, pid FROM sessions
        WHERE status NOT IN ('completed', 'lost')
      `)
      .all() as ActiveSessionRow[];

    return rows.map(rowToActiveSessionRecord);
  }

  findByStatus(status: SessionStatus): Session[] {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT * FROM sessions WHERE status = ? ORDER BY last_active_at DESC')
      .all(status) as SessionRow[];

    return rows.map(rowToSession);
  }

  findByDirectory(directory: string): Session[] {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT * FROM sessions WHERE directory = ? ORDER BY last_active_at DESC')
      .all(directory) as SessionRow[];

    return rows.map(rowToSession);
  }

  upsert(data: SessionUpsertData): Session {
    const db = getDatabase();
    const now = new Date().toISOString();

    return transaction(() => {
      const hasPid = 'pid' in data;
      const hasTty = 'tty' in data;
      const hasLastTool = 'lastTool' in data;
      const hasLastToolInput = 'lastToolInput' in data;
      const hasCurrentFile = 'currentFile' in data;
      const hasLastMessage = 'lastMessage' in data;
      const hasCompletedAt = 'completedAt' in data;
      const hasAgentId = 'agentId' in data;
      const hasParentSessionId = 'parentSessionId' in data;
      const hasUsageStats = 'usageStats' in data;
      const hasToolCalls = 'toolCalls' in data;
      const hasWasProcessObserved = 'wasProcessObserved' in data;
      const updateResult = db.prepare(`
        UPDATE sessions SET
          status = COALESCE(?, status),
          client = COALESCE(?, client),
          title = COALESCE(?, title),
          initial_prompt = COALESCE(?, initial_prompt),
          last_tool = CASE WHEN ? THEN ? ELSE last_tool END,
          last_tool_input = CASE WHEN ? THEN ? ELSE last_tool_input END,
          current_file = CASE WHEN ? THEN ? ELSE current_file END,
          last_message = CASE WHEN ? THEN ? ELSE last_message END,
          started_at = COALESCE(?, started_at),
          last_active_at = COALESCE(?, last_active_at),
          completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
          pid = CASE WHEN ? THEN ? ELSE pid END,
          tty = CASE WHEN ? THEN ? ELSE tty END,
          tool_count = COALESCE(?, tool_count),
          message_count = COALESCE(?, message_count),
          agent_id = CASE WHEN ? THEN ? ELSE agent_id END,
          parent_session_id = CASE WHEN ? THEN ? ELSE parent_session_id END,
          is_sub_agent = COALESCE(?, is_sub_agent),
          total_input_tokens = CASE WHEN ? THEN ? ELSE total_input_tokens END,
          total_output_tokens = CASE WHEN ? THEN ? ELSE total_output_tokens END,
          total_tokens = CASE WHEN ? THEN ? ELSE total_tokens END,
          total_cost = CASE WHEN ? THEN ? ELSE total_cost END,
          api_calls = CASE WHEN ? THEN ? ELSE api_calls END,
          tool_calls = CASE WHEN ? THEN ? ELSE tool_calls END,
          was_process_observed = CASE WHEN ? THEN ? ELSE was_process_observed END,
          updated_at = ?
        WHERE session_id = ?
      `).run(
        data.status ?? null,
        data.client ?? null,
        data.title ?? null,
        data.initialPrompt ?? null,
        hasLastTool ? 1 : 0,
        data.lastTool ?? null,
        hasLastToolInput ? 1 : 0,
        data.lastToolInput ?? null,
        hasCurrentFile ? 1 : 0,
        data.currentFile ?? null,
        hasLastMessage ? 1 : 0,
        data.lastMessage ?? null,
        data.startedAt?.toISOString() ?? null,
        data.lastActiveAt?.toISOString() ?? null,
        hasCompletedAt ? 1 : 0,
        data.completedAt?.toISOString() ?? null,
        hasPid ? 1 : 0,
        data.pid ?? null,
        hasTty ? 1 : 0,
        data.tty ?? null,
        data.toolCount ?? null,
        data.messageCount ?? null,
        hasAgentId ? 1 : 0,
        data.agentId ?? null,
        hasParentSessionId ? 1 : 0,
        data.parentSessionId ?? null,
        data.isSubAgent != null ? (data.isSubAgent ? 1 : 0) : null,
        hasUsageStats ? 1 : 0,
        data.usageStats?.totalInputTokens ?? null,
        hasUsageStats ? 1 : 0,
        data.usageStats?.totalOutputTokens ?? null,
        hasUsageStats ? 1 : 0,
        data.usageStats?.totalTokens ?? null,
        hasUsageStats ? 1 : 0,
        data.usageStats?.totalCost ?? null,
        hasUsageStats ? 1 : 0,
        data.usageStats?.apiCalls ?? null,
        hasToolCalls ? 1 : 0,
        data.toolCalls ? JSON.stringify(data.toolCalls) : null,
        hasWasProcessObserved ? 1 : 0,
        data.wasProcessObserved ? 1 : 0,
        now,
        data.sessionId
      );

      if (updateResult.changes > 0) {
        return this.findBySessionId(data.sessionId)!;
      }

      {
        // Insert new session
        const id = randomUUID();
        db.prepare(`
          INSERT INTO sessions (
            id, session_id, directory, status, title, initial_prompt,
            client,
            last_tool, last_tool_input, current_file, last_message,
            started_at, last_active_at, completed_at, pid, tty,
            tool_count, message_count,
            agent_id, parent_session_id, is_sub_agent,
            total_input_tokens, total_output_tokens, total_tokens, total_cost, api_calls,
            tool_calls,
            was_process_observed,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          data.sessionId,
          data.directory || '',
          data.status || 'idle',
          data.title || '',
          data.initialPrompt || '',
          data.client || 'claude',
          data.lastTool ?? null,
          data.lastToolInput ?? null,
          data.currentFile ?? null,
          data.lastMessage ?? null,
          data.startedAt?.toISOString() ?? null,
          data.lastActiveAt?.toISOString() || now,
          data.completedAt?.toISOString() ?? null,
          data.pid ?? null,
          data.tty ?? null,
          data.toolCount || 0,
          data.messageCount || 0,
          data.agentId ?? null,
          data.parentSessionId ?? null,
          data.isSubAgent ? 1 : 0,
          data.usageStats?.totalInputTokens ?? null,
          data.usageStats?.totalOutputTokens ?? null,
          data.usageStats?.totalTokens ?? null,
          data.usageStats?.totalCost ?? null,
          data.usageStats?.apiCalls ?? null,
          data.toolCalls ? JSON.stringify(data.toolCalls) : null,
          data.wasProcessObserved ? 1 : 0,
          now,
          now
        );

        return this.findBySessionId(data.sessionId)!;
      }
    });
  }

  deleteOldSessions(retentionDays: number, now: Date = new Date()): number {
    const db = getDatabase();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffIso = cutoff.toISOString();

    return transaction(() => {
      const beforeCount = (db.prepare(`
        SELECT COUNT(*) as count FROM sessions
        WHERE status = 'completed' AND last_active_at < ?
      `).get(cutoffIso) as { count: number }).count;

      db.prepare(`
        DELETE FROM tool_usage
        WHERE session_id IN (
          SELECT session_id FROM sessions
          WHERE status = 'completed' AND last_active_at < ?
        )
      `).run(cutoffIso);

      db.prepare(`
        DELETE FROM hook_events
        WHERE session_id IN (
          SELECT session_id FROM sessions
          WHERE status = 'completed' AND last_active_at < ?
        )
      `).run(cutoffIso);

      db.prepare(`
        DELETE FROM sessions
        WHERE status = 'completed' AND last_active_at < ?
      `).run(cutoffIso);

      return beforeCount;
    });
  }

  countByStatus(): Record<SessionStatus, number> {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT status, COUNT(*) as count FROM sessions GROUP BY status
    `).all() as Array<{ status: string; count: number }>;

    const result: Record<SessionStatus, number> = {
      running: 0,
      waiting: 0,
      idle: 0,
      lost: 0,
      completed: 0,
    };

    for (const row of rows) {
      result[row.status as SessionStatus] = row.count;
    }

    return result;
  }
}

/** Singleton instance */
export const sessionRepository = new SessionRepository();
