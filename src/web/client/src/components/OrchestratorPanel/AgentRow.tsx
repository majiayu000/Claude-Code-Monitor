import type {
  OrchestratorQueueItem,
} from '@/types'
import { formatRelativeTime } from '@/utils/format'
import styles from './OrchestratorPanel.module.css'

interface AgentRowProps {
  item: OrchestratorQueueItem
  onOpenSession?: (sessionId: string) => void
  onRecover?: (sessionId: string) => void | Promise<void>
  onStop?: (sessionId: string) => void | Promise<void>
  onComplete?: (sessionId: string) => void | Promise<void>
  onCopyRecoveryCommand?: (sessionId: string) => void | Promise<void>
  onActionComplete?: () => void | Promise<void>
}

const STATUS_LABELS: Record<OrchestratorQueueItem['status'], string> = {
  waiting: 'Input needed',
  lost: 'Recoverable',
  running: 'Working',
  completed: 'Finished',
  idle: 'Paused',
}

export function AgentRow({
  item,
  onOpenSession,
  onRecover,
  onStop,
  onComplete,
  onCopyRecoveryCommand,
  onActionComplete,
}: AgentRowProps) {
  const runtimeLabel = item.client === 'codex' ? 'Codex' : 'Claude Code'
  const task = formatTask(item)
  const currentState = formatCurrentState(item, task)
  const project = item.project.name

  return (
    <article
      className={styles.agentCard}
      role="listitem"
      data-lane={item.lane}
      data-status={item.status}
    >
      <div className={styles.cardHeader}>
        <span className={styles.statusLabel}>
          <span className={styles.statusDot} aria-hidden="true" />
          {STATUS_LABELS[item.status]}
        </span>
        <span className={styles.runtimeMeta}>
          {runtimeLabel}
          <span aria-hidden="true">·</span>
          <time dateTime={item.lastActiveAt}>{formatRelativeTime(item.lastActiveAt)}</time>
        </span>
      </div>

      <h3 className={styles.task} title={task}>{task}</h3>
      <p className={styles.currentState} title={currentState}>{currentState}</p>

      <div className={styles.cardFooter}>
        <span className={styles.projectName} title={item.project.displayPath}>{project}</span>
        <RowActions
          item={item}
          onOpenSession={onOpenSession}
          onRecover={onRecover}
          onStop={onStop}
          onComplete={onComplete}
          onCopyRecoveryCommand={onCopyRecoveryCommand}
          onActionComplete={onActionComplete}
        />
      </div>
    </article>
  )
}

function RowActions({
  item,
  onOpenSession,
  onRecover,
  onStop,
  onComplete,
  onCopyRecoveryCommand,
  onActionComplete,
}: AgentRowProps) {
  const canRecover = item.canRecover && item.recommendedAction === 'recover' && onRecover
  const canStop = Boolean(item.pid)
    && (item.status === 'running' || item.status === 'waiting')
    && onStop
  const canComplete = item.status !== 'completed' && onComplete
  const primaryAction = canRecover
    ? () => runAction(() => onRecover(item.sessionId), onActionComplete)
    : onOpenSession
      ? () => runAction(() => onOpenSession(item.sessionId))
      : undefined
  const hasSecondaryActions = Boolean(
    (canRecover && onOpenSession) ||
    canStop ||
    canComplete ||
    (canRecover && onCopyRecoveryCommand)
  )

  return (
    <div className={styles.actions} role="group" aria-label={`Actions for ${item.sessionId}`}>
      {primaryAction && (
        <button
          type="button"
          className={`${styles.actionButton} ${styles.primaryAction}`}
          onClick={() => void primaryAction()}
        >
          {canRecover ? 'Continue in terminal' : 'Open'}
        </button>
      )}
      {hasSecondaryActions && (
        <details className={styles.actionMenu}>
          <summary aria-label={`More actions for ${taskIdentity(item)}`}>•••</summary>
          <div className={styles.actionMenuList}>
            {canRecover && onOpenSession && (
              <button type="button" onClick={() => onOpenSession(item.sessionId)}>Open details</button>
            )}
            {canStop && (
              <button
                type="button"
                className={styles.dangerAction}
                onClick={() => void runAction(() => onStop(item.sessionId), onActionComplete)}
              >
                Stop agent
              </button>
            )}
            {canComplete && (
              <button
                type="button"
                onClick={() => void runAction(() => onComplete(item.sessionId), onActionComplete)}
              >
                Mark finished
              </button>
            )}
            {canRecover && onCopyRecoveryCommand && (
              <button
                type="button"
                onClick={() => void runAction(() => onCopyRecoveryCommand(item.sessionId))}
              >
                Copy recovery command
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  )
}

async function runAction(
  action: () => void | Promise<void>,
  onActionComplete?: () => void | Promise<void>
) {
  try {
    await action()
    await onActionComplete?.()
  } catch (error) {
    console.error('Orchestrator action failed:', error)
  }
}

function formatTask(item: OrchestratorQueueItem): string {
  const title = item.intent.noiseFlags.includes('instructions_heavy')
    ? undefined
    : item.title?.trim()
  return item.intent.task?.trim() || title || 'No task captured'
}

function formatCurrentState(item: OrchestratorQueueItem, task: string): string {
  const currentState = item.intent.currentState?.trim()
  if (currentState && currentState !== task) return currentState
  return (item.context.lastTool ? `Using ${item.context.lastTool}` : '')
    || item.intent.nextAction?.trim()
    || 'No recent activity captured'
}

function taskIdentity(item: OrchestratorQueueItem): string {
  return item.intent.task?.trim() || item.title?.trim() || item.sessionId
}
