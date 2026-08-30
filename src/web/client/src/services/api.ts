/**
 * API service - typed fetch wrappers for backend endpoints
 */

import type {
  ApiResponse,
  SessionsData,
  ProjectsData,
  SyncResult,
  SessionDetailData,
  SessionDetailsData,
  SessionFullData,
  RecoverBody,
  RecoverResponseData,
  StopBody,
  ProcessStatusData,
  ToolCallsData,
  SubAgentsData,
  UsageData,
  QuotaData,
  ClientsData,
  CodexQuotaData,
  SessionMemory,
  MemorySummary,
  MemoryContext,
  Plan,
  PlanSummary,
  PlanAggregateStats,
  AuthStatus,
  LoginRequest,
  LoginResponse,
  SetupRequest,
  SetupResponse,
  AgentClient,
  RuntimeFilter,
  SessionStatus,
  WorkItem,
  WorkItemCreateInput,
  WorkItemsData,
  WorkItemUpdateInput,
  OrchestratorOverviewData,
} from '@/types'
import { API_BASE, API_TIMEOUT_MS } from '@/constants'

interface RequestOptions extends RequestInit {
  timeout?: number
}

async function request<T>(
  endpoint: string,
  options?: RequestOptions,
  signal?: AbortSignal
): Promise<ApiResponse<T>> {
  const { timeout = API_TIMEOUT_MS, ...fetchOptions } = options || {}

  // Create timeout controller if no external signal provided
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), timeout)

  // Combine external signal with timeout
  const combinedSignal = signal
    ? combineAbortSignals(signal, timeoutController.signal)
    : timeoutController.signal

  try {
    const headers = new Headers(fetchOptions.headers)
    const token = typeof window !== 'undefined'
      ? localStorage.getItem('terminal_token')
      : null

    if (!(fetchOptions.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`)
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...fetchOptions,
      signal: combinedSignal,
      headers,
    })
    clearTimeout(timeoutId)
    return await response.json()
  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: signal?.aborted ? 'Request cancelled' : 'Request timeout',
        }
      }
      return { success: false, error: error.message }
    }
    return { success: false, error: 'Unknown error' }
  }
}

/** Combine multiple abort signals into one */
function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

/**
 * GET /api/sessions - Fetch sessions with stats
 * @param fields - 'basic' for list view (faster), 'full' for all fields
 * @param options - Pagination and filtering options
 */
export async function fetchSessions(
  fields: 'basic' | 'full' = 'basic',
  options?: {
    limit?: number
    offset?: number
    skipSync?: boolean
    query?: string
    status?: SessionStatus[]
    client?: AgentClient
    runtime?: RuntimeFilter
    projectRoot?: string
    projectId?: string
  },
  signal?: AbortSignal
): Promise<ApiResponse<SessionsData>> {
  const params = new URLSearchParams({ fields })
  if (options?.limit) params.set('limit', String(options.limit))
  if (options?.offset) params.set('offset', String(options.offset))
  if (options?.skipSync) params.set('skipSync', 'true')
  if (options?.query?.trim()) params.set('q', options.query.trim())
  if (options?.client) params.set('client', options.client)
  if (options?.runtime && options.runtime !== 'all') params.set('runtime', options.runtime)
  for (const status of options?.status ?? []) {
    params.append('status', status)
  }
  if (options?.projectRoot) params.set('projectRoot', options.projectRoot)
  if (options?.projectId) params.set('projectId', options.projectId)
  return request<SessionsData>(`/sessions?${params}`, undefined, signal)
}

/**
 * GET /api/projects - Fetch project summaries with stats
 */
export async function fetchProjects(
  fields: 'basic' | 'full' = 'basic',
  signal?: AbortSignal
): Promise<ApiResponse<ProjectsData>> {
  const params = new URLSearchParams({ fields })
  return request<ProjectsData>(`/projects?${params}`, undefined, signal)
}

/**
 * POST /api/sessions/sync - Sync sessions with filesystem
 */
export async function syncSessions(signal?: AbortSignal): Promise<ApiResponse<SyncResult>> {
  return request<SyncResult>('/sessions/sync', { method: 'POST' }, signal)
}

/**
 * GET /api/sessions/:id - Get single session details
 */
export async function fetchSession(
  sessionId: string,
  signal?: AbortSignal
): Promise<ApiResponse<SessionDetailData>> {
  return request<SessionDetailData>(`/sessions/${sessionId}`, undefined, signal)
}

/**
 * POST /api/sessions/:id/recover - Recover a lost session
 */
export async function recoverSession(
  sessionId: string,
  body: RecoverBody,
  signal?: AbortSignal
): Promise<ApiResponse<RecoverResponseData>> {
  return request<RecoverResponseData>(`/sessions/${sessionId}/recover`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, signal)
}

/**
 * POST /api/sessions/:id/complete - Mark session as completed
 */
export async function completeSession(
  sessionId: string,
  signal?: AbortSignal
): Promise<ApiResponse> {
  return request(`/sessions/${sessionId}/complete`, { method: 'POST' }, signal)
}

/**
 * POST /api/sessions/:id/stop - Stop session process
 */
export async function stopSession(
  sessionId: string,
  body: StopBody = {},
  signal?: AbortSignal
): Promise<ApiResponse> {
  return request(`/sessions/${sessionId}/stop`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, signal)
}

/**
 * GET /api/sessions/:id/process - Get process status
 */
export async function fetchProcessStatus(
  sessionId: string,
  signal?: AbortSignal
): Promise<ApiResponse<ProcessStatusData>> {
  return request<ProcessStatusData>(`/sessions/${sessionId}/process`, undefined, signal)
}

/**
 * GET /api/sessions/:id/tools - Get tool calls for a session
 */
export async function fetchToolCalls(
  sessionId: string,
  signal?: AbortSignal
): Promise<ApiResponse<ToolCallsData>> {
  return request<ToolCallsData>(`/sessions/${sessionId}/tools`, undefined, signal)
}

/**
 * GET /api/sessions/:id/details - Get lazy loaded session details
 */
export async function fetchSessionDetails(
  sessionId: string,
  signal?: AbortSignal
): Promise<ApiResponse<SessionDetailsData>> {
  return request<SessionDetailsData>(`/sessions/${sessionId}/details`, undefined, signal)
}

/**
 * GET /api/sessions/:id/subagents - Get sub-agents for a session
 */
export async function fetchSubAgents(
  sessionId: string,
  signal?: AbortSignal
): Promise<ApiResponse<SubAgentsData>> {
  return request<SubAgentsData>(`/sessions/${sessionId}/subagents`, undefined, signal)
}

/**
 * GET /api/sessions/:id/full - Get full session data (details + tools + subagents)
 * This combines 3 requests into 1 for better performance
 */
export async function fetchSessionFull(
  sessionId: string,
  signal?: AbortSignal
): Promise<ApiResponse<SessionFullData>> {
  return request<SessionFullData>(`/sessions/${sessionId}/full`, undefined, signal)
}

/**
 * GET /api/usage - Get usage analytics from ccusage
 * @param type - daily, monthly, weekly, session
 * @param since - YYYYMMDD format
 * @param until - YYYYMMDD format
 */
export async function fetchUsage(
  type: 'daily' | 'monthly' | 'weekly' | 'session' = 'daily',
  options?: {
    since?: string
    until?: string
  },
  signal?: AbortSignal
): Promise<ApiResponse<UsageData>> {
  const params = new URLSearchParams({ type })
  if (options?.since) params.set('since', options.since)
  if (options?.until) params.set('until', options.until)
  return request<UsageData>(`/usage?${params}`, undefined, signal)
}

/**
 * GET /api/quota - Get Claude Code rate limit quota
 */
export async function fetchQuota(
  signal?: AbortSignal
): Promise<ApiResponse<QuotaData>> {
  return request<QuotaData>('/quota', undefined, signal)
}

/**
 * GET /api/codex/quota - Codex CLI rate limit quota
 */
export async function fetchCodexQuota(
  signal?: AbortSignal
): Promise<ApiResponse<CodexQuotaData>> {
  return request<CodexQuotaData>('/codex/quota', undefined, signal)
}

/**
 * GET /api/clients - Load optional client definitions for multi-client quota display
 */
export async function fetchClients(
  signal?: AbortSignal
): Promise<ApiResponse<ClientsData>> {
  return request<ClientsData>('/clients', undefined, signal)
}

// ═══════════════════════════════════════════════════════════════
// WORK ITEMS API - Inbox/Todo/Idea capture
// ═══════════════════════════════════════════════════════════════

export async function fetchWorkItems(
  signal?: AbortSignal
): Promise<ApiResponse<WorkItemsData>> {
  return request<WorkItemsData>('/work-items', undefined, signal)
}

export async function fetchOrchestratorOverview(
  signal?: AbortSignal
): Promise<ApiResponse<OrchestratorOverviewData>> {
  return request<OrchestratorOverviewData>('/orchestrator/overview', undefined, signal)
}

export async function createWorkItem(
  data: WorkItemCreateInput,
  signal?: AbortSignal
): Promise<ApiResponse<{ item: WorkItem }>> {
  return request<{ item: WorkItem }>('/work-items', {
    method: 'POST',
    body: JSON.stringify(data),
  }, signal)
}

export async function updateWorkItem(
  id: string,
  data: WorkItemUpdateInput,
  signal?: AbortSignal
): Promise<ApiResponse<{ item: WorkItem }>> {
  return request<{ item: WorkItem }>(`/work-items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  }, signal)
}

