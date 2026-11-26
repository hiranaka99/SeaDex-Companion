# Usenet finder implementation plan

## Purpose and status

Not implemented. This document is an implementation handoff. It turns the Prowlarr file-list search from a click-per-release, memory-only feature for private-tracker releases into a general, persisted Usenet finder for every release the hash indexers do not carry, and it closes the defects found while reviewing that path.

It amends section 16 of the [Usenet implementation plan](usenet-implementation-plan.md). Where the two disagree, this plan wins once the phase that changes the behavior has shipped. Everything else in that plan still applies, including its boundaries, its security rules (section 11) and the UI workflow (section 10).

Source references are to commit `d423a3b`. Reinspect the current source before editing, because line numbers move.

## 1. Evidence

### The library this was measured on

Measured on 2026-11-26 from the saved scan results and Usenet cache of a real installation (134 library items, 222 results, 325 listed releases), with no requests to its indexers.

| Torrent size | Hashes | AnimeTosho | AmeNZB | Neither | Covered |
| --- | --- | --- | --- | --- | --- |
| Under 8 GiB | 107 | 77 | 6 | 24 | 78% |
| 8–16 GiB | 50 | 34 | 8 | 8 | 84% |
| 16–32 GiB | 93 | 35 | 42 | 16 | 83% |
| 32–64 GiB | 53 | 10 | 28 | 15 | 72% |
| 64 GiB and over | 70 | 4 | 15 | 51 | 27% |
| All | 373 | 160 | 99 | 114 | 69% |

- **Actionable releases:** of the 35 target releases on upgrade and partial results, 6 have a hash-linked NZB, 21 are public but missed by both hash indexers, and 8 exist only on AnimeBytes. For 29 of 35, Usenet acquisition depends on the file-list search.
- **Eligibility:** all 114 missed hashes have a complete file list, so each can be searched by file list. With the 22 private-only releases, 123 listed releases need a search.
- **Queries:** the current code would send 392 queries for those 123 releases, each to every Usenet indexer. The group plus the library title matches the release's own file names for 95 of them, and one of the four searched titles matches for 115.
- **Groups:** 40 of the 123 have a release group of three characters or fewer once punctuation is removed (`sam`, `fig`, `uba`, `ZR`). Seven have file names that do not contain the group at all.
- **Pacing:** during a 325-release sweep, AnimeTosho rate limited the installation ten times in 14 minutes at the fixed 2-second spacing.
- **Prowlarr:** version 3.0.2 with two Usenet indexers and no private torrent indexer. The private torrent path cannot work on this installation.

### Prowlarr behavior, read from its source

Read from the `develop` branch of Prowlarr. Phase 0 confirms each point against a running instance.

| Fact | Source | Consequence |
| --- | --- | --- |
| `/api/v1/search` returns an empty list when an indexer throws or is at its query limit | `ReleaseSearchService.DispatchIndexer` | An empty answer is not proof of absence, and a search almost never carries `Retry-After` |
| The per-indexer Newznab endpoint (`/{id}/api`, also `/api/v1/indexer/{id}/newznab`) answers 429 with `Retry-After` when the indexer is disabled or at its query limit, and 410 when it is turned off | `NewznabController.GetNewznabResponse` | One indexer per request makes failures attributable |
| A Usenet download always redirects to the indexer's own link | `NewznabController.GetDownload` | NZB fetch failures come from the indexer, not from Prowlarr |
| A redirected download is recorded as a grab | `DownloadService.RecordRedirect`, `HistoryService` | Prowlarr's own grab limit counts Companion's fetches |
| Download links have the form `/{id}/download?apikey=…&link=…&file=…` | `DownloadMappingService.ConvertToProxyLink` | The stored reference must drop `apikey` |
| The API key is read from the `apikey` query parameter, then a header | `ApiKeyAuthenticationHandler` | Header authentication should work on the Newznab endpoint; confirm live |
| Results carry `files`, `grabs`, `pubDate` and categories | `ReleaseResource`, `NewznabResults` | Usable for ranking |
| Results outside the requested categories are dropped, and indexers that do not support them are skipped | `ReleaseSearchService.Dispatch` | Category filters reduce recall |
| The indexer list carries `capabilities`, `status.disabledTill` and the `baseSettings.queryLimit`, `baseSettings.grabLimit` and `baseSettings.limitsUnit` fields | `IndexerResource`, `IndexerBaseSettings` | Limits and outages can be read without a search |
| ID search exists (`t=tvsearch&tvdbid=…&season=…`) | `NewznabRequest` | Deferred; results carry no TVDB or TMDB ID today |

### NZB size calibration

Eight public AnimeTosho NZBs were compared with the exact file sizes AnimeTosho reports for the same entries.

- In seven posts (77 video files), every subject stated the exact file size, and the sum of a file's `<segment bytes>` was 1.030 to 1.032 times its size. Within one post the ratio varied by at most 0.18%.
- The eighth post packed 25 torrent files into a single archive of 9 NZB files. Nothing but the total size can be compared for such a post.
- Only AnimeTosho's own posts were measured. Other posters use other line lengths and article sizes, so the accepted range in section 9 is wider than the measured one and is validated from real fetches (section 9, calibration).

## 2. Decisions

### Confirmed by the user on 2026-11-26

1. A near-exact match is sent automatically and labelled as near-exact.
2. Bulk review may fetch one NZB for each selected release, within a daily limit per indexer.

### Recommended defaults, not yet confirmed

Implement these as written unless the user decides otherwise.

3. Background search is off by default. An installation that already uses Prowlarr must not start contacting indexers on its own after an update (decision 9 of the Usenet plan).
4. Default limits are 100 background searches and 20 NZB fetches per indexer per 24 hours. Both are editable, and 0 means no limit from Companion.
5. Tracker credentials stay in Prowlarr. Companion does not store a tracker passkey.
6. The new tracker choice in section 13 is opt-in. The default stays **Include private trackers**.

### Not built

