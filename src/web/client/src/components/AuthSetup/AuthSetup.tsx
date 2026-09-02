/**
 * AuthSetup - First-run setup form
 */

import { useState, type FormEvent } from 'react'
import styles from './AuthSetup.module.css'

interface AuthSetupProps {
  onSetup: (username: string, password: string, enableTotp?: boolean) => Promise<{ totpUri?: string }>
  error?: string | null
}

export function AuthSetup({ onSetup, error }: AuthSetupProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [enableTotp, setEnableTotp] = useState(false)
  const [totpUri, setTotpUri] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)

    if (password !== confirmPassword) {
      setLocalError('Passwords do not match')
      return
    }
    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters')
      return
    }

    setSubmitting(true)
    try {
      const result = await onSetup(username, password, enableTotp)
      if (result.totpUri) {
        setTotpUri(result.totpUri)
      }
    } catch (e) {
      setLocalError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (totpUri) {
    return (
      <div className={styles.container}>
        <div className={styles.card}>
          <h2 className={styles.title}>TOTP Setup</h2>
          <p className={styles.description}>
            Add this URI to your authenticator app:
          </p>
          <code className={styles.totpUri}>{totpUri}</code>
          <p className={styles.description}>Setup complete. You can now use Keepline.</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h2 className={styles.title}>Keepline Setup</h2>
        <p className={styles.description}>
          Create credentials for your local dashboard.
        </p>
        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="setup-username">Username</label>
            <input
              id="setup-username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              minLength={3}
              maxLength={32}
              required
              autoComplete="username"
              autoFocus
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="setup-password">Password</label>
            <input
              id="setup-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              minLength={8}
              required
              autoComplete="new-password"
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="setup-confirm">Confirm Password</label>
            <input
              id="setup-confirm"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
          <div className={styles.checkbox}>
            <input
              id="setup-totp"
              type="checkbox"
              checked={enableTotp}
              onChange={e => setEnableTotp(e.target.checked)}
            />
            <label htmlFor="setup-totp">Enable TOTP 2FA</label>
          </div>
          {(localError || error) && (
            <div className={styles.error}>{localError || error}</div>
          )}
          <button type="submit" className={styles.submit} disabled={submitting}>
            {submitting ? 'Setting up...' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  )
}