export async function deleteWorkItem(
  id: string,
  signal?: AbortSignal
): Promise<ApiResponse> {
  return request(`/work-items/${id}`, { method: 'DELETE' }, signal)
}

export async function reviewWorkItemCompletion(
  id: string,
  evidenceId: string,
  decision: 'accepted' | 'rejected',
  signal?: AbortSignal
): Promise<ApiResponse<{ item: WorkItem }>> {
  return request<{ item: WorkItem }>(`/work-items/${id}/completion-review`, {
    method: 'POST',
    body: JSON.stringify({ evidenceId, decision }),
  }, signal)
}

export async function reviewWorkItemSessionLink(
  linkId: string,
  decision: 'accept' | 'reject',
  signal?: AbortSignal
): Promise<ApiResponse> {
  return request(`/work-items/session-links/${linkId}/${decision}`, { method: 'POST' }, signal)
}

// ═══════════════════════════════════════════════════════════════
// MEMORY API - Session context persistence
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/memory - List all session memories
 */
export async function fetchMemories(
  options?: {
    limit?: number
    directory?: string
  },
  signal?: AbortSignal
): Promise<ApiResponse<SessionMemory[]>> {
  const params = new URLSearchParams()
  if (options?.limit) params.set('limit', String(options.limit))
  if (options?.directory) params.set('directory', options.directory)
  const queryString = params.toString()
  return request<SessionMemory[]>(`/memory${queryString ? `?${queryString}` : ''}`, undefined, signal)
}

