/**
 * Terminal operations for recovery
 */

import { execSync, spawn } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import { logger } from '../lib/logger.js';
import { renderShellCommand, shellQuote } from '../lib/shell-quote.js';
import type { TerminalApp } from './recovery.types.js';

// Allowed commands whitelist for recovery
const ALLOWED_COMMANDS = ['claude', 'claude-code', 'codex', 'npx'];

/** Validate directory path */
function validateDirectory(directory: string): boolean {
  // Must be absolute path
  if (!path.isAbsolute(directory)) {
    return false;
  }
  // Must exist
  if (!existsSync(directory)) {
    return false;
  }
  // No path traversal sequences
  if (directory.includes('..')) {
    return false;
  }
  return true;
}

/** Validate command is in whitelist */
function validateCommand(command: string): boolean {
  const cmdParts = command.trim().split(/\s+/);
  const baseCmd = cmdParts[0];
  return ALLOWED_COMMANDS.some(allowed => baseCmd === allowed || baseCmd.endsWith('/' + allowed));
}

/** Detect available terminal app */
export function detectTerminalApp(): TerminalApp {
  try {
    // Check if Warp is running
    const warpResult = execSync(
      `osascript -e 'tell application "System Events" to (name of processes) contains "Warp"'`,
      { encoding: 'utf-8' }
    ).trim();

    if (warpResult === 'true') {
      return 'Warp';
    }

    // Check if iTerm is running
    const iTermResult = execSync(
      `osascript -e 'tell application "System Events" to (name of processes) contains "iTerm2"'`,
      { encoding: 'utf-8' }
    ).trim();

    if (iTermResult === 'true') {
      return 'iTerm';
    }
  } catch {
    // Ignore
  }

  return 'Terminal';
}

/** Open a new terminal window with command */
export function openTerminalWithCommand(
  command: string,
  directory: string,
  terminalApp: TerminalApp = 'auto'
): void {
  // Security: Validate inputs
  if (!validateDirectory(directory)) {
    logger.error('Invalid directory for terminal command', { directory });
    throw new Error('Invalid directory path');
  }

  if (!validateCommand(command)) {
    logger.error('Command not in whitelist', { command });
    throw new Error('Command not allowed');
  }

  const app = terminalApp === 'auto' ? detectTerminalApp() : terminalApp;

  if (app === 'Warp') {
    openWarp(command, directory);
  } else if (app === 'iTerm') {
    openITerm(command, directory);
  } else {
    openTerminalApp(command, directory);
  }
}

/** Open a validated argv command at the terminal automation boundary. */
export function openTerminalWithArgv(
  executable: string,
  args: string[],
  directory: string,
  terminalApp: TerminalApp = 'auto'
): void {
  if (!ALLOWED_COMMANDS.includes(executable)) {
    throw new Error('Command not allowed');
  }
  openTerminalWithCommand(renderShellCommand([executable, ...args]), directory, terminalApp);
}

/** Open Terminal.app with command */
function openTerminalApp(command: string, directory: string): void {
  const terminalCommand = `cd ${shellQuote(directory)} && ${command}`;
  const script = `
    tell application "Terminal"
      activate
      do script "${escapeForAppleScript(terminalCommand)}"
    end tell
  `;

  try {
    execSync(`osascript -e '${script}'`, { encoding: 'utf-8' });
    logger.debug('Opened Terminal.app with command');
  } catch (error) {
    logger.error('Failed to open Terminal.app', error);
    throw error;
  }
}

/** Open iTerm with command */
function openITerm(command: string, directory: string): void {
  const terminalCommand = `cd ${shellQuote(directory)} && ${command}`;
  const script = `
    tell application "iTerm"
      activate
      create window with default profile
      tell current session of current window
        write text "${escapeForAppleScript(terminalCommand)}"
      end tell
    end tell
  `;

  try {
    execSync(`osascript -e '${script}'`, { encoding: 'utf-8' });
    logger.debug('Opened iTerm with command');
  } catch (error) {
    logger.error('Failed to open iTerm', error);
    throw error;
  }
}

/** Open Warp with command */
function openWarp(command: string, directory: string): void {
  const terminalCommand = `cd ${shellQuote(directory)} && ${command}`;
  const script = `
    tell application "Warp"
      activate
      delay 0.5
      tell application "System Events"
        tell process "Warp"
          keystroke "t" using command down
          delay 0.3
          keystroke "${escapeForAppleScript(terminalCommand)}"
          key code 36
        end tell
      end tell
    end tell
  `;

  try {
    execSync(`osascript -e '${script}'`, { encoding: 'utf-8' });
    logger.debug('Opened Warp with command');
  } catch (error) {
    logger.error('Failed to open Warp', error);
    throw error;
  }
}

/** Escape string for AppleScript */
function escapeForAppleScript(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "'\"'\"'");
}

/** Execute command in current terminal */
export function executeCommand(command: string, cwd: string): number | null {
  // Security: Validate inputs
  if (!validateDirectory(cwd)) {
    logger.error('Invalid cwd for command execution', { cwd });
    return null;
  }

  if (!validateCommand(command)) {
    logger.error('Command not in whitelist', { command });
    return null;
  }

  try {
    // Parse command into executable and args (safer than shell: true)
    const cmdParts = command.trim().split(/\s+/);
    const executable = cmdParts[0];
    const args = cmdParts.slice(1);

    const child = spawn(executable, args, {
      shell: false, // Security: Disable shell interpretation
      cwd,
      stdio: 'inherit',
      detached: true,
    });

    child.unref();
    return child.pid ?? null;
  } catch (error) {
    logger.error('Failed to execute command', error);
    return null;
  }
}

/** Print command for user to copy */
export function printRecoveryCommand(command: string, directory: string): void {
  console.log('\nTo recover this session, run:\n');
  console.log(`  cd ${shellQuote(directory)}`);
  console.log(`  ${command}`);
  console.log('');
}
