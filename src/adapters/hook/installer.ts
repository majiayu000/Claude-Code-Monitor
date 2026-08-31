/**
 * Claude hooks installer
 *
 * Registers a Keepline hook under Claude Code's matcher-block settings shape:
 *   hooks.<Event>[] = [{ matcher?, hooks: [{ type: "command", command }] }]
 *
 * The command forwards Claude's stdin hook JSON verbatim to the hook server;
 * it does not rely on `$CLAUDE_*` environment variables.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { CLAUDE_SETTINGS } from '../../lib/paths.js';
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
const HOOK_TYPES: HookEventType[] = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'UserPromptSubmit',
];

/** Get current Claude settings */
function getClaudeSettings(): ClaudeSettings {
  if (!existsSync(CLAUDE_SETTINGS)) {
    logger.debug('Claude settings file not found, using defaults');
    return {};
  }

  try {
    const content = readFileSync(CLAUDE_SETTINGS, 'utf-8');
    return JSON.parse(content) as ClaudeSettings;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to parse Claude settings: ${message}`, { path: CLAUDE_SETTINGS });
    return {};
  }
}

/** Save Claude settings */
function saveClaudeSettings(settings: ClaudeSettings): void {
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
}

/**
 * Generate the hook command.
 *
 * `--data-binary @-` forwards Claude's stdin JSON verbatim. The marker prefix
 * is a harmless env assignment used only to identify Keepline-owned hooks in
 * the settings file.
 */
function getHookCommand(port: number = config.get().hookPort): string {
  return `${KEEPLINE_HOOK_MARKER} curl -fsS -X POST http://127.0.0.1:${port}/hook -H "Content-Type: application/json" --data-binary @- > /dev/null 2>&1 || true`;
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
  hookCommand: string = getHookCommand()
): boolean {
  const before = JSON.stringify(settings.hooks ?? {});

  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const hookType of HOOK_TYPES) {
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
  for (const hookType of HOOK_TYPES) {
    const hooks = settings.hooks[hookType];
    if (!hooks) continue;
    removed += countKeeplineHooks(hooks);
    settings.hooks[hookType] = removeKeeplineHooks(hooks);
  }

  return removed;
}

function hasKeeplineHook(settings: ClaudeSettings): boolean {
  return HOOK_TYPES.every((hookType) => settings.hooks?.[hookType]?.some(isKeeplineHook));
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

/** Check whether Claude Stop events target the running lifecycle receiver. */
export function isLifecycleHookInstalled(port: number = config.get().hookPort): boolean {
  return hasCurrentLifecycleHook(getClaudeSettings(), getHookCommand(port));
}

/** Check if keepline hooks are installed */
export function areHooksInstalled(): boolean {
  const settings = getClaudeSettings();
  return hasKeeplineHook(settings);
}

/** Install keepline hooks into Claude settings */
export function installHooks(): void {
  const settings = getClaudeSettings();
  if (installKeeplineHookConfig(settings)) {
    saveClaudeSettings(settings);
    logger.info('Keepline hooks installed');
  } else {
    logger.debug('Keepline hooks already installed');
  }
}

/** Uninstall keepline hooks from Claude settings */
export function uninstallHooks(): void {
  const settings = getClaudeSettings();

  const removed = uninstallKeeplineHookConfig(settings);
  if (removed > 0) {
    saveClaudeSettings(settings);
    logger.info('Keepline hooks uninstalled');
  } else {
    logger.debug('Keepline hooks not installed');
  }
}

/** Get hook status info */
export function getHookStatus(): {
  installed: boolean;
  settingsPath: string;
  hookCommand: string;
} {
  return {
    installed: areHooksInstalled(),
    settingsPath: CLAUDE_SETTINGS,
    hookCommand: getHookCommand(),
  };
}
