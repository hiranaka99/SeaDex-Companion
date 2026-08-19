import { FormEvent, useState } from 'react'
import * as api from '../api'
import type { AuthState } from '../types'
import { buttonPrimary, control } from '../styles'
import Icon from './Icons'

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
      <section className="grid w-full max-w-[900px] animate-rise grid-cols-[1fr_430px] overflow-hidden rounded-[22px] border border-line bg-panel shadow-card max-[780px]:max-w-[430px] max-[780px]:grid-cols-1">
        <div className="relative flex flex-col justify-between overflow-hidden border-r border-line bg-canvas-soft p-9 max-[780px]:hidden"><div className="absolute -top-32 -left-28 size-80 rounded-full bg-accent/10 blur-3xl"/><div className="relative"><div className="mb-10 flex items-center gap-3"><img src="/favicon.png" alt="" className="size-11 rounded-xl border border-line-strong object-cover"/><div><div className="text-lg font-extrabold">SeaDex</div><div className="text-[10px] tracking-[.18em] text-muted uppercase">Companion</div></div></div><h1 className="max-w-sm text-3xl leading-tight font-extrabold tracking-tight">Your anime library,<br/><span className="text-accent-bright">beautifully organized.</span></h1><p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">Compare local releases, discover upgrades, and send the best version straight to your download client.</p></div><div className="relative grid grid-cols-2 gap-3 text-xs text-muted"><span className="flex items-center gap-2"><Icon name="check" size={15} className="text-good"/>Encrypted credentials</span><span className="flex items-center gap-2"><Icon name="check" size={15} className="text-good"/>Private local account</span></div></div>
        <div className="px-7 py-9 max-[480px]:px-5">
        <header className="mb-7 text-center">
          <img src="/favicon.png" alt="SeaDex Companion" className="mx-auto mb-4 hidden size-14 rounded-2xl border border-line-strong object-cover max-[780px]:block" />
          <h1 className="m-0 text-2xl font-extrabold tracking-tight">{setupRequired ? 'Create your account' : 'Welcome back'}</h1>
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
        </div>
      </section>
    </main>
  )
}
