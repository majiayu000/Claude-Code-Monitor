/**
 * Daemon command - manage background process
 */

import chalk from 'chalk';
import { startDaemon, stopDaemon, getDaemonStatus, restartDaemon } from '../services/daemon.manager.js';
import { runDaemon } from '../services/daemon.scheduler.js';
import { installHooks, uninstallHooks, getHookStatus } from '../adapters/hook/installer.js';

type DaemonAction = 'start' | 'stop' | 'restart' | 'status' | 'run';

interface DaemonOptions {
  hooks?: boolean;
}

export async function daemonCommand(
  action: DaemonAction,
  options: DaemonOptions
): Promise<void> {
  switch (action) {
    case 'start':
      await startDaemonAction(options);
      break;
    case 'stop':
      await stopDaemonAction(options);
      break;
    case 'restart':
      await restartDaemonAction(options);
      break;
    case 'status':
      showStatus();
      break;
    case 'run':
      // Run in foreground (used by daemon process itself)
      await runDaemon();
      break;
    default:
      console.log(chalk.red(`Unknown action: ${action}`));
      console.log('Available actions: start, stop, restart, status');
      process.exit(1);
  }
}

async function startDaemonAction(options: DaemonOptions): Promise<void> {
  console.log(chalk.cyan('Starting daemon...'));

  // Install hooks if requested
  if (options.hooks) {
    console.log(chalk.gray('Installing Claude Code and Codex hooks...'));
    installHooks();
  }

  const result = startDaemon();

  if (result.success) {
    console.log(chalk.green(`Daemon started (PID: ${result.pid})`));
  } else {
    console.log(chalk.red(`Failed to start daemon: ${result.error}`));
    process.exit(1);
  }
}

async function stopDaemonAction(options: DaemonOptions): Promise<void> {
  console.log(chalk.cyan('Stopping daemon...'));

  // Uninstall hooks if requested
  if (options.hooks) {
    console.log(chalk.gray('Uninstalling Claude Code and Codex hooks...'));
    uninstallHooks();
  }

  const result = await stopDaemon();

  if (result.success) {
    console.log(chalk.green('Daemon stopped'));
  } else {
    console.log(chalk.red(`Failed to stop daemon: ${result.error}`));
    process.exit(1);
  }
}

async function restartDaemonAction(_options: DaemonOptions): Promise<void> {
  console.log(chalk.cyan('Restarting daemon...'));

  const result = await restartDaemon();

  if (result.success) {
    console.log(chalk.green(`Daemon restarted (PID: ${result.pid})`));
  } else {
    console.log(chalk.red(`Failed to restart daemon: ${result.error}`));
    process.exit(1);
  }
}

function showStatus(): void {
  const daemonStatus = getDaemonStatus();
  const hookStatus = getHookStatus();

  console.log('');
  console.log(chalk.bold('Keepline Status'));
  console.log('');

  // Daemon status
  console.log(chalk.gray('Daemon:'));
  if (daemonStatus.running) {
    console.log(chalk.green(`  Running (PID: ${daemonStatus.pid})`));
    if (daemonStatus.uptime) {
      const hours = Math.floor(daemonStatus.uptime / 3600);
      const minutes = Math.floor((daemonStatus.uptime % 3600) / 60);
      console.log(chalk.gray(`  Uptime: ${hours}h ${minutes}m`));
    }
  } else {
    console.log(chalk.yellow('  Not running'));
  }

  console.log('');

  // Hook status
  console.log(chalk.gray('Hooks:'));
  if (hookStatus.installation === 'all') {
    console.log(chalk.green('  Installed'));
  } else if (hookStatus.installation === 'partial') {
    console.log(chalk.yellow('  Partially installed'));
  } else {
    console.log(chalk.yellow('  Not installed'));
  }
  console.log(chalk.gray(`  Settings: ${hookStatus.settingsPath}`));
  if (hookStatus.targets.some((target) => target.runtimeId === 'codex' && target.installed)) {
    console.log(chalk.yellow('  Codex trust: verify approval in Codex'));
  }

  console.log('');
}
