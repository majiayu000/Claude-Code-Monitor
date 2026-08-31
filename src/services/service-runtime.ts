import type { Server } from 'bun';
import { runServiceMigrations } from '../local-api/migrations.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';
import { events } from '../lib/events.js';
import { createLocalApiApp } from '../local-api/app.js';
import { createRecoveryProcessRunner } from '../local-api/routes/recovery.js';
import { localServiceState } from '../local-api/service-state.js';
import { replaceRuntimeScanStatus, type RuntimeScanSummary } from './runtime-status.js';
import {
  startLifecycleReceiver,
  type LifecycleReceiver,
} from '../adapters/hook/completion-receiver.js';

const SCAN_RESULT_PREFIX = '__KEEPLINE_SERVICE_SCAN__';

export interface KeeplineService {
  server: Server<unknown>;
  hookPort: number;
  stop(): Promise<void>;
}

export interface KeeplineServiceOptions {
  port?: number;
  hookPort?: number;
  /** Periodic transcript scan interval. Zero disables the periodic timer. */
  scanIntervalMs?: number;
  scanTimeoutMs?: number;
  scanKillGraceMs?: number;
  scanOutputLimitBytes?: number;
  /** Test/support override. Production resolves the isolated scan from the current entrypoint. */
  scanCommand?: string[];
  /** Test/support override. Production resolves recovery through an isolated child process. */
  recoveryCommand?: string[];
}

const DEFAULT_SCAN_TIMEOUT_MS = 30_000;
const DEFAULT_SCAN_KILL_GRACE_MS = 1_000;
const DEFAULT_SCAN_OUTPUT_LIMIT_BYTES = 512 * 1024;

function isAllowedLoopbackRequestHost(req: Request, port: number): boolean {
  const hostHeader = req.headers.get('host');
  if (!hostHeader) return false;
  try {
    const url = new URL(`http://${hostHeader}`);
    const hostname = url.hostname.toLowerCase();
    const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' ||
      hostname === '[::1]' || hostname === '::1';
    return isLoopback && (!url.port || Number(url.port) === port);
  } catch {
    return false;
  }
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  byteLimit: number
): Promise<string> {
  const reader = stream.getReader();
  let retained = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength >= byteLimit) {
        retained = value.slice(value.byteLength - byteLimit);
        continue;
      }
      const keepFromPrevious = Math.min(retained.byteLength, byteLimit - value.byteLength);
      const next = new Uint8Array(keepFromPrevious + value.byteLength);
      next.set(retained.slice(retained.byteLength - keepFromPrevious));
      next.set(value, keepFromPrevious);
      retained = next;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(retained);
}

function waitForExit(
  process: ReturnType<typeof Bun.spawn>,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    process.exited.then(() => finish(true), () => finish(true));
  });
}

async function terminateProcess(
  process: ReturnType<typeof Bun.spawn>,
  graceMs: number
): Promise<void> {
  if (await waitForExit(process, 0)) return;
  process.kill('SIGTERM');
  if (await waitForExit(process, graceMs)) return;
  process.kill('SIGKILL');
  await waitForExit(process, graceMs);
}

