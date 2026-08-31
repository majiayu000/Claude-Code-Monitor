import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ParseError } from '../lib/errors.js';
import {
  parseCodexSessionFile,
  scopeCodexSessionId,
  unscopeCodexSessionId,
} from '../adapters/codex/parser.js';

const tempDirs: string[] = [];

function createCodexJsonlFile(
  lines: Array<Record<string, unknown> | string>,
  options: { trailingNewline?: boolean } = {}
): string {
  const dir = mkdtempSync(join(tmpdir(), 'keepline-jsonl-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'rollout-019ed4a3-2186-7e51-9aa1-ca1e376549b8.jsonl');
  const contents = lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n');
  writeFileSync(filePath, options.trailingNewline === false ? contents : `${contents}\n`);
  return filePath;
}

function createTempHome(): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'keepline-codex-home-'));
  tempDirs.push(homeDir);
  return homeDir;
}

function writeCodexSessionFile(
  homeDir: string,
  rawSessionId: string,
  lines: Array<Record<string, unknown> | string>,
  options: { trailingNewline?: boolean } = {}
): string {
  const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '06', '23');
  mkdirSync(sessionDir, { recursive: true });
  const filePath = join(sessionDir, `rollout-${rawSessionId}.jsonl`);
  const contents = lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n');
  writeFileSync(filePath, options.trailingNewline === false ? contents : `${contents}\n`);
  return filePath;
}

function runCodexScannerScript(homeDir: string, script: string) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '--eval', script],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      KEEPLINE_HOME: join(homeDir, '.keepline'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString() || `codex scanner subprocess failed with code ${proc.exitCode}`);
  }

  const jsonLine = proc.stdout.toString().trim().split('\n').filter(Boolean).pop();
  if (!jsonLine) {
    throw new Error('codex scanner subprocess produced no JSON output');
  }
  return JSON.parse(jsonLine) as Record<string, unknown>;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Codex JSONL parser', () => {
  test('scopes session ids without changing resume ids', () => {
    const rawId = '019ed4a3-2186-7e51-9aa1-ca1e376549b8';
    expect(scopeCodexSessionId(rawId)).toBe(`codex_${rawId}`);
    expect(scopeCodexSessionId(`codex_${rawId}`)).toBe(`codex_${rawId}`);
    expect(unscopeCodexSessionId(`codex_${rawId}`)).toBe(rawId);
  });

  test('summarizes Codex messages and tool calls', async () => {
    const filePath = createCodexJsonlFile([
      {
        type: 'session_meta',
        timestamp: '2026-06-17T01:00:00.000Z',
        payload: {
          id: '019ed4a3-2186-7e51-9aa1-ca1e376549b8',
          cwd: '/tmp/codex-project',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-17T01:00:03.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Add Codex detection' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-17T01:00:05.000Z',
        payload: {
          type: 'function_call',
          name: 'read_file',
          arguments: '{"path":"/tmp/codex-project/src/index.ts"}',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-17T01:00:09.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Detection added' }],
        },
      },
    ]);

    const parsed = await parseCodexSessionFile(filePath, { includeToolCalls: true });

    expect(parsed).not.toBeNull();
    expect(parsed!.client).toBe('codex');
    expect(parsed!.rawSessionId).toBe('019ed4a3-2186-7e51-9aa1-ca1e376549b8');
    expect(parsed!.sessionId).toBe('codex_019ed4a3-2186-7e51-9aa1-ca1e376549b8');
    expect(parsed!.directory).toBe('/tmp/codex-project');
    expect(parsed!.firstMessage).toBe('Add Codex detection');
    expect(parsed!.lastMessage).toBe('Detection added');
    expect(parsed!.messageCount).toBe(2);
    expect(parsed!.toolCount).toBe(1);
    expect(parsed!.lastTool).toBe('read_file');
    expect(parsed!.lastToolInput).toEqual({ path: '/tmp/codex-project/src/index.ts' });
    expect(parsed!.currentFile).toBe('/tmp/codex-project/src/index.ts');
    expect(parsed!.startedAt?.toISOString()).toBe('2026-06-17T01:00:00.000Z');
    expect(parsed!.lastActiveAt.toISOString()).toBe('2026-06-17T01:00:09.000Z');
    expect(parsed!.toolCalls).toEqual([
      {
        name: 'read_file',
        input: { path: '/tmp/codex-project/src/index.ts' },
        timestamp: '2026-06-17T01:00:05.000Z',
      },
    ]);
  });

  test('uses the latest real user task across injected Codex context', async () => {
    const filePath = createCodexJsonlFile([
      {
        type: 'session_meta',
        timestamp: '2026-06-17T01:00:00.000Z',
        payload: {
          id: '019ed4a3-2186-7e51-9aa1-ca1e376549b8',
          cwd: '/tmp/codex-project',
        },
      },
      ...[
        '<recommended_plugins>plugin catalog</recommended_plugins>',
        '# AGENTS.md instructions for /tmp/codex-project\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>',
        '<environment_context>\n<cwd>/tmp/codex-project</cwd>\n</environment_context>',
        'Inspect the session title boundary',
        '继续',
        '# AGENTS.md instructions for /tmp/codex-project\n\n<INSTRUCTIONS>compacted rules</INSTRUCTIONS>',
        'Fix the session title boundary',
        '继续。',
      ].map((text, index) => ({
        type: 'response_item',
        timestamp: `2026-06-17T01:00:0${index + 1}.000Z`,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      })),
    ]);

    const parsed = await parseCodexSessionFile(filePath);

    expect(parsed?.firstMessage).toBe('Fix the session title boundary');
    expect(parsed?.messageCount).toBe(8);
  });

  test('skips a truncated final JSONL line while preserving parsed session data', async () => {
    const filePath = createCodexJsonlFile([
      {
        type: 'session_meta',
        timestamp: '2026-06-17T01:00:00.000Z',
        payload: {
          id: '019ed4a3-2186-7e51-9aa1-ca1e376549b8',
          cwd: '/tmp/codex-project',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-17T01:00:03.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Recover Codex tail' }],
        },
      },
      '{"type":"response_item","payload":{"type":"message"',
    ], { trailingNewline: false });

    const parsed = await parseCodexSessionFile(filePath);

    expect(parsed).not.toBeNull();
    expect(parsed!.rawSessionId).toBe('019ed4a3-2186-7e51-9aa1-ca1e376549b8');
    expect(parsed!.firstMessage).toBe('Recover Codex tail');
  });

  test('throws ParseError for non-final invalid JSONL', async () => {
    const filePath = createCodexJsonlFile([
      {
        type: 'session_meta',
        timestamp: '2026-06-17T01:00:00.000Z',
        payload: {
          id: '019ed4a3-2186-7e51-9aa1-ca1e376549b8',
          cwd: '/tmp/codex-project',
        },
      },
      '{"type":"response_item", invalid json',
      {
        type: 'response_item',
        timestamp: '2026-06-17T01:00:03.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'This should not mask corruption' }],
        },
      },
    ]);

    await expect(parseCodexSessionFile(filePath)).rejects.toBeInstanceOf(ParseError);
  });

  test('accumulates token usage from Codex event messages', async () => {
    const filePath = createCodexJsonlFile([
      {
        type: 'session_meta',
        timestamp: '2026-06-17T01:00:00.000Z',
        payload: {
          id: '019ed4a3-2186-7e51-9aa1-ca1e376549b8',
          cwd: '/tmp/codex-project',
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-17T01:00:05.000Z',
        payload: {
          msg: {
            model: 'gpt-4o-mini',
            usage: {
              input_tokens: 1000,
              output_tokens: 250,
              cache_read_input_tokens: 100,
            },
          },
        },
      },
    ]);

    const parsed = await parseCodexSessionFile(filePath);

    expect(parsed?.usageStats).toMatchObject({
      totalInputTokens: 1100,
      totalOutputTokens: 250,
      totalTokens: 1350,
      apiCalls: 1,
    });
    expect(parsed?.usageStats?.totalCost).toBeGreaterThan(0);
  });
});

