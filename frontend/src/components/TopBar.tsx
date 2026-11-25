import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as api from '../api'
import { Status, TabId } from '../types'
import { cx } from '../styles'
import Icon, { IconName } from './Icons'
import SidebarStatus from './SidebarStatus'
import { useToast } from './Toast'
import UpdateDialog, { UPDATED_FLAG } from './UpdateDialog'
import type { UpdateInfo } from '../../../shared/update-contracts.js'
import pkg from '../../package.json'

const APP_VERSION = `v${pkg.version.replace(/\.0$/, '')}`

const NAV: { id: TabId; icon: IconName; label: string }[] = [
  { id: 'anime', icon: 'library', label: 'Library' },
  { id: 'history', icon: 'history', label: 'Scan history' },
  { id: 'config', icon: 'settings', label: 'Configuration' },
  { id: 'log', icon: 'logs', label: 'Server log' },
]

interface Props {
  tab: TabId
  onTabChange: (tab: TabId) => void
  username: string
  onLogout: () => void
  collapsed: boolean
  onToggleCollapsed: () => void
  status: Status
  scanCompleted: string | null
  scanCancelledDismissed: boolean
  onCancelScan: () => void
  onRetryScan: () => void
  onOpenConfig: () => void
  onDismissScan: () => void
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <img
        src="/favicon.png"
        alt=""
        className={cx('rounded-lg border border-line-strong object-cover', compact ? 'size-9' : 'size-11')}
      />
      <div className="min-w-0">
        <div className={cx('font-extrabold tracking-tight text-ink', compact ? 'text-base' : 'text-lg')}>
          SeaDex
          {compact && (
            <span
              className="ml-2 inline-block rounded-md border border-line-strong bg-panel-raised px-1.5 py-0.5 align-middle text-[10px] font-semibold tracking-normal text-muted"
              title={`SeaDex Companion ${APP_VERSION}`}
            >
              {APP_VERSION}
            </span>
          )}
        </div>
        <div className="text-[10px] font-semibold tracking-[0.18em] text-muted-dim uppercase">Companion</div>
      </div>
    </div>
  )
}

function positionSelection(nav: HTMLElement | null, marker: HTMLElement | null) {
  const active = nav?.querySelector<HTMLButtonElement>('[aria-current="page"]')
  if (!active || !marker || !active.offsetHeight) return
  // Read geometry together, then write only changed values. Marker movement
  // doesn't need a React render or another root commit.
  const height = `${active.offsetHeight}px`
  const transform = `translateY(${active.offsetTop}px)`
  if (marker.style.height !== height) marker.style.height = height
  if (marker.style.transform !== transform) marker.style.transform = transform
}