- Looking up public copies of private releases on AnimeTosho, or indexing its database export. About one private-only release in ten has a public copy.
- Checking articles or PAR2 files over NNTP, NZBHydra2, or letting Sonarr or Radarr search and grab.
- ID-based search. It needs TVDB and TMDB IDs on results, which scans do not capture. Revisit after the measurement gate in phase 4.

### Section 16 decisions this plan replaces

| Section 16 | Replaced by |
| --- | --- |
| Decision 3: at most three candidates are fetched per release | Three for an explicit search or a single download; one per source for a bulk review |
| Decision 4: an NZB is accepted only with every name and exact size in its subjects | The proof levels in section 9 |
| Decision 6: a Usenet search runs only when asked, and bulk review blocks unsearched rows | Searching is free and may run in the background; bulk review verifies the rows the user selected |
| Decision 8 and the caching table: observations live in memory | Section 14 |

### Kept

- The hash chain runs first. A failed or still-processing hash lookup never falls back to Prowlarr.
- Public-tracker mode never searches Prowlarr for private-tracker releases.
- Indexer titles and sizes only choose candidates. A candidate's own content decides.
- A candidate the user chooses by hand still needs the explicit confirmation in release details.
- SABnzbd owns article retrieval. A whole-source NZB still needs the whole-source acknowledgement.
- UI work follows section 10 of the Usenet plan.

## 3. Gaps and where each is closed

| # | Gap | Where | Phase |
| --- | --- | --- | --- |
| G1 | An indexer that refuses an NZB fetch is read as a bad candidate. The search is cached as "no match" for six hours and the other candidates are still tried | `prowlarrDownload` (`server/prowlarr.ts`), `findNzb` (`server/private-sources.ts`) | 1 |
| G2 | A Prowlarr failure loses its `Retry-After` and is retried after one minute | `failed()` and `TTL.failure` in `server/private-sources.ts` | 1 |
| G3 | Group matching is a substring test | `plausible` in `findNzb` | 1 |
| G4 | Radarr rows search category 2000 only, which hides anime filed under TV | `searchCategories` (`server/search-titles.ts`) | 1 |
| G5 | Every title is searched with no early stop, in an order that ignores the release's own file names | `findNzb`, `searchTitles` | 1 |
| G6 | A candidate must carry the group in its title, although some releases never do | `plausible` in `findNzb` | 1 |
| G7 | AnimeTosho pacing is fixed and keeps hitting the rate limit | `LookupScheduler` (`server/usenet-scheduler.ts`) | 1 |
| G8 | Results live in memory with 6 and 12 hour lifetimes; a restart forgets them | `nzbs` map in `server/private-sources.ts` | 2 |
| G9 | An NZB dropped from the 128 MB memory budget is fetched a second time on submission | `privateNzbBytes` | 2 |
| G10 | A failed or limited indexer looks like an empty answer | `searchProwlarr` (`/api/v1/search`) | 3 |
| G11 | The scheduler and its pause reporting are typed to the two hash indexers | `LookupScheduler`, `UsenetPrefetchProgress`, `usenetPauseText` (`frontend/src/utils.ts`) | 3 |
| G12 | Nothing limits how many searches or fetches Companion spends per indexer per day | none today | 3 |
| G13 | Searching and fetching are one step, so nothing can run in the background | `findNzb` | 3, 4 |
| G14 | The background sweep covers hash lookups only | `server/usenet-prefetch.ts` | 4 |
| G15 | Only posts with exact sizes in their subjects can be proven | `nzbFiles`, `nzbHasFiles` (`server/source-files.ts`) | 5 |
| G16 | Archive-packed and obfuscated posts are indistinguishable from wrong releases | `nzbFileMatches` | 5 |
| G17 | Bulk review blocks every row that was not searched by hand | `resolvePrivateUsenetRow`, `resolveUsenetRow` (`server/download-preflight.ts`) | 6 |
| G18 | A download that turns out not to be the listed release is never fed back to the candidate | `server/import-follow.ts` | 7 |
| G19 | A best release on a tracker Prowlarr cannot reach stays the target forever | `assessSeason` (`server/assessment.ts`) | 8 |

## 4. Target architecture

```text
release source (info hash, or files:<sha1>)
  1. hash chain        AnimeTosho, then AmeNZB            unchanged
  2. search stage      Prowlarr, one indexer per request   free, persisted, may run in the background
  3. verify stage      fetch one NZB, grade its contents   costs a grab, runs only for a user action
  4. submission        stored NZB bytes to SABnzbd         never fetches a verified NZB again
```

Step 2 runs for a private-tracker release, and for a public release once every enabled hash indexer has answered "no NZB" and SeaDex lists the torrent's files with sizes. That eligibility rule is unchanged (`privateUsenetSources`, `prowlarrFallbackSource` in `server/usenet.ts`).

### Modules

| Module | Change |
| --- | --- |
| `server/prowlarr.ts` | Per-indexer Newznab search; indexer capabilities, status and limits; failure classification after a download redirect; a storable download reference |
| `server/usenet-scheduler.ts` | Channels keyed by string, created on first use; adaptive spacing; used by two instances |
| `server/usenet-search.ts` (new) | Query ladder, candidate plausibility and ranking, search stage, verify stage, in-flight deduplication. Replaces the NZB half of `server/private-sources.ts` |
| `server/usenet-search-store.ts` (new) | Persisted search records, the NZB store and the per-indexer usage counters |
| `server/private-sources.ts` | Shrinks to the private torrent lookup (`findTorrent`, `resolvePrivateTorrent`, `trackerTorrentId`, `searchContext`) |
| `server/source-files.ts` | Segment byte sums per NZB file; `gradeNzb` |
| `server/search-titles.ts` | Title ordering by fit with the file names; `searchCategories` removed |
| `server/usenet.ts` | Availability rows from the store; the `verify` request; `fetchUsenetNzb` reads the NZB store |
| `server/usenet-prefetch.ts` | Search sweep after the hash sweep; pruning of the search store |
| `server/download-preflight.ts` | Reads stored results only for bulk reviews and acceptance; the `not_verified` block; proof on planned units |
| `server/import-follow.ts`, `server/download-store.ts` | Proof on ledger records; candidate rejection after a mismatched import |
| `server/assessment.ts`, `server/scan.ts`, `shared/settings.ts` | The `reachable` tracker mode |
| `shared/usenet-contracts.ts`, `shared/download-contracts.ts`, `shared/contracts.ts` | Section 5 |
| `server/paths.ts` | `USENET_SEARCH_FILE`, `NZB_STORE_DIR` |

