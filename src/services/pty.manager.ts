/**
 * PTY Session Manager
 *
 * Manages pseudo-terminal sessions with scrollback buffer,
 * detach/reattach support, and lifecycle tracking.
 * Uses Bun's built-in PTY implementation, avoiding a separately published
 * native dynamic library.
 */

import { randomUUID } from 'crypto';
import { existsSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { runSql } from '../infrastructure/database/sqlite.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { assertValidSessionId } from '../lib/session-id.js';
import type { AgentClient } from '../domain/session/index.js';
import { unscopeCodexSessionId } from '../adapters/codex/parser.js';

interface IPty {
  pid: number;
  cols: number;
  rows: number;
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onExit: (callback: (e: { exitCode: number; signal?: string }) => void) => { dispose: () => void };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
}

interface BunPtyOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

function spawnBunPty(file: string, args: string[], options: BunPtyOptions): IPty {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: string }) => void>();
  const decoder = new TextDecoder();
  let cols = options.cols;
  let rows = options.rows;
  let terminal: Bun.Terminal | undefined;
  let exitEvent: { exitCode: number; signal?: string } | undefined;

  const process = Bun.spawn([file, ...args], {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      name: options.name,
      cols,
      rows,
      data(_terminal, bytes) {
        const data = decoder.decode(bytes, { stream: true });
        if (!data) return;
        for (const listener of dataListeners) listener(data);
      },
    },
    onExit(_process, exitCode, signalCode, error) {
      const trailingData = decoder.decode();
      if (trailingData) {
        for (const listener of dataListeners) listener(trailingData);
      }
      const event = {
        exitCode: exitCode ?? (error ? 1 : 0),
        signal: signalCode == null ? undefined : String(signalCode),
      };
      exitEvent = event;
      for (const listener of exitListeners) listener(event);
      // Closing from inside Bun's onExit callback can delay the callback until
      // the PTY stream itself closes. Notify lifecycle listeners first and
      // release the terminal on the next microtask.
      queueMicrotask(() => terminal?.close());
    },
  });
  terminal = process.terminal;
  if (!terminal) {
    process.kill();
    throw new Error('Bun did not create a pseudo-terminal');
  }

  return {
    pid: process.pid,
    get cols() { return cols; },
    get rows() { return rows; },
    onData(callback) {
      dataListeners.add(callback);
      return { dispose: () => dataListeners.delete(callback) };
    },
    onExit(callback) {
      exitListeners.add(callback);
      if (exitEvent) queueMicrotask(() => callback(exitEvent!));
      return { dispose: () => exitListeners.delete(callback) };
    },
    write(data) {
      terminal?.write(data);
    },
    resize(nextCols, nextRows) {
      cols = nextCols;
      rows = nextRows;
      terminal?.resize(nextCols, nextRows);
    },
    kill(signal) {
      process.kill(signal as NodeJS.Signals | undefined);
    },
  };
}

interface ServerWebSocket {
  send: (data: string | Buffer) => void;
}

export function resolveAllowedTerminalCwd(
  requestedCwd: unknown,
  allowedRoots: string[] = getAllowedTerminalCwdRoots(),
): string {
  if (requestedCwd !== undefined && typeof requestedCwd !== 'string') {
    throw new Error('Terminal cwd must be a string');
  }

  const fallbackCwd = process.env.HOME || homedir();
  const candidate = requestedCwd && requestedCwd.trim().length > 0 ? requestedCwd : fallbackCwd;
  const realCandidate = realDirectory(candidate, 'Terminal cwd');
  const realAllowedRoots = allowedRoots
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => realDirectory(root, 'Terminal cwd allowlist root'));

  if (realAllowedRoots.length === 0) {
    throw new Error('Terminal cwd allowlist is empty');
  }

  if (!realAllowedRoots.some((root) => isPathWithin(realCandidate, root))) {
    throw new Error('Terminal cwd is outside allowed roots');
  }

  return realCandidate;
}

export interface PtySession {
  id: string;
  userId: string;
  pty: IPty;
  scrollback: string[];
  scrollbackBytes: number;
  attachedClients: Set<ServerWebSocket>;
  status: 'running' | 'exited';
  exitCode?: number;
  cwd: string;
  createdAt: Date;
  lastActivity: Date;
}

