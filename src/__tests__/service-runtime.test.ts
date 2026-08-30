import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { emit } from '../lib/events.js';
import { serviceMigrationVersions } from '../local-api/migrations.js';
import { startKeeplineService, type KeeplineService } from '../services/service-runtime.js';

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
    expect(serviceMigrationVersions).toEqual([1, 4, 5, 6, 7, 8, 10, 11, 12]);
  });

  test('uses watchdog TERM then KILL and bounds captured child output', async () => {
    const script = `
      process.stderr.write('x'.repeat(100000));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    liveService = await startKeeplineService({
      port: 0,
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

  test('does not lose a dispatch wake-up during a scan when interval is zero', async () => {
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
      scanIntervalMs: 0,
      scanTimeoutMs: 2_000,
      scanCommand: [process.execPath, '-e', script],
    });
    await waitUntil(() => Number(readFileSync(counterPath, 'utf8')) === 1);
    emit('dispatch:created', { dispatchId: 'rescan-test' });
    await waitUntil(() => Number(readFileSync(counterPath, 'utf8')) >= 2);
    expect(Number(readFileSync(counterPath, 'utf8'))).toBe(2);
  });

  test('allows local auth in actual loopback service mode despite a wildcard web host env', async () => {
    const previousHost = process.env.KEEPLINE_HOST;
    process.env.KEEPLINE_HOST = '0.0.0.0';
    try {
      liveService = await startKeeplineService({
        port: 0,
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
