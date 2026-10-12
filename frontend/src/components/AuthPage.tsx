import { FormEvent, useEffect, useId, useState } from 'react'
import * as api from '../api'
import type { AuthState } from '../types'
import { buttonPrimary, control } from '../styles'
import Icon from './Icons'

interface Props { setupRequired: boolean; onAuthenticated: (state: AuthState) => void }
const fallbackArtwork = [
  ['/auth-art/rezero.jpg', '/auth-art/spy-family.jpg', '/auth-art/horimiya.jpg'],
  ['/auth-art/beastars.png', '/auth-art/slime.jpg', '/auth-art/tomo.jpg'],
  ['/auth-art/horimiya.jpg', '/auth-art/rezero.jpg', '/auth-art/slime.jpg'],
]

export default function AuthPage({ setupRequired, onAuthenticated }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [artPaused, setArtPaused] = useState(false)
  const [artwork, setArtwork] = useState(fallbackArtwork)
  const id = useId()
  const mismatch = error === 'Passwords do not match'

  useEffect(() => {
    const controller = new AbortController()
    // Optional artwork never gates the form or its bundled covers.
    if (!window.matchMedia('(min-width: 900px) and (min-width: 50rem)').matches) return
    void fetch('/api/auth/artwork', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) return
        const data = await response.json()
        if (!Array.isArray(data.covers)) return
        const covers = data.covers.filter((src: unknown): src is string => typeof src === 'string' && src.startsWith('https://s4.anilist.co/file/anilistcdn/media/anime/cover/')).slice(0, 18)
        if (covers.length < 3 || controller.signal.aborted) return
        for (let i = covers.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[covers[i], covers[j]] = [covers[j], covers[i]]
        }
        setArtwork([0, 1, 2].map(column => {
          const items = covers.filter((_: string, index: number) => index % 3 === column)
          while (items.length < 3) items.push(...items)
          return items
        }))
      }).catch(() => { /* Offline: keep local artwork. */ })
    return () => controller.abort()
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError('')
    if (setupRequired && password !== confirmation) { setError('Passwords do not match'); return }
    setBusy(true)
    try {
      const state = setupRequired ? await api.setupAuth(username, password) : await api.login(username, password)
      onAuthenticated(state)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Unable to sign in. Please try again.')
    } finally { setBusy(false) }
  }

  return <main className="auth-screen">
    <section className="auth-access" aria-labelledby={`${id}-title`}>
      <div className="auth-brand"><img src="/favicon.png" alt="" width="40" height="40"/><span>SeaDex Companion</span></div>
      <div className="auth-form-wrap">
        <header className="auth-heading">
          <h1 id={`${id}-title`}>{setupRequired ? 'Your library starts here.' : 'Welcome back.'}</h1>
          <p>{setupRequired ? 'Create the local administrator account for this SeaDex Companion installation.' : 'Sign in to your local SeaDex Companion account.'}</p>
        </header>
        <form className="auth-form" onSubmit={submit} aria-busy={busy}>
          <div className="auth-field">
            <label htmlFor={`${id}-username`}>Username</label>
            <input id={`${id}-username`} className={control} name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={setupRequired ? 3 : undefined} maxLength={64} required autoFocus disabled={busy} value={username} onChange={event => setUsername(event.target.value)}/>
          </div>
          <div className="auth-field">
            <label htmlFor={`${id}-password`}>Password</label>
            <div className="auth-password">
              <input id={`${id}-password`} className={control} name="password" type={showPassword ? 'text' : 'password'} autoComplete={setupRequired ? 'new-password' : 'current-password'} minLength={setupRequired ? 10 : undefined} required disabled={busy} value={password} aria-describedby={setupRequired ? `${id}-password-hint` : undefined} onChange={event => setPassword(event.target.value)}/>
              <button type="button" className="auth-reveal" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-controls={`${id}-password`} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}><Icon name={showPassword ? 'eye-off' : 'eye'} size={19}/></button>
            </div>
            {setupRequired && <p id={`${id}-password-hint`} className="auth-field-hint">At least 10 characters</p>}
          </div>
          {setupRequired && <div className="auth-field">
            <label htmlFor={`${id}-confirmation`}>Confirm password</label>
            <div className="auth-password">
              <input id={`${id}-confirmation`} className={control} name="password_confirmation" type={showConfirmation ? 'text' : 'password'} autoComplete="new-password" minLength={10} required disabled={busy} value={confirmation} aria-invalid={mismatch || undefined} aria-describedby={mismatch ? `${id}-error` : undefined} onChange={event => setConfirmation(event.target.value)}/>
              <button type="button" className="auth-reveal" aria-label={showConfirmation ? 'Hide confirmation password' : 'Show confirmation password'} aria-controls={`${id}-confirmation`} aria-pressed={showConfirmation} onClick={() => setShowConfirmation(value => !value)}><Icon name={showConfirmation ? 'eye-off' : 'eye'} size={19}/></button>
            </div>
          </div>}
          {error && <p id={`${id}-error`} role="alert" className="auth-error">{error}</p>}
          <button className={`${buttonPrimary} auth-submit`} type="submit" disabled={busy}>{busy ? (setupRequired ? 'Creating account…' : 'Signing in…') : setupRequired ? 'Create account' : 'Sign in'}{!busy && <Icon name="chevron-right" size={18}/>}</button>
          <span className="sr-only" role="status">{busy ? (setupRequired ? 'Creating your account' : 'Signing in') : ''}</span>
        </form>
        {!setupRequired && <details className="auth-help"><summary>Need help signing in?</summary><p>Use the account created for this installation, rather than your Sonarr or Radarr credentials. If someone else manages this server, ask them for access.</p></details>}
      </div>
    </section>
    <aside className="auth-gallery" aria-label="Anime artwork">
      <div className="auth-art-wall" data-paused={artPaused} aria-hidden="true">
        {artwork.map((column, index) => <div className="auth-art-column" key={index}><div className="auth-art-track">{[0, 1].map(copy => <div className="auth-art-sequence" key={copy}>{column.map((src, imageIndex) => <img src={src} alt="" width="230" height="345" decoding="async" key={src + imageIndex} onError={event => { const image = event.currentTarget; const fallback = fallbackArtwork[index][imageIndex % fallbackArtwork[index].length]; if (image.getAttribute('src') !== fallback) image.src = fallback }}/>)}</div>)}</div></div>)}
      </div>
      <button className="auth-motion-toggle" type="button" onClick={() => setArtPaused(value => !value)} aria-pressed={artPaused} aria-label={artPaused ? 'Resume artwork animation' : 'Pause artwork animation'}><Icon name={artPaused ? 'play' : 'pause'} size={16}/><span>{artPaused ? 'Resume artwork' : 'Pause artwork'}</span></button>
    </aside>
  </main>
}
