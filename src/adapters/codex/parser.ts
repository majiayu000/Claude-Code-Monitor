/**
 * JSONL parser for Codex saved session files.
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { ParseError } from '../../lib/errors.js';
import { scopeCodexSessionId } from '../../lib/session-id.js';
import { extractTaskPrompt, type ToolCallInfo } from '../../domain/session/index.js';
import type { CodexJsonlEntry, CodexParsedSessionData } from './types.js';
import {
  addUsageToAccumulator,
  createUsageAccumulator,
  usageStatsFromAccumulator,
} from '../../services/usage.extractor.js';

export interface ParseCodexSessionOptions {
  includeToolCalls?: boolean;
}

interface CodexAccumulator {
  rawSessionId: string;
  sessionId: string;
  directory: string;
  firstMessage?: string;
  lastMessage?: string;
  lastTool?: string;
  lastToolInput?: Record<string, unknown>;
  currentFile?: string;
  messageCount: number;
  toolCount: number;
  startedAtMs?: number;
  lastActiveAtMs: number;
  toolCalls: ToolCallInfo[];
  includeToolCalls: boolean;
  usageAccumulator: ReturnType<typeof createUsageAccumulator>;
}

export { scopeCodexSessionId, unscopeCodexSessionId } from '../../lib/session-id.js';

function parseCodexTimestampMs(timestamp: unknown): number | undefined {
  if (typeof timestamp !== 'string') return undefined;
  const timestampMs = Date.parse(timestamp);
  return Number.isNaN(timestampMs) ? undefined : timestampMs;
}

function firstTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (
      (record.type === 'input_text' || record.type === 'output_text') &&
      typeof record.text === 'string'
    ) {
      return record.text;
    }
  }

  return undefined;
}

function parseFunctionArguments(argumentsValue: unknown): Record<string, unknown> | undefined {
  if (!argumentsValue) return undefined;
  if (typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
    return argumentsValue as Record<string, unknown>;
  }
  if (typeof argumentsValue !== 'string') return undefined;

  try {
    const parsed = JSON.parse(argumentsValue);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return { arguments: argumentsValue };
  }

  return undefined;
}

function parseCodexLine(
  line: string,
  lineNumber: number,
  filePath: string,
  allowTruncatedTail = false
): CodexJsonlEntry | null {
  if (!line.trim()) return null;

  try {
    return JSON.parse(line) as CodexJsonlEntry;
  } catch {
    if (allowTruncatedTail) {
      return null;
    }
    throw new ParseError(filePath, lineNumber);
  }
}

function extractCodexCurrentFile(toolInput: Record<string, unknown> | undefined): string | undefined {
  if (!toolInput) return undefined;

  for (const key of ['path', 'file_path', 'filePath', 'notebook_path']) {
    const value = toolInput[key];
    if (typeof value === 'string') return value;
  }

  return undefined;
}

function createAccumulator(entry: CodexJsonlEntry, includeToolCalls: boolean): CodexAccumulator | null {
  if (entry.type !== 'session_meta' || !entry.payload) return null;

  const rawSessionId = entry.payload.id;
  const directory = entry.payload.cwd;
  if (typeof rawSessionId !== 'string' || typeof directory !== 'string') {
    return null;
  }

  const startedAtMs = parseCodexTimestampMs(entry.timestamp);
  return {
    rawSessionId,
    sessionId: scopeCodexSessionId(rawSessionId),
    directory,
    messageCount: 0,
    toolCount: 0,
    startedAtMs,
    lastActiveAtMs: startedAtMs ?? Date.now(),
    toolCalls: [],
    includeToolCalls,
    usageAccumulator: createUsageAccumulator(),
  };
}

function updateTimestamp(accumulator: CodexAccumulator, timestamp: unknown): void {
  const timestampMs = parseCodexTimestampMs(timestamp);
  if (timestampMs === undefined) return;
  if (accumulator.startedAtMs === undefined || timestampMs < accumulator.startedAtMs) {
    accumulator.startedAtMs = timestampMs;
  }
  if (timestampMs > accumulator.lastActiveAtMs) {
    accumulator.lastActiveAtMs = timestampMs;
  }
}

function accumulateResponseItem(accumulator: CodexAccumulator, entry: CodexJsonlEntry): void {
  const payload = entry.payload;
  if (!payload) return;

  updateTimestamp(accumulator, entry.timestamp);

  if (payload.type === 'message') {
    accumulator.messageCount++;
    const text = firstTextContent(payload.content);

    if (payload.role === 'user' && text) {
      const taskPrompt = extractTaskPrompt(text);
      if (taskPrompt) accumulator.firstMessage = taskPrompt;
    }
    if (payload.role === 'assistant' && text) {
      accumulator.lastMessage = text;
    }
    return;
  }

  if (payload.type === 'function_call') {
    const name = typeof payload.name === 'string' ? payload.name : undefined;
    if (!name) return;

    const input = parseFunctionArguments(payload.arguments) ?? {};
    accumulator.toolCount++;
    accumulator.lastTool = name;
    accumulator.lastToolInput = input;
    accumulator.currentFile = extractCodexCurrentFile(input) ?? accumulator.currentFile;

    if (accumulator.includeToolCalls) {
      accumulator.toolCalls.push({
        name,
        input,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
      });
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function findUsageRecord(payload: Record<string, unknown>): {
  source: Record<string, unknown>;
  usage: Record<string, unknown>;
} | undefined {
  const directUsage = asRecord(payload.usage);
  if (directUsage) return { source: payload, usage: directUsage };

  for (const key of ['msg', 'message', 'event', 'data']) {
    const nested = asRecord(payload[key]);
    const nestedUsage = nested ? asRecord(nested.usage) : undefined;
    if (nested && nestedUsage) return { source: nested, usage: nestedUsage };
  }

  return undefined;
}

function accumulateCodexUsageEvent(accumulator: CodexAccumulator, entry: CodexJsonlEntry): void {
  const payload = entry.payload;
  if (!payload) return;

  const usageRecord = findUsageRecord(payload);
  if (!usageRecord) return;

  const inputTokens = numberField(usageRecord.usage, [
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
  ]);
  const outputTokens = numberField(usageRecord.usage, [
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
  ]);

  if (inputTokens === undefined || outputTokens === undefined) {
    return;
  }

  const cacheCreationTokens = numberField(usageRecord.usage, [
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cache_write_input_tokens',
    'cacheWriteInputTokens',
    'cacheWriteTokens',
  ]) ?? 0;
  const cacheReadTokens = numberField(usageRecord.usage, [
    'cache_read_input_tokens',
    'cacheReadInputTokens',
    'cacheReadTokens',
  ]) ?? 0;
  const model = stringField(usageRecord.source, ['model', 'modelName', 'model_name']) ??
    stringField(usageRecord.usage, ['model', 'modelName', 'model_name']) ??
    'codex-unknown';

  addUsageToAccumulator(accumulator.usageAccumulator, model, {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
  });
}

function finalizeAccumulator(accumulator: CodexAccumulator): CodexParsedSessionData {
  return {
    client: 'codex',
    rawSessionId: accumulator.rawSessionId,
    sessionId: accumulator.sessionId,
    directory: accumulator.directory,
    firstMessage: accumulator.firstMessage,
    lastMessage: accumulator.lastMessage,
    messageCount: accumulator.messageCount,
    toolCount: accumulator.toolCount,
    lastTool: accumulator.lastTool,
    lastToolInput: accumulator.lastToolInput,
    currentFile: accumulator.currentFile,
    startedAt: accumulator.startedAtMs === undefined ? undefined : new Date(accumulator.startedAtMs),
    lastActiveAt: new Date(accumulator.lastActiveAtMs),
    toolCalls: accumulator.includeToolCalls ? accumulator.toolCalls : undefined,
    usageStats: accumulator.usageAccumulator.apiCalls === 0
      ? undefined
      : usageStatsFromAccumulator(accumulator.usageAccumulator),
  };
}

export async function parseCodexSessionFile(
  filePath: string,
  options: ParseCodexSessionOptions = {}
): Promise<CodexParsedSessionData | null> {
  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  let accumulator: CodexAccumulator | null = null;
  const includeToolCalls = options.includeToolCalls ?? true;
  let pendingLine: { line: string; lineNumber: number } | null = null;

  const processLine = (line: string, currentLineNumber: number, isLastLine: boolean): void => {
    const entry = parseCodexLine(line, currentLineNumber, filePath, isLastLine);
    if (!entry) return;

    if (!accumulator) {
      accumulator = createAccumulator(entry, includeToolCalls);
      if (accumulator) {
        return;
      }
    }

    if (!accumulator) return;
    if (entry.type === 'response_item') {
      accumulateResponseItem(accumulator, entry);
    } else if (entry.type === 'event_msg') {
      accumulateCodexUsageEvent(accumulator, entry);
      updateTimestamp(accumulator, entry.timestamp);
    } else {
      updateTimestamp(accumulator, entry.timestamp);
    }
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

  return accumulator ? finalizeAccumulator(accumulator) : null;
}
