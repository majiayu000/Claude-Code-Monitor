import { afterAll, expect, test } from 'bun:test';
import { resetDatabase } from '../../db/migrations.js';
import { closeDatabase, queryOne, runSql } from '../../infrastructure/database/sqlite.js';

afterAll(() => closeDatabase());

test('opens only the preload-provided isolated database', () => {
  resetDatabase();
  runSql('CREATE TABLE preload_probe (value TEXT NOT NULL)');
  runSql('INSERT INTO preload_probe (value) VALUES (?)', ['isolated']);
  expect(queryOne<{ value: string }>('SELECT value FROM preload_probe')?.value).toBe('isolated');
});

