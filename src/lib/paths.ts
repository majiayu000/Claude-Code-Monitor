/**
 * Path utilities for Keepline.
 */

import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/** Claude base directory */
export const CLAUDE_HOME = join(homedir(), '.claude');

/** Claude projects directory (primary) */
export const CLAUDE_PROJECTS = join(CLAUDE_HOME, 'projects');

/** Additional Claude data home (claude-work fork / secondary install) */
export const CLAUDE_WORK_HOME = join(homedir(), '.claude-work');

/** Additional Claude projects directory under claude-work */
export const CLAUDE_WORK_PROJECTS = join(CLAUDE_WORK_HOME, 'projects');

/**
 * All Claude project roots to scan.
 * Override via KEEPLINE_PROJECT_ROOTS (colon-separated absolute paths).
 */
export const CLAUDE_PROJECT_ROOTS: string[] = (() => {
  const override = process.env.KEEPLINE_PROJECT_ROOTS;
  if (override) {
    return override.split(':').map((p) => p.trim()).filter(Boolean);
  }
  return [CLAUDE_PROJECTS, CLAUDE_WORK_PROJECTS];
})();

/** Claude history file */
export const CLAUDE_HISTORY = join(CLAUDE_HOME, 'history.jsonl');

/** Claude settings file */
export const CLAUDE_SETTINGS = join(CLAUDE_HOME, 'settings.json');

/** Codex base directory */
export const CODEX_HOME = join(homedir(), '.codex');

/** Codex saved sessions directory */
export const CODEX_SESSIONS = join(CODEX_HOME, 'sessions');

/** Codex lifecycle hooks file */
export const CODEX_HOOKS = join(CODEX_HOME, 'hooks.json');

/**
 * Resolve the Keepline data directory from the current environment.
 *
 * Re-reads `process.env.KEEPLINE_HOME` every call so a CLI flag that sets the
 * env var after this module is imported still takes effect.
 */
export function getKeeplineHome(): string {
  if (process.env.KEEPLINE_HOME) return process.env.KEEPLINE_HOME;
  return join(homedir(), '.keepline');
}

/** Keepline database file (re-resolved each call). */
export function getKeeplineDb(): string {
  return join(getKeeplineHome(), 'keepline.db');
}

/** Keepline log file (re-resolved each call). */
export function getKeeplineLog(): string {
  return join(getKeeplineHome(), 'keepline.log');
}

/** Keepline PID file for daemon (re-resolved each call). */
export function getKeeplinePid(): string {
  return join(getKeeplineHome(), 'keepline.pid');
}

/**
 * Module-load-time snapshots. New code should prefer the getter functions when
 * it needs to honor runtime env overrides set after import.
 */
export const KEEPLINE_HOME = getKeeplineHome();

/** Keepline persisted parse-failure cache */
export const KEEPLINE_PARSE_FAILURE_CACHE = join(KEEPLINE_HOME, 'invalid-session-files.json');

/** Keepline database file (load-time snapshot). */
export const KEEPLINE_DB = getKeeplineDb();

/** Keepline log file (load-time snapshot). */
export const KEEPLINE_LOG = getKeeplineLog();

/** Keepline PID file (load-time snapshot). */
export const KEEPLINE_PID = getKeeplinePid();

/** Ensure the Keepline data directory exists. */
export function ensureKeeplineDataHome(): string {
  const home = getKeeplineHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }
  return home;
}

/** Ensure the parent directory for a Keepline file path exists. */
export function ensureKeeplineParent(path: string): void {
  ensureKeeplineDataHome();
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

/**
 * Convert directory path to Claude project folder name
 * /Users/foo/bar -> -Users-foo-bar
 */
export function dirToProjectName(dir: string): string {
  return dir.replace(/\//g, '-');
}

/**
 * Convert Claude project folder name back to directory path
 * -Users-foo-bar -> /Users/foo/bar
 */
export function projectNameToDir(name: string): string {
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

/**
 * Get project folder path for a directory.
 * Searches every configured Claude project root; returns the first existing
 * match, falling back to the primary root if none exist yet.
 */
export function getProjectFolder(dir: string): string {
  const folderName = dirToProjectName(dir);
  for (const root of CLAUDE_PROJECT_ROOTS) {
    const candidate = join(root, folderName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return join(CLAUDE_PROJECT_ROOTS[0] ?? CLAUDE_PROJECTS, folderName);
}

/**
 * Extract session ID from JSONL filename
 */
export function extractSessionId(filename: string): string {
  return filename.replace('.jsonl', '');
}
