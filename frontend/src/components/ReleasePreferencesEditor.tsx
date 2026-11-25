import { useId } from 'react'
import type { ReleasePreferences, TrackerMode } from '../../../shared/contracts'
import { control, cx } from '../styles'
import { ListField, ToggleRow, subheading } from './config/parts'

interface Props {
  preferences: ReleasePreferences
  /** Whether owned releases are checked against the listed file sizes. */
  verify: boolean
  trackerMode: TrackerMode
  onChange: (preferences: ReleasePreferences) => void
  onVerifyChange: (verify: boolean) => void
  onTrackerModeChange: (mode: TrackerMode) => void
  /** Trackers that appear in the current library results, offered as one-click choices. */
  knownTrackers: string[]
}

const TRACKER_MODES: [TrackerMode, string, string][] = [
  [
    'public',
    'Public trackers only',
    'Releases that need a private-tracker account are left out. This is SeaDex Companion’s default.',
  ],
  [
    'private',
    'Include private trackers',
    'Releases from private trackers are listed too. You download those from the tracker yourself.',
  ],
]

const TARGETS: [ReleasePreferences['size'], string, string][] = [
  ['largest', 'Largest release', 'Usually the remux or highest-bitrate encode. This is SeaDex Companion’s default.'],
  ['smallest', 'Smallest release', 'Usually the encode, when SeaDex lists it beside a remux.'],
]

/**
 * Chooses the download target among the releases SeaDex lists, and what counts as already
 * having the best release. Flat rows, in the order a person decides them: which trackers count,
 * what to aim for, what to leave out, then how strictly the library is judged.
 */
export default function ReleasePreferencesEditor({
  preferences,
  verify,
  trackerMode,
  onChange,
  onVerifyChange,
  onTrackerModeChange,
  knownTrackers,
}: Props) {
  const trackersId = useId()
  const targetId = useId()
  const limitId = useId()
  const set = <K extends keyof ReleasePreferences>(key: K, value: ReleasePreferences[K]) =>
    onChange({ ...preferences, [key]: value })
  const option =
    'flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-line bg-canvas-soft p-4 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10'
  return (
    <>
      <div>
        <h3 id={trackersId} className={subheading}>
          Trackers
        </h3>
        <p className="mt-1 mb-3 text-xs text-muted">
          SeaDex lists releases from public and private trackers. Choose which ones the library is judged against.
        </p>
        <div role="radiogroup" aria-labelledby={trackersId} className="grid gap-2 md:grid-cols-2">
          {TRACKER_MODES.map(([value, label, hint]) => (
            <label key={value} className={option}>
              <input
                type="radio"
                name="tracker_mode"
                className="mt-0.5 size-4 shrink-0 accent-accent"
                checked={trackerMode === value}
                onChange={() => onTrackerModeChange(value)}
              />
              <span className="min-w-0">
                <span className="block font-semibold text-ink">{label}</span>
                <span className="mt-1 block text-xs text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="border-t border-line pt-6">
        <h3 id={targetId} className={subheading}>
          Download target
        </h3>
        <p className="mt-1 mb-3 text-xs text-muted">
          SeaDex often lists more than one best release for a season. Choose which one is offered for download.
        </p>
        <div role="radiogroup" aria-labelledby={targetId} className="grid gap-2 md:grid-cols-2">
          {TARGETS.map(([value, label, hint]) => (
            <label key={value} className={option}>
              <input
                type="radio"
                name="release_target_size"
                className="mt-0.5 size-4 shrink-0 accent-accent"
                checked={preferences.size === value}
                onChange={() => set('size', value)}
              />
              <span className="min-w-0">
                <span className="block font-semibold text-ink">{label}</span>
                <span className="mt-1 block text-xs text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <ToggleRow
        label="Prefer dual audio"
        hint="Whenever SeaDex lists a dual-audio release for a season, that release becomes the target."
        checked={preferences.dual_audio}
        onChange={checked => set('dual_audio', checked)}
      />
      <div className="grid gap-5 border-t border-line pt-6 md:grid-cols-2">
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <label htmlFor={limitId} className="text-xs font-semibold text-ink">
            Size limit per episode
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={limitId}
              aria-describedby={limitId + '-hint'}
              className={cx(control, 'no-spinner w-28 bg-canvas-soft')}
              type="number"
              inputMode="decimal"
              min="0"
              max="1000"
              step="0.1"
              placeholder="No limit"
              value={preferences.max_episode_gb > 0 ? preferences.max_episode_gb : ''}
              onChange={event => set('max_episode_gb', Math.max(0, Number(event.target.value) || 0))}
            />
            <span className="text-xs font-semibold text-ink">GB</span>
          </div>
          <span id={limitId + '-hint'} className="text-xs text-muted-dim">
            Releases above this average episode size are never offered. Leave empty for no limit. Movies are not
            limited.
          </span>
        </div>
        <ListField
          label="Ignored release groups"
          hint="Never offered for download. Use the names SeaDex shows."
          placeholder="Group A, Group B"
          values={preferences.ignored_groups}
          onChange={ignored_groups => set('ignored_groups', ignored_groups)}
        />
        <ListField
          label="Ignored trackers"
          hint="Releases that exist only on these trackers are never offered."
          placeholder="Tracker name"
          values={preferences.ignored_trackers}
          suggestions={knownTrackers}
          suggestionsLabel="Trackers in your library results"
          onChange={ignored_trackers => set('ignored_trackers', ignored_trackers)}
        />
      </div>
      <div className="space-y-5 border-t border-line pt-6">
        <ToggleRow
          label="Alternatives are good enough"
          hint="A season counts as best when you own a release SeaDex lists as an alternative. An alternative can become the target when no best release fits the rules above."
          checked={preferences.accept_alternatives}
          onChange={checked => set('accept_alternatives', checked)}
        />
        <ToggleRow
          label="Only my target counts as best"
          hint="Off: owning any best release settles a season, and these preferences only choose what to download. On: a season where you own a different best release becomes upgradable to your target."
          checked={preferences.strict}
          onChange={checked => set('strict', checked)}
        />
        <ToggleRow
          label="Check owned releases by file size"
          hint="Your files count as a release only when their sizes match the files SeaDex lists for it. Files that carry the right release group but differ in size make the season upgradable. Turn this off if your files are changed after import, for example remuxed or stripped of tracks."
          checked={verify}
          onChange={onVerifyChange}
        />
      </div>
      <p className="m-0 text-xs text-muted">Changes take effect with the next library scan.</p>
    </>
  )
}
