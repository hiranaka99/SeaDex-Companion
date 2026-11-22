import { useEffect, useRef, useState } from 'react'
import { buttonBase, cx } from '../styles'
import Modal from './Modal'
import PlanReview from './PlanReview'
import type { DownloadPreflight } from '../api'

export interface SinglePlanFlow {
  plan: { preflight: DownloadPreflight | null; label: string; error: string | null } | null
  busy: boolean
  submitting: boolean
  confirm: (acknowledge: { whole_source?: boolean; disk_space?: boolean }) => Promise<void>
  refresh: () => Promise<void>
  close: () => void
}

interface Props { flow: SinglePlanFlow }

/** Review + acknowledgement gate for sending one release to its client. */
export default function SinglePlanDialog({ flow }: Props) {
  const preflight = flow.plan?.preflight
  const open = flow.plan !== null
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [wholeSource, setWholeSource] = useState(false)
  const [diskSpace, setDiskSpace] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setWholeSource(false)
    setDiskSpace(false)
    cancelRef.current?.focus()
  }, [open, preflight?.plan_id])

  if (!open || !flow.plan) return null
  const needsWhole = preflight?.requires_whole_ack === true
  const needsSpace = preflight?.requires_space_ack === true
  const blocked = !preflight || (needsWhole && !wholeSource) || (needsSpace && !diskSpace)

  const send = async () => {
    if (submitting) return
    setSubmitting(true)
    try { await flow.confirm({ whole_source: wholeSource || undefined, disk_space: diskSpace || undefined }) }
    finally { setSubmitting(false) }
  }

  return (
    <Modal open labelledBy="single-plan-title" busy={flow.submitting || submitting} onClose={flow.close}>
      <section className="w-full max-w-lg animate-rise rounded-card border border-line-strong bg-panel-raised p-5 shadow-card" aria-busy={flow.busy || submitting}>
        <div className="mb-4">
          <h2 id="single-plan-title" className="m-0 text-lg font-bold">Send to download client</h2>
          <p className="mt-1 mb-0 text-sm text-muted wrap-anywhere">{flow.plan.label}</p>
        </div>
        {preflight && <PlanReview preflight={preflight}/>}
        {!preflight && flow.busy && <p className="m-0 text-sm text-muted" role="status">{flow.submitting ? 'Sending to the download client…' : 'Checking download clients and sources…'}</p>}
        {flow.plan.error && <p className="m-0 text-sm text-warn wrap-anywhere" role="alert">{flow.plan.error}</p>}
        {(needsWhole || needsSpace) && <div className="mt-4 flex flex-col gap-2">
          {needsWhole && <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-warn/30 bg-warn/7 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 accent-warn" checked={wholeSource} onChange={event => setWholeSource(event.target.checked)}/>
            <span><span className="block font-bold text-warn">Download whole Usenet sources</span><span className="mt-0.5 block text-xs text-muted">Usenet sources cannot be split per episode. Files beyond the selected episodes will also be downloaded.</span></span>
          </label>}
          {needsSpace && <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-warn/30 bg-warn/7 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 accent-warn" checked={diskSpace} onChange={event => setDiskSpace(event.target.checked)}/>
            <span><span className="block font-bold text-warn">Continue without confirmed free space</span><span className="mt-0.5 block text-xs text-muted">The client could not confirm enough space. The download may fail until space is available.</span></span>
          </label>}
        </div>}
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" className={`${buttonBase} border-line bg-panel text-ink hover:text-ink`} onClick={flow.close} disabled={flow.submitting || submitting}>Cancel</button>
          {!preflight ? <button type="button" className={cx(buttonBase, 'border-accent/35 bg-accent text-on-accent')} onClick={() => void flow.refresh()} disabled={flow.busy || submitting}>Refresh review</button> : <button type="button" className={cx(buttonBase, 'border-accent/35 bg-accent text-on-accent')} onClick={() => void send()} disabled={blocked || flow.busy || submitting}>
            {submitting && <span className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current"/>}
            {submitting ? 'Sending…' : 'Send now'}
          </button>}
        </div>
      </section>
    </Modal>
  )
}
