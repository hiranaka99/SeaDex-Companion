import { ReactNode, useEffect, useId, useRef, useState } from 'react'
import * as api from '../api'
import { copyText } from '../clipboard'
import { buttonBase, buttonPrimary, cx } from '../styles'
import type { UpdateInfo } from '../../../shared/update-contracts.js'
import Icon from './Icons'
import Modal from './Modal'
import { useToast } from './Toast'

export const UPDATED_FLAG = 'seadex:updated-to'
const UPDATE_GUIDE = 'https://github.com/hiranaka99/SeaDex-Companion#updating-and-backups'
const RESTART_TIMEOUT_MS = 3 * 60_000

const COMMANDS = {
  compose: 'docker compose pull\ndocker compose up -d',
  run: 'docker pull hiranaka/seadex-companion:latest\ndocker stop seadex-companion\ndocker rm seadex-companion',
}

type Phase =
  | { step: 'idle' }
  | { step: 'installing' }
  | { step: 'restarting'; version: string }
  | { step: 'error'; message: string }

interface Props {
  open: boolean
  info: UpdateInfo
  onClose: () => void
}

function Callout({ tone, title, children }: { tone: 'warn' | 'bad'; title: string; children: ReactNode }) {
  return (
    <div
      role={tone === 'bad' ? 'alert' : undefined}
      className={cx(
        'mb-4 rounded-xl border px-4 py-3 text-sm text-ink',
        tone === 'warn' ? 'border-warn/35 bg-warn/8' : 'border-bad/35 bg-bad/8',
      )}
    >
      <div className={cx('mb-1 flex items-center gap-2 font-bold', tone === 'warn' ? 'text-warn' : 'text-bad')}>
        <Icon name="alert" size={16} />
        {title}
      </div>
      {children}
    </div>
  )
}

