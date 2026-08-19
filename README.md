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
- Password-protected WebUI with automatic first-run administrator setup

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

Open **http://localhost:8080**, create the administrator account when prompted,
then set your Sonarr/Radarr URLs and API keys in the Config tab and hit **Scan Library**.

### Development

```bash
npm run dev                    # Backend with live reload
npm --prefix frontend run dev  # Vite UI, proxies /api to localhost:8080
```

Run those commands in separate terminals and use the Vite dev-server URL.

Run the backend regression suite with `npm test`.

## Run with Docker

```bash
docker compose up -d --build
```

- Web UI: **http://localhost:8080**
- Config, encryption key, caches and logs persist in `./data`
- Sonarr, Radarr, qBittorrent and Discord are configured only through the WebUI
- The credential encryption key is generated automatically on first use
- The administrator account is created in the WebUI on first launch
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
  hiranaka/seadex-companion:latest
```

Then open **http://\<your-server\>:8080**, create the administrator account, and
configure every integration in the Config tab.

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
    restart: unless-stopped

volumes:
  seadex-data:
```

```bash
docker compose up -d
```

### Updating

```bash
docker compose pull && docker compose up -d
```

## Configuration

All application settings are configured exclusively in the WebUI. Sonarr/Radarr keys,
the qBittorrent password and the Discord webhook are encrypted with AES-256-GCM in
`secrets.enc.json`. Non-secret settings remain in `config.json`; both files live in the
data directory (`DATA_DIR`, `/app/data` in Docker).

Enter only the Sonarr and Radarr server base URLs (for example,
`http://192.168.1.10:8989`). The backend adds `/api/v3` automatically. Existing URLs
that already include the API path continue to work and are normalized when saved.

The API never returns stored secret values to the browser. A blank secret field keeps
the current value, while the adjacent **Clear** button explicitly removes it.

The master key is generated automatically as `.seadex-key` inside the data directory
the first time credentials are saved. It is created with mode `0600` and persists in
the normal Docker data volume. Back up the complete data volume: losing the key while
keeping `secrets.enc.json` makes the encrypted credentials unrecoverable. Because the
key and ciphertext share a volume, this protects credentials from accidental plaintext
exposure, but not from someone who can read the entire volume. Existing plaintext
secret fields in `config.json` are migrated automatically.

## Login security

The first browser to open a new installation is asked to create the administrator
username and password. The password is never stored directly: `auth.json` contains a
salted scrypt hash and is created with mode `0600`. All application API routes require
an authenticated session held in an HttpOnly, SameSite cookie. Sessions expire after
seven days and are cleared when the server restarts.

Use HTTPS through a reverse proxy when exposing the app outside a trusted local
network. If the password is lost, stop the app, remove `auth.json` from the data
directory, restart it, and create a new administrator account. This does not remove the
integration configuration.
