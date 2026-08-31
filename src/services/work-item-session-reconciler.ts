import { runtimeIdForClient } from './runtime-status.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import { workItemEvidenceRepository } from '../infrastructure/database/repositories/work-item-evidence.repository.js';

export interface LinkedSessionReconcileResult {
  updated: number;
  missing: number;
  evidenceCreated: number;
}

function conciseSummary(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, 500);
}

/**
 * Refresh accepted Work links from canonical runtime sessions.
 * Completion evidence is emitted only for the durable explicit completedAt signal
 * written by an explicit user completion action.
 */
export function reconcileLinkedAgentSessions(): LinkedSessionReconcileResult {
  const result: LinkedSessionReconcileResult = { updated: 0, missing: 0, evidenceCreated: 0 };
  const linkedSessions = workItemEvidenceRepository.findAcceptedLinkedAgentSessions();

  for (const linked of linkedSessions) {
    const canonical = sessionRepository.findBySessionId(linked.runtimeSessionId);
    if (!canonical || runtimeIdForClient(canonical.client) !== linked.runtimeId) {
      result.missing++;
      continue;
    }

    const evidenceSummary = conciseSummary(canonical.lastMessage, canonical.title);
    workItemEvidenceRepository.upsertAgentSession({
      runtimeId: linked.runtimeId,
      runtimeSessionId: linked.runtimeSessionId,
      projectRoot: linked.projectRoot ?? canonical.directory,
      cwd: canonical.directory,
      status: canonical.status,
      title: canonical.title,
      lastActiveAt: canonical.lastActiveAt,
      evidenceSummary,
    });
    result.updated++;

    for (const link of workItemEvidenceRepository.findAcceptedSessionLinks(linked.id)) {
      const pendingClaims = workItemEvidenceRepository.findPendingAgentCompletionClaims(
        link.workItemId,
        canonical.sessionId
      );
      for (const pending of pendingClaims) {
        const claimAtValue = pending.metadata?.claimAt;
        if (typeof claimAtValue !== 'string') continue;
        const claimAt = new Date(claimAtValue);
        if (Number.isNaN(claimAt.getTime()) ||
            workItemEvidenceRepository.findAgentCompletionClaimEvidence(
              linked.id,
              link.workItemId,
              claimAt
            )) continue;
        workItemEvidenceRepository.createProgressEvidence({
          workItemId: link.workItemId,
          agentSessionId: linked.id,
          runtimeId: linked.runtimeId,
          kind: 'message',
          outcome: 'completed',
          confidence: 'explicit',
          summary: pending.summary,
          occurredAt: claimAt,
          metadata: {
            source: 'agent_completion_claim',
            claimAt: claimAt.toISOString(),
          },
        });
        result.evidenceCreated++;
      }
    }

    if (canonical.status !== 'completed' || !canonical.completedAt) continue;
    if (workItemEvidenceRepository.findCanonicalCompletionEvidence(linked.id, canonical.completedAt)) {
      continue;
    }

    workItemEvidenceRepository.createProgressEvidence({
      agentSessionId: linked.id,
      runtimeId: linked.runtimeId,
      kind: 'message',
      outcome: 'completed',
      confidence: 'explicit',
      summary: conciseSummary(canonical.lastMessage, `${canonical.title} completed`),
      occurredAt: canonical.completedAt,
      metadata: {
        source: 'canonical_session_completed',
        completedAt: canonical.completedAt.toISOString(),
      },
    });
    result.evidenceCreated++;
  }

  return result;
}
