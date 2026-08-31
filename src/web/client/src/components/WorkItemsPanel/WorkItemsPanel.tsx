import { FormEvent, useMemo, useState } from 'react'
import { Button } from '@/components/Button'
import { useWorkItems } from '@/hooks'
import type {
  WorkItem,
  WorkItemKind,
  WorkItemStatus,
  WorkboardData,
  WorkboardItemProjection,
} from '@/types'
import styles from './WorkItemsPanel.module.css'

type WorkItemsView = 'workboard' | 'overview' | 'todo' | 'inbox'

const VIEW_LABELS: Array<{ id: WorkItemsView; label: string }> = [
  { id: 'workboard', label: 'Workboard' },
  { id: 'overview', label: 'Overview' },
  { id: 'todo', label: 'Todo' },
  { id: 'inbox', label: 'Inbox' },
]

const STATUS_LABELS: Record<WorkItemStatus, string> = {
  inbox: 'Inbox',
  planned: 'Planned',
  active: 'Active',
  blocked: 'Blocked',
  done: 'Done',
  archived: 'Archived',
}

const KIND_LABELS: Record<WorkItemKind, string> = {
  todo: 'Todo',
  idea: 'Idea',
  note: 'Note',
  project_task: 'Project',
}

interface WorkItemsPanelProps {
  token: string
}

