/**
 * Style C: Neon Cyberpunk View
 * - Bright neon colors
 * - Double borders
 * - Futuristic aesthetic
 */

import React from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
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
  running: '⚡',
  waiting: '⏳',
  idle: '◇',
  lost: '☠',
  completed: '★',
};

const colors: Record<SessionStatus, string> = {
  running: '#00ff00',
  waiting: '#ffff00',
  idle: '#00ffff',
  lost: '#ff0055',
  completed: '#666699',
};

function formatPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `»${parts.slice(-2).join('/')}`;
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return '::NOW';
  if (s < 3600) return `::${Math.floor(s / 60)}M`;
  if (s < 86400) return `::${Math.floor(s / 3600)}H`;
  return `::${Math.floor(s / 86400)}D`;
}

function truncate(text: string, len = 35): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= len ? clean : clean.slice(0, len - 1) + '…';
}

export function NeonView({ sessions, stats }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" padding={1}>
      {/* Cyberpunk Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color="#333366">╔{'═'.repeat(76)}╗</Text>
        <Box>
          <Text color="#333366">║ </Text>
          <Gradient name="rainbow">
            <Text bold>◢◤ KEEPLINE v1.0 ◢◤</Text>
          </Gradient>
          <Text color="#666699">  // AGENT SESSION MONITOR //</Text>
          <Text color="#333366">{' '.repeat(20)}║</Text>
        </Box>
        <Text color="#333366">╠{'═'.repeat(76)}╣</Text>
      </Box>

      {/* Stats Bar */}
      <Box marginBottom={1} paddingX={1}>
        <Text color="#333366">║ </Text>
        <Text color="#ff00ff" bold>[SYS]</Text>
        <Text color="#666699"> NODES:</Text>
        <Text color="#ffffff" bold>{stats.total}</Text>
        <Text color="#666699"> │ </Text>
        <Text color="#00ff00">◈LIVE:{stats.running}</Text>
        <Text color="#666699"> │ </Text>
        <Text color="#ffff00">◈WAIT:{stats.waiting}</Text>
        <Text color="#666699"> │ </Text>
        <Text color="#00ffff">◈IDLE:{stats.idle}</Text>
        <Text color="#666699"> │ </Text>
        <Text color="#ff0055">
          ◈{SESSION_STATUS_PRESENTATION.lost.shortLabel}:{stats.lost}
        </Text>
        <Text color="#333366">{' '.repeat(10)}║</Text>
      </Box>

      <Box paddingX={1}>
        <Text color="#333366">╟{'─'.repeat(76)}╢</Text>
      </Box>

      {/* Session List */}
      <Box flexDirection="column" paddingX={1}>
        {sessions.slice(0, 20).map((session, idx) => {
          const icon = icons[session.status];
          const color = colors[session.status];
          const task = truncate(session.title || session.initialPrompt || 'UNKNOWN');
          const path = formatPath(session.directory);
          const time = timeAgo(session.lastActiveAt);

          return (
            <Box key={session.sessionId}>
              <Text color="#333366">║ </Text>
              <Text color="#666699">[</Text>
              <Text color="#00ffff">{String(idx + 1).padStart(2, '0')}</Text>
              <Text color="#666699">] </Text>
              <Text color={color}>{icon} </Text>
              <Text color="#ffffff">{path.padEnd(22).slice(0, 22)} </Text>
              <Text color="#666699">│ </Text>
              <Text color="#999999">{task.padEnd(36).slice(0, 36)}</Text>
              <Text color={color}>{time.padStart(7)}</Text>
              <Text color="#333366"> ║</Text>
            </Box>
          );
        })}
        {sessions.length > 20 && (
          <Box>
            <Text color="#333366">║ </Text>
            <Text color="#666699">... [{sessions.length - 20} MORE NODES IN QUEUE]</Text>
            <Text color="#333366">{' '.repeat(40)}║</Text>
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Box flexDirection="column" marginTop={1}>
        <Text color="#333366">╠{'═'.repeat(76)}╣</Text>
        <Box>
          <Text color="#333366">║ </Text>
          <Text color="#ff00ff">[CMD]</Text>
          <Text color="#666699"> RECOVER: </Text>
          <Text color="#00ffff" bold>keepline r {'<ID>'}</Text>
          <Text color="#666699"> │ LIST: </Text>
          <Text color="#00ffff" bold>keepline ls</Text>
          <Text color="#666699"> │ WATCH: </Text>
          <Text color="#00ffff" bold>keepline w</Text>
          <Text color="#333366">{' '.repeat(5)}║</Text>
        </Box>
        <Text color="#333366">╚{'═'.repeat(76)}╝</Text>
      </Box>
    </Box>
  );
}
