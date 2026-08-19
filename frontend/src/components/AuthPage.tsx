import { FormEvent, useState } from 'react'
import * as api from '../api'
import type { AuthState } from '../types'
import { buttonPrimary, control } from '../styles'

interface Props {
  setupRequired: boolean
  onAuthenticated: (state: AuthState) => void
}

export default function AuthPage({ setupRequired, onAuthenticated }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (setupRequired && password !== confirmation) {
      setError('Passwords do not match')
      return
    }
    setBusy(true)
    try {
      const state = setupRequired
        ? await api.setupAuth(username, password)
        : await api.login(username, password)
      onAuthenticated(state)
    } catch (caught: any) {
      setError(caught?.message || 'Authentication failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <section className="w-full max-w-[430px] animate-rise rounded-card border border-line bg-panel px-7 py-8 shadow-card max-[480px]:px-5">
        <header className="mb-7 text-center">
          <img src="/favicon.png" alt="SeaDex Companion" className="mx-auto mb-4 size-16 rounded-2xl border border-line-strong object-cover shadow-[0_8px_30px_rgba(79,140,255,0.25)]" />
          <h1 className="m-0 text-2xl font-extrabold tracking-[0.3px]">SeaDex Companion</h1>
          <p className="mt-2 mb-0 text-sm text-muted">
            {setupRequired ? 'Create the administrator account' : 'Sign in to continue'}
          </p>
        </header>

        <form className="flex flex-col gap-4" onSubmit={submit}>
          <label className="flex flex-col gap-2 text-[13px] font-semibold text-muted">
            Username
            <input
              className={control}
              name="username"
              type="text"
              autoComplete="username"
              minLength={3}
              maxLength={64}
              required
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-2 text-[13px] font-semibold text-muted">
            Password
            <input
              className={control}
              name="password"
              type="password"
              autoComplete={setupRequired ? 'new-password' : 'current-password'}
              minLength={10}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {setupRequired && <small className="font-normal text-muted-dim">At least 10 characters</small>}
          </label>

          {setupRequired && (
            <label className="flex flex-col gap-2 text-[13px] font-semibold text-muted">
              Confirm password
              <input
                className={control}
                name="password_confirmation"
                type="password"
                autoComplete="new-password"
                minLength={10}
                required
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
          )}

          {error && <p role="alert" className="m-0 rounded-control border border-bad/35 bg-bad/10 px-3.5 py-2.5 text-sm text-bad">{error}</p>}

          <button className={`${buttonPrimary} mt-1 justify-center`} type="submit" disabled={busy}>
            {busy ? 'Please wait…' : setupRequired ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  )
}

