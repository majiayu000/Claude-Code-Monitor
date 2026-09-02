/**
 * Authentication service for the local web dashboard.
 *
 * Handles user management, JWT tokens, and TOTP 2FA.
 */

import { randomUUID, timingSafeEqual } from 'crypto';
import { queryOne, runSql } from '../infrastructure/database/sqlite.js';
import { logger } from '../lib/logger.js';

// JWT secret - auto-generated on first use, cached in memory
let jwtSecret: string | null = null;

function getJwtSecret(): string {
  if (jwtSecret) return jwtSecret;

  const row = queryOne<{ value: string }>(
    "SELECT value FROM metadata WHERE key = 'terminal_jwt_secret'"
  );

  if (row) {
    jwtSecret = row.value;
  } else {
    jwtSecret = randomUUID() + randomUUID();
    runSql(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('terminal_jwt_secret', ?)",
      [jwtSecret]
    );
  }

  return jwtSecret;
}

// ── Helpers ──

function base64url(data: string): string {
  return Buffer.from(data).toString('base64url');
}

function hmacSign(payload: string): string {
  const hmac = new Bun.CryptoHasher('sha256', getJwtSecret());
  hmac.update(payload);
  return hmac.digest('base64url') as unknown as string;
}

/**
 * Constant-time string comparison.
 *
 * `!==` short-circuits at the first mismatched byte and leaks the position of
 * the first differing character through wall-clock time. For HMAC signatures
 * this lets an attacker recover bytes one at a time. `timingSafeEqual` always
 * compares both buffers in full and only fails fast on a length mismatch
 * (which is fine because length is not secret here — both sides are
 * deterministic SHA-256/base64url encodings of fixed length).
 */
function safeEqual(a: string, b: string): boolean {
  // Length-mismatch shortcut is intentional: HMAC outputs are fixed-length,
  // so a length difference is guaranteed to be a forgery.
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Defensive guard: timingSafeEqual throws on differing lengths.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ── JWT ──

interface JwtPayload {
  sub: string; // user id
  username: string;
  iat: number;
  exp: number;
  jti: string; // session id for revocation
}

function createToken(userId: string, username: string, expiryHours: number = 72): { token: string; sessionId: string } {
  const sessionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const payload: JwtPayload = {
    sub: userId,
    username,
    iat: now,
    exp: now + expiryHours * 3600,
    jti: sessionId,
  };

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = hmacSign(`${header}.${body}`);
  const token = `${header}.${body}.${signature}`;

  // Store session for revocation
  const tokenHash = Bun.hash(token).toString();
  runSql(
    'INSERT INTO terminal_auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [sessionId, userId, tokenHash, new Date(payload.exp * 1000).toISOString()]
  );

  return { token, sessionId };
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;
    const expectedSig = hmacSign(`${header}.${body}`);
    if (!safeEqual(signature, expectedSig)) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as JwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    // Check revocation
    const session = queryOne<{ revoked: number }>(
      'SELECT revoked FROM terminal_auth_sessions WHERE id = ?',
      [payload.jti]
    );
    if (!session || session.revoked) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── User Management ──

export async function isSetupComplete(): Promise<boolean> {
  const user = queryOne<{ id: string }>('SELECT id FROM terminal_users LIMIT 1');
  return !!user;
}

export async function setupUser(
  username: string,
  password: string,
  enableTotp: boolean = false
): Promise<{ token: string; totpUri?: string }> {
  // Only allow setup if no users exist
  if (await isSetupComplete()) {
    throw new Error('Setup already completed');
  }

  const userId = randomUUID();
  const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });

  let totpSecret: string | null = null;
  let totpUri: string | undefined;

  if (enableTotp) {
    const { TOTP } = await import('otpauth');
    const totp = new TOTP({ issuer: 'Keepline', label: username, digits: 6, period: 30 });
    totpSecret = totp.secret.base32;
    totpUri = totp.toString();
  }

  runSql(
    'INSERT INTO terminal_users (id, username, password_hash, totp_secret, totp_enabled) VALUES (?, ?, ?, ?, ?)',
    [userId, username, passwordHash, totpSecret, enableTotp ? 1 : 0]
  );

  const { token } = createToken(userId, username);
  logAudit(userId, 'setup', undefined, 'Initial user setup');

  return { token, totpUri };
}

export async function login(
  username: string,
  password: string,
  totpCode?: string
): Promise<{ token: string }> {
  const user = queryOne<{
    id: string;
    username: string;
    password_hash: string;
    totp_enabled: number;
    totp_secret: string | null;
  }>('SELECT * FROM terminal_users WHERE username = ?', [username]);

  if (!user) throw new Error('Invalid credentials');

  const valid = await Bun.password.verify(password, user.password_hash);
  if (!valid) throw new Error('Invalid credentials');

  if (user.totp_enabled && user.totp_secret) {
    if (!totpCode) throw new Error('TOTP code required');
    const { TOTP } = await import('otpauth');
    const totp = new TOTP({
      issuer: 'Keepline',
      label: user.username,
      digits: 6,
      period: 30,
      secret: user.totp_secret,
    });
    const delta = totp.validate({ token: totpCode, window: 1 });
    if (delta === null) throw new Error('Invalid TOTP code');
  }

  const { token } = createToken(user.id, user.username);
  logAudit(user.id, 'login', undefined);

  return { token };
}

export async function localLogin(): Promise<{ token: string }> {
  // Get or create a local user
  let user = queryOne<{ id: string; username: string }>(
    'SELECT id, username FROM terminal_users LIMIT 1'
  );

  if (!user) {
    // Auto-create a local user
    const userId = randomUUID();
    const passwordHash = await Bun.password.hash(randomUUID(), { algorithm: 'argon2id' });
    runSql(
      'INSERT INTO terminal_users (id, username, password_hash, totp_enabled) VALUES (?, ?, ?, 0)',
      [userId, 'local', passwordHash]
    );
    user = { id: userId, username: 'local' };
  }

  const { token } = createToken(user.id, user.username);
  logAudit(user.id, 'local_login', undefined);

  return { token };
}

export function revokeToken(jti: string): void {
  runSql('UPDATE terminal_auth_sessions SET revoked = 1 WHERE id = ?', [jti]);
}

export function revokeAllTokens(userId: string): void {
  runSql('UPDATE terminal_auth_sessions SET revoked = 1 WHERE user_id = ?', [userId]);
}

// ── Audit ──

export function logAudit(userId: string | null, action: string, ip?: string, details?: string): void {
  try {
    runSql(
      'INSERT INTO terminal_audit_log (user_id, action, ip, details) VALUES (?, ?, ?, ?)',
      [userId, action, ip || null, details || null]
    );
  } catch (e) {
    logger.error('Failed to write audit log', e);
    throw new Error('Failed to write audit log');
  }
}

export type { JwtPayload };