export async function startKeeplineService(
  options: KeeplineServiceOptions | number = {}
): Promise<KeeplineService> {
  const port = typeof options === 'number' ? options : (options.port ?? 3377);
  const hookPort = typeof options === 'number'
    ? config.get().hookPort
    : (options.hookPort ?? config.get().hookPort);
  const configuredScanInterval = typeof options === 'number'
    ? 60_000
    : (options.scanIntervalMs ?? 60_000);
  const scanTimeoutMs = typeof options === 'number'
    ? DEFAULT_SCAN_TIMEOUT_MS
    : (options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS);
  const scanKillGraceMs = typeof options === 'number'
    ? DEFAULT_SCAN_KILL_GRACE_MS
    : (options.scanKillGraceMs ?? DEFAULT_SCAN_KILL_GRACE_MS);
  const scanOutputLimitBytes = typeof options === 'number'
    ? DEFAULT_SCAN_OUTPUT_LIMIT_BYTES
    : (options.scanOutputLimitBytes ?? DEFAULT_SCAN_OUTPUT_LIMIT_BYTES);
  if (!Number.isFinite(configuredScanInterval) || configuredScanInterval < 0) {
    throw new Error('Service scan interval must be zero or a positive number');
  }
  if (!Number.isInteger(hookPort) || hookPort < 0 || hookPort > 65535) {
    throw new Error('Invalid completion hook port');
  }
  if (!Number.isFinite(scanTimeoutMs) || scanTimeoutMs <= 0 ||
      !Number.isFinite(scanKillGraceMs) || scanKillGraceMs < 0 ||
      !Number.isInteger(scanOutputLimitBytes) || scanOutputLimitBytes < 1_024) {
    throw new Error('Invalid service scan process limits');
  }
  const entrypoint = process.argv[1];
  const configuredRecoveryCommand = typeof options === 'number'
    ? undefined
    : options.recoveryCommand;
  const recoveryCommand = configuredRecoveryCommand ??
    (entrypoint ? [process.execPath, entrypoint, '_service-recovery'] : []);
  runServiceMigrations();
  const app = createLocalApiApp({
    recoveryRunner: createRecoveryProcessRunner(recoveryCommand),
  });
  const hostname = '127.0.0.1';
  const server = Bun.serve({
    hostname,
    port,
    fetch(req, bunServer) {
      if (!isAllowedLoopbackRequestHost(req, bunServer.port ?? port)) {
        return new Response('Forbidden', { status: 403 });
      }
      return app.fetch(req, { server: bunServer });
    },
  });
  let lifecycleReceiver: LifecycleReceiver;
  try {
    lifecycleReceiver = startLifecycleReceiver(hookPort);
  } catch (error) {
    server.stop(true);
    closeDatabase();
    throw error;
  }
  localServiceState.lifecycleHook.receiverRunning = true;
  localServiceState.lifecycleHook.port = lifecycleReceiver.port;

  let stopped = false;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let scanPromise: Promise<void> | undefined;
  let scanProcess: ReturnType<typeof Bun.spawn> | undefined;
  let nextScanDelayMs = configuredScanInterval;
  let continueCorrelation = false;
  let rescanRequested = false;
  localServiceState.scan.running = false;
  localServiceState.scan.completed = false;
  localServiceState.scan.lastStartedAt = undefined;
  localServiceState.scan.lastCompletedAt = undefined;
  localServiceState.scan.lastError = undefined;
  const scan = async () => {
    if (stopped) return;
    if (localServiceState.scan.running) {
      rescanRequested = true;
      return;
    }
    localServiceState.scan.running = true;
    localServiceState.scan.lastStartedAt = new Date();
    localServiceState.scan.lastError = undefined;
    try {
      const command = typeof options === 'number' ? undefined : options.scanCommand;
      if (!command && !entrypoint) throw new Error('Unable to resolve Keepline service entrypoint');
      const child = Bun.spawn(
        command ?? [process.execPath, entrypoint!, '_service-scan'],
        {
          env: process.env,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      scanProcess = child;
      if (!child.stdout || typeof child.stdout === 'number' ||
          !child.stderr || typeof child.stderr === 'number') {
        child.kill('SIGTERM');
        throw new Error('Unable to capture isolated session scan output');
      }
      const stdoutPromise = readBoundedText(child.stdout, scanOutputLimitBytes);
      const stderrPromise = readBoundedText(child.stderr, scanOutputLimitBytes);
      if (!await waitForExit(child, scanTimeoutMs)) {
        await terminateProcess(child, scanKillGraceMs);
        const stderr = await stderrPromise;
        await stdoutPromise;
        throw new Error(
          `Session scan timed out after ${scanTimeoutMs} ms${stderr.trim() ? `: ${stderr.trim()}` : ''}`
        );
      }
      const exitCode = await child.exited;
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      if (scanProcess === child) scanProcess = undefined;
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `Session scan exited with status ${exitCode}`);
      }
      const resultLine = stdout.split('\n').find((line) => line.startsWith(SCAN_RESULT_PREFIX));
      if (!resultLine) throw new Error('Session scan returned no result payload');
      const payload = JSON.parse(resultLine.slice(SCAN_RESULT_PREFIX.length)) as {
        runtimeScan?: RuntimeScanSummary[];
        pendingDispatches?: number;
      };
      if (Array.isArray(payload.runtimeScan)) {
        replaceRuntimeScanStatus(payload.runtimeScan);
      }
      continueCorrelation = typeof payload.pendingDispatches === 'number' &&
        payload.pendingDispatches > 0;
      nextScanDelayMs = continueCorrelation
        ? (configuredScanInterval === 0 ? 3_000 : Math.min(configuredScanInterval, 3_000))
        : configuredScanInterval;
      localServiceState.scan.completed = true;
      localServiceState.scan.lastCompletedAt = new Date();
    } catch (error) {
      localServiceState.scan.lastError = error instanceof Error ? error.message : String(error);
      if (!stopped) logger.error('Service scan failed', error);
    } finally {
      scanProcess = undefined;
      localServiceState.scan.running = false;
    }
  };

  const scheduleScan = (delayMs: number) => {
    if (stopped) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      scanPromise = scan().finally(() => {
        scanPromise = undefined;
        if (stopped) return;
        if (rescanRequested) {
          rescanRequested = false;
          scheduleScan(0);
        } else if (continueCorrelation || configuredScanInterval > 0) {
          scheduleScan(nextScanDelayMs);
        }
      });
    }, delayMs);
  };

  // Leave a short window for health/meta requests before transcript parsing begins.
  scheduleScan(250);
  const requestScan = () => {
    if (stopped) return;
    if (localServiceState.scan.running) {
      rescanRequested = true;
      return;
    }
    scheduleScan(250);
  };
  events.on('dispatch:created', requestScan);
  events.on('session:turn-ended', requestScan);
  events.on('session:completed', requestScan);

  logger.info(
    `Keepline service available at http://${hostname}:${server.port} ` +
    `(lifecycle hooks: ${lifecycleReceiver.port})`
  );
  return {
    server,
    hookPort: lifecycleReceiver.port,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (scanTimer) clearTimeout(scanTimer);
      events.off('dispatch:created', requestScan);
      events.off('session:turn-ended', requestScan);
      events.off('session:completed', requestScan);
      if (scanProcess) await terminateProcess(scanProcess, scanKillGraceMs);
      if (scanPromise) {
        await Promise.race([
          scanPromise,
          new Promise<void>((resolve) => setTimeout(resolve, scanKillGraceMs * 2 + 100)),
        ]);
      }
      try {
        lifecycleReceiver.stop();
      } finally {
        localServiceState.lifecycleHook.receiverRunning = false;
        localServiceState.lifecycleHook.port = undefined;
        server.stop(true);
        closeDatabase();
      }
    },
  };
}
