/**
 * Status command - show system status
 */

import chalk from 'chalk';
import { existsSync } from 'fs';
import {
  CLAUDE_HOME,
  CLAUDE_PROJECT_ROOTS,
  KEEPLINE_HOME,
  KEEPLINE_DB,
} from '../lib/paths.js';
import { getDaemonStatus } from '../services/daemon.manager.js';
import { getHookAvailability } from '../adapters/hook/availability.js';
import { config } from '../lib/config.js';
import { runMigrations } from '../db/migrations.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';
import { scanAgentProcesses } from '../adapters/process/scanner.js';

export async function statusCommand(): Promise<void> {
  console.log('');
  console.log(chalk.bold('Keepline System Status'));
  console.log('');

  // Paths
  console.log(chalk.cyan('Paths:'));
  console.log(`  Claude home:    ${CLAUDE_HOME} ${existsSync(CLAUDE_HOME) ? chalk.green('OK') : chalk.red('Not found')}`);
  for (const root of CLAUDE_PROJECT_ROOTS) {
    console.log(`  Claude projects: ${root} ${existsSync(root) ? chalk.green('OK') : chalk.gray('Not found')}`);
  }
  console.log(`  Keepline home:  ${KEEPLINE_HOME} ${existsSync(KEEPLINE_HOME) ? chalk.green('OK') : chalk.gray('Will create')}`);
  console.log(`  Keepline DB:    ${KEEPLINE_DB} ${existsSync(KEEPLINE_DB) ? chalk.green('OK') : chalk.gray('Will create')}`);
  console.log('');

  // Daemon
  const daemon = getDaemonStatus();
  console.log(chalk.cyan('Daemon:'));
  if (daemon.running) {
    console.log(`  Status: ${chalk.green('Running')}`);
    console.log(`  PID:    ${daemon.pid}`);
    if (daemon.uptime) {
      const hours = Math.floor(daemon.uptime / 3600);
      const minutes = Math.floor((daemon.uptime % 3600) / 60);
      console.log(`  Uptime: ${hours}h ${minutes}m`);
    }
  } else {
    console.log(`  Status: ${chalk.yellow('Not running')}`);
  }
  console.log('');

  // Hooks
  const hooks = await getHookAvailability();
  console.log(chalk.cyan('Hooks:'));
  console.log(`  Installed: ${hooks.installed ? chalk.green('Yes') : chalk.yellow('No')}`);
  console.log(`  Receiver:  ${hooks.receiverRunning ? chalk.green('Running') : chalk.yellow('Not running')}`);
  if (hooks.degraded) {
    console.log(`  Status:    ${chalk.yellow('Degraded - run keepline daemon start to receive hook events')}`);
  }
  const codexHooks = hooks.targets.find((target) => target.runtimeId === 'codex');
  if (codexHooks?.installed) {
    console.log(`  Codex trust: ${chalk.yellow('Runtime-managed - verify approval in Codex')}`);
  }
  console.log('');

  // Configuration
  const cfg = config.get();
  console.log(chalk.cyan('Configuration:'));
  console.log(`  Scan interval:  ${cfg.scanInterval}ms`);
  console.log(`  Hook port:      ${cfg.hookPort}`);
  console.log(`  Log level:      ${cfg.logLevel}`);
  console.log('');

  // Database stats
  try {
    runMigrations();
    const allSessions = sessionRepository.findAll();
    const activeSessions = sessionRepository.findActive();

    console.log(chalk.cyan('Database:'));
    console.log(`  Total sessions:  ${allSessions.length}`);
    console.log(`  Active sessions: ${activeSessions.length}`);
  } catch {
    console.log(chalk.cyan('Database:'));
    console.log(`  ${chalk.gray('Not initialized')}`);
  }
  console.log('');

  // Running processes
  const processes = scanAgentProcesses();
  console.log(chalk.cyan('Agent Processes:'));
  if (processes.length === 0) {
    console.log(`  ${chalk.gray('No supported agent processes running')}`);
  } else {
    console.log(`  Found: ${chalk.green(processes.length)} running`);
    processes.slice(0, 5).forEach((p) => {
      console.log(`    PID ${p.pid}: ${p.cwd}`);
    });
    if (processes.length > 5) {
      console.log(chalk.gray(`    ... and ${processes.length - 5} more`));
    }
  }
  console.log('');
  closeDatabase();
}