### Identities

- **Source ID:** unchanged. An info hash, or `files:<sha1>` for a private-tracker release.
- **Record key:** the credential-free Prowlarr fingerprint (`prowlarrFingerprint`) plus the source ID, as today.
- **Entry ID:** unchanged. The indexer ID plus the first 20 hex characters of the SHA-1 of the result GUID. It keeps matching `NZB_CHOICE` in `server/download-preflight.ts`.
- **Download reference:** `{ indexer_id, link, file }`, the `link` and `file` query parameters of Prowlarr's download link. The path is rebuilt in memory with the configured key when a fetch is made.
- **Channel:** `prowlarr:<indexer id>` in the scheduler, one per Usenet indexer.

## 5. Contracts

`shared/usenet-contracts.ts`:

```ts
export type UsenetProof = 'exact' | 'near_exact' | 'probable' | 'size_only' | 'unverified'

export type UsenetUnitState =
  | 'not_checked' | 'unverified' | 'available' | 'no_match' | 'processing'
  | 'incomplete' | 'unsupported_hash' | 'not_configured' | 'lookup_failed'

export interface UsenetCandidate {
  // existing fields stay
  /** The NZB was fetched and graded. False for a search result nobody has opened yet. */
  checked: boolean
  proof?: UsenetProof
  posted_at?: string
  /** File count the indexer reports. Shown, never used to reject. */
  files?: number
  /** Marked wrong after an import, or by the user; never offered as a match again. */
  rejected?: boolean
}

export interface UsenetHashAvailability {
  // existing fields stay
  proof?: UsenetProof
  /** Search results found for this source, checked or not. */
  candidate_count?: number
}

export interface UsenetAvailabilityRequest {
  // existing fields stay
  /** Rows selected for download: search if needed, then fetch and check the best candidate. */
  verify?: { key: string; release: number }[]
}

export interface UsenetAvailabilityResponse {
  // existing fields stay
  /** NZB fetches left today per Usenet indexer in Prowlarr; null means no limit. */
  prowlarr_usage?: { indexer: string; fetches_left: number | null; paused_seconds?: number }[]
}
```

- **`unverified`:** search results exist and none has been checked. `aggregateHashStates` ranks it after `processing` and before `not_checked`.
- **`PlannedUnit.proof`:** added to `shared/download-contracts.ts` so a review can label a near-exact unit.
- **`PreflightBlocked.code`:** gains `not_verified`. `not_searched` stays for a source with no search record.
- **`UsenetPrefetchProgress`:** `paused[].provider` becomes `{ id: string; label: string }`, and a `search?: { checked: number; total: number }` field reports the search sweep.
- **`OwnedDownloadRecord.proof`:** optional, in `server/download-store.ts`. Records without it load unchanged.
- **`TrackerMode`:** gains `'reachable'` (section 13).
- **`Config`:** gains `prowlarr_background_search`, `prowlarr_search_limit` and `prowlarr_fetch_limit` (section 15).

Before changing an exported contract, find every reference in both TypeScript contexts (server and frontend), as the Usenet plan requires.

## 6. Prowlarr client

All changes are in `server/prowlarr.ts`.

### Indexer list

`parseIndexer` also reads:

- `capabilities.tvSearchParams` and `capabilities.movieSearchParams`, compared case-insensitively, for a later ID search.
- `status.disabledTill`. An indexer disabled until a future time is not searched; its channel is paused until then.
- The fields `baseSettings.queryLimit`, `baseSettings.grabLimit` and `baseSettings.limitsUnit`, converted to a per-day figure.

### Per-indexer search

Add `searchIndexer(settings, indexerId, params)`:

- Request `GET /{id}/api` with `t=search`, `q`, `limit=100`, `extended=1`, and `minsize` and `maxsize` when the caller gives a size window. Authenticate with the `X-Api-Key` header, as every other call does. Use a 45-second timeout.
- Parse the RSS with the existing bounded XML helpers (`parseProviderXml`, `findNewznabError`, `listOf`, `text`). Reuse the attribute reading in `server/amenzb.ts` by moving `newznabAttributes` and `elementText` to `server/usenet-provider-types.ts`.
- Map each item to `ProwlarrRelease` plus `files`, `grabs`, `posted_at` and `categories`. Build `download_path` with the existing `downloadPath`, and `info_url` with the existing `infoUrl`.
- Failures:

| Answer | `ProwlarrError` code | Scope |
| --- | --- | --- |
| 429 | `rate_limited`, with `retryAfterMs` | indexer |
| 410 | `invalid_config` ("turned off in Prowlarr") | indexer |
| 401 or 403 | `unauthorized` | Prowlarr |
| 5xx, timeout, network | `server`, `timeout`, `network` | indexer |
| Newznab `<error>` document | by `classifyNewznabError` | indexer |
| An empty channel | no failure; the indexer answered | |

- Give `ProwlarrError` a `scope: 'prowlarr' | 'indexer'` field, so the finder knows whether to pause one indexer or fail the whole lookup.
- `classifyNewznabError` hardcodes "AmeNZB" in its messages. Give it the provider's name as a parameter.

`searchProwlarr` (`/api/v1/search`) stays for private torrent searches, which are unchanged.

**Fallback.** If phase 0 shows the Newznab endpoint cannot be used, keep `/api/v1/search` with one indexer per request. After an empty answer, read `/api/v1/indexerstatus`: an indexer whose `disabledTill` is in the future, or whose `mostRecentFailure` is not older than the request, counts as failed.

### Downloads

`prowlarrDownload` classifies what happens after the redirect instead of reporting every refusal as `invalid_response` (G1):

