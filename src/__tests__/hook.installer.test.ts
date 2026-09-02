import { afterEach, describe, expect, test } from 'bun:test';
import {
  hasCurrentLifecycleHook,
  installKeeplineHookConfig,
  isKeeplineHook,
  uninstallKeeplineHookConfig,
} from '../adapters/hook/installer.js';
import type { ClaudeHookMatcher, ClaudeSettings } from '../adapters/hook/types.js';
import { getCodexHooksPath } from '../lib/paths.js';

const markedCommand =
  'KEEPLINE_HOOK_MARKER=keepline-hook-v2 curl -fsS -X POST http://127.0.0.1:7890/hook -H "Content-Type: application/json" --data-binary @- > /dev/null 2>&1 || true';
const unrelatedLocalhostCommand = 'curl -s http://127.0.0.1:7777/other-hook';
const unrelatedBlock: ClaudeHookMatcher = {
  hooks: [{ type: 'command', command: unrelatedLocalhostCommand }],
};
const legacyKeeplineCommand = `curl -s -X POST http://127.0.0.1:7890/hook -H "Content-Type: application/json" -d '{"event_type":"$CLAUDE_EVENT_TYPE","session_id":"$CLAUDE_SESSION_ID","cwd":"$PWD","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","tool_name":"$CLAUDE_TOOL_NAME","tool_input":'"\${CLAUDE_TOOL_INPUT:-{}}"'}' > /dev/null 2>&1 || true`;
const foreignLegacyShapeCommand = `curl -s -X POST https://collector.example/hook -H "Content-Type: application/json" -d '{"event_type":"$CLAUDE_EVENT_TYPE","session_id":"$CLAUDE_SESSION_ID","cwd":"$PWD","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","tool_name":"$CLAUDE_TOOL_NAME","tool_input":'"\${CLAUDE_TOOL_INPUT:-{}}"'}' > /dev/null 2>&1 || true`;
const expectedHandler = { type: 'command', command: markedCommand };
const registeredEvents = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
] as const;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

function matcherBlock(block: unknown): ClaudeHookMatcher {
  return block as ClaudeHookMatcher;
}

describe('hook installer ownership detection', () => {
  test('resolves hooks.json from the active CODEX_HOME', () => {
    process.env.CODEX_HOME = '/tmp/custom-codex-home';

    expect(getCodexHooksPath()).toBe('/tmp/custom-codex-home/hooks.json');
  });

  test('does not claim unrelated localhost hooks', () => {
    expect(isKeeplineHook({ type: 'command', command: unrelatedLocalhostCommand })).toBe(false);
  });

  test('does not claim non-local legacy-shaped hooks', () => {
    expect(isKeeplineHook({ type: 'command', command: foreignLegacyShapeCommand })).toBe(false);
  });

  test('registers all Keepline hook events using the nested shape', () => {
    const settings: ClaudeSettings = {};

    const changed = installKeeplineHookConfig(settings, markedCommand);

    expect(changed).toBe(true);
    for (const event of registeredEvents) {
      const blocks = settings.hooks?.[event];
      expect(blocks).toHaveLength(1);
      const entry = matcherBlock(blocks?.[0]).hooks[0];
      expect(entry).toEqual(expectedHandler);
    }
    expect(settings.hooks?.PreToolUse?.[0].matcher).toBe('*');
    expect(settings.hooks?.PostToolUse?.[0].matcher).toBe('*');
  });

  test('install is idempotent', () => {
    const settings: ClaudeSettings = {};
    installKeeplineHookConfig(settings, markedCommand);

    const changedAgain = installKeeplineHookConfig(settings, markedCommand);

    expect(changedAgain).toBe(false);
    for (const event of registeredEvents) {
      expect(settings.hooks?.[event]).toHaveLength(1);
    }
  });

  test('install coexists with unrelated hooks in the same event', () => {
    const settings: ClaudeSettings = {
      hooks: { PostToolUse: [unrelatedBlock] },
    };

    const changed = installKeeplineHookConfig(settings, markedCommand);

    expect(changed).toBe(true);
    expect(settings.hooks?.PostToolUse).toHaveLength(2);
    expect(settings.hooks?.PostToolUse?.[0]).toEqual(unrelatedBlock);
    expect(settings.hooks?.PostToolUse?.[1]).toEqual({
      matcher: '*',
      hooks: [expectedHandler],
    });
  });

  test('uninstall removes only Keepline-owned hooks and drops empty blocks', () => {
    const settings: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          unrelatedBlock,
          { hooks: [{ type: 'command', command: markedCommand }] },
        ],
        Stop: [
          {
            hooks: [
              { type: 'command', command: legacyKeeplineCommand },
              { type: 'command', command: 'echo keep-me' },
            ],
          },
        ],
      },
    };

    const removed = uninstallKeeplineHookConfig(settings);

    expect(removed).toBe(2);
    expect(settings.hooks?.PostToolUse).toEqual([unrelatedBlock]);
    expect(settings.hooks?.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'echo keep-me' }] },
    ]);
  });

  test('uninstall removes Keepline handlers from mixed matcher groups', () => {
    const settings: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: markedCommand },
              { type: 'command', command: 'echo keep-me' },
            ],
          },
        ],
      },
    };

    const removed = uninstallKeeplineHookConfig(settings);

    expect(removed).toBe(1);
    expect(settings.hooks?.PostToolUse).toEqual([
      {
        matcher: '*',
        hooks: [{ type: 'command', command: 'echo keep-me' }],
      },
    ]);
  });

  test('install upgrades a legacy Keepline hook without duplicating', () => {
    const settings: ClaudeSettings = {
      hooks: {
        PostToolUse: [{ type: 'command', command: legacyKeeplineCommand }],
      },
    };

    const changed = installKeeplineHookConfig(settings, markedCommand);

    expect(changed).toBe(true);
    expect(settings.hooks?.PostToolUse).toEqual([
      {
        matcher: '*',
        hooks: [expectedHandler],
      },
    ]);
    for (const event of ['PreToolUse', 'Notification', 'SessionStart', 'Stop', 'UserPromptSubmit'] as const) {
      expect(matcherBlock(settings.hooks?.[event]?.[0]).hooks[0]).toEqual(expectedHandler);
    }
  });

  test('generated command forwards stdin and does not rely on $CLAUDE_* env vars', () => {
    const settings: ClaudeSettings = {};
    installKeeplineHookConfig(settings);
    const command = matcherBlock(settings.hooks?.PostToolUse?.[0]).hooks[0].command;

    expect(command).toContain('--data-binary @-');
    expect(command).not.toContain('$CLAUDE_EVENT_TYPE');
    expect(command).not.toContain('$CLAUDE_SESSION_ID');
    expect(command).not.toContain('$CLAUDE_TOOL_INPUT');
  });

  test('lifecycle readiness requires a command Stop hook targeting the current receiver', () => {
    const current: ClaudeSettings = {};
    installKeeplineHookConfig(current, markedCommand);
    expect(hasCurrentLifecycleHook(current, markedCommand)).toBe(true);

    const stale: ClaudeSettings = {};
    installKeeplineHookConfig(stale, markedCommand.replace(':7890/', ':7891/'));
    expect(hasCurrentLifecycleHook(stale, markedCommand)).toBe(false);
    expect(hasCurrentLifecycleHook({}, markedCommand)).toBe(false);
    expect(hasCurrentLifecycleHook({
      hooks: { Stop: [{ hooks: [{ type: 'prompt', command: markedCommand }] }] },
    }, markedCommand)).toBe(false);
  });
});
