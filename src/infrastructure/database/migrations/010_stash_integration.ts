import type { Migration } from './index.js';
import { execSql, getDatabase } from '../sqlite.js';

function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = getDatabase().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    execSql(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const migration010: Migration = {
  version: 10,
  name: 'stash_integration',
  up: () => {
    addColumnIfMissing('work_items', 'external_source', 'TEXT');
    addColumnIfMissing('work_items', 'external_id', 'TEXT');
    execSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_external_identity
      ON work_items(external_source, external_id)
      WHERE external_source IS NOT NULL AND external_id IS NOT NULL
    `);
    execSql(`
      CREATE TABLE IF NOT EXISTS task_dispatches (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        prompt TEXT NOT NULL,
        terminal_app TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('queued', 'launching', 'awaiting_session', 'linked', 'ambiguous', 'failed', 'cancelled')),
        pre_launch_session_ids TEXT NOT NULL,
        candidate_session_ids TEXT NOT NULL DEFAULT '[]',
        linked_agent_session_id TEXT,
        error TEXT,
        launched_at TEXT,
        correlation_deadline_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        FOREIGN KEY (linked_agent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL
      )
    `);
    addColumnIfMissing(
      'task_dispatches',
      'correlation_deadline_at',
      `TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`
    );
    execSql(`
      CREATE INDEX IF NOT EXISTS idx_task_dispatches_state ON task_dispatches(state);
      CREATE INDEX IF NOT EXISTS idx_task_dispatches_work_item ON task_dispatches(work_item_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_dispatches_unique_agent_session_claim
        ON task_dispatches(linked_agent_session_id)
        WHERE linked_agent_session_id IS NOT NULL;
    `);
    execSql(`
      CREATE TABLE IF NOT EXISTS completion_reviews (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        FOREIGN KEY (evidence_id) REFERENCES progress_evidence(id) ON DELETE CASCADE,
        UNIQUE(work_item_id, evidence_id)
      )
    `);
  },
  down: () => {
    execSql('DROP TABLE IF EXISTS completion_reviews');
    execSql('DROP TABLE IF EXISTS task_dispatches');
    execSql('DROP INDEX IF EXISTS idx_task_dispatches_unique_agent_session_claim');
    execSql('DROP INDEX IF EXISTS idx_work_items_external_identity');
  },
};
