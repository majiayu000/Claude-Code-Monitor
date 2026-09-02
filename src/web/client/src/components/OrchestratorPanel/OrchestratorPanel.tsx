import { memo, useMemo } from 'react'
import { Spinner } from '@/components/Spinner'
import { useOrchestratorOverview } from '@/hooks'
import { formatRelativeTime } from '@/utils/format'
import type { AgentBoardLane, OrchestratorQueueItem } from '@/types'
import { AgentRow } from './AgentRow'
import styles from './OrchestratorPanel.module.css'

interface BoardLaneDefinition {
  id: AgentBoardLane
  label: string
  hint: string
}

const BOARD_LANES: readonly BoardLaneDefinition[] = [
  { id: 'needs_you', label: 'Needs you', hint: 'Input or recovery' },
  { id: 'working', label: 'Working', hint: 'Active agents' },
  { id: 'finished', label: 'Finished', hint: 'Explicitly completed' },
  { id: 'paused', label: 'Paused', hint: 'Alive but quiet' },
]

interface OrchestratorPanelProps {
  token: string
  onOpenSession?: (sessionId: string) => void
  onRecover?: (sessionId: string) => void | Promise<void>
  onStop?: (sessionId: string) => void | Promise<void>
  onComplete?: (sessionId: string) => void | Promise<void>
  onCopyRecoveryCommand?: (sessionId: string) => void | Promise<void>
}

export const OrchestratorPanel = memo(function OrchestratorPanel({
  token,
  onOpenSession,
  onRecover,
  onStop,
  onComplete,
  onCopyRecoveryCommand,
}: OrchestratorPanelProps) {
  const { overview, loading, error, realtime, refresh } = useOrchestratorOverview(token)
  const stats = overview?.stats ?? {
    totalCandidates: 0,
    needingAttention: 0,
    critical: 0,
    warning: 0,
    hiddenOldLost: 0,
  }
  const scopeText = formatScopeText(stats.hiddenOldLost, stats.lostWindowHours)
  const itemsByLane = useMemo(() => groupItemsByLane(overview?.items ?? []), [overview?.items])

  return (
    <section
      className={styles.panel}
      role="tabpanel"
      id="panel-overview"
      aria-labelledby="tab-overview"
    >
      <div className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.eyebrow}>Agent operations</div>
          <div className={styles.titleLine}>
            <h2 className={styles.title}>Board</h2>
            {overview && <span className={styles.liveMark}>{realtime ? 'Live' : 'Snapshot'}</span>}
          </div>
          <div className={styles.meta}>
            {overview
              ? `${overview.items.length} agents · updated ${formatRelativeTime(overview.generatedAt)}${scopeText}`
              : 'Waiting for overview'}
          </div>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh agent overview"
        >
          <span aria-hidden="true">↻</span>
          <span>Refresh</span>
        </button>
      </div>

      {error && <div className={styles.error} role="alert">{error}</div>}

      {loading && !overview ? (
        <div className={styles.loading}>
          <Spinner size="sm" />
          <span>Loading agents...</span>
        </div>
      ) : overview && overview.items.length === 0 ? (
        <div className={styles.emptyState}>No agent sessions found</div>
      ) : overview ? (
        <div className={styles.board} aria-label="Agent operations board">
          {BOARD_LANES.map((lane) => {
            const items = itemsByLane.get(lane.id) ?? []
            return (
              <section
                key={lane.id}
                className={styles.lane}
                data-lane={lane.id}
                aria-labelledby={`agent-lane-${lane.id}`}
              >
                <div className={styles.laneHeader}>
                  <span className={styles.laneDot} aria-hidden="true" />
                  <div className={styles.laneTitleGroup}>
                    <h3 id={`agent-lane-${lane.id}`}>{lane.label}</h3>
                    <span>{lane.hint}</span>
                  </div>
                  <span className={styles.laneCount}>{items.length}</span>
                </div>
                <div className={styles.laneBody} role="list">
                  {items.length === 0 ? (
                    <div className={styles.laneEmpty}>Clear</div>
                  ) : items.map((item) => (
                    <AgentRow
                      key={item.sessionId}
                      item={item}
                      onOpenSession={onOpenSession}
                      onRecover={onRecover}
                      onStop={onStop}
                      onComplete={onComplete}
                      onCopyRecoveryCommand={onCopyRecoveryCommand}
                      onActionComplete={refresh}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      ) : null}
    </section>
  )
})

function groupItemsByLane(items: OrchestratorQueueItem[]): Map<AgentBoardLane, OrchestratorQueueItem[]> {
  const grouped = new Map<AgentBoardLane, OrchestratorQueueItem[]>()
  for (const item of items) {
    const laneItems = grouped.get(item.lane) ?? []
    laneItems.push(item)
    grouped.set(item.lane, laneItems)
  }
  return grouped
}

function formatScopeText(hiddenOldLost: number, lostWindowHours?: number): string {
  if (hiddenOldLost === 0 || lostWindowHours == null) return ''
  return ` · ${hiddenOldLost} older lost in Sessions`
}
