/**
 * Regression tests for JSONL session parsing.
 *
 * These tests lock observable parsing behavior so the parser can be
 * refactored for lower memory usage without changing results.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ParseError } from '../lib/errors.js';
import { parseSessionFile } from '../adapters/claude/parser/jsonl.js';

const tempDirs: string[] = [];

function createJsonlFile(
  lines: Array<Record<string, unknown> | string>,
  options: { trailingNewline?: boolean } = {}
): string {
  const dir = mkdtempSync(join(tmpdir(), 'keepline-jsonl-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'session.jsonl');
  const contents = lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n');
  writeFileSync(filePath, options.trailingNewline === false ? contents : `${contents}\n`);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('JSONL Session Parser', () => {
  test('summarizes session fields, tools, and usage from a JSONL file', async () => {
    const filePath = createJsonlFile([
      {
        type: 'user',
        uuid: 'user-1',
        sessionId: 'session-1',
        cwd: '/tmp/project',
        timestamp: '2026-04-13T10:00:00.000Z',
        userType: 'external',
        message: {
          role: 'user',
          content: 'Investigate performance regression',
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        sessionId: 'session-1',
        cwd: '/tmp/project',
        timestamp: '2026-04-13T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-3-5-sonnet-20241022',
          content: [
            { type: 'text', text: 'Analyzing parser hotspot' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file_path: '/tmp/project/src/app.ts' },
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 10,
          },
        },
      },
      {
        type: 'file-history-snapshot',
        uuid: 'snapshot-1',
        sessionId: 'session-1',
        cwd: '/tmp/project',
        timestamp: '2026-04-13T10:00:06.000Z',
        messageId: 'assistant-1',
        snapshot: {
          messageId: 'assistant-1',
          timestamp: '2026-04-13T10:00:06.000Z',
          trackedFileBackups: {},
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-2',
        parentUuid: 'assistant-1',
        sessionId: 'session-1',
        cwd: '/tmp/project',
        timestamp: '2026-04-13T10:00:10.000Z',
        message: {
          role: 'assistant',
          model: 'claude-3-5-sonnet-20241022',
          content: [
            {
              type: 'tool_use',
              id: 'tool-2',
              name: 'Edit',
              input: { path: '/tmp/project/src/app.ts' },
            },
            { type: 'text', text: 'Applied fix' },
          ],
          usage: {
            input_tokens: 50,
            output_tokens: 25,
          },
        },
      },
    ]);

    const parsed = await parseSessionFile(filePath);

    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe('session-1');
    expect(parsed!.directory).toBe('/tmp/project');
    expect(parsed!.firstMessage).toBe('Investigate performance regression');
    expect(parsed!.lastMessage).toBe('Applied fix');
    expect(parsed!.messageCount).toBe(1);
    expect(parsed!.toolCount).toBe(2);
    expect(parsed!.lastTool).toBe('Edit');
    expect(parsed!.lastToolInput).toEqual({ path: '/tmp/project/src/app.ts' });
    expect(parsed!.currentFile).toBe('/tmp/project/src/app.ts');
    expect(parsed!.startedAt?.toISOString()).toBe('2026-04-13T10:00:00.000Z');
    expect(parsed!.lastActiveAt.toISOString()).toBe('2026-04-13T10:00:10.000Z');
    expect(parsed!.toolCalls).toEqual([
      {
        name: 'Read',
        input: { file_path: '/tmp/project/src/app.ts' },
        timestamp: '2026-04-13T10:00:05.000Z',
      },
      {
        name: 'Edit',
        input: { path: '/tmp/project/src/app.ts' },
        timestamp: '2026-04-13T10:00:10.000Z',
      },
    ]);
    expect(parsed!.usageStats).toMatchObject({
      totalInputTokens: 180,
      totalOutputTokens: 65,
      totalTokens: 245,
      apiCalls: 2,
    });
    expect(parsed!.usageStats?.totalCost).toBeCloseTo(0.001503, 8);
  });

  test('uses the latest real user task across injected context messages', async () => {
    const messages = [
      '<recommended_plugins>plugin catalog</recommended_plugins>',
      '# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>',
      '<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>',
      'Inspect the Claude session title boundary',
      '继续',
      '# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>compacted rules</INSTRUCTIONS>',
      'Fix the Claude session title boundary',
      '继续。',
    ];
    const filePath = createJsonlFile(messages.map((content, index) => ({
      type: 'user',
      uuid: `user-${index}`,
      sessionId: 'session-context-boundary',
      cwd: '/tmp/project',
      timestamp: `2026-04-13T10:00:0${index}.000Z`,
      userType: 'external',
      message: { role: 'user', content },
    })));

    const parsed = await parseSessionFile(filePath);

    expect(parsed?.firstMessage).toBe('Fix the Claude session title boundary');
    expect(parsed?.messageCount).toBe(8);
  });

  test('uses system command fallback and sub-agent metadata when no external user message exists', async () => {
    const filePath = createJsonlFile([
      {
        type: 'system',
        uuid: 'system-1',
        sessionId: 'parent-session',
        cwd: '/tmp/project',
        timestamp: '2026-04-13T11:00:00.000Z',
        agentId: 'agent-123',
        isSidechain: true,
        content: '<command-name>/resume</command-name>',
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        parentUuid: 'system-1',
        sessionId: 'parent-session',
        cwd: '/tmp/project',
        timestamp: '2026-04-13T11:00:02.000Z',
        agentId: 'agent-123',
        isSidechain: true,
        message: {
          role: 'assistant',
          model: 'claude-3-5-sonnet-20241022',
          content: [{ type: 'text', text: 'Recovered sidechain context' }],
        },
      },
    ]);

    const parsed = await parseSessionFile(filePath);

    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe('agent-agent-123');
    expect(parsed!.parentSessionId).toBe('parent-session');
    expect(parsed!.agentId).toBe('agent-123');
    expect(parsed!.isSubAgent).toBe(true);
    expect(parsed!.firstMessage).toBe('System: /resume');
    expect(parsed!.lastMessage).toBe('Recovered sidechain context');
    expect(parsed!.messageCount).toBe(0);
  });

  test('falls back to parsed timestamp ordering for non-canonical timestamp strings', async () => {
    const filePath = createJsonlFile([
      {
        type: 'user',
        uuid: 'user-1',
        sessionId: 'session-non-iso',
        cwd: '/tmp/project',
        timestamp: 'Mon, 13 Apr 2026 10:00:05 GMT',
        userType: 'external',
        message: {
          role: 'user',
          content: 'Handle non-ISO timestamps',
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        sessionId: 'session-non-iso',
        cwd: '/tmp/project',
        timestamp: 'Mon, 13 Apr 2026 10:00:00 GMT',
        message: {
          role: 'assistant',
          model: 'claude-3-5-sonnet-20241022',
          content: [{ type: 'text', text: 'Older assistant event' }],
        },
      },
    ]);

    const parsed = await parseSessionFile(filePath);

    expect(parsed).not.toBeNull();
    expect(parsed!.startedAt?.toISOString()).toBe('2026-04-13T10:00:00.000Z');
    expect(parsed!.lastActiveAt.toISOString()).toBe('2026-04-13T10:00:05.000Z');
  });

  test('skips a truncated final JSONL line while preserving parsed session data', async () => {
    const filePath = createJsonlFile([
      {
        type: 'user',
        uuid: 'user-1',
        sessionId: 'session-truncated-tail',
        cwd: '/tmp/project',
        timestamp: '2026-04-13T12:00:00.000Z',
        userType: 'external',
        message: {
          role: 'user',
          content: 'Recover me despite a truncated tail',
        },
      },
      '{"type":"assistant","message":{"content":',
    ], { trailingNewline: false });

    const parsed = await parseSessionFile(filePath);

    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe('session-truncated-tail');
    expect(parsed!.firstMessage).toBe('Recover me despite a truncated tail');
  });

  test('throws ParseError with file path and line number for non-final invalid JSONL', async () => {
    const filePath = createJsonlFile([
      {
        type: 'user',
        uuid: 'user-1',
        sessionId: 'session-1',
        cwd: '/tmp/project',
        timestamp: '2026-04-13T12:00:00.000Z',
        userType: 'external',
        message: {
          role: 'user',
          content: 'Hello',
        },
      },
      '{"type":"assistant", bad json',
      {
        type: 'assistant',
        uuid: 'assistant-after-bad-line',
        sessionId: 'session-1',
        cwd: '/tmp/project',
        timestamp: '2026-04-13T12:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-3-5-sonnet-20241022',
          content: [{ type: 'text', text: 'This line must not hide the prior corruption' }],
        },
      },
    ]);

    try {
      await parseSessionFile(filePath);
      throw new Error('Expected parseSessionFile to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      const parseError = error as ParseError;
      expect(parseError.code).toBe('PARSE_ERROR');
      expect(parseError.details).toMatchObject({
        filePath,
        line: 2,
      });
    }
  });
});
