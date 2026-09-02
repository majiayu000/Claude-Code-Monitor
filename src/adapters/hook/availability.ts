import { getHookStatus } from './installer.js';
import { getHookServerUrl, isHookServerRunning } from './server.js';
import { logger } from '../../lib/logger.js';
import { getDaemonStatus } from '../../services/daemon.manager.js';

export interface HookAvailability {
  installed: boolean;
  installation: 'none' | 'partial' | 'all';
  receiverRunning: boolean;
  degraded: boolean;
  settingsPath: string;
  hookCommand: string;
  hookServerUrl: string;
  targets: Array<{
    runtimeId: 'claude-code' | 'codex';
    installed: boolean;
    settingsPath: string;
    trustStatus: 'not-required' | 'runtime-managed';
  }>;
}

export function buildHookAvailability(input: {
  installed: boolean;
  installation?: HookAvailability['installation'];
  receiverRunning: boolean;
  settingsPath: string;
  hookCommand: string;
  hookServerUrl: string;
  targets?: HookAvailability['targets'];
}): HookAvailability {
  const installation = input.installation ?? (input.installed ? 'all' : 'none');
  return {
    ...input,
    installation,
    targets: input.targets ?? [],
    degraded: installation !== 'none' && !input.receiverRunning,
  };
}

export type HookHealthProbe = (url: string, timeoutMs: number) => Promise<boolean>;

export function isKeeplineHookHealth(payload: unknown): boolean {
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    (payload as { service?: unknown }).service === 'keepline-hook-receiver'
  );
}

async function probeHookHealth(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${url}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    return isKeeplineHookHealth(await response.json());
  } catch (error) {
    logger.debug('Hook receiver health probe failed', error);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function isHookReceiverRunning(input: {
  localServerRunning: boolean;
  daemonRunning: boolean;
  hookServerUrl: string;
  timeoutMs?: number;
  probe?: HookHealthProbe;
}): Promise<boolean> {
  if (input.localServerRunning) return true;

  const timeoutMs = input.timeoutMs ?? 250;
  const probe = input.probe ?? probeHookHealth;
  return probe(input.hookServerUrl, timeoutMs);
}

export async function getHookAvailability(): Promise<HookAvailability> {
  const status = getHookStatus();
  const daemon = getDaemonStatus();
  const hookServerUrl = getHookServerUrl();
  return buildHookAvailability({
    installed: status.installed,
    installation: status.installation,
    receiverRunning: await isHookReceiverRunning({
      localServerRunning: isHookServerRunning(),
      daemonRunning: daemon.running,
      hookServerUrl,
    }),
    settingsPath: status.settingsPath,
    hookCommand: status.hookCommand,
    hookServerUrl,
    targets: status.targets,
  });
}
