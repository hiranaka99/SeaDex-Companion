# SeaDex Companion

A web UI that compares your **Sonarr / Radarr** anime library against the best releases on [releases.moe](https://releases.moe/) (SeaDEX) — and shows which upgrades you're still missing, with anime artwork.

## Features

- One card per anime (all seasons grouped), with AniList artwork
- Card status: **Upgradable**, **Already best quality**, or **Not on SeaDex**
- Total size delta if you replaced every file with the best release
- Live scan progress and automatic re-scan on a configurable interval
- Search & filter by title, release group, source and status; hide cards
- One-click download of the best release to qBittorrent (public trackers only)
- Discord notifications for new upgrades
- Live log tab

## Run locally

### Prerequisites

- **Node.js 22+**
  - Windows: `winget install OpenJS.NodeJS` (or download from [nodejs.org](https://nodejs.org/))
  - macOS: `brew install node`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`

Verify with `node --version` and `npm --version`.

### Steps

1. Install the backend and frontend development dependencies:

   ```bash
   npm install
   npm --prefix frontend install
   ```

2. Start the app (the TypeScript backend and frontend are built automatically):

   ```bash
   npm start
   ```

To build without starting the server, run:

```bash
npm run build
```

Open **http://localhost:8080**, set your Sonarr/Radarr URLs and API keys in the Config tab, then hit **Scan Library**.

### Development

```bash
npm run dev                    # TypeScript backend with live reload
npm --prefix frontend run dev  # Vite UI, proxies /api to localhost:8080
```

Run those commands in separate terminals and use the Vite dev-server URL.

Run the backend regression suite with `npm test`.

## Run with Docker

```bash
docker compose up -d --build
```

- Web UI: **http://localhost:8080**
- Config, caches and logs persist in `./data`
- No local build needed — the image compiles both TypeScript applications inside the container
- To change the port, edit the `ports` mapping in `docker-compose.yml` (e.g. `"8878:8878"`) and set `PORT` to match the container side (right of the colon) — see the comments in `docker-compose.yml`

## Deploy from Docker Hub (no build needed)

The app is published on [Docker Hub](https://hub.docker.com/r/hiranaka/seadex-companion). Pull the pre-built image and run it — no Node.js, no frontend build, no local Dockerfile required.

### One-liner

```bash
docker run -d \
  --name seadex-companion \
  --restart unless-stopped \
  -p 8080:8080 \
  -v seadex-data:/app/data \
  -e SONARR_URL=http://<sonarr-host>:8989/api/v3 \
  -e SONARR_KEY=<sonarr-api-key> \
  -e RADARR_URL=http://<radarr-host>:7878/api/v3 \
  -e RADARR_KEY=<radarr-api-key> \
  -e QBITTORRENT_URL=http://<qbittorrent-host>:8080 \
  -e QBITTORRENT_USER=<qbittorrent-username> \
  -e QBITTORRENT_PASS=<qbittorrent-password> \
  -e DISCORD_WEBHOOK= \
  hiranaka/seadex-companion:latest
```

Then open **http://\<your-server\>:8080**. All settings can also be configured later in the Config tab.

### With Docker Compose (recommended)

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
      - SONARR_URL=${SONARR_URL}
      - SONARR_KEY=${SONARR_KEY}
      - RADARR_URL=${RADARR_URL}
      - RADARR_KEY=${RADARR_KEY}
      - QBITTORRENT_URL=${QBITTORRENT_URL}
      - QBITTORRENT_USER=${QBITTORRENT_USER}
      - QBITTORRENT_PASS=${QBITTORRENT_PASS}
      - DISCORD_WEBHOOK=${DISCORD_WEBHOOK}
    restart: unless-stopped

volumes:
  seadex-data:
```

Put the real values in a `.env` file next to this `docker-compose.yml` (see `.env.example`), then:

```bash
docker compose up -d
```

### Updating

```bash
docker compose pull && docker compose up -d
```

## Configuration

All settings (Sonarr/Radarr, qBittorrent, Discord webhook, auto-check interval) are editable in the Config tab and persisted to `config.json` in the data directory (`DATA_DIR` env var; defaults to the app folder, `./data` in Docker).
