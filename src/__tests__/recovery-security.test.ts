import { describe, expect, test } from 'bun:test';
import type { Session } from '../domain/session/index.js';
import type {
  ISessionRepository,
  ActiveSessionRecord,
  ExistingSessionSummary,
  SessionUpsertData,
} from '../domain/session/repository.js';
import type { SessionStatus } from '../domain/session/value-objects.js';
import {
  buildCodexCommandArgs,
  buildClaudeCommand,
  buildClaudeCommandArgs,
  buildRecoveryCommand,
  buildRecoveryShellCommand,
  RecoveryService,
} from '../services/recovery.service.js';
import { scopeCodexSessionId } from '../adapters/codex/parser.js';
import type { CodexSessionFile } from '../adapters/codex/types.js';

function recoverySession(overrides: Partial<Session> = {}): Session {
  return {
    id: '1',
    sessionId: 'safe-session-123',
    client: 'claude',
    directory: process.cwd(),
    status: 'lost',
    statusSource: 'scan',
    title: 'Recover me',
    initialPrompt: 'Recover me',
    lastActiveAt: new Date(),
    toolCount: 0,
    messageCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createRepository(session: Session | null): ISessionRepository {
  return {
    findById: () => session,
    findBySessionId: (sessionId: string) =>
      session?.sessionId === sessionId ? session : null,
    findBySessionIds: () => session ? [session] : [],
    findBySessionIdsSummary: (): ExistingSessionSummary[] =>
      session ? [{
        sessionId: session.sessionId,
        client: session.client,
        status: session.status,
        statusSource: session.statusSource,
        title: session.title,
        lastActiveAt: session.lastActiveAt,
      }] : [],
    findAll: () => session ? [session] : [],
    findOperational: () => session ? [session] : [],
    findAllLightweight: () => [],
    findOperationalLightweight: () => [],
    findActive: () => session ? [session] : [],
    findActiveLightweight: (): ActiveSessionRecord[] => [],
    findByStatus: (status: SessionStatus) =>
      session?.status === status ? [session] : [],
    findByDirectory: (directory: string) =>
      session?.directory === directory ? [session] : [],
    upsert: (data: SessionUpsertData) => recoverySession({
      ...session,
      ...data,
      sessionId: data.sessionId,
    }),
    deleteOldSessions: () => 0,
    countByStatus: () => ({
      running: 0,
      waiting: 0,
      idle: 0,
      lost: session?.status === 'lost' ? 1 : 0,
      completed: 0,
    }),
  };
}

describe('recovery command security', () => {
  test('builds resume commands from structured argv', () => {
    expect(buildClaudeCommandArgs('resume', 'safe-session-123')).toEqual([
      'claude',
      '--resume',
      'safe-session-123',
    ]);
    expect(buildClaudeCommand('resume', 'safe-session-123')).toBe(
      'claude --resume safe-session-123'
    );
  });

  test('builds a paste-ready recovery command with a shell-safe cwd', () => {
    const session = recoverySession({
      directory: "/tmp/agent's project",
    });

    expect(buildRecoveryShellCommand(session, 'resume')).toBe(
      "cd '/tmp/agent'\\''s project' && claude --resume safe-session-123"
    );
  });

  test('rejects unsafe session IDs before rendering resume commands', () => {
    expect(() => buildClaudeCommand('resume', 'safe1234;touch-owned')).toThrow(
      'Invalid session ID format'
    );
    expect(() => buildClaudeCommand('new', 'safe1234;touch-owned')).toThrow(
      'Invalid session ID format'
    );
  });

  test('shell-quotes prompts used in new-session recovery commands', () => {
    expect(buildClaudeCommand('new', 'safe-session-123', "don't run; rm -rf /")).toBe(
      "claude 'don'\\''t run; rm -rf /'"
    );
  });

  test('builds Codex resume commands with unscoped session IDs', () => {
    expect(buildCodexCommandArgs('resume', 'codex_019ed4a3-2186-7e51-9aa1-ca1e376549b8')).toEqual([
      'codex',
      'resume',
      '019ed4a3-2186-7e51-9aa1-ca1e376549b8',
    ]);
    expect(buildCodexCommandArgs('continue', 'codex_019ed4a3-2186-7e51-9aa1-ca1e376549b8', undefined, true)).toEqual([
      'codex',
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
      '--last',
    ]);
  });

  test('builds recovery commands for the owning agent client', () => {
    const codexSession = recoverySession({
      client: 'codex',
      sessionId: 'codex_019ed4a3-2186-7e51-9aa1-ca1e376549b8',
    });

    expect(buildRecoveryCommand(codexSession, 'resume')).toBe(
      'codex resume 019ed4a3-2186-7e51-9aa1-ca1e376549b8'
    );
  });

  test('marks Codex sessions recoverable when their working directory exists', () => {
    const rawSessionId = '019ed4a3-2186-7e51-9aa1-ca1e376549b8';
    const sessionId = scopeCodexSessionId(rawSessionId);
    const codexFiles: CodexSessionFile[] = [{
      sessionId,
      rawSessionId,
      directory: process.cwd(),
      filePath: `/tmp/rollout-${rawSessionId}.jsonl`,
      modifiedAt: new Date(),
    }];

    const service = new RecoveryService(createRepository(null), () => codexFiles);
    const result = service.canRecover(recoverySession({
      client: 'codex',
      sessionId,
      directory: process.cwd(),
    }));

    expect(result).toEqual({
      canRecover: true,
      availableMethods: ['resume', 'continue', 'new'],
    });
  });

  test('does not offer Codex resume when the rollout file is missing', () => {
    const service = new RecoveryService(createRepository(null), () => []);
    const result = service.canRecover(recoverySession({
      client: 'codex',
      sessionId: 'codex_019ed4a3-2186-7e51-9aa1-ca1e376549b8',
      directory: process.cwd(),
    }));

    expect(result).toEqual({
      canRecover: true,
      availableMethods: ['continue', 'new'],
    });
  });

  test('does not build recovery commands for a missing working directory', () => {
    const service = new RecoveryService(createRepository(null), () => []);
    const result = service.canRecover(recoverySession({
      directory: `/tmp/keepline-missing-${process.pid}`,
    }));

    expect(result).toEqual({
      canRecover: false,
      reason: 'Session directory no longer exists',
      availableMethods: [],
    });
  });

  test('marks persisted sessions with unsafe IDs as unrecoverable', () => {
    const service = new RecoveryService(createRepository(recoverySession({
      sessionId: 'safe1234;touch-owned',
    })));

    const result = service.canRecover(recoverySession({
      sessionId: 'safe1234;touch-owned',
    }));

    expect(result).toEqual({
      canRecover: false,
      reason: 'Invalid session ID format',
      availableMethods: [],
    });
  });

  test('rejects invalid recovery requests before repository lookup', async () => {
    const service = new RecoveryService(createRepository(null));

    await expect(service.recoverSession({
      method: 'resume',
      sessionId: 'safe1234;touch-owned',
      directory: process.cwd(),
      openTerminal: false,
    })).rejects.toThrow('Invalid session ID format');
  });
});
