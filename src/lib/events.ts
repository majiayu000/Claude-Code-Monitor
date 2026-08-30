/**
 * Event system for Keepline
 */

import EventEmitter from 'eventemitter3';
import type { Session, SessionStatus } from '../domain/session/index.js';

/** Event payload for session lifecycle events. */
export interface SessionEventPayload {
  session: Session;
  previousStatus?: SessionStatus;
}

/** Event payload for tool hook events. */
export interface ToolEventPayload {
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  output?: string;
  timestamp: Date;
}

/** Event payload for session end events. */
export interface SessionEndEventPayload {
  sessionId: string;
  timestamp: Date;
  reason?: string;
}

/** Event types */
export type KeeplineEvents = {
  // Session events
  'session:discovered': SessionEventPayload;
  'session:updated': SessionEventPayload;
  'session:lost': SessionEventPayload;
  'session:recovered': SessionEventPayload;
  'session:completed': SessionEventPayload;
  'session:end': SessionEndEventPayload;

  // Tool events (from hooks)
  'tool:pre': ToolEventPayload;
  'tool:post': ToolEventPayload;

  // System events
  'daemon:started': { pid: number };
  'daemon:stopped': { reason: string };
  'scan:complete': { sessionCount: number; duration: number };
  'dispatch:created': { dispatchId: string };
  'error': { error: Error; context: string };
};

/** Global event emitter instance */
class KeeplineEventEmitter extends EventEmitter<KeeplineEvents> {
  private static instance: KeeplineEventEmitter;

  private constructor() {
    super();
  }

  static getInstance(): KeeplineEventEmitter {
    if (!KeeplineEventEmitter.instance) {
      KeeplineEventEmitter.instance = new KeeplineEventEmitter();
    }
    return KeeplineEventEmitter.instance;
  }
}

/** Export singleton instance */
export const events = KeeplineEventEmitter.getInstance();

/** Helper to emit typed events */
export function emit<K extends keyof KeeplineEvents>(
  event: K,
  payload: KeeplineEvents[K]
): void {
  events.emit(event, payload);
}

/** Helper to listen to typed events */
export function on<K extends keyof KeeplineEvents>(
  event: K,
  handler: (payload: KeeplineEvents[K]) => void
): void {
  events.on(event, handler as (...args: unknown[]) => void);
}
