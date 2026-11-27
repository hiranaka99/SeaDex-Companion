# Usenet implementation plan

## Purpose and status

Implement exact-source Usenet acquisition in SeaDex Companion through AnimeTosho NEW and AmeNZB, with SABnzbd as the downloader. Preserve the existing qBittorrent workflow. This document is an implementation handoff, not a record of an implemented feature.

The user approved the behavior decisions below. The implementing agent should execute this plan without reopening those decisions. Reinspect current source before editing because line numbers and surrounding implementation can change.

> **Amendment (private-tracker releases through Prowlarr).** The user later approved an extension for releases SeaDex lists on private trackers, which have no public info hash. Section 16 specifies it. It narrows decision 1 and two boundaries below: hash lookups remain the only path for releases with a public hash; for private-tracker releases, a Prowlarr search may *propose* candidates, but nothing is sent unless the candidate's own file list matches the file list SeaDex publishes, byte for byte. Where this section and section 16 disagree, section 16 wins.

## 1. Required behavior and confirmed decisions

1. Resolve SeaDex's original BitTorrent v1 info hashes through both AnimeTosho NEW and AmeNZB. Do not substitute title searches, release-group searches, or a different encode. *(Amended: a release without a public hash may be searched through Prowlarr, and is acquired only when a candidate's files match SeaDex's file list exactly; see section 16.)*
2. Send matched NZBs directly to SABnzbd. Provide progress, pause, resume, remove while preserving files, remove with explicit file deletion, and bulk cancellation for app-owned downloads.
3. Add a persisted download-mode setting with the exact labels **Torrent only**, **Usenet only**, and **Choose per download**.
4. Show an explicit Usenet-unavailable result when no matching NZB exists. Distinguish a successful lookup with no match from an unsuccessful lookup.
5. Perform all UI design and implementation through the Impeccable skill.
6. Torrent only and Usenet only are strict enqueue policies. Only Choose per download permits either protocol. Never fall back silently between protocols.
7. Choose per download supports a protocol choice for each release or cour in bulk review, plus an apply-to-all control. A submitted batch can contain both protocols.
8. If an NZB requires the whole source torrent rather than the requested episodes, permit it only after explicit review and acknowledgement of the larger scope. Do not silently widen a selection.
9. Default existing and new installations to Torrent only. Existing installations must not start contacting Usenet services merely because they were upgraded.
10. Prefer AnimeTosho NEW, then AmeNZB, for each source hash when both providers are enabled. Provider fallback is discovery behavior, not permission to retry an uncertain SABnzbd submission.

### Boundaries

- SABnzbd owns NNTP connections, article retrieval, repair, and unpacking. Companion must not implement an NNTP downloader.
- Do not add NZBHydra2, generic title matching, NZBGet, a plugin registry, automatic posting requests, or new automatic acquisition schedules in this change. *(Amended: Prowlarr is added for private-tracker releases only, as specified in section 16. Its search results choose candidates; they never decide a match.)*
- Do not modify Sonarr/Radarr quality profiles or introduce forced-import behavior. Preserve the existing category-based handoff. Document the required SABnzbd connection in Sonarr/Radarr.
- A source-hash association identifies the source torrent. Do not describe it as independent verification of downloaded bytes. Downloaded-file checksum verification is outside this scope.
- Preserve library matching, best/alternative classification, exclusions, notifications, unseen release changes, and scan scheduling. Provider availability is runtime acquisition state, not a change to the SeaDex recommendation.
- Preserve qBittorrent's selected-file behavior. Submit provider NZBs without deleting archive volumes or PAR2 entries to manufacture episode selection.
- Do not introduce a separate Downloads page or restore the removed library table. Keep card/detail controls and bulk review/cancellation.

## 2. Existing implementation to inspect

| Responsibility | Existing files | Relevant behavior |
| --- | --- | --- |
| Configuration and secrets | `shared/contracts.ts`, `server/config.ts`, `server/index.ts`, `frontend/src/components/ConfigTab.tsx` | Explicit patch rules, encrypted secrets, configured flags, connection-test drafts, unsaved settings protection |
| SeaDex source identity | `server/catalog.ts`, `server/types.ts`, `server/matching.ts`, `server/result-model.ts`, `shared/releases.ts` | Source info hashes, per-hash torrent file manifests, selected files, release identity and result normalization |
| Eligibility and estimates | `shared/download-plan.ts`, `shared/download-estimate.ts`, `server/download-preflight.ts`, `server/downloads.ts` | Shared-torrent deduplication, scope unions, ownership and size/disk-space checks |
| Submission and tracking | `server/download-routes.ts`, `server/download-jobs.ts`, `server/download-store.ts`, `server/paths.ts`, `shared/download-jobs.ts`, `shared/download-contracts.ts` | Single/bulk submission, persisted jobs, app-owned torrent ledger, progress and cancellation |
| qBittorrent | `server/qbittorrent.ts` | Session handling, per-torrent locks, metadata/file priorities, existing-torrent checks, controls; also currently contains unrelated integration tests |
| UI and retained state | `frontend/src/api.ts`, `frontend/src/download-store.ts`, `frontend/src/useCardDownloads.ts`, `frontend/src/components/ReleaseDetails.tsx`, `DownloadsPanel.tsx`, `BulkDownloadDialog.tsx`, `BulkCancelDialog.tsx`, `OperationCenter.tsx`, `frontend/src/bulk-job-store.ts` | Optimistic sending state, background jobs, release controls, bulk outcomes and retained review |
| Regression infrastructure | `tests/download-tracking.test.ts`, `tests/download-estimate.test.ts`, `tests/frontend-api.test.ts`, `tests/qbittorrent-session.test.ts`, `tests/season-mapping.test.ts`, `tests/release-changes.test.ts`, `tests/http-security.test.ts`, `tests/browser-smoke.mjs`, `tests/run-tests.mjs` | Isolated data directories, fake HTTP services and browser workflow fixtures |
| Product and UI authority | `PRODUCT.md`, `DESIGN.md`, `frontend/src/styles.ts`, `frontend/src/index.css`, `docs/screenshots/` | Existing dark, card-based operational interface; code governs actual behavior |

Important current constraints:

- `Release.downloadable` currently means that usable torrent hashes exist. `upgradeParts` explicitly requires those hashes. A second protocol must not inherit that misleading eligibility test.
- `releaseIdentity` contains the part, group, tracker, hashes and selected-file scope. Preserve that catalog identity independently of provider availability.
- Progress and frontend state currently use a result key plus release index. This is insufficient as the authoritative identity of a SABnzbd job.
- Job persistence validates pending/added/existing entries as 40-character hashes. Ownership persistence also assumes torrent hashes.
- `owned_torrents.json` and legacy `download_records.json` contain user data. Migrate their records; never discard them to simplify the new model.
- A release can merge several complementary source torrents. Usenet acquisition must resolve every required hash, not just the first one.
- The current download UI disappears when a release is owned or absent from current results. Stable ledger associations are needed so a rescan does not make an active job uncontrollable.

Before changing exported contracts, use language-server references. Server and frontend have separate TypeScript contexts; inspect both. Do not rely on one server's incomplete reference result. Migrate every active caller, fixture and API consumer. Confine old-format compatibility to persistence loading rather than retaining alternate runtime APIs.

## 3. Architecture and ownership

Keep source recommendations, mirror discovery, acquisition plans, and client jobs separate.

