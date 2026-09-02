import { describe, expect, test } from 'bun:test';
import { isAllowedRequestHost } from '../web/api/request-security.js';

describe('request Host allowlist', () => {
  test('accepts loopback aliases for a loopback-bound server', () => {
    expect(isAllowedRequestHost(
      new Request('http://127.0.0.1:3377/ws', { headers: { host: 'localhost:3377' } }),
      '127.0.0.1',
      3377,
    )).toBe(true);
    expect(isAllowedRequestHost(
      new Request('http://127.0.0.1:3377/ws', { headers: { host: '[::1]:3377' } }),
      '127.0.0.1',
      3377,
    )).toBe(true);
  });

  test('rejects attacker-controlled Host values', () => {
    const req = new Request('http://127.0.0.1:3377/ws', {
      headers: { host: 'evil.test' },
    });
    expect(isAllowedRequestHost(req, '127.0.0.1', 3377)).toBe(false);
  });

  test('accepts configured public hosts for reverse proxies', () => {
    const req = new Request('http://127.0.0.1:3377/ws', {
      headers: { host: 'hub.example.com' },
    });
    expect(isAllowedRequestHost(
      req,
      '127.0.0.1',
      3377,
      ['https://hub.example.com'],
    )).toBe(true);
  });

  test('accepts local interface hosts for wildcard-bound servers', () => {
    const req = new Request('http://192.168.1.10:3377/ws', {
      headers: { host: '192.168.1.10:3377' },
    });
    expect(isAllowedRequestHost(req, '0.0.0.0', 3377, [], ['192.168.1.10'])).toBe(true);
  });

  test('rejects arbitrary hosts for wildcard-bound servers', () => {
    const req = new Request('http://attacker.example:3377/ws', {
      headers: { host: 'attacker.example:3377' },
    });
    expect(isAllowedRequestHost(req, '0.0.0.0', 3377, [], ['192.168.1.10'])).toBe(false);
  });
});
