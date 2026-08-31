/**
 * JSONL file parser for Claude session files
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { ParseError } from '../../../lib/errors.js';
import { extractTaskPrompt } from '../../../domain/session/index.js';
import type {
  ClaudeEntry,
  ClaudeUserEntry,
  ClaudeAssistantEntry,
  ClaudeContentBlock,
  ClaudeToolUseBlock,
  ParsedSessionData,
  ToolCallInfo,
  SessionUsageStats,
} from '../types.js';
import {
  addUsageToAccumulator,
  createUsageAccumulator,
  usageStatsFromAccumulator,
} from '../../../services/usage.extractor.js';

/** Extended entry type with agent info */
export type ClaudeEntryWithAgent = ClaudeEntry & {
  agentId?: string;
  isSidechain?: boolean;
}

export interface ParseSessionOptions {
  includeToolCalls?: boolean;
}

interface SessionSummaryAccumulator {
  sessionId: string;
  directory: string;
  agentId?: string;
  isSubAgent: boolean;
  parentSessionId?: string;
  firstMessage?: string;
  lastMessage?: string;
  firstSystemCommand?: string;
  messageCount: number;
  toolCount: number;
  lastTool?: string;
  lastToolInput?: Record<string, unknown>;
  currentFile?: string;
  useCanonicalTimestamps: boolean;
  startedAtIso?: string;
  lastActiveAtIso?: string;
  startedAtMs?: number;
  lastActiveAtMs: number;
  toolCalls: ToolCallInfo[];
  usageAccumulator: ReturnType<typeof createUsageAccumulator>;
  includeToolCalls: boolean;
}

interface AssistantBlockSummary {
  entryToolCount: number;
  entryLastToolUse?: ClaudeToolUseBlock;
  entryText?: string;
}

/** Parse a single JSONL line */
function parseLine(
  line: string,
  lineNumber: number,
  filePath: string,
  allowTruncatedTail = false
): ClaudeEntryWithAgent | null {
  if (!line.trim()) return null;

  try {
    return JSON.parse(line) as ClaudeEntryWithAgent;
  } catch {
    if (allowTruncatedTail) {
      return null;
    }
    throw new ParseError(filePath, lineNumber);
  }
}

/** Extract command name from system entry content */
function extractSystemCommand(content: string): string | undefined {
  const match = content.match(/<command-name>\/(\w+)<\/command-name>/);
  return match ? `/${match[1]}` : undefined;
}

/** Extract first user prompt from entry */
function extractUserPrompt(entry: ClaudeUserEntry): string | undefined {
  const content = entry.message.content;
  if (typeof content === 'string') {
    return extractTaskPrompt(content);
  }
  return undefined;
}

/** Extract current file from tool input */
function extractCurrentFile(toolInput: Record<string, unknown>): string | undefined {
  const path = toolInput.path;
  if (typeof path === 'string') return path;

  const filePath = toolInput.file_path;
  if (typeof filePath === 'string') return filePath;

  const filePathCamel = toolInput.filePath;
  if (typeof filePathCamel === 'string') return filePathCamel;

  const notebookPath = toolInput.notebook_path;
  if (typeof notebookPath === 'string') return notebookPath;

  return undefined;
}

function parseTimestampMs(timestamp: string): number | undefined {
  const timestampMs = Date.parse(timestamp);
  return Number.isNaN(timestampMs) ? undefined : timestampMs;
}

function isAsciiWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function isCanonicalIsoUtcTimestamp(timestamp: string): boolean {
  return (
    timestamp.length === 24 &&
    timestamp[4] === '-' &&
    timestamp[7] === '-' &&
    timestamp[10] === 'T' &&
    timestamp[13] === ':' &&
    timestamp[16] === ':' &&
    timestamp[19] === '.' &&
    timestamp[23] === 'Z'
  );
}

