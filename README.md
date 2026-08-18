# SeaDex Companion

A modern web UI that compares your **Sonarr / Radarr** anime library against the
**best releases** on [releases.moe](https://releases.moe/) (SeaDEX) and shows
which upgrades you're still missing - with anime artwork.

## Features

- **Anime tab** - responsive card grid, one card per anime (all its seasons grouped together). Each card shows the AniList banner + cover, the title (linked), and a row per season with: the release groups you have, the best release group + quality + tracker, notes/tags, a direct link to the entry on releases.moe, and a per-season ⬇ download button.
- **Three card statuses** - **Upgradable** (blue, you don't own the best group), **Already best quality** (green, you own the best group), **Not on SeaDex** (grey, the anime/season isn't listed on releases.moe). Cards sort upgradable first, then missing, then best.
- **Total size delta** - the header shows the net size change if you replaced every current file with the best release.
- **Live scan progress** bar and status pill (with an auto-check countdown).
- **Search + filter** by title / release group, by source (Sonarr/Radarr), by status, plus a "hide locked" toggle.
- **Download to qBittorrent** - the ⬇ button on a season sends the best release's magnet to your qBittorrent client under the matching Sonarr/Radarr category. Public releases only (Nyaa / AnimeTosho); private-tracker releases (AnimeBytes) have no magnet and show a disabled button.
- **Notify Discord** - post every found upgrade to your webhook in one click.
- **Auto-check** - re-scans on a configurable interval and automatically posts *new* upgrades to Discord (once per upgrade, unless re-appearing after being resolved).
- **Per-item lock** - mute the notification for a single card with the 🔔/🔕 button; locked items are never posted.
- **Global notification toggle** - switch all Discord notifications on/off in the Config tab.
- **Log tab** - live view of the backend log (scans, API errors, notifications) with All / Warnings+ / Errors-only filters.
- **Docker-ready** for easy deployment.

## How it works

1. Fetches every collection entry from the releases.moe API and keeps the `isBest` torrent per AniList ID, plus the other tracker releases ("alts") for each season.
2. Fetches your library (Sonarr `/series`, Radarr `/movie`) and collects the release groups and on-disk size per season.
3. Resolves each title to an AniList entry (cached to disk), following the **SEQUEL relation chain** so each season maps to its own AniList entry.
4. Each season is classified as **Best quality**, **Upgradable**, or **Not on SeaDex** (anime or season not listed). Seasons are grouped into one card per anime.
5. The scheduler re-runs the scan every *auto-check interval* (minutes, 0 = off) and posts only upgrades it has not notified about before (tracked in `notified.json`), skipping locked items.

> Scans are rate-limited against AniList (~30 calls/min) and cached, so repeated scans are fast.

## Run locally

```
cd "C:\Coding\SeaDEX Compare"
pip install -r requirements.txt
python app.py
```

Then open **http://localhost:8080** in your browser. Configure URLs/keys in the Config tab, then hit **Scan Library**.

The compiled frontend is already in `static/`, so the app runs as-is. To work on the UI:

```
cd "C:\Coding\SeaDEX Compare\frontend"
npm install
npm run dev        # dev server (proxies /api to http://localhost:8080)
npm run build      # rebuild the production bundle into ../static
```

## Run with Docker

```
cd "C:\Coding\SeaDEX Compare"
docker compose up -d --build
```

- Web UI: **http://localhost:8080**
- Config + cache + logs persist in `./data` (mounted at `/app/data`).
- To change the port, edit the `ports` mapping in `docker-compose.yml`.
- The Docker image is built in two stages: the React frontend is compiled
  **inside the image** (Node stage, `npm ci && npm run build`) and the
  resulting bundle is copied into the final Python runtime image. You do
  **not** need to run `npm run build` locally before deploying — the
  container always ships the UI that matches the current `frontend/` source.

## Files

- `app.py` - Flask backend (API + scan engine + static serving)
- `frontend/` - React + TypeScript source (Vite); builds into `static/` (or into the Docker image)
- `static/` - Compiled frontend served by Flask (output of `npm run build`; for Docker, produced inside the image)
- `requirements.txt` - Python dependencies
- `Dockerfile` - Multi-stage container image (Node build stage + Python runtime)
- `docker-compose.yml` - One-command deployment
- `config.json` *(generated)* - your saved config (Sonarr/Radarr + qBittorrent + webhook, notification settings + locked items)
- `anilist_cache.json` *(generated)* - AniList title/season to ID cache
- `last_results.json` *(generated)* - last scan results
- `notified.json` *(generated)* - upgrades already posted to Discord (prevents duplicate notifications)
- `logs/app.log` *(generated)* - rotating backend log (shown in the Log tab)

> Config, caches, and logs live in the data directory (`DATA_DIR` env var, defaults to the app folder; Docker mounts `./data`).

## Notes

- The default config ships with your Sonarr/Radarr endpoints pre-filled; update keys/webhook/qBittorrent in the UI as needed.
