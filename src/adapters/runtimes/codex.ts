/**
 * Codex runtime adapter.
 */

import type {
  AgentRuntimeAdapter,
  RuntimeRecoveryOptions,
  RuntimeScanError,
  RuntimeScanOptions,
  RuntimeScanResult,
  RuntimeSession,
} from '../../domain/runtime/index.js';
import { CODEX_DESCRIPTOR } from '../../domain/runtime/descriptors.js';
import { buildCodexCommandArgs } from '../../services/recovery.service.js';
import { scopeCodexSessionId } from '../codex/parser.js';
import {
  getAllCodexSessionsWithFailures,
  type CodexScanOptions,
  type CodexSessionScanFailure,
} from '../codex/scanner.js';
import type { CodexParsedSessionData } from '../codex/types.js';
import {
  attributeRuntimeProcesses,
  type RuntimeProcessAttributor,
} from './process-attribution.js';
import { parsedSessionToRuntimeSession, structuredCommand } from './session-mapper.js';

interface CodexRuntimeScanSourceResult {
  sessions: CodexParsedSessionData[];
  failures?: CodexSessionScanFailure[];
}

export type CodexSessionScanner = (
  options?: CodexScanOptions
) => Promise<CodexParsedSessionData[] | CodexRuntimeScanSourceResult>;

export class CodexRuntimeAdapter implements AgentRuntimeAdapter {
  readonly descriptor = CODEX_DESCRIPTOR;

  constructor(
    private readonly scanCodexSessions: CodexSessionScanner = getAllCodexSessionsWithFailures,
    private readonly attributeProcesses: RuntimeProcessAttributor = (sessions) =>
      attributeRuntimeProcesses('codex', sessions)
  ) {}

  async scanSessions(options: RuntimeScanOptions = {}): Promise<RuntimeScanResult> {
    try {
      const scanResult = await this.scanCodexSessions({
        includeToolCalls: options.mode === 'full',
        maxAgeDays: options.maxAgeDays,
      });
      const sessions = Array.isArray(scanResult) ? scanResult : scanResult.sessions;
      const failures = Array.isArray(scanResult) ? [] : scanResult.failures ?? [];
      const mappedSessions = sessions.map((session) =>
        parsedSessionToRuntimeSession(this.descriptor.id, session, {
          legacyClient: 'codex',
          scopedSessionId: session.sessionId,
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
      buildCodexCommandArgs(
        options.method,
        scopeCodexSessionId(session.sessionId),
        options.initialPrompt ?? session.initialPrompt,
        options.skipPermissions ?? false
      ),
      session.cwd
    );
  }
}
