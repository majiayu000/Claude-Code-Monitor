/**
 * Claude Code runtime adapter.
 */

import type { ParsedSessionData } from '../../domain/session/index.js';
import type {
  AgentRuntimeAdapter,
  RuntimeRecoveryOptions,
  RuntimeScanError,
  RuntimeScanOptions,
  RuntimeScanResult,
  RuntimeSession,
} from '../../domain/runtime/index.js';
import { CLAUDE_CODE_DESCRIPTOR } from '../../domain/runtime/descriptors.js';
import { buildClaudeCommandArgs } from '../../services/recovery.service.js';
import {
  getAllSessionsWithFailures as getAllClaudeSessionsWithFailures,
  type ClaudeSessionScanFailure,
  type ScanOptions,
} from '../claude/scanner.js';
import {
  attributeRuntimeProcesses,
  type RuntimeProcessAttributor,
} from './process-attribution.js';
import { parsedSessionToRuntimeSession, structuredCommand } from './session-mapper.js';

interface ClaudeRuntimeScanSourceResult {
  sessions: ParsedSessionData[];
  failures?: ClaudeSessionScanFailure[];
}

export type ClaudeCodeSessionScanner = (
  options?: ScanOptions
) => Promise<ParsedSessionData[] | ClaudeRuntimeScanSourceResult>;

export class ClaudeCodeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly descriptor = CLAUDE_CODE_DESCRIPTOR;

  constructor(
    private readonly scanClaudeSessions: ClaudeCodeSessionScanner = getAllClaudeSessionsWithFailures,
    private readonly attributeProcesses: RuntimeProcessAttributor = (sessions) =>
      attributeRuntimeProcesses('claude-code', sessions)
  ) {}

  async scanSessions(options: RuntimeScanOptions = {}): Promise<RuntimeScanResult> {
    try {
      const scanResult = await this.scanClaudeSessions({
        includeSubAgents: options.includeSubAgents,
        includeToolCalls: options.mode === 'full',
        maxAgeDays: options.maxAgeDays,
      });
      const sessions = Array.isArray(scanResult) ? scanResult : scanResult.sessions;
      const failures = Array.isArray(scanResult) ? [] : scanResult.failures ?? [];
      const mappedSessions = sessions.map((session) =>
        parsedSessionToRuntimeSession(this.descriptor.id, session, {
          legacyClient: 'claude',
        })
      );
      const processAttribution = this.attributeProcesses(mappedSessions);

      return {
        runtime: this.descriptor,
        sessions: processAttribution.sessions,
        errors: [
          ...failures.map((failure) => ({
            runtimeId: this.descriptor.id,
            code: 'parse-failed' as const,
            message: failure.message,
            sourcePath: failure.filePath,
            recoverable: true,
          })),
          ...processAttribution.errors,
        ],
      };
    } catch (error) {
      const scanError: RuntimeScanError = {
        runtimeId: this.descriptor.id,
        code: 'unknown',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      };
      return {
        runtime: this.descriptor,
        sessions: [],
        errors: [scanError],
      };
    }
  }

  buildRecoveryCommand(
    session: RuntimeSession,
    options: RuntimeRecoveryOptions
  ) {
    return structuredCommand(
      buildClaudeCommandArgs(
        options.method,
        session.sessionId,
        options.initialPrompt ?? session.initialPrompt,
        options.skipPermissions ?? false
      ),
      session.cwd
    );
  }
}
