import { useCallback, useState, useRef, useEffect, lazy, Suspense } from 'react'
import { ThemeProvider, useTheme, type Theme } from '@/contexts/ThemeContext'
import { ToastProvider, useToast } from '@/components/Toast'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Layout, layoutStyles } from '@/components/Layout'
import { SessionCardSkeleton } from '@/components/Skeleton'
import { HelpModal } from '@/components/HelpModal'
import { AuthSetup } from '@/components/AuthSetup'
import { AuthLogin } from '@/components/AuthLogin'
import type { TabId } from '@/components/TabNav'
import type { ProjectInfo, RuntimeFilter, SessionStatus } from '@/types'
import { useAuth, useSessions, useKeyboardShortcuts, useNotifications, useProjects } from '@/hooks'
import { fetchSession } from '@/services/api'

const SessionList = lazy(() => import('@/components/SessionList').then(m => ({ default: m.SessionList })))
const UsagePanel = lazy(() => import('@/components/UsagePanel').then(m => ({ default: m.UsagePanel })))
const ProjectStatsBar = lazy(() => import('@/components/ProjectStatsBar').then(m => ({ default: m.ProjectStatsBar })))
const ProjectsGrid = lazy(() => import('@/components/ProjectsGrid').then(m => ({ default: m.ProjectsGrid })))
const MemoryPanel = lazy(() => import('@/components/MemoryPanel').then(m => ({ default: m.MemoryPanel })))
const PlansPanel = lazy(() => import('@/components/PlansPanel').then(m => ({ default: m.PlansPanel })))
const WorkItemsPanel = lazy(() => import('@/components/WorkItemsPanel').then(m => ({ default: m.WorkItemsPanel })))
const OrchestratorPanel = lazy(() => import('@/components/OrchestratorPanel').then(m => ({ default: m.OrchestratorPanel })))

const THEME_ORDER: Theme[] = ['cyberpunk', 'matrix', 'synthwave', 'minimal', 'tokyo']

interface DashboardAppProps {
  token: string
  onLogout: () => Promise<void>
}

