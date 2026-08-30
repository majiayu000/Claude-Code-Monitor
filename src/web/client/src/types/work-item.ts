export type WorkItemStatus = 'inbox' | 'planned' | 'active' | 'blocked' | 'done' | 'archived'
export type WorkItemKind = 'todo' | 'idea' | 'note' | 'project_task'
export type WorkItemStatusSource = 'user' | 'accepted_agent_suggestion'
export type WorkboardBucketId = 'now' | 'waiting' | 'stale' | 'done'

export interface WorkItem {
  id: string
  kind: WorkItemKind
  status: WorkItemStatus
  title: string
  body?: string
  projectRoot?: string
  areaId?: string
  area?: string
  statusSource: WorkItemStatusSource
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface WorkItemOverviewStats {
  total: number
  inbox: number
  planned: number
  active: number
  blocked: number
  done: number
  archived: number
  todo: number
  idea: number
  note: number
  projectTask: number
}

export interface WorkItemsData {
  items: WorkItem[]
  stats: WorkItemOverviewStats
  workboard: WorkboardData
}

export interface WorkboardAgentSessionSummary {
  id: string
  runtimeId: string
  title: string
  status: string
  lastActiveAt: string
}

export interface WorkboardSuggestion {
  linkId: string
  agentSession: WorkboardAgentSessionSummary
  suggestedAt: string
}

export interface WorkboardItemProjection {
  item: WorkItem
  bucket?: WorkboardBucketId
  progressSummary?: string
  lastActivityAt?: string
  waitingOnSession?: WorkboardAgentSessionSummary
  acceptedSessions: WorkboardAgentSessionSummary[]
  suggestions: WorkboardSuggestion[]
  completionSuggestion?: {
    evidenceId: string
    summary: string
    occurredAt: string
  }
}

export interface WorkboardData {
  now: WorkboardItemProjection[]
  waiting: WorkboardItemProjection[]
  stale: WorkboardItemProjection[]
  done: WorkboardItemProjection[]
  suggestions: WorkboardItemProjection[]
  staleWindowHours: number
  generatedAt: string
}

export interface WorkItemCreateInput {
  title: string
  kind?: WorkItemKind
  status?: WorkItemStatus
  body?: string
  projectRoot?: string
  area?: string
  statusSource?: WorkItemStatusSource
}

export interface WorkItemUpdateInput {
  title?: string
  kind?: WorkItemKind
  status?: WorkItemStatus
  body?: string | null
  projectRoot?: string | null
  area?: string | null
  statusSource?: WorkItemStatusSource
}
