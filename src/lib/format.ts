/**
 * Formatting utilities for CLI output
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import {
  SESSION_STATUS_PRESENTATION,
  type Session,
  type SessionStatus,
} from '../domain/session/index.js';

/** Status display configuration */
const statusConfig: Record<SessionStatus, { label: string; color: (s: string) => string }> = {
  running: { label: 'Running', color: chalk.green },
  waiting: { label: 'Waiting', color: chalk.yellow },
  idle: { label: 'Idle', color: chalk.blue },
  lost: { label: SESSION_STATUS_PRESENTATION.lost.label, color: chalk.red },
  completed: { label: 'Done', color: chalk.gray },
};

/** Format session status with color */
export function formatStatus(status: SessionStatus): string {
  const { label, color } = statusConfig[status];
  return color(label);
}

/** Format directory path (truncate if too long) */
export function formatDirectory(dir: string, maxLength = 40): string {
  if (dir.length <= maxLength) return dir;
  return '...' + dir.slice(-(maxLength - 3));
}

/** Format time ago */
export function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Format session title (truncate if needed) */
export function formatTitle(title: string, maxLength = 50): string {
  if (title.length <= maxLength) return title;
  return title.slice(0, maxLength - 3) + '...';
}

/** Create sessions table */
export function createSessionTable(sessions: Session[]): string {
  const table = new Table({
    head: [
      chalk.bold('#'),
      chalk.bold('Directory'),
      chalk.bold('Status'),
      chalk.bold('Task'),
      chalk.bold('Last Active'),
    ],
    colWidths: [5, 42, 10, 52, 12],
    wordWrap: true,
  });

  sessions.forEach((session, index) => {
    table.push([
      String(index + 1),
      formatDirectory(session.directory),
      formatStatus(session.status),
      formatTitle(session.title || session.initialPrompt),
      formatTimeAgo(session.lastActiveAt),
    ]);
  });

  return table.toString();
}

/** Format session detail */
export function formatSessionDetail(session: Session): string {
  const lines = [
    chalk.bold('Session Details'),
    '',
    `${chalk.gray('ID:')}         ${session.sessionId}`,
    `${chalk.gray('Directory:')}  ${session.directory}`,
    `${chalk.gray('Status:')}     ${formatStatus(session.status)}`,
    `${chalk.gray('PID:')}        ${session.pid ?? 'N/A'}`,
    '',
    chalk.gray('Task:'),
    session.title || session.initialPrompt,
    '',
    `${chalk.gray('Started:')}    ${session.startedAt?.toISOString() ?? 'N/A'}`,
    `${chalk.gray('Last Active:')} ${session.lastActiveAt.toISOString()}`,
    `${chalk.gray('Messages:')}   ${session.messageCount}`,
    `${chalk.gray('Tools Used:')} ${session.toolCount}`,
  ];

  if (session.lastTool) {
    lines.push('', chalk.gray('Last Tool:'), session.lastTool);
  }

  return lines.join('\n');
}
