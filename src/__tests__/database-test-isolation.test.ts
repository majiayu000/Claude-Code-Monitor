import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test('a child bun test without Keepline env cannot touch the default-home database', () => {
  const fakeUserHome = mkdtempSync(join(tmpdir(), 'keepline-fake-user-'));
  const persistentHome = join(fakeUserHome, '.keepline');
  const persistentDatabase = join(persistentHome, 'keepline.db');
  mkdirSync(persistentHome, { recursive: true });
  const sentinel = new Database(persistentDatabase);
  sentinel.exec(`
    CREATE TABLE user_sentinel (value TEXT NOT NULL);
    INSERT INTO user_sentinel (value) VALUES ('do-not-touch');
  `);
  sentinel.close();
  const beforeBytes = readFileSync(persistentDatabase);
  const beforeMtime = statSync(persistentDatabase).mtimeMs;

  const childEnv: Record<string, string | undefined> = { ...process.env, HOME: fakeUserHome };
  delete childEnv.KEEPLINE_HOME;
  delete childEnv.KEEPLINE_TEST_HOME;
  delete childEnv.KEEPLINE_TEST_ISOLATED;
  const child = Bun.spawnSync(
    [process.execPath, 'test', 'src/__tests__/fixtures/database-preload-child.test.ts'],
    { cwd: process.cwd(), env: childEnv, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(child.exitCode).toBe(0);

  expect(readFileSync(persistentDatabase)).toEqual(beforeBytes);
  expect(statSync(persistentDatabase).mtimeMs).toBe(beforeMtime);
  const persisted = new Database(persistentDatabase, { readonly: true });
  const row = persisted.query('SELECT value FROM user_sentinel').get() as { value: string };
  persisted.close();
  expect(row.value).toBe('do-not-touch');
});
