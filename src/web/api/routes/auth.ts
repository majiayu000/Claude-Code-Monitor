/**
 * Auth routes for the local web dashboard.
 *
 * Handles setup, login, logout, and status checks.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { getConnInfo } from 'hono/bun';
import { getClientIp, rateLimit, resetRateLimitKey } from '../middleware/rateLimit.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  isSetupComplete,
  setupUser,
  login,
  localLogin,
  revokeToken,
  logAudit,
} from '../../../services/auth.service.js';
import type { JwtPayload } from '../../../services/auth.service.js';
import { logger } from '../../../lib/logger.js';
import {
  isAllowedFetchMetadata,
  isLoopbackHostHeader,
  isLoopbackOrigin,
} from '../request-security.js';
import { isLoopbackHost } from '../web-network.js';

const auth = new Hono();
const LOGIN_USERNAME_RATE_LIMIT_SCOPE = 'auth-login-username';

function loginUsernameRateLimitKey(username: string): string {
  return `login:${username.slice(0, 64).toLowerCase()}`;
}

function getTcpPeerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote?.address;
  } catch (error) {
    logger.warn('Unable to resolve TCP peer for local login', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function isLoopbackPeer(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function hasConfiguredPublicOrigin(): boolean {
  const configuredOrigins = [
    process.env.KEEPLINE_PUBLIC_ORIGIN,
    process.env.KEEPLINE_ALLOWED_ORIGINS,
  ];
  return configuredOrigins
    .flatMap((value) => (value ?? '').split(','))
    .some((value) => value.trim().length > 0);
}

function isLoopbackOnlyServerMode(): boolean {
  const hostname = process.env.KEEPLINE_HOST || '127.0.0.1';
  return isLoopbackHost(hostname) && !hasConfiguredPublicOrigin();
}

function isAllowedLocalLoginBrowserContext(c: Context): boolean {
  const host = c.req.header('host');
  if (!isLoopbackHostHeader(host)) return false;

  const origin = c.req.header('origin');
  if (origin && !isLoopbackOrigin(origin)) return false;

  return isAllowedFetchMetadata(c.req.raw);
}

/**
 * Defence-in-depth limit: lock out the *username* after too many failed
 * attempts inside the window, regardless of source IP. This is what
 * blocks credential-stuffing through rotating proxies — the per-IP limit
 * alone is bypassed once the attacker has more IPs than the limit.
 *
 * We extract the username out-of-band by peeking at the request body. The
 * extractor must not throw; on any failure we fall back to the constant
 * `unknown` bucket which still applies a small global cap.
 */
async function loginUsernameKey(c: Context): Promise<string> {
  try {
    const cloned = c.req.raw.clone();
    const body = (await cloned.json()) as { username?: unknown };
    if (typeof body.username === 'string' && body.username.length > 0) {
      return loginUsernameRateLimitKey(body.username);
    }
  } catch {
    // fall through
  }
  return 'login:__unknown__';
}

// GET /api/auth/status - Check if setup is complete and if user is authenticated
auth.get('/status', async (c) => {
  const setupComplete = await isSetupComplete();

  // Check if current token is valid
  let authenticated = false;
  let username: string | undefined;
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const { verifyToken } = await import('../../../services/auth.service.js');
    const payload = verifyToken(authHeader.slice(7));
    if (payload) {
      authenticated = true;
      username = payload.username;
    }
  }

  return c.json({ success: true, data: { setupComplete, authenticated, username } });
});

// POST /api/auth/setup - First-run user creation
auth.post('/setup', rateLimit(5, 60 * 1000), async (c) => {
  try {
    const body = await c.req.json();
    const { username, password, enableTotp } = body;

    if (!username || !password) {
      return c.json({ success: false, error: 'Username and password required' }, 400);
    }
    if (username.length < 3 || username.length > 32) {
      return c.json({ success: false, error: 'Username must be 3-32 characters' }, 400);
    }
    if (password.length < 8) {
      return c.json({ success: false, error: 'Password must be at least 8 characters' }, 400);
    }

    const result = await setupUser(username, password, enableTotp);
    const ip = getClientIp(c);
    logAudit(null, 'setup_complete', ip);

    return c.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Setup failed';
    return c.json({ success: false, error: message }, 400);
  }
});

// POST /api/auth/login - Authenticate.
// Two-layer rate limit: per-IP (default) AND per-username. The per-username
// layer makes credential-stuffing across rotating proxies expensive: 10
// attempts per username per 5 minutes regardless of source IP.
auth.post(
  '/login',
  rateLimit(10, 60 * 1000),
  rateLimit(10, 5 * 60 * 1000, {
    keyExtractor: loginUsernameKey,
    scope: LOGIN_USERNAME_RATE_LIMIT_SCOPE,
  }),
  async (c) => {
  try {
    const body = await c.req.json();
    const { username, password, totpCode } = body;

    if (!username || !password) {
      return c.json({ success: false, error: 'Username and password required' }, 400);
    }

    const result = await login(username, password, totpCode);
    resetRateLimitKey(LOGIN_USERNAME_RATE_LIMIT_SCOPE, loginUsernameRateLimitKey(username));
    const ip = getClientIp(c);
    logAudit(null, 'login_success', ip, `User: ${username}`);

    return c.json({ success: true, data: result });
  } catch (e) {
    const ip = getClientIp(c);
    logAudit(null, 'login_failed', ip);
    const message = e instanceof Error ? e.message : 'Login failed';
    return c.json({ success: false, error: message }, 401);
  }
});

// POST /api/auth/logout - Revoke current token
// POST /api/auth/local - Localhost passwordless login
auth.post('/local', rateLimit(10, 60 * 1000), async (c) => {
  const peerAddress = getTcpPeerAddress(c);
  if (
    !isLoopbackOnlyServerMode() ||
    !isLoopbackPeer(peerAddress) ||
    !isAllowedLocalLoginBrowserContext(c)
  ) {
    return c.json({ success: false, error: 'Local login only available from localhost' }, 403);
  }

  try {
    const result = await localLogin();
    logAudit(null, 'local_login', peerAddress);
    return c.json({ success: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Local login failed';
    return c.json({ success: false, error: message }, 500);
  }
});

// POST /api/auth/logout - Revoke current token
auth.post('/logout', authMiddleware, async (c) => {
  const user = (c as any).get('user') as JwtPayload;
  revokeToken(user.jti);
  logAudit(user.sub, 'logout');
  return c.json({ success: true });
});

export default auth;
