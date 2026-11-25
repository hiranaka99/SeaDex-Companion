import { useState } from 'react'
import * as api from '../../api'
import { buttonBase, control, cx } from '../../styles'
import Icon from '../Icons'
import { useToast } from '../Toast'
import { subheading } from './parts'
import { errorMessage } from '../../../../shared/errors.js'

const EMPTY = { currentPassword: '', newPassword: '', confirmPassword: '' }

/** Changes the administrator password; every other session is signed out when it succeeds. */
export default function ChangePasswordForm({
  username,
  onAccountUpdated,
}: {
  username: string
  onAccountUpdated: (username: string) => void
}) {
  const [account, setAccount] = useState(EMPTY)
  const [savingAccount, setSavingAccount] = useState(false)
  const toast = useToast()

  const saveAccount = async () => {
    if (username.trim().length < 3) {
      toast.show('Username must contain at least 3 characters', 'error')
      return
    }
    if (!account.currentPassword) {
      toast.show('Enter your current password', 'error')
      return
    }
    if (account.newPassword && account.newPassword.length < 10) {
      toast.show('The new password must contain at least 10 characters', 'error')
      return
    }
    if (account.newPassword !== account.confirmPassword) {
      toast.show('The new passwords do not match', 'error')
      return
    }
    setSavingAccount(true)
    try {
      const updated = await api.updateAccount(username.trim(), account.currentPassword, account.newPassword)
      onAccountUpdated(updated.username || username.trim())
      setAccount(EMPTY)
      toast.show('Administrator account updated; other sessions were signed out', 'success')
    } catch (error) {
      toast.show('Could not update account: ' + errorMessage(error), 'error')
    } finally {
      setSavingAccount(false)
    }
  }

  return (
    <div className="border-t border-line pt-6">
      <h3 className={subheading}>Change password</h3>
      <p className="mt-1 mb-4 text-xs text-muted">
        Changing the password signs out other sessions and updates the credentials used by Sonarr and Radarr webhooks.
      </p>
      <div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink">Current password</span>
          <input
            className={cx(control, 'w-full bg-canvas-soft')}
            type="password"
            value={account.currentPassword}
            autoComplete="current-password"
            onChange={event => setAccount(current => ({ ...current, currentPassword: event.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink">New password</span>
          <input
            className={cx(control, 'w-full bg-canvas-soft')}
            type="password"
            value={account.newPassword}
            autoComplete="new-password"
            placeholder="At least 10 characters"
            onChange={event => setAccount(current => ({ ...current, newPassword: event.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink">Confirm new password</span>
          <input
            className={cx(control, 'w-full bg-canvas-soft')}
            type="password"
            value={account.confirmPassword}
            autoComplete="new-password"
            onChange={event => setAccount(current => ({ ...current, confirmPassword: event.target.value }))}
          />
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright hover:bg-accent/18')}
          onClick={() => void saveAccount()}
          disabled={savingAccount || !account.currentPassword || !account.newPassword || !account.confirmPassword}
        >
          {savingAccount ? (
            <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
          ) : (
            <Icon name="check" size={16} />
          )}{' '}
          {savingAccount ? 'Changing password…' : 'Change password'}
        </button>
      </div>
    </div>
  )
}
