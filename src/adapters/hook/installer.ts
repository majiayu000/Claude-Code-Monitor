/**
 * Claude Code and Codex hooks installer
 *
 * Registers a Keepline hook under Claude Code's matcher-block settings shape:
 *   hooks.<Event>[] = [{ matcher?, hooks: [{ type: "command", command }] }]
 *
 * The command forwards Claude's stdin hook JSON verbatim to the hook server;
 * it does not rely on `$CLAUDE_*` environment variables.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { CLAUDE_SETTINGS, getCodexHooksPath } from '../../lib/paths.js';
import { config } from '../../lib/config.js';
import { logger } from '../../lib/logger.js';
import type {
  ClaudeHookCommandHandler,
  ClaudeHookConfig,
  ClaudeHookMatcherGroup,
  ClaudeSettings,
  HookEventType,
} from './types.js';

const KEEPLINE_HOOK_MARKER = 'KEEPLINE_HOOK_MARKER=keepline-hook-v2';
const CLAUDE_HOOK_TYPES: HookEventType[] = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
];

const CODEX_HOOK_TYPES: HookEventType[] = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
];

const ALL_HOOK_TYPES = [...new Set([...CLAUDE_HOOK_TYPES, ...CODEX_HOOK_TYPES])];

type HookRuntimeId = 'claude-code' | 'codex';

interface HookTarget {
  runtimeId: HookRuntimeId;
  settingsPath: string;
  hookTypes: HookEventType[];
}

function getHookTargets(): HookTarget[] {
  return [
    { runtimeId: 'claude-code', settingsPath: CLAUDE_SETTINGS, hookTypes: CLAUDE_HOOK_TYPES },
    { runtimeId: 'codex', settingsPath: getCodexHooksPath(), hookTypes: CODEX_HOOK_TYPES },
  ];
}

/** Read one runtime's hook settings. */
function getHookSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) {
    logger.debug('Hook settings file not found, using defaults', { path: settingsPath });
    return {};
  }

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    return JSON.parse(content) as ClaudeSettings;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse hook settings at ${settingsPath}: ${message}`);
  }
}

/** Save hook settings while preserving unrelated keys and handlers. */
function saveHookSettings(settingsPath: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Generate the hook command.
 *
 * `--data-binary @-` forwards Claude's stdin JSON verbatim. The marker prefix
 * is a harmless env assignment used only to identify Keepline-owned hooks in
 * the settings file.
 */
function getHookCommand(
  port: number = config.get().hookPort,
  runtimeId: HookRuntimeId = 'claude-code'
): string {
  return `${KEEPLINE_HOOK_MARKER} curl -fsS -X POST "http://127.0.0.1:${port}/hook?runtime=${runtimeId}" -H "Content-Type: application/json" --data-binary @- > /dev/null 2>&1 || true`;
}

/** Detect the pre-v2 command that incorrectly relied on `$CLAUDE_*` env vars */
function isLegacyKeeplineHookCommand(command: string): boolean {
  return (
    command.includes('curl -s -X POST') &&
    /\bhttp:\/\/127\.0\.0\.1:\d+\/hook\b/.test(command) &&
    command.includes('"event_type":"$CLAUDE_EVENT_TYPE"') &&
    command.includes('"session_id":"$CLAUDE_SESSION_ID"') &&
    command.includes('"cwd":"$PWD"') &&
    command.includes('"tool_name":"$CLAUDE_TOOL_NAME"') &&
    command.includes('CLAUDE_TOOL_INPUT')
  );
}

/** Is this command string a Keepline-owned hook from any supported version? */
export function isKeeplineHookCommand(command: string): boolean {
  return command.includes(KEEPLINE_HOOK_MARKER) || isLegacyKeeplineHookCommand(command);
}

function isHookCommandHandler(hook: unknown): hook is ClaudeHookCommandHandler {
  return Boolean(
    hook &&
    typeof hook === 'object' &&
    typeof (hook as Partial<ClaudeHookCommandHandler>).command === 'string'
  );
}

function isHookMatcherGroup(hook: unknown): hook is ClaudeHookMatcherGroup {
  return Boolean(
    hook &&
    typeof hook === 'object' &&
    Array.isArray((hook as Partial<ClaudeHookMatcherGroup>).hooks)
  );
}

export function isKeeplineHook(hook: unknown): hook is ClaudeHookConfig {
  if (isHookCommandHandler(hook)) {
    return isKeeplineHookCommand(hook.command);
  }

  if (isHookMatcherGroup(hook)) {
    return hook.hooks.some(isKeeplineHook);
  }

  return false;
}

function removeKeeplineHooks(hooks: ClaudeHookConfig[]): ClaudeHookConfig[] {
  const nextHooks: ClaudeHookConfig[] = [];

  for (const hook of hooks) {
    if (isHookCommandHandler(hook)) {
      if (!isKeeplineHook(hook)) {
        nextHooks.push(hook);
      }
      continue;
    }

    if (isHookMatcherGroup(hook)) {
      const remainingHandlers = hook.hooks.filter((handler) => !isKeeplineHook(handler));
      if (remainingHandlers.length > 0) {
        nextHooks.push({
          ...hook,
          hooks: remainingHandlers,
        });
      }
      continue;
    }

    nextHooks.push(hook);
  }

  return nextHooks;
}

function countKeeplineHooks(hooks: ClaudeHookConfig[]): number {
  let count = 0;

  for (const hook of hooks) {
    if (isHookCommandHandler(hook)) {
      if (isKeeplineHook(hook)) {
        count++;
      }
      continue;
    }

    if (isHookMatcherGroup(hook)) {
      count += hook.hooks.filter(isKeeplineHook).length;
    }
  }

  return count;
}

function createKeeplineHookConfig(
  hookType: HookEventType,
  hookCommand: string
): ClaudeHookMatcherGroup {
  const hookConfig: ClaudeHookMatcherGroup = {
    hooks: [
      {
        type: 'command',
        command: hookCommand,
      },
    ],
  };

  if (hookType === 'PreToolUse' || hookType === 'PostToolUse') {
    hookConfig.matcher = '*';
  }

  return hookConfig;
}

export function installKeeplineHookConfig(
  settings: ClaudeSettings,
  hookCommand: string = getHookCommand(),
  hookTypes: HookEventType[] = CLAUDE_HOOK_TYPES
): boolean {
  const before = JSON.stringify(settings.hooks ?? {});

  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const hookType of hookTypes) {
    const existingHooks = settings.hooks[hookType] ?? [];
    settings.hooks[hookType] = [
      ...removeKeeplineHooks(existingHooks),
      createKeeplineHookConfig(hookType, hookCommand),
    ];
  }

  return JSON.stringify(settings.hooks) !== before;
}

export function uninstallKeeplineHookConfig(settings: ClaudeSettings): number {
  if (!settings.hooks) return 0;

  let removed = 0;
  for (const hookType of ALL_HOOK_TYPES) {
    const hooks = settings.hooks[hookType];
    if (!hooks) continue;
    removed += countKeeplineHooks(hooks);
    settings.hooks[hookType] = removeKeeplineHooks(hooks);
  }

  return removed;
}

function hasKeeplineHook(settings: ClaudeSettings, hookTypes: HookEventType[]): boolean {
  return hookTypes.every((hookType) => settings.hooks?.[hookType]?.some(isKeeplineHook));
}

export function hasCurrentLifecycleHook(
  settings: ClaudeSettings,
  hookCommand: string = getHookCommand()
): boolean {
  return settings.hooks?.Stop?.some((hook) => {
    if (isHookCommandHandler(hook)) {
      return hook.type === 'command' && hook.command === hookCommand;
    }
    return isHookMatcherGroup(hook) && hook.hooks.some(
      (handler) => handler.type === 'command' && handler.command === hookCommand
    );
  }) ?? false;
}

/** Check whether one runtime's Stop events target the running lifecycle receiver. */
export function isLifecycleHookInstalled(
  port: number = config.get().hookPort,
  runtimeId: string = 'claude-code'
): boolean {
  const target = getHookTargets().find((candidate) => candidate.runtimeId === runtimeId);
  if (!target) return false;
  return hasCurrentLifecycleHook(
    getHookSettings(target.settingsPath),
    getHookCommand(port, target.runtimeId)
  );
}

/** Check if keepline hooks are installed */
export function areHooksInstalled(): boolean {
  return getHookTargets().every((target) => hasKeeplineHook(
    getHookSettings(target.settingsPath),
    target.hookTypes
  ));
}

/** Install Keepline hooks into Claude Code and Codex settings. */
export function installHooks(): void {
  const targets = getHookTargets().map((target) => ({
    ...target,
    settings: getHookSettings(target.settingsPath),
  }));
  for (const target of targets) {
    const changed = installKeeplineHookConfig(
      target.settings,
      getHookCommand(config.get().hookPort, target.runtimeId),
      target.hookTypes
    );
    if (changed) {
      saveHookSettings(target.settingsPath, target.settings);
      logger.info(`Keepline ${target.runtimeId} hooks installed`);
      if (target.runtimeId === 'codex') {
        logger.warn('Codex must approve newly installed hooks before they run; verify hook trust in Codex');
      }
    } else {
      logger.debug(`Keepline ${target.runtimeId} hooks already installed`);
    }
  }
}

/** Uninstall only Keepline-owned hooks from Claude Code and Codex settings. */
export function uninstallHooks(): void {
  const targets = getHookTargets().map((target) => ({
    ...target,
    settings: getHookSettings(target.settingsPath),
  }));
  for (const target of targets) {
    const removed = uninstallKeeplineHookConfig(target.settings);
    if (removed > 0) {
      saveHookSettings(target.settingsPath, target.settings);
      logger.info(`Keepline ${target.runtimeId} hooks uninstalled`);
    } else {
      logger.debug(`Keepline ${target.runtimeId} hooks not installed`);
    }
  }
}

/** Get hook status info */
export function getHookStatus(): {
  installed: boolean;
  installation: 'none' | 'partial' | 'all';
  settingsPath: string;
  hookCommand: string;
  targets: Array<{
    runtimeId: HookRuntimeId;
    installed: boolean;
    settingsPath: string;
    trustStatus: 'not-required' | 'runtime-managed';
  }>;
} {
  const targets = getHookTargets().map((target) => ({
    runtimeId: target.runtimeId,
    installed: hasKeeplineHook(getHookSettings(target.settingsPath), target.hookTypes),
    settingsPath: target.settingsPath,
    trustStatus: target.runtimeId === 'codex' ? 'runtime-managed' as const : 'not-required' as const,
  }));
  const installedCount = targets.filter((target) => target.installed).length;
  return {
    installed: installedCount > 0,
    installation: installedCount === 0
      ? 'none'
      : installedCount === targets.length ? 'all' : 'partial',
    settingsPath: targets.map((target) => target.settingsPath).join(', '),
    hookCommand: getHookCommand(),
    targets,
  };
}
