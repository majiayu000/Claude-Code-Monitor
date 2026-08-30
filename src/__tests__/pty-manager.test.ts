import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ptyManager } from '../services/pty.manager.js';
import { config } from '../lib/config.js';
import { resetDatabase } from '../db/migrations.js';
import { closeDatabase, queryOne } from '../infrastructure/database/sqlite.js';
import { setupUser } from '../services/auth.service.js';

const shellCommand = process.env.SHELL || '/bin/sh';
const mockClient = { send() {} };
const tempDirs: string[] = [];

function createExitScript(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'keepline-pty-'));
  tempDirs.push(dir);
  const filePath = join(dir, name);
  writeFileSync(filePath, `#!/bin/sh\n${body}\n`);
  chmodSync(filePath, 0o755);
  return filePath;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for PTY state');
}

describe('PTY session ownership', () => {
  const originalTerminalConfig = { ...config.get().webTerminal };
  let ownerId = '';

  beforeEach(async () => {
    resetDatabase();
    config.set('webTerminal', {
      ...config.get().webTerminal,
      shellCommand,
    });

    await setupUser('pty-owner', 'password123');
    ownerId = queryOne<{ id: string }>(
      'SELECT id FROM terminal_users WHERE username = ?',
      ['pty-owner']
    )!.id;
  });

  afterEach(() => {
    ptyManager.cleanup();
    config.set('webTerminal', originalTerminalConfig);
    closeDatabase();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  test('rejects attach for a different user', async () => {
    const session = await ptyManager.create(ownerId, 80, 24, process.cwd());
    expect(() => ptyManager.attach(session.id, 'owner-b', mockClient)).toThrow('Forbidden');
  });

  test('rejects write and kill for a different user', async () => {
    const session = await ptyManager.create(ownerId, 80, 24, process.cwd());
    expect(() => ptyManager.write(session.id, 'owner-b', 'pwd\n')).toThrow('Forbidden');
    expect(() => ptyManager.kill(session.id, 'owner-b')).toThrow('Forbidden');
  });

  test('rejects unsafe resume session IDs before spawning a PTY', async () => {
    await expect(
      ptyManager.create(ownerId, 80, 24, process.cwd(), 'safe1234;touch-owned')
    ).rejects.toThrow('Invalid session ID format');

    expect(ptyManager.listSessions(ownerId)).toHaveLength(0);
  });

  test('removes exited sessions that have no attached clients', async () => {
    const exitScript = createExitScript('exit-no-clients.sh', 'printf "done\\n"\nsleep 0.05');
    config.set('webTerminal', {
      ...config.get().webTerminal,
      shellCommand: exitScript,
    });

    const session = await ptyManager.create(ownerId, 80, 24, process.cwd());
    await waitFor(() => !ptyManager.sessions.has(session.id));

    expect(ptyManager.listSessions(ownerId)).toHaveLength(0);
  });

  test('removes exited sessions after the last attached client detaches', async () => {
    const exitScript = createExitScript('exit-detach-cleanup.sh', 'printf "done\\n"\nsleep 0.05');
    config.set('webTerminal', {
      ...config.get().webTerminal,
      shellCommand: exitScript,
    });

    const session = await ptyManager.create(ownerId, 80, 24, process.cwd());
    ptyManager.attach(session.id, ownerId, mockClient);

    await waitFor(() => ptyManager.sessions.get(session.id)?.status === 'exited');

    const exitedSession = ptyManager.sessions.get(session.id);
    expect(exitedSession).toBeDefined();
    expect((exitedSession?.scrollbackBytes || 0) > 0).toBe(true);

    ptyManager.detach(session.id, ownerId, mockClient);

    expect(ptyManager.sessions.has(session.id)).toBe(false);
  });
});
