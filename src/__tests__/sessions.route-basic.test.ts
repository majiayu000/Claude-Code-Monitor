import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sessions from '../web/api/routes/sessions.js';
import { setupUser } from '../services/auth.service.js';
import { resetDatabase } from '../db/migrations.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import {
  clearRuntimeScanStatus,
  recordRuntimeScanFailures,
} from '../services/runtime-status.js';

describe('Basic Sessions Route Contract', () => {
  const tmpRoots: string[] = [];

  beforeEach(() => {
    resetDatabase();
    clearRuntimeScanStatus();
  });

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    closeDatabase();
    clearRuntimeScanStatus();
  });

  function makeGitProject(prefix: string): { root: string; nested: string } {
    const root = mkdtempSync(join(tmpdir(), prefix));
    tmpRoots.push(root);
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    return { root, nested };
  }

  test('fields=basic returns lightweight session payloads with persisted usageStats', async () => {
    sessionRepository.upsert({
      sessionId: 'session-basic-1',
      directory: '/tmp/keepline-basic-contract',
      status: 'running',
      title: 'Investigate hot loop',
      initialPrompt: 'Profile the parser',
      lastTool: 'Edit',
      lastToolInput: JSON.stringify({ path: '/tmp/keepline-basic-contract/src/parser.ts' }),
      currentFile: '/tmp/keepline-basic-contract/src/parser.ts',
      lastMessage: 'Working on it',
      startedAt: new Date('2026-04-13T10:00:00.000Z'),
      lastActiveAt: new Date('2026-04-13T10:00:05.000Z'),
      toolCount: 4,
      messageCount: 2,
      usageStats: {
        totalInputTokens: 1200,
        totalOutputTokens: 300,
        totalTokens: 1500,
        totalCost: 1.25,
        apiCalls: 4,
      },
    });

    const { token } = await setupUser('basic-route-user', 'password123');
    const response = await sessions.fetch(new Request(
      'http://localhost/?skipSync=true&fields=basic',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: {
        sessions: Array<Record<string, unknown>>;
        stats: { total: number; lost: number };
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.stats.total).toBe(1);
    expect(body.data.stats.lost).toBe(1);
    expect(body.data.sessions).toHaveLength(1);

    const session = body.data.sessions[0];
    expect(session).toMatchObject({
      sessionId: 'session-basic-1',
      directory: '/tmp/keepline-basic-contract',
      title: 'Investigate hot loop',
      status: 'lost',
      toolCount: 4,
      messageCount: 2,
      processRunning: false,
      usageStats: {
        totalInputTokens: 1200,
        totalOutputTokens: 300,
        totalTokens: 1500,
        totalCost: 1.25,
        apiCalls: 4,
      },
    });
    expect(session.startedAt).toBe('2026-04-13T10:00:00.000Z');
    expect(session.lastActiveAt).toBe('2026-04-13T10:00:05.000Z');
    expect('initialPrompt' in session).toBe(false);
    expect('lastMessage' in session).toBe(false);
    expect('lastTool' in session).toBe(false);
    expect('lastToolInput' in session).toBe(false);
  });

  test('details returns null usageStats when parsed source data is unavailable', async () => {
    sessionRepository.upsert({
      sessionId: 'session-no-source',
      directory: '/tmp/keepline-no-source',
      status: 'completed',
      title: 'No parsed source',
      initialPrompt: 'No source',
      lastActiveAt: new Date('2026-04-13T10:00:05.000Z'),
      toolCount: 0,
      messageCount: 1,
    });

    const { token } = await setupUser('details-route-user', 'password123');
    const response = await sessions.fetch(new Request(
      'http://localhost/session-no-source/details',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: {
        usageStats: unknown;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.usageStats).toBeNull();
  });

  test('single session route includes runtimeId payload field', async () => {
    sessionRepository.upsert({
      sessionId: 'single-codex-runtime-session',
      client: 'codex',
      directory: '/tmp/keepline-single-runtime',
      status: 'completed',
      title: 'Single runtime payload',
      initialPrompt: 'Return runtimeId',
      lastActiveAt: new Date('2026-04-13T10:00:05.000Z'),
      toolCount: 0,
      messageCount: 1,
    });

    const { token } = await setupUser('single-runtime-route-user', 'password123');
    const response = await sessions.fetch(new Request(
      'http://localhost/single-codex-runtime-session',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: {
        session: {
          sessionId: string;
          client: string;
          runtimeId?: string;
        };
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.session).toMatchObject({
      sessionId: 'single-codex-runtime-session',
      client: 'codex',
      runtimeId: 'codex',
    });
  });

  test('single session route includes a complete recovery command', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'keepline-recovery-command-'));
    tmpRoots.push(directory);

    sessionRepository.upsert({
      sessionId: 'copy-recovery-command-session',
      client: 'claude',
      directory,
      status: 'lost',
      title: 'Copy recovery command',
      initialPrompt: 'Recover from the original working directory',
      lastActiveAt: new Date('2026-04-13T10:00:05.000Z'),
      toolCount: 0,
      messageCount: 1,
    });

    const { token } = await setupUser('recovery-command-route-user', 'password123');
    const response = await sessions.fetch(new Request(
      'http://localhost/copy-recovery-command-session',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: {
        recovery: {
          canRecover: boolean;
          recommendedMethod?: string;
          command?: string;
        };
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.recovery).toMatchObject({
      canRecover: true,
      recommendedMethod: 'continue',
      command: `cd ${directory} && claude --continue`,
    });
  });

  test('projectRoot filters sessions by resolved git root exactly', async () => {
    const target = makeGitProject('keepline-target-project-');
    const other = makeGitProject('keepline-other-project-');

    sessionRepository.upsert({
      sessionId: 'target-project-session',
      client: 'claude',
      directory: target.nested,
      status: 'running',
      title: 'Target project',
      initialPrompt: 'Target',
      lastActiveAt: new Date('2026-04-13T10:00:05.000Z'),
      toolCount: 4,
      messageCount: 2,
    });
    sessionRepository.upsert({
      sessionId: 'other-project-session',
      client: 'codex',
      directory: other.nested,
      status: 'running',
      title: 'Other project',
      initialPrompt: 'Other',
      lastActiveAt: new Date('2026-04-13T10:00:06.000Z'),
      toolCount: 4,
      messageCount: 2,
    });

    const { token } = await setupUser('project-filter-route-user', 'password123');
    const params = new URLSearchParams({
      skipSync: 'true',
      fields: 'basic',
      projectRoot: target.root,
    });
    const response = await sessions.fetch(new Request(
      `http://localhost/?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: {
        sessions: Array<{ sessionId: string; directory: string }>;
        stats: { total: number };
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.stats.total).toBe(1);
    expect(body.data.sessions).toHaveLength(1);
    expect(body.data.sessions[0]).toMatchObject({
      sessionId: 'target-project-session',
      directory: target.nested,
    });
  });

  test('projectRoot=Unknown filters sessions with missing project identity', async () => {
    sessionRepository.upsert({
      sessionId: 'unknown-project-session',
      client: 'claude',
      directory: '',
      status: 'running',
      title: 'Unknown project session',
      initialPrompt: 'Unknown',
      lastActiveAt: new Date('2026-04-13T10:00:05.000Z'),
      toolCount: 1,
      messageCount: 1,
    });
    sessionRepository.upsert({
      sessionId: 'known-project-session',
      client: 'codex',
      directory: '/tmp/keepline-known-project',
      status: 'running',
      title: 'Known project session',
      initialPrompt: 'Known',
      lastActiveAt: new Date('2026-04-13T10:00:06.000Z'),
      toolCount: 1,
      messageCount: 1,
    });

    const { token } = await setupUser('unknown-project-filter-route-user', 'password123');
    const params = new URLSearchParams({
      skipSync: 'true',
      fields: 'basic',
      projectRoot: 'Unknown',
    });
    const response = await sessions.fetch(new Request(
      `http://localhost/?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: {
        sessions: Array<{ sessionId: string; directory: string }>;
        stats: { total: number };
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.stats.total).toBe(1);
    expect(body.data.sessions.map(session => session.sessionId)).toEqual(['unknown-project-session']);
  });

  test('fields=basic search filters globally before pagination', async () => {
    sessionRepository.upsert({
      sessionId: 'session-search-match',
      directory: '/tmp/keepline-search',
      status: 'completed',
      title: 'Unrelated title',
      initialPrompt: 'Find the hidden global needle',
      lastActiveAt: new Date('2026-04-13T10:00:05.000Z'),
      toolCount: 0,
      messageCount: 1,
    });
    sessionRepository.upsert({
      sessionId: 'session-search-miss',
      directory: '/tmp/keepline-other',
      status: 'completed',
      title: 'Other work',
      initialPrompt: 'No matching text here',
      lastActiveAt: new Date('2026-04-13T10:00:06.000Z'),
      toolCount: 0,
      messageCount: 1,
    });

    const { token } = await setupUser('search-route-user', 'password123');
    const response = await sessions.fetch(new Request(
      'http://localhost/?skipSync=true&fields=basic&q=needle&limit=1',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: {
        sessions: Array<{ sessionId: string }>;
        pagination: { total: number; hasMore: boolean };
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.pagination.total).toBe(1);
    expect(body.data.pagination.hasMore).toBe(false);
    expect(body.data.sessions.map((session) => session.sessionId)).toEqual(['session-search-match']);
  });

  test('rejects invalid status filters instead of returning unfiltered sessions', async () => {
    sessionRepository.upsert({
      sessionId: 'session-invalid-status-filter',
      directory: '/tmp/keepline-invalid-status-filter',
      status: 'completed',
      title: 'Should not leak through invalid filter',
      initialPrompt: 'No source',
      lastActiveAt: new Date('2026-04-13T10:00:05.000Z'),
      toolCount: 0,
      messageCount: 1,
    });

    const { token } = await setupUser('invalid-status-route-user', 'password123');
    const response = await sessions.fetch(new Request(
      'http://localhost/?skipSync=true&fields=basic&status=runing',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(400);

    const body = await response.json() as {
      success: boolean;
      error: string;
      data?: { sessions: Array<{ sessionId: string }> };
    };

    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid status filter: runing');
    expect(body.data).toBeUndefined();
  });

  test('rejects invalid limit instead of returning a misleading empty page', async () => {
    const { token } = await setupUser('invalid-limit-route-user', 'password123');
    const response = await sessions.fetch(new Request(
      'http://localhost/?skipSync=true&fields=basic&limit=abc',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(400);

    const body = await response.json() as {
      success: boolean;
      error: string;
    };

    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid limit');
  });

  test('rejects invalid offset instead of returning a misleading page', async () => {
    const { token } = await setupUser('invalid-offset-route-user', 'password123');
    const response = await sessions.fetch(new Request(
      'http://localhost/?skipSync=true&fields=basic&offset=-1',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(400);

    const body = await response.json() as {
      success: boolean;
      error: string;
    };

    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid offset');
  });

  test('runtime filter composes with project, status, search, and pagination', async () => {
    const target = makeGitProject('keepline-runtime-target-');
    const other = makeGitProject('keepline-runtime-other-');

    sessionRepository.upsert({
      sessionId: 'runtime-target-codex-match',
      client: 'codex',
      directory: target.nested,
      status: 'completed',
      title: 'Runtime needle match',
      initialPrompt: 'Target Codex',
      lastActiveAt: new Date('2026-04-13T10:00:05.000Z'),
      toolCount: 1,
      messageCount: 1,
    });
    sessionRepository.upsert({
      sessionId: 'runtime-target-claude-miss',
      client: 'claude',
      directory: target.nested,
      status: 'completed',
      title: 'Runtime needle match',
      initialPrompt: 'Target Claude',
      lastActiveAt: new Date('2026-04-13T10:00:06.000Z'),
      toolCount: 1,
      messageCount: 1,
    });
    sessionRepository.upsert({
      sessionId: 'runtime-other-codex-miss',
      client: 'codex',
      directory: other.nested,
      status: 'completed',
      title: 'Runtime needle match',
      initialPrompt: 'Other Codex',
      lastActiveAt: new Date('2026-04-13T10:00:07.000Z'),
      toolCount: 1,
      messageCount: 1,
    });

    const { token } = await setupUser('runtime-filter-route-user', 'password123');
    const params = new URLSearchParams({
      skipSync: 'true',
      fields: 'basic',
      projectRoot: target.root,
      runtime: 'codex',
      status: 'completed',
      q: 'needle',
      limit: '1',
    });
    const response = await sessions.fetch(new Request(
      `http://localhost/?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: {
        sessions: Array<{ sessionId: string; client: string; runtimeId: string }>;
        pagination: { total: number; hasMore: boolean };
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.pagination).toMatchObject({ total: 1, hasMore: false });
    expect(body.data.sessions).toEqual([
      expect.objectContaining({
        sessionId: 'runtime-target-codex-match',
        client: 'codex',
        runtimeId: 'codex',
      }),
    ]);
  });

  test('rejects invalid runtime filters instead of returning unfiltered sessions', async () => {
    const { token } = await setupUser('invalid-runtime-route-user', 'password123');
    const response = await sessions.fetch(new Request(
      'http://localhost/?skipSync=true&fields=basic&runtime=cursor',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(400);

    const body = await response.json() as {
      success: boolean;
      error: string;
      data?: { sessions: Array<{ sessionId: string }> };
    };

    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid runtime filter: cursor');
    expect(body.data).toBeUndefined();
  });

  test('runtime scan degradation is surfaced without hiding sessions', async () => {
    sessionRepository.upsert({
      sessionId: 'runtime-scan-visible-session',
      client: 'claude',
      directory: '/tmp/keepline-runtime-scan-visible',
      status: 'completed',
      title: 'Visible despite runtime scan degradation',
      initialPrompt: 'Visible',
      lastActiveAt: new Date('2026-04-13T10:00:05.000Z'),
      toolCount: 1,
      messageCount: 1,
    });
    recordRuntimeScanFailures('codex', [{
      filePath: '/tmp/codex/bad-rollout.jsonl',
      message: 'Invalid JSONL',
    }]);

    const { token } = await setupUser('runtime-scan-route-user', 'password123');
    const response = await sessions.fetch(new Request(
      'http://localhost/?skipSync=true&fields=basic',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: {
        sessions: Array<{ sessionId: string }>;
        runtimeScan: Array<{
          runtimeId: string;
          degraded: boolean;
          errorCount: number;
          errors: Array<{ sourcePath?: string; message: string }>;
        }>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.sessions.map(session => session.sessionId)).toContain('runtime-scan-visible-session');
    expect(body.data.runtimeScan.find(scan => scan.runtimeId === 'codex')).toMatchObject({
      degraded: true,
      errorCount: 1,
      errors: [expect.objectContaining({
        sourcePath: '/tmp/codex/bad-rollout.jsonl',
        message: 'Invalid JSONL',
      })],
    });
  });
});
