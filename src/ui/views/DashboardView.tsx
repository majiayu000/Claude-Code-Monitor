/**
 * Style B: Dashboard Cards View (btop/htop inspired)
 * - Boxed sections
 * - Stats widgets
 * - Clear visual hierarchy
 */

import React from 'react';
import { Box, Text } from 'ink';
import {
  SESSION_STATUS_PRESENTATION,
  type Session,
  type SessionStatus,
} from '../../domain/session/index.js';

interface Props {
  sessions: Session[];
  stats: { total: number; running: number; waiting: number; idle: number; lost: number };
}

const icons: Record<SessionStatus, string> = {
  running: '●',
  waiting: '◐',
  idle: '○',
  lost: '✖',
  completed: '✔',
};

const colors: Record<SessionStatus, string> = {
  running: '#9ece6a',
  waiting: '#ff9e64',
  idle: '#7dcfff',
  lost: '#f7768e',
  completed: '#565f89',
};

function formatPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function truncate(text: string, len = 38): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= len ? clean : clean.slice(0, len - 1) + '…';
}

function StatBox({ label, value, color }: { label: string; value: number; color: string }): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor="#414868"
      paddingX={1}
      marginRight={1}
    >
      <Text color={color} bold>{value}</Text>
      <Text color="#565f89"> {label}</Text>
    </Box>
  );
}

export function DashboardView({ sessions, stats }: Props): React.ReactElement {
  // Group by status
  const running = sessions.filter(s => s.status === 'running' || s.status === 'waiting');
  const idle = sessions.filter(s => s.status === 'idle');
  const lost = sessions.filter(s => s.status === 'lost');

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="#bb9af7" bold>╭─ </Text>
        <Text color="#7dcfff" bold>KEEPLINE</Text>
        <Text color="#bb9af7" bold> ─╮</Text>
        <Text color="#565f89"> agent runtime session control center</Text>
      </Box>

      {/* Stats Row */}
      <Box marginBottom={1}>
        <StatBox label="total" value={stats.total} color="#c0caf5" />
        <StatBox label="run" value={stats.running} color="#9ece6a" />
        <StatBox label="wait" value={stats.waiting} color="#ff9e64" />
        <StatBox label="idle" value={stats.idle} color="#7dcfff" />
        <StatBox
          label={SESSION_STATUS_PRESENTATION.lost.label.toLowerCase()}
          value={stats.lost}
          color="#f7768e"
        />
      </Box>

      {/* Active Sessions Box */}
      {running.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor="#9ece6a" marginBottom={1}>
          <Box paddingX={1}>
            <Text color="#9ece6a" bold>▌ACTIVE ({running.length})</Text>
          </Box>
          {running.map((session, idx) => (
            <Box key={session.sessionId} paddingX={1}>
              <Text color="#565f89">{String(idx + 1).padStart(2)} </Text>
              <Text color={colors[session.status]}>{icons[session.status]} </Text>
              <Text color="#c0caf5">{formatPath(session.directory).padEnd(22).slice(0, 22)} </Text>
              <Text color="#565f89">{truncate(session.title || session.initialPrompt || '—')}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Idle Sessions Box */}
      {idle.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor="#414868" marginBottom={1}>
          <Box paddingX={1}>
            <Text color="#7dcfff" bold>▌IDLE ({idle.length})</Text>
          </Box>
          {idle.slice(0, 8).map((session, idx) => (
            <Box key={session.sessionId} paddingX={1}>
              <Text color="#565f89">{String(running.length + idx + 1).padStart(2)} </Text>
              <Text color="#7dcfff">{icons.idle} </Text>
              <Text color="#a9b1d6">{formatPath(session.directory).padEnd(22).slice(0, 22)} </Text>
              <Text color="#565f89">{truncate(session.title || session.initialPrompt || '—')}</Text>
              <Text color="#414868"> {timeAgo(session.lastActiveAt)}</Text>
            </Box>
          ))}
          {idle.length > 8 && (
            <Box paddingX={1}>
              <Text color="#565f89">   ... +{idle.length - 8} more</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Lost Sessions Box */}
      {lost.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor="#f7768e" marginBottom={1}>
          <Box paddingX={1}>
            <Text color="#f7768e" bold>
              ▌{SESSION_STATUS_PRESENTATION.lost.shortLabel} ({lost.length})
            </Text>
            <Text color="#565f89"> — can be recovered</Text>
          </Box>
          {lost.slice(0, 5).map((session, idx) => (
            <Box key={session.sessionId} paddingX={1}>
              <Text color="#565f89">{String(running.length + idle.length + idx + 1).padStart(2)} </Text>
              <Text color="#f7768e">{icons.lost} </Text>
              <Text color="#9aa5ce">{formatPath(session.directory).padEnd(22).slice(0, 22)} </Text>
              <Text color="#565f89">{truncate(session.title || session.initialPrompt || '—')}</Text>
              <Text color="#414868"> {timeAgo(session.lastActiveAt)}</Text>
            </Box>
          ))}
          {lost.length > 5 && (
            <Box paddingX={1}>
              <Text color="#565f89">   ... +{lost.length - 5} more</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Footer hint */}
      <Box>
        <Text color="#414868">╰─ </Text>
        <Text color="#565f89">recover: </Text>
        <Text color="#7dcfff">keepline r {'<n>'}</Text>
        <Text color="#414868"> ─╯</Text>
      </Box>
    </Box>
  );
}
