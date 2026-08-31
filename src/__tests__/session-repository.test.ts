import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetDatabase } from '../db/migrations.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';

describe('Session Repository Upsert', () => {
  beforeEach(() => {
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
  });

  test('preserves pid and tty when omitted from an update', () => {
    sessionRepository.upsert({
      sessionId: 'session-preserve',
      directory: '/tmp/repo',
      status: 'running',
      title: 'Initial',
      initialPrompt: 'Prompt',
      pid: 1234,
      tty: 'ttys001',
      lastActiveAt: new Date('2026-04-13T15:00:00.000Z'),
      toolCount: 1,
      messageCount: 1,
    });

    const updated = sessionRepository.upsert({
      sessionId: 'session-preserve',
      title: 'Updated',
      toolCount: 2,
    });

    expect(updated.pid).toBe(1234);
    expect(updated.tty).toBe('ttys001');
    expect(updated.title).toBe('Updated');
    expect(updated.toolCount).toBe(2);
  });

  test('clears pid and tty when explicitly updated to undefined', () => {
    sessionRepository.upsert({
      sessionId: 'session-clear',
      directory: '/tmp/repo',
      status: 'running',
      title: 'Initial',
      initialPrompt: 'Prompt',
      pid: 5678,
      tty: 'ttys002',
      lastActiveAt: new Date('2026-04-13T15:00:00.000Z'),
      toolCount: 1,
      messageCount: 1,
    });

    const updated = sessionRepository.upsert({
      sessionId: 'session-clear',
      pid: undefined,
      tty: undefined,
    });

    expect(updated.pid).toBeUndefined();
    expect(updated.tty).toBeUndefined();
  });

  test('persists multi-agent metadata, usage stats, and tool calls (issue #13)', () => {
    const created = sessionRepository.upsert({
      sessionId: 'session-metadata',
      directory: '/tmp/repo',
      status: 'running',
      title: 'Meta',
      initialPrompt: 'Prompt',
      lastActiveAt: new Date('2026-04-13T15:00:00.000Z'),
      toolCount: 3,
      messageCount: 5,
      agentId: 'agent-xyz',
      parentSessionId: 'parent-session-1',
      isSubAgent: true,
      usageStats: {
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalTokens: 300,
        totalCost: 0.42,
        apiCalls: 7,
      },
      toolCalls: [
        { name: 'Read', input: { file: 'a.ts' }, timestamp: '2026-04-13T15:00:00.000Z' },
        { name: 'Bash', input: { cmd: 'ls' }, timestamp: '2026-04-13T15:01:00.000Z' },
      ],
    });

    expect(created.agentId).toBe('agent-xyz');
    expect(created.parentSessionId).toBe('parent-session-1');
    expect(created.isSubAgent).toBe(true);
    expect(created.usageStats?.totalInputTokens).toBe(100);
    expect(created.usageStats?.totalCost).toBe(0.42);
    expect(created.usageStats?.apiCalls).toBe(7);
    expect(created.toolCalls).toHaveLength(2);
    expect(created.toolCalls?.[0].name).toBe('Read');

    // Re-read from DB to confirm true persistence, not just the in-memory return
    const fetched = sessionRepository.findBySessionId('session-metadata');
    expect(fetched?.agentId).toBe('agent-xyz');
    expect(fetched?.isSubAgent).toBe(true);
    expect(fetched?.usageStats?.totalTokens).toBe(300);
    expect(fetched?.toolCalls?.[1].name).toBe('Bash');
  });

  test('persists completedAt when inserting completed sessions', () => {
    const completedAt = new Date('2026-04-13T16:00:00.000Z');

    sessionRepository.upsert({
      sessionId: 'session-completed-insert',
      directory: '/tmp/repo',
      status: 'completed',
      title: 'Completed',
      initialPrompt: 'Prompt',
      startedAt: new Date('2026-04-13T15:00:00.000Z'),
      lastActiveAt: completedAt,
      completedAt,
      toolCount: 0,
      messageCount: 1,
    });

    const fetched = sessionRepository.findBySessionId('session-completed-insert');
    expect(fetched?.completedAt?.toISOString()).toBe('2026-04-13T16:00:00.000Z');
  });

  test('clears nullable activity fields when explicitly provided as undefined', () => {
    sessionRepository.upsert({
      sessionId: 'session-clear-nullable-fields',
      directory: '/tmp/repo',
      status: 'completed',
      title: 'Clear fields',
      initialPrompt: 'Prompt',
      lastTool: 'Read',
      lastToolInput: JSON.stringify({ path: '/tmp/repo/file.ts' }),
      currentFile: '/tmp/repo/file.ts',
      lastMessage: 'Done',
      completedAt: new Date('2026-04-13T16:00:00.000Z'),
      lastActiveAt: new Date('2026-04-13T16:00:00.000Z'),
      agentId: 'agent-1',
      parentSessionId: 'parent-1',
      usageStats: {
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalTokens: 30,
        totalCost: 0.12,
        apiCalls: 1,
      },
      toolCalls: [
        { name: 'Read', input: { path: '/tmp/repo/file.ts' }, timestamp: '2026-04-13T15:59:00.000Z' },
      ],
    });

    sessionRepository.upsert({
      sessionId: 'session-clear-nullable-fields',
      title: 'Still preserves omitted title updates',
      lastTool: undefined,
      lastToolInput: undefined,
      currentFile: undefined,
      lastMessage: undefined,
      completedAt: undefined,
      agentId: undefined,
      parentSessionId: undefined,
      usageStats: undefined,
      toolCalls: undefined,
    });

    const fetched = sessionRepository.findBySessionId('session-clear-nullable-fields');
    expect(fetched?.title).toBe('Still preserves omitted title updates');
    expect(fetched?.lastTool).toBeUndefined();
    expect(fetched?.lastToolInput).toBeUndefined();
    expect(fetched?.currentFile).toBeUndefined();
    expect(fetched?.lastMessage).toBeUndefined();
    expect(fetched?.completedAt).toBeUndefined();
    expect(fetched?.agentId).toBeUndefined();
    expect(fetched?.parentSessionId).toBeUndefined();
    expect(fetched?.usageStats).toBeUndefined();
    expect(fetched?.toolCalls).toBeUndefined();
  });

  test('keeps unobserved historical lost sessions out of the operational view', () => {
    const base = {
      directory: '/tmp/repo',
      title: 'Session',
      initialPrompt: 'Prompt',
      lastActiveAt: new Date('2026-04-13T15:00:00.000Z'),
      toolCount: 0,
      messageCount: 1,
    };

    sessionRepository.upsert({
      ...base,
      sessionId: 'historical-lost',
      status: 'lost',
    });
    sessionRepository.upsert({
      ...base,
      sessionId: 'observed-lost',
      status: 'lost',
      wasProcessObserved: true,
    });
    sessionRepository.upsert({
      ...base,
      sessionId: 'current-running',
      status: 'running',
    });
    sessionRepository.upsert({
      ...base,
      sessionId: 'explicitly-completed',
      status: 'completed',
    });

    expect(sessionRepository.findAll()).toHaveLength(4);
    expect(sessionRepository.findOperational().map((session) => session.sessionId).sort()).toEqual([
      'current-running',
      'explicitly-completed',
      'observed-lost',
    ]);
    expect(
      sessionRepository.findOperationalLightweight().map((session) => session.sessionId).sort()
    ).toEqual([
      'current-running',
      'explicitly-completed',
      'observed-lost',
    ]);
  });
});