function TopBar({
  tab,
  onTabChange,
  username,
  onLogout,
  collapsed,
  onToggleCollapsed,
  status,
  scanCompleted,
  scanCancelledDismissed,
  onCancelScan,
  onRetryScan,
  onOpenConfig,
  onDismissScan,
}: Props) {
  const toast = useToast()
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [updateOpen, setUpdateOpen] = useState(false)
  const needsImage = update?.install?.mode === 'image_required'
  const updateLabel = update
    ? needsImage
      ? `v${update.latest} available — needs a new Docker image`
      : `v${update.latest} available`
    : ''
  const mobileHeaderRef = useRef<HTMLElement>(null)
  const mobileNavRef = useRef<HTMLElement>(null)
  const desktopNavRef = useRef<HTMLElement>(null)
  const selectionRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    positionSelection(desktopNavRef.current, selectionRef.current)
  }, [tab])

  useLayoutEffect(() => {
    const nav = desktopNavRef.current
    if (!nav) return
    let previousHeight = -1
    const observer = new ResizeObserver(([entry]) => {
      // Width changes every frame during collapse, but fixed icon/label rows
      // keep their height. Re-measure only for text sizing or breakpoint changes.
      if (entry.contentRect.height === previousHeight) return
      previousHeight = entry.contentRect.height
      positionSelection(nav, selectionRef.current)
    })
    observer.observe(nav)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    // Reserve the rendered chrome height, including user text size and safe areas.
    const updateInsets = () => {
      const header = mobileHeaderRef.current?.getBoundingClientRect()
      const nav = mobileNavRef.current?.getBoundingClientRect()
      if (!header?.height || !nav?.height) {
        delete document.documentElement.dataset.mobileSpaceLimited
        return
      }
      const clearance = Math.ceil(nav.height + Math.max(0, window.innerHeight - nav.bottom) + 12)
      document.documentElement.style.setProperty('--mobile-header-height', `${Math.ceil(header.height)}px`)
      document.documentElement.style.setProperty('--mobile-navigation-space', `${clearance}px`)
      // A tall toolbar should scroll away when enlarged text or a keyboard
      // leaves little space between the fixed navigation surfaces.
      document.documentElement.toggleAttribute(
        'data-mobile-space-limited',
        header.height + clearance > window.innerHeight * 0.3,
      )
    }
    const observer = new ResizeObserver(updateInsets)
    if (mobileHeaderRef.current) observer.observe(mobileHeaderRef.current)
    if (mobileNavRef.current) observer.observe(mobileNavRef.current)
    window.addEventListener('resize', updateInsets)
    updateInsets()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateInsets)
      document.documentElement.style.removeProperty('--mobile-header-height')
      document.documentElement.style.removeProperty('--mobile-navigation-space')
      document.documentElement.removeAttribute('data-mobile-space-limited')
    }
  }, [])

  useEffect(() => {
    let active = true
    api
      .checkForUpdates()
      .then(info => {
        if (active && info.latest) setUpdate(info)
      })
      .catch(() => undefined)
    try {
      const updated = sessionStorage.getItem(UPDATED_FLAG)
      if (updated) {
        sessionStorage.removeItem(UPDATED_FLAG)
        toast.show(`SeaDex Companion was updated to v${updated}`, 'success', 6000)
      }
    } catch {
      /* Session storage unavailable. */
    }
    return () => {
      active = false
    }
  }, [toast])

  return (
    <>
      <aside
        data-collapsed={collapsed}
        className="sidebar flex h-dvh min-w-0 flex-col border-r border-line bg-canvas-soft px-4 py-5 max-[900px]:hidden"
      >
        {collapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="relative mx-auto grid size-11 animate-fade cursor-pointer place-items-center rounded-xl transition-transform duration-300 hover:scale-105"
          >
            <img src="/favicon.png" alt="" className="size-9 rounded-lg border border-line-strong object-cover" />
            <span className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full border border-line-strong bg-panel-raised text-muted shadow-card">
              <Icon name="chevron-right" size={12} />
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-2 px-2 animate-fade">
            <Brand />
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="ml-auto grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-panel hover:text-ink"
            >
              <Icon name="chevron-left" size={18} />
            </button>
          </div>
        )}

        <nav
          ref={desktopNavRef}
          className="sidebar-nav relative mt-9 flex flex-col gap-1.5"
          aria-label="Primary navigation"
        >
          <span
            ref={selectionRef}
            aria-hidden="true"
            className="sidebar-selection pointer-events-none absolute inset-x-0 rounded-xl bg-accent/12"
          />
          {NAV.map(item => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              className={cx(
                'sidebar-nav-button group relative flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold',
                tab === item.id ? 'text-ink' : 'text-muted hover:bg-panel hover:text-ink',
              )}
              aria-label={item.label}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => onTabChange(item.id)}
            >
              <Icon
                name={item.icon}
                size={19}
                className={cx(
                  'sidebar-nav-icon shrink-0 transition-colors',
                  tab === item.id ? 'text-accent-bright' : 'text-muted-dim group-hover:text-ink',
                )}
              />
              <span aria-hidden="true" className="sidebar-nav-label">
                {item.label}
              </span>
            </button>
          ))}
        </nav>

        <div className={cx('mt-auto', collapsed && 'flex w-full flex-col items-center')}>
          <SidebarStatus
            status={status}
            scanCompleted={scanCompleted}
            scanCancelledDismissed={scanCancelledDismissed}
            collapsed={collapsed}
            onCancelScan={onCancelScan}
            onRetryScan={onRetryScan}
            onOpenConfig={onOpenConfig}
            onDismissScan={onDismissScan}
            onExpand={onToggleCollapsed}
          />
          {collapsed ? (
            <div className="flex w-full flex-col items-center gap-3 animate-fade">
              {update ? (
                <button
                  type="button"
                  onClick={() => setUpdateOpen(true)}
                  className={cx(
                    'touch-target flex cursor-pointer items-center gap-1.5 rounded-md px-1 text-[10px] font-semibold tracking-[0.14em] hover:underline',
                    needsImage ? 'text-warn' : 'text-accent-bright',
                  )}
                  title={`SeaDex Companion ${APP_VERSION} installed — ${updateLabel}`}
                  aria-label={`${updateLabel}. Open update details`}
                >
                  {APP_VERSION}
                  {needsImage ? (
                    <Icon name="alert" size={11} />
                  ) : (
                    <span className="size-1.5 rounded-full bg-accent-bright" aria-hidden="true" />
                  )}
                </button>
              ) : (
                <div
                  className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.14em] text-muted-dim"
                  title={`SeaDex Companion ${APP_VERSION}`}
                >
                  {APP_VERSION}
                </div>
              )}
              <div className="flex w-full flex-col items-center gap-2 border-t border-line pt-4">
                <span
                  className="grid size-9 place-items-center rounded-full bg-panel-raised text-muted"
                  title={username}
                >
                  <Icon name="user" size={17} />
                </span>
                <button
                  type="button"
                  onClick={onLogout}
                  aria-label="Log out"
                  title="Log out"
                  className="touch-target grid size-9 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-bad/10 hover:text-bad"
                >
                  <Icon name="log-out" size={18} />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex w-full flex-col gap-3 animate-fade">
              {update ? (
                <button
                  type="button"
                  onClick={() => setUpdateOpen(true)}
                  className={cx(
                    'flex cursor-pointer flex-col items-start gap-0.5 rounded-md px-1 text-left text-[10px] font-semibold tracking-[0.14em] hover:underline',
                    needsImage ? 'text-warn' : 'text-accent-bright',
                  )}
                  title={`SeaDex Companion ${APP_VERSION} installed — ${updateLabel}`}
                >
                  <span className="flex items-center gap-1.5">
                    {needsImage && <Icon name="alert" size={12} />}v{update.latest} available
                  </span>
                  {needsImage && <span className="tracking-normal text-muted">Needs a new Docker image</span>}
                </button>
              ) : (
                <div
                  className="px-1 text-[10px] font-semibold tracking-[0.14em] text-muted-dim"
                  title={`SeaDex Companion ${APP_VERSION}`}
                >
                  {APP_VERSION}
                </div>
              )}
              <div className="flex items-center gap-2.5 border-t border-line pt-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-panel-raised text-muted">
                  <Icon name="user" size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-ink" title={username}>
                    {username}
                  </div>
                  <div className="text-[11px] text-muted-dim">Administrator</div>
                </div>
                <button
                  type="button"
                  className="touch-target grid size-9 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-bad/10 hover:text-bad"
                  onClick={onLogout}
                  aria-label="Log out"
                  title="Log out"
                >
                  <Icon name="log-out" size={18} />
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>

      <header
        ref={mobileHeaderRef}
        className="mobile-header fixed inset-x-0 top-0 z-50 hidden min-h-16 items-center justify-between gap-3 border-b border-line bg-canvas-soft/95 px-4 py-2 backdrop-blur-xl max-[900px]:flex"
      >
        <Brand compact />
        <div className="flex items-center gap-3">
          {update && (
            <button
              type="button"
              onClick={() => setUpdateOpen(true)}
              aria-label={`${updateLabel}. Open update details`}
              className={cx(
                'touch-target inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold',
                needsImage ? 'border-warn/35 bg-warn/10 text-warn' : 'border-accent/35 bg-accent/12 text-accent-bright',
              )}
            >
              <Icon name={needsImage ? 'alert' : 'download'} size={15} />v{update.latest}
            </button>
          )}
          <button
            type="button"
            className="touch-target grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg border border-line bg-panel text-ink"
            onClick={onLogout}
            aria-label="Log out"
          >
            <Icon name="log-out" size={17} />
          </button>
        </div>
      </header>

      <nav
        ref={mobileNavRef}
        className="mobile-navigation app-scrollbar fixed inset-x-3 bottom-3 z-50 hidden min-h-16 items-center rounded-2xl border border-line-strong bg-panel-raised/95 px-2 py-1 shadow-card backdrop-blur-xl max-[900px]:flex"
        aria-label="Mobile navigation"
      >
        {NAV.map(item => (
          <button
            key={item.id}
            type="button"
            className={cx(
              'touch-target flex min-w-max flex-1 cursor-pointer flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs font-semibold transition-colors',
              tab === item.id ? 'bg-accent/12 text-ink' : 'text-muted',
            )}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => onTabChange(item.id)}
          >
            <Icon name={item.icon} size={19} />
            {item.label
              .replace('Configuration', 'Config')
              .replace('Server log', 'Log')
              .replace('Scan history', 'History')}
          </button>
        ))}
      </nav>

      {update && <UpdateDialog open={updateOpen} info={update} onClose={() => setUpdateOpen(false)} />}
    </>
  )
}

export default memo(TopBar)
