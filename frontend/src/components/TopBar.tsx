import { TabId, Status } from '../types'
import { cx } from '../styles'

const NAV: { id: TabId; icon: string; label: string }[] = [
  { id: 'anime', icon: '🔍', label: 'Anime' },
  { id: 'config', icon: '⚙️', label: 'Config' },
  { id: 'log', icon: '📄', label: 'Log' },
]

interface Props {
  tab: TabId
  onTabChange: (t: TabId) => void
  status: Status
  username: string
  onLogout: () => void
}

export default function TopBar({ tab, onTabChange, status, username, onLogout }: Props) {
  const statusTone = status.running
    ? 'border-line-strong text-ink'
    : status.error
      ? 'border-bad/40 text-bad'
      : status.last_run
        ? 'border-line text-good'
        : 'border-line text-muted'
  const dotTone = status.running
    ? 'animate-pulse-ring bg-accent'
    : status.error
      ? 'bg-bad'
      : status.last_run
        ? 'bg-good'
        : 'bg-muted-dim'

  return (
    <header className="sticky top-0 z-50 flex items-center gap-5 border-b border-line bg-linear-to-b from-canvas-soft to-canvas px-6 py-3 shadow-[0_6px_18px_rgba(0,0,0,0.25)] max-[820px]:flex-wrap max-[820px]:gap-x-4 max-[820px]:gap-y-2.5 max-[820px]:px-4 max-[820px]:py-2.5">
      <div className="flex shrink-0 items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl border border-line-strong bg-accent/15 text-2xl shadow-[inset_0_0_20px_rgba(79,140,255,0.15)]">
          <img
            src="/favicon.png"
            alt="Zero Two"
            className="size-full rounded-xl object-cover"
          />
        </div>
        <div>
          <h1 className="m-0 text-[19px] leading-[1.1] font-extrabold tracking-[0.3px]">SeaDex</h1>
          <p className="m-0 text-[10.5px] tracking-[2px] text-muted uppercase max-[820px]:hidden">Companion</p>
        </div>
      </div>

      <nav className="flex flex-row gap-2 max-[820px]:flex-1">
        {NAV.map((n) => (
          <button
            key={n.id}
            className={cx(
              'flex cursor-pointer items-center gap-[9px] whitespace-nowrap rounded-control border px-4 py-[9px] text-left text-[14.5px] font-semibold text-muted transition-all duration-150 hover:bg-panel hover:text-ink max-[820px]:px-3 max-[820px]:py-2 max-[820px]:text-[13.5px]',
              tab === n.id ? 'border-line-strong bg-accent/15 text-ink' : 'border-transparent bg-transparent',
            )}
            onClick={() => onTabChange(n.id)}
          >
            <span className="text-base">{n.icon}</span> {n.label}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div className={cx('flex items-center gap-[9px] rounded-control border bg-panel px-3 py-2.5 text-[13px] max-[820px]:px-2.5 max-[820px]:py-2 max-[820px]:text-xs', statusTone)}>
          <span className={cx('size-[9px] shrink-0 rounded-full', dotTone)} />
          <span>{status.message || 'Idle'}</span>
        </div>
        <span className="max-w-32 truncate px-1 text-xs text-muted max-[620px]:hidden" title={username}>{username}</span>
        <button
          className="cursor-pointer rounded-control border border-line bg-panel px-3 py-2.5 text-xs font-semibold text-muted transition-colors hover:border-line-strong hover:text-ink max-[820px]:py-2"
          type="button"
          onClick={onLogout}
        >
          Log out
        </button>
      </div>
    </header>
  )
}
