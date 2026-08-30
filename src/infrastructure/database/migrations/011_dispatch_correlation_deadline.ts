import type { Migration } from './index.js';
import { execSql, getDatabase } from '../sqlite.js';

export const migration011: Migration = {
  version: 11,
  name: 'dispatch_correlation_deadline',
  up: () => {
    const columns = getDatabase().prepare('PRAGMA table_info(task_dispatches)')
      .all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === 'correlation_deadline_at')) {
      execSql(`
        ALTER TABLE task_dispatches
        ADD COLUMN correlation_deadline_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
      `);
    }
  },
  // SQLite cannot safely remove the column on all supported versions. Leaving it in place
  // makes rollback/reapply deterministic; migration010 owns the table lifecycle.
  down: () => {},
};
