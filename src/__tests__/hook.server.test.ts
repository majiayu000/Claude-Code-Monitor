import { afterEach, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import {
  createHookServer,
  isValidHookEvent,
  normalizeHookEvent,
} from '../adapters/hook/server.js';
import {
  buildHookAvailability,
  isKeeplineHookHealth,
  isHookReceiverRunning,
} from '../adapters/hook/availability.js';

const fixedNow = new Date('2026-07-02T15:30:00.000Z');

describe('hook server payload normalization', () => {
  test('accepts current Claude Code PostToolUse stdin payloads', () => {
    const event = normalizeHookEvent(
      {
        session_id: 'session-1234',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/project',
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/project/file.txt',
          content: 'hello',
        },
        tool_response: {
          filePath: '/tmp/project/file.txt',
          success: true,
        },
      },
      fixedNow
    );

    expect(event).toEqual({
      event_type: 'PostToolUse',
      session_id: 'session-1234',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/project',
      timestamp: '2026-07-02T15:30:00.000Z',
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/project/file.txt',
        content: 'hello',
      },
      tool_output: '{"filePath":"/tmp/project/file.txt","success":true}',
    });
  });

  test('accepts legacy Keepline event_type payloads', () => {
    const event = normalizeHookEvent({
      event_type: 'PreToolUse',
      session_id: 'session-1234',
      cwd: '/tmp/project',
      timestamp: '2026-07-02T15:31:00.000Z',
      tool_name: 'Bash',
      tool_input: {
        command: 'bun test',
      },
    });

    expect(event).toEqual({
      event_type: 'PreToolUse',
      session_id: 'session-1234',
      cwd: '/tmp/project',
      timestamp: '2026-07-02T15:31:00.000Z',
      transcript_path: undefined,
      tool_name: 'Bash',
      tool_input: {
        command: 'bun test',
      },
      tool_output: undefined,
    });
  });

  test('accepts UserPromptSubmit without a synthetic timestamp from the command', () => {
    expect(
      isValidHookEvent({
        session_id: 'session-1234',
        cwd: '/tmp/project',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Summarize this repo',
      })
    ).toBe(true);
  });

  test('accepts Codex SessionStart payloads', () => {
    expect(normalizeHookEvent({
      session_id: 'codex-session-1234',
      transcript_path: '/tmp/codex-session.jsonl',
      cwd: '/tmp/project',
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, fixedNow)).toEqual({
      event_type: 'SessionStart',
      session_id: 'codex-session-1234',
      transcript_path: '/tmp/codex-session.jsonl',
      cwd: '/tmp/project',
      timestamp: '2026-07-02T15:30:00.000Z',
      source: 'startup',
    });
  });

  test('rejects malformed tool payloads', () => {
    expect(
      normalizeHookEvent({
        session_id: 'session-1234',
        cwd: '/tmp/project',
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
      })
    ).toBeNull();
  });
});

describe('hook server request security', () => {
  let server: FastifyInstance | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  function app(): FastifyInstance {
    server = createHookServer();
    return server;
  }

  test('rejects non-loopback Host headers before hook validation', async () => {
    const response = await app().inject({
      method: 'POST',
      url: '/hook',
      headers: {
        host: 'attacker.example',
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    const body = response.json() as { success: boolean; error: string };
    expect(body).toEqual({ success: false, error: 'Forbidden' });
  });

  test('rejects cross-origin context reads', async () => {
    const response = await app().inject({
      method: 'GET',
      url: '/context?path=/tmp/project',
      headers: {
        host: '127.0.0.1:7890',
        origin: 'https://attacker.example',
      },
    });

    expect(response.statusCode).toBe(403);
  });

  test('accepts loopback health requests', async () => {
    const response = await app().inject({
      method: 'GET',
      url: '/health',
      headers: {
        host: 'localhost:7890',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      service: 'keepline-hook-receiver',
    });
  });

  test('allows loopback hook requests to reach payload validation', async () => {
    const response = await app().inject({
      method: 'POST',
      url: '/hook',
      headers: {
        host: '127.0.0.1:7890',
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { success: boolean; error: string };
    expect(body).toEqual({
      success: false,
      error: 'Invalid hook event payload',
    });
  });

  test('rejects cross-site browser fetch metadata', async () => {
    const response = await app().inject({
      method: 'POST',
      url: '/hook',
      headers: {
        host: '127.0.0.1:7890',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('hook availability status', () => {
  test('accepts only health responses from the Keepline hook receiver', () => {
    expect(isKeeplineHookHealth({ status: 'ok', service: 'keepline-hook-receiver' })).toBe(true);
    expect(isKeeplineHookHealth({ status: 'ok' })).toBe(false);
    expect(isKeeplineHookHealth('ok')).toBe(false);
  });

  test('treats a daemon-owned healthy receiver as running outside the daemon process', async () => {
    const calls: Array<{ url: string; timeoutMs: number }> = [];

    await expect(
      isHookReceiverRunning({
        localServerRunning: false,
        daemonRunning: true,
        hookServerUrl: 'http://127.0.0.1:7890',
        timeoutMs: 50,
        probe: async (url, timeoutMs) => {
          calls.push({ url, timeoutMs });
          return true;
        },
      })
    ).resolves.toBe(true);

    expect(calls).toEqual([{ url: 'http://127.0.0.1:7890', timeoutMs: 50 }]);
  });

  test('discovers a receiver owned by a decoupled service without a daemon pid', async () => {
    let probed = false;

    await expect(
      isHookReceiverRunning({
        localServerRunning: false,
        daemonRunning: false,
        hookServerUrl: 'http://127.0.0.1:7890',
        probe: async () => {
          probed = true;
          return true;
        },
      })
    ).resolves.toBe(true);

    expect(probed).toBe(true);
  });

  test('marks installed hooks without a receiver as degraded', () => {
    expect(
      buildHookAvailability({
        installed: true,
        receiverRunning: false,
        settingsPath: '/tmp/settings.json',
        hookCommand: 'curl http://127.0.0.1:7890/hook',
        hookServerUrl: 'http://127.0.0.1:7890',
      })
    ).toMatchObject({
      installed: true,
      receiverRunning: false,
      degraded: true,
    });
  });

  test('does not mark uninstalled hooks as degraded', () => {
    expect(
      buildHookAvailability({
        installed: false,
        receiverRunning: false,
        settingsPath: '/tmp/settings.json',
        hookCommand: 'curl http://127.0.0.1:7890/hook',
        hookServerUrl: 'http://127.0.0.1:7890',
      }).degraded
    ).toBe(false);
  });
});