function trimTextIfNeeded(text: string): string {
  if (text.length === 0) {
    return text;
  }

  const first = text.charCodeAt(0);
  const last = text.charCodeAt(text.length - 1);
  if (!isAsciiWhitespace(first) && !isAsciiWhitespace(last)) {
    return text;
  }

  return text.trim();
}

function downgradeTimestampTracking(accumulator: SessionSummaryAccumulator): void {
  if (!accumulator.useCanonicalTimestamps) {
    return;
  }

  accumulator.useCanonicalTimestamps = false;
  accumulator.startedAtMs = accumulator.startedAtIso
    ? parseTimestampMs(accumulator.startedAtIso)
    : accumulator.startedAtMs;
  accumulator.lastActiveAtMs = accumulator.lastActiveAtIso
    ? (parseTimestampMs(accumulator.lastActiveAtIso) ?? accumulator.lastActiveAtMs)
    : accumulator.lastActiveAtMs;
  accumulator.startedAtIso = undefined;
  accumulator.lastActiveAtIso = undefined;
}

function isFileHistorySnapshot(entry: ClaudeEntryWithAgent): boolean {
  return (entry as { type?: string }).type === 'file-history-snapshot';
}

/**
 * Bootstrap entries written by Claude Code that may appear before the first
 * conversation entry. They carry a sessionId but no cwd, so they cannot seed
 * the session accumulator on their own.
 */
function isBootstrapOnlyEntry(entry: ClaudeEntryWithAgent): boolean {
  const type = (entry as { type?: string }).type;
  return type === 'queue-operation' || type === 'last-prompt';
}

function summarizeAssistantBlocks(
  blocks: ClaudeContentBlock[],
  timestamp: string,
  includeToolCalls: boolean,
  toolCalls: ToolCallInfo[]
): AssistantBlockSummary {
  if (blocks.length === 1) {
    const first = blocks[0];
    if (first.type === 'text') {
      return { entryToolCount: 0, entryText: first.text };
    }
    if (first.type === 'tool_use') {
      if (includeToolCalls) {
        toolCalls.push({
          name: first.name,
          input: first.input,
          timestamp,
        });
      }
      return { entryToolCount: 1, entryLastToolUse: first };
    }
  }

  if (
    blocks.length === 3 &&
    blocks[0].type === 'text' &&
    blocks[1].type === 'tool_use' &&
    blocks[2].type === 'text'
  ) {
    const toolUse = blocks[1];
    if (includeToolCalls) {
      toolCalls.push({
        name: toolUse.name,
        input: toolUse.input,
        timestamp,
      });
    }
    return {
      entryToolCount: 1,
      entryLastToolUse: toolUse,
      entryText: `${blocks[0].text}\n${blocks[2].text}`,
    };
  }

  let entryToolCount = 0;
  let entryLastToolUse: ClaudeToolUseBlock | undefined;
  let entryText = '';
  let hasText = false;

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      entryToolCount++;
      entryLastToolUse = block;
      if (includeToolCalls) {
        toolCalls.push({
          name: block.name,
          input: block.input,
          timestamp,
        });
      }
      continue;
    }

    if (block.type === 'text') {
      if (hasText) {
        entryText += `\n${block.text}`;
      } else {
        entryText = block.text;
        hasText = true;
      }
    }
  }

  return {
    entryToolCount,
    entryLastToolUse,
    entryText: hasText ? entryText : undefined,
  };
}

