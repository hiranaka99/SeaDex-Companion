import { TabId, Status } from '../types'
import { cx } from '../styles'
import Icon, { IconName } from './Icons'

const NAV: { id: TabId; icon: IconName; label: string }[] = [
  { id: 'anime', icon: 'library', label: 'Library' },
  { id: 'config', icon: 'settings', label: 'Configuration' },
  { id: 'log', icon: 'logs', label: 'Server log' },
]

interface Props {
  tab: TabId
  onTabChange: (tab: TabId) => void
  status: Status
  username: string
  onLogout: () => void
  collapsed: boolean
  onToggleCollapsed: () => void
}

function StatusPill({ status, compact = false }: { status: Status; compact?: boolean }) {
  const tone = status.running ? 'text-accent-bright' : status.error ? 'text-bad' : status.last_run ? 'text-good' : 'text-muted'
  const dot = status.running ? 'animate-pulse-ring bg-accent' : status.error ? 'bg-bad' : status.last_run ? 'bg-good' : 'bg-muted-dim'
  return (
    <div className={cx('flex min-w-0 items-center gap-2 text-xs font-semibold', tone)} title={status.message || 'Idle'}>
      <span className={cx('size-2 shrink-0 rounded-full', dot)} />
      <span className={cx('truncate', compact ? 'max-w-28' : 'max-w-40')}>{status.running ? status.message || 'Scanning' : status.error ? 'Needs attention' : status.last_run ? 'System ready' : 'Ready to scan'}</span>
    </div>
  )
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <img src="/favicon.png" alt="" className={cx('rounded-xl border border-line-strong object-cover shadow-[0_8px_24px_rgba(79,140,255,0.16)]', compact ? 'size-9' : 'size-11')} />
      <div><div className={cx('font-extrabold tracking-tight text-ink', compact ? 'text-base' : 'text-lg')}>SeaDex</div><div className="text-[10px] font-semibold tracking-[0.18em] text-muted-dim uppercase">Companion</div></div>
    </div>
  )
}

function statusDotClass(status: Status): string {
  return status.running ? 'animate-pulse-ring bg-accent' : status.error ? 'bg-bad' : status.last_run ? 'bg-good' : 'bg-muted-dim'
}

export default function TopBar({ tab, onTabChange, status, username, onLogout, collapsed, onToggleCollapsed }: Props) {
  return (
    <>
      <aside className={cx('flex h-dvh flex-col border-r border-line bg-canvas-soft py-5 max-[900px]:hidden', collapsed ? 'items-center px-3' : 'px-4')}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-4 animate-fade">
            <img src="/favicon.png" alt="" className="size-9 rounded-xl border border-line-strong object-cover shadow-[0_8px_24px_rgba(79,140,255,0.16)]" />
            <button type="button" onClick={onToggleCollapsed} aria-label="Expand sidebar" title="Expand sidebar" className="grid size-8 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-panel hover:text-ink"><Icon name="chevron-right" size={18} /></button>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-2 animate-fade">
            <Brand />
            <button type="button" onClick={onToggleCollapsed} aria-label="Collapse sidebar" title="Collapse sidebar" className="ml-auto grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-panel hover:text-ink"><Icon name="chevron-left" size={18} /></button>
          </div>
        )}

        <nav className={cx('flex flex-col gap-1.5', collapsed ? 'mt-6' : 'mt-9')} aria-label="Primary navigation">
          {NAV.map((item) => (
            <button key={item.id} type="button" title={item.label} className={cx(
              'group flex cursor-pointer items-center gap-3 rounded-xl text-left text-sm font-semibold transition-all duration-300 ease-in-out',
              collapsed ? 'size-10 justify-center' : 'px-3.5 py-3',
              tab === item.id ? 'bg-accent/12 text-accent-bright' : 'text-muted hover:bg-panel hover:text-ink',
            )} aria-current={tab === item.id ? 'page' : undefined} onClick={() => onTabChange(item.id)}>
              <Icon name={item.icon} size={19} className={cx('shrink-0 transition-colors', tab === item.id ? 'text-accent-bright' : 'text-muted-dim group-hover:text-ink')} />
              {!collapsed && item.label}
            </button>
          ))}
        </nav>

        <div className={cx('mt-auto', collapsed && 'flex w-full flex-col items-center')}>
          {collapsed ? (
            <div className="flex w-full flex-col items-center gap-3 animate-fade">
              <div className="grid size-9 place-items-center rounded-lg" title={status.message || 'Idle'}>
                <span className={cx('size-2.5 rounded-full', statusDotClass(status))} />
              </div>
              <div className="flex w-full flex-col items-center gap-2 border-t border-line pt-4">
                <span className="grid size-9 place-items-center rounded-full bg-panel-raised text-muted" title={username}><Icon name="user" size={17} /></span>
                <button type="button" onClick={onLogout} aria-label="Log out" title="Log out" className="grid size-9 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-bad/10 hover:text-bad"><Icon name="log-out" size={18} /></button>
              </div>
            </div>
          ) : (
            <div className="flex w-full flex-col gap-3 animate-fade">
              <div className="rounded-xl border border-line bg-panel/70 p-3.5"><StatusPill status={status} /><p className="mt-2 mb-0 line-clamp-2 text-[11px] text-muted-dim">{status.message || 'No active tasks'}</p></div>
              <div className="flex items-center gap-2.5 border-t border-line pt-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-panel-raised text-muted"><Icon name="user" size={17} /></span>
                <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-ink" title={username}>{username}</div><div className="text-[11px] text-muted-dim">Administrator</div></div>
                <button type="button" className="grid size-9 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-bad/10 hover:text-bad" onClick={onLogout} aria-label="Log out" title="Log out"><Icon name="log-out" size={18} /></button>
              </div>
            </div>
          )}
        </div>
      </aside>

      <header className="fixed inset-x-0 top-0 z-50 hidden h-16 items-center justify-between border-b border-line bg-canvas-soft/95 px-4 backdrop-blur-xl max-[900px]:flex">
        <Brand compact />
        <div className="flex items-center gap-3"><StatusPill status={status} compact /><button type="button" className="grid size-9 cursor-pointer place-items-center rounded-lg border border-line bg-panel text-muted" onClick={onLogout} aria-label="Log out"><Icon name="log-out" size={17} /></button></div>
      </header>

      <nav className="fixed inset-x-3 bottom-3 z-50 hidden h-16 items-center justify-around rounded-2xl border border-line-strong bg-panel-raised/95 px-2 shadow-card backdrop-blur-xl max-[900px]:flex" aria-label="Mobile navigation">
        {NAV.map((item) => (
          <button key={item.id} type="button" className={cx('flex min-w-20 cursor-pointer flex-col items-center gap-1 rounded-xl px-3 py-2 text-[10px] font-bold transition-colors', tab === item.id ? 'bg-accent/12 text-accent-bright' : 'text-muted')} aria-current={tab === item.id ? 'page' : undefined} onClick={() => onTabChange(item.id)}><Icon name={item.icon} size={19} />{item.label.replace('Configuration', 'Config').replace('Server log', 'Log')}</button>
        ))}
      </nav>
    </>
  )
}
