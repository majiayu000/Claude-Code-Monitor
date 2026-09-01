/**
 * Daemon scheduler for periodic tasks
 */

import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { syncSessions } from './session.service.js';
import { startHookServer, stopHookServer } from '../adapters/hook/server.js';
import { runMigrations } from '../db/migrations.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';
import { emit } from '../lib/events.js';
import { initializeMemoryService } from './memory.service.js';
import { runRetentionCleanup } from './retention.service.js';
import { initPricing } from './usage.pricing.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';

let scanInterval: NodeJS.Timeout | null = null;
let retentionInterval: NodeJS.Timeout | null = null;
let isRunning = false;

const RETENTION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Run a single scan cycle */
async function runScanCycle(): Promise<void> {
  try {
    const result = await syncSessions();
    logger.debug(`Scan cycle: ${result.discovered} new, ${result.updated} updated, ${result.lost} lost`);
  } catch (error) {
    logger.error('Scan cycle failed', error);
    emit('error', { error: error as Error, context: 'scan_cycle' });
  }
}

/** Run one retention cleanup cycle */
async function runRetentionCleanupCycle(): Promise<void> {
  try {
    await runRetentionCleanup();
  } catch (error) {
    logger.error('Retention cleanup failed', error);
    emit('error', { error: error as Error, context: 'retention_cleanup' });
  }
}

/** Start the scheduler */
export async function startScheduler(): Promise<void> {
  if (isRunning) {
    logger.warn('Scheduler already running');
    return;
  }

  isRunning = true;
  const cfg = config.get();

  logger.info('Starting scheduler...');

  // Initialize database
  runMigrations();
  const interruptedSessions = sessionRepository.markActiveSessionsInterrupted();
  if (interruptedSessions > 0) {
    logger.info(
      `Marked ${interruptedSessions} persisted live session(s) interrupted before reconciliation`
    );
  }

  // Initialize pricing before scan cycles. The pricing module falls back to
  // defaults if remote LiteLLM pricing cannot be fetched.
  await initPricing();

  // Initialize memory service (must be before hook server)
  initializeMemoryService();

  // Start hook server
  await startHookServer();

  // Run initial scan
  await runScanCycle();

  // Run initial retention cleanup after sessions are synced.
  await runRetentionCleanupCycle();

  // Start periodic scanning
  scanInterval = setInterval(runScanCycle, cfg.scanInterval);

  if (cfg.retentionDays > 0) {
    retentionInterval = setInterval(runRetentionCleanupCycle, RETENTION_CLEANUP_INTERVAL_MS);
  } else {
    logger.info('Retention cleanup disabled');
  }

  logger.info(`Scheduler started (scan interval: ${cfg.scanInterval}ms)`);
}

/** Stop the scheduler */
export async function stopScheduler(): Promise<void> {
  if (!isRunning) return;

  logger.info('Stopping scheduler...');

  // Stop periodic scanning
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  if (retentionInterval) {
    clearInterval(retentionInterval);
    retentionInterval = null;
  }

  // Stop hook server
  await stopHookServer();

  // Close database
  closeDatabase();

  isRunning = false;
  logger.info('Scheduler stopped');
}

/** Check if scheduler is running */
export function isSchedulerRunning(): boolean {
  return isRunning;
}

/** Run scheduler in foreground (for daemon process) */
export async function runDaemon(): Promise<void> {
  logger.info('Starting daemon...');

  // Handle graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    await stopScheduler();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  const exitOnFatalError = async (error: Error, context: string): Promise<void> => {
    try {
      logger.error(`Fatal daemon error: ${context}`, error);
      emit('error', { error, context });
      await stopScheduler();
    } finally {
      process.exit(1);
    }
  };

  process.on('uncaughtException', (error) => {
    void exitOnFatalError(error, 'uncaught_exception');
  });

  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    void exitOnFatalError(error, 'unhandled_rejection');
  });

  // Start scheduler
  await startScheduler();

  // Keep process alive
  logger.info('Daemon running. Press Ctrl+C to stop.');
}

/** Trigger manual sync */
export async function triggerSync(): Promise<{
  discovered: number;
  updated: number;
  lost: number;
}> {
  return syncSessions();
}
