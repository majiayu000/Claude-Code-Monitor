import { migration001 } from '../infrastructure/database/migrations/001_initial.js';
import { migration004 } from '../infrastructure/database/migrations/004_sessions_last_message.js';
import { migration005 } from '../infrastructure/database/migrations/005_session_metadata.js';
import { migration006 } from '../infrastructure/database/migrations/006_session_client.js';
import { migration007 } from '../infrastructure/database/migrations/007_work_items.js';
import { migration008 } from '../infrastructure/database/migrations/008_work_item_evidence.js';
import { migration010 } from '../infrastructure/database/migrations/010_stash_integration.js';
import { migration011 } from '../infrastructure/database/migrations/011_dispatch_correlation_deadline.js';
import { migration012 } from '../infrastructure/database/migrations/012_unique_dispatch_session_claim.js';
import { migration013 } from '../infrastructure/database/migrations/013_session_process_observation.js';
import { migration014 } from '../infrastructure/database/migrations/014_session_status_source.js';
import { runAllMigrations } from '../infrastructure/database/migrations/index.js';
import { execSql } from '../infrastructure/database/sqlite.js';
import { logger } from '../lib/logger.js';

// Service Mode intentionally excludes memory and session-digest migrations. The selected
// migrations are SQLite-only schema modules required by local auth, sessions and work items.
const serviceMigrations = [
  migration001,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
];

export function runServiceMigrations(): void {
  runAllMigrations(serviceMigrations);
  ensureServiceAuthSchema();
  logger.info('Service database migrations completed');
}

export const serviceMigrationVersions = serviceMigrations.map((migration) => migration.version);

function ensureServiceAuthSchema(): void {
  // Do not mark the full terminal-auth migration as applied: web mode can later add its
  // terminal session tables. Service Mode needs only local-user tokens and audit records.
  execSql(`
    CREATE TABLE IF NOT EXISTS terminal_users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS terminal_auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES terminal_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS terminal_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT NOT NULL,
      ip TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_auth_sessions_user
      ON terminal_auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_terminal_auth_sessions_expires
      ON terminal_auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_terminal_audit_log_user
      ON terminal_audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_terminal_audit_log_created
      ON terminal_audit_log(created_at);
  `);
}
