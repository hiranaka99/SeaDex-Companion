import { TabId, Status } from '../types'

const NAV: { id: TabId; icon: string; label: string }[] = [
  { id: 'anime', icon: '🔍', label: 'Anime' },
  { id: 'config', icon: '⚙️', label: 'Config' },
  { id: 'log', icon: '📄', label: 'Log' },
]

interface Props {
  tab: TabId
  onTabChange: (t: TabId) => void
  status: Status
}

export default function Sidebar({ tab, onTabChange, status }: Props) {
  let pillClass = 'status-pill'
  if (status.running) pillClass += ' running'
  else if (status.error) pillClass += ' error'
  else if (status.last_run) pillClass += ' done'

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-icon">
          <img
            src="/favicon.png"
            alt="Zero Two"
            style={{ width: '100%', height: '100%', borderRadius: 12, objectFit: 'cover' }}
          />
        </div>
        <div>
          <h1>SeaDex</h1>
          <p>Companion</p>
        </div>
      </div>

      <nav className="nav">
        {NAV.map((n) => (
          <button
            key={n.id}
            className={'nav-btn' + (tab === n.id ? ' active' : '')}
            onClick={() => onTabChange(n.id)}
          >
            <span className="nav-icon">{n.icon}</span> {n.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className={pillClass}>
          <span className="dot" />
          <span>{status.message || 'Idle'}</span>
        </div>
      </div>
    </aside>
  )
}