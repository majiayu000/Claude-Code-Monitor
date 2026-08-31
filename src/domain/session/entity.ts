/**
 * Session entity definition
 */

import type { Entity } from '../shared/types.js';
import type {
  AgentClient,
  SessionStatus,
  ToolCallInfo,
  SessionUsageStats,
} from './value-objects.js';

/** Session entity - represents a monitored agent session */
export interface Session extends Entity {
  /** Client-scoped session ID used by Keepline. */
  sessionId: string;

  /** Agent client that owns this session. */
  client: AgentClient;

  /** Working directory path */
  directory: string;

  /** Current status */
  status: SessionStatus;

  /** Task information */
  title: string;
  initialPrompt: string;

  /** Activity tracking */
  lastTool?: string;
  lastToolInput?: string;
  currentFile?: string;
  lastMessage?: string;
  toolCalls?: ToolCallInfo[];

  /** Multi-session tracking */
  agentId?: string;
  parentSessionId?: string;
  isSubAgent?: boolean;

  /** Usage statistics */
  usageStats?: SessionUsageStats;

  /** Timeline */
  startedAt?: Date;
  lastActiveAt: Date;
  completedAt?: Date;

  /** Process info */
  pid?: number;
  tty?: string;

  /** Metrics */
  toolCount: number;
  messageCount: number;
}

/** Parsed session data from JSONL files */
export interface ParsedSessionData {
  sessionId: string;
  client?: AgentClient;
  directory: string;
  firstMessage?: string;
  lastMessage?: string;
  messageCount: number;
  toolCount: number;
  lastTool?: string;
  lastToolInput?: Record<string, unknown>;
  currentFile?: string;
  startedAt?: Date;
  lastActiveAt: Date;
  toolCalls?: ToolCallInfo[];
  usageStats?: SessionUsageStats;

  /** Multi-session tracking */
  agentId?: string;
  parentSessionId?: string;
  isSubAgent?: boolean;
}

/** Session with live process data */
export interface AggregatedSession extends Session {
  processRunning: boolean;
  cpuUsage?: number;
  memoryUsage?: number;
}

/** Lightweight session row for list/realtime payloads */
export type SessionListItem = Pick<
  Session,
  | 'id'
  | 'sessionId'
  | 'client'
  | 'directory'
  | 'status'
  | 'title'
  | 'startedAt'
  | 'lastActiveAt'
  | 'completedAt'
  | 'pid'
  | 'tty'
  | 'toolCount'
  | 'messageCount'
  | 'usageStats'
  | 'createdAt'
  | 'updatedAt'
>;

/** Lightweight session with live process data */
export interface AggregatedSessionListItem extends SessionListItem {
  processRunning: boolean;
  cpuUsage?: number;
  memoryUsage?: number;
}

/** Input for creating a new session */
export interface CreateSessionInput {
  sessionId: string;
  client?: AgentClient;
  directory: string;
  initialPrompt: string;
  title?: string;
  pid?: number;
  tty?: string;
}

/** Input for updating an existing session */
export interface UpdateSessionInput {
  directory?: string;
  status?: SessionStatus;
  title?: string;
  initialPrompt?: string;
  lastTool?: string;
  lastToolInput?: string;
  currentFile?: string;
  lastMessage?: string;
  lastActiveAt?: Date;
  completedAt?: Date;
  pid?: number;
  tty?: string;
  toolCount?: number;
  messageCount?: number;
}

/** Session statistics */
export interface SessionStats {
  running: number;
  waiting: number;
  idle: number;
  lost: number;
  completed: number;
  total: number;
}

/** Generate title from prompt */
export function generateTitle(prompt: string): string {
  const instructionMatch = prompt.match(/^#\s*AGENTS\.md instructions for ([^\n<]+)/i);
  if (instructionMatch) {
    const taskPrompt = extractPromptAfterAgentInstructions(prompt);
    if (taskPrompt) {
      return summarizePrompt(taskPrompt);
    }

    const targetPath = instructionMatch[1]?.trim();
    if (targetPath) {
      const projectName = targetPath.split('/').filter(Boolean).pop();
      return projectName ? `AGENTS.md: ${projectName}` : 'AGENTS.md instructions';
    }
    return 'AGENTS.md instructions';
  }

  return summarizePrompt(prompt);
}

/** Extract a user-authored task from Codex/Claude context wrapper messages. */
export function extractTaskPrompt(prompt: string): string | undefined {
  const trimmed = prompt.trim();
  if (!trimmed) return undefined;

  if (/^<recommended_plugins(?:\s|>)/i.test(trimmed)) {
    const remainder = textAfterClosingTag(trimmed, '</recommended_plugins>');
    return remainder ? extractTaskPrompt(remainder) : undefined;
  }
  if (/^#\s*AGENTS\.md instructions(?:\s|$)/i.test(trimmed)) {
    const remainder = extractPromptAfterAgentInstructions(trimmed);
    return remainder ? extractTaskPrompt(remainder) : undefined;
  }
  if (/^<environment_context(?:\s|>)/i.test(trimmed)) {
    const remainder = textAfterClosingTag(trimmed, '</environment_context>');
    return remainder ? extractTaskPrompt(remainder) : undefined;
  }

  if (/^继续[。.!！]?$/.test(trimmed)) return undefined;

  return trimmed;
}

function summarizePrompt(prompt: string): string {
  if (prompt.length <= 80) return prompt;

  const truncated = prompt.slice(0, 80);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 40) {
    return truncated.slice(0, lastSpace) + '...';
  }
  return truncated + '...';
}

function extractPromptAfterAgentInstructions(prompt: string): string | null {
  const environmentClose = prompt.lastIndexOf('</environment_context>');
  if (environmentClose !== -1) {
    const rest = prompt.slice(environmentClose + '</environment_context>'.length).trim();
    return rest || null;
  }

  const instructionsClose = prompt.lastIndexOf('</INSTRUCTIONS>');
  if (instructionsClose !== -1) {
    const rest = prompt.slice(instructionsClose + '</INSTRUCTIONS>'.length).trim();
    return rest || null;
  }

  return null;
}

function textAfterClosingTag(prompt: string, closingTag: string): string | undefined {
  const close = prompt.lastIndexOf(closingTag);
  if (close === -1) return undefined;
  const rest = prompt.slice(close + closingTag.length).trim();
  return rest || undefined;
}
