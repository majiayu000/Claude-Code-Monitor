import type { Session } from '../types/session'

export interface NotificationEventSettings {
  onStatusChange: boolean
  onSessionLost: boolean
  onHighCost: boolean
  costThreshold: number
}

export interface SessionNotificationOptions {
  body?: string
  tag?: string
}

export interface SessionNotificationEvent {
  title: string
  options: SessionNotificationOptions
}

export function getSessionNotificationEvents(
  prevSessions: Session[],
  newSessions: Session[],
  settings: NotificationEventSettings
): SessionNotificationEvent[] {
  const events: SessionNotificationEvent[] = []
  const prevMap = new Map(prevSessions.map((s) => [s.sessionId, s]))

  for (const session of newSessions) {
    const prev = prevMap.get(session.sessionId)
    if (!prev) continue

    if (settings.onStatusChange && prev.status !== session.status) {
      if (settings.onSessionLost && session.status === 'lost') {
        events.push({
          title: 'Session Interrupted',
          options: {
            body: `Session "${session.title || session.sessionId}" was interrupted and may be recoverable`,
            tag: `session-lost-${session.sessionId}`,
          },
        })
      } else if (session.status === 'completed' && prev.status !== 'completed') {
        events.push({
          title: 'Session Completed',
          options: {
            body: `Session "${session.title || session.sessionId}" has completed`,
            tag: `session-completed-${session.sessionId}`,
          },
        })
      }
    }

    if (settings.onHighCost && session.usageStats) {
      const prevCost = prev.usageStats?.totalCost || 0
      const newCost = session.usageStats.totalCost || 0

      if (prevCost < settings.costThreshold && newCost >= settings.costThreshold) {
        events.push({
          title: 'High Cost Warning',
          options: {
            body: `Session "${session.title || session.sessionId}" has exceeded $${settings.costThreshold.toFixed(2)} (current: $${newCost.toFixed(2)})`,
            tag: `high-cost-${session.sessionId}`,
          },
        })
      }
    }
  }

  return events
}