- 429 from the indexer becomes `rate_limited` with its `Retry-After`; 5xx becomes `server`; 401 and 403 become `unauthorized`. All have indexer scope.
- A body that is a Newznab error document (`detectXmlError`) is classified the same way. Indexers answer a reached download limit with HTTP 200 and such a document.
- A 429 from Prowlarr itself, before any redirect, already carries `Retry-After`. Keep it and give it indexer scope: it is Prowlarr's grab limit for that indexer.

Add `downloadRef(release)` and `downloadPathFromRef(settings, ref)`. The first extracts `link` and `file` from a download path. The second rebuilds `/{indexer_id}/download?apikey=…&link=…&file=…` with the configured key.

## 7. Scheduler

`LookupScheduler` in `server/usenet-scheduler.ts`:

- **Channels.** Replace `UsenetProvider` with a string channel. Create a channel's state on first use from a `describe(channel, { label, minIntervalMs })` call. `LookupJob.provider` becomes `channel`. `recordOutcome` accepts any `{ kind: string; code?: UsenetFailureCode; retry_after_ms?: number }`.
- **Adaptive spacing (G7).** Each channel has a current interval, starting at its minimum. A `rate_limited` outcome multiplies it by 1.5, up to 15 seconds. Every 20 consecutive successes reduce it by 10%, down to the minimum. Nothing is persisted. The existing pause after rate limiting stays.
- **Two instances.** `usenetScheduler` keeps serving AnimeTosho and AmeNZB with its current options. A second instance in `server/usenet-search.ts` serves the Prowlarr channels with a concurrency of 3, one slot reserved for foreground work, and a 2-second minimum interval per indexer. A slow indexer search then never takes a slot from hash lookups.
- **Pauses.** `usenetProviderPauses()` reports both instances. The frontend text (`usenetPauseText`) uses the reported label instead of a provider enum.

The rules already documented in [maintainability.md](maintainability.md) hold for both instances: foreground before background, a paused channel fails queued foreground work fast, background work waits out the pause.

## 8. Search stage

### Query ladder

A source's search terms come from its own file names, not from a fixed title order.