Use concrete modules rather than a general plugin framework:

- `server/animetosho.ts`: AnimeTosho NEW JSON metadata lookup and NZB retrieval.
- `server/amenzb.ts`: AmeNZB Newznab hash lookup and NZB retrieval.
- `server/usenet.ts`: provider ordering, source-hash deduplication, availability aggregation and bounded caching.
- `server/sabnzbd.ts`: authenticated SABnzbd calls, submission receipts, queue/history reads and targeted controls.
- `shared/usenet-contracts.ts`: public availability types without credentials or authenticated URLs.
- Existing planning, job, route and persistence modules own cross-protocol orchestration. A switch on the protocol is sufficient; do not build an extensible downloader framework.

Use one submission service for single and bulk operations. Single downloads must not retain a separate SABnzbd implementation that bypasses the bulk planner's mode, scope, identity and ownership rules.

### Identities

Define these concepts explicitly:

1. **Recommendation identity:** current `releaseIdentity`, based only on catalog source and requested file scope.
2. **Source hash:** normalized 40-character BitTorrent v1 info hash. Keep it as provenance even for a Usenet download.
3. **Mirror reference:** provider, provider entry ID, source hash and endpoint identity. Do not use an API-key-bearing download URL as its durable ID.
4. **Planned unit:** one actual torrent submission or one whole-source NZB submission. It has an opaque `unit_id`, protocol, source hash, category, effective scope, and associations with all covered review rows.
5. **Client job:** client kind, normalized connection identity, and native job ID. qBittorrent's native ID is its hash; SABnzbd's is its `nzo_id`.
6. **Submission intent:** a durable operation/unit record written before a mutating client call. It can end in accepted, rejected, or acceptance unknown.

Connection identity must not contain credentials. Bind a job to the normalized client endpoint used at submission. A changed URL must not redirect old controls to a different client. Rotating a key for the same endpoint must not orphan its jobs.

### Shared contracts

Introduce `DownloadProtocol = 'torrent' | 'usenet'` and `DownloadMode = 'torrent_only' | 'usenet_only' | 'choose'`.

Replace the ambiguous public `Release.downloadable` field with explicit static torrent availability, such as `torrent_available`. Usenet availability belongs in a separate, identity-keyed lookup response/store. It must not be persisted into the catalog or affect change detection. Keep genuinely torrent-specific helpers, including hash normalization and file-priority planning, torrent-specific.

Generalize shared download contracts to include:

- Selection: result key, release index, required recommendation identity, requested protocol, and whole-source acknowledgement when applicable.
- Planned unit: `unit_id`, protocol, source hash, client connection identity, category, mirror reference for Usenet, effective scope and associated selections.
- Receipt: stable download record ID and native client job ID, not just an info hash.
- Failure: unit ID, protocol, associated selections, typed failure code and safe message. Remove the assumption that every failure has a torrent `hash`.
- Progress: stable record ID, protocol, client label, source hash, associations, transfer bytes, speed, phase, safe error and capabilities for pause/resume/remove/file deletion.
- Bulk outcome: pending/added/existing/failed planned units and row associations. Preserve partial success without reporting a partially added release as wholly successful.
- Cancelable item: stable record ID, actual client, phase, affected titles/cours and capabilities. Cancellation must not resolve through a possibly replaced release index.

Do not encode Usenet identities into fake 40-character hashes. Do not keep torrent-only names for protocol-neutral counts, failure fields or UI state.

## 4. Configuration contract

Add the following flat fields to the existing configuration convention:

| Field | Default | Meaning |
| --- | --- | --- |
| `download_mode` | `torrent_only` | Strict policy for new enqueue operations |
| `sabnzbd_url` | empty | SABnzbd base URL, including any reverse-proxy prefix |
| `sabnzbd_key` | empty | Full API key, not the add-only NZB key |
| `sabnzbd_sonarr_category` | `sonarr-anime` | SABnzbd category watched by Sonarr |
| `sabnzbd_radarr_category` | `radarr-anime` | SABnzbd category watched by Radarr |
| `animetosho_enabled` | true | Enable AnimeTosho NEW discovery when Usenet is used |
| `animetosho_url` | `https://feed.animetosho.net` | Current feed/API base, configurable for domain migration |
| `amenzb_enabled` | false | Enable AmeNZB after the user configures an account |
| `amenzb_url` | `https://amenzb.moe` | AmeNZB base URL |
| `amenzb_key` | empty | AmeNZB account API key |

Keep existing `sonarr_category` and `radarr_category` semantics for qBittorrent. Do not repurpose those saved values to affect a second client silently.

Extend secret key lists, encrypted storage and public configured flags for `sabnzbd_key` and `amenzb_key`. Public responses must return blank secret values plus `*_configured` flags. Blank edits preserve a saved key; explicit clear removes it. Connection-test previews must apply the same rules without saving the draft.

Validate mode enums, booleans, URLs and categories through the existing explicit configuration patch boundary. Preserve unrelated values and the unsaved frontend draft. Use normal HTTP(S) URL parsing and reverse-proxy-safe path construction. Never append API paths twice.

Allow settings to be saved during incomplete setup. Show exactly which integrations are missing and block affected submissions server-side. Saving a mode does not prove client connectivity. Mode changes affect new submissions only; previously accepted downloads keep their protocol and remain controllable.

Extend connection testing for `sabnzbd`, `animetosho` and `amenzb`:

- SABnzbd: read version plus an authenticated queue/history response. Reject an add-only key that cannot provide controls. Do not enqueue a test download.
- AnimeTosho NEW: validate a real API response, such as capabilities, rather than accepting HTML with HTTP 200. No key is required.
- AmeNZB: use an authenticated read-only search, including a known nonexistent v1 hash, and parse Newznab errors. Public capabilities alone cannot validate its key or pinned IP.
- Keep test-generation protection so responses to an obsolete draft cannot replace current UI connection state.

Move integration-test dispatch out of `server/qbittorrent.ts` into a concrete integration module if needed. Move the existing function and callers rather than introducing a second dispatcher or leaving obsolete exports.

## 5. Hash lookup and provider behavior

### AnimeTosho NEW

Request:

```http
GET <animetosho_url>/json?show=torrent&hash=<normalized-source-hash>
```

Read the returned `info_hash`, entry `id`, `nzb_url`, file names/sizes, source IDs, total size and processing state. Require returned source identity to agree with the requested hash. Validate the response shape and normalize hash case.

Treat a documented HTTP 404 as no source entry. A source entry without an NZB URL is not downloadable. Distinguish pending processing, skipped entries, deleted entries and invalid responses when the response supplies that evidence.

Do not require the entire entry's `status` to equal `complete` if a usable NZB is already present. AnimeTosho documents that NZBs can appear before DDL and other processing finish. Availability requires an actual NZB reference and a safe source/scope association, not completion of unrelated DDL processing.

Use the returned NZB reference; do not derive storage paths from the torrent hash. Providers can return compressed NZBs. Retrieval must handle the documented content encoding/file compression without double decompression.

### AmeNZB

Request:

```http
GET <amenzb_url>/api?t=search&apikey=<server-held-key>&info_hash=<normalized-source-hash>
```

Parse Newznab XML items, stable entry/GUID data, enclosure/download references, size and relevant attributes. Use the documented hash-search contract. If a response also supplies a source-hash attribute, require agreement. Reject conflicting or ambiguous entries rather than guessing by title.

