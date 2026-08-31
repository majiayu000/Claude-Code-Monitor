import { beforeEach, describe, expect, test } from 'bun:test';
import { resetDatabase } from '../db/migrations.js';
import { getDatabase } from '../infrastructure/database/sqlite.js';
import { migration010 } from '../infrastructure/database/migrations/010_stash_integration.js';
import { migration011 } from '../infrastructure/database/migrations/011_dispatch_correlation_deadline.js';
import {
  isMigrationApplied,
  rollbackMigration,
  runMigration,
} from '../infrastructure/database/migrations/index.js';

describe('stash integration migration rerun', () => {
  beforeEach(() => resetDatabase());

  test('rolls migration010 down and up repeatedly without duplicate-column failure', () => {
    rollbackMigration(migration011);
    rollbackMigration(migration010);
    runMigration(migration010);
    expect(isMigrationApplied(10)).toBe(true);

    rollbackMigration(migration010);
    runMigration(migration010);
    runMigration(migration011);

    const workItemColumns = getDatabase().prepare('PRAGMA table_info(work_items)')
      .all() as Array<{ name: string }>;
    const dispatchColumns = getDatabase().prepare('PRAGMA table_info(task_dispatches)')
      .all() as Array<{ name: string }>;
    expect(workItemColumns.filter((column) => column.name === 'external_source')).toHaveLength(1);
    expect(workItemColumns.filter((column) => column.name === 'external_id')).toHaveLength(1);
    expect(dispatchColumns.filter((column) => column.name === 'correlation_deadline_at')).toHaveLength(1);
  });
});
