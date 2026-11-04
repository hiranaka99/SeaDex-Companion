import { useEffect, useRef } from 'react'
import { releaseOwned } from '../../../shared/download-plan'
import type { Config, ResultItem } from '../types'
import { currentReleases, releaseCours, releaseQuality } from '../release-status'
import { buttonBase, cx } from '../styles'
import { IDLE_DOWNLOAD } from '../useCardDownloads'
import Icon from './Icons'
import type { DownloadEntry } from './DownloadsPanel'
import ReleaseDetails, { type DetailsDownloadState } from './ReleaseDetails'
import DetailsQuality from './DetailsQuality'

export function detailsSeasonName(season: ResultItem): string {
  return season.arr === 'Radarr' || season.season === 0 ? 'Movie' : typeof season.season === 'number' ? `Season ${season.season}` : 'Release'
}

function RecommendationNotes({ notes }: { notes?: string | null }) {
  if (!notes || notes === '-') return null
  return <details className="release-notes"><summary className="touch-target flex cursor-pointer items-center gap-1.5 py-2 text-xs font-semibold text-accent-bright"><Icon name="chevron-right" size={14}/>Why these releases?</summary><div className="max-w-[70ch] pb-3 whitespace-pre-line text-sm leading-relaxed text-muted wrap-anywhere">{notes}</div></details>
}

function CurrentRelease({ groups, unscoped = false }: { groups: string[]; unscoped?: boolean }) {
  return <span className="details-current-release"><span>{unscoped ? 'Season files: ' : 'Your release: '}</span><strong>{groups.length ? groups.join(', ') : 'None found'}</strong>{unscoped && <span> · cour ownership unconfirmed</span>}</span>
}

interface Props {
  sectionId: string
  r: ResultItem
  config: Config | null
  dl: Record<number, DetailsDownloadState>
  busyDownload: string | null
  onDownload: (release: number) => void
  onPause: (entry: DownloadEntry) => void
  onResume: (entry: DownloadEntry) => void
  onRemove: (entry: DownloadEntry) => void
  ruleBusy: string
  onToggleExclusion: (part: string, excluded: boolean) => void
  onCorrectMatch: () => void
}

