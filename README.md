# SeaDex Companion

SeaDex Companion is a self-hosted web UI that compares your **Sonarr** and **Radarr** anime libraries with the best releases indexed by [SeaDex](https://releases.moe/). It highlights missing upgrades, explains the match season by season, and can send selected public releases directly to qBittorrent.

<p align="center">
  <img width="100%" alt="SeaDex Companion library showing anime upgrade status" src="docs/screenshots/library.png" />
</p>

> [!WARNING]
> This project is built and maintained as a personal, heavily AI-assisted project. It is tested with care, but you should review its configuration and behavior before relying on it.

## Highlights

- One card per anime, with all seasons grouped together
- Upgrade states for **Upgradable**, **Best quality**, **Partially on SeaDex**, and **Not on SeaDex**
- Episode-aware matching for split seasons, cours, and multi-part releases
- Current-size versus target-size comparison
- One-click or bulk downloads through qBittorrent, limited to missing episodes when possible
- Bulk download estimates deduplicate shared torrents and selected files, skip existing hashes, and check qBittorrent download-disk space where supported
- Bulk review follows your library filters, with an explicit entire-library scope and background batch progress
- Download monitoring, pause, resume, cancellation, and removal
- Search and filtering by title, release group, source, and status
- Matching-review status and aired-episode missing counts
- Manual AniList corrections and season/cour exclusions
- Interval, daily, or weekly scans with timezone and missed-run controls
- Sonarr and Radarr webhooks for incremental scans when titles are added
- Scan history, change feed, Discord notifications, and live server logs
- Password-protected UI, Argon2ID password hashing, session revocation, and AES-256-GCM credential encryption
- Guided connection setup and mobile layouts with larger touch controls

## Quick start

### Docker

The published image is available from [Docker Hub](https://hub.docker.com/r/hiranaka/seadex-companion).

```bash
docker run -d \
  --name seadex-companion \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v seadex-data:/app/data \
  hiranaka/seadex-companion:latest
```

Open [http://localhost:8080](http://localhost:8080), create the administrator account, then configure your services under **Configuration**.

The named volume stores configuration, account data, the encryption key, caches, scan results, and logs. The container runs as an unprivileged user and exposes a health check at `/healthz`.

### Docker Compose

The included `docker-compose.yml` builds the current source:

```bash
docker compose up -d --build
```

For the published image instead, use:

```yaml
services:
  seadex-companion:
    image: hiranaka/seadex-companion:latest
    container_name: seadex-companion
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - seadex-data:/app/data
    environment:
      - PORT=8080
      - DATA_DIR=/app/data
      - TZ=Europe/Berlin
    restart: unless-stopped

volumes:
  seadex-data:
```

Replace `TZ` with your [IANA timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). Update a published-image deployment with:

```bash
docker compose pull && docker compose up -d
```

## Configuration

All integrations are configured in the WebUI; no integration credentials need to be passed through Docker.

1. Use the connection checklist to add and test a Sonarr URL and API key or a Radarr URL and API key. Use **Show all settings** to configure both.
2. Add qBittorrent credentials to enable downloads.
3. Optionally add a Discord webhook for upgrade notifications.
4. Test each configured integration, save, and select **Scan library**.
5. Configure automatic scans under **Configuration → Automation & webhooks**.

Bulk review defaults to the current library results across all matching pages. Choose **Entire library** to review titles outside your search, source, and status filters; hidden titles start unchecked. Release rows show the group, tracker, quality, audio, and tags before submission. After submitting, selections are fixed and **Continue in background** lets you use other tabs while the batch runs. **Review batch** reopens the most recent submitted review in the same session; operation progress and failure details can also be recovered after a reload.

Bulk download review shows the size of new torrents and checks free space on qBittorrent's download paths. Existing torrents are skipped without changing their files or ownership. Low-space warnings require acknowledgement before sending downloads. Older clients may only report space for their default save path; other paths are shown as unavailable. Run a new scan after updating to populate the per-torrent file sizes used by accurate estimates. Estimates do not reserve space or include torrent overhead and library-import copies.

For near-real-time discovery, add these webhook connections in Sonarr and Radarr using HTTP Basic Authentication with your SeaDex Companion username and password:

- Sonarr: `https://your-seadex-host/api/webhooks/sonarr`
- Radarr: `https://your-seadex-host/api/webhooks/radarr`

SeaDex Companion accepts Sonarr `SeriesAdd` and Radarr `MovieAdded` events. Keep a scheduled scan enabled as well; scheduled scans reconcile existing titles when SeaDex changes older entries.

## Run from source

Requires **Node.js 24+**.

```bash
npm install
npm --prefix frontend install
npm start
```

For live reload, run these in separate terminals:

```bash
npm run dev
npm --prefix frontend run dev
```

The Vite development server proxies `/api` requests to the backend on port `8080`.

Run `npm test` for backend, HTTP, scheduling, and frontend utility regressions. For browser workflow checks, run `npm run test:browser`. The browser checks use isolated local fixtures and default to Microsoft Edge on Windows; set `BROWSER_PATH` to a Chromium executable on other systems.

## Security

> [!IMPORTANT]
> SeaDex Companion is intended for a trusted home network. Do not expose port `8080` directly to the internet.

For remote access, prefer a private VPN. If you use a reverse proxy, require HTTPS and access controls, and forward `X-Forwarded-Proto: https` so session cookies are marked `Secure`.

- Use a unique administrator password.
- Keep the container and host patched.
- Do not grant untrusted users administrator access; configured integration URLs can reach private services on the application's network.
- Back up the persistent `seadex-data` volume before upgrades or host migration.

## Support and license

- Report defects through [GitHub Issues](https://github.com/hiranaka99/SeaDex-Companion/issues).
- Licensed under the [MIT License](LICENSE).

## Screenshots


### Release details

<img width="100%" alt="Anime details showing current files and recommended SeaDex releases" src="docs/screenshots/release-details.png" />

### Bulk download review

<img width="100%" alt="Bulk download review showing selected releases, torrent count, file scope, and size summary" src="docs/screenshots/bulk-download-review.png" />

### Bulk cancellation

<img width="100%" alt="Bulk cancellation review showing no incomplete app-managed downloads" src="docs/screenshots/bulk-cancellation.png" />


### Scan history

<img width="100%" alt="Scan history page" src="docs/screenshots/scan-history.png" />

### Sign in

<img width="100%" alt="SeaDex Companion sign-in page" src="docs/screenshots/sign-in.png" />
