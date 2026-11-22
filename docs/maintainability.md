# Runtime ownership

HTTP composition lives in `server/index.ts`; download routes and scheduling have their own modules. Production modules import their owners directly. `server/app.ts` retains the previous exports for callers and existing tests.

The scan service resolves its dependencies once. Its coordinator owns admission, cancellation, progress, commits, and notifications; `assessment.ts` computes a season recommendation without I/O. Sonarr and Radarr adapters load independently. Shared API contracts describe results and configuration, while `result-model.ts` normalizes old cached results before they reach API readers or download commands.

`shared/download-plan.ts` owns upgrade eligibility, torrent hash normalization, and per-hash file selection. Review, estimation, and execution consume those rules. Whole-torrent requests override scoped requests; file scopes are united across selections. Incomplete metadata stays uncertain and never becomes permission to download unrelated files.

Recommendations are identified by result/release identity. Acquisitions are identified by app-owned record ID and bound client endpoint, with source hashes, effective file scope, and every library/release association retained separately. Frontend projection validates the current hashes and scope before attaching a record to a recommendation. A replacement recommendation cannot change the acquisition selected for control or cancellation.

Download jobs capture each unit's actual selection associations before external work. `POST /api/download-jobs` returns an accepted job ID; `GET /api/download-jobs/:id` and `/latest` expose persisted state. Unfinished jobs become interrupted on restart rather than repeating side effects. Every admitted job reaches a terminal outcome when its state can be persisted, including ownership-intent failures. Single-release receipts aggregate every required source, and row outcomes stay pending until all sources settle. One frontend observer handles submission and reload recovery, and the retained download store survives card pagination and unmounts.

qBittorrent sessions and caches belong to each connection. Mutation locks belong to torrent hashes; sorted acquisition prevents multi-hash deadlocks. Metadata loading therefore does not block independent status reads or controls.

## Provider discovery and reviewed plans

One priority-aware scheduler assigns lookup capacity only when provider pacing permits a request to start. Foreground requests precede queued background work, and configuration invalidation cancels stale work without retaining its results. Each prefetch sweep owns an epoch; superseded work cannot overwrite current progress.

Availability requests validate canonical release identities before querying providers. Internal resolvers retain complete validated manifests for scope decisions. The public availability projection bounds filename lists and clears their completeness flag when names are omitted. NZB validation reads the standard nested segment structure and accepts the standard public declaration without resolving external entities.

`server/usenet-cache.ts` owns `DATA_DIR/usenet_cache.json`, a versioned cache of provider observations. Records are scoped by provider, source hash, and a SHA-256 fingerprint of the provider URL and credentials. The file stores neither those credentials nor credential-bearing URLs or NZB payloads. Cache reads do not rewrite the file, and incompatible provider configuration removes only the affected records. The existing 4,000-record capacity bound remains; age alone does not delete an observation.

Freshness intervals are 24 hours for a usable source, one hour for no match or deletion, two minutes for processing, and one minute for lookup failures. Public availability returns cached or unchecked snapshots immediately and coalesces missing or stale checks in the background. Failed refreshes retain prior observations with retry state and an error. Observation timestamps reflect provider work, not cache access. Open reviews observe only their refreshing rows and retain cached data and choices until updated results arrive.

Successful provider observations checkpoint atomically before exposure, including on platforms that can terminate a process without shutdown hooks. Failure metadata and configuration pruning use batched writes, and graceful shutdown flushes pending changes. Authoritative resolver and preflight calls await fresh-on-stale data rather than treating retained stale observations as a new successful check. The actual provider NZB is fetched and validated before SABnzbd submission.


Bulk review retains its selected result snapshot. Acceptance checks current identities, client presence, and acknowledgements again before writing intents. Provider-backed reviews are cancellable and rely on bounded provider requests rather than a fixed aggregate frontend deadline. Expired or consumed single plans require an explicit fresh review with acknowledgements reset.


# Persistence and compatibility

AniList metadata is persisted under `media:v1:<id>` and shared by automatic chains and explicit season matches. Known IDs from the active scan's saved title matches, chains, and manual selections are loaded through `Page.media(id_in: ...)` in batches of up to 25. All batches use the same serialized transport and 2.1-second pacing as interactive searches. Batch errors must propagate rather than being cached as missing titles; successfully omitted IDs are cached as missing for 24 hours.

Raw metadata and derived season/chain caches expire after 24 hours. Derived caches inherit the oldest raw metadata timestamp used, preventing reuse from extending stale metadata indefinitely. A newly required Sonarr season forces one relation refresh even for fresh raw data. Fully manual items skip automatic title matching and traversal, and use manual metadata for continuous episode offsets only when inferred matches agree with every explicit selection.

Configuration settings and their AES-GCM encrypted credentials share one atomic `config.json` commit. Ordinary reads do not write. Startup migration reads the former separate secrets file without replacing the existing key. Back up the complete data directory before upgrading; restore that backup for older versions that expect separate credential storage.

`owned_downloads.json` contains the versioned protocol-neutral record ledger and its release associations. Legacy ownership arrays, versioned torrent dictionaries, and separate `download_records.json` details are read together during migration. Ownership, scope, native-ID bindings, and associations are committed before publishing in-memory state. Failed writes leave the prior ledger intact.

Job updates also write before publishing in-memory state. Readers receive copies, and no credentials are stored with jobs. Unknown acceptance retains duplicate protection. A fresh complete client read can establish presence or absence; malformed, failed, or endpoint-mismatched reads cannot. Removal of a confirmed missing acquisition changes only tracking and preserves files.

# Verification

Run `npm test`, `npm run build`, and `npm run test:browser`. `npm run test:docker` builds a fresh image and checks startup, health, assets, authentication, encrypted persistence, job IDs, restart recovery, and graceful shutdown using an isolated container without mounting host data.
