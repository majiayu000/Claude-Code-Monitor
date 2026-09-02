/**
 * Session ID validation shared by scanners, persistence, and recovery sinks.
 */

const SESSION_ID_PATTERN = /^[a-zA-Z0-9-_]{8,64}$/;

/** Validate session ID format used by Keepline recovery APIs. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id);
}

/** Throw when a value cannot safely be used as a recovery session ID. */
export function assertValidSessionId(id: unknown): asserts id is string {
  if (!isValidSessionId(id)) {
    throw new Error('Invalid session ID format');
  }
}

export function scopeCodexSessionId(rawSessionId: string): string {
  return rawSessionId.startsWith('codex_') ? rawSessionId : `codex_${rawSessionId}`;
}

export function unscopeCodexSessionId(sessionId: string): string {
  return sessionId.startsWith('codex_') ? sessionId.slice('codex_'.length) : sessionId;
}
