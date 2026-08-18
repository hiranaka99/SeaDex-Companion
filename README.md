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

- **Python 3.11+**
  - Windows: `winget install Python.Python.3.11` (or download the installer from [python.org](https://www.python.org/downloads/) — tick **"Add python.exe to PATH"** during setup)
  - macOS: `brew install python@3.11`
  - Linux: `sudo apt install python3.11` (or your distro's equivalent)
- **Node.js 22+** (only needed to build the frontend)
  - Windows: `winget install OpenJS.NodeJS` (or download from [nodejs.org](https://nodejs.org/))
  - macOS: `brew install node`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`

Verify with `python --version` and `node --version`.

### Steps

1. Install the Python dependencies:

   ```bash
   pip install -r requirements.txt
   ```

2. Build the frontend (required — the compiled bundle in `static/` is not committed):

   ```bash
   cd frontend
   npm install
   npm run build   # outputs the bundle into ../static
   cd ..
   ```

3. Start the app:

   ```bash
   python app.py
   ```

Open **http://localhost:8080**, set your Sonarr/Radarr URLs and API keys in the Config tab, then hit **Scan Library**.

### Frontend development

```bash
cd frontend
npm run dev   # Vite dev server, proxies /api to http://localhost:8080
```

Run the backend as above in a second terminal and use the dev server URL instead.

## Run with Docker

```bash
docker compose up -d --build
```

- Web UI: **http://localhost:8080**
- Config, caches and logs persist in `./data`
- No local frontend build needed — the image is built in two stages and compiles the React app inside the container, so it always ships the UI that matches the current `frontend/` source
- To change the port, edit the `ports` mapping in `docker-compose.yml`

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

### Publishing a new image to Docker Hub

From the repository root (after `docker login`):

- **Windows:** `.\scripts\push-dockerhub.ps1 -User hiranaka`
- **Linux / macOS:** `./scripts/push-dockerhub.sh hiranaka`

Both scripts build the image, tag it as `latest` plus the current git short SHA, and push it to `docker.io/hiranaka/seadex-companion`.

## Configuration

All settings (Sonarr/Radarr, qBittorrent, Discord webhook, auto-check interval) are editable in the Config tab and persisted to `config.json` in the data directory (`DATA_DIR` env var; defaults to the app folder, `./data` in Docker).