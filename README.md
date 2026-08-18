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

Prerequisites: Python 3.11+ and Node.js 22+.

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

## Configuration

All settings (Sonarr/Radarr, qBittorrent, Discord webhook, auto-check interval) are editable in the Config tab and persisted to `config.json` in the data directory (`DATA_DIR` env var; defaults to the app folder, `./data` in Docker).