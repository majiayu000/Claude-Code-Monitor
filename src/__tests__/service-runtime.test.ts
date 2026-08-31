import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { emit } from '../lib/events.js';
import { serviceMigrationVersions } from '../local-api/migrations.js';
import { startKeeplineService, type KeeplineService } from '../services/service-runtime.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import { workItemEvidenceRepository } from '../infrastructure/database/repositories/work-item-evidence.repository.js';
import { workItemRepository } from '../infrastructure/database/repositories/work-item.repository.js';
import { getDatabase } from '../infrastructure/database/sqlite.js';
import { taskDispatchRepository } from '../infrastructure/database/repositories/task-dispatch.repository.js';
import { reconcileLinkedAgentSessions } from '../services/work-item-session-reconciler.js';

const SCAN_RESULT_PREFIX = '__KEEPLINE_SERVICE_SCAN__';
let liveService: KeeplineService | undefined;

interface BuildMetafile {
  inputs: Record<string, { imports: Array<{ path: string; kind: string }> }>;
}

afterEach(async () => {
  await liveService?.stop();
  liveService = undefined;
});

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Condition was not met within ${timeoutMs} ms`);
}

function successfulScanCommand(): string[] {
  const payload = JSON.stringify({ runtimeScan: [], pendingDispatches: 0 });
  return [process.execPath, '-e', `console.log(${JSON.stringify(SCAN_RESULT_PREFIX + payload)})`];
}

describe('service runtime isolation', () => {
  test('does not trust a completion claim when the canonical session is missing', async () => {
    liveService = await startKeeplineService({
      port: 0,
      hookPort: 0,
      scanIntervalMs: 0,
      scanCommand: successfulScanCommand(),
    });
    const sessionId = 'missing-canonical-session';
    const workItem = workItemRepository.create({ title: 'Do not trust stale links' });
    const agentSession = workItemEvidenceRepository.upsertAgentSession({
      runtimeId: 'claude-code',
      runtimeSessionId: sessionId,
      cwd: '/tmp/expected-project',
      status: 'running',
      title: 'Do not trust stale links',
    });
    workItemEvidenceRepository.createSessionLink({
      workItemId: workItem.id,
      agentSessionId: agentSession.id,
      linkSource: 'user',
    });

    const response = await fetch(`http://127.0.0.1:${liveService.hookPort}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: '/tmp/wrong-project',
        timestamp: '2026-08-30T10:07:00.000Z',
        last_assistant_message:
          `Done\nKEEPLINE_COMPLETE_WORK_ITEM:${workItem.id}`,
      }),
    });

    expect(response.status).toBe(404);
    expect(
      workItemEvidenceRepository.findLatestExplicitCompletionForAgentSession(agentSession.id)
    ).toBeNull();
  });

  test('does not promote a pending claim from a failed dispatch', async () => {
    liveService = await startKeeplineService({
      port: 0,
      hookPort: 0,
      scanIntervalMs: 0,
      scanCommand: successfulScanCommand(),
    });
    const sessionId = 'failed-dispatch-session';
    const workItem = workItemRepository.create({ title: 'Discard stale claim' });
    const dispatch = taskDispatchRepository.create({
      workItemId: workItem.id,
      runtimeId: 'claude-code',
      cwd: '/tmp/failed-dispatch',
      prompt: 'Discard stale claim',
      terminalApp: 'auto',
      idempotencyKey: 'failed-pending-claim',
      preLaunchSessionIds: [],
      correlationDeadlineAt: new Date('2026-08-30T10:20:00.000Z'),
    });
    taskDispatchRepository.updateState(dispatch.id, 'failed', {
      launchedAt: new Date('2026-08-30T10:00:00.000Z'),
    });
    sessionRepository.upsert({
      sessionId,
      client: 'claude',
      directory: '/tmp/failed-dispatch',
      status: 'running',
    });
    const agentSession = workItemEvidenceRepository.upsertAgentSession({
      runtimeId: 'claude-code',
      runtimeSessionId: sessionId,
      cwd: '/tmp/failed-dispatch',
      status: 'running',
      title: 'Discard stale claim',
    });
    workItemEvidenceRepository.createSessionLink({
      workItemId: workItem.id,
      agentSessionId: agentSession.id,
      linkSource: 'user',
    });
    const claimAt = new Date('2026-08-30T10:08:00.000Z');
    workItemEvidenceRepository.createProgressEvidence({
      workItemId: workItem.id,
      runtimeId: 'claude-code',
      kind: 'message',
      outcome: 'progress',
      confidence: 'inferred',
      summary: 'Stale completion claim',
      occurredAt: claimAt,
      metadata: {
        source: 'pending_agent_completion_claim',
        runtimeSessionId: sessionId,
        dispatchId: dispatch.id,
        cwd: '/tmp/failed-dispatch',
        claimAt: claimAt.toISOString(),
      },
    });

    reconcileLinkedAgentSessions();

    expect(
      workItemEvidenceRepository.findLatestExplicitCompletionForAgentSession(agentSession.id)
    ).toBeNull();
    expect(
      workItemEvidenceRepository.findPendingAgentCompletionClaims(workItem.id, sessionId)
    ).toHaveLength(0);
  });

  test('treats Claude Stop as a turn boundary, never task completion', async () => {
    liveService = await startKeeplineService({
      port: 0,
      hookPort: 0,
      scanIntervalMs: 0,
      scanCommand: successfulScanCommand(),
    });
    const metadataResponse = await fetch(
      `http://127.0.0.1:${liveService.server.port}/api/v1/meta`
    );
    const metadata = await metadataResponse.json() as {
      data: { runtimes: Array<{ id: string; capabilities: string[] }> };
    };
    const claudeCapabilities = metadata.data.runtimes.find(
      (runtime) => runtime.id === 'claude-code'
    )?.capabilities;
    expect(claudeCapabilities).toContain('session-lifecycle-hook-unconfigured');
    expect(claudeCapabilities).toContain('agent-completion-claim-hook-unconfigured');
    expect(claudeCapabilities).not.toContain('explicit-completion-hook');
    expect(claudeCapabilities).toContain('explicit-completion-manual-only');

    const sessionId = 'service-stop-session';
    sessionRepository.upsert({
      sessionId,
      client: 'claude',
      directory: '/tmp/service-stop',
      title: 'Exercise embedded completion',
      initialPrompt: 'Exercise embedded completion',
      status: 'running',
      startedAt: new Date('2026-08-30T10:00:00.000Z'),
      lastActiveAt: new Date('2026-08-30T10:00:00.000Z'),
      toolCount: 0,
      messageCount: 1,
    });

    const postStop = (body: Record<string, unknown>) => fetch(
      `http://127.0.0.1:${liveService!.hookPort}/hook`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'Stop',
          session_id: sessionId,
          cwd: '/tmp/service-stop',
          timestamp: '2026-08-30T10:05:00.000Z',
          ...body,
        }),
      }
    );

    expect((await postStop({ session_id: 'unknown-stop-session' })).status).toBe(404);
    expect((await postStop({ cwd: '/tmp/wrong-project' })).status).toBe(409);
    sessionRepository.upsert({
      sessionId: 'codex-stop-session',
      client: 'codex',
      directory: '/tmp/codex-stop',
      status: 'running',
    });
    expect((await postStop({
      session_id: 'codex-stop-session',
      cwd: '/tmp/codex-stop',
    })).status).toBe(409);

    const response = await postStop({ stop_reason: 'completed' });

    expect(response.status).toBe(200);
    expect(sessionRepository.findBySessionId(sessionId)).toMatchObject({
      status: 'running',
    });
    expect(sessionRepository.findBySessionId(sessionId)?.completedAt).toBeUndefined();
    expect((await postStop({ timestamp: '2026-08-30T10:06:00.000Z' })).status).toBe(200);
    expect(sessionRepository.findBySessionId(sessionId)?.completedAt).toBeUndefined();

    const workItem = workItemRepository.create({ title: 'Claimed work' });
    const agentSession = workItemEvidenceRepository.upsertAgentSession({
      runtimeId: 'claude-code',
      runtimeSessionId: sessionId,
      cwd: '/tmp/service-stop',
      status: 'running',
      title: 'Exercise embedded completion',
    });
    workItemEvidenceRepository.createSessionLink({
      workItemId: workItem.id,
      agentSessionId: agentSession.id,
      linkSource: 'user',
    });
    expect((await postStop({
      last_assistant_message: 'Done\nKEEPLINE_COMPLETE_WORK_ITEM:wrong-work-item',
    })).status).toBe(200);
    expect(
      workItemEvidenceRepository.findLatestExplicitCompletionForAgentSession(agentSession.id)
    ).toBeNull();

    const claimTimestamp = '2026-08-30T10:07:00.000Z';
    const claim = `Done and verified\nKEEPLINE_COMPLETE_WORK_ITEM:${workItem.id}`;
    expect((await postStop({
      timestamp: claimTimestamp,
      last_assistant_message: claim,
    })).status).toBe(200);
    const evidence = workItemEvidenceRepository
      .findLatestExplicitCompletionForAgentSession(agentSession.id);
    expect(evidence).toMatchObject({
      workItemId: workItem.id,
      outcome: 'completed',
      confidence: 'explicit',
      metadata: {
        source: 'agent_completion_claim',
        claimAt: claimTimestamp,
      },
    });
    expect(sessionRepository.findBySessionId(sessionId)?.completedAt).toBeUndefined();
    expect((await postStop({
      timestamp: claimTimestamp,
      last_assistant_message: claim,
    })).status).toBe(200);
    const claimCount = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM progress_evidence
      WHERE agent_session_id = ? AND json_extract(metadata, '$.source') = 'agent_completion_claim'
    `).get(agentSession.id) as { count: number };
    expect(claimCount.count).toBe(1);

    const pendingWorkItem = workItemRepository.create({ title: 'Fast completion claim' });
    const pendingSessionId = 'pending-stop-session';
    const pendingDispatch = taskDispatchRepository.create({
      workItemId: pendingWorkItem.id,
      runtimeId: 'claude-code',
      cwd: '/tmp/service-stop',
      prompt: 'Finish quickly',
      terminalApp: 'auto',
      idempotencyKey: 'pending-claim-dispatch',
      preLaunchSessionIds: [],
      correlationDeadlineAt: new Date('2026-08-30T10:20:00.000Z'),
    });
    taskDispatchRepository.updateState(pendingDispatch.id, 'awaiting_session', {
      launchedAt: new Date('2026-08-30T10:00:00.000Z'),
    });
    const pendingTimestamp = '2026-08-30T10:08:00.000Z';
    expect((await postStop({
      session_id: pendingSessionId,
      timestamp: pendingTimestamp,
      last_assistant_message:
        `Verified\nKEEPLINE_COMPLETE_WORK_ITEM:${pendingWorkItem.id}`,
    })).status).toBe(202);
    const pendingCount = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM progress_evidence
      WHERE work_item_id = ? AND json_extract(metadata, '$.source') = 'pending_agent_completion_claim'
    `).get(pendingWorkItem.id) as { count: number };
    expect(pendingCount.count).toBe(1);
    expect(
      workItemEvidenceRepository.findPendingAgentCompletionClaims(
        pendingWorkItem.id,
        pendingSessionId
      )[0]?.metadata?.dispatchId
    ).toBe(pendingDispatch.id);

    sessionRepository.upsert({
      sessionId: pendingSessionId,
      client: 'claude',
      directory: '/tmp/service-stop',
      title: 'Fast completion claim',
      status: 'running',
      lastActiveAt: new Date(pendingTimestamp),
    });
    const pendingAgentSession = workItemEvidenceRepository.upsertAgentSession({
      runtimeId: 'claude-code',
      runtimeSessionId: pendingSessionId,
      cwd: '/tmp/service-stop',
      status: 'running',
      title: 'Fast completion claim',
      lastActiveAt: new Date(pendingTimestamp),
    });
    taskDispatchRepository.claimAgentSession(
      pendingDispatch.id,
      pendingWorkItem.id,
      pendingAgentSession.id,
      pendingSessionId
    );
    reconcileLinkedAgentSessions();
    expect(
      workItemEvidenceRepository.findLatestExplicitCompletionForAgentSession(
        pendingAgentSession.id
      )
    ).toMatchObject({
      workItemId: pendingWorkItem.id,
      metadata: { source: 'agent_completion_claim', claimAt: pendingTimestamp },
    });

    const oversizedBody = JSON.stringify({
      hook_event_name: 'Notification',
      session_id: sessionId,
      cwd: '/tmp/service-stop',
      message: 'x'.repeat(70 * 1024),
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversizedBody));
        controller.close();
      },
    });
    const oversizedResponse = await fetch(
      `http://127.0.0.1:${liveService.hookPort}/hook`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
      }
    );
    expect(oversizedResponse.status).toBe(413);

    const hookPort = liveService.hookPort;
    await liveService.stop();
    liveService = undefined;
    await expect(fetch(`http://127.0.0.1:${hookPort}/health`)).rejects.toThrow();
  });

  test('keeps the static service graph free of heavy app-only modules', async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'keepline-service-graph-'));
    const buildWithMetafile = Bun.build as unknown as (
      options: Record<string, unknown>
    ) => Promise<{ success: boolean; metafile: BuildMetafile }>;
    const build = await buildWithMetafile({
      entrypoints: ['src/services/service-runtime.ts'],
      target: 'bun',
      splitting: true,
      outdir: outputDirectory,
      metafile: true,
    });
    expect(build.success).toBe(true);

    const inputs = build.metafile.inputs;
    const inputByAbsolutePath = new Map(
      Object.keys(inputs).map((path) => [resolve(path), path])
    );
    const reachable = new Set<string>();
    const queue = [resolve('src/services/service-runtime.ts')];
    while (queue.length > 0) {
      const absolute = queue.pop()!;
      if (reachable.has(absolute)) continue;
      reachable.add(absolute);
      const key = inputByAbsolutePath.get(absolute);
      if (!key) continue;
      for (const dependency of inputs[key].imports) {
        if (dependency.kind !== 'import-statement') continue;
        const child = resolve(dependency.path);
        if (inputByAbsolutePath.has(child)) queue.push(child);
      }
    }
    const forbidden = [...reachable].filter((path) =>
      /(?:memory|pricing|recovery\.service|services\/terminal\.ts|pty\.manager|web\/api\/routes\/(?:sessions|recovery|auth|work-items))/.test(path)
    );
    expect(forbidden).toEqual([]);
    expect(serviceMigrationVersions).toEqual([1, 4, 5, 6, 7, 8, 10, 11, 12, 13]);
  });

  test('uses watchdog TERM then KILL and bounds captured child output', async () => {
    const script = `
      process.stderr.write('x'.repeat(100000));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    liveService = await startKeeplineService({
      port: 0,
      hookPort: 0,
      scanIntervalMs: 0,
      scanTimeoutMs: 60,
      scanKillGraceMs: 30,
      scanOutputLimitBytes: 1_024,
      scanCommand: [process.execPath, '-e', script],
    });
    const baseURL = `http://127.0.0.1:${liveService.server.port}`;
    let error = '';
    await waitUntil(async () => {
      const response = await fetch(`${baseURL}/api/v1/health`);
      const body = await response.json() as { data: { scan: { lastError?: string } } };
      error = body.data.scan.lastError ?? '';
      return error.includes('timed out');
    });
    expect(error.length).toBeLessThan(1_200);

    const started = performance.now();
    await liveService.stop();
    liveService = undefined;
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('bounds shutdown while an uncooperative scan child is still running', async () => {
    const script = `
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    liveService = await startKeeplineService({
      port: 0,
      hookPort: 0,
      scanIntervalMs: 0,
      scanTimeoutMs: 10_000,
      scanKillGraceMs: 30,
      scanCommand: [process.execPath, '-e', script],
    });
    const baseURL = `http://127.0.0.1:${liveService.server.port}`;
    await waitUntil(async () => {
      const response = await fetch(`${baseURL}/api/v1/health`);
      const body = await response.json() as { data: { scan: { running: boolean } } };
      return body.data.scan.running;
    });

    const started = performance.now();
    await liveService.stop();
    liveService = undefined;
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('rescans promptly for dispatch, turn-boundary, and completion events', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'keepline-rescan-'));
    const counterPath = join(directory, 'count');
    writeFileSync(counterPath, '0');
    const script = `
      const fs = await import('fs');
      const path = ${JSON.stringify(counterPath)};
      const count = Number(fs.readFileSync(path, 'utf8')) + 1;
      fs.writeFileSync(path, String(count));
      if (count === 1) await Bun.sleep(150);
      console.log(${JSON.stringify(SCAN_RESULT_PREFIX)} + JSON.stringify({runtimeScan: [], pendingDispatches: 0}));
    `;
    liveService = await startKeeplineService({
      port: 0,
      hookPort: 0,
      scanIntervalMs: 0,
      scanTimeoutMs: 2_000,
      scanCommand: [process.execPath, '-e', script],
    });
    await waitUntil(() => Number(readFileSync(counterPath, 'utf8')) === 1);
    emit('dispatch:created', { dispatchId: 'rescan-test' });
    await waitUntil(() => Number(readFileSync(counterPath, 'utf8')) >= 2);
    emit('session:turn-ended', {
      sessionId: 'rescan-session',
      timestamp: new Date('2026-08-30T10:00:00.000Z'),
    });
    await waitUntil(() => Number(readFileSync(counterPath, 'utf8')) >= 3);
    const completedSession = sessionRepository.upsert({
      sessionId: 'rescan-session',
      status: 'completed',
      completedAt: new Date('2026-08-30T10:00:00.000Z'),
    });
    emit('session:completed', { session: completedSession });
    await waitUntil(() => Number(readFileSync(counterPath, 'utf8')) >= 4);
    expect(Number(readFileSync(counterPath, 'utf8'))).toBe(4);
  });

  test('allows local auth in actual loopback service mode despite a wildcard web host env', async () => {
    const previousHost = process.env.KEEPLINE_HOST;
    process.env.KEEPLINE_HOST = '0.0.0.0';
    try {
      liveService = await startKeeplineService({
        port: 0,
        hookPort: 0,
        scanIntervalMs: 0,
        scanCommand: successfulScanCommand(),
      });
      const response = await fetch(
        `http://127.0.0.1:${liveService.server.port}/api/v1/auth/local`,
        { method: 'POST' }
      );
      const body = await response.json() as { success: boolean; data?: { token?: string } };
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data?.token).toBeString();
    } finally {
      if (previousHost === undefined) delete process.env.KEEPLINE_HOST;
      else process.env.KEEPLINE_HOST = previousHost;
    }
  });
});
