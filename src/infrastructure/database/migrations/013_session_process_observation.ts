import type { Migration } from './index.js';
import { execSql, getDatabase } from '../sqlite.js';

export const migration013: Migration = {
  version: 13,
  name: 'session_process_observation',
  up: () => {
    const columns = getDatabase().prepare('PRAGMA table_info(sessions)')
      .all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === 'was_process_observed')) {
      execSql(`
        ALTER TABLE sessions
        ADD COLUMN was_process_observed INTEGER NOT NULL DEFAULT 0
      `);
    }
  },
  // SQLite cannot safely remove the column on all supported versions.
  down: () => {},
};
