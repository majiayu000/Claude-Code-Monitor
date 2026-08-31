import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/services/api'
import type {
  WorkItem,
  WorkItemCreateInput,
  WorkItemOverviewStats,
  WorkItemUpdateInput,
  WorkboardData,
} from '@/types'

const EMPTY_STATS: WorkItemOverviewStats = {
  total: 0,
  inbox: 0,
  planned: 0,
  active: 0,
  blocked: 0,
  done: 0,
  archived: 0,
  todo: 0,
  idea: 0,
  note: 0,
  projectTask: 0,
}

const EMPTY_WORKBOARD: WorkboardData = {
  now: [],
  waiting: [],
  stale: [],
  done: [],
  suggestions: [],
  staleWindowHours: 72,
  generatedAt: new Date(0).toISOString(),
}

export interface UseWorkItemsReturn {
  items: WorkItem[]
  stats: WorkItemOverviewStats
  workboard: WorkboardData
  loading: boolean
  saving: boolean
  error: string | null
  refresh: () => Promise<void>
  createItem: (input: WorkItemCreateInput) => Promise<WorkItem | null>
  updateItem: (id: string, input: WorkItemUpdateInput) => Promise<WorkItem | null>
  deleteItem: (id: string) => Promise<boolean>
  reviewCompletion: (id: string, evidenceId: string, decision: 'accepted' | 'rejected') => Promise<boolean>
  reviewSessionLink: (linkId: string, decision: 'accept' | 'reject') => Promise<boolean>
}

export function useWorkItems(_token: string): UseWorkItemsReturn {
  const [items, setItems] = useState<WorkItem[]>([])
  const [stats, setStats] = useState<WorkItemOverviewStats>(EMPTY_STATS)
  const [workboard, setWorkboard] = useState<WorkboardData>(EMPTY_WORKBOARD)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    const response = await api.fetchWorkItems()
    if (!mountedRef.current) return
    if (response.success && response.data) {
      setItems(response.data.items)
      setStats(response.data.stats)
      setWorkboard(response.data.workboard ?? EMPTY_WORKBOARD)
      setError(null)
    } else {
      setError(response.error || 'Failed to load work items')
    }
    setLoading(false)
  }, [])

  const createItem = useCallback(async (input: WorkItemCreateInput): Promise<WorkItem | null> => {
    setSaving(true)
    const response = await api.createWorkItem(input)
    setSaving(false)
    if (response.success && response.data) {
      await refresh()
      return response.data.item
    }
    setError(response.error || 'Failed to create work item')
    return null
  }, [refresh])

  const updateItem = useCallback(async (
    id: string,
    input: WorkItemUpdateInput
  ): Promise<WorkItem | null> => {
    setSaving(true)
    const response = await api.updateWorkItem(id, input)
    setSaving(false)
    if (response.success && response.data) {
      await refresh()
      return response.data.item
    }
    setError(response.error || 'Failed to update work item')
    return null
  }, [refresh])

  const deleteItem = useCallback(async (id: string): Promise<boolean> => {
    setSaving(true)
    const response = await api.deleteWorkItem(id)
    setSaving(false)
    if (response.success) {
      await refresh()
      return true
    }
    setError(response.error || 'Failed to delete work item')
    return false
  }, [refresh])

  const reviewCompletion = useCallback(async (
    id: string,
    evidenceId: string,
    decision: 'accepted' | 'rejected'
  ): Promise<boolean> => {
    setSaving(true)
    const response = await api.reviewWorkItemCompletion(id, evidenceId, decision)
    setSaving(false)
    if (response.success) {
      await refresh()
      return true
    }
    setError(response.error || 'Failed to review completion')
    return false
  }, [refresh])

  const reviewSessionLink = useCallback(async (
    linkId: string,
    decision: 'accept' | 'reject'
  ): Promise<boolean> => {
    setSaving(true)
    const response = await api.reviewWorkItemSessionLink(linkId, decision)
    setSaving(false)
    if (response.success) {
      await refresh()
      return true
    }
    setError(response.error || 'Failed to review session link')
    return false
  }, [refresh])

  useEffect(() => {
    mountedRef.current = true
    refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  return {
    items,
    stats,
    workboard,
    loading,
    saving,
    error,
    refresh,
    createItem,
    updateItem,
    deleteItem,
    reviewCompletion,
    reviewSessionLink,
  }
}