function DashboardApp({ token, onLogout }: DashboardAppProps) {
  const { showToast } = useToast()
  const { theme, setTheme } = useTheme()
  const [showHelp, setShowHelp] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [selectedProjectRoot, setSelectedProjectRoot] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilters, setStatusFilters] = useState<Set<SessionStatus>>(new Set())
  const [runtimeFilter, setRuntimeFilter] = useState<RuntimeFilter>('all')
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null)

  const {
    sessions,
    allSessions,
    stats,
    loading,
    syncing,
    error,
    refresh,
    sync,
    recoverSession,
    stopSession,
    completeSession,
    getSessionFull,
    loadSessionFull,
    isLoadingFull,
    pagination,
    loadMore,
    loadingMore,
    connectionStatus,
    version: sessionsVersion,
  } = useSessions(
    token,
    activeTab === 'sessions'
      ? { searchQuery, statusFilters, runtimeFilter, projectRoot: selectedProjectRoot ?? undefined }
      : {}
  )

  const filteredSessions = sessions
  const totalSessionCount = allSessions.length > 0 ? allSessions.length : (stats?.total ?? sessions.length)
  const matchedSessionCount = pagination?.total ?? sessions.length
  const hasActiveFilters = searchQuery.trim().length > 0 ||
    statusFilters.size > 0 ||
    runtimeFilter !== 'all' ||
    Boolean(selectedProjectRoot)

  const {
    projects,
    stats: projectStats,
    loading: projectsLoading,
    error: projectsError,
  } = useProjects(token, sessionsVersion)

  const selectedProject = selectedProjectRoot
    ? projects.find(project => project.rootPath === selectedProjectRoot)
    : undefined

  const {
    settings: notificationSettings,
    updateSettings: updateNotificationSettings,
    permission: notificationPermission,
    requestPermission: requestNotificationPermission,
    checkSessionChanges,
  } = useNotifications()

  const prevSessionsRef = useRef<typeof sessions>([])
  useEffect(() => {
    const notificationSessions = allSessions.length > 0 ? allSessions : sessions
    if (notificationSessions.length > 0 && prevSessionsRef.current.length > 0) {
      checkSessionChanges(prevSessionsRef.current, notificationSessions)
    }
    prevSessionsRef.current = notificationSessions
  }, [allSessions, sessions, checkSessionChanges])

  const handleSync = useCallback(async () => {
    const success = await sync()
    showToast(success ? 'Sync completed' : 'Sync failed', success ? 'success' : 'error')
  }, [sync, showToast])

  const handleRecover = useCallback(async (sessionId: string, terminalApp?: import('@/types').TerminalApp) => {
    const result = await recoverSession(sessionId, terminalApp)
    showToast(
      result.success
        ? `Session opened in ${terminalApp || 'terminal'}`
        : result.error || 'Failed to recover session',
      result.success ? 'success' : 'error'
    )
  }, [recoverSession, showToast])

  const handleStop = useCallback(async (sessionId: string) => {
    const success = await stopSession(sessionId)
    showToast(
      success ? 'Session stopped' : 'Failed to stop session',
      success ? 'success' : 'error'
    )
  }, [stopSession, showToast])

  const handleComplete = useCallback(async (sessionId: string) => {
    const success = await completeSession(sessionId)
    showToast(
      success ? 'Session marked as completed' : 'Failed to complete session',
      success ? 'success' : 'error'
    )
  }, [completeSession, showToast])

  const handleSetTheme = useCallback((newTheme: Theme) => {
    setTheme(newTheme)
    showToast(`Theme: ${newTheme}`, 'info')
  }, [setTheme, showToast])

  const handleCycleTheme = useCallback(() => {
    const currentIndex = THEME_ORDER.indexOf(theme)
    const nextIndex = (currentIndex + 1) % THEME_ORDER.length
    const nextTheme = THEME_ORDER[nextIndex]
    setTheme(nextTheme)
    showToast(`Theme: ${nextTheme}`, 'info')
  }, [theme, setTheme, showToast])

  const handleProjectClick = useCallback((project: ProjectInfo) => {
    setSelectedProjectRoot(project.rootPath)
    setSearchQuery('')
    setActiveTab('sessions')
    showToast(`Filtered to: ${project.name}`, 'info')
  }, [showToast])

  const handleClearProjectFilter = useCallback(() => {
    setSelectedProjectRoot(null)
    showToast('Project filter cleared', 'info')
  }, [showToast])

  const handleOpenOrchestratorSession = useCallback((sessionId: string) => {
    setSelectedProjectRoot(null)
    setStatusFilters(new Set())
    setRuntimeFilter('all')
    setSearchQuery(sessionId)
    setExpandedSessionId(sessionId)
    setActiveTab('sessions')
  }, [])

  const handleInitialExpansionConsumed = useCallback(() => {
    setExpandedSessionId(null)
  }, [])

  const handleCopyRecoveryCommand = useCallback(async (sessionId: string) => {
    try {
      const response = await fetchSession(sessionId)
      const command = response.data?.recovery.command
      if (!response.success || !command) {
        showToast(response.error || 'Recovery command is not available', 'error')
        return
      }

      await navigator.clipboard.writeText(command)
      showToast('Recovery command copied', 'success')
    } catch {
      showToast('Failed to copy recovery command', 'error')
    }
  }, [showToast])

  useKeyboardShortcuts({
    onRefresh: refresh,
    onSync: handleSync,
    onShowHelp: () => setShowHelp(true),
    onSetTheme: handleSetTheme,
    onCycleTheme: handleCycleTheme,
  })

  return (
    <Layout
      stats={stats}
      loading={loading}
      onSync={handleSync}
      onLogout={onLogout}
      syncing={syncing}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      statusFilters={statusFilters}
      onFilterChange={setStatusFilters}
      runtimeFilter={runtimeFilter}
      onRuntimeFilterChange={setRuntimeFilter}
      totalCount={totalSessionCount}
      filteredCount={matchedSessionCount}
      sessions={filteredSessions}
      notificationSettings={notificationSettings}
      onUpdateNotificationSettings={updateNotificationSettings}
      notificationPermission={notificationPermission}
      onRequestNotificationPermission={requestNotificationPermission}
      connectionStatus={connectionStatus}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      {loading && <SessionCardSkeleton count={4} />}

      {error && !loading && (
        <div className={layoutStyles.errorBox} role="alert">
          Error: {error}
        </div>
      )}

      <Suspense fallback={<SessionCardSkeleton count={4} />}>
        {activeTab === 'sessions' && !loading && (
          <>
            {selectedProjectRoot && (
              <div className={layoutStyles.projectFilterBar}>
                <span className={layoutStyles.projectFilterText}>
                  Project:
                  <strong>{selectedProject?.name || selectedProjectRoot.split('/').pop() || selectedProjectRoot}</strong>
                  <span className={layoutStyles.projectFilterPath}>
                    {selectedProject?.displayPath || selectedProjectRoot}
                  </span>
                </span>
                <button
                  type="button"
                  className={layoutStyles.projectFilterClear}
                  onClick={handleClearProjectFilter}
                >
                  Clear
                </button>
              </div>
            )}
            <SessionList
              sessions={filteredSessions}
              onRecover={handleRecover}
              onStop={handleStop}
              onComplete={handleComplete}
              getSessionFull={getSessionFull}
              loadSessionFull={loadSessionFull}
              isLoadingFull={isLoadingFull}
              pagination={pagination}
              onLoadMore={loadMore}
              loadingMore={loadingMore}
              hasActiveFilters={hasActiveFilters}
              totalCount={totalSessionCount}
              globalMatchCount={matchedSessionCount}
              initiallyExpandedSessionId={expandedSessionId ?? undefined}
              onInitialExpansionConsumed={handleInitialExpansionConsumed}
            />
          </>
        )}

        {activeTab === 'analytics' && !loading && (
          <UsagePanel />
        )}

        {(activeTab === 'overview' || activeTab === 'orchestrator') && !loading && (
          <OrchestratorPanel
            token={token}
            onOpenSession={handleOpenOrchestratorSession}
            onRecover={handleRecover}
            onStop={handleStop}
            onComplete={handleComplete}
            onCopyRecoveryCommand={handleCopyRecoveryCommand}
          />
        )}

        {activeTab === 'work' && !loading && (
          <WorkItemsPanel token={token} />
        )}

        {activeTab === 'projects' && !loading && (
          <>
            {projectsError && (
              <div className={layoutStyles.errorBox} role="alert">
                Error: {projectsError}
              </div>
            )}
            <ProjectStatsBar stats={projectStats} />
            {projectsLoading ? (
              <SessionCardSkeleton count={4} />
            ) : (
              <ProjectsGrid
                projects={projects}
                onProjectClick={handleProjectClick}
              />
            )}
          </>
        )}

        {activeTab === 'memory' && !loading && (
          <MemoryPanel />
        )}

        {activeTab === 'plans' && !loading && (
          <PlansPanel />
        )}

      </Suspense>

      <HelpModal isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </Layout>
  )
}

function AppContent() {
  const auth = useAuth()
  const token = auth.getToken()

  if (auth.loading || !auth.status) {
    return <SessionCardSkeleton count={4} />
  }

  if (!auth.status.setupComplete) {
    return <AuthSetup onSetup={auth.setup} error={auth.error} />
  }

  if (!auth.status.authenticated || !token) {
    return <AuthLogin onLogin={auth.login} onLocalLogin={auth.localLogin} error={auth.error} />
  }

  return <DashboardApp token={token} onLogout={auth.logout} />
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          <AppContent />
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