/**
 * GET /api/memory/summaries - Get memory summaries
 */
export async function fetchMemorySummaries(
  signal?: AbortSignal
): Promise<ApiResponse<MemorySummary[]>> {
  return request<MemorySummary[]>('/memory/summaries', undefined, signal)
}

/**
 * GET /api/memory/:sessionId - Get memory for a specific session
 */
export async function fetchMemory(
  sessionId: string,
  signal?: AbortSignal
): Promise<ApiResponse<SessionMemory>> {
  return request<SessionMemory>(`/memory/${sessionId}`, undefined, signal)
}

/**
 * GET /api/memory/:sessionId/context - Get recovery context for a session
 */
export async function fetchMemoryContext(
  sessionId: string,
  minimal?: boolean,
  signal?: AbortSignal
): Promise<ApiResponse<MemoryContext>> {
  const params = minimal ? '?minimal=true' : ''
  return request<MemoryContext>(`/memory/${sessionId}/context${params}`, undefined, signal)
}

/**
 * DELETE /api/memory/:sessionId - Delete memory
 */
export async function deleteMemory(
  sessionId: string,
  signal?: AbortSignal
): Promise<ApiResponse> {
  return request(`/memory/${sessionId}`, { method: 'DELETE' }, signal)
}

// ═══════════════════════════════════════════════════════════════
// PLANS API - Claude Code plan files
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/plans - List all plans
 */