function createSessionAccumulator(
  entry: ClaudeEntryWithAgent,
  options: ParseSessionOptions = {}
): SessionSummaryAccumulator | null {
  const sessionId = entry.sessionId;
  const directory = entry.cwd;

  if (!sessionId || !directory) {
    return null;
  }

  const agentId = entry.agentId;
  const isSubAgent = !!agentId || entry.isSidechain === true;
  const useCanonicalTimestamps = isCanonicalIsoUtcTimestamp(entry.timestamp);
  let startedAtMs: number | undefined;
  let lastActiveAtMs = Date.now();
  let startedAtIso: string | undefined;
  let lastActiveAtIso: string | undefined;

  if (useCanonicalTimestamps) {
    startedAtIso = entry.timestamp;
    lastActiveAtIso = entry.timestamp;
  } else {
    const parsedTimestamp = parseTimestampMs(entry.timestamp);
    startedAtMs = parsedTimestamp;
    lastActiveAtMs = parsedTimestamp ?? Date.now();
  }

  return {
    sessionId,
    directory,
    agentId,
    isSubAgent,
    parentSessionId: isSubAgent ? sessionId : undefined,
    messageCount: 0,
    toolCount: 0,
    useCanonicalTimestamps,
    startedAtIso,
    lastActiveAtIso,
    startedAtMs,
    lastActiveAtMs,
    toolCalls: [],
    usageAccumulator: createUsageAccumulator(),
    includeToolCalls: options.includeToolCalls ?? true,
  };
}

function accumulateSessionEntry(
  accumulator: SessionSummaryAccumulator,
  entry: ClaudeEntryWithAgent
): void {
  if (accumulator.useCanonicalTimestamps && isCanonicalIsoUtcTimestamp(entry.timestamp)) {
    if (!accumulator.lastActiveAtIso || entry.timestamp > accumulator.lastActiveAtIso) {
      accumulator.lastActiveAtIso = entry.timestamp;
    }
    if (!accumulator.startedAtIso || entry.timestamp < accumulator.startedAtIso) {
      accumulator.startedAtIso = entry.timestamp;
    }
  } else {
    downgradeTimestampTracking(accumulator);
    const entryTimeMs = parseTimestampMs(entry.timestamp);
    if (entryTimeMs !== undefined && entryTimeMs > accumulator.lastActiveAtMs) {
      accumulator.lastActiveAtMs = entryTimeMs;
    }
    if (entryTimeMs !== undefined && (
      accumulator.startedAtMs === undefined || entryTimeMs < accumulator.startedAtMs
    )) {
      accumulator.startedAtMs = entryTimeMs;
    }
  }

  if (entry.type === 'user' && entry.userType === 'external') {
    accumulator.messageCount++;
    const taskPrompt = extractUserPrompt(entry as ClaudeUserEntry);
    if (taskPrompt) accumulator.firstMessage = taskPrompt;
  }

  if ((entry as { type?: string }).type === 'system' && !accumulator.firstSystemCommand) {
    const content = (entry as { content?: string }).content;
    if (content) {
      accumulator.firstSystemCommand = extractSystemCommand(content);
    }
  }

  if (entry.type !== 'assistant') {
    return;
  }

  const assistantEntry = entry as ClaudeAssistantEntry;

  const {
    entryToolCount,
    entryLastToolUse,
    entryText,
  } = summarizeAssistantBlocks(
    assistantEntry.message.content,
    entry.timestamp,
    accumulator.includeToolCalls,
    accumulator.toolCalls
  );

  accumulator.toolCount += entryToolCount;

  if (entryLastToolUse) {
    accumulator.lastTool = entryLastToolUse.name;
    accumulator.lastToolInput = entryLastToolUse.input;

    const file = extractCurrentFile(entryLastToolUse.input);
    if (file) {
      accumulator.currentFile = file;
    }
  }

  if (entryText !== undefined) {
    const text = trimTextIfNeeded(entryText);
    if (text) {
      accumulator.lastMessage = text;
    }
  }

  const usage = assistantEntry.message.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | undefined;
  if (
    usage &&
    typeof usage.input_tokens === 'number' &&
    typeof usage.output_tokens === 'number'
  ) {
    addUsageToAccumulator(accumulator.usageAccumulator, assistantEntry.message.model, {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
    });
  }
}

