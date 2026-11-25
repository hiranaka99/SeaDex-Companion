import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Icon, { type IconName } from '../Icons'
import { cx } from '../../styles'

export type SettingsTabId =
  'library' | 'downloads' | 'preferences' | 'notifications' | 'automation' | 'general' | 'maintenance'

export const SETTINGS_TABS: { id: SettingsTabId; label: string; icon: IconName }[] = [
  { id: 'library', label: 'Library sources', icon: 'server' },
  { id: 'downloads', label: 'Downloads', icon: 'download' },
  { id: 'preferences', label: 'Release preferences', icon: 'filter' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'automation', label: 'Automation', icon: 'clock' },
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'maintenance', label: 'Maintenance', icon: 'hard-drive' },
]

export const settingsTabId = (base: string, tab: SettingsTabId) => `${base}-tab-${tab}`
export const settingsPanelId = (base: string, tab: SettingsTabId) => `${base}-panel-${tab}`

/**
 * The configuration groups as tabs. Selection follows focus, so arrow keys move between groups directly;
 * a tab whose group needs attention carries an alert glyph and says so to assistive technology.
 */
export function SettingsTabs({
  base,
  active,
  attention,
  onSelect,
}: {
  base: string
  active: SettingsTabId
  attention: Partial<Record<SettingsTabId, boolean>>
  onSelect: (tab: SettingsTabId) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)
  const [edges, setEdges] = useState({ start: true, end: true })
  const tabElement = (tab: SettingsTabId) => document.getElementById(settingsTabId(base, tab))
  const measureEdges = () => {
    const box = scroller.current
    if (box) setEdges({ start: box.scrollLeft <= 1, end: box.scrollLeft + box.clientWidth >= box.scrollWidth - 1 })
  }

  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const measure = () => {
      const tab = element.querySelector<HTMLElement>('[aria-selected="true"]')
      if (tab) setIndicator({ left: tab.offsetLeft, width: tab.offsetWidth })
      measureEdges()
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (scroller.current) observer.observe(scroller.current)
    return () => observer.disconnect()
  }, [active])

  // On a narrow strip, bring the selected tab into view by scrolling the strip only, never the page.
  useLayoutEffect(() => {
    const box = scroller.current
    const tab = tabElement(active)
    if (!box || !tab) return
    const left = tab.offsetLeft - 16
    const right = tab.offsetLeft + tab.offsetWidth + 16 - box.clientWidth
    if (box.scrollLeft > left) box.scrollLeft = left
    else if (box.scrollLeft < right) box.scrollLeft = right
  }, [active])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = SETTINGS_TABS.findIndex(tab => tab.id === active)
    const last = SETTINGS_TABS.length - 1
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % SETTINGS_TABS.length
        : event.key === 'ArrowLeft'
          ? (index + last) % SETTINGS_TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1
    if (next < 0) return
    event.preventDefault()
    const tab = SETTINGS_TABS[next].id
    onSelect(tab)
    tabElement(tab)?.focus()
  }

  return (
    <div
      ref={scroller}
      onScroll={measureEdges}
      data-fade-start={edges.start ? undefined : ''}
      data-fade-end={edges.end ? undefined : ''}
      className="settings-tabs-scroller overflow-x-auto"
    >
      <div
        ref={list}
        role="tablist"
        aria-label="Configuration sections"
        onKeyDown={onKeyDown}
        className="relative flex w-max min-w-full gap-1"
      >
        {SETTINGS_TABS.map(tab => {
          const selected = tab.id === active
          const flagged = Boolean(attention[tab.id])
          return (
            <button
              key={tab.id}
              id={settingsTabId(base, tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={settingsPanelId(base, tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              className={cx(
                'settings-tab flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-t-control px-3.5 text-sm font-semibold whitespace-nowrap transition-colors duration-150 motion-reduce:transition-none',
                selected ? 'text-ink' : 'text-muted hover:bg-panel/70 hover:text-ink',
              )}
            >
              <Icon
                name={tab.icon}
                size={16}
                className={cx('shrink-0', selected ? 'text-accent-bright' : 'text-muted-dim')}
              />
              {tab.label}
              {flagged && (
                <>
                  <Icon name="alert" size={14} className="shrink-0 text-bad" />
                  <span className="sr-only">, needs attention</span>
                </>
              )}
            </button>
          )
        })}
        {indicator && (
          <span
            aria-hidden="true"
            className="settings-tab-indicator pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-accent"
            style={{ left: indicator.left, width: indicator.width }}
          />
        )}
      </div>
    </div>
  )
}

/** One configuration group. Every panel stays mounted so the draft, validation, and nested disclosures persist. */
export function SettingsPanel({
  base,
  tab,
  active,
  children,
}: {
  base: string
  tab: SettingsTabId
  active: boolean
  children: ReactNode
}) {
  const label = SETTINGS_TABS.find(entry => entry.id === tab)?.label
  return (
    <section
      id={settingsPanelId(base, tab)}
      role="tabpanel"
      aria-labelledby={settingsTabId(base, tab)}
      data-settings-tab={tab}
      hidden={!active}
      className="settings-panel space-y-6 pt-6 pb-3"
    >
      <h2 className="sr-only">{label}</h2>
      {children}
    </section>
  )
}