export async function fetchPlans(
  signal?: AbortSignal
): Promise<ApiResponse<Plan[]>> {
  return request<Plan[]>('/plans', undefined, signal)
}

/**
 * GET /api/plans/summaries - Get plan summaries
 */
export async function fetchPlanSummaries(
  signal?: AbortSignal
): Promise<ApiResponse<PlanSummary[]>> {
  return request<PlanSummary[]>('/plans/summaries', undefined, signal)
}

/**
 * GET /api/plans/stats - Get aggregate stats
 */
export async function fetchPlanStats(
  signal?: AbortSignal
): Promise<ApiResponse<PlanAggregateStats>> {
  return request<PlanAggregateStats>('/plans/stats', undefined, signal)
}

/**
 * GET /api/plans/:id - Get a specific plan with full content
 */
export async function fetchPlan(
  id: string,
  signal?: AbortSignal
): Promise<ApiResponse<Plan>> {
  return request<Plan>(`/plans/${id}`, undefined, signal)
}

// ═══════════════════════════════════════════════════════════════
// AUTH API - Terminal authentication
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/auth/status - Check auth status
 */
export async function fetchAuthStatus(
  signal?: AbortSignal
): Promise<ApiResponse<AuthStatus>> {
  const token = localStorage.getItem('terminal_token')
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  return request<AuthStatus>('/auth/status', { headers }, signal)
}

/**
 * POST /api/auth/setup - First-run setup
 */
export async function setupAuth(
  data: SetupRequest,
  signal?: AbortSignal
): Promise<ApiResponse<SetupResponse>> {
  return request<SetupResponse>('/auth/setup', {
    method: 'POST',
    body: JSON.stringify(data),
  }, signal)
}

/**
 * POST /api/auth/login - Login
 */
export async function loginAuth(
  data: LoginRequest,
  signal?: AbortSignal
): Promise<ApiResponse<LoginResponse>> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(data),
  }, signal)
}

/**
 * POST /api/auth/local - Localhost passwordless login
 */
export async function localLoginAuth(
  signal?: AbortSignal
): Promise<ApiResponse<LoginResponse>> {
  return request<LoginResponse>('/auth/local', {
    method: 'POST',
  }, signal)
}

/**
 * POST /api/auth/logout - Logout
 */
export async function logoutAuth(
  signal?: AbortSignal
): Promise<ApiResponse> {
  const token = localStorage.getItem('terminal_token')
  return request('/auth/logout', {
    method: 'POST',
    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
  }, signal)
}

// Export all API functions
export const api = {
  fetchSessions,
  fetchProjects,
  syncSessions,
  fetchSession,
  recoverSession,
  completeSession,
  stopSession,
  fetchProcessStatus,
  fetchToolCalls,
  fetchSessionDetails,
  fetchSubAgents,
  fetchSessionFull,
  fetchUsage,
  fetchQuota,
  fetchClients,
  fetchCodexQuota,
  fetchOrchestratorOverview,
  fetchWorkItems,
  createWorkItem,
  updateWorkItem,
  deleteWorkItem,
  reviewWorkItemCompletion,
  reviewWorkItemSessionLink,
  // Memory API
  fetchMemories,
  fetchMemorySummaries,
  fetchMemory,
  fetchMemoryContext,
  deleteMemory,
  // Plans API
  fetchPlans,
  fetchPlanSummaries,
  fetchPlanStats,
  fetchPlan,
  // Auth API
  fetchAuthStatus,
  setupAuth,
  loginAuth,
  logoutAuth,
}
