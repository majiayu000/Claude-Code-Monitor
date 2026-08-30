import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { queryOne, runSql, closeDatabase } from '../infrastructure/database/sqlite.js';
import { resetDatabase, runMigrations } from '../db/migrations.js';
import { memoryRepository } from '../infrastructure/database/index.js';
import { setupUser } from '../services/auth.service.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';

describe('resetDatabase', () => {
  beforeEach(() => {
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
  });

  test('clears newer tables and reapplies migrations', async () => {
    runMigrations();
    await setupUser('reset-user', 'password123');
    sessionRepository.upsert({
      sessionId: 'session-reset-test',
      directory: '/tmp/reset-test',
      status: 'running',
    });
    memoryRepository.upsert({
      sessionId: 'session-reset-test',
      directory: '/tmp/reset-test',
      lastProgress: 'in progress',
    });
    runSql(
      'INSERT INTO terminal_sessions (id, user_id, pid, cwd, status) VALUES (?, ?, ?, ?, ?)',
      ['pty-test', queryOne<{ id: string }>('SELECT id FROM terminal_users LIMIT 1')!.id, 1234, '/tmp/reset-test', 'running']
    );

    resetDatabase();

    expect(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM terminal_users')?.count).toBe(0);
    expect(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM session_memories')?.count).toBe(0);
    expect(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM terminal_sessions')?.count).toBe(0);
    expect((queryOne<{ count: number }>('SELECT COUNT(*) as count FROM schema_migrations')?.count ?? 0)).toBeGreaterThan(0);
  });

  test('sets a non-zero SQLite busy timeout', () => {
    expect(queryOne<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(5000);
  });

  test('drops optional events table during reset', () => {
    runSql(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        aggregate_id TEXT,
        payload TEXT,
        timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    runSql(
      'INSERT INTO events (type, aggregate_id, payload, timestamp) VALUES (?, ?, ?, ?)',
      ['test.event', 'aggregate-1', '{}', '2026-04-13T10:00:00.000Z']
    );

    resetDatabase();

    expect(queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'"
    ) ?? undefined).toBeUndefined();
  });

  test('refuses non-test, symlinked, and marker-mismatched reset targets', () => {
    const isolatedHome = process.env.KEEPLINE_HOME;
    const isolatedTestHome = process.env.KEEPLINE_TEST_HOME;
    const isolatedMarker = process.env.KEEPLINE_TEST_ISOLATED;
    if (!isolatedHome || !isolatedTestHome || isolatedMarker !== '1') {
      throw new Error('Keepline test preload did not establish an isolated home');
    }
    const fakePersistentRoot = mkdtempSync(join(tmpdir(), 'keepline-persistent-fixture-'));
    const fakePersistentHome = join(fakePersistentRoot, 'data');
    const mismatchHome = mkdtempSync(join(tmpdir(), 'keepline-test-mismatch-'));
    mkdirSync(fakePersistentHome);
    try {
      process.env.KEEPLINE_HOME = fakePersistentHome;
      expect(() => resetDatabase()).toThrow('Refusing to reset non-isolated Keepline database');

      const symlinkHome = join(isolatedTestHome, 'persistent-link');
      symlinkSync(fakePersistentHome, symlinkHome);
      process.env.KEEPLINE_HOME = symlinkHome;
      expect(() => resetDatabase()).toThrow('Refusing to reset non-isolated Keepline database');

      process.env.KEEPLINE_HOME = isolatedHome;
      delete process.env.KEEPLINE_TEST_ISOLATED;
      expect(() => resetDatabase()).toThrow('Refusing to reset non-isolated Keepline database');

      process.env.KEEPLINE_TEST_ISOLATED = isolatedMarker;
      process.env.KEEPLINE_TEST_HOME = mismatchHome;
      expect(() => resetDatabase()).toThrow('Refusing to reset non-isolated Keepline database');
    } finally {
      if (isolatedHome === undefined) delete process.env.KEEPLINE_HOME;
      else process.env.KEEPLINE_HOME = isolatedHome;
      if (isolatedTestHome === undefined) delete process.env.KEEPLINE_TEST_HOME;
      else process.env.KEEPLINE_TEST_HOME = isolatedTestHome;
      if (isolatedMarker === undefined) delete process.env.KEEPLINE_TEST_ISOLATED;
      else process.env.KEEPLINE_TEST_ISOLATED = isolatedMarker;
      rmSync(fakePersistentRoot, { recursive: true, force: true });
      rmSync(mismatchHome, { recursive: true, force: true });
    }
  });
});
