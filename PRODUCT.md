# SeaDex Companion

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a home-server anime collector who already uses Sonarr, Radarr, or both and wants to identify, review, and download better releases from SeaDex. This audience and job were confirmed by the project owner during initialization.

## Product Purpose

Compare the user's existing anime library with releases recommended by SeaDex, explain where upgrades are available, and help the user send selected public releases to qBittorrent. Success means users can understand their library's quality and complete upgrades with accurate matching and a simple workflow. The owner gives these two priorities equal weight.

## Positioning

SeaDex Companion connects SeaDex recommendations to the user's actual Sonarr/Radarr collection. Season-, cour-, part-, and episode-aware comparison makes recommendations actionable for an existing library, including downloads limited to missing episodes when possible.

## Operating Context

- Self-hosted on a trusted home network, with a local administrator account; remote access follows the private VPN or protected HTTPS reverse-proxy guidance in README.md.
- The main workflow is account setup, integration configuration and testing, library scanning, upgrade review, download selection, and download monitoring.
- The existing application surfaces are Library, Scan history, Downloads, Configuration, and Server log. Library browsing supports cards and a compact table.
- Scans can run manually, on a schedule, or after supported Sonarr/Radarr webhook events. Scheduled scans also reconcile changes to older SeaDex entries.
- The existing implementation uses React, TypeScript, Vite, and Tailwind CSS for the frontend and a Node.js/TypeScript backend. Docker is the documented deployment path.
- Local development uses `npm run dev` for the backend and `npm --prefix frontend run dev` for the Vite frontend. Vite proxies `/api` to port 8080; builds emit the frontend into `static/`.

## Capabilities and Constraints

The following capabilities and constraints are established by the repository's README and implementation:

- Group seasons into one anime entry, search and filter the library, compare local and target sizes, and explain matching and upgrade status.
- Preserve the distinction between Upgradable, Best quality, Partially on SeaDex, Not on SeaDex, and entries requiring matching review. Missing catalog coverage or uncertain matching must remain visible.
- Support manual AniList mapping corrections and season/cour exclusions.
- Send individually selected or bulk public releases to qBittorrent; private or unavailable releases are not automatically downloadable.
- Bulk estimates deduplicate shared torrents and selected files, skip existing hashes, and check download-disk space where supported. Estimates do not reserve space or include torrent overhead and library-import copies; unavailable space checks must remain explicit.
- Low-space warnings require acknowledgement before sending downloads. Existing torrents are skipped without changing their files or ownership.
- Monitor, pause, resume, cancel, and remove tracked downloads. Keep app-added torrents manageable after recommendations change.
- Provide scan history, change tracking, optional Discord notifications, live logs, and interval/daily/weekly scheduling with timezone and missed-run controls.
- Configure integration credentials through the UI. The current implementation includes password protection, Argon2ID password hashing, session revocation, and AES-256-GCM credential encryption.
- Keep persistent configuration, account data, keys, caches, results, and logs in the configured data directory. Follow the existing trusted-network deployment guidance.

## Brand Commitments

The established product name is SeaDex Companion. Existing identity assets include `frontend/public/favicon.png`; integration marks are implemented in `frontend/src/components/BrandLogo.tsx`. UI terminology follows SeaDex, Sonarr, Radarr, qBittorrent, and AniList. No additional binding brand or voice direction was supplied during initialization.

## Evidence on Hand

- `README.md`: product description, supported workflows, setup, deployment, security guidance, and known download-estimate limitations.
- `frontend/src/` and `server/`: implemented application behavior and UI copy.
- `shared/`: release identity, download estimates, and scan scheduling logic.
- `tests/`: backend, HTTP, scheduling, matching, download, and browser workflow checks.
- `docs/screenshots/`: committed examples of sign-in, scan history, bulk download review, and bulk cancellation. These are reference artifacts; check freshness against current source before visual work.
- No customer testimonials, adoption metrics, or comparative performance claims were confirmed during initialization. Future work must not invent them.

## Product Principles

1. Give matching accuracy and workflow simplicity equal weight; improve one without obscuring the other.
2. Explain why an upgrade is recommended and expose uncertainty, partial coverage, and unavailable releases.
3. Keep download decisions understandable through release scope, size estimates, existing-torrent handling, and explicit consequences for cancellation or removal.
4. Preserve user control over mappings, exclusions, scheduling, and selected downloads.
5. Respect the self-hosted operating context, private integration credentials, and persistent user data.

## Open Decisions

No specific accessibility conformance target, additional audience, or new feature roadmap was established during initialization. Existing keyboard-focus, navigation-label, responsive-layout, and reduced-motion behavior is implementation evidence to preserve and verify in future UI changes.