Do not mistake a Newznab `<error>` document with HTTP 200 for an empty successful result. Classify invalid credentials/IP mismatch, allowance exhaustion, invalid parameters and service failures separately. Its custom hash parameter is documented but not advertised in current public capabilities.

Retrieve the NZB server-side using the returned link or documented `t=get` and entry ID. Keep authentication on the configured provider endpoint. Do not require Prowlarr.

Do not apply `healthy=1` by default: it excludes unknown-health entries. Indexer health is not a successful download test on the user's Usenet provider.

### Aggregation and caching

- Normalize and deduplicate the source hashes required by the selected release, retaining per-hash file scope.
- For each hash, use AnimeTosho first. If it has no usable match or its lookup fails, consult enabled/configured AmeNZB. A usable match from either provider is sufficient for that hash.
- Prefer a complete supported source mapping over an incomplete one. Do not assemble a replacement release from unrelated hashes or versions.
- A multi-hash release is ready only when every required source unit is matched or already present as an appropriately associated app-owned job. Return per-hash results so the UI can explain missing coverage.
- Aggregate `not_found` only when relevant enabled providers completed successful lookups without a usable NZB. If an unqueried/failed provider could contain the missing match, report lookup failure or unresolved availability rather than definitive absence.
- Return separate states for not checked, available, no match, processing, incomplete, unsupported source hash, providers not configured, and lookup failure. Frontend checking state is separate from a provider's processing state.
- Use demand-driven lookup when Usenet-enabled details or bulk review are opened. Do not add provider requests to every library scan or poll them every three seconds with transfer progress.
- Deduplicate in-flight requests and cache by provider configuration generation plus source hash. Use internal positive and negative TTLs, initially 15 minutes and 5 minutes. Do not cache authentication/network errors as no-match results.
- An explicit Retry bypasses stale lookup results. Configuration changes invalidate relevant availability and unsubmitted plans. Recommendation changes invalidate scope-dependent aggregation without throwing away accepted job records.
- Bound source-hash lookup concurrency, initially four. Chunk large review lists at the API boundary, initially 100 selections per request. Process all selected library items; chunking must not silently narrow full-library bulk review.
- Keep the provider contract small enough to add another concrete hash-aware provider later, but do not implement a configurable generic indexer system now.

## 6. Download modes and UI routing

| Mode | Single release | Bulk review | Missing Usenet match |
| --- | --- | --- | --- |
| Torrent only | Existing torrent path, with explicit torrent/client labels | Existing torrent selection and estimates | No automatic Usenet lookup; no fallback |
| Usenet only | Lookup and Usenet scope review, then SABnzbd | Resolve each selected row's required hashes; submit Usenet units only | Visible unavailable/processing/error state; no torrent fallback |
| Choose per download | Explicit Torrent or Usenet choice for that action | Protocol choice per release/cour, with apply-to-all; mixed batches allowed | Usenet option shows the reason and is unavailable; Torrent remains a separate explicit choice |

Choose per download must not silently preselect Torrent. Keep protocol selection distinct from choosing a best release among several groups. Apply-to-all sets the selected protocol where usable and leaves incompatible rows visibly unresolved or unavailable. Never change them to the other protocol automatically.

The server enforces the currently saved mode during preflight and acceptance. A forged or stale opposite-protocol request must fail before a client mutation. If settings change while a review is open, invalidate its preflight and require review again. Controls for existing downloads are not restricted by the new mode.

## 7. Scope, preflight and submission

### Effective Usenet scope

Each provider NZB is an actual source unit, not an arbitrary list of requested episodes. Submit the provider's NZB with its article and PAR2 lists intact.

Compare the requested selected paths with the complete source manifest for each hash. If the NZB requires a larger source scope:

1. Show the requested files/cour separately from the actual whole-source scope.
2. List the extra known files, including other episodes/seasons/extras, and show full-source payload size.
3. If the full manifest is incomplete, say the extra scope or size is unknown. Do not invent a file count or claim exact selection.
4. Require an explicit whole-source acknowledgement for that selection before submission.
5. Bind the acknowledgement to the exact preflight plan. Changing the release, protocol, units or scope clears it.

A release with several source hashes can have whole-source expansion on only some units. Explain and deduplicate those units individually. Do not sum the merged release size once for every hash.

Within one protocol, deduplicate units covering the same source hash. For Usenet, two cours using the same whole-source NZB produce one SABnzbd job with both associations. For torrents, preserve existing file-scope unions and whole-torrent precedence.

If mixed review rows request the same source hash through both protocols with overlapping content, flag the conflict and require one acquisition choice before acceptance. Do not silently override a selected protocol or send duplicate copies. Similarly, an app-owned active acquisition covering the requested content must be shown as already in progress, with its actual client, even after a mode change.

### Server-owned preflight

Extend the existing `/api/download_bulk/preflight` endpoint/service to handle protocol-aware selections. Use it for a single release with a one-element selection list as well.

Preflight must:

- Validate source result, release identity, exclusions, ownership, selected protocol and saved mode.
- Resolve Usenet availability and effective scope without enqueuing anything.
- Select concrete provider references and client/category destinations.
- Find existing app-owned units and existing qBittorrent hashes without claiming foreign jobs as app-owned.
- Produce deduplicated units, row associations, payload estimates, scope warnings and per-client storage checks.
- Return an opaque, expiring `plan_id` plus a safe public review. Keep the authoritative plan server-side. It contains no browser-supplied NZB URL.

Retain plans in bounded memory for 15 minutes. A server restart expires unsubmitted plans. Do not persist plaintext URLs with keys or stale credentials to make them survive. The browser can retain selections and obtain a new preflight.

Single submission uses `/api/download` with the plan ID for a single-selection plan. Bulk submission uses `/api/download-jobs` with the plan ID. Both call the same acceptance/submission service. Migrate old selection-only submission callers and tests; do not keep an identity-bypassing route.

At acceptance, revalidate recommendation identities, saved mode/configuration generation, required acknowledgements and duplicate ownership under appropriate locks. Reject expired or changed plans with HTTP 409 and an actionable review message. Reject unavailable/incomplete selections before any units for that selection are enqueued. Other valid rows can still be submitted after the user removes or resolves blocked rows.

Fetch and validate an NZB only when needed for an accepted submission. A fetch can count against a provider's grab allowance; do not fetch every NZB repeatedly during UI polling or ordinary availability checks. Do not mark a discovery match as a completed download.

### Size and disk checks

- Preserve current qBittorrent storage checks and scoped-byte estimates.
- For Usenet, show whole-source payload bytes from a verified full manifest when possible. Otherwise use a clearly approximate provider total or an unknown value.
- Do not equate NZB XML size or summed encoded article bytes with extracted media size.
- Report SABnzbd's known incomplete/complete storage information using the units documented for the supported SABnzbd version. Only associate free space with a category destination when the API supplies enough path information.
- Include the client identity when grouping storage checks. Equal path strings on two client hosts are not the same disk.
- PAR2, archives, unpacking workspace and import copies make payload bytes a lower bound. Do not invent a storage multiplier or show a green sufficient result when total need or destination attribution is unknown.
- Preserve explicit acknowledgements for low or unverified space. Tie them to the current plan alongside scope acknowledgement. A failed read produces an unknown-space warning, not fabricated free space.

## 8. SABnzbd integration

Build API requests under the configured base URL plus `/api`, preserving reverse-proxy paths. Use the full API key server-side. Set JSON output and validate actual response bodies.