export default function DetailsSeason({ sectionId, r, config, dl, busyDownload, onDownload, onPause, onResume, onRemove, ruleBusy, onToggleExclusion, onCorrectMatch }: Props) {
  const root = useRef<HTMLElement>(null)
  const groups = releaseCours(r)
  const split = groups.some(group => group.part)
  const seasonName = detailsSeasonName(r)
  const quality = releaseQuality(r)
  const ignored = Boolean(r.excluded)
  const sources = (r.urls?.length ? r.urls : r.url ? [{ label: 'seadex.moe', url: r.url }] : []).filter(source => source.label === 'seadex.moe')
  const activeReleases = Object.entries(dl).filter(([, state]) => state.phase !== 'idle' && state.phase !== 'complete').map(([index]) => index).join(',')

  useEffect(() => {
    if (!activeReleases || !root.current) return
    root.current.querySelector<HTMLDetailsElement>('.details-season-disclosure')!.open = true
    for (const index of activeReleases.split(',')) {
      let parent: HTMLElement | null = root.current.querySelector(`[data-release-index="${index}"]`)?.parentElement || null
      while (parent && parent !== root.current) {
        if (parent instanceof HTMLDetailsElement) parent.open = true
        parent = parent.parentElement
      }
    }
  }, [activeReleases])

  const exclusion = (part = '') => {
    const excluded = ignored || Boolean(part && r.excluded_parts?.includes(part))
    const name = part || seasonName
    return <button type="button" className={cx(buttonBase, 'min-h-11 min-w-0 max-w-full px-3 text-xs', excluded ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line bg-panel text-muted hover:bg-panel-raised hover:text-ink')} aria-pressed={excluded} aria-label={`${excluded ? 'Include' : 'Ignore'} ${name} in bulk downloads and notifications`} title={part && ignored ? 'Restore the season to change individual cour rules.' : !r.library_key ? 'Run a new scan to enable season rules' : undefined} disabled={!r.library_key || Boolean(ruleBusy) || Boolean(part && ignored)} onClick={() => onToggleExclusion(part, !excluded)}><Icon name="ban" size={15}/>{excluded ? 'Ignored for bulk' : 'Ignore for bulk'}</button>
  }

  const renderReleases = (items: typeof groups[number]['items']) => <div className="flex min-w-0 flex-col gap-3">{items.map(({ rel, index }) => <div key={index} data-release-index={index}>
    <ReleaseDetails result={r} release={rel} index={index} config={config} state={dl[index] || IDLE_DOWNLOAD} busy={busyDownload !== null} onDownload={() => onDownload(index)} onPause={onPause} onResume={onResume} onRemove={onRemove}/>
  </div>)}</div>

  return <section ref={root} id={sectionId} tabIndex={-1} className="details-season min-w-0" aria-label={seasonName} data-needs-review={quality.kind === 'review' || undefined}>
    <details className="details-season-disclosure">
      <summary className="details-summary cursor-pointer">
        <span className="min-w-0">
          <span className="details-season-name">{seasonName}</span>
          {split && r.precise_part_ownership ? <span className="details-current-release">Your releases:<span className="details-owned-cours">{groups.filter(group => group.part).map(group => <span key={group.part}>{group.part}: <strong>{currentReleases(r, group.part).join(', ') || 'None found'}</strong></span>)}</span></span> : <CurrentRelease groups={r.have} unscoped={split}/>}
          {(r.missing_episode_count || 0) > 0 && <span className="details-summary-note text-warn">{r.missing_episode_count} episode{r.missing_episode_count === 1 ? '' : 's'} missing</span>}
          {r.season_mapping_override && <span className="details-summary-note text-muted">Manual season match</span>}
          {ignored && <span className="details-summary-note text-warn">Ignored for bulk</span>}
          {!ignored && !!r.excluded_parts?.length && <span className="details-summary-note text-warn">Ignored for bulk: {r.excluded_parts.join(', ')}</span>}
          {activeReleases && <span className="details-summary-note text-accent-bright">Download activity · expand for controls</span>}
        </span>
        <DetailsQuality status={quality}/><Icon name="chevron-right" size={16} className="details-disclosure-chevron text-muted"/>
      </summary>
      <div className="details-season-content">
        {!split && (r.status === 'missing' || r.status === 'uncovered') && <p className="mb-3 text-sm text-muted">{quality.kind === 'review' ? 'Confirm the AniList match to check this release.' : r.status === 'uncovered' ? 'This season has no releases on SeaDex.' : 'Not listed on seadex.moe.'}</p>}
        {!split && <RecommendationNotes notes={r.notes}/>}
        {groups.length === 0 && r.status !== 'missing' && r.status !== 'uncovered' && <p className="mb-3 text-sm text-muted">No release details are available. Run a new library scan to refresh this title.</p>}
        {groups.map((cour, courIndex) => {
          if (!cour.part) return <div key="season">{renderReleases(cour.items)}</div>
          const courStatus = releaseQuality(r, cour)
          return <details id={`${sectionId}-cour-${courIndex}`} key={cour.part} className="details-cour" aria-label={`${seasonName} · ${cour.part}`}>
            <summary className="details-summary cursor-pointer"><span className="min-w-0"><span className="details-season-name">{cour.part}</span><CurrentRelease groups={currentReleases(r, cour.part)} unscoped={!r.precise_part_ownership}/>{r.excluded_parts?.includes(cour.part) && !ignored && <span className="details-summary-note text-warn">Ignored for bulk</span>}</span><DetailsQuality status={courStatus}/><Icon name="chevron-right" size={16} className="details-disclosure-chevron text-muted"/></summary>
            <div className="details-cour-content">
              {cour.unavailable && <p className="mb-3 text-sm text-muted wrap-anywhere">{cour.unavailable}</p>}
              {cour.items.length === 0 && !cour.unavailable && <p className="mb-3 text-sm text-muted">No release details are available for this cour.</p>}
              <RecommendationNotes notes={r.notes_by_part?.[cour.part]}/>
              {renderReleases(cour.items)}
              <div className="details-secondary-actions">{(r.urls || []).filter(source => source.label === cour.part).map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener" className="touch-target inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-accent-bright">SeaDex · {cour.part}<Icon name="chevron-right" size={14}/></a>)}{exclusion(cour.part)}</div>
            </div>
          </details>
        })}
        <details className="details-season-actions" open={quality.kind === 'review' || undefined}>
          <summary className="touch-target flex cursor-pointer items-center gap-1.5 py-2 text-xs font-semibold text-muted">{r.arr === 'Radarr' ? 'Movie actions' : 'Season actions'}<Icon name="more" size={16}/></summary>
          <div className="details-secondary-actions">
            {sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener" className="touch-target inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-accent-bright">SeaDex<Icon name="chevron-right" size={14}/></a>)}
            {r.arr === 'Sonarr' && !!r.season && <button type="button" className={cx(buttonBase, 'min-h-11 border-line bg-panel px-3 text-xs text-accent-bright hover:bg-panel-raised')} disabled={!r.library_key || Boolean(ruleBusy)} onClick={onCorrectMatch} aria-label={`${r.season_mapping_override ? 'Change' : 'Correct'} Season ${r.season} match`}><Icon name="refresh" size={15}/>{r.season_mapping_override ? 'Change season match' : 'Correct season match'}</button>}
            {r.arr === 'Sonarr' && !!r.season && r.anilist_id && <a href={`https://anilist.co/anime/${r.anilist_id}`} target="_blank" rel="noopener" className="touch-target inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-accent-bright" aria-label={`Open Season ${r.season} in AniList`}>AniList<Icon name="chevron-right" size={14}/></a>}
            {exclusion()}
          </div>
        </details>
        {r.precise_part_ownership && !split && r.have.length > 0 && r.releases.some(rel => rel.kind === 'best' && !releaseOwned(r, rel) && r.have.some(group => group.toLowerCase() === rel.releaseGroup.toLowerCase())) && <p className="mt-3 text-xs text-muted">The release group appears in your files, but complete ownership is not confirmed.</p>}
      </div>
    </details>
  </section>
}
