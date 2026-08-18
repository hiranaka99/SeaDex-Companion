import { useEffect, useRef, useState, ReactNode } from 'react'
import { GroupedCard, Release, ResultItem, Config } from '../types'
import { formatBytes, sizeDelta, seasonLabel, STATUS_LABEL } from '../utils'
import * as api from '../api'

const IconDL = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
    <path d="M11 3h2v9.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17V3z" />
    <path d="M4 19h16v2H4z" />
  </svg>
)

const IconOK = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={3.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path d="M4 12.5l5 5L20 6.5" />
  </svg>
)

const IconEye = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
)

const IconEyeOff = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path d="M3 3l18 18" />
    <path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6 0 9.5 7 9.5 7a17.4 17.4 0 0 1-2.9 3.9" />
    <path d="M6.6 6.6A16.8 16.8 0 0 0 2.5 12s3.5 7 9.5 7a9.7 9.7 0 0 0 4.4-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </svg>
)

interface CardProps {
  group: GroupedCard
  index: number
  config: Config | null
  hidden?: boolean
  onToggle: () => void
}

const HIDE_DURATION_MS = 280

export default function Card({ group, index, config, hidden = false, onToggle }: CardProps) {
  const [hiding, setHiding] = useState(false)
  const hideTimer = useRef<number | null>(null)
  const srcClass = group.arr === 'Sonarr' ? 'sonarr' : 'radarr'
  const st = group.status || 'upgrade'

  useEffect(() => {
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    }
  }, [])

  const handleHide = () => {
    if (hiding) return
    if (hidden) {
      onToggle()
      return
    }
    setHiding(true)
    hideTimer.current = window.setTimeout(onToggle, HIDE_DURATION_MS)
  }

  return (
    <article
      className={'card status-' + st + (hiding ? ' is-hiding' : '') + (hidden ? ' is-hidden' : '')}
      style={{ animationDelay: Math.min(index * 40, 400) + 'ms' }}
    >
      <div
        className="card-banner"
        style={group.banner ? { backgroundImage: `url('${group.banner}')` } : undefined}
      >
        {group.image && (
          <img
            className="card-img"
            src={group.image}
            alt=""
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        )}
        <span className={'card-source ' + srcClass}>{group.arr}</span>
        <span className={'card-status ' + st}>{STATUS_LABEL[st]}</span>
      </div>
      <div className="card-body">
        <div className="card-title-row">
          <div className="card-title">
            {group.anilist_id ? (
              <a href={`https://anilist.co/anime/${group.anilist_id}`} target="_blank" rel="noopener">
                {group.title}
              </a>
            ) : (
              group.title
            )}
          </div>
          <button
            className={'hide-btn' + (hidden ? ' is-hidden' : '')}
            type="button"
            title={hidden ? 'Show this card' : 'Hide this card'}
            aria-label={(hidden ? 'Show ' : 'Hide ') + group.title}
            onClick={handleHide}
            disabled={hiding}
          >
            {hidden ? <IconEyeOff /> : <IconEye />}
          </button>
        </div>
        {group.seasons.map((r) => (
          <Season key={r.key} r={r} config={config} />
        ))}
      </div>
    </article>
  )
}

interface SeasonProps {
  r: ResultItem
  config: Config | null
}

interface DisplayRelease {
  rel: Release
  index: number
}

/**
 * Older cached scan results can still contain one row per tracker.  The
 * backend now removes those duplicates, but deduplicating here as well keeps
 * the card correct until the next scan and preserves the original download
 * index used by the API.
 */
function uniqueReleases(releases: Release[]): DisplayRelease[] {
  const selected = new Map<string, DisplayRelease>()

  releases.forEach((rel, index) => {
    const key = `${rel.part || ''}\u0000${rel.releaseGroup.trim().toLowerCase()}`
    const current = selected.get(key)
    if (!current || (rel.downloadable && !current.rel.downloadable)) {
      selected.set(key, { rel, index })
    }
  })

  return [...selected.values()].sort((a, b) => a.index - b.index)
}

/**
 * Group consecutive display releases by their cour part label so each cour
 * can be rendered with its own header and a divider separates the cours.
 */
function groupByCour(releases: DisplayRelease[]): { part: string; items: DisplayRelease[] }[] {
  const groups: { part: string; items: DisplayRelease[] }[] = []
  for (const dr of releases) {
    const part = dr.rel.part || ''
    const last = groups[groups.length - 1]
    if (last && last.part === part) {
      last.items.push(dr)
    } else {
      groups.push({ part, items: [dr] })
    }
  }
  return groups
}

