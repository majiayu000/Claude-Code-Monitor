import { getDatabase } from '../infrastructure/database/sqlite.js';
import { runAllMigrations, allMigrations } from '../infrastructure/database/index.js';
import { logger } from '../lib/logger.js';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import { KEEPLINE_DB, getKeeplineDb, getKeeplineHome } from '../lib/paths.js';

/** Run all migrations */
export function runMigrations(): void {
  runAllMigrations(allMigrations);
  logger.info('Database migrations completed');
}

/** Reset database (for testing) */
export function resetDatabase(): void {
  assertSafeTestDatabaseReset();
  const db = getDatabase();
  db.exec(`
    DROP TABLE IF EXISTS completion_reviews;
    DROP TABLE IF EXISTS task_dispatches;
    DROP TABLE IF EXISTS progress_evidence;
    DROP TABLE IF EXISTS session_digests;
    DROP TABLE IF EXISTS work_item_session_links;
    DROP TABLE IF EXISTS agent_sessions;
    DROP TABLE IF EXISTS work_items;
    DROP TABLE IF EXISTS areas;
    DROP TABLE IF EXISTS terminal_sessions;
    DROP TABLE IF EXISTS terminal_audit_log;
    DROP TABLE IF EXISTS terminal_auth_sessions;
    DROP TABLE IF EXISTS terminal_users;
    DROP TABLE IF EXISTS session_memories;
    DROP TABLE IF EXISTS tool_usage;
    DROP TABLE IF EXISTS hook_events;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS metadata;
    DROP TABLE IF EXISTS schema_migrations;
  `);
  runMigrations();
  logger.info('Database reset completed');
}

function canonicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return join(existsSync(parent) ? realpathSync(parent) : resolve(parent), basename(path));
}

/** Hard stop before destructive test-only schema drops can reach persistent user data. */
export function assertSafeTestDatabaseReset(): void {
  const declaredTestHome = process.env.KEEPLINE_TEST_HOME;
  const isolated = process.env.KEEPLINE_TEST_ISOLATED === '1';
  const testHome = declaredTestHome ? canonicalPath(declaredTestHome) : '';
  const configuredHome = canonicalPath(getKeeplineHome());
  const configuredDatabase = canonicalPath(getKeeplineDb());
  const openedDatabase = canonicalPath(KEEPLINE_DB);
  const canonicalTmp = realpathSync(tmpdir());
  const safeTestRoot = isolated && !!testHome &&
    testHome.startsWith(`${canonicalTmp}${sep}`) &&
    basename(testHome).startsWith('keepline-test-');
  const expectedDatabase = testHome ? join(testHome, 'keepline.db') : '';
  const exactIsolatedTarget = safeTestRoot && configuredHome === testHome &&
    configuredDatabase === expectedDatabase && openedDatabase === expectedDatabase;

  if (!exactIsolatedTarget) {
    throw new Error(
      `Refusing to reset non-isolated Keepline database: ${configuredDatabase}`
    );
  }
}
