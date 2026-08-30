import { memo, useEffect, useRef, useState } from 'react'
import styles from './TabNav.module.css'

export type TabId =
  | 'overview'
  | 'sessions'
  | 'orchestrator'
  | 'work'
  | 'analytics'
  | 'projects'
  | 'memory'
  | 'plans'
  | 'terminal'

interface Tab {
  id: TabId
  label: string
  icon: string
}

const PRIMARY_TABS: Tab[] = [
  { id: 'overview', label: 'Overview', icon: '01' },
  { id: 'work', label: 'Work', icon: '+' },
  { id: 'sessions', label: 'Sessions', icon: '>' },
]

const SECONDARY_TABS: Tab[] = [
  { id: 'projects', label: 'Projects', icon: '#' },
  { id: 'plans', label: 'Plans', icon: '%' },
  { id: 'memory', label: 'Memory', icon: '@' },
  { id: 'analytics', label: 'Analytics', icon: '$' },
  { id: 'terminal', label: 'Terminal', icon: '~' },
]

interface TabNavProps {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
}

export const TabNav = memo(function TabNav({ activeTab, onTabChange }: TabNavProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const secondaryActive = SECONDARY_TABS.some((tab) => tab.id === activeTab)

  useEffect(() => {
    if (!moreOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) {
        setMoreOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [moreOpen])

  const selectTab = (tab: TabId) => {
    onTabChange(tab)
    setMoreOpen(false)
  }

  return (
    <nav className={styles.nav} aria-label="Main navigation">
      <div className={styles.primary} role="tablist" aria-label="Primary views">
      {PRIMARY_TABS.map((tab) => (
        <button
          key={tab.id}
          className={`${styles.tab} ${activeTab === tab.id ? styles.active : ''}`}
          onClick={() => selectTab(tab.id)}
          id={`tab-${tab.id}`}
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls={`panel-${tab.id}`}
        >
          <span className={styles.icon}>{tab.icon}</span>
          <span className={styles.label}>{tab.label}</span>
        </button>
      ))}
      </div>

      <div className={styles.more} ref={moreRef}>
        <button
          type="button"
          className={`${styles.moreButton} ${secondaryActive ? styles.active : ''}`}
          onClick={() => setMoreOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
        >
          <span className={styles.moreMark}>•••</span>
          <span>More</span>
        </button>
        {moreOpen && (
          <div className={styles.menu} role="menu" aria-label="More views">
            <div className={styles.menuLabel}>Workspace</div>
            {SECONDARY_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`${styles.menuItem} ${activeTab === tab.id ? styles.menuItemActive : ''}`}
                onClick={() => selectTab(tab.id)}
                role="menuitem"
              >
                <span className={styles.menuIcon}>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </nav>
  )
})
