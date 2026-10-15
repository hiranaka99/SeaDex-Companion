# Runtime ownership

HTTP composition lives in `server/index.ts`; download routes and scheduling have their own modules. Production modules import their owners directly. `server/app.ts` retains the previous exports for callers and existing tests.

The scan service resolves its dependencies once. Its coordinator owns admission, cancellation, progress, commits, and notifications; `assessment.ts` computes a season recommendation without I/O. Sonarr and Radarr adapters load independently. Shared API contracts describe results and configuration, while `result-model.ts` normalizes old cached results before they reach API readers or download commands.

`shared/download-plan.ts` owns upgrade eligibility, torrent hash normalization, and per-hash file selection. Review, estimation, and execution consume those rules. Whole-torrent requests override scoped requests; file scopes are united across selections. Incomplete metadata stays uncertain and never becomes permission to download unrelated files.

Recommendations are identified by result/release identity. Running downloads are identified by torrent hash, with separate library/season associations. Changing a recommendation cannot change the torrent selected for cancellation.

Download jobs capture the selected plan before external work. `POST /api/download-jobs` returns an accepted job ID; `GET /api/download-jobs/:id` and `/latest` expose persisted state. Unfinished jobs become interrupted on restart rather than automatically repeating side effects. The previous synchronous bulk endpoint remains available for existing callers. One frontend observer handles submission and reload recovery, and the retained download store survives card pagination and unmounts.

qBittorrent sessions and caches belong to each connection. Mutation locks belong to torrent hashes; sorted acquisition prevents multi-hash deadlocks. Metadata loading therefore does not block independent status reads or controls.

# Persistence and compatibility

Configuration settings and their AES-GCM encrypted credentials share one atomic `config.json` commit. Ordinary reads do not write. Startup migration reads the former separate secrets file without replacing the existing key. Back up the complete data directory before upgrading; restore that backup for older versions that expect separate credential storage.

`owned_torrents.json` now contains `{ version: 1, torrents: { [hash]: metadataOrNull } }`. Legacy ownership arrays and separate `download_records.json` details are read together and migrated on the next ownership commit. Unattributed legacy hashes remain cancellable in the all-downloads scope. Ownership and associated metadata are committed before in-memory state changes.

Job updates also write before publishing in-memory state. Readers receive copies. No credential data is stored with jobs.

# Verification

Run `npm test`, `npm run build`, and `npm run test:browser`. `npm run test:docker` builds a fresh image and checks startup, health, assets, authentication, encrypted persistence, job IDs, restart recovery, and graceful shutdown using an isolated container without mounting host data.