export interface SessionInfo {
  id: string;
  pid: number;
  cwd: string;
  status: string;
  exitCode?: number;
  createdAt: string;
  clientCount: number;
}

class PtyManager {
  sessions = new Map<string, PtySession>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Start idle cleanup timer
    this.idleTimer = setInterval(() => this.cleanupIdle(), 60_000);
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  async create(
    userId: string,
    cols: number = 80,
    rows: number = 24,
    cwd?: string,
    resumeSessionId?: string,
    resumeSessionClient: AgentClient = 'claude'
  ): Promise<PtySession> {
    const cfg = config.get().webTerminal;

    // Check max sessions
    const userSessions = [...this.sessions.values()].filter(
      s => s.userId === userId && s.status === 'running'
    );
    if (userSessions.length >= cfg.maxSessions) {
      throw new Error(`Max sessions (${cfg.maxSessions}) reached`);
    }

    const sessionId = randomUUID();
    const spawnCwd = resolveAllowedTerminalCwd(cwd);

    // Build command: if resumeSessionId provided, resume through the owning client.
    let file: string;
    let args: string[];
    if (resumeSessionId) {
      assertValidSessionId(resumeSessionId);
      if (resumeSessionClient === 'codex') {
        file = 'codex';
        args = ['resume', unscopeCodexSessionId(resumeSessionId)];
      } else {
        file = 'claude';
        args = ['--resume', resumeSessionId];
      }
    } else {
      const shellCmd = cfg.shellCommand || 'claude';
      const shellParts = shellCmd.split(' ');
      file = shellParts[0];
      args = shellParts.slice(1);
    }

    const pty = spawnBunPty(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: spawnCwd,
      env: {
        HOME: process.env.HOME || '',
        PATH: process.env.PATH || '',
        TERM: 'xterm-256color',
        LANG: process.env.LANG || 'en_US.UTF-8',
        USER: process.env.USER || '',
        SHELL: process.env.SHELL || '/bin/bash',
        COLORTERM: 'truecolor',
      },
    });

    const session: PtySession = {
      id: sessionId,
      userId,
      pty,
      scrollback: [],
      scrollbackBytes: 0,
      attachedClients: new Set(),
      status: 'running',
      cwd: spawnCwd,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    // Capture output -> scrollback + broadcast to attached clients
    pty.onData((data: string) => {
      session.lastActivity = new Date();
      this.appendScrollback(session, data);
      const msg = JSON.stringify({ type: 'term:output', data: { sessionId, data } });
      for (const client of session.attachedClients) {
        try {
          client.send(msg);
        } catch (e) {
          session.attachedClients.delete(client);
          logger.warn(`PTY ${sessionId}: client send failed; detached disconnected client`, e);
        }
      }
    });

    // Handle exit
    pty.onExit(({ exitCode }) => {
      session.status = 'exited';
      session.exitCode = exitCode;
      const msg = JSON.stringify({ type: 'term:exited', data: { sessionId, exitCode } });
      for (const client of session.attachedClients) {
        try {
          client.send(msg);
        } catch (e) {
          session.attachedClients.delete(client);
          logger.warn(`PTY ${sessionId}: client send (exit) failed; detached disconnected client`, e);
        }
      }
      // Update DB
      runSql(
        'UPDATE terminal_sessions SET status = ?, exit_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['exited', exitCode, sessionId]
      );
      logger.info(`PTY session ${sessionId} exited with code ${exitCode}`);
      this.cleanupExitedSession(session);
    });

    this.sessions.set(sessionId, session);

    // Record in DB
    runSql(
      'INSERT INTO terminal_sessions (id, user_id, pid, cwd, status) VALUES (?, ?, ?, ?, ?)',
      [sessionId, userId, pty.pid, spawnCwd, 'running']
    );

    logger.info(`PTY session ${sessionId} created (pid: ${pty.pid})`);
    return session;
  }

