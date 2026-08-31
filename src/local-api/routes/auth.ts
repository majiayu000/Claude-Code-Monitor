import type { Context } from 'hono';
import { Hono } from 'hono';
import { getConnInfo } from 'hono/bun';
import { localLogin, logAudit } from '../../services/auth.service.js';
import { rateLimit } from '../../web/api/middleware/rateLimit.js';

const app = new Hono();

function isLoopback(value: string | undefined): boolean {
  const host = value?.trim().toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1' ||
    host === 'localhost';
}

function requestHostIsLoopback(c: Context): boolean {
  const header = c.req.header('host');
  if (!header) return false;
  try {
    return isLoopback(new URL(`http://${header}`).hostname);
  } catch {
    return false;
  }
}

function requestOriginIsAllowed(c: Context): boolean {
  const origin = c.req.header('origin');
  if (origin) {
    try {
      if (!isLoopback(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  const fetchSite = c.req.header('sec-fetch-site')?.trim().toLowerCase();
  return !fetchSite || ['same-origin', 'same-site', 'none'].includes(fetchSite);
}

function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote?.address;
  } catch {
    return undefined;
  }
}

app.post('/local', rateLimit(10, 60_000), async (c) => {
  const peer = peerAddress(c);
  // This router is mounted only by the service that is actually bound to loopback.
  // Do not consult KEEPLINE_HOST: it configures other modes and must not disable service auth.
  if (!isLoopback(peer) || !requestHostIsLoopback(c) || !requestOriginIsAllowed(c)) {
    return c.json({ success: false, error: 'Local login only available from localhost' }, 403);
  }
  try {
    const result = await localLogin();
    logAudit(null, 'local_login', peer);
    return c.json({ success: true, data: result });
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Local login failed',
    }, 500);
  }
});

export default app;
