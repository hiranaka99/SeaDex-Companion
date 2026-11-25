import { useRef, useState } from 'react'
import type { ArrKind, ArrScopeOptions, LibraryScope } from '../../../shared/contracts'
import { scopeIsEmpty } from '../../../shared/settings'
import Icon from './Icons'
import { ListField, ToggleRow } from './config/parts'

interface Props {
  kind: ArrKind
  /** Name of the instance as the person knows it, for labels and messages. */
  appName: string
  scope: LibraryScope
  onChange: (scope: LibraryScope) => void
  /** The instance has a URL and an API key, so its tags and folders can be read. */
  canLoad: boolean
  loadOptions: () => Promise<ArrScopeOptions>
}

/** One sentence saying which part of an instance is scanned, shown while the editor is collapsed. */
export function describeScope(scope: LibraryScope | undefined, kind: ArrKind): string {
  if (!scope || scopeIsEmpty(scope)) return kind === 'sonarr' ? 'All series' : 'All movies'
  const parts = [
    scope.anime_only && kind === 'sonarr' ? 'anime series' : '',
    scope.include_tags.length ? `tagged ${scope.include_tags.join(', ')}` : '',
    scope.exclude_tags.length ? `not tagged ${scope.exclude_tags.join(', ')}` : '',
    scope.root_folders.length
      ? `in ${scope.root_folders.length === 1 ? scope.root_folders[0] : `${scope.root_folders.length} root folders`}`
      : '',
  ].filter(Boolean)
  return `Only ${parts.join(', ')}`
}

/**
 * Limits which titles of one Sonarr or Radarr instance are scanned. Tags and root folders are
 * read from the instance when the editor opens, so they are picked rather than retyped.
 */
export default function LibraryScopeEditor({ kind, appName, scope, onChange, canLoad, loadOptions }: Props) {
  const [options, setOptions] = useState<ArrScopeOptions | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)
  const titles = kind === 'sonarr' ? 'series' : 'movies'

  const load = async () => {
    if (!canLoad) return
    const current = ++request.current
    setLoading(true)
    setError('')
    try {
      const loaded = await loadOptions()
      if (current === request.current) setOptions(loaded)
    } catch (caught) {
      if (current === request.current)
        setError(caught instanceof Error ? caught.message : `Could not read tags and folders from ${appName}`)
    } finally {
      if (current === request.current) setLoading(false)
    }
  }

  return (
    <details
      className="group/scope text-xs"
      onToggle={event => {
        if (event.currentTarget.open && !options && !loading) void load()
      }}
    >
      <summary className="touch-target flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <Icon
          name="chevron-right"
          size={14}
          className="shrink-0 transition-transform duration-150 group-open/scope:rotate-90 motion-reduce:transition-none"
        />
        <span className="text-ink">Library scope</span>
        <span className="min-w-0 font-normal wrap-anywhere">{describeScope(scope, kind)}</span>
      </summary>
      <div className="flex flex-col gap-4 pt-3">
        <p className="m-0 leading-relaxed text-muted">
          Only {titles} matching every rule below are scanned. Leave everything empty to scan all {titles} in {appName}.
        </p>
        {kind === 'sonarr' && (
          <ToggleRow
            label="Only anime series"
            hint={`Series whose type is set to Anime in ${appName}.`}
            checked={scope.anime_only}
            onChange={anime_only => onChange({ ...scope, anime_only })}
          />
        )}
        <ListField
          label="Only with these tags"
          hint={`A ${kind === 'sonarr' ? 'series' : 'movie'} is scanned when it carries at least one of them.`}
          placeholder="anime, seadex"
          values={scope.include_tags}
          suggestions={options?.tags}
          suggestionsLabel={`Tags in ${appName}`}
          onChange={include_tags => onChange({ ...scope, include_tags: include_tags.map(tag => tag.toLowerCase()) })}
        />
        <ListField
          label="Skip these tags"
          hint="Wins over every other rule."
          placeholder="no-seadex"
          values={scope.exclude_tags}
          suggestions={options?.tags}
          suggestionsLabel={`Tags in ${appName} to skip`}
          onChange={exclude_tags => onChange({ ...scope, exclude_tags: exclude_tags.map(tag => tag.toLowerCase()) })}
        />
        <ListField
          label="Only in these root folders"
          hint={`As listed under Media Management in ${appName}.`}
          placeholder="/data/anime"
          values={scope.root_folders}
          suggestions={options?.root_folders}
          suggestionsLabel={`Root folders in ${appName}`}
          onChange={root_folders => onChange({ ...scope, root_folders })}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="status">
          {!canLoad && (
            <span className="text-muted-dim">
              Enter the URL and API key to pick from the tags and root folders in {appName}.
            </span>
          )}
          {canLoad && loading && (
            <span className="inline-flex items-center gap-2 text-muted">
              <span className="size-3.5 animate-spin rounded-full border-2 border-muted/30 border-t-accent motion-reduce:animate-none" />
              Reading tags and root folders from {appName}…
            </span>
          )}
          {canLoad && !loading && error && (
            <span className="text-bad wrap-anywhere">Could not read tags and root folders: {error}</span>
          )}
          {canLoad && !loading && options && !error && !options.tags.length && !options.root_folders.length && (
            <span className="text-muted-dim">{appName} has no tags or root folders yet.</span>
          )}
          {canLoad && !loading && (
            <button
              type="button"
              className="touch-target cursor-pointer rounded-lg px-2 py-1 font-semibold text-accent-bright hover:bg-accent/10"
              onClick={() => void load()}
            >
              {options || error ? 'Read again' : `Read from ${appName}`}
            </button>
          )}
        </div>
      </div>
    </details>
  )
}
