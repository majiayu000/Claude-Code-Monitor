/**
 * Commands module - register all CLI commands
 */

import { Command } from 'commander';
import { DEFAULT_WEB_PORT } from '../lib/config.js';

export function registerCommands(program: Command): void {
  // List sessions
  program
    .command('list')
    .alias('ls')
    .description('List all agent runtime sessions')
    .option('-s, --status <status>', 'Filter by status (running,waiting,idle,lost,completed)')
    .option('-d, --directory <dir>', 'Filter by directory')
    .option('-l, --limit <n>', 'Limit results')
    .option('-a, --all', 'Include completed sessions')
    .option('--style <style>', 'UI style: cyber (default), minimal, dashboard, neon, macos')
    .action(async (options) => (await import('./list.js')).listCommand(options));

  // Watch sessions (live)
  program
    .command('watch')
    .alias('w')
    .description('Live monitor agent runtime sessions')
    .option('-i, --interval <seconds>', 'Refresh interval in seconds')
    .action(async (options) => (await import('./watch.js')).watchCommand(options));

  // Recover session
  program
    .command('recover [session]')
    .alias('r')
    .description('Recover a lost session')
    .option('-m, --method <method>', 'Recovery method (resume, continue, new)')
    .option('-t, --terminal', 'Open in new terminal window')
    .option('-a, --terminal-app <app>', 'Terminal app to use (Terminal, iTerm, Warp, auto)')
    .option('--skip-permissions', 'Use the owning CLI unsafe permission bypass flag')
    .action(async (session, options) => {
      const { recoverCommand, recoverListCommand } = await import('./recover.js');
      if (!session) {
        await recoverListCommand();
      } else {
        await recoverCommand(session, options);
      }
    });

  // Daemon management
  program
    .command('daemon <action>')
    .alias('d')
    .description('Manage background daemon (start, stop, restart, status)')
    .option('--hooks', 'Install/uninstall Claude-compatible hooks with daemon')
    .action(async (action, options) => (await import('./daemon.js')).daemonCommand(action, options));

  // Status
  program
    .command('status')
    .description('Show system status')
    .action(async () => (await import('./status.js')).statusCommand());

  // Orchestrator overview
  program
    .command('overview')
    .description('Show the global agent attention queue')
    .option('-a, --all', 'Include completed sessions')
    .option('-l, --limit <n>', 'Limit results (default: 20)')
    .option('--json', 'Output JSON')
    .option('--high-cost-threshold <amount>', 'Cost threshold for high-cost reason')
    .option('--stale-hours <hours>', 'Hours without activity before stale reason')
    .option('--lost-hours <hours>', 'Hours a lost session remains in the default recovery queue')
    .option('--include-old-lost', 'Include lost sessions outside the recovery window')
    .action(async (options) => (await import('./overview.js')).overviewCommand(options));

  // Hooks management
  program
    .command('hooks <action>')
    .description('Manage Claude-compatible hooks (install, uninstall, status)')
    .action(async (action: string) => {
      const { installHooks, uninstallHooks } = await import('../adapters/hook/installer.js');
      const chalk = (await import('chalk')).default;

      switch (action) {
        case 'install':
          installHooks();
          console.log(chalk.green('Hooks installed successfully'));
          break;
        case 'uninstall':
          uninstallHooks();
          console.log(chalk.green('Hooks uninstalled successfully'));
          break;
        case 'status': {
          const { getHookAvailability } = await import('../adapters/hook/availability.js');
          const status = await getHookAvailability();
          console.log(`Hooks installed: ${status.installed ? chalk.green('Yes') : chalk.red('No')}`);
          console.log(`Hook receiver: ${status.receiverRunning ? chalk.green('Running') : chalk.yellow('Not running')}`);
          if (status.degraded) {
            console.log(chalk.yellow('Hooks are installed but no hook receiver is running. Start keepline daemon to receive hook events.'));
          }
          console.log(`Settings path: ${status.settingsPath}`);
          break;
        }
        default:
          console.log(chalk.red(`Unknown action: ${action}`));
          console.log('Available actions: install, uninstall, status');
      }
    });

  // Sync (manual trigger)
  program
    .command('sync')
    .description('Manually sync agent runtime sessions')
    .action(async () => {
      const { runMigrations } = await import('../db/migrations.js');
      const { syncSessions } = await import('../services/session.service.js');
      const chalk = (await import('chalk')).default;

      runMigrations();
      console.log(chalk.gray('Syncing sessions...'));
      const result = await syncSessions();
      console.log(chalk.green(`Done: ${result.discovered} new, ${result.updated} updated, ${result.lost} lost`));
    });

  // Web UI
  program
    .command('web')
    .description('Start the web UI server')
    .option('-p, --port <port>', `Port to listen on (default: ${DEFAULT_WEB_PORT})`)
    .action(async (options) => (await import('./web.js')).webCommand(options));

  program
    .command('service')
    .description('Start the lightweight local API service')
    .option('-p, --port <port>', 'Port to listen on (default: 3377)')
    .option('--scan-interval <seconds>', 'Periodic transcript scan interval (default: 60; 0 disables)')
    .action(async (options) => (await import('./service.js')).serviceCommand(options));

  program
    .command('_service-scan', { hidden: true })
    .option('--full')
    .action(async (options) => (await import('./service-scan.js')).serviceScanCommand(options));

  // Memory management (relay race pattern)
  const memoryCmd = program
    .command('memory')
    .alias('m')
    .description('Manage session memory (relay race pattern)');

  memoryCmd
    .command('list')
    .alias('ls')
    .description('List all session memories')
    .option('-d, --directory <dir>', 'Filter by directory')
    .option('-l, --limit <n>', 'Limit results (default: 10)')
    .action(async (options) => (await import('./memory.js')).memoryListCommand(options));

  memoryCmd
    .command('show <session>')
    .description('Show memory details for a session')
    .option('-v, --verbose', 'Show all details')
    .option('-c, --context', 'Show recovery context')
    .action(async (session, options) => (await import('./memory.js')).memoryShowCommand(session, options));

  memoryCmd
    .command('edit <session>')
    .description('Edit session memory')
    .option('-p, --progress <text>', 'Set last progress')
    .option('-t, --add-task <task>', 'Add a pending task')
    .option('-T, --complete-task <index|text>', 'Complete a task (by index or text match)')
    .option('-i, --add-issue <issue>', 'Add a known issue')
    .option('-I, --resolve-issue <index|text>', 'Resolve an issue')
    .option('-d, --decision <text>', 'Add a decision')
    .option('-H, --handoff <notes>', 'Set handoff notes')
    .option('-P, --priority <item>', 'Add a priority item for handoff')
    .option('-n, --notes <text>', 'Set general notes')
    .option('--clear', 'Clear all memory fields')
    .action(async (session, options) => (await import('./memory.js')).memoryEditCommand(session, options));

  memoryCmd
    .command('delete <session>')
    .description('Delete session memory')
    .option('-f, --force', 'Confirm deletion')
    .action(async (session, options) => (await import('./memory.js')).memoryDeleteCommand(session, options));

  memoryCmd
    .command('export <session>')
    .description('Export memory as recovery context')
    .option('-o, --output <file>', 'Output file (default: stdout)')
    .action(async (session, options) => (await import('./memory.js')).memoryExportCommand(session, options));
}
