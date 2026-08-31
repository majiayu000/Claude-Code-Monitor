/**
 * Database layer exports
 */

// SQLite connection
export {
  getDatabase,
  closeDatabase,
  transaction,
  isDatabaseInitialized,
  runSql,
  execSql,
  queryAll,
  queryOne,
} from './sqlite.js';

// Migrations
export {
  runMigration,
  rollbackMigration,
  runAllMigrations,
  getCurrentVersion,
  isMigrationApplied,
  getAppliedMigrations,
} from './migrations/index.js';

export type { Migration } from './migrations/index.js';

export { allMigrations } from './migrations/all.js';

// Repositories
export { sessionRepository } from './repositories/session.repository.js';
export { memoryRepository } from './repositories/memory.repository.js';
export type { IMemoryRepository } from './repositories/memory.repository.js';
export { workItemRepository } from './repositories/work-item.repository.js';
export type { IWorkItemRepository } from './repositories/work-item.repository.js';
export { workItemEvidenceRepository } from './repositories/work-item-evidence.repository.js';
export type {
  IWorkItemEvidenceRepository,
} from './repositories/work-item-evidence.repository.js';
export { sessionDigestRepository } from './repositories/session-digest.repository.js';
export type {
  ISessionDigestRepository,
} from './repositories/session-digest.repository.js';
export { taskDispatchRepository } from './repositories/task-dispatch.repository.js';
