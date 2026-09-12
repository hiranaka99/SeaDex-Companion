# SeaDex Companion

> ⚠️ **Disclaimer:** This project is **100% vibe coded** — i still spend a lot of time making sure it is as bug free and user friendly as possible.

SeaDex Companion is a web UI that compares your **Sonarr / Radarr** anime library against the best releases on [releases.moe](https://releases.moe/) (**SeaDex**) — and shows exactly which upgrades you're still missing, with anime artwork.

## Features

- **One card per anime** (all seasons grouped)
- **Card status**: Upgradable, Best quality, Partially on SeaDex or Not on SeaDex
- **Size delta** — how much space would change if you replaced every upgradable file with the best release
- **Smart upgrade detection** — understands split seasons (Cours / Part 1 & 2) and tracks ownership episode-by-episode
- **One-click download** of the best release to qBittorrent, fetching only the missing episodes/cour (public trackers only)
- **Bulk download** every upgrade at once, plus a **Downloads panel** to monitor, pause, resume and delete torrents
- **Flexible automatic scans** on an interval, at a daily time, or on selected weekdays, with timezone and missed-run controls
- **Search & filter** by title, release group, source and status; hide cards you don't care about
- **Manual AniList corrections** for ambiguous titles, plus season/cour exclusions for bulk downloads and notifications
- **Scan history** with a change feed for new, resolved and changed upgrades
- **Discord notifications** for newly-found upgrades
- **Live log tab**
- **Password-protected WebUI** with Argon2ID password hashing, account maintenance and session revocation; integration credentials are encrypted at rest with AES-256-GCM

## Security and network exposure

> **Internet exposure is not recommended.** SeaDex Companion is intended for a trusted home network. Do not publish port `8080` directly to the internet.

For remote access, use a private VPN or an HTTPS reverse proxy with access controls. TLS is required to protect the administrator password and session cookie in transit. When TLS terminates at a reverse proxy, forward `X-Forwarded-Proto: https` so the app marks its session cookie `Secure`.

- Use a unique administrator password.
- Keep the container and host patched.
- Do not grant untrusted users administrator access: configured integration URLs can reach private services on the app's network.

## Run with Docker (recommended)

The app is published on [Docker Hub](https://hub.docker.com/r/hiranaka/seadex-companion)
```bash
docker run -d \
  --name seadex-companion \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v seadex-data:/app/data \
  hiranaka/seadex-companion:latest
```

Then open **http://localhost:8080**, create the administrator account when prompted, and configure Sonarr, Radarr, qBittorrent and Discord in the **Config** tab.

- Config, account data, the encryption key, caches and logs all persist in the `seadex-data` volume
- Every integration is configured in the WebUI — nothing to set in Docker
- The container includes a health check at `/healthz` and runs as an unprivileged user

### With Docker Compose

The repo ships a `docker-compose.yml` that builds from source:

```yaml
services:
  seadex-compare:
    build: .
    container_name: seadex-compare
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - seadex-data:/app/data
    environment:
      - PORT=8080
      - DATA_DIR=/app/data
    restart: unless-stopped

volumes:
  seadex-data:
```

```bash
docker compose up -d --build
```

Prefer the pre-built image? Swap the service for:

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
    restart: unless-stopped

volumes:
  seadex-data:
```

Update with `docker compose pull && docker compose up -d`.


## Run locally

Requires **Node.js 24+**.

```bash
npm install
npm --prefix frontend install
npm start
```

Open **http://localhost:8080**, create the administrator account, then set your Sonarr/Radarr base URLs and API keys in the Config tab and hit **Scan Library**.

Automatic scans are configured under **Configuration → Automation**. Choose an interval, a daily local time, or selected weekdays; calendar schedules use the configured IANA timezone and can either run once after downtime or skip missed runs.

For near-real-time discovery of newly added library entries, add Sonarr and Radarr webhook connections under **Configuration → Library webhooks**. Configure HTTP Basic Authentication using the same username and password used to sign in to SeaDex. SeaDex accepts Sonarr `SeriesAdd` and Radarr `MovieAdded` events and groups bursts for 10 seconds before one incremental scan. Keep the time-based schedule enabled: it reconciles existing titles when releases.moe updates older entries.


The operation panel can cancel an active scan while preserving the previous complete results. Webhook scans update only the affected Sonarr series or Radarr movie. The Automation panel validates schedules, previews the next run before saving, and provides a **Run now** action. Bulk-download review summarizes download size, unique torrents, selected files, and torrents already present in qBittorrent. Scan history records trigger, duration, scanned-title count, and partial integration failures.

For development (live reload, separate terminals):

```bash
npm run dev                     # backend
npm --prefix frontend run dev   # Vite UI, proxies /api to :8080
```

## Support and license

- Report defects through [GitHub Issues](https://github.com/hiranaka99/SeaDex-Companion/issues).
- Licensed under the [MIT License](LICENSE).

## Images
### Library
<img width="100%" alt="zen_048GFZmbcS" src="https://github.com/user-attachments/assets/126af5eb-ba68-4b51-ad45-b9d86151522a" />


### Details Card
<img width="60%" alt="zen_F4Ypy8e1k4" src="https://github.com/user-attachments/assets/cc25a539-4e92-4dd2-959f-358341f3c2c8" />

### Bulk Download / Cancel
<img width="60%" alt="zen_QsCLbBpGll" src="https://github.com/user-attachments/assets/e075cd65-e51d-4914-82df-0459105acf83" />

# 

<img width="60%" alt="zen_hbDMnDwqHo" src="https://github.com/user-attachments/assets/ddf51c68-717d-4f4b-92a9-8da7b90c44be" />