function finalizeSessionAccumulator(
  accumulator: SessionSummaryAccumulator
): ParsedSessionData {
  if (!accumulator.firstMessage && accumulator.firstSystemCommand) {
    accumulator.firstMessage = `System: ${accumulator.firstSystemCommand}`;
  }

  const rawUsageStats = usageStatsFromAccumulator(accumulator.usageAccumulator);
  const usageStats: SessionUsageStats | undefined = rawUsageStats.apiCalls > 0
    ? {
        totalInputTokens: rawUsageStats.totalInputTokens,
        totalOutputTokens: rawUsageStats.totalOutputTokens,
        totalTokens: rawUsageStats.totalTokens,
        totalCost: rawUsageStats.totalCost,
        apiCalls: rawUsageStats.apiCalls,
      }
    : undefined;

  return {
    sessionId: accumulator.isSubAgent && accumulator.agentId
      ? `agent-${accumulator.agentId}`
      : accumulator.sessionId,
    directory: accumulator.directory,
    firstMessage: accumulator.firstMessage,
    lastMessage: accumulator.lastMessage,
    messageCount: accumulator.messageCount,
    toolCount: accumulator.toolCount,
    lastTool: accumulator.lastTool,
    lastToolInput: accumulator.lastToolInput,
    currentFile: accumulator.currentFile,
    startedAt: accumulator.useCanonicalTimestamps
      ? (accumulator.startedAtIso ? new Date(accumulator.startedAtIso) : undefined)
      : (accumulator.startedAtMs === undefined ? undefined : new Date(accumulator.startedAtMs)),
    lastActiveAt: accumulator.useCanonicalTimestamps
      ? new Date(accumulator.lastActiveAtIso!)
      : new Date(accumulator.lastActiveAtMs),
    toolCalls: accumulator.toolCalls.length > 0 ? accumulator.toolCalls : undefined,
    usageStats,
    agentId: accumulator.agentId,
    parentSessionId: accumulator.parentSessionId,
    isSubAgent: accumulator.isSubAgent,
  };
}

/** Parse a session JSONL file */
export function summarizeSessionEntries(entries: ClaudeEntryWithAgent[]): ParsedSessionData | null {
  let accumulator: SessionSummaryAccumulator | null = null;

  for (const entry of entries) {
    if (isFileHistorySnapshot(entry) || isBootstrapOnlyEntry(entry) || !entry.timestamp) {
      continue;
    }
    if (!accumulator) {
      if (!entry.cwd) {
        continue;
      }
      accumulator = createSessionAccumulator(entry);
      if (!accumulator) {
        return null;
      }
    }
    accumulateSessionEntry(accumulator, entry);
  }

  return accumulator ? finalizeSessionAccumulator(accumulator) : null;
}

/** Parse a session JSONL file */
export async function parseSessionFile(
  filePath: string,
  options: ParseSessionOptions = {}
): Promise<ParsedSessionData | null> {
  let lineNumber = 0;
  let accumulator: SessionSummaryAccumulator | null = null;
  let pendingLine: { line: string; lineNumber: number } | null = null;

  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const processLine = (line: string, currentLineNumber: number, isLastLine: boolean): void => {
    const entry = parseLine(line, currentLineNumber, filePath, isLastLine);
    if (
      !entry ||
      isFileHistorySnapshot(entry) ||
      isBootstrapOnlyEntry(entry) ||
      !entry.timestamp
    ) {
      return;
    }

    if (!accumulator) {
      if (!entry.cwd) {
        return;
      }
      accumulator = createSessionAccumulator(entry, options);
      if (!accumulator) {
        return;
      }
    }

    accumulateSessionEntry(accumulator, entry);
  };

  for await (const line of rl) {
    if (pendingLine) {
      processLine(pendingLine.line, pendingLine.lineNumber, false);
    }

    lineNumber++;
    pendingLine = { line, lineNumber };
  }

  if (pendingLine) {
    processLine(pendingLine.line, pendingLine.lineNumber, true);
  }

  return accumulator ? finalizeSessionAccumulator(accumulator) : null;
}