export function WorkItemsPanel({ token }: WorkItemsPanelProps) {
  const {
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
  } = useWorkItems(token)
  const [view, setView] = useState<WorkItemsView>('workboard')
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<WorkItemKind>('todo')
  const [status, setStatus] = useState<WorkItemStatus>('inbox')
  const [area, setArea] = useState('')
  const [projectRoot, setProjectRoot] = useState('')
  const [body, setBody] = useState('')

  const visibleItems = useMemo(() => {
    if (view === 'inbox') return items.filter((item) => item.status === 'inbox')
    if (view === 'todo') {
      return items.filter((item) => item.kind === 'todo' && item.status !== 'archived')
    }
    return items.filter((item) => item.status !== 'archived')
  }, [items, view])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title.trim()) return
    const created = await createItem({
      title: title.trim(),
      kind,
      status,
      area: area.trim() || undefined,
      projectRoot: projectRoot.trim() || undefined,
      body: body.trim() || undefined,
      statusSource: 'user',
    })
    if (created) {
      setTitle('')
      setArea('')
      setProjectRoot('')
      setBody('')
      setStatus('inbox')
      setKind('todo')
    }
  }

  const setItemStatus = (item: WorkItem, nextStatus: WorkItemStatus) => {
    updateItem(item.id, { status: nextStatus, statusSource: 'user' })
  }

  if (loading) {
    return (
      <div className={styles.panel}>
        <div className={styles.loading}>Loading work items...</div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.statsBar}>
        <Stat label="Inbox" value={stats.inbox} tone="inbox" />
        <Stat label="Planned" value={stats.planned} tone="planned" />
        <Stat label="Active" value={stats.active} tone="active" />
        <Stat label="Blocked" value={stats.blocked} tone="blocked" />
        <Stat label="Done" value={stats.done} tone="done" />
      </div>

      <div className={styles.toolbar}>
        <div className={styles.segmented} role="tablist" aria-label="Work item views">
          {VIEW_LABELS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`${styles.segmentButton} ${view === tab.id ? styles.activeSegment : ''}`}
              onClick={() => setView(tab.id)}
              role="tab"
              aria-selected={view === tab.id}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={refresh}
          title="Refresh"
          aria-label="Refresh"
        >
          @
        </button>
      </div>

      {error && <div className={styles.error} role="alert">{error}</div>}

      <form className={styles.captureForm} onSubmit={handleSubmit}>
        <input
          className={styles.titleInput}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Capture work item"
          maxLength={200}
        />
        <select
          className={styles.select}
          value={kind}
          onChange={(event) => setKind(event.target.value as WorkItemKind)}
        >
          <option value="todo">Todo</option>
          <option value="idea">Idea</option>
          <option value="note">Note</option>
          <option value="project_task">Project</option>
        </select>
        <select
          className={styles.select}
          value={status}
          onChange={(event) => setStatus(event.target.value as WorkItemStatus)}
        >
          <option value="inbox">Inbox</option>
          <option value="planned">Planned</option>
          <option value="active">Active</option>
          <option value="blocked">Blocked</option>
        </select>
        <input
          className={styles.compactInput}
          value={area}
          onChange={(event) => setArea(event.target.value)}
          placeholder="Area"
          maxLength={120}
        />
        <input
          className={styles.projectInput}
          value={projectRoot}
          onChange={(event) => setProjectRoot(event.target.value)}
          placeholder="Project root"
          maxLength={2048}
        />
        <textarea
          className={styles.bodyInput}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Notes"
          rows={2}
          maxLength={10000}
        />
        <Button type="submit" size="sm" loading={saving} disabled={!title.trim()}>
          Add
        </Button>
      </form>

      {view === 'workboard' ? (
        <WorkboardView
          workboard={workboard}
          setItemStatus={setItemStatus}
          deleteItem={deleteItem}
          reviewCompletion={reviewCompletion}
          reviewSessionLink={reviewSessionLink}
        />
      ) : visibleItems.length === 0 ? (
        <div className={styles.emptyState}>No work items</div>
      ) : (
        <div className={styles.itemList}>
          {visibleItems.map((item) => (
            <WorkItemCard
              key={item.id}
              item={item}
              setItemStatus={setItemStatus}
              deleteItem={deleteItem}
              reviewCompletion={reviewCompletion}
              reviewSessionLink={reviewSessionLink}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function WorkboardView({
  workboard,
  setItemStatus,
  deleteItem,
  reviewCompletion,
  reviewSessionLink,
}: {
  workboard: WorkboardData;
  setItemStatus: (item: WorkItem, nextStatus: WorkItemStatus) => void;
  deleteItem: (id: string) => void;
  reviewCompletion: (id: string, evidenceId: string, decision: 'accepted' | 'rejected') => void;
  reviewSessionLink: (linkId: string, decision: 'accept' | 'reject') => void;
}) {
  return (
    <div className={styles.workboard}>
      <WorkboardSection
        title="Now"
        items={workboard.now}
        setItemStatus={setItemStatus}
        deleteItem={deleteItem}
        reviewCompletion={reviewCompletion}
        reviewSessionLink={reviewSessionLink}
      />
      <WorkboardSection
        title="Waiting"
        items={workboard.waiting}
        setItemStatus={setItemStatus}
        deleteItem={deleteItem}
        reviewCompletion={reviewCompletion}
        reviewSessionLink={reviewSessionLink}
      />
      <WorkboardSection
        title="Stale"
        items={workboard.stale}
        setItemStatus={setItemStatus}
        deleteItem={deleteItem}
        reviewCompletion={reviewCompletion}
        reviewSessionLink={reviewSessionLink}
      />
      <WorkboardSection
        title="Done"
        items={workboard.done}
        setItemStatus={setItemStatus}
        deleteItem={deleteItem}
        reviewCompletion={reviewCompletion}
        reviewSessionLink={reviewSessionLink}
      />
      {workboard.suggestions.length > 0 && (
        <section className={styles.suggestionSection}>
          <div className={styles.sectionHeader}>
            <h3>Suggestions</h3>
            <span>{workboard.suggestions.length}</span>
          </div>
          <div className={styles.itemList}>
            {workboard.suggestions.map((projection) => (
              <WorkItemCard
                key={projection.item.id}
                item={projection.item}
                projection={projection}
                setItemStatus={setItemStatus}
                deleteItem={deleteItem}
                reviewCompletion={reviewCompletion}
                reviewSessionLink={reviewSessionLink}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function WorkboardSection({
  title,
  items,
  setItemStatus,
  deleteItem,
  reviewCompletion,
  reviewSessionLink,
}: {
  title: string;
  items: WorkboardItemProjection[];
  setItemStatus: (item: WorkItem, nextStatus: WorkItemStatus) => void;
  deleteItem: (id: string) => void;
  reviewCompletion: (id: string, evidenceId: string, decision: 'accepted' | 'rejected') => void;
  reviewSessionLink: (linkId: string, decision: 'accept' | 'reject') => void;
}) {
  return (
    <section className={styles.boardSection}>
      <div className={styles.sectionHeader}>
        <h3>{title}</h3>
        <span>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className={styles.boardEmpty}>No items</div>
      ) : (
        <div className={styles.boardItems}>
          {items.map((projection) => (
            <WorkItemCard
              key={projection.item.id}
              item={projection.item}
              projection={projection}
              setItemStatus={setItemStatus}
              deleteItem={deleteItem}
              reviewCompletion={reviewCompletion}
              reviewSessionLink={reviewSessionLink}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function WorkItemCard({
  item,
  projection,
  setItemStatus,
  deleteItem,
  reviewCompletion,
  reviewSessionLink,
}: {
  item: WorkItem;
  projection?: WorkboardItemProjection;
  setItemStatus: (item: WorkItem, nextStatus: WorkItemStatus) => void;
  deleteItem: (id: string) => void;
  reviewCompletion: (id: string, evidenceId: string, decision: 'accepted' | 'rejected') => void;
  reviewSessionLink: (linkId: string, decision: 'accept' | 'reject') => void;
}) {
  return (
    <article className={styles.itemCard}>
      <div className={styles.itemMain}>
        <div className={styles.itemHeader}>
          <h3 className={styles.itemTitle}>{item.title}</h3>
          <div className={styles.badges}>
            <span className={`${styles.badge} ${styles[item.status]}`}>
              {STATUS_LABELS[item.status]}
            </span>
            <span className={styles.badge}>{KIND_LABELS[item.kind]}</span>
            {projection?.bucket && (
              <span className={`${styles.badge} ${styles.bucketBadge}`}>
                {projection.bucket}
              </span>
            )}
          </div>
        </div>
        {item.body && <p className={styles.itemBody}>{item.body}</p>}
        {projection?.progressSummary && (
          <p className={styles.progressLine}>{projection.progressSummary}</p>
        )}
        {projection?.completionSuggestion && (
          <div className={styles.reviewCard}>
            <div>
              <strong>Agent reports this work is finished</strong>
              <p>{projection.completionSuggestion.summary}</p>
            </div>
            <div className={styles.reviewActions}>
              <button type="button" onClick={() => reviewCompletion(item.id, projection.completionSuggestion!.evidenceId, 'rejected')}>
                Keep open
              </button>
              <button type="button" className={styles.acceptAction} onClick={() => reviewCompletion(item.id, projection.completionSuggestion!.evidenceId, 'accepted')}>
                Complete
              </button>
            </div>
          </div>
        )}
        <div className={styles.metaRow}>
          {item.area && <span>{item.area}</span>}
          {item.projectRoot && <span className={styles.path}>{item.projectRoot}</span>}
          {projection?.lastActivityAt && (
            <span>{new Date(projection.lastActivityAt).toLocaleString()}</span>
          )}
          {item.statusSource === 'accepted_agent_suggestion' && <span>Accepted suggestion</span>}
        </div>
        {projection && (projection.acceptedSessions.length > 0 || projection.suggestions.length > 0) && (
          <div className={styles.sessionRow}>
            {projection.acceptedSessions.map((session) => (
              <span key={session.id} className={styles.sessionPill}>
                {session.runtimeId} / {session.status}
              </span>
            ))}
            {projection.suggestions.map((suggestion) => (
              <span key={suggestion.linkId} className={styles.suggestionPill}>
                {suggestion.agentSession.runtimeId} / {suggestion.agentSession.status}
                <button type="button" onClick={() => reviewSessionLink(suggestion.linkId, 'reject')}>Dismiss</button>
                <button type="button" onClick={() => reviewSessionLink(suggestion.linkId, 'accept')}>Link</button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className={styles.actions}>
        {item.status !== 'planned' && item.status !== 'done' && item.status !== 'archived' && (
          <button type="button" onClick={() => setItemStatus(item, 'planned')} title="Plan">
            P
          </button>
        )}
        {item.status !== 'active' && item.status !== 'done' && item.status !== 'archived' && (
          <button type="button" onClick={() => setItemStatus(item, 'active')} title="Start">
            S
          </button>
        )}
        {item.status !== 'blocked' && item.status !== 'done' && item.status !== 'archived' && (
          <button type="button" onClick={() => setItemStatus(item, 'blocked')} title="Block">
            B
          </button>
        )}
        {item.status !== 'done' && item.status !== 'archived' && (
          <button type="button" onClick={() => setItemStatus(item, 'done')} title="Done">
            D
          </button>
        )}
        {item.status !== 'archived' && (
          <button type="button" onClick={() => setItemStatus(item, 'archived')} title="Archive">
            A
          </button>
        )}
        <button type="button" onClick={() => deleteItem(item.id)} title="Delete">
          X
        </button>
      </div>
    </article>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`${styles.statCard} ${styles[tone]}`}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  )
}
