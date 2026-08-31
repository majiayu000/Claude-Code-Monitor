import { runtimeIdForClient } from './runtime-status.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';
import { taskDispatchRepository } from '../infrastructure/database/repositories/task-dispatch.repository.js';
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

    const acceptedLinks = workItemEvidenceRepository.findAcceptedSessionLinks(linked.id);
    for (const link of acceptedLinks) {
      const pendingClaims = workItemEvidenceRepository.findPendingAgentCompletionClaims(
        link.workItemId,
        canonical.sessionId
      );
      for (const pending of pendingClaims) {
        const dispatchId = pending.metadata?.dispatchId;
        const dispatch = typeof dispatchId === 'string'
          ? taskDispatchRepository.findById(dispatchId)
          : null;
        const dispatchMatches = dispatch?.state === 'linked' &&
          dispatch.workItemId === link.workItemId &&
          dispatch.runtimeId === linked.runtimeId &&
          dispatch.cwd === canonical.directory &&
          dispatch.linkedAgentSessionId === linked.id &&
          dispatch.candidateSessionIds.includes(canonical.sessionId);
        if (!dispatchMatches) {
          workItemEvidenceRepository.deletePendingAgentCompletionClaim(pending.id);
          continue;
        }
        const claimAtValue = pending.metadata?.claimAt;
        if (typeof claimAtValue !== 'string') {
          workItemEvidenceRepository.deletePendingAgentCompletionClaim(pending.id);
          continue;
        }
        const claimAt = new Date(claimAtValue);
        if (Number.isNaN(claimAt.getTime())) {
          workItemEvidenceRepository.deletePendingAgentCompletionClaim(pending.id);
          continue;
        }
        if (workItemEvidenceRepository.findAgentCompletionClaimEvidence(
          linked.id,
          link.workItemId,
          claimAt
        )) {
          workItemEvidenceRepository.deletePendingAgentCompletionClaim(pending.id);
          continue;
        }
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
        workItemEvidenceRepository.deletePendingAgentCompletionClaim(pending.id);
        result.evidenceCreated++;
      }
    }

    if (canonical.status !== 'completed' || !canonical.completedAt) continue;
    for (const link of acceptedLinks) {
      if (workItemEvidenceRepository.findCanonicalCompletionEvidence(
        linked.id,
        link.workItemId,
        canonical.completedAt
      )) continue;

      workItemEvidenceRepository.createProgressEvidence({
        workItemId: link.workItemId,
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
  }

  return result;
}
