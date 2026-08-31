import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLocalApiApp } from '../local-api/app.js';
import { resetDatabase } from '../db/migrations.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import { setupUser } from '../services/auth.service.js';
import { createServiceRecoveryHandler } from '../cli/service-recovery.js';
import {
  createRecoveryProcessRunner,
  type LocalRecoveryPreview,
} from '../local-api/routes/recovery.js';

const preview: LocalRecoveryPreview = {
  sessionId: 'recover-session-1234',
  runtimeId: 'codex',
  method: 'resume',
  executable: 'codex',
  arguments: ['resume', '019ed4a3-2186-7e51-9aa1-ca1e376549b8'],
  directory: process.cwd(),
  createsNewSession: false,
  confirmationId: 'a'.repeat(64),
};

describe('Local API recovery confirmation', () => {
  beforeEach(() => resetDatabase());
  afterEach(() => closeDatabase());

  test('previews once and executes an unchanged recovery idempotently', async () => {
    const requests: Array<{ action: string; sessionId: string }> = [];
    const app = createLocalApiApp({
      recoveryRunner: async (request) => {
        requests.push(request);
        return { preview, executed: request.action === 'execute' };
      },
    });
    const { token } = await setupUser('local-api-recovery-user', 'password123');
    sessionRepository.upsert({
      sessionId: preview.sessionId,
      client: 'codex',
      directory: preview.directory,
      status: 'lost',
    });
    const headers = { Authorization: `Bearer ${token}` };

    const metadata = await app.fetch(new Request('http://localhost/api/v1/meta'));
    const metadataBody = await metadata.json() as { data: { capabilities: string[] } };
    expect(metadataBody.data.capabilities).toContain('sessions.recovery.preview');
    expect(metadataBody.data.capabilities).toContain('sessions.recovery.execute');

    const previewResponse = await app.fetch(new Request(
      `http://localhost/api/v1/sessions/${preview.sessionId}/recovery-preview`,
      { headers }
    ));
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({
      success: true,
      data: { preview },
    });

    const body = JSON.stringify({
      confirmationId: preview.confirmationId,
      terminalApp: 'auto',
      idempotencyKey: 'recovery-request-1234',
    });
    const executeRequest = () => app.fetch(new Request(
      `http://localhost/api/v1/sessions/${preview.sessionId}/recover`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
      }
    ));
    expect((await executeRequest()).status).toBe(200);
    expect((await executeRequest()).status).toBe(200);
    expect(requests.map((request) => request.action)).toEqual(['preview', 'preview', 'execute']);

    const conflict = await app.fetch(new Request(
      `http://localhost/api/v1/sessions/${preview.sessionId}/recover`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          confirmationId: 'b'.repeat(64),
          terminalApp: 'auto',
          idempotencyKey: 'recovery-request-1234',
        }),
      }
    ));
    expect(conflict.status).toBe(409);
  });
});

test('recovery process runner uses the structured helper protocol', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keepline-recovery-runner-'));
  const script = join(directory, 'helper.ts');
  writeFileSync(script, `
    const [action, sessionId] = process.argv.slice(2);
    const preview = {
      sessionId,
      runtimeId: 'codex',
      method: 'resume',
      executable: 'codex',
      arguments: ['resume', sessionId],
      directory: ${JSON.stringify(process.cwd())},
      createsNewSession: false,
      confirmationId: '${'c'.repeat(64)}',
    };
    console.log('__KEEPLINE_SERVICE_RECOVERY__' + JSON.stringify({
      success: true,
      preview,
      executed: action === 'execute',
    }));
  `);
  const runner = createRecoveryProcessRunner([process.execPath, script]);
  const result = await runner({ action: 'preview', sessionId: 'runner-session-1234' });
  expect(result).toMatchObject({
    executed: false,
    preview: { sessionId: 'runner-session-1234', executable: 'codex' },
  });
});

test('isolated recovery helper executes only the preview the user confirmed', async () => {
  const opened: Array<{ executable: string; arguments: string[]; directory: string }> = [];
  let markedRunning = false;
  const handler = createServiceRecoveryHandler({
    recoverySource: () => ({
      sessionId: 'codex_019ed4a3-2186-7e51-9aa1-ca1e376549b8',
      runtimeId: 'codex',
      directory: process.cwd(),
      status: 'lost',
      initialPrompt: 'Continue safely',
      availableMethods: ['resume', 'continue', 'new'],
      recommendedMethod: 'resume',
    }),
    openTerminal: (executable, arguments_, directory) => {
      opened.push({ executable, arguments: arguments_, directory });
    },
    markRunning: () => { markedRunning = true; },
  });

  const result = handler.preview('codex_019ed4a3-2186-7e51-9aa1-ca1e376549b8');
  expect(result).toMatchObject({
    runtimeId: 'codex',
    method: 'resume',
    executable: 'codex',
    arguments: ['resume', '019ed4a3-2186-7e51-9aa1-ca1e376549b8'],
    directory: process.cwd(),
    createsNewSession: false,
  });
  expect(result.confirmationId).toMatch(/^[a-f0-9]{64}$/);
  expect(result.arguments).not.toContain('--dangerously-bypass-approvals-and-sandbox');

  expect(() => handler.execute(result.sessionId, 'b'.repeat(64), 'auto')).toThrow(
    'Recovery preview changed'
  );
  expect(opened).toHaveLength(0);

  const executed = handler.execute(result.sessionId, result.confirmationId, 'auto');
  expect(executed.executed).toBe(true);
  expect(opened).toEqual([{
    executable: 'codex',
    arguments: ['resume', '019ed4a3-2186-7e51-9aa1-ca1e376549b8'],
    directory: process.cwd(),
  }]);
  expect(markedRunning).toBe(true);
});
