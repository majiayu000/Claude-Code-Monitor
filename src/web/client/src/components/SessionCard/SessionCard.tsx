import { useCallback, useEffect, memo } from 'react'
import type { Session, SessionFullData, TerminalApp } from '@/types'
import { Button } from '@/components/Button'
import { ResponsePanel } from '@/components/ResponsePanel'
import { ToolCallList } from '@/components/ToolCallList'
import { UsageStats } from '@/components/UsageStats'
import { SubAgentList } from '@/components/SubAgentList'
import { TerminalSelector } from '@/components/TerminalSelector'
import { formatRelativeTime, formatPath } from '@/utils/format'
import { getStatusColor, STATUS_LABELS } from '@/constants'
import { useToggle } from '@/hooks'
import styles from './SessionCard.module.css'

interface SessionCardProps {
  session: Session
  onRecover?: (sessionId: string, terminalApp?: TerminalApp) => void
  onStop?: (sessionId: string) => void
  onComplete?: (sessionId: string) => void
  // Lazy loading - now uses combined /full endpoint (1 request instead of 3)
  getSessionFull?: (sessionId: string) => SessionFullData | undefined
  loadSessionFull?: (sessionId: string) => Promise<SessionFullData | null>
  isLoadingFull?: (sessionId: string) => boolean
  defaultExpanded?: boolean
}

export const SessionCard = memo(function SessionCard({
  session,
  onRecover,
  onStop,
  onComplete,
  getSessionFull,
  loadSessionFull,
  isLoadingFull,
  defaultExpanded = false,
}: SessionCardProps) {
  const [expanded, toggle] = useToggle(defaultExpanded)

  const statusColor = getStatusColor(session.status)
  const cardId = `session-${session.sessionId}`
  const detailsId = `${cardId}-details`
  const runtimeId = session.runtimeId ?? (session.client === 'codex' ? 'codex' : 'claude-code')
  const runtimeLabel = runtimeId === 'codex' ? 'Codex' : 'Claude Code'

  // Get cached full data or loading state (1 request instead of 3)
  const fullData = getSessionFull?.(session.sessionId)
  const loadingFull = isLoadingFull?.(session.sessionId) ?? false

  // Load full data when expanded - only trigger on expand change
  useEffect(() => {
    if (expanded && loadSessionFull) {
      // loadSessionFull handles caching internally
      loadSessionFull(session.sessionId)
    }
  }, [expanded, session.sessionId, loadSessionFull])

  // Merge session data with lazy-loaded details
  const details = fullData?.details
  const initialPrompt = details?.initialPrompt ?? session.initialPrompt
  const lastMessage = details?.lastMessage ?? session.lastMessage
  const lastTool = details?.lastTool ?? session.lastTool
  const usageStats = details?.usageStats ?? session.usageStats

  // Get tools and subagents from cached full data
  const toolsData = fullData?.tools
  const subAgentsData = fullData?.subAgents

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }, [toggle])

  return (
    <article
      className={styles.card}
      style={{ borderLeftColor: statusColor }}
      aria-labelledby={`${cardId}-title`}
    >
      <div
        className={styles.header}
        onClick={toggle}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={detailsId}
      >
        <div className={styles.statusRow}>
          <span className={styles.status} style={{ color: statusColor }}>
            {STATUS_LABELS[session.status]}
          </span>
          <span className={styles.clientBadge} data-runtime={runtimeId}>
            {runtimeLabel}
          </span>
          <span className={styles.meta}>
            {session.pid ? `PID: ${session.pid}` : 'No process'}
          </span>
        </div>
        <div className={styles.title} id={`${cardId}-title`}>
          {session.title || '(no title)'}
        </div>
        <div className={styles.path}>{formatPath(session.directory)}</div>
        <div className={styles.stats}>
          <span>Tools: {session.toolCount}</span>
          <span>Messages: {session.messageCount}</span>
          {lastTool && <span>Last: {lastTool}</span>}
        </div>
        <div className={styles.statsRow}>
          <div className={styles.lastActive}>
            {formatRelativeTime(session.lastActiveAt)}
          </div>
          {usageStats && usageStats.totalTokens > 0 && (
            <UsageStats stats={usageStats} compact />
          )}
        </div>
        <span className={styles.expandIcon} aria-hidden="true">
          {expanded ? '▼' : '▶'}
        </span>
      </div>

      {expanded && (
        <div className={styles.details} id={detailsId}>
          {loadingFull && (
            <div className={styles.loading}>Loading details...</div>
          )}

          {initialPrompt && (
            <section className={styles.section}>
              <h4 className={styles.sectionTitle}>Initial Prompt</h4>
              <div className={styles.promptBox}>{initialPrompt}</div>
            </section>
          )}

          {session.toolCount > 0 && (
            <section className={styles.section}>
              <h4 className={styles.sectionTitle}>Tool Calls</h4>
              <ToolCallList
                sessionId={session.sessionId}
                toolCount={session.toolCount}
                cachedData={toolsData}
              />
            </section>
          )}

          {lastMessage && (
            <section className={styles.section}>
              <h4 className={styles.sectionTitle}>Last Response</h4>
              <ResponsePanel content={lastMessage} />
            </section>
          )}

          {usageStats && usageStats.totalTokens > 0 && (
            <section className={styles.section}>
              <h4 className={styles.sectionTitle}>Usage Statistics</h4>
              <UsageStats stats={usageStats} />
            </section>
          )}

          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>Sub-Agents</h4>
            <SubAgentList
              sessionId={session.sessionId}
              cachedData={subAgentsData}
            />
          </section>

          <div className={styles.actions} role="group" aria-label="Session actions">
            {session.status === 'lost' && onRecover && (
              <TerminalSelector
                onSelect={(terminal) => onRecover(session.sessionId, terminal)}
              />
            )}
            {(session.status === 'running' || session.status === 'waiting') && onStop && (
              <Button variant="danger" size="sm" onClick={() => onStop(session.sessionId)}>
                Stop
              </Button>
            )}
            {session.status !== 'completed' && onComplete && (
              <Button variant="secondary" size="sm" onClick={() => onComplete(session.sessionId)}>
                Complete
              </Button>
            )}
          </div>
        </div>
      )}
    </article>
  )
})
