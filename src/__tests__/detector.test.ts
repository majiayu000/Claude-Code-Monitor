/**
 * Integration tests for session status detection
 *
 * These tests verify the complete detection logic using real data structures.
 * Following best practices:
 * - Test features, not implementation details
 * - Use real objects, no mocks
 * - Test observable behavior
 */

import { describe, test, expect } from 'bun:test';
import {
  detectSessionStatus,
  isSessionCompleted,
  needsAttention,
  getStatusDescription,
} from '../adapters/process/detector.js';
import type { ClaudeProcessInfo } from '../adapters/process/types.js';
import type { SessionStatus } from '../domain/session/index.js';
import { resolveAggregatedStatus } from '../services/session.aggregator.js';

// ============================================================================
// Test Data: Real process info structures (not mocks)
// ============================================================================

/** Creates a valid ClaudeProcessInfo with realistic values */
function processInfo(overrides: Partial<ClaudeProcessInfo> = {}): ClaudeProcessInfo {
  return {
    client: 'claude',
    pid: process.pid, // Use current process PID for realism
    cwd: process.cwd(),
    cpu: 0.5,
    memory: 50.0,
    startTime: new Date(),
    args: ['--version'],
    tty: undefined,
    ...overrides,
  };
}

/** Creates a Date representing seconds ago from now */
function secondsAgo(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

// ============================================================================
// Feature: Session Status Detection
// ============================================================================

describe('Session Status Detection', () => {
  test('preserves a hook-derived waiting state while its process is alive', () => {
    expect(resolveAggregatedStatus(
      { status: 'waiting', lastActiveAt: new Date() },
      processInfo({ cpu: 10 })
    )).toBe('waiting');
  });

  describe('when process is not running', () => {
    test('status is "lost" - session terminated unexpectedly', () => {
      const status = detectSessionStatus(null);

      expect(status).toBe('lost');
      expect(getStatusDescription(status)).toBe('Process terminated unexpectedly');
      expect(needsAttention(status)).toBe(true);
    });

    test('status is "lost" regardless of last activity time', () => {
      expect(detectSessionStatus(null, secondsAgo(1))).toBe('lost');
      expect(detectSessionStatus(null, secondsAgo(100))).toBe('lost');
      expect(detectSessionStatus(null, new Date(0))).toBe('lost');
    });
  });

  describe('when process is actively using CPU', () => {
    test('status is "running" when CPU > threshold', () => {
      const activeProcess = processInfo({ cpu: 5.0 });
      const status = detectSessionStatus(activeProcess);

      expect(status).toBe('running');
      expect(getStatusDescription(status)).toBe('Actively processing');
      expect(needsAttention(status)).toBe(false);
    });

    test('status is "running" at high CPU even with old activity', () => {
      const activeProcess = processInfo({ cpu: 10.0 });
      const oldActivity = secondsAgo(120);

      expect(detectSessionStatus(activeProcess, oldActivity)).toBe('running');
    });
  });

  describe('when process has recent activity (< 5 seconds)', () => {
    test('status is "running" - actively processing', () => {
      const idleProcess = processInfo({ cpu: 0.1 });
      const recentActivity = secondsAgo(2);

      const status = detectSessionStatus(idleProcess, recentActivity);

      expect(status).toBe('running');
    });

    test('boundary: exactly at 5 second threshold', () => {
      const idleProcess = processInfo({ cpu: 0.1 });
      // Just under 5 seconds should be running
      expect(detectSessionStatus(idleProcess, secondsAgo(4.9))).toBe('running');
    });
  });

  describe('when process has moderate activity (5-30 seconds)', () => {
    test('status is "waiting" - waiting for user input', () => {
      const idleProcess = processInfo({ cpu: 0.1 });
      const moderateActivity = secondsAgo(15);

      const status = detectSessionStatus(idleProcess, moderateActivity);

      expect(status).toBe('waiting');
      expect(getStatusDescription(status)).toBe('Waiting for user input');
      expect(needsAttention(status)).toBe(true);
    });

    test('at 10 seconds: still waiting', () => {
      const idleProcess = processInfo({ cpu: 0.1 });
      expect(detectSessionStatus(idleProcess, secondsAgo(10))).toBe('waiting');
    });

    test('at 25 seconds: still waiting', () => {
      const idleProcess = processInfo({ cpu: 0.1 });
      expect(detectSessionStatus(idleProcess, secondsAgo(25))).toBe('waiting');
    });
  });

  describe('when process has old activity (> 30 seconds)', () => {
    test('status is "idle" - process running but inactive', () => {
      const idleProcess = processInfo({ cpu: 0.1 });
      const oldActivity = secondsAgo(60);

      const status = detectSessionStatus(idleProcess, oldActivity);

      expect(status).toBe('idle');
      expect(getStatusDescription(status)).toBe('Idle but running');
      expect(needsAttention(status)).toBe(false);
    });

    test('boundary: exactly at 30 second threshold', () => {
      const idleProcess = processInfo({ cpu: 0.1 });
      // Just over 30 seconds should be idle
      expect(detectSessionStatus(idleProcess, secondsAgo(31))).toBe('idle');
    });

    test('very old activity still results in idle', () => {
      const idleProcess = processInfo({ cpu: 0.1 });
      expect(detectSessionStatus(idleProcess, secondsAgo(3600))).toBe('idle');
    });
  });

  describe('when no activity date is provided', () => {
    test('low CPU process is "idle"', () => {
      const idleProcess = processInfo({ cpu: 0.1 });
      expect(detectSessionStatus(idleProcess)).toBe('idle');
    });

    test('high CPU process is "running"', () => {
      const activeProcess = processInfo({ cpu: 5.0 });
      expect(detectSessionStatus(activeProcess)).toBe('running');
    });
  });
});

// ============================================================================
// Feature: Session Completion Detection
// ============================================================================

describe('Session Completion Detection', () => {
  describe('when process is still running', () => {
    test('session is not completed regardless of last tool', () => {
      const runningProcess = processInfo();

      expect(isSessionCompleted(runningProcess, 'Write')).toBe(false);
      expect(isSessionCompleted(runningProcess, 'TodoWrite')).toBe(false);
      expect(isSessionCompleted(runningProcess, 'Edit')).toBe(false);
      expect(isSessionCompleted(runningProcess, 'Read')).toBe(false);
    });
  });

  describe('when process has terminated', () => {
    test('completed if last tool was Write', () => {
      expect(isSessionCompleted(null, 'Write')).toBe(true);
    });

    test('completed if last tool was TodoWrite', () => {
      expect(isSessionCompleted(null, 'TodoWrite')).toBe(true);
    });

    test('completed if last tool was Edit', () => {
      expect(isSessionCompleted(null, 'Edit')).toBe(true);
    });

    test('not completed if last tool was Read', () => {
      expect(isSessionCompleted(null, 'Read')).toBe(false);
    });

    test('not completed if last tool was Bash', () => {
      expect(isSessionCompleted(null, 'Bash')).toBe(false);
    });

    test('not completed if no last tool provided', () => {
      expect(isSessionCompleted(null)).toBe(false);
      expect(isSessionCompleted(null, undefined)).toBe(false);
    });
  });
});

// ============================================================================
// Feature: Attention Required Detection
// ============================================================================

describe('Attention Required Detection', () => {
  const allStatuses: SessionStatus[] = ['running', 'waiting', 'idle', 'lost', 'completed'];

  describe('statuses that need attention', () => {
    test('"lost" sessions need attention - user should recover', () => {
      expect(needsAttention('lost')).toBe(true);
    });

    test('"waiting" sessions need attention - user should respond', () => {
      expect(needsAttention('waiting')).toBe(true);
    });
  });

  describe('statuses that do not need attention', () => {
    test('"running" sessions are fine', () => {
      expect(needsAttention('running')).toBe(false);
    });

    test('"idle" sessions are fine', () => {
      expect(needsAttention('idle')).toBe(false);
    });

    test('"completed" sessions are fine', () => {
      expect(needsAttention('completed')).toBe(false);
    });
  });

  test('all status types are covered', () => {
    // Ensure we have tested all possible statuses
    for (const status of allStatuses) {
      expect(typeof needsAttention(status)).toBe('boolean');
    }
  });
});

// ============================================================================
// Feature: Status Descriptions
// ============================================================================

describe('Status Descriptions', () => {
  test('each status has a human-readable description', () => {
    const descriptions: Record<SessionStatus, string> = {
      running: 'Actively processing',
      waiting: 'Waiting for user input',
      idle: 'Idle but running',
      lost: 'Process terminated unexpectedly',
      completed: 'Session completed',
    };

    for (const [status, expected] of Object.entries(descriptions)) {
      expect(getStatusDescription(status as SessionStatus)).toBe(expected);
    }
  });

  test('descriptions are non-empty strings', () => {
    const statuses: SessionStatus[] = ['running', 'waiting', 'idle', 'lost', 'completed'];

    for (const status of statuses) {
      const description = getStatusDescription(status);
      expect(typeof description).toBe('string');
      expect(description.length).toBeGreaterThan(0);
    }
  });
});