### Submission

Prefer server-side NZB retrieval followed by SABnzbd multipart upload:

```http
POST <sabnzbd_url>/api
Content-Type: multipart/form-data

mode=addfile
apikey=<server-held-SABnzbd-key>
output=json
name=<NZB file upload>
cat=<source-specific SABnzbd category>
```

This keeps the AmeNZB key out of the URL SABnzbd stores and avoids requiring SABnzbd's network to fetch from the user's pinned provider IP. Preserve the original release title/NZB name for manager parsing. Use category post-processing defaults; do not change SABnzbd's global configuration.

Require a successful response with valid, nonempty `nzo_ids`. Record every returned native ID and its source associations. A valid acceptance receipt means added to SABnzbd, not download or import completed.

Before the POST, persist the submission intent. After receipt, atomically persist native IDs and app ownership. Only issue controls against confirmed app-owned native IDs.

Do not automatically retry a mutating submission after timeout, connection loss, or an ambiguous response. Mark acceptance unknown, preserve the intent, and show "Submission status unknown. Check SABnzbd before retrying." Do not claim an external queue job from a similar title or content checksum. Never submit through the second provider or qBittorrent to hide uncertain acceptance. Restart recovery must not enqueue these units again automatically.

### Reads and phase mapping

Read targeted queue and history records for known IDs, with pagination/chunking where needed. Include archived history when necessary to distinguish archived records from missing jobs. A job can leave the transfer queue while still repairing or unpacking; queue absence is not completion.

| SABnzbd evidence | Shared phase | UI consequence |
| --- | --- | --- |
| Accepted with receipt, not yet visible | queued | Retain accepted identity; do not submit again |
| Queued, Propagating | queued | Show queued/propagating detail |
| Downloading, fetching repair articles | downloading | Show byte progress and actual transfer speed |
| Paused | paused | Allow resume |
| QuickCheck, Verifying | verifying | Keep active; do not imply completion |
| Repairing | repairing | Show repair phase |
| Extracting | unpacking | Show unpacking phase |
| Moving, Running scripts | post_processing | Keep active with the stage detail |
| History Completed after processing | complete | Completed in SABnzbd, not necessarily imported |
| Failed or explicit error | error | Preserve failure text safely and offer supported removal |
| Successful explicit removal | removed | Preserve an audit/receipt outcome; remove active display |
| No evidence after successful reads | missing | Do not call it complete, delete files, or automatically retry |
| Client unreachable/configuration changed | unavailable | Preserve last known state and ledger; show a connection error |
| Ambiguous submission | acceptance_unknown | No invented native ID or controls |

Treat transfer percentage and post-processing phase separately. Do not hold a fake download speed during repair/unpacking, or hide an active job because transfer reached 100 percent. Aggregate a multi-unit release as complete only when all its required units complete; preserve mixed paused/failed/processing states and missing-unit information.

### Controls

Use stable app-owned job IDs, never `all`, `failed`, `completed`, category-wide purge or global pause/resume operations.

| Action | SABnzbd request | Required safety behavior |
| --- | --- | --- |
| Pause transfer | `mode=queue&name=pause&value=<nzo_id>` | Only a targeted owned queue job; confirm fresh state |
| Resume transfer | `mode=queue&name=resume&value=<nzo_id>` | Only a targeted owned paused job; confirm fresh state |
| Remove active queue job, keep files | `mode=queue&name=delete&value=<nzo_id>&del_files=0` | Default removal behavior; verify the job is no longer active |
| Remove active queue job and files | Same targeted deletion with `del_files=1` | Explicit destructive acknowledgement; no library-file deletion |
| Remove supported history item | `mode=history&name=delete&value=<nzo_id>&archive=0` | Select the correct phase/record; keep files by default |

The documented file-deletion option for history items applies to failed jobs. Do not advertise arbitrary completed-file deletion from history as supported without actual API evidence. Completed items are not included in bulk cancellation, matching current torrent behavior.

Pause/resume applies to transfers. Individual repair/unpack pause is not provided by the queue API. Expose phase-specific capabilities and an explanation; never invoke SABnzbd's global post-processing pause to imitate a per-job control. For loaded post-processing history records, verify targeted cancellation behavior against the supported SABnzbd version. If SABnzbd rejects a targeted action, return the real failure and retain ownership/state rather than reporting success.

SABnzbd documents boolean success responses that can be misleading for some operations. Confirm controls with a fresh targeted queue/history read. Handle queue-to-history races by re-reading and using the appropriate targeted operation, not by broadening deletion scope.

Bulk cancellation includes only app-owned noncompleted jobs, groups operations by bound client and capabilities, and reports partial failures. Keep the current explicit file-deletion option off by default. A shared whole-source job lists all affected cours before removal.

## 9. Persistence and restart recovery

Generalize the authoritative ownership ledger and submission-job store to versioned protocol-neutral records. Use atomic persistence and restrictive permissions through existing helpers.

Migrate existing torrent ledger arrays, version-1 torrent dictionaries and legacy detail records into the new format. Preserve associations, source hashes, selected scope where known, and existing outcomes. Bind legacy torrent records to the configured qBittorrent endpoint at migration when available. If an endpoint cannot be established, preserve the record as unbound rather than inventing a destination or dropping ownership.

If adopting `owned_downloads.json`, perform a one-time checked startup migration from the existing files. Do not keep simultaneous writers to old and new ledgers. Do not remove a legacy file before the new atomic record is durable. Migrate unversioned `download_jobs.json` arrays without losing pending, added, failed or existing units. Remove old runtime aliases after callers migrate.

Persist only what recovery needs: protocol, endpoint identity, source/mirror references without secrets, effective scope, association snapshot, timestamps, intent/result and native IDs. Do not persist provider NZB buffers or API-key-bearing URLs.

On restart:

- Restore accepted jobs and poll their bound clients when configured.
- Treat unfinished submission intents conservatively; never automatically replay unknown mutations.
- Retain SABnzbd IDs independently of source hashes.
- Do not erase records on temporary client failure or after a result disappears in a rescan.
- Expose records whose recommendation association is stale through retained card associations or the existing all-app-downloads bulk control surface.
- Do not send old controls to a newly configured client endpoint.

Clearing scanned data must preserve configuration, availability-independent ownership and acquisition receipts. Expire transient lookup/preflight caches independently.

## 10. UI implementation through Impeccable

### Required workflow

Before any UI work, read `skill://impeccable`. Run the skill's `impeccable context` launcher once in the implementing agent's session against the target surface. Use the resolved skill directory and Windows launcher when needed. Do not assume this planning session's setup has run in another agent's session.

Follow its planning/new-work references as applicable. Read `reference/craft-floor.md` immediately before UI edits; it was intentionally not loaded for this planning-only task. Preserve the incumbent visual world and Operate mode. This is an extension of settings, release review and controls, not a redesign.

Use `PRODUCT.md`, `DESIGN.md`, current tokens/components and relevant existing screenshots as evidence. Code is authoritative when screenshots differ. Do not copy new colors, fonts or decorative layout into this feature. Do not create a new design system or alter unrelated navigation.

### Settings

Extend the existing Download client section into a download settings section containing:

- A labeled three-option radio/segmented group for the strict download mode, with concise descriptions.
- Existing qBittorrent integration and categories with unchanged meaning.
- SABnzbd URL, full API-key field, Sonarr/Radarr SABnzbd categories and connection test.
- Separate provider controls for AnimeTosho NEW and AmeNZB. Explain the public AnimeTosho API and AmeNZB account key/IP-pinning requirement.
- Explicit configuration/connection states and a sentence explaining that Torrent only performs no automatic mirror lookups.

Retain existing secret-field masking, configured indicators, clear confirmation, draft preservation and save footer. Reuse shared controls and brand/icon conventions. A missing new integration logo must not justify fabricated artwork or broken image references.

### Release details and single-download review

Show the protocol, actual destination and Usenet availability next to the existing release identity and scope. Do not replace the SeaDex best/alternative label with a provider label.

Use distinct, visible messages:

- "Checking Usenet availability..."
- "Available on Usenet via AnimeTosho NEW" or "... via AmeNZB"
- "No hash-matched Usenet download found"
- "Usenet mirror is still processing"
- "Usenet unavailable: some source torrents have no matching NZB"
- "Could not check Usenet availability" with a safe reason and Retry
- "Configure a Usenet provider" or "Configure SABnzbd" when appropriate
- "This release has no supported public torrent hash"

Do not express these differences solely through color, a tooltip, a disabled button or a toast. A failed lookup must not appear as definitive no match. Show the source hashes/units that lack coverage through a disclosure when useful.

In Choose per download, let the user explicitly choose Torrent or Usenet. In strict modes, present the relevant action without an opposite-protocol override. Whole-source Usenet expansion uses a review/confirmation with requested scope, actual scope, known extras, full size and acknowledgement. Use the same preflight safety service for single and bulk submissions.

### Bulk review

Keep release-group selection, protocol selection, row inclusion and scope acknowledgement distinct. Use the existing ready/unavailable review structure with unresolved choices rather than hiding unavailable rows.

- Show provider/client and availability per selected release/cour.
- Provide apply-to-all protocol controls in Choose per download.
- Recompute review signatures and invalidate preflight/acknowledgements after any protocol, release or scope change.
- Show separate counts for selected rows, new torrents, new NZBs, existing units, blocked rows and unresolved choices. Show deduplicated download size and per-client disk information.
- Include expanded scope and shared-job associations in the review.
- Preserve current hidden-title defaults, current-results/entire-library scope and cross-page behavior.
- Freeze the accepted selection and display per-unit/per-row outcomes. Closing the review continues an accepted batch in the background.
- Use actual destination copy: "Added to SABnzbd", "Added to qBittorrent", or protocol-neutral wording for mixed totals.

### Progress and controls

Update `DownloadsPanel`, detail state, retained stores, operation summaries, cancellation dialogs and notifications together. Bind actions to stable download record IDs. Include client/protocol in accessible labels, progress descriptions, error messages and removal confirmation.

Keep repairing/unpacking jobs visible. Explain unavailable per-phase actions. Default removal preserves downloaded files. Require explicit acknowledgement for deletion and show all affected associations for shared jobs.

Do not suppress an accepted download because the current mode is different, the library now owns its group, or the release index changed. Completed state may retain current compact behavior, but active/failed jobs must remain reachable.

### Accessibility and visual acceptance

- Radio groups have group labels, keyboard operation and visible selection state.
- Busy/checking states use appropriate status or busy semantics without announcing every poll.
- Preserve native dialog focus, background inertness, Escape behavior and focus restoration.
- Keep destructive confirmation explicit and distinguish removal from file deletion.
- Reuse the existing 44-pixel coarse-pointer targets, responsive wrapping, typography and reduced-motion behavior.
- Verify settings, single choice/review, no-match/error states, mixed bulk review, processing progress and cancellation in the rendered browser at desktop, 390-pixel mobile and 320-pixel narrow widths. Include enlarged text and keyboard navigation.
- Do not validate visuals solely through source inspection, DOM selectors or fabricated screenshots.

## 11. Security and failure rules

- Provider and SABnzbd secrets remain server-side, encrypted at rest and absent from public responses, URLs displayed in the UI, persisted jobs and logs.
- Do not accept arbitrary browser-supplied NZB URLs, native client IDs, categories or deletion scopes as authority. Resolve them from validated source selections and owned records.
- Restrict actions and configuration to the existing authenticated/admin boundaries. Check middleware coverage for new endpoints and preserve same-origin protections.
- Parse Newznab/NZB XML with a maintained parser. Disable external entities/DTD resolution and reject entity declarations. Do not regex-parse XML or evaluate provider markup. Choose one parser dependency rather than multiple conventions, and update lockfiles normally.
- Bound response bytes, decompressed NZB bytes, lookup concurrency, cache size, plans and request batches. Stream/enforce limits while reading; do not allocate an unbounded buffer first. Reject malformed XML, HTML error pages and invalid binary data before SABnzbd submission.
- Validate provider-returned HTTP(S) URLs and redirects. Restrict credential-bearing requests to the configured provider endpoint. Known AnimeTosho storage hosts must be handled explicitly; reject unexpected destinations rather than turning the backend into an arbitrary URL fetcher.
- Do not forward API keys across origin-changing redirects. Permit user-configured private SABnzbd/qBittorrent endpoints through the existing trusted-admin configuration model, not through untrusted lookup responses.
- Sanitize errors into typed codes and bounded text. Do not render SABnzbd history HTML with `dangerouslySetInnerHTML`.
- Read timeouts/errors do not mean no match, client rejection, completion or disappearance. Mutating timeouts do not permit automatic retries.
- API allowance exhaustion and IP-pinning failures must be actionable. Do not retry them in a tight loop.
- Keep controls limited to app-owned records. Never acquire ownership of foreign jobs merely to make duplicate detection or cancellation easier.

## 12. Implementation sequence

One integration owner must own the shared contracts, planning, routes and persistence cutover. If work is delegated, assign disjoint files and supply these contracts. Do not delegate the top-level decisions. Skip builds, lint, tests and formatters mid-flight; run the coordinated verification after integration.

### Phase A: Domain and settings

- Introduce protocol/mode/availability/unit/receipt contracts.
- Replace ambiguous torrent-only public fields and migrate all callers.
- Add configuration defaults, validation, encrypted keys and public configured flags.
- Extend read-only integration testing and configuration invalidation.
- Define versioned persistence migration and authoritative acquisition identities before adding client mutations.

### Phase B: Mirror discovery

- Implement concrete AnimeTosho NEW and AmeNZB clients against their documented hash APIs.
- Implement aggregation for every required source hash, provider ordering, safe errors and bounded demand-driven caches.
- Add the authenticated, identity-validated lookup endpoint under the download route boundary.
- Keep public availability responses free of keys and authenticated URLs.

### Phase C: SABnzbd and recovery

- Implement multipart NZB submission, queue/history reads and capability-aware targeted controls.
- Persist intents/receipts and app ownership with restart-safe recovery.
- Generalize job/progress/cancellation storage and migrate existing torrent records.
- Preserve qBittorrent's concrete implementation and safeguards.

### Phase D: Unified planning and HTTP flow

- Make eligibility, preflight and submission mode-aware.
- Implement whole-source review, deduplicated units, mixed-batch conflict handling and storage uncertainty.
- Require current preflight plans for single and bulk submission.
- Generalize progress/cancellation routes and errors; enforce stable owned IDs.
- Keep accepted jobs independent of subsequent configuration, mode and result changes.

### Phase E: Impeccable UI integration

