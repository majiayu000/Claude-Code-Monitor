import { getHookStatus } from './installer.js';
import { getHookServerUrl, isHookServerRunning } from './server.js';
import { logger } from '../../lib/logger.js';
import { getDaemonStatus } from '../../services/daemon.manager.js';

export interface HookAvailability {
  installed: boolean;
  receiverRunning: boolean;
  degraded: boolean;
  settingsPath: string;
  hookCommand: string;
  hookServerUrl: string;
}

export function buildHookAvailability(input: {
  installed: boolean;
  receiverRunning: boolean;
  settingsPath: string;
  hookCommand: string;
  hookServerUrl: string;
}): HookAvailability {
  return {
    ...input,
    degraded: input.installed && !input.receiverRunning,
  };
}

export type HookHealthProbe = (url: string, timeoutMs: number) => Promise<boolean>;

async function probeHookHealth(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${url}/health`, {
      signal: controller.signal,
    });
    return response.ok;
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
    receiverRunning: await isHookReceiverRunning({
      localServerRunning: isHookServerRunning(),
      daemonRunning: daemon.running,
      hookServerUrl,
    }),
    settingsPath: status.settingsPath,
    hookCommand: status.hookCommand,
    hookServerUrl,
  });
}
