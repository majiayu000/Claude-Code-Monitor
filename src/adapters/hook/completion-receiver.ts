import type { Server } from 'bun';
import { sessionRepository } from '../../infrastructure/database/repositories/session.repository.js';
import { workItemEvidenceRepository } from '../../infrastructure/database/repositories/work-item-evidence.repository.js';
import { encodeAgentSessionId } from '../../domain/work-item/index.js';
import { workItemRepository } from '../../infrastructure/database/repositories/work-item.repository.js';
import { taskDispatchRepository } from '../../infrastructure/database/repositories/task-dispatch.repository.js';
import { emit } from '../../lib/events.js';
import { logger } from '../../lib/logger.js';
import { isValidSessionId, scopeCodexSessionId } from '../../lib/session-id.js';
import {
  generateTitle,
  isGeneratedSessionTitle,
  type AgentClient,
  type SessionStatus,
} from '../../domain/session/index.js';
import {
  isAllowedFetchMetadata,
  isAllowedRequestHost,
  isLoopbackOrigin,
} from '../../web/api/request-security.js';

const ACCEPTED_EVENT_TYPES = new Set([
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
]);
const MAX_HOOK_BODY_BYTES = 64 * 1024;

export interface LifecycleReceiver {
  port: number;
  stop(): void;
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HOOK_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAllowedRequest(request: Request, port: number): boolean {
  const origin = request.headers.get('origin');
  return isAllowedRequestHost(request, '127.0.0.1', port) &&
    (!origin || isLoopbackOrigin(origin)) &&
    isAllowedFetchMetadata(request);
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

function parseRuntimeHint(url: URL): AgentClient | null | undefined {
  const runtime = url.searchParams.get('runtime');
  if (runtime === null) return undefined;
  if (runtime === 'claude-code') return 'claude';
  if (runtime === 'codex') return 'codex';
  return null;
}

function observedStatus(eventType: string): SessionStatus | undefined {
  if (eventType === 'Stop') return 'waiting';
  if (eventType === 'SessionStart' || eventType === 'UserPromptSubmit' ||
      eventType === 'PreToolUse' || eventType === 'PostToolUse') {
    return 'running';
  }
  return undefined;
}

function recordCompletionClaim(
  sessionId: string,
  cwd: string,
  message: unknown,
  claimAt: Date,
  allowExplicitCompletion: boolean
): 'recorded' | 'pending' | 'ignored' {
  if (typeof message !== 'string') return 'ignored';
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) return 'ignored';
  const prefix = 'KEEPLINE_COMPLETE_WORK_ITEM:';
  if (!lastLine.startsWith(prefix)) return 'ignored';
  const workItemId = lastLine.slice(prefix.length);
  const workItem = workItemRepository.findById(workItemId);
  if (!workItem || lastLine !== `${prefix}${workItem.id}`) return 'ignored';

  const agentSessionId = encodeAgentSessionId('claude-code', sessionId);
  const link = workItemEvidenceRepository.findAcceptedSessionLinks(agentSessionId)
    .find((candidate) => candidate.workItemId === workItem.id);
  const summary = lines.slice(0, -1).join(' ').slice(0, 500) ||
    'Agent explicitly claimed the linked work item is complete.';
  if (!link || !allowExplicitCompletion) {
    const matchingDispatches = taskDispatchRepository.findByWorkItemId(workItem.id).filter(
      (dispatch) => dispatch.runtimeId === 'claude-code' &&
        dispatch.cwd === cwd &&
        ['launching', 'awaiting_session', 'ambiguous', 'linked'].includes(dispatch.state)
    );
    if (matchingDispatches.length !== 1) return 'ignored';
    const dispatch = matchingDispatches[0];
    const existingPending = workItemEvidenceRepository
      .findPendingAgentCompletionClaims(workItem.id, sessionId)
      .some((evidence) => evidence.metadata?.claimAt === claimAt.toISOString());
    if (!existingPending) {
      workItemEvidenceRepository.createProgressEvidence({
        workItemId: workItem.id,
        runtimeId: 'claude-code',
        kind: 'message',
        outcome: 'progress',
        confidence: 'inferred',
        summary,
        occurredAt: claimAt,
        metadata: {
          source: 'pending_agent_completion_claim',
          runtimeSessionId: sessionId,
          dispatchId: dispatch.id,
          cwd,
          claimAt: claimAt.toISOString(),
        },
      });
    }
    return 'pending';
  }
  if (workItemEvidenceRepository.findAgentCompletionClaimEvidence(
    agentSessionId,
    link.workItemId,
    claimAt
  )) return 'recorded';

  workItemEvidenceRepository.createProgressEvidence({
    workItemId: link.workItemId,
    agentSessionId,
    runtimeId: 'claude-code',
    kind: 'message',
    outcome: 'completed',
    confidence: 'explicit',
    summary,
    occurredAt: claimAt,
    metadata: {
      source: 'agent_completion_claim',
      claimAt: claimAt.toISOString(),
    },
  });
  return 'recorded';
}

export function startLifecycleReceiver(port: number): LifecycleReceiver {
  let server: Server<unknown>;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request) {
      if (!isAllowedRequest(request, server.port ?? port)) {
        return json({ success: false, error: 'Forbidden' }, 403);
      }
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ status: 'ok', service: 'keepline-hook-receiver', mode: 'lifecycle-only' });
      }
      if (request.method !== 'POST' || url.pathname !== '/hook') {
        return json({ success: false, error: 'Not found' }, 404);
      }

      const contentLength = Number(request.headers.get('content-length') ?? '0');
      if (Number.isFinite(contentLength) && contentLength > MAX_HOOK_BODY_BYTES) {
        return json({ success: false, error: 'Hook event payload is too large' }, 413);
      }

      try {
        let body: unknown;
        try {
          const bytes = await readBoundedBody(request);
          if (!bytes) {
            return json({ success: false, error: 'Hook event payload is too large' }, 413);
          }
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return json({ success: false, error: 'Invalid hook event payload' }, 400);
        }
        if (!isRecord(body)) {
          return json({ success: false, error: 'Invalid hook event payload' }, 400);
        }
        const eventType = body.hook_event_name ?? body.event_type;
        if (typeof eventType !== 'string' || !ACCEPTED_EVENT_TYPES.has(eventType) ||
            !isValidSessionId(body.session_id)) {
          return json({ success: false, error: 'Invalid hook event payload' }, 400);
        }
        const runtimeHint = parseRuntimeHint(url);
        if (runtimeHint === null || typeof body.cwd !== 'string' || body.cwd.length === 0) {
          return json({ success: false, error: 'Invalid hook event payload' }, 400);
        }
        const sessionId = runtimeHint === 'codex'
          ? scopeCodexSessionId(body.session_id)
          : body.session_id;

        const eventTimestamp = typeof body.timestamp === 'string'
          ? new Date(body.timestamp)
          : new Date();
        if (Number.isNaN(eventTimestamp.getTime())) {
          return json({ success: false, error: 'Invalid hook event timestamp' }, 400);
        }
        let existing = sessionRepository.findBySessionId(sessionId);
        if (!existing) {
          if (eventType === 'Stop') {
            if (recordCompletionClaim(
              sessionId,
              body.cwd,
              body.last_assistant_message,
              eventTimestamp,
              false
            ) === 'pending') {
              emit('session:turn-ended', {
                sessionId,
                timestamp: eventTimestamp,
              });
              return json({ success: true, pending: true }, 202);
            }
            return json({ success: false, error: 'Session not found' }, 404);
          }
          const status = observedStatus(eventType);
          if (!status) return json({ success: false, error: 'Session not found' }, 404);
          const initialPrompt = eventType === 'UserPromptSubmit' && typeof body.prompt === 'string'
            ? body.prompt
            : 'Unknown task';
          existing = sessionRepository.upsert({
            sessionId,
            client: runtimeHint ?? 'claude',
            directory: body.cwd,
            status,
            title: generateTitle(initialPrompt),
            initialPrompt,
            startedAt: new Date(),
            lastActiveAt: new Date(),
          });
          emit('session:discovered', { session: existing });
        }
        if (runtimeHint && runtimeHint !== existing.client) {
          return json({ success: false, error: 'Hook runtime does not match the session' }, 409);
        }
        if (body.cwd !== existing.directory) {
          return json({ success: false, error: 'Hook cwd does not match the session' }, 409);
        }

        const status = observedStatus(eventType);
        if (status && existing.status !== 'completed') {
          const previousStatus = existing.status;
          const prompt = eventType === 'UserPromptSubmit' && typeof body.prompt === 'string'
            ? body.prompt
            : undefined;
          const session = sessionRepository.upsert({
            sessionId,
            status,
            lastActiveAt: new Date(),
            ...(typeof body.tool_name === 'string' && { lastTool: body.tool_name }),
            ...(prompt && isGeneratedSessionTitle(existing.title) && {
              title: generateTitle(prompt),
              initialPrompt: prompt,
            }),
          });
          if (previousStatus !== session.status) {
            emit('session:updated', { session, previousStatus });
          }
        }

        if (eventType === 'Stop') {
          // Stop means one response turn ended, not that the user's task completed.
          // A completion suggestion requires a separate exact claim tied to an accepted link.
          if (existing.client === 'claude') {
            recordCompletionClaim(
              sessionId,
              body.cwd,
              body.last_assistant_message,
              eventTimestamp,
              true
            );
          }
          emit('session:turn-ended', {
            sessionId,
            timestamp: eventTimestamp,
            reason: typeof body.stop_reason === 'string'
              ? body.stop_reason
              : typeof body.reason === 'string' ? body.reason : undefined,
          });
        }
        return json({ success: true });
      } catch (error) {
        logger.error('Failed to receive lifecycle hook', error);
        return json({ success: false, error: 'Failed to process hook event' }, 500);
      }
    },
  });

  return {
    port: server.port ?? port,
    stop() {
      server.stop(true);
    },
  };
}
