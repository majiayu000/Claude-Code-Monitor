/**
 * StatsBar component - session statistics display
 */

import React from 'react';
import { Box, Text } from 'ink';
import { SESSION_STATUS_PRESENTATION } from '../../domain/session/index.js';

interface SessionStats {
  total: number;
  running: number;
  waiting: number;
  idle: number;
  lost: number;
  completed: number;
}

interface StatsBarProps {
  stats: SessionStats;
}

interface StatItemProps {
  label: string;
  value: number;
  color: string;
}

function StatItem({ label, value, color }: StatItemProps): React.ReactElement {
  return (
    <Box marginRight={2}>
      <Text color={color} bold>{value}</Text>
      <Text color="gray"> {label}</Text>
    </Box>
  );
}

export function StatsBar({ stats }: StatsBarProps): React.ReactElement {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={2}
      paddingY={0}
      marginBottom={1}
      justifyContent="space-between"
    >
      <Box>
        <StatItem label="Total" value={stats.total} color="white" />
        <Text color="gray">│</Text>
        <Box marginLeft={1}>
          <StatItem label="Running" value={stats.running} color="green" />
          <StatItem label="Waiting" value={stats.waiting} color="yellow" />
          <StatItem label="Idle" value={stats.idle} color="blue" />
          <StatItem label={SESSION_STATUS_PRESENTATION.lost.label} value={stats.lost} color="red" />
        </Box>
      </Box>
    </Box>
  );
}