  private getOwnedSession(sessionId: string, userId: string): PtySession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.userId !== userId) throw new Error('Forbidden');
    return session;
  }

  attach(sessionId: string, userId: string, ws: ServerWebSocket): PtySession {
    const session = this.getOwnedSession(sessionId, userId);

    // Replay scrollback
    if (session.scrollback.length > 0) {
      const scrollbackData = session.scrollback.join('');
      ws.send(JSON.stringify({ type: 'term:scrollback', data: { sessionId, data: scrollbackData } }));
    }

    session.attachedClients.add(ws);
    logger.info(`Client attached to session ${sessionId} (${session.attachedClients.size} clients)`);
    return session;
  }

  detach(sessionId: string, userId: string, ws: ServerWebSocket): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.userId !== userId) {
        throw new Error('Forbidden');
      }
      session.attachedClients.delete(ws);
      logger.info(`Client detached from session ${sessionId} (${session.attachedClients.size} clients)`);
      this.cleanupExitedSession(session);
    }
  }

  write(sessionId: string, userId: string, data: string): void {
    const session = this.getOwnedSession(sessionId, userId);
    if (session.status !== 'running') return;
    session.pty.write(data);
    session.lastActivity = new Date();
  }

  resize(sessionId: string, userId: string, cols: number, rows: number): void {
    const session = this.getOwnedSession(sessionId, userId);
    if (session.status !== 'running') return;
    session.pty.resize(cols, rows);
  }

  kill(sessionId: string, userId: string): void {
    const session = this.getOwnedSession(sessionId, userId);
    if (session.status !== 'running') return;
    session.pty.kill();
    logger.info(`PTY session ${sessionId} killed`);
  }

  listSessions(userId?: string): SessionInfo[] {
    const result: SessionInfo[] = [];
    for (const session of this.sessions.values()) {
      if (userId && session.userId !== userId) continue;
      result.push({
        id: session.id,
        pid: session.pty.pid,
        cwd: session.cwd,
        status: session.status,
        exitCode: session.exitCode,
        createdAt: session.createdAt.toISOString(),
        clientCount: session.attachedClients.size,
      });
    }
    return result;
  }

  detachAll(ws: ServerWebSocket): void {
    for (const session of this.sessions.values()) {
      session.attachedClients.delete(ws);
      this.cleanupExitedSession(session);
    }
  }

  private cleanupExitedSession(session: PtySession): void {
    if (session.status !== 'exited' || session.attachedClients.size > 0) {
      return;
    }

    session.scrollback = [];
    session.scrollbackBytes = 0;
    this.sessions.delete(session.id);
    logger.info(`Cleaned up exited PTY session ${session.id}`);
  }

  private appendScrollback(session: PtySession, data: string): void {
    const maxSize = config.get().webTerminal.scrollbackSize;
    session.scrollback.push(data);
    session.scrollbackBytes += data.length;

    // Trim if over limit
    while (session.scrollbackBytes > maxSize && session.scrollback.length > 1) {
      const removed = session.scrollback.shift()!;
      session.scrollbackBytes -= removed.length;
    }
  }

  private cleanupIdle(): void {
    const timeoutMin = config.get().webTerminal.idleTimeoutMinutes;
    const cutoff = Date.now() - timeoutMin * 60_000;
    for (const session of [...this.sessions.values()]) {
      if (session.status === 'exited') {
        this.cleanupExitedSession(session);
        continue;
      }

      if (timeoutMin <= 0) {
        continue;
      }

      if (session.status === 'running' && session.lastActivity.getTime() < cutoff && session.attachedClients.size === 0) {
        logger.info(`Killing idle session ${session.id}`);
        session.pty.kill();
      }
    }
  }

  cleanup(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const session of [...this.sessions.values()]) {
      if (session.status === 'running') {
        session.pty.kill();
      }
    }
    this.sessions.clear();
  }
}

export const ptyManager = new PtyManager();

function getAllowedTerminalCwdRoots(): string[] {
  const configuredRoots = process.env.KEEPLINE_TERMINAL_CWD_ROOTS;
  if (configuredRoots) {
    return configuredRoots.split(path.delimiter);
  }
  return [process.env.HOME || homedir()];
}

function realDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  if (!existsSync(resolved)) {
    throw new Error(`${label} does not exist`);
  }

  const realPath = realpathSync(resolved);
  if (!statSync(realPath).isDirectory()) {
    throw new Error(`${label} is not a directory`);
  }

  return realPath;
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
