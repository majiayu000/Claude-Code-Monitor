import { createHash } from 'crypto';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import {
  buildClaudeCommandArgs,
  buildCodexCommandArgs,
  getRecoveryInfo,
} from '../services/recovery.service.js';
import type { RecoveryMethod, TerminalApp } from '../services/recovery.types.js';
import { openTerminalWithArgv } from '../services/terminal.js';
import type { LocalRecoveryPreview, RecoveryRunnerResult } from '../local-api/routes/recovery.js';

const RECOVERY_RESULT_PREFIX = '__KEEPLINE_SERVICE_RECOVERY__';

export interface ServiceRecoverySource {
  sessionId: string;
  runtimeId: 'codex' | 'claude-code';
  directory: string;
  status: string;
  initialPrompt?: string;
  availableMethods: RecoveryMethod[];
  recommendedMethod: RecoveryMethod;
}

interface ServiceRecoveryDependencies {
  recoverySource(sessionId: string): ServiceRecoverySource | null;
  openTerminal(
    executable: string,
    arguments_: string[],
    directory: string,
    terminalApp: TerminalApp
  ): void;
  markRunning(sessionId: string): void;
}

export class ServiceRecoveryError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 500, message: string) {
    super(message);
  }
}

function productionDependencies(): ServiceRecoveryDependencies {
  return {
    recoverySource(sessionId) {
      const info = getRecoveryInfo(sessionId);
      if (!info.session) return null;
      if (!info.canRecover || !info.recommendedMethod) {
        throw new ServiceRecoveryError(409, info.reason ?? 'Session cannot be recovered');
      }
      return {
        sessionId: info.session.sessionId,
        runtimeId: info.session.client === 'codex' ? 'codex' : 'claude-code',
        directory: info.session.directory,
        status: info.session.status,
        initialPrompt: info.session.initialPrompt,
        availableMethods: info.availableMethods,
        recommendedMethod: info.recommendedMethod,
      };
    },
    openTerminal: openTerminalWithArgv,
    markRunning(sessionId) {
      sessionRepository.upsert({ sessionId, status: 'running', statusSource: 'user' });
    },
  };
}

export function createServiceRecoveryHandler(
  dependencies: ServiceRecoveryDependencies = productionDependencies()
) {
  function preview(sessionId: string): LocalRecoveryPreview {
    const source = dependencies.recoverySource(sessionId);
    if (!source) throw new ServiceRecoveryError(404, 'Session not found');
    if (source.sessionId !== sessionId) {
      throw new ServiceRecoveryError(409, 'Recovery session identity changed');
    }
    if (source.status !== 'lost') {
      throw new ServiceRecoveryError(409, 'Only lost sessions can be recovered');
    }
    if (!source.availableMethods.includes(source.recommendedMethod)) {
      throw new ServiceRecoveryError(409, 'Recommended recovery method is no longer available');
    }
    const argv = source.runtimeId === 'codex'
      ? buildCodexCommandArgs(
          source.recommendedMethod,
          source.sessionId,
          source.initialPrompt,
          false
        )
      : buildClaudeCommandArgs(
          source.recommendedMethod,
          source.sessionId,
          source.initialPrompt,
          false
        );
    const executable = argv[0];
    if (!['codex', 'claude', 'claude-code'].includes(executable)) {
      throw new ServiceRecoveryError(500, 'Recovery runtime produced an invalid executable');
    }
    const unsigned = {
      sessionId: source.sessionId,
      runtimeId: source.runtimeId,
      method: source.recommendedMethod,
      executable: executable as 'codex' | 'claude' | 'claude-code',
      arguments: argv.slice(1),
      directory: source.directory,
      createsNewSession: source.recommendedMethod === 'new',
    };
    const confirmationId = createHash('sha256')
      .update(JSON.stringify(unsigned))
      .digest('hex');
    return { ...unsigned, confirmationId };
  }

  function execute(
    sessionId: string,
    confirmationId: string,
    terminalApp: TerminalApp
  ): RecoveryRunnerResult {
    if (!['auto', 'Terminal', 'iTerm', 'Warp'].includes(terminalApp)) {
      throw new ServiceRecoveryError(400, 'Invalid terminal app');
    }
    const current = preview(sessionId);
    if (current.confirmationId !== confirmationId) {
      throw new ServiceRecoveryError(409, 'Recovery preview changed; review it again');
    }
    dependencies.openTerminal(
      current.executable,
      current.arguments,
      current.directory,
      terminalApp
    );
    dependencies.markRunning(sessionId);
    return { preview: current, executed: true };
  }

  return { preview, execute };
}

export async function serviceRecoveryCommand(args: string[]): Promise<void> {
  try {
    const [action, sessionId, confirmationId, terminalApp] = args;
    if (!sessionId || !['preview', 'execute'].includes(action ?? '')) {
      throw new ServiceRecoveryError(400, 'Invalid recovery helper arguments');
    }
    const handler = createServiceRecoveryHandler();
    const result: RecoveryRunnerResult = action === 'preview'
      ? { preview: handler.preview(sessionId), executed: false }
      : handler.execute(
          sessionId,
          confirmationId ?? '',
          (terminalApp ?? '') as TerminalApp
        );
    console.log(RECOVERY_RESULT_PREFIX + JSON.stringify({ success: true, ...result }));
  } catch (error) {
    const status = error instanceof ServiceRecoveryError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Recovery helper failed';
    console.log(RECOVERY_RESULT_PREFIX + JSON.stringify({ success: false, status, error: message }));
    process.exitCode = 1;
  }
}
