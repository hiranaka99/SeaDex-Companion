#!/usr/bin/env node
// Replays SeaDex catalog entries through the scan's season assessment and prints each part's listing.
// It runs the compiled code in dist/, so start it with `npm run replay:seadex -- …`, which builds first.
// See docs/development.md ("Replaying SeaDex entries").
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const usage = `Usage: npm run replay:seadex -- --alid <id,id…> --episodes <n,n…> [options]

  --alid       AniList IDs of the season's SeaDex entries, one per part, in order
  --episodes   AniList episode count of each part, in the same order
  --season     Sonarr season number (default 1)
  --season-episodes
               Episodes the Sonarr season has under the series' episode order (default: the parts' total)
  --order      The series' episode order as Sonarr v5 names it: official, dvd… (default: none, as with Sonarr v3)
  --own        Release groups the library holds for the whole season, comma separated
  --own-files  Release groups whose listed files the library holds byte for byte, comma separated
  --trackers   public, private or reachable (default: the app's default)
  --from       Read the SeaDex entries from a saved JSON file instead of seadex.moe
  --save       Write the fetched SeaDex entries to a JSON file, such as a test fixture`

const { values } = parseArgs({
  options: {
    alid: { type: 'string' },
    episodes: { type: 'string' },
    season: { type: 'string', default: '1' },
    'season-episodes': { type: 'string' },
    order: { type: 'string' },
    own: { type: 'string' },
    'own-files': { type: 'string' },
    trackers: { type: 'string' },
    from: { type: 'string' },
    save: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})
const numbers = text => (text || '').split(',').filter(Boolean).map(Number)
const alids = numbers(values.alid)
const episodes = numbers(values.episodes)
const season = Number(values.season)
const seasonEpisodes = values['season-episodes'] === undefined ? undefined : Number(values['season-episodes'])
const TRACKER_MODES = ['public', 'private', 'reachable']
const valid =
  alids.length > 0 &&
  alids.length === episodes.length &&
  [...alids, ...episodes, season].every(Number.isSafeInteger) &&
  (seasonEpisodes === undefined || (Number.isSafeInteger(seasonEpisodes) && seasonEpisodes > 0)) &&
  (!values.trackers || TRACKER_MODES.includes(values.trackers))
if (values.help || !valid) {
  console.log(usage)
  process.exit(values.help ? 0 : 2)
}

const { replayCatalog } = await import('../dist/tests/support/seadex-replay.js')
const { episodeRangeLabel } = await import('../dist/shared/releases.js')

async function fetchEntries() {
  const { SEADEX, fetchWithTimeout } = await import('../dist/server/http.js')
  const filter = alids.map(id => `alID=${id}`).join('||')
  const url = `${SEADEX}/collections/entries/records?filter=(${encodeURIComponent(filter)})&perPage=500&expand=trs`
  const response = await fetchWithTimeout(url, {}, 30_000)
  if (!response.ok) throw new Error(`SeaDex answered ${response.status} for ${url}`)
  return (await response.json()).items
}

// A saved file holds `{ items }` as the API answers, or the bare list of entries.
const saved = values.from ? JSON.parse(readFileSync(values.from, 'utf8')) : null
const items = saved ? (Array.isArray(saved) ? saved : saved.items) : await fetchEntries()
if (!Array.isArray(items)) {
  console.error(`${values.from || 'SeaDex'} holds no list of SeaDex entries`)
  process.exit(2)
}
if (values.save) writeFileSync(values.save, `${JSON.stringify({ items }, null, 2)}\n`)
const missing = alids.filter(id => !items.some(item => Number(item.alID) === id))
if (missing.length) console.log(`SeaDex lists no entry for AniList ${missing.join(', ')}`)

const { result, violations } = await replayCatalog(items, {
  season,
  parts: alids.map((alid, index) => ({ alid, episodes: episodes[index] })),
  ...(seasonEpisodes !== undefined ? { seasonEpisodes } : {}),
  ...(values.order ? { episodeOrder: values.order } : {}),
  own: (values.own || '').split(',').filter(Boolean),
  ownFiles: (values['own-files'] || '').split(',').filter(Boolean),
  ...(values.trackers ? { trackers: values.trackers } : {}),
})

console.log(`Season ${result.season}: ${result.status}${result.best_group ? ` · best ${result.best_group}` : ''}`)
for (const part of result.unavailable_parts || []) console.log(`  ${part.label}: ${part.reason}`)
let heading = null
for (const release of result.releases) {
  const part = release.part || 'Season'
  if (part !== heading) console.log((heading = part))
  const selected = release.selected_files || []
  const scope =
    release.excluded_kind === 'episode_order'
      ? 'never downloaded'
      : selected.length
        ? `${episodeRangeLabel(selected) || 'unlabelled episodes'} · ${selected.length} files`
        : 'whole torrent'
  const flags = [
    release.target && 'target',
    release.files_match && 'files match',
    !release.torrent_available && 'private',
    release.excluded_by && `excluded (${release.excluded_kind || 'preferences'}): ${release.excluded_by}`,
  ].filter(Boolean)
  console.log(`  ${release.kind.padEnd(4)} ${release.releaseGroup} (${release.tracker}) · ${scope}`)
  if (flags.length) console.log(`       ${flags.join(' · ')}`)
}
if (violations.length) {
  console.log('\nListing rules broken:')
  for (const violation of violations) console.log(`  ${violation}`)
  process.exitCode = 1
} else console.log('\nListing rules: kept')