- Apply the required skill workflow and preserve incumbent design.
- Add settings, single protocol choice, demand-driven availability and scope review.
- Update mixed bulk review, outcomes, retained progress, operation center and cancellation.
- Replace torrent-only copy only where the underlying behavior becomes protocol-neutral. Keep real torrent-specific labels elsewhere.

### Phase F: Regression proof and documentation

- Update contract tests that the deliberate API/type cutover changes.
- Add the consumer-visible regression cases below using the repository's existing isolated test infrastructure.
- Run one coordinated verification pass, inspect actual UI states and fix failures. Do not rerun existing passing suites merely to confirm the same output.
- Complete real-service acceptance with an authorized small source download where credentials are available. Report untested service paths explicitly rather than claiming end-to-end proof.
- Update user and technical documentation in the correct locations and remove temporary scripts/fixtures not needed by permanent tests.

## 13. Required regression and acceptance cases

Use fake HTTP services for deterministic tests; no provider credentials, real NNTP downloads or the user's data directory in permanent tests. Add tests only for real consumer-visible failure risks, not source text, copy wording, wiring echoes or incidental defaults.

### Discovery

- Correct source hash yields a usable AnimeTosho NZB; mismatched hash, malformed JSON and HTML responses cannot enqueue.
- HTTP 404 differs from timeout/error; an entry without an NZB differs from a ready match.
- An NZB present before unrelated processing completes remains usable.
- AmeNZB parses successful RSS, empty RSS and HTTP-200 XML errors correctly. An invalid key/IP pinning failure cannot become no match.
- Provider fallback succeeds without changing the source identity; all misses differ from a miss plus unresolved provider failure.
- Complementary multi-hash releases resolve every needed source and report partial coverage. Repeated hashes cause one lookup/actual unit.
- Cache/in-flight behavior prevents duplicate requests and invalidates on credential/configuration changes; stale responses cannot overwrite a new release's UI state.

### Modes, scope and planning

- Existing settings load Torrent only and normal library operations make no automatic mirror calls.
- Opposite-protocol forged requests fail before mutations in strict modes.
- Choose per download requires explicit choices and supports a mixed bulk batch.
- No-match rows remain visible; valid other rows are not silently narrowed or changed to another protocol.
- Whole-source expansion requires acknowledgement, uses full-source size and lists known extras. Changed selection invalidates acknowledgement.
- Shared cours produce one whole-source NZB job with all associations; merged hashes do not multiply the same release total.
- Conflicting overlapping cross-protocol selections cannot enqueue duplicate copies silently.
- Preflight does not add downloads. Expired plans, changed recommendation identities or changed settings produce conflicts before enqueue.
- Unknown or low SABnzbd space remains an explicit warning, and equal path strings on different clients are not merged.

### SABnzbd, ownership and controls

- Multipart submission receives the expected NZB bytes/category without leaking the provider key into SABnzbd's stored URL.
- Valid native IDs persist and recover. Empty/invalid receipts and mutating timeouts do not produce false success or automatic retry/fallback.
- Queue-to-history transitions keep repair/unpack jobs active; 100-percent transfer is not completion.
- Multi-unit progress preserves partial failure and completes only after all required units finish.
- Targeted pause/resume/delete affects only the chosen owned IDs. Preserve-files deletion is the default; destructive deletion requires explicit acknowledgement.
- A misleading success flag or a queue/history race does not erase ownership or falsely report the control succeeded.
- Foreign jobs and category-wide operations cannot be controlled. Unsupported phase capabilities are explicit rather than implemented with global actions.
- Mixed bulk cancellation preserves unrelated/completed jobs and returns per-client failures.
- Rescan, changed release indices, missing recommendations, changed modes and temporary client outages do not orphan active controls.
- Client URL changes cannot send old controls to the replacement client.
- Legacy ledger/job migration retains torrent ownership, failures and associations; clearing scanned data does not clear acquired-job ownership.
- New secret keys follow blank-preserve/explicit-clear behavior and never appear in public configuration or persisted job records.

### UI workflows

Extend the existing browser fixture scenario set for settings/mode persistence, secret clearing, explicit protocol choice, no match, lookup failure and retry, pending provider processing, whole-source acknowledgement, mixed bulk review, background continuation, SABnzbd progress stages and safe cancellation.

Observe actual browser interactions and rendered states. Include keyboard focus restoration, mobile/narrow layouts, enlarged text, descriptive progress semantics and touch targets. Do not pin tests to exact copy or implementation-specific layout details.

### Verification commands

Consult `docs/development.md` and the current package scripts. For the completed feature, use the existing coordinated entry points:

```bash
npm test
npm run test:browser
```

`npm test` builds server tests and uses `tests/run-tests.mjs` to isolate persistence under a temporary `DATA_DIR`. Do not execute data-mutating tests directly against the live application directory. Avoid redundant full builds or unrelated Docker/release checks unless the feature changes those paths.

For authorized live acceptance, use an isolated Companion data directory and a deliberately small source. Demonstrate both provider lookup paths, SABnzbd submission, pause/resume, preserve-files removal, explicit deletion on a disposable job, restart recovery and category-based manager discovery. Never delete the user's library files or silently enqueue a real batch as a connection test. If AmeNZB credentials or a Usenet provider are unavailable, finish deterministic coverage and record exactly which live claims remain unverified.

## 14. Documentation and definition of done

Update `README.md` only with user-visible setup and operation:

- Three modes and strict behavior, including no automatic protocol fallback.
- SABnzbd API key and category setup, and Sonarr/Radarr connection/category requirements.
- Provider configuration, public AnimeTosho API, AmeNZB account/IP-pinning limits and exact-hash coverage limitations.
- Whole-source warnings, unavailable versus failed lookups, repair/unpack phases and preservation/deletion controls.
- Storage estimates, background/restart behavior and existing persistent-volume/security advice.

Place implementation details, migrations, verification commands and development instructions under `docs/`, not the README. Add a release note under `docs/releases/` using the repository's release/version conventions. Update Impeccable product/surface documentation only as its workflow requires, with factual new capabilities rather than a design-system rewrite.

The feature is done only when:

- Both specified hash providers work through the same end-to-end acquisition flow.
- SABnzbd jobs have real receipts, persisted ownership, progress and safe targeted controls.
- Single and mixed bulk downloads enforce saved modes and current review acknowledgements server-side.
- No matching NZB is visible as an unavailable state, not a hidden button or a swallowed error.
- Existing torrents, file priorities, categories, ownership, bulk review, cancellation and encrypted settings remain functional.
- Active controls survive result/mode changes and restart without targeting foreign jobs.
- All UI work followed Impeccable and was inspected in the rendered browser.
- Regression results and any live-service verification limits are reported accurately.
- No stubs, fake fallbacks, obsolete runtime APIs, automatic title matches, undocumented silent scope widening or secrets in browser data remain.

## 15. Primary sources and evidence limits

Recheck provider domains and supported SABnzbd API behavior when implementing; the URLs below were the sources for this plan.