function Season({ r, config }: SeasonProps) {
  const [dlState, setDlState] = useState<Record<number, 'idle' | 'busy' | 'done'>>({})
  const st = r.status || 'upgrade'

  const handleDownload = async (release: number) => {
    setDlState((s) => ({ ...s, [release]: 'busy' }))
    try {
      const res = await api.download(r.key, release)
      if (res.ok) setDlState((s) => ({ ...s, [release]: 'done' }))
      else throw new Error(res.error || 'Download failed')
    } catch (e: any) {
      alert('Download failed: ' + e.message)
    }
    setTimeout(() => {
      setDlState((s) => ({ ...s, [release]: 'idle' }))
    }, 2500)
  }

  let middle: ReactNode
  if (st === 'missing') {
    middle = <div className="season-note">Not listed on releases.moe</div>
  } else if (st === 'uncovered') {
    middle = <div className="season-note">This season is not covered on releases.moe</div>
  } else {
    const displayReleases = uniqueReleases(r.releases || [])
    const courGroups = groupByCour(displayReleases)
    middle = (
      <>
        {courGroups.map((group, gi) => (
          <div key={group.part || 'all'} className="cour-block">
            {gi > 0 && <div className="cour-divider" role="separator" />}
            {group.part && (
              <div className="cour-header">
                <span className="cour-header-label">{group.part}</span>
              </div>
            )}
            <div className="releases">
              {group.items.map(({ rel, index }) => {
                const isBest = rel.kind === 'best'
                // Sonarr's size covers both cours, while a split-cour row only
                // covers one. Comparing those values would produce a bogus delta.
                const delta = rel.part ? '' : sizeDelta(rel.size, r.local_size)
                const owned = r.have.some((h) => h.toLowerCase() === rel.releaseGroup.toLowerCase())
                const cat = (config ? String((config as any)[((r.arr || '').toLowerCase() + '_category')] || '') : '').trim()
                const state = dlState[index] || 'idle'
                const disabled = owned || !rel.downloadable
                const btnTitle = owned
                  ? 'You already have this release'
                  : rel.downloadable
                  ? 'Send this release to qBittorrent (category: ' + (cat || r.arr) + ')'
                  : 'No magnet available (private tracker)'
                return (
                  <div
                    key={`${rel.part || ''}-${rel.releaseGroup}`}
                    className={'release-row ' + (isBest ? 'best' : 'alt') + (owned ? ' owned' : '')}
                  >
                    <span className="rel-kind" title={rel.part || undefined}>
                      {isBest ? 'Best' : 'Alt'}
                    </span>
                    <span className={'badge ' + (isBest ? 'best' : '')} title={rel.releaseGroup}>
                      {rel.releaseGroup}
                    </span>
                    <span className={'size ' + (isBest ? 'best' : '')} title="Size of this release">
                      {formatBytes(rel.size)}
                    </span>
                    {delta && (
                      <span className="size-delta" title="Difference: release size minus your local size">
                        {delta}
                      </span>
                    )}
                    <button
                      className={'dl-btn' + (disabled ? ' disabled' : '')}
                      disabled={disabled || state === 'busy'}
                      title={btnTitle}
                      onClick={() => !disabled && handleDownload(index)}
                    >
                      {owned || state === 'done' ? <IconOK /> : state === 'busy' ? '…' : <IconDL />}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {r.notes && r.notes !== '-' && (
          <div className="card-notes" title={r.notes}>
            {r.notes}
          </div>
        )}
      </>
    )
  }

  const have = r.have.length
    ? r.have.map((x, i) => (
        <span key={i} className="badge" title={x}>
          {x}
        </span>
      ))
    : [
        <span key="none" className="badge">
          none
        </span>,
      ]

  return (
    <div className="season">
      <div className="season-head">
        <span className="season-num">{seasonLabel(r)}</span>
        <span className="current-lbl">Current</span>
        <div className="have-wrap" title="Release groups you already have">
          {have}
        </div>
        {r.local_size ? (
          <span className="size" title="Size of your current files">
            {formatBytes(r.local_size)}
          </span>
        ) : null}
      </div>
      {middle}
      <div className="season-foot">
        <div className="season-links">
          {r.arr_url ? (
            <a
              className={'card-link arr-link ' + (r.arr === 'Sonarr' ? 'sonarr' : 'radarr')}
              href={r.arr_url}
              target="_blank"
              rel="noopener"
              title={'Open in ' + r.arr}
            >
              {r.arr} <span className="arr">↗</span>
            </a>
          ) : null}
          {(r.urls?.length ? r.urls : r.url ? [{ label: 'releases.moe', url: r.url }] : []).map(
            (source, i) => (
              <a
                className="card-link"
                href={source.url}
                target="_blank"
                rel="noopener"
                key={`${source.url}-${i}`}
              >
                {source.label === 'releases.moe' ? source.label : `SeaDEX ${source.label}`}{' '}
                <span className="arr">↗</span>
              </a>
            ),
          )}
        </div>
      </div>
    </div>
  )
}