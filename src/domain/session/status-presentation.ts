import type { SessionStatus } from './value-objects.js';
import { SESSION_STATUSES } from './value-objects.js';

export interface SessionStatusPresentation {
  status: SessionStatus;
  label: string;
  shortLabel: string;
  icon: string;
  order: number;
}

export const SESSION_STATUS_PRESENTATION: Record<SessionStatus, SessionStatusPresentation> = {
  running: { status: 'running', label: 'Running', shortLabel: 'EXEC', icon: '▶', order: 0 },
  waiting: { status: 'waiting', label: 'Waiting', shortLabel: 'WAIT', icon: '⏸', order: 1 },
  idle: { status: 'idle', label: 'Idle', shortLabel: 'IDLE', icon: '◇', order: 2 },
  lost: {
    status: 'lost',
    label: 'Interrupted',
    shortLabel: 'INTR',
    icon: '↻',
    order: 3,
  },
  completed: { status: 'completed', label: 'Completed', shortLabel: 'DONE', icon: '✓', order: 4 },
};

export const SESSION_STATUS_ORDER: readonly SessionStatus[] = SESSION_STATUSES;

export function getSessionStatusPresentation(status: SessionStatus): SessionStatusPresentation {
  return SESSION_STATUS_PRESENTATION[status];
}