function ImageCommands() {
  const toast = useToast()
  const [method, setMethod] = useState<keyof typeof COMMANDS>('compose')
  const copy = async () => {
    try {
      await copyText(COMMANDS[method])
      toast.show('Commands copied', 'success')
    } catch {
      toast.show('Could not copy automatically; select the commands and copy them manually', 'error')
    }
  }
  return (
    <div className="mb-4">
      <div className="mb-2 flex flex-wrap items-center gap-2" role="group" aria-label="How you run SeaDex Companion">
        {(['compose', 'run'] as const).map(option => (
          <button
            key={option}
            type="button"
            aria-pressed={method === option}
            onClick={() => setMethod(option)}
            className={cx(
              'touch-target cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors',
              method === option
                ? 'border-accent/40 bg-accent/12 text-ink'
                : 'border-line bg-panel text-muted hover:text-ink',
            )}
          >
            {option === 'compose' ? 'Docker Compose' : 'docker run'}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void copy()}
          className="touch-target ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-muted hover:text-ink"
        >
          <Icon name="copy" size={14} />
          Copy
        </button>
      </div>
      <pre className="m-0 overflow-x-auto rounded-lg border border-line bg-canvas-soft px-3 py-2.5 font-mono text-xs leading-relaxed text-ink">
        {COMMANDS[method]}
      </pre>
      {method === 'run' && (
        <p className="mt-2 mb-0 text-xs text-muted">
          Then run your original <code>docker run</code> command again with the same <code>seadex-data</code> volume.
        </p>
      )}
    </div>
  )
}

export default function UpdateDialog({ open, info, onClose }: Props) {
  const id = useId()
  const [phase, setPhase] = useState<Phase>({ step: 'idle' })
  const closeRef = useRef<HTMLButtonElement>(null)
  const mode = info.install?.mode ?? 'unavailable'
  const latest = info.latest ?? ''
  const busy = phase.step === 'installing' || phase.step === 'restarting'
  const failure = info.last_failure?.version === latest ? info.last_failure : null

  useEffect(() => {
    if (!open) return
    if (!busy) setPhase({ step: 'idle' })
    closeRef.current?.focus()
    // Resetting only on open; a running install must survive re-renders.
  }, [open])

  // While the server restarts, wait for the new version, then reload into its frontend.
  useEffect(() => {
    if (phase.step !== 'restarting') return
    let active = true
    const deadline = Date.now() + RESTART_TIMEOUT_MS
    let timer = 0
    const poll = async () => {
      try {
        const status = await api.getUpdateStatus()
        if (!active) return
        if (status.current === phase.version) {
          try {
            sessionStorage.setItem(UPDATED_FLAG, phase.version)
          } catch {
            /* The toast after reload is a convenience. */
          }
          window.location.reload()
          return
        }
        if (status.last_failure?.version === phase.version) {
          setPhase({
            step: 'error',
            message: `v${phase.version} ${status.last_failure.reason}, so SeaDex Companion returned to v${status.last_failure.restored}. The Server log has details.`,
          })
          return
        }
      } catch {
        /* The server is restarting. */
      }
      if (!active) return
      if (Date.now() > deadline) {
        setPhase({
          step: 'error',
          message:
            'The restart is taking longer than expected. Reload this page in a minute, or check the container logs if SeaDex Companion does not come back.',
        })
        return
      }
      timer = window.setTimeout(() => void poll(), 2_000)
    }
    timer = window.setTimeout(() => void poll(), 2_000)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [phase])

  const install = async () => {
    setPhase({ step: 'installing' })
    try {
      const result = await api.installUpdate()
      setPhase({ step: 'restarting', version: result.version })
    } catch (error) {
      setPhase({
        step: 'error',
        message: error instanceof Error ? error.message : 'The update could not be installed.',
      })
    }
  }

  const title =
    phase.step === 'restarting'
      ? `Restarting into v${phase.version}`
      : mode === 'image_required'
        ? `v${latest} needs a new Docker image`
        : `Update to v${latest}`

  return (
    <Modal open={open} labelledBy={`${id}-title`} describedBy={`${id}-description`} busy={busy} onClose={onClose}>
      <section
        className="app-scrollbar max-h-[calc(100dvh-3rem)] w-full max-w-lg animate-rise overflow-y-auto rounded-card border border-line-strong bg-panel-raised p-5 shadow-card"
        aria-busy={busy}
      >
        <div className="mb-4 flex items-start gap-3">
          <span
            className={cx(
              'grid size-10 shrink-0 place-items-center rounded-xl',
              mode === 'image_required' ? 'bg-warn/12 text-warn' : 'bg-accent/12 text-accent-bright',
            )}
          >
            <Icon name={mode === 'image_required' ? 'alert' : 'download'} />
          </span>
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="m-0 text-lg font-bold">
              {title}
            </h2>
            <p id={`${id}-description`} className="mt-1 mb-0 text-sm text-muted">
              You are running v{info.current}
              {info.managed && info.image !== info.current
                ? ` (installed in-app on Docker image v${info.image})`
                : ''}.{' '}
              {info.url && (
                <a
                  href={info.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-accent-bright hover:underline"
                >
                  Release notes
                </a>
              )}
            </p>
          </div>
        </div>

        {failure && phase.step === 'idle' && (
          <Callout tone="bad" title="The last install did not start">
            <p className="m-0 text-muted">
              v{failure.version} {failure.reason}, so SeaDex Companion returned to v{failure.restored}. The Server log
              has details. You can try again, or pull the new Docker image instead.
            </p>
          </Callout>
        )}

        {phase.step === 'error' && (
          <Callout tone="bad" title="Update not applied">
            <p className="m-0 text-muted">{phase.message}</p>
          </Callout>
        )}

        {phase.step === 'restarting' ? (
          <div
            className="mb-4 flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-sm"
            role="status"
          >
            <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent-bright" />
            <span>
              Update installed. SeaDex Companion is restarting; this page reloads when v{phase.version} is ready.
            </span>
          </div>
        ) : mode === 'in_app' ? (
          <>
            <p className="mt-0 mb-3 text-sm text-ink">
              SeaDex Companion downloads the update, verifies it, and restarts. This usually takes less than a minute.
            </p>
            <ul className="mt-0 mb-4 flex list-none flex-col gap-1.5 p-0 text-sm text-muted">
              <li className="flex gap-2">
                <Icon name="check" size={16} className="mt-0.5 shrink-0 text-good" />
                Settings, library data, and download tracking stay in place.
              </li>
              <li className="flex gap-2">
                <Icon name="check" size={16} className="mt-0.5 shrink-0 text-good" />
                If the new version fails to start, v{info.current} comes back automatically.
              </li>
              <li className="flex gap-2">
                <Icon name="info" size={16} className="mt-0.5 shrink-0 text-muted-dim" />
                In-app updates replace SeaDex Companion only. Pull the Docker image from time to time to receive
                operating system security fixes.
              </li>
            </ul>
          </>
        ) : mode === 'image_required' ? (
          <>
            <Callout tone="warn" title="This update can't be installed from here">
              <p className="mt-0 mb-1.5 text-muted">
                v{latest} changes the container itself, so you need to download the new Docker image:
              </p>
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-ink">
                {(info.install?.reasons ?? []).map(reason => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </Callout>
            <p className="mt-0 mb-2 text-sm text-ink">
              Back up your <code>seadex-data</code> volume, then update the container from the host:
            </p>
            <ImageCommands />
          </>
        ) : (
          <div className="mb-4 rounded-xl border border-line bg-panel px-4 py-3 text-sm">
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-muted">
              {(info.install?.reasons ?? []).map(reason => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            {info.managed && (
              <p className="mt-2 mb-0 text-muted">
                You can still update by pulling the new Docker image.{' '}
                <a
                  href={UPDATE_GUIDE}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-accent-bright hover:underline"
                >
                  How to update
                </a>
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            ref={closeRef}
            type="button"
            className={`${buttonBase} border-line bg-panel text-ink hover:text-ink`}
            onClick={onClose}
            disabled={busy}
          >
            {mode === 'in_app' && phase.step !== 'restarting' ? 'Not now' : 'Close'}
          </button>
          {mode === 'in_app' && phase.step !== 'restarting' && (
            <button type="button" className={buttonPrimary} onClick={() => void install()} disabled={busy}>
              {phase.step === 'installing' ? (
                <span className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current" />
              ) : (
                <Icon name="download" size={16} />
              )}
              {phase.step === 'installing'
                ? 'Downloading and verifying…'
                : phase.step === 'error' || failure
                  ? 'Try again'
                  : 'Install and restart'}
            </button>
          )}
        </div>
      </section>
    </Modal>
  )
}
