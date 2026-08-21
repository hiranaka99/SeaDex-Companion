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
- **Live scan progress** and automatic re-scan on a configurable interval
- **Search & filter** by title, release group, source and status; hide cards you don't care about
- **Manual AniList corrections** for ambiguous titles, plus season/cour exclusions for bulk downloads and notifications
- **Scan history** with a change feed for new, resolved and changed upgrades
- **Discord notifications** for newly-found upgrades
- **Live log tab**
- **Password-protected WebUI** with account maintenance and session revocation; credentials are encrypted at rest (AES-256-GCM)

## Run with Docker (recommended)

The app is published on [Docker Hub](https://hub.docker.com/r/hiranaka/seadex-companion) — no Node.js or build step required.

```bash
docker run -d \
  --name seadex-companion \
  --restart unless-stopped \
  -p 8080:8080 \
  -v seadex-data:/app/data \
  hiranaka/seadex-companion:latest
```

Then open **http://localhost:8080**, create the administrator account when prompted, and configure Sonarr, Radarr, qBittorrent and Discord in the **Config** tab.

- Config, the encryption key, caches and logs all persist in the `seadex-data` volume
- Every integration is configured in the WebUI — nothing to set in Docker

### With Docker Compose

The repo ships a `docker-compose.yml` that builds from source:

```yaml
services:
  seadex-compare:
    build: .
    container_name: seadex-compare
    ports:
      - "8080:8080"
    volumes:
      - ./data:/app/data
    environment:
      - PORT=8080
      - DATA_DIR=/app/data
    restart: unless-stopped
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
      - "8080:8080"
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

Requires **Node.js 22+**.

```bash
npm install
npm --prefix frontend install
npm start
```

Open **http://localhost:8080**, create the administrator account, then set your Sonarr/Radarr base URLs and API keys in the Config tab and hit **Scan Library**.

For development (live reload, separate terminals):

```bash
npm run dev                     # backend
npm --prefix frontend run dev   # Vite UI, proxies /api to :8080
```

## Images
### Library
<img width="100%" alt="zen_048GFZmbcS" src="https://github.com/user-attachments/assets/126af5eb-ba68-4b51-ad45-b9d86151522a" />


### Details Card
<img width="60%" alt="zen_F4Ypy8e1k4" src="https://github.com/user-attachments/assets/cc25a539-4e92-4dd2-959f-358341f3c2c8" />

### Bulk Download / Cancel
<img width="60%" alt="zen_QsCLbBpGll" src="https://github.com/user-attachments/assets/e075cd65-e51d-4914-82df-0459105acf83" />

# 

<img width="60%" alt="zen_hbDMnDwqHo" src="https://github.com/user-attachments/assets/ddf51c68-717d-4f4b-92a9-8da7b90c44be" />