describe('Codex scanner', () => {
  test('reports cached per-file parse failures while preserving healthy sessions', () => {
    const homeDir = createTempHome();
    const healthyId = '019ed4a3-2186-7e51-9aa1-ca1e376549b8';
    const brokenId = '019ed4a3-2186-7e51-9aa1-ca1e376549b9';
    const brokenPath = writeCodexSessionFile(homeDir, brokenId, [
      {
        type: 'session_meta',
        timestamp: '2026-06-23T01:00:00.000Z',
        payload: {
          id: brokenId,
          cwd: '/tmp/broken-codex',
        },
      },
      '{"type":"response_item", invalid json',
      {
        type: 'response_item',
        timestamp: '2026-06-23T01:00:02.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Line after corruption' }],
        },
      },
    ]);
    writeCodexSessionFile(homeDir, healthyId, [
      {
        type: 'session_meta',
        timestamp: '2026-06-23T01:00:00.000Z',
        payload: {
          id: healthyId,
          cwd: '/tmp/healthy-codex',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-23T01:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Healthy Codex session' }],
        },
      },
    ]);

    const result = runCodexScannerScript(homeDir, `
      const { clearCodexSessionCache, getAllCodexSessionsWithFailures } = await import('./src/adapters/codex/scanner.ts');
      clearCodexSessionCache();
      const first = await getAllCodexSessionsWithFailures();
      const second = await getAllCodexSessionsWithFailures();
      console.log(JSON.stringify({
        firstSessions: first.sessions.map((session) => session.rawSessionId),
        firstFailures: first.failures.map((failure) => failure.filePath),
        secondSessions: second.sessions.map((session) => session.rawSessionId),
        secondFailures: second.failures.map((failure) => failure.filePath),
      }));
    `);

    expect(result).toEqual({
      firstSessions: [healthyId],
      firstFailures: [brokenPath],
      secondSessions: [healthyId],
      secondFailures: [brokenPath],
    });
  });

  test('does not cache a final-line truncation as a Codex parse failure', () => {
    const homeDir = createTempHome();
    const truncatedId = '019ed4a3-2186-7e51-9aa1-ca1e376549b8';
    writeCodexSessionFile(homeDir, truncatedId, [
      {
        type: 'session_meta',
        timestamp: '2026-06-23T01:00:00.000Z',
        payload: {
          id: truncatedId,
          cwd: '/tmp/truncated-codex',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-23T01:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Visible despite truncation' }],
        },
      },
      '{"type":"response_item","payload":{"type":"message"',
    ], { trailingNewline: false });

    const result = runCodexScannerScript(homeDir, `
      const { clearCodexSessionCache, getAllCodexSessionsWithFailures } = await import('./src/adapters/codex/scanner.ts');
      clearCodexSessionCache();
      const first = await getAllCodexSessionsWithFailures();
      const second = await getAllCodexSessionsWithFailures();
      console.log(JSON.stringify({
        firstSessions: first.sessions.map((session) => session.rawSessionId),
        firstFailures: first.failures.map((failure) => failure.filePath),
        secondSessions: second.sessions.map((session) => session.rawSessionId),
        secondFailures: second.failures.map((failure) => failure.filePath),
      }));
    `);

    expect(result).toEqual({
      firstSessions: [truncatedId],
      firstFailures: [],
      secondSessions: [truncatedId],
      secondFailures: [],
    });
  });
});
