import { describe, expect, test } from 'bun:test';
import { hasCompatibleService } from '../web/api/server.js';

const healthyService = () => Promise.resolve(new Response(JSON.stringify({
  success: true,
  data: { status: 'ok', mode: 'service' },
}), {
  status: 200,
  headers: { 'content-type': 'application/json' },
}));

describe('Keepline Web and Service Mode coexistence', () => {
  test('uses a compatible loopback service on a different port', async () => {
    expect(await hasCompatibleService(
      3378,
      'http://127.0.0.1:3377',
      healthyService
    )).toBe(true);
  });

  test('never probes its own port as a separate service', async () => {
    let called = false;
    const probe = () => {
      called = true;
      return healthyService();
    };

    expect(await hasCompatibleService(3377, 'http://127.0.0.1:3377', probe)).toBe(false);
    expect(called).toBe(false);
  });

  test('rejects non-loopback service URLs', async () => {
    expect(await hasCompatibleService(
      3378,
      'https://example.com',
      healthyService
    )).toBe(false);
  });

  test('falls back when the endpoint is not Service Mode', async () => {
    const dashboard = () => Promise.resolve(new Response(JSON.stringify({
      success: true,
      data: { status: 'ok', mode: 'web' },
    }), { status: 200 }));

    expect(await hasCompatibleService(
      3378,
      'http://127.0.0.1:3377',
      dashboard
    )).toBe(false);
  });
});
