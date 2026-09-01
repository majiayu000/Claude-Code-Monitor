import { memo, useState, useRef } from 'react'
import { useClickOutside } from '@/hooks'
import type { NotificationSettings as NotificationSettingsType } from '@/hooks/useNotifications'
import styles from './NotificationSettings.module.css'

interface NotificationSettingsProps {
  settings: NotificationSettingsType
  onUpdateSettings: (updates: Partial<NotificationSettingsType>) => void
  permission: NotificationPermission
  onRequestPermission: () => Promise<boolean>
}

export const NotificationSettings = memo(function NotificationSettings({
  settings,
  onUpdateSettings,
  permission,
  onRequestPermission,
}: NotificationSettingsProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useClickOutside(containerRef, () => setIsOpen(false))

  const handleRequestPermission = async () => {
    await onRequestPermission()
  }

  const isEnabled = settings.enabled && permission === 'granted'
  const needsPermission = permission !== 'granted'

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        className={`${styles.trigger} ${isEnabled ? styles.enabled : styles.disabled}`}
        onClick={() => setIsOpen(!isOpen)}
        title={isEnabled ? 'Notifications enabled' : 'Notifications disabled'}
      >
        🔔
        {needsPermission && <span className={styles.badge} />}
      </button>

      {isOpen && (
        <div className={styles.panel}>
          <div className={styles.header}>
            <h3 className={styles.title}>Notification Settings</h3>
            <button className={styles.closeButton} onClick={() => setIsOpen(false)}>
              ✕
            </button>
          </div>

          <div className={styles.content}>
            {needsPermission && (
              <div className={styles.permissionBanner}>
                <span className={styles.permissionText}>
                  {permission === 'denied'
                    ? 'Notifications are blocked. Please enable them in your browser settings.'
                    : 'Enable browser notifications to receive alerts.'}
                </span>
                {permission !== 'denied' && (
                  <button className={styles.permissionButton} onClick={handleRequestPermission}>
                    Enable Notifications
                  </button>
                )}
              </div>
            )}

            <div className={styles.settingsList}>
              <div className={styles.settingItem}>
                <div className={styles.settingLabel}>
                  <span className={styles.settingName}>Enable Notifications</span>
                  <span className={styles.settingDesc}>Receive browser notifications</span>
                </div>
                <button
                  className={`${styles.toggle} ${settings.enabled ? styles.active : ''}`}
                  onClick={() => onUpdateSettings({ enabled: !settings.enabled })}
                  disabled={permission !== 'granted'}
                />
              </div>

              <div className={styles.settingItem}>
                <div className={styles.settingLabel}>
                  <span className={styles.settingName}>Session Interrupted</span>
                  <span className={styles.settingDesc}>Alert when a session is interrupted</span>
                </div>
                <button
                  className={`${styles.toggle} ${settings.onSessionLost ? styles.active : ''}`}
                  onClick={() => onUpdateSettings({ onSessionLost: !settings.onSessionLost })}
                  disabled={!settings.enabled}
                />
              </div>

              <div className={styles.settingItem}>
                <div className={styles.settingLabel}>
                  <span className={styles.settingName}>Status Changes</span>
                  <span className={styles.settingDesc}>Alert on completion</span>
                </div>
                <button
                  className={`${styles.toggle} ${settings.onStatusChange ? styles.active : ''}`}
                  onClick={() => onUpdateSettings({ onStatusChange: !settings.onStatusChange })}
                  disabled={!settings.enabled}
                />
              </div>

              <div className={styles.settingItem}>
                <div className={styles.settingLabel}>
                  <span className={styles.settingName}>High Cost Warning</span>
                  <span className={styles.settingDesc}>Alert when cost exceeds threshold</span>
                </div>
                <button
                  className={`${styles.toggle} ${settings.onHighCost ? styles.active : ''}`}
                  onClick={() => onUpdateSettings({ onHighCost: !settings.onHighCost })}
                  disabled={!settings.enabled}
                />
              </div>

              {settings.onHighCost && (
                <div className={styles.settingItem}>
                  <div className={styles.settingLabel}>
                    <span className={styles.settingName}>Cost Threshold</span>
                    <span className={styles.settingDesc}>Alert when session exceeds</span>
                  </div>
                  <div className={styles.thresholdInput}>
                    <span className={styles.inputPrefix}>$</span>
                    <input
                      type="number"
                      className={styles.input}
                      value={settings.costThreshold}
                      onChange={(e) => onUpdateSettings({ costThreshold: parseFloat(e.target.value) || 0 })}
                      min="0"
                      step="0.5"
                      disabled={!settings.enabled}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