- [GitHub feature request](https://github.com/hiranaka99/SeaDex-Companion/issues/20)
- [AnimeTosho NEW API/about documentation](https://animetosho.net/about)
- [AnimeTosho NEW capabilities](https://feed.animetosho.net/api?t=caps)
- [Verified hash lookup example](https://feed.animetosho.net/json?show=torrent&hash=b59e2358e8c28e89bed053e40f8bd3a4cb1eec81)
- [Verified SeaDex-linked batch lookup](https://feed.animetosho.net/json?show=torrent&hash=a3fe138a71a7913b761cfd87e76bdf3756f09529)
- [SeaDex-linked batch release page](https://animetosho.net/view/706201)
- [AnimeTosho NEW SeaDex processing update](https://animetosho.net/news/1037)
- [AnimeTosho NEW skipping policy](https://animetosho.net/about/skip)
- [AmeNZB search/hash/download API](https://amenzb.moe/wiki/amenzb/search-api)
- [SABnzbd API, including queue/history and control semantics](https://sabnzbd.org/wiki/configuration/5.1/api)
- [NZB specification](https://sabnzbd.org/wiki/extra/nzb-spec)
- [Sonarr failed-download handling source](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Download/FailedDownloadService.cs)

Observed during planning: AnimeTosho NEW's public hash lookups returned original source hashes and NZB references, including a SeaDex-linked batch. AmeNZB's hash path was verified in its documentation, not through an authenticated lookup. SABnzbd control semantics were inspected in its documentation, not exercised against a live configured downloader. No real Usenet download, repair or library import was started while writing this plan. The original SeaDex API did not resolve in the research environment, so this document makes no catalog-wide mirror-coverage claim.

## 16. Amendment: private-tracker releases through Prowlarr

### Status and purpose

Implemented. SeaDex withholds the info hash of a torrent on a private tracker (its API returns `"<redacted>"`, for example for AnimeBytes), so neither the hash providers above nor qBittorrent magnets can reach it. SeaDex does still list that torrent's files with their exact sizes. This amendment uses the indexers the user has configured in Prowlarr to find the release, and uses the file list to prove that what Prowlarr found is that release.

### Confirmed decisions

1. Prowlarr is optional, off by default, and configured with `prowlarr_enabled`, `prowlarr_url` (including any URL base) and the encrypted secret `prowlarr_key`. For private-tracker releases it is used only while Release preferences include private trackers (`tracker_mode: 'private'`). Public-tracker mode never searches Prowlarr for them, even for owned private-tracker releases that stay visible there.
2. Releases with a usable public hash still use magnets for torrents and the AnimeTosho/AmeNZB hash chain first for Usenet. *(Amended later: when every enabled hash indexer answered "no NZB" for a hash, and SeaDex lists that torrent's files with sizes, the user may search Prowlarr for it. This works in either tracker mode. The source is the torrent's own file list (`torrent_files`); the same checks, candidates and limits apply as for private-tracker releases. A copy found this way is planned and owned under the real info hash, with `provider: 'prowlarr'`. Availability rows report it as `fallback: 'prowlarr'` until Prowlarr has a result, then as `search: 'prowlarr'`. A failed or still-processing hash lookup never falls back.)*
3. Title and size from search results only choose which candidates are fetched. At most three candidates are fetched per release, because every fetch through Prowlarr counts as a grab on the indexer. *(Amended by the [Usenet finder plan](usenet-finder-implementation-plan.md): up to three fetches for **Search Prowlarr**, **Search again** and a single download review; one per source for **Check now** and for each row of a bulk review, within a daily fetch limit per indexer; none for a bulk preflight, an acceptance or the background sweep.)*
4. A candidate is accepted only by its own content:
   - **Torrent:** the `.torrent` file must hold exactly SeaDex's files: the same multiset of base names and byte sizes, nothing more and nothing less. The real info hash is the SHA-1 of the raw `info` dictionary.
   - **NZB:** the NZB subjects must name every SeaDex video file with its exact decoded size (the trailing size Nyuu and ngPost write after `yEnc (n/m)`). Extra files such as PAR2 sets are allowed. Obfuscated, repacked or size-less posts never match. *(Amended by the [Usenet finder plan](usenet-finder-implementation-plan.md): an NZB is graded `exact`, `near_exact`, `probable`, `size_only` or `unverified` from its subjects and segment byte sums. `exact` and `near_exact` are sent automatically, `near_exact` labelled as such; the other levels only after an explicit choice and confirmation.)*
5. A release that cannot be proven is reported as no match, with the reason. The NZBs that were checked without being proven are listed as candidates. Each shows its title, indexer, reported size, how many episode files match by name and exact size, how many match by name alone (for posts whose subjects list no sizes), and a link to its page on the indexer. The link comes from Prowlarr's `infoUrl`, `commentUrl` or `guid`; links on Prowlarr's own origin, download links, and links with a key-like parameter or the Prowlarr key are never shown. The user may download one candidate after an explicit confirmation in release details. The single-download selection then names it (`nzb`: the candidate's entry ID), and naming it is the acknowledgement. Nothing is searched again; the checked bytes are sent. A chosen NZB is refused for a public release or for the torrent protocol, and reported as `not_searched` once its search result has expired.
6. A Usenet search runs only when the user asks in release details (**Search Prowlarr**, sent as the availability request's `search` rows, never implied by `refresh`), or for a single explicit download. Bulk reviews use earlier search results only and block unsearched rows with `not_searched`. Private torrent lookups may run in bulk reviews, because they fetch only small `.torrent` files from the user's own tracker account. *(Amended by the [Usenet finder plan](usenet-finder-implementation-plan.md): searching costs no grab and may run in the background when **Search Usenet indexers in the background** is on, within a daily search limit per indexer. A bulk review searches and checks the rows chosen for Usenet through availability `verify` rows before its preflight; the preflight and the acceptance only read stored results. `not_searched` remains for a source without a search record, and `not_verified` blocks a source whose results were not checked.)*
7. qBittorrent receives the checked `.torrent` file itself (multipart upload), not a magnet. Selected-file scopes work as for public torrents; the torrent stays stopped until file priorities are set, because its metadata is already known.
8. SABnzbd receives the NZB bytes that were checked; submission does not fetch it again while those bytes are in memory. *(Amended by the [Usenet finder plan](usenet-finder-implementation-plan.md): the checked bytes are kept on disk in `DATA_DIR/nzb_store/` across restarts. An NZB evicted from that store is fetched once more on submission, within the fetch limit, and sent only when it is the same file or grades to the same proof.)*

### Identities

- `PrivateSource` (`shared/contracts.ts`) is attached to a release as `private_sources` only when the release has no usable hash: `{ id, page?, files }`. `page` is the tracker page SeaDex links; `files` is the whole torrent's file list.
- `id` is `files:` plus the SHA-1 of the sorted `basename\0size` lines (`server/source-files.ts`). It is independent of file order and folder, is never 40 bare hex characters, and so can never be confused with an info hash (`FILES_SOURCE_PATTERN`, `normalizeSourceId` in `shared/ids.ts`).
- A private torrent is planned, owned and controlled under its **real** info hash from the `.torrent` file. Torrent ledger records never accept a `files:` identity as their source hash; they keep it as `source_alias`, which progress reports so the browser can attach the download to the private release, since the release has no hash of its own.
- A Usenet copy of a private release is planned and owned under the `files:` identity, with `provider: 'prowlarr'` and an entry ID of the indexer ID plus a digest of the result GUID. The ledger accepts `files:` identities for Usenet records only.
- `SubmissionUnit.sourceAlias` carries the `files:` identity of a private torrent unit, so one review never sends the same private release through both protocols.
- `releaseIdentity` is unchanged; `private_sources` does not take part in it or in release-change detection.

### Modules

| Module | Responsibility |
| --- | --- |
| `server/prowlarr.ts` | Prowlarr API (`/api/v1/system/status`, `/api/v1/indexer`, `/api/v1/search`) with the key in `X-Api-Key`; download links re-rooted on the configured origin and URL base; download redirects (Prowlarr's per-indexer **Redirect** option) followed up to three hops to http(s) only, without the Prowlarr key, and redirects to magnets refused; tracker-name matching (`AB` → AnimeBytes and others) restricted to private torrent indexers; connection test |
| `server/torrent-file.ts` | Bounded bencode reader: info hash, file list, private flag, BEP 47 padding files skipped |
| `server/source-files.ts` | `files:` identity, exact torrent comparison, NZB subject parsing and NZB comparison |
| `server/private-sources.ts` | Search, candidate ranking and checks, in-flight deduplication, concurrency limit of two, caches and bounded NZB byte retention (128 MB). *(Amended by the [Usenet finder plan](usenet-finder-implementation-plan.md): now the private torrent lookup only; the Usenet half moved to `server/usenet-search.ts` and `server/usenet-search-store.ts`.)* |
| `server/download-preflight.ts` | Resolves private torrent rows before ownership is read; plans private Usenet rows by `files:` identity; new block codes `private_no_match`, `private_lookup_failed`, `not_searched` |
| `server/usenet.ts` | Availability rows for private releases (`search: 'prowlarr'`), never searched without `refresh`; `fetchUsenetNzb` hands Prowlarr entries to the private-source cache |
| `server/qbittorrent.ts` | `qbAddTorrent` accepts `{ hash, file }` as well as a magnet |

### Caching

*(Amended by the [Usenet finder plan](usenet-finder-implementation-plan.md): the table below now holds for private torrent lookups only. Usenet search results, checks and fetched NZBs persist in `DATA_DIR/usenet_search.json` and `DATA_DIR/nzb_store/` with the freshness rules in section 8 of that plan and in [maintainability.md](maintainability.md#usenet-finder-through-prowlarr), and a change of the Prowlarr URL or key drops those of the previous connection. The Usenet rows of the table and the restart sentence below it no longer apply.)*

Observations live in memory only and are keyed by a credential-free Prowlarr fingerprint plus the source identity. Changing any Prowlarr setting clears them.

| Observation | Kept for |
| --- | --- |
| Torrent match (with the `.torrent` file) | 1 hour |
| Torrent no match | 30 minutes |
| Usenet match | 12 hours (NZB bytes dropped oldest-first beyond 128 MB, then fetched again and re-checked on submission) |
| Usenet no match | 6 hours |
| Failure | 1 minute |
| Missing indexer | 5 minutes |

**Search again** bypasses a cached Usenet result. A restart forgets every observation; a Usenet copy must then be searched again before a bulk review can send it.

### Failure and unavailable states

- Prowlarr not set up, or public-tracker mode: torrent rows block as `no_torrent` with a hint to set up Prowlarr. Usenet rows block as `no_match` with the same hint, and release details show *Usenet unavailable* with setup guidance.
- No Prowlarr indexer for the tracker, or no Usenet indexer: `private_no_match`, or `usenet_unconfigured` for Usenet, naming what is missing.
- Candidates found but none proven: `private_no_match`, or `no_match` for Usenet, saying how many candidates were checked.
- Prowlarr unreachable, unauthorized or rate limited: `private_lookup_failed`, or `lookup_failed` for Usenet. A failure is never reported as absence.

### Verification

`tests/prowlarr.test.ts` covers the bencode info hash and file list; identity stability; strict torrent and NZB comparisons, including size-less and obfuscated posts; catalog and saved-result handling of private sources, including rejection of a hash-shaped `files` ID; link re-rooting and URL-base enforcement; tracker-to-indexer matching; the end-to-end private torrent flow (tracker ID preferred over a same-size decoy, a single search and a single `.torrent` fetch shared by review and acceptance, multipart upload, real-hash ledger record); refusal of a torrent whose files differ; public-mode and unconfigured refusals without Prowlarr calls; the Usenet flow (no search without a request, `not_searched` in bulk, release-group filtering, exact NZB match, the checked bytes sent to SABnzbd, ownership on re-review); ledger identity rules; secret handling of the API key; attaching private torrent and Usenet progress to their release rows; and unproven candidates (safe indexer link, file-match counts, explicit choice sending the checked bytes, refusal of unknown or misplaced choices).

Not verified against live services: no real Prowlarr instance, AnimeBytes account, Usenet indexer or SABnzbd download was used. The AnimeBytes torrent-ID match relies on Prowlarr exposing the tracker's `torrentid` in a result link (`guid`, `infoUrl` or `commentUrl`). When it does not, a torrent of the same total size is checked instead, and the file comparison still decides. UI changes extend existing components and patterns; they were not produced through the Impeccable workflow required in section 10, and were checked with the existing browser smoke suite rather than a dedicated visual review.

### Known limits

- **What Prowlarr covers:** the UI only offers what Prowlarr's indexers can serve. `GET /api/prowlarr/coverage?trackers=…` returns which of the given SeaDex tracker names have an enabled private torrent indexer, and whether any Usenet indexer exists.
  - **Torrents:** the library fetches this for the trackers its private releases use and enables the torrent path (`findsPrivateTorrent`) only for covered trackers. Until Prowlarr answers, or when it cannot be reached, nothing is offered.
  - **Usenet:** availability reads the cached indexer list without waiting. When the list shows no Usenet indexer, private rows report `not_configured` ("Prowlarr has no Usenet indexer.") and public rows get no Prowlarr fallback. While the list is unknown, searches stay offered and the list is refreshed in the background.
  - **Server checks:** planning still checks both server-side.
- A candidate whose NZB cannot be fetched is still listed, with its indexer link and the reason, but can never be sent. When every candidate fails for a transient reason, the search counts as failed rather than as no match.
- Obfuscated Usenet posts cannot be proven and are never offered. PAR2-based verification would need article retrieval, which SABnzbd owns (section 1 boundaries).
- Search terms follow Sonarr's anime search (`NewznabRequestGenerator`): one text query (`t=search`) per scene title, cleaned with Sonarr's `GetCleanSceneTitle` rules. Those rules drop a leading "The", turn `&` into "and", delete `' . \` ´ ‘ ’`, treat other non-word characters as separators and remove diacritics (`server/search-titles.ts`).
  - **Titles:** the library title, then Sonarr's `alternateTitles` that apply to the season (captured during scans as `search_titles`), then AniList's romaji and English titles from the scan's metadata cache. Deduplicated after cleaning, at most four.
  - **Usenet queries:** led by the cleaned release group (`ZR Banished From the Heros Party …`) and restricted to categories 5070 and 5000 for Sonarr, 2000 for Radarr. Every title is searched, as Sonarr does, and candidates are ranked across all answers. Tracker searches stop early only once the tracker's own torrent ID appears. *(Amended by the [Usenet finder plan](usenet-finder-implementation-plan.md): Usenet searches use no categories, order the titles by their fit with the release's file names, send each indexer at most four queries per source and stop at the first strong candidate.)*
  - **Tracker searches:** the titles alone, without categories, as the tracker's own naming decides.
  - **Not covered:** an indexer that knows the release under none of these titles reports no match.
- A multi-season private torrent is one source: its Usenet copy is the whole upload, and selecting one season needs the existing whole-source acknowledgement.

