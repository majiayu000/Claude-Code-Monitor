/**
 * Cyberpunk 2077 Inspired Terminal UI
 * - Neon cyan/magenta/yellow color scheme
 * - Clean table layout with flexbox
 * - Futuristic typography
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

// Cyberpunk color palette
const C = {
  cyan: '#00fff9',
  magenta: '#ff00ff',
  yellow: '#fcee0a',
  red: '#ff003c',
  green: '#00ff9f',
  blue: '#00b3ff',
  purple: '#bd00ff',
  orange: '#ff6b00',
  dim: '#5a5a7a',
  border: '#3a3a5a',
  text: '#a0a0c0',
  bg: '#1a1a2e',
};

const statusConfig: Record<SessionStatus, { icon: string; color: string; label: string }> = {
  running: {
    icon: SESSION_STATUS_PRESENTATION.running.icon,
    color: C.green,
    label: SESSION_STATUS_PRESENTATION.running.shortLabel,
  },
  waiting: {
    icon: SESSION_STATUS_PRESENTATION.waiting.icon,
    color: C.yellow,
    label: SESSION_STATUS_PRESENTATION.waiting.shortLabel,
  },
  idle: {
    icon: SESSION_STATUS_PRESENTATION.idle.icon,
    color: C.cyan,
    label: SESSION_STATUS_PRESENTATION.idle.shortLabel,
  },
  lost: {
    icon: SESSION_STATUS_PRESENTATION.lost.icon,
    color: C.red,
    label: SESSION_STATUS_PRESENTATION.lost.shortLabel,
  },
  completed: {
    icon: SESSION_STATUS_PRESENTATION.completed.icon,
    color: C.dim,
    label: SESSION_STATUS_PRESENTATION.completed.shortLabel,
  },
};

function formatPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return '…/' + parts.slice(-2).join('/');
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function truncateDisplay(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  // Count display width (CJK chars = 2, others = 1)
  let width = 0;
  let result = '';
  for (const char of clean) {
    const charWidth = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char) ? 2 : 1;
    if (width + charWidth > maxLen - 1) {
      return result + '…';
    }
    width += charWidth;
    result += char;
  }
  return result;
}

function Header(): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Gradient name="atlas">
          <Text bold>█▄▀ █▀▀ █▀▀ █▀█ █░░ █ █▄░█ █▀▀</Text>
        </Gradient>
        <Text color={C.dim}>  ║  </Text>
        <Text color={C.cyan} bold>KEEPLINE</Text>
        <Text color={C.dim}> v1.0</Text>
      </Box>
      <Text color={C.border}>{'─'.repeat(70)}</Text>
    </Box>
  );
}

function Stats({ stats }: { stats: Props['stats'] }): React.ReactElement {
  return (
    <Box marginBottom={1}>
      <Text color={C.magenta} bold>SYS</Text>
      <Text color={C.dim}>::</Text>
      <Text color={C.cyan}>NODES[</Text>
      <Text color="#fff" bold>{stats.total}</Text>
      <Text color={C.cyan}>]</Text>
      <Text color={C.dim}>  </Text>
      <Text color={C.green}>●</Text><Text color={C.text}> LIVE:</Text><Text color="#fff" bold>{stats.running}</Text>
      <Text color={C.dim}>  </Text>
      <Text color={C.yellow}>●</Text><Text color={C.text}> WAIT:</Text><Text color="#fff" bold>{stats.waiting}</Text>
      <Text color={C.dim}>  </Text>
      <Text color={C.cyan}>●</Text><Text color={C.text}> IDLE:</Text><Text color="#fff" bold>{stats.idle}</Text>
      <Text color={C.dim}>  </Text>
      <Text color={C.red}>●</Text>
      <Text color={C.text}> {SESSION_STATUS_PRESENTATION.lost.shortLabel}:</Text>
      <Text color="#fff" bold>{stats.lost}</Text>
    </Box>
  );
}

function SectionHeader({ title, count, color }: { title: string; count: number; color: string }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={color} bold>▌{title}</Text>
      <Text color={C.dim}> [{count}]</Text>
    </Box>
  );
}

function SessionRow({ session, num }: { session: Session; num: number }): React.ReactElement {
  const cfg = statusConfig[session.status];
  const path = formatPath(session.directory);
  const task = truncateDisplay(session.title || session.initialPrompt || '(no task)', 32);
  const time = timeAgo(session.lastActiveAt);

  return (
    <Box>
      <Box width={5}>
        <Text color={C.dim}>[</Text>
        <Text color={C.cyan}>{String(num).padStart(2, '0')}</Text>
        <Text color={C.dim}>]</Text>
      </Box>
      <Box width={6}>
        <Text color={cfg.color}>{cfg.icon} </Text>
        <Text color={cfg.color} dimColor>{cfg.label}</Text>
      </Box>
      <Box width={20}>
        <Text color={C.text}>{path.slice(0, 18)}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color={C.dim}>{task}</Text>
      </Box>
      <Box width={5} justifyContent="flex-end">
        <Text color={cfg.color}>{time}</Text>
      </Box>
    </Box>
  );
}

function MoreIndicator({ count, label, color }: { count: number; label: string; color: string }): React.ReactElement {
  return (
    <Box marginLeft={5}>
      <Text color={color}>+{count} {label}</Text>
    </Box>
  );
}

function Footer({ hasLost }: { hasLost: boolean }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={C.border}>{'─'.repeat(70)}</Text>
      <Box>
        <Text color={C.magenta} bold>CMD</Text>
        <Text color={C.dim}>::</Text>
        <Text color={C.text}> list=</Text><Text color={C.yellow}>keepline ls</Text>
        <Text color={C.dim}>  │  </Text>
        <Text color={C.text}>watch=</Text><Text color={C.yellow}>keepline w</Text>
        {hasLost && (
          <>
            <Text color={C.dim}>  │  </Text>
            <Text color={C.text}>recover=</Text><Text color={C.yellow}>keepline r {'<n>'}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

export function CyberpunkView({ sessions, stats }: Props): React.ReactElement {
  const running = sessions.filter(s => s.status === 'running');
  const waiting = sessions.filter(s => s.status === 'waiting');
  const idle = sessions.filter(s => s.status === 'idle');
  const lost = sessions.filter(s => s.status === 'lost');

  const active = [...running, ...waiting];
  let idx = 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header />
      <Stats stats={stats} />

      {active.length > 0 && (
        <>
          <SectionHeader title="ACTIVE" count={active.length} color={C.green} />
          {active.map(s => <SessionRow key={s.sessionId} session={s} num={++idx} />)}
        </>
      )}

      {idle.length > 0 && (
        <>
          <SectionHeader title="STANDBY" count={idle.length} color={C.cyan} />
          {idle.slice(0, 6).map(s => <SessionRow key={s.sessionId} session={s} num={++idx} />)}
          {idle.length > 6 && <MoreIndicator count={idle.length - 6} label="more in standby" color={C.dim} />}
        </>
      )}

      {lost.length > 0 && (
        <>
          <SectionHeader title="DISCONNECTED" count={lost.length} color={C.red} />
          {lost.slice(0, 5).map(s => <SessionRow key={s.sessionId} session={s} num={++idx} />)}
          {lost.length > 5 && <MoreIndicator count={lost.length - 5} label="more recoverable" color={C.red} />}
        </>
      )}

      <Footer hasLost={stats.lost > 0} />
    </Box>
  );
}
