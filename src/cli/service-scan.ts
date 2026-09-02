import { runServiceMigrations } from '../local-api/migrations.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';
import { taskDispatchRepository } from '../infrastructure/database/repositories/task-dispatch.repository.js';
import { getRuntimeScanStatus } from '../services/runtime-status.js';
import { syncSessions } from '../services/session.service.js';
import { taskDispatchService } from '../services/task-dispatch.service.js';
import { reconcileLinkedAgentSessions } from '../services/work-item-session-reconciler.js';

const SCAN_RESULT_PREFIX = '__KEEPLINE_SERVICE_SCAN__';

interface ServiceScanOptions {
  full?: boolean;
}

/** Isolated scan process used by service mode so transcript parsing memory is reclaimed on exit. */
export async function serviceScanCommand(options: ServiceScanOptions = {}): Promise<void> {
  runServiceMigrations();
  try {
    const sync = await syncSessions(options.full
      ? { fullSync: true, includeSubAgents: true }
      : { maxAgeDays: 1, includeSubAgents: false });
    const dispatches = taskDispatchService.reconcilePending();
    const linkedSessions = reconcileLinkedAgentSessions();
    console.log(`${SCAN_RESULT_PREFIX}${JSON.stringify({
      sync,
      reconciledDispatches: dispatches.length,
      pendingDispatches: taskDispatchRepository.findCorrelationPending().length,
      linkedSessions,
      runtimeScan: getRuntimeScanStatus(),
    })}`);
  } finally {
    closeDatabase();
  }
}