1. **Common tokens.** Take the base names of the source's video files outside folders named like extras. Lower-case them, remove diacritics, and split on every character that is not a letter or digit. The common tokens are those present in every such name; they hold the show title, the group and the release tags, without episode numbers.
2. **Title order.** Clean every available title with `cleanSearchTitle` (library title, Sonarr's alternate titles, AniList romaji and English). A title fits when all its tokens are common tokens. Fitting titles come first, in their existing order. Consider every title for ordering; the four-query ceiling applies to queries, not to titles.
3. **Rungs.** At most four queries per indexer per source:

| Rung | Query | When |
| --- | --- | --- |
| A | group and the first title | First when the group's tokens are common tokens |
| B | the first title alone, with a size window of 0.97 to 1.35 times the listed total | First when the file names do not carry the group (G6); otherwise second |
| C | group and the next title, then the one after | Only while no strong candidate exists |

4. **No categories** on any rung (G4). The file check is the gate.
5. **Early stop (G5).** Each rung goes to every Usenet indexer, as separate requests. After a rung, stop when any candidate is strong (below).

On the measured library this is about 135 queries per indexer for 123 releases instead of 392.

### Candidates

- **Group match (G3):** the group's tokens appear in the candidate title as consecutive whole tokens, or the group with punctuation removed equals one token or up to three adjacent tokens joined. `-ZR-` matches `[ZR]` and `Remux-ZR`, and no longer matches "Dragon Ball Z Remastered".
- **Name coverage:** the share of the source's common tokens found among the candidate title's tokens.
- **Plausible:** a Usenet result whose size is unknown or within 0.97 to 1.35 times the listed total, and which has a group match or a name coverage of at least 0.6.
- **Strong:** plausible, with a size within 1.0 to 1.25 times the listed total.
- **Rank:** group match first, then name coverage, then closeness of the size to 1.08 times the listed total. A reported file count at least as large as the number of listed files, and a non-zero grab count, break ties. The file count never rejects a candidate, because packed posts report unrelated counts.
- Keep the 20 best plausible candidates per source.

### Record states and freshness

| Stored result | Availability state | Fresh for |
| --- | --- | --- |
| A candidate checked as exact or near-exact, not rejected | `available`, with `proof` | 30 days |
| Candidates, none checked | `unverified` | 7 days |
| Candidates checked, none sendable | `no_match`, with the candidates | 7 days |
| Every indexer answered, no plausible candidate | `no_match` | 1 day, then 3, 7 and 30 days on consecutive absences |
| No candidate, and at least one indexer failed | `lookup_failed`, naming the indexer | Until that indexer's pause ends, at least one minute (G2) |
| No record | `not_checked` | |

- A record is also stale when an enabled Usenet indexer is missing from its `indexers` list. The refresh asks only the missing indexers and merges their candidates.
- **Search again** in release details bypasses freshness, as today.
- A lookup already running is shared by every caller. A foreground caller promotes a background job, as the hash path does.

## 9. Verify stage

### Fetching

`verifySource(config, source, { limit })` walks the ranked, unchecked, unrejected candidates:

1. Skip a candidate whose indexer is paused or has no fetches left today. If that leaves nothing to fetch, the source stays `unverified` and the availability row carries the reason.
2. Take a scheduler slot on the indexer's channel, count the fetch, and fetch the NZB through `prowlarrDownload` and `gunzipOnce`.
3. On an indexer-scope failure, record the outcome on the channel, mark the candidate `unavailable` with its retry time, and stop fetching from that indexer. The source becomes `lookup_failed`, never `no_match`, unless another candidate is proven.
4. On success, grade the NZB, store its bytes (section 14), and save the candidate's `check` at once.
5. Stop at the first exact or near-exact candidate, or at `limit` fetches.

`limit` is 3 for an explicit search and for a single download, and 1 for a bulk review (decision 2).

### Proof levels

`nzbFiles` in `server/source-files.ts` returns every `<file>` of the NZB, with the sum of its `<segment bytes>`. A subject that does not parse gives a file without a name instead of being dropped. `gradeNzb(files, expected)` returns the first level that holds. "Video files" are the listed files that match `VIDEO_FILE`; "ratio" is a file's segment bytes divided by its listed size.

| Level | Rule | Sending |
| --- | --- | --- |
| `exact` | Every video file appears with its base name and exact size in a subject. This is today's `nzbHasFiles` | Automatic |
| `near_exact` | Every video file's base name appears, and for each the ratio is within 1.005 to 1.06, and the ratios of video files of 64 MiB or more differ by at most 0.005 | Automatic, labelled (decision 1) |
| `probable` | At least three video files, and one ratio within 1.005 to 1.06 assigns every listed video size to a different NZB file within 0.005 | By explicit choice |
| `size_only` | Total segment bytes divided by the listed total is within 1.005 to 1.35 | By explicit choice |
| `unverified` | None of the above | By explicit choice, with a warning that the sizes differ |

- For `probable`, try each NZB file as the partner of the largest video file. Each trial fixes a ratio; then match the remaining video sizes greedily against unused NZB files.
- Keep the thresholds as named constants beside `gradeNzb`.
- An NZB with missing articles has a low or uneven ratio and falls out of `near_exact` by itself.

### Calibration

Every exact match is ground truth for the ratio. Log the lowest and highest ratio of each graded NZB at INFO level with the indexer's name, for exact matches too. Phase 5 is complete only when the logged ratios of exact matches from the installation's own indexers fall inside the accepted range; widen the constants if a poster falls outside.

### Usage limits (G12)

`server/usenet-search-store.ts` keeps hourly counters per indexer for the last 24 hours and persists them.

| Counter | Counts | Limit |
| --- | --- | --- |
| Searches | Background queries only | `prowlarr_search_limit`, and at most half of the indexer's own daily query limit when Prowlarr reports one |
| Fetches | Every NZB fetch through Prowlarr | `prowlarr_fetch_limit` |

- Foreground searches are paced but not counted against the search limit. Prowlarr's own limits still apply, and its 429 pauses the channel.
- A fetch refused by the limit is not an error. The row reports "Daily NZB check limit reached for <indexer>" with the time the next fetch becomes available.

## 10. Availability, review and submission

### Availability (`server/usenet.ts`)

`usenetAvailability` keeps returning at once and never waits on Prowlarr.

- Rows that need a file-list search report the stored state from the table in section 8, with `search: 'prowlarr'` or `fallback: 'prowlarr'` as today.
- `search` rows (the **Search Prowlarr** and **Search again** buttons) start a refresh search and a verify with a limit of 3, in the foreground.
- `verify` rows start a search if no fresh record exists, then a verify with a limit of 1. Rows already verified do nothing.
- `refreshing` is true while a search or verify for the source is running, so the existing observer (`observeUsenetAvailability`) polls until it settles.
- The response carries `prowlarr_usage`.

### Preflight (`server/download-preflight.ts`)

| Caller | Searches | Fetches |
| --- | --- | --- |
| Single download review | If no fresh record | Up to 3, as today |
| Bulk review | Never | Never |
| Acceptance of any plan | Never | Never |

- Add a `resolve: 'stored' | 'search'` option to `planDownloads`. `buildDownloadPlan` passes `'search'` for one selection. `acceptDownloadPlan` always passes `'stored'`, so accepting a plan can never spend a fetch.
- Bulk rows read the store. A verified source plans a unit with its `proof`. `unverified` blocks as `not_verified` with the reason from the verify stage. No record blocks as `not_searched`. The other states map as today.
- `chosenPrivateNzb` reads the store: the chosen entry must be checked, fetchable and not rejected.
- New block copy: `not_verified`: "Usenet results for this release have not been checked yet." Replace the `not_searched` copy with: "This release has not been searched on Usenet yet. Open the review again, or search it in its details."

### Bulk review flow (G17)

1. The review dialog observes availability for its rows, as today (`useReviewAvailability`).
2. For every row whose chosen protocol is Usenet and whose state is `not_checked` or `unverified`, it sends the row in `verify`. In **Choose per download** mode this happens when the row's protocol becomes Usenet, including through apply-to-all.
3. The dialog shows the checks in progress and the fetches left per indexer, and stays cancellable.
4. When no row is refreshing, it requests the preflight, which reads stored results.

`buildReview` in `frontend/src/bulk-review.ts` must count a release as Usenet-eligible when a file-list search is possible for it, not only once it was searched.

### Submission

`fetchUsenetNzb` for `provider: 'prowlarr'` returns the stored NZB bytes. If they were evicted (section 14), it fetches the NZB again within the fetch limit and requires the same SHA-256 or the same proof level before sending. `acceptDownloadPlan` copies the unit's `proof` to the ledger record.

## 11. Background search sweep

In `server/usenet-prefetch.ts`:

- **Eligibility:** `prowlarr_background_search` is on, SABnzbd is configured, the download mode is not **Torrent only**, and Prowlarr has a Usenet indexer. It does not require AnimeTosho or AmeNZB, because private-only releases have no hash.
- **Order:** the existing `prefetchPlan` order. Each release's hash lookups finish first.
- **Work:** for each source that qualifies for step 2 and has no fresh record, run the search stage at background priority within the search limit. The sweep never fetches an NZB.
- **Progress:** `usenet_prefetch.search` in `/api/status`.
- **Summary:** when a sweep ends, log how many sources were searched, how many have candidates, how many have none, how many failed, and how many queries each indexer received. Show the latest summary in the Prowlarr settings card. This is the measurement for the gate after phase 4.
- **Pruning:** `pruneCache` also drops search records, with their stored NZBs, for sources no current result references. Records referenced by an active ledger record are kept.

## 12. Outcome feedback (G18)

- When a scan after a finished download shows the target season's release group in `mismatched_by_part`, and the ledger record has `provider: 'prowlarr'` and a proof other than `exact`, mark the candidate `rejected` in the search store.
- A rejected candidate is never ranked, verified or reported as available again. The source returns to `no_match` with its candidates, so the next search can try another one.
- Set the record's import message to "The downloaded files are not the release SeaDex lists; their sizes differ." Report it through the existing import-problem notification, with a new `ImportProblem.state` of `'mismatch'`.
- A confirmed import changes nothing in the store.

## 13. Reachable tracker mode (G19)

`TrackerMode` gains `'reachable'`, labelled **Include private trackers Prowlarr can reach**.

- A private-tracker release counts as obtainable when Prowlarr has a private torrent indexer for its tracker (`trackerIndexers`).
- In `assessSeason`, when the part's chosen target is not obtainable and a public release is listed, the target becomes the public pick: `pickBest` over the downloadable candidates, taking a best-flagged one when there is one and otherwise an alternative. Status is judged against that target.
- The unreachable release stays listed with its own `kind`, is never the target, and carries a note such as "Best release is on AB, which Prowlarr cannot reach". A Usenet copy of it can still be searched and downloaded from release details.
- When the part lists no public release at all, nothing changes: the private release stays the target.
- The scan reads the covered trackers once at its start. `assessmentSignature` in `server/scan.ts` includes the mode and the sorted covered trackers, so a change of coverage makes the next scan a baseline. When Prowlarr cannot be read, the scan reuses the covered trackers of the saved signature.
- `privateSearchSettings` treats `reachable` as it treats `private`.
- On the measured library, 10 targets are private-only and every affected result also lists a public release.

## 14. Persistence

### Search records

`DATA_DIR/usenet_search.json`, written with `writeJsonAtomic` and mode `0600`:

```ts
interface SearchRecord {
  source_id: string
  fingerprint: string
  searched_at: number
  last_attempt_at: number
  retry_at: number
  negative_streak?: number
  indexers: { id: number; name: string; answered: boolean; at: number }[]
  candidates: StoredCandidate[]
}

interface StoredCandidate {
  entry_id: string
  indexer_id: number
  indexer: string
  title: string
  size: number | null
  files?: number
  grabs?: number
  posted_at?: number
  info_url?: string
  download: { link: string; file: string }
  check?: {
    at: number
    proof: UsenetProof
    files_matched: number
    names_matched: number
    files_expected: number
    sizes_known: boolean
    ratio?: [number, number]
    nzb_sha256?: string
    unavailable?: { code: UsenetFailureCode; retry_at: number }
  }
  rejected?: { at: number; reason: 'import_mismatch' }
}
```

- The file also holds `version: 1`, the per-indexer usage counters and the latest sweep summary.
- Validate every record on load, as `storedRecord` does in `server/usenet-cache.ts`. Drop invalid ones with a warning.
- Search-only updates are written at most every 30 seconds and on graceful shutdown (register the flush beside `flushUsenetCache` in `server/index.ts`). An update that records a fetch is written immediately, so a fetch is never spent twice after a crash.
- A change of the Prowlarr URL or key drops the records of other fingerprints, with their stored NZBs. This replaces `invalidatePrivateSources` in `server/config-service.ts`.
- Titles pass through `safeText`. `info_url` keeps its existing rules.

### NZB store

`DATA_DIR/nzb_store/<sha256>.nzb.gz`, mode `0600`:

- Every fetched and graded NZB is stored, proven or not, so a candidate the user chooses later costs no second fetch.
- The budget is 256 MB. Beyond it, the oldest NZBs go first, but never one checked in the last 24 hours. A hard limit of 512 MB overrides that protection.
- An evicted candidate keeps its `check`. Its bytes are fetched again only on submission.
- Measured NZBs were 0.2 to 3.1 MB uncompressed for sources of 1.4 to 18.6 GiB.

### Compatibility

No existing file changes. There is nothing to migrate; results from before the update were in memory only.

## 15. Settings

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `prowlarr_background_search` | boolean | `false` | Search Usenet indexers in the background after each scan |
| `prowlarr_search_limit` | integer, 0 to 10,000 | `100` | Background searches per indexer per 24 hours; 0 is no limit |
| `prowlarr_fetch_limit` | integer, 0 to 1,000 | `20` | NZB fetches per indexer per 24 hours; 0 is no limit |
| `tracker_mode` | adds `'reachable'` | unchanged | Section 13 |

- Add them to `Config` and `DEFAULT_CONFIG`, validate them in `applyConfigUpdate`, and extend `normalizeTrackerMode`.
- Changing `prowlarr_background_search` starts or stops the search sweep (`saveSettings` in `server/config-service.ts`). Changing a limit takes effect at once and invalidates nothing.
- None of them is a secret.

## 16. UI

Follow section 10 of the Usenet plan. This extends existing components; it is not a redesign.

| Surface | File | Change |
| --- | --- | --- |
| Release details | `frontend/src/components/ReleaseDetails.tsx` (`describeUsenet`, the candidate list, the confirm dialog) | Text for `unverified` with a **Check now** action; a proof label on an available Prowlarr copy; per-candidate wording by proof level; unchecked and rejected candidates shown as such |
| Bulk review | `frontend/src/useBulkReviewChecks.ts`, `frontend/src/components/BulkDownloadDialog.tsx`, `BulkReviewParts.tsx` (`UsenetStatus`), `frontend/src/bulk-review.ts` | The `verify` request; a label for `unverified`; checks in progress and fetches left; a near-exact label on units |
| Availability plumbing | `frontend/src/api.ts`, `frontend/src/usenet-observation.ts`, `frontend/src/useCardDownloads.ts` | The `verify` parameter, sent on the first request like `search` |
| Sidebar and operation center | `frontend/src/components/SidebarStatus.tsx`, `OperationCenter.tsx`, `frontend/src/utils.ts` (`usenetPauseText`) | Search sweep progress; pause text from the reported label |
| Prowlarr settings | `frontend/src/components/ConfigTab.tsx`, `frontend/src/config-services.ts`, `frontend/src/components/config/parts.tsx` | The background toggle with the expected number of searches for the current library, the two limits, and the latest sweep summary |
| Release preferences | `frontend/src/components/ReleasePreferencesEditor.tsx` (`TRACKER_MODES`) | The third tracker choice |

Wording for the states a user sees:

| State | Text |
| --- | --- |
| `unverified` | "Possible copy on Usenet: N results, not checked yet" |
| `available`, exact | "On Usenet through Prowlarr: files match exactly" |
| `available`, near-exact | "On Usenet through Prowlarr: names and sizes match (near-exact)" |
| Candidate, probable | "File sizes match an obfuscated post" |
| Candidate, size only | "Only the total size could be compared (packed or obfuscated post)" |
| Fetch limit reached | "Daily NZB check limit reached for <indexer>. Next check at <time>." |

## 17. Security rules

These add to section 11 of the Usenet plan.

- The Prowlarr key, download links with a key, and indexer links never reach a log, a response, or `usenet_search.json`. The store keeps `link` and `file` only.
- `link` is Prowlarr's encrypted form of the indexer's download address. Treat it as sensitive: mode `0600`, never sent to the browser, never logged.
- After a download redirect, the Prowlarr key is not sent to the indexer. This is unchanged.
- Indexer-supplied text is bounded and cleaned with `safeText` before it is stored or shown. Error descriptions from an indexer are never copied into a message, because an indexer can echo the request address.
- An NZB is validated with `validateNzbBytes` before it is graded or stored.
- Entry IDs stay opaque. The browser never receives a download reference.

## 18. Phases

Each phase leaves the application working and can ship alone. Tests are listed with their phase; section 19 lists cross-phase cases.

### Phase 0: live checks

No product change. Needs the user's consent, because it spends about two searches and one fetch per indexer.

- Confirm against the running Prowlarr: the Newznab endpoint accepts the `X-Api-Key` header; `t=search` returns `files`, `grabs` and `pubDate`; an indexer at its query limit answers 429 with `Retry-After`; a Usenet download redirects; the numeric values of `baseSettings.limitsUnit`.
- Save one sanitized response of each kind as a test fixture, with keys and hosts replaced.
- Record the outcome in section 20. If the Newznab endpoint is unusable, phase 3 uses the fallback in section 6.

### Phase 1: fixes in the current path

No contract or persistence change.

- G1: classify fetch failures after the redirect in `prowlarrDownload`; in `findNzb`, an indexer-scope failure stops fetching from that indexer and fails the lookup instead of caching "no match".
- G2: `failed()` keeps `retryAfterMs`; a failed lookup is retried no earlier than that.
- G3 and G6: whole-token group match, name coverage, the plausible rule.
- G4: remove categories from Usenet searches; delete `searchCategories` and its test.
- G5: title ordering by fit, the rung order, early stop. `searchAll` already supports stopping.
- G7: adaptive spacing in `LookupScheduler`.

Tests, in `tests/prowlarr.test.ts`, and in `tests/usenet-discovery.test.ts` for the scheduler:

- An indexer answering 429, or HTTP 200 with a Newznab error document, yields `lookup_failed`, fetches no second candidate from that indexer, and is not cached as a match or an absence.
- A Prowlarr 429 with `Retry-After: 3600` is not retried within the hour.
- `ZR` does not match "Dragon Ball Z Remastered"; `sam` does not match "Samurai"; `-ZR-` matches `[ZR] Show` and `Show.Remux-ZR`.
- A release whose file names lack the group is found by the title-only rung with the size window.
- The first query that returns a strong candidate ends the search.
- No request carries a category.
- A `rate_limited` outcome widens a channel's interval, and sustained success narrows it again.

Done when: the existing Prowlarr tests pass with their expectations updated only where this phase changes behavior, and a release whose first query returns a strong candidate costs one query per indexer.

### Phase 2: persistence

- `server/usenet-search-store.ts` with records, the NZB store and validation.
- The NZB half of `private-sources.ts` reads and writes the store instead of the `nzbs` map and the 128 MB budget. Freshness follows section 8.
- `fetchUsenetNzb` reads stored bytes. Flush on shutdown. Fingerprint-based invalidation. Pruning.

Tests, in a new `tests/usenet-search.test.ts`:

- A proven match survives a simulated restart, and a bulk review then plans it without a search or a fetch.
- Submission sends the stored bytes with no Prowlarr request.
- A fetch is written before it is exposed: a store reloaded after a simulated crash still knows the checked candidate.
- An invalid record, and a record of another fingerprint, are dropped on load.
- The stored file contains neither the Prowlarr key nor a download address with a key.
- Eviction keeps recent NZBs, and an evicted NZB is fetched again on submission and compared.
- Records of sources that left the results are pruned with their NZBs.

Done when: restarting the server between **Search Prowlarr** and a bulk download no longer blocks the row.

### Phase 3: per-indexer search, channels and limits

- `searchIndexer`, the indexer details, and the second scheduler instance.
- Split `findNzb` into `searchSource` and `verifySource` in `server/usenet-search.ts`. An explicit search still runs both, so behavior stays click-driven.
- Usage counters and the two limits, with their settings and validation (UI in phase 4).
- Pause reporting for Prowlarr channels.

Tests:

- One indexer failing and one answering yields candidates from the second, and the record lists the first as not answered.
- No candidates plus a failed indexer is `lookup_failed`; no candidates with every indexer answering is `no_match`.
- A paused indexer fails queued foreground work fast and makes background work wait.
- A newly added indexer makes a record stale, and only that indexer is asked.
- The fetch limit refuses a fetch without an error and reports the next time.
- Hash lookups keep their slots while an indexer search hangs until its timeout.

Done when: the Prowlarr history shows one query per indexer per rung and no category restriction.

### Phase 4: background sweep and the `unverified` state

- The contract additions for `unverified`, `candidate_count`, `checked` and the progress shape.
- The sweep, its eligibility, progress, summary and pruning.
- UI: the settings toggle and limits, the sweep progress, the `unverified` text and the **Check now** action in release details.

Tests:

- The sweep searches eligible sources in priority order and never fetches.
- It does not run with the setting off, with **Torrent only**, or without a Usenet indexer.
- It runs for private-only releases when both hash indexers are off.
- It stops at the search limit and resumes when usage ages out.
- A superseded sweep stops reporting progress.
- Frontend: an `unverified` row renders its count and action; a changed `config_generation` still discards rows.

Done when: the sweep summary reports candidate counts for the whole library.

**Gate.** Review the summary with the user before phases 5 and 6. If the indexers return candidates for only a small share of releases, those phases bring little, and ID search or another indexer is the better next step.

### Phase 5: proof levels

- Segment sums in `nzbFiles`, `gradeNzb`, `proof` on availability rows, candidates, planned units and ledger records.
- Near-exact matches become `available` (decision 1).
- The ratio log line for calibration.
- UI: proof labels and candidate wording.

Tests, with NZB fixtures built in the test file:

- Exact subjects grade as `exact`, and their ratios fall inside the accepted range.
- Correct names without trailing sizes and with a constant overhead grade as `near_exact` and are planned without a confirmation.
- Correct names with one file 2% off grade below `near_exact`.
- Random names with sizes in a constant ratio grade as `probable` for three or more files, and never for one or two.
- A single-archive post grades as `size_only`.
- A PAR2 volume larger than an episode does not break `probable`.
- A post with missing segments grades below `near_exact`.
- `probable`, `size_only` and `unverified` candidates still need the explicit confirmation and are refused for a torrent row.

Done when: the calibration condition in section 9 holds.

### Phase 6: bulk verification

- The `verify` request and its handling, the `resolve` option, the `not_verified` block.
- UI: the bulk review flow in section 10.

Tests:

- A bulk review of rows without records searches and fetches exactly one NZB per source, then plans the proven ones.
- A row whose top candidate is not proven stays blocked and lists its candidates; no second fetch is made.
- Rows beyond the fetch limit block as `not_verified` with the next time.
- A row switched to Torrent is never verified.
- Acceptance spends no search and no fetch, including when the stored record has disappeared (it blocks as `not_searched`).
- Cancelling the review stops queued verification.

Done when: a bulk Usenet download of unsearched releases completes from one dialog.

### Phase 7: outcome feedback

- Section 12.

Tests, in `tests/import-follow.test.ts`:

- A near-exact download whose import shows a size mismatch rejects its candidate, reports the problem once, and returns the source to `no_match`.
- A rejected candidate is skipped by the next verify.
- An exact download, a hash-provider download and a torrent are never rejected this way.

### Phase 8: reachable tracker mode

- Section 13, with its settings, signature and UI.

Tests, in `tests/release-preferences.test.ts`:

- With an uncovered tracker, the public release becomes the target and the private one stays listed with its kind and note.
- With a covered tracker, the result equals private mode.
- A part with no public release keeps the private target.
- A coverage change makes the next scan a baseline; an unreadable Prowlarr reuses the saved coverage.
- Private and public modes are unchanged.

### Phase 9: documentation

Section 21. Update the documents with each phase; this phase is the final check.

## 19. Regression and acceptance cases

Beyond the tests listed per phase:

- Releases with a hash-linked NZB behave exactly as before in availability, review, submission and ownership.
- A failed or processing hash lookup never starts a Prowlarr search.
- Public-tracker mode makes no Prowlarr request for a private-tracker release.
- The private torrent flow is unchanged: one search, one `.torrent` fetch shared by review and acceptance, real-hash ledger record.
- A source requested through both protocols in one review is still sent through neither.
- A whole-source NZB with a selected-file scope still needs the acknowledgement, at every proof level.
- A Usenet copy of a private release is still owned under its `files:` identity, and re-review reports it as existing.
- A changed Prowlarr URL or key leaves no usable record or stored NZB behind.
- `GET /api/status`, the availability response and the review contain no download reference, key or indexer address with a credential-like parameter.
- With Prowlarr turned off, no code path reads the search store for availability.

## 20. Verification

```bash
npm run format:check
npm run typecheck
npm test
npm run test:browser
```

`npm test` isolates persistence in a temporary `DATA_DIR`. Never run data-mutating tests against a live data directory.

Live acceptance, with the user's consent and an isolated data directory:

1. Phase 0 checks.
2. One release known to be on the indexers: search, verify, review and submit to SABnzbd, then restart and confirm nothing is fetched again.
3. One bulk review of three unsearched releases, watching Prowlarr's history for exactly one grab each.
4. One background sweep, comparing its query count with Prowlarr's history.

Record here what was confirmed live and what was not.

## 21. Documentation and definition of done

- **[README.md](../README.md):** rewrite **Private-tracker releases through Prowlarr** and the Usenet paragraph for users. Cover that search results are kept across restarts, what the proof labels mean, that bulk download checks one NZB per release within the daily limit, the background search setting and the two limits, and the third tracker choice under **Release preferences**. Keep implementation detail out, as [AGENTS.md](../AGENTS.md) requires.
- **[maintainability.md](maintainability.md):** the two scheduler instances and adaptive spacing; `usenet_search.json` and `nzb_store/` with their freshness, flush and pruning rules; the proof levels; the `reachable` signature.
- **[usenet-implementation-plan.md](usenet-implementation-plan.md):** mark the replaced decisions in section 16 as amended, with a link here.
- **This document:** set the status to implemented per phase, and fill in section 20.

Done means: every phase's tests pass, the commands in section 20 pass, the documents above are current, and the live claims that could not be verified are listed.

## 22. Evidence limits and open points

- Prowlarr's behavior was read from its `develop` branch, not observed on the installed 3.0.2. Phase 0 settles it.
- The size ratio was measured on AnimeTosho's own posts only. Section 9's calibration settles the range for other posters.
- How often the installation's indexers return a candidate is unknown. The gate after phase 4 settles it.
- Decisions 3 to 6 in section 2 are recommendations awaiting the user's confirmation.
- The coverage figures describe one library on one day. Rerun the measurement after phase 4 to compare.
