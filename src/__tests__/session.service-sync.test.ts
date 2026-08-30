import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tempDirs: string[] = [];

function createTempHome(): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'keepline-test-sync-home-'));
  tempDirs.push(homeDir);
  return homeDir;
}

function writeClaudeSessionFile(homeDir: string, sessionId: string): void {
  const projectDir = join(homeDir, '.claude', 'projects', '-tmp-completed-sync');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'user',
      uuid: 'user-1',
      sessionId,
      cwd: '/tmp/completed-sync',
      timestamp: '2026-04-13T16:05:00.000Z',
      userType: 'external',
      message: {
        role: 'user',
        content: 'Completed sync regression',
      },
    }) + '\n'
  );
}

function runSyncScript(homeDir: string, script: string): Record<string, unknown> {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '--eval', script],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      KEEPLINE_HOME: homeDir,
      KEEPLINE_TEST_HOME: homeDir,
      KEEPLINE_TEST_ISOLATED: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString() || `sync subprocess failed with code ${proc.exitCode}`);
  }

  const jsonLine = proc.stdout.toString().trim().split('\n').filter(Boolean).pop();
  if (!jsonLine) {
    throw new Error('sync subprocess produced no JSON output');
  }
  return JSON.parse(jsonLine) as Record<string, unknown>;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('SessionService sync', () => {
  test('preserves user-completed sessions during later file syncs', () => {
    const homeDir = createTempHome();
    const sessionId = 'completed-sync-1';
    writeClaudeSessionFile(homeDir, sessionId);

    const result = runSyncScript(homeDir, `
      const { resetDatabase } = await import('./src/db/migrations.ts');
      const { closeDatabase } = await import('./src/infrastructure/database/sqlite.ts');
      const { sessionRepository } = await import('./src/infrastructure/database/repositories/session.repository.ts');
      const { sessionService } = await import('./src/services/session.service.ts');

      resetDatabase();
      const completedAt = new Date('2026-04-13T16:00:00.000Z');
      sessionRepository.upsert({
        sessionId: ${JSON.stringify(sessionId)},
        client: 'claude',
        directory: '/tmp/completed-sync',
        status: 'completed',
        title: 'Completed task',
        initialPrompt: 'Completed sync regression',
        startedAt: new Date('2026-04-13T15:55:00.000Z'),
        lastActiveAt: completedAt,
        completedAt,
        pid: 999999,
        toolCount: 0,
        messageCount: 1,
      });

      const syncResult = await sessionService.syncSessions({ fullSync: true });
      const fetched = sessionRepository.findBySessionId(${JSON.stringify(sessionId)});
      console.log(JSON.stringify({
        syncResult,
        status: fetched?.status,
        completedAt: fetched?.completedAt?.toISOString(),
        lastActiveAt: fetched?.lastActiveAt.toISOString(),
        pid: fetched?.pid ?? null,
      }));
      closeDatabase();
    `);

    expect(result).toEqual({
      syncResult: { discovered: 0, updated: 1, lost: 0 },
      status: 'completed',
      completedAt: '2026-04-13T16:00:00.000Z',
      lastActiveAt: '2026-04-13T16:05:00.000Z',
      pid: null,
    });
  });
});
