import type { Migration } from './index.js';
import { execSql, getDatabase } from '../sqlite.js';

export const migration014: Migration = {
  version: 14,
  name: 'session_status_source',
  up: () => {
    const columns = getDatabase().prepare('PRAGMA table_info(sessions)')
      .all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === 'status_source')) {
      execSql(`
        ALTER TABLE sessions
        ADD COLUMN status_source TEXT NOT NULL DEFAULT 'scan'
      `);
    }
  },
  down: () => {},
};
