import { TabId } from '../types'
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
  username: string
  onLogout: () => void
  collapsed: boolean
  onToggleCollapsed: () => void
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <img src="/favicon.png" alt="" className={cx('rounded-xl border border-line-strong object-cover shadow-[0_8px_24px_rgba(79,140,255,0.16)]', compact ? 'size-9' : 'size-11')} />
      <div><div className={cx('font-extrabold tracking-tight text-ink', compact ? 'text-base' : 'text-lg')}>SeaDex</div><div className="text-[10px] font-semibold tracking-[0.18em] text-muted-dim uppercase">Companion</div></div>
    </div>
  )
}

export default function TopBar({ tab, onTabChange, username, onLogout, collapsed, onToggleCollapsed }: Props) {
  return (
    <>
      <aside className={cx('flex h-dvh flex-col border-r border-line bg-canvas-soft py-5 max-[900px]:hidden', collapsed ? 'items-center px-3' : 'px-4')}>
        {collapsed ? (
          <button type="button" onClick={onToggleCollapsed} aria-label="Expand sidebar" title="Expand sidebar" className="relative mx-auto grid size-11 animate-fade cursor-pointer place-items-center rounded-xl transition-transform duration-300 hover:scale-105">
            <img src="/favicon.png" alt="" className="size-9 rounded-xl border border-line-strong object-cover shadow-[0_8px_24px_rgba(79,140,255,0.16)]" />
            <span className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full border border-line-strong bg-panel-raised text-muted shadow-card"><Icon name="chevron-right" size={12} /></span>
          </button>
        ) : (
          <div className="flex items-center gap-2 px-2 animate-fade">
            <Brand />
            <button type="button" onClick={onToggleCollapsed} aria-label="Collapse sidebar" title="Collapse sidebar" className="ml-auto grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-panel hover:text-ink"><Icon name="chevron-left" size={18} /></button>
          </div>
        )}

        <nav className="mt-9 flex flex-col gap-1.5" aria-label="Primary navigation">
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
              <div className="flex w-full flex-col items-center gap-2 border-t border-line pt-4">
                <span className="grid size-9 place-items-center rounded-full bg-panel-raised text-muted" title={username}><Icon name="user" size={17} /></span>
                <button type="button" onClick={onLogout} aria-label="Log out" title="Log out" className="grid size-9 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-bad/10 hover:text-bad"><Icon name="log-out" size={18} /></button>
              </div>
            </div>
          ) : (
            <div className="flex w-full flex-col gap-3 animate-fade">
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
        <div className="flex items-center gap-3"><button type="button" className="grid size-9 cursor-pointer place-items-center rounded-lg border border-line bg-panel text-muted" onClick={onLogout} aria-label="Log out"><Icon name="log-out" size={17} /></button></div>
      </header>

      <nav className="fixed inset-x-3 bottom-3 z-50 hidden h-16 items-center justify-around rounded-2xl border border-line-strong bg-panel-raised/95 px-2 shadow-card backdrop-blur-xl max-[900px]:flex" aria-label="Mobile navigation">
        {NAV.map((item) => (
          <button key={item.id} type="button" className={cx('flex min-w-20 cursor-pointer flex-col items-center gap-1 rounded-xl px-3 py-2 text-[10px] font-bold transition-colors', tab === item.id ? 'bg-accent/12 text-accent-bright' : 'text-muted')} aria-current={tab === item.id ? 'page' : undefined} onClick={() => onTabChange(item.id)}><Icon name={item.icon} size={19} />{item.label.replace('Configuration', 'Config').replace('Server log', 'Log')}</button>
        ))}
      </nav>
    </>
  )
}
