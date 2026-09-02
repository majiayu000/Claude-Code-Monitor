/**
 * Style D: macOS / Apple Inspired View
 * - Clean, rounded corners feel
 * - SF-style aesthetics
 * - Emoji status indicators
 * - Soft gradients
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
  running: '🟢',
  waiting: '🟡',
  idle: '⚪',
  lost: '🔴',
  completed: '✅',
};

// Status colors (for potential future use)
const _colors: Record<SessionStatus, string> = {
  running: '#34c759',
  waiting: '#ff9500',
  idle: '#007aff',
  lost: '#ff3b30',
  completed: '#8e8e93',
};
void _colors;

function formatPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join('/');
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr`;
  return `${Math.floor(s / 86400)} day`;
}

function truncate(text: string, len = 42): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= len ? clean : clean.slice(0, len - 1) + '…';
}

function Pill({ label, value, color }: { label: string; value: number; color: string }): React.ReactElement {
  return (
    <Box marginRight={1}>
      <Text color="#8e8e93">{label} </Text>
      <Text color={color} bold>{value}</Text>
    </Box>
  );
}

export function MacOSView({ sessions, stats }: Props): React.ReactElement {
  // Group sessions
  const active = sessions.filter(s => s.status === 'running' || s.status === 'waiting');
  const idle = sessions.filter(s => s.status === 'idle');
  const lost = sessions.filter(s => s.status === 'lost');

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header - macOS window style */}
      <Box marginBottom={1}>
        <Text>🔴 🟡 🟢  </Text>
        <Text color="#1d1d1f" backgroundColor="#f5f5f7" bold> Keepline </Text>
        <Text color="#8e8e93"> — Session Monitor</Text>
      </Box>

      {/* Stats Pills */}
      <Box
        borderStyle="round"
        borderColor="#c7c7cc"
        paddingX={2}
        paddingY={0}
        marginBottom={1}
      >
        <Pill label="Sessions" value={stats.total} color="#1d1d1f" />
        <Text color="#c7c7cc">│</Text>
        <Pill label="  Active" value={stats.running + stats.waiting} color="#34c759" />
        <Pill label="Idle" value={stats.idle} color="#007aff" />
        <Pill label={SESSION_STATUS_PRESENTATION.lost.label} value={stats.lost} color="#ff3b30" />
      </Box>

      {/* Active Sessions */}
      {active.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={0}>
            <Text color="#34c759" bold>● Active Sessions</Text>
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor="#e5e5ea" paddingX={1}>
            {active.map((session) => (
              <Box key={session.sessionId} justifyContent="space-between">
                <Box>
                  <Text>{icons[session.status]} </Text>
                  <Text color="#1d1d1f" bold>{formatPath(session.directory).slice(0, 24)} </Text>
                  <Text color="#8e8e93">{truncate(session.title || session.initialPrompt || '—', 35)}</Text>
                </Box>
                <Text color="#8e8e93">{timeAgo(session.lastActiveAt)}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* Idle Sessions */}
      {idle.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={0}>
            <Text color="#007aff" bold>○ Recent Sessions</Text>
            <Text color="#8e8e93"> ({idle.length})</Text>
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor="#e5e5ea" paddingX={1}>
            {idle.slice(0, 6).map((session) => (
              <Box key={session.sessionId} justifyContent="space-between">
                <Box>
                  <Text>{icons[session.status]} </Text>
                  <Text color="#3c3c43">{formatPath(session.directory).slice(0, 24)} </Text>
                  <Text color="#8e8e93">{truncate(session.title || session.initialPrompt || '—', 35)}</Text>
                </Box>
                <Text color="#aeaeb2">{timeAgo(session.lastActiveAt)}</Text>
              </Box>
            ))}
            {idle.length > 6 && (
              <Box justifyContent="center">
                <Text color="#007aff">Show {idle.length - 6} more…</Text>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {/* Lost Sessions */}
      {lost.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={0}>
            <Text color="#ff3b30" bold>◉ Recoverable</Text>
            <Text color="#8e8e93"> ({lost.length})</Text>
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor="#ffccc7" paddingX={1}>
            {lost.slice(0, 5).map((session, i) => (
              <Box key={session.sessionId} justifyContent="space-between">
                <Box>
                  <Text color="#8e8e93">{String(i + 1).padStart(2)}. </Text>
                  <Text>{icons[session.status]} </Text>
                  <Text color="#3c3c43">{formatPath(session.directory).slice(0, 22)} </Text>
                  <Text color="#8e8e93">{truncate(session.title || session.initialPrompt || '—', 32)}</Text>
                </Box>
                <Text color="#aeaeb2">{timeAgo(session.lastActiveAt)}</Text>
              </Box>
            ))}
            {lost.length > 5 && (
              <Box justifyContent="center">
                <Text color="#ff3b30">+{lost.length - 5} more recoverable</Text>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {/* Footer */}
      <Box borderStyle="round" borderColor="#e5e5ea" paddingX={2} paddingY={0}>
        <Text color="#8e8e93">💡 Recover: </Text>
        <Text color="#007aff" bold>keepline recover {'<n>'}</Text>
        <Text color="#c7c7cc"> │ </Text>
        <Text color="#8e8e93">Watch: </Text>
        <Text color="#007aff" bold>keepline watch</Text>
      </Box>
    </Box>
  );
}
