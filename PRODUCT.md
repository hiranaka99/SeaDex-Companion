# SeaDex Companion

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People managing personal anime libraries through Sonarr and/or Radarr on a trusted home network. They need to identify better releases, understand season and episode matches, and choose which upgrades to download.

## Product Purpose

A self-hosted companion that compares existing anime libraries with releases indexed by SeaDex. Success means users can understand their library's upgrade status and selectively acquire better releases with confidence about the affected episodes, download size, and available disk space.

## Positioning

Connects SeaDex release recommendations to the user's actual Sonarr/Radarr library, with season-, cour-, and episode-aware matching and optional public-release downloads through qBittorrent.

## Operating Context

- Users create an administrator account, configure and test integrations, then scan their library.
- Library browsing groups seasons under an anime in a card view, with search, filtering, sorting, pagination, and release details. The table view and view switcher were explicitly removed at the user's request.
- Users inspect matching and release details, correct AniList mappings or exclude seasons/cours when needed, then select individual or bulk downloads.
- Downloads are monitored and controlled from library cards; bulk cancellation remains available.
- Scan history, configuration, and server logs support ongoing operation and troubleshooting.
- Scans can run manually, on a configured schedule, or incrementally through Sonarr/Radarr webhooks. Discord notifications are optional.
- The intended deployment is self-hosted on a trusted home network. Preserve the repository's private remote-access and persistent-data guidance.

## Capabilities and Constraints

- Preserve existing workflows, matching details, and download safeguards. This is an explicit user commitment for future UI work.
- Preserve the distinctions between Upgradable, Best quality, Partially on SeaDex, and Not on SeaDex, together with matching-review and missing-episode information.
- Keep split seasons, cours, multi-part releases, current-versus-target sizes, and release identities understandable.
- Downloads require configured qBittorrent access and are limited to supported public releases. Preserve missing-episode file selection where possible.
- Bulk review deduplicates shared torrents and selected files, skips existing hashes, and checks download-disk space where supported. Low-space warnings require acknowledgement.
- Estimates do not reserve space or include torrent overhead or library-import copies. Unavailable size or disk-space information must remain explicit.
- Preserve password protection, session handling, credential encryption, and file-preservation defaults. Retain explicit warnings and confirmation for irreversible file deletion.
- Library pagination affects presentation; search, filtering, counts, and bulk review operate on the full collection.
- Keep the current navigation: Library, Scan history, Configuration, and Server log. Downloads are managed within the library rather than a separate page.

## Brand Commitments

Use the existing name, SeaDex Companion, and established integration terminology: SeaDex, Sonarr, Radarr, qBittorrent, AniList, and Discord. Existing application artwork and integration marks are available in the repository. No new voice or visual direction was selected during initialization.

## Evidence on Hand

- `README.md`: product overview, supported capabilities, deployment, configuration, and security guidance.
- `frontend/src/`: the existing React interface and user-facing workflows; `frontend/public/`: application assets.
- `server/` and `shared/`: implementation and shared domain contracts.
- `tests/`: regression and browser workflow fixtures.
- `docs/screenshots/`: reference captures of release-related reviews, scan history, and sign-in.
- `docs/ui-ux-audit.md`, `docs/ui-ux-follow-up-audit.md`, and `docs/ui-ux-follow-up-implementation.md`: prior scoped interface reviews and their reported validation limits.
- `docs/releases/`: documented release behavior.

Repository screenshots and audit results are evidence of specific existing states, not testimonials, accessibility certification, or guaranteed production performance.

## Product Principles

1. Make recommendations explainable through the user's actual season, cour, episode, and release details.
2. Keep users in control of download scope and preserve review, acknowledgement, and file-deletion safeguards.
3. Distinguish confirmed information from missing, partial, stale, or uncertain information.
4. Preserve established workflows and domain behavior while improving presentation.
5. Keep self-hosted operation understandable through configuration, scan history, and actionable diagnostics.

## Open Decisions

No product-specific accessibility standard or additional audience requirement was established during initialization. Future work should preserve existing accessibility behavior; prior audit scores do not establish conformance.
