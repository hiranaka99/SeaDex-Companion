# SeaDex Companion

SeaDex Companion compares your **Sonarr** and **Radarr** anime libraries with the best releases indexed by [SeaDex](https://seadex.moe/). See which titles need an upgrade, review your current releases season by season, and send selected public releases directly to qBittorrent.

<p align="center">
  <img width="100%" alt="SeaDex Companion library showing anime upgrade status" src="docs/screenshots/library.png" />
</p>

> [!WARNING]
> This project is built and maintained as a personal, heavily AI-assisted project. It is tested with care, but you should review its configuration and behavior before relying on it.

## Highlights

- See all seasons of an anime together, with clear upgrade and ownership summaries.
- Compare your current release groups, episode coverage, and file sizes with SeaDex recommendations.
- Confirm that your files are the exact release SeaDex lists, not just a release by the same group.
- Set release preferences: smaller or larger releases, dual audio, a size limit per episode, and groups or trackers to leave out.
- Scan several Sonarr and Radarr instances, and limit each one to its anime by series type, tag, or root folder.
- Find titles by name, release group, source, or upgrade status.
- Correct AniList matches and exclude individual seasons or cours from upgrades.
- Download individual releases or review a batch, with size estimates and available-disk-space checks.
- Download over qBittorrent, over Usenet through SABnzbd, or choose per release.
- Monitor downloads, pause or resume, and cancel downloads while preserving files by default.
- See whether Sonarr or Radarr imported a finished download, and why not when it did not.
- Track unseen release changes and receive optional Discord notifications, including when a season loses its best release.
- Optionally tag series and movies in Sonarr and Radarr with their SeaDex status.
- Schedule scans or connect Sonarr and Radarr webhooks to scan newly added titles.
- Use a password-protected interface on desktop or mobile, with encrypted storage for integration credentials.

## Quick start

### Docker

The published image is available from [Docker Hub](https://hub.docker.com/r/hiranaka/seadex-companion) for Linux amd64 and arm64. You need a Sonarr or Radarr library that SeaDex Companion can reach; qBittorrent is optional unless you want to download releases.

```bash
docker run -d \
  --name seadex-companion \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v seadex-data:/app/data \
  hiranaka/seadex-companion:latest
```

Open [http://localhost:8080](http://localhost:8080), create the administrator account, then configure your services under **Configuration**.

Keep the `seadex-data` volume: it stores your settings, account, integration credentials, matching corrections, scan history, and cached Usenet availability. Both installation examples limit access to the host computer. See [Security](#security) before setting up access from other devices.

### Docker Compose

To use Compose, create a `compose.yaml` file with the following settings:

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

Replace `TZ` with your timezone, such as `Europe/Berlin` or `America/New_York`. Start SeaDex Companion from the folder containing your `compose.yaml`:

```bash
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080) and create your administrator account. The `latest` image follows stable releases; use a specific version tag if you prefer to choose when to upgrade.

## Connect your library

All integrations are configured in the WebUI; no integration credentials need to be passed through Docker.

1. Use the connection checklist to add and test a Sonarr URL and API key or a Radarr URL and API key. Use **Show all settings** to configure both.
2. Add qBittorrent credentials to enable downloads.
3. Optionally add a Discord webhook for upgrade notifications.
4. Test each configured integration, save, and select **Scan library**.
5. Configure automatic scans under **Configuration → Automation**.

Use addresses reachable from the SeaDex Companion container. Inside a container, `localhost` refers to that container, so it usually cannot reach Sonarr or qBittorrent running elsewhere through `localhost`.

Sonarr v3, v4, and v5 are supported. Enter each service's base URL, including any reverse-proxy path, such as `http://sonarr:8989/sonarr`. If your proxy redirects to a different address or from HTTP to HTTPS, enter the final URL directly.

### Limit what is scanned

By default every series in Sonarr and every movie in Radarr is scanned. If your library also holds other shows, open **Library scope** on the Sonarr or Radarr card under **Configuration** and limit the scan:

- **Only anime series** keeps the series whose type is set to Anime in Sonarr.
- **Only with these tags** keeps titles that carry at least one of the listed tags. **Skip these tags** leaves titles out and wins over every other rule.
- **Only in these root folders** keeps titles stored under one of the listed root folders.

Once the URL and API key are entered, the tags and root folders of that instance are offered as buttons, so you can pick them instead of typing. A title has to match every rule you set. Titles outside the scope are not scanned and disappear from the library with the next scan.

### Additional Sonarr and Radarr instances

Use **Add Sonarr instance** or **Add Radarr instance** for a second library, such as a 4K instance. Give it a name, its URL and API key, and the download-client category that instance imports from. Each instance has its own library scope and is scanned separately.

The same anime in two instances appears as two cards, and the card of an additional instance shows that instance's name. The **source** filter in the library lists your instances by name. Matching corrections, hidden cards, and exclusions belong to one instance and do not affect the other. Removing an instance removes its titles from the library with the next scan.

## Review your library

The library opens with a one-line summary of what you can act on: how many shown titles can be upgraded, the estimated size change if you download all of them, and how many matches need review. In the recommended order, titles are grouped under a heading for each status, with matches that need review first. Cards that need action have an accent border; titles that are already on their best release sit flatter. Every season badge shows a symbol as well as a color (an up arrow for upgradable, a check for the best release owned, a minus for not on SeaDex, a warning for partial coverage), and selecting a badge opens **Details** at that season.

Open **Details** on an anime to see its quality verdict, the release groups in your files, and the recommended upgrades. Expand a season or cour to compare releases and download options. A cour is one part of a split season.

**Not on SeaDex** means there is no matching SeaDex listing. **Match needs review** means SeaDex Companion needs help identifying the correct anime or season. A matching release group alone does not mean a season is complete; review any missing-episode or uncertain-coverage messages as well.

### Exact-release check

A release group's name does not say which of the group's releases you have. An earlier batch, or the group's web release beside its Blu-ray release, carries the same name. SeaDex Companion therefore compares the sizes of your files with the files SeaDex lists for a release:

- When every file matches, release details show **Your files match this release exactly**. This also recognizes a release whose files carry no group name.
- When your files carry the right group but differ in size, the season becomes **Upgradable**, and release details say that your files differ from the listed release.
- When either side has no file sizes, nothing changes and the group name decides, as before.

If your files are changed after import, for example remuxed or stripped of tracks, they can never match. Turn off **Check owned releases by file size** under **Configuration → Release preferences** to rely on group names again. Run a new scan after updating; the first scan with the check enabled may turn some seasons from best to upgradable.

### Release preferences

SeaDex often lists more than one best release for a season, such as a remux and a smaller encode. Under **Configuration → Release preferences** you choose which one SeaDex Companion targets:

- **Download target**: the largest release (the default) or the smallest.
- **Prefer dual audio**: whenever a dual-audio release is listed for a season, it becomes the target.
- **Size limit per episode**: releases above this average episode size are never offered. Movies are not limited.
- **Ignored release groups** and **Ignored trackers**: releases from these are never offered.
- **Alternatives are good enough**: owning a release SeaDex lists as an alternative counts as having the best release, and an alternative can become the target when no best release fits your other rules.
- **Only my target counts as best**: off by default. While it is off, owning any best release settles a season and your preferences only choose what to download. Turn it on to make a season upgradable whenever you own a different best release than your target.

In release details the target is marked **Your target**, and a release your preferences leave out says why. Bulk download offers only your target and other releases your preferences allow; **Download** in release details still sends any release you pick yourself. When your preferences exclude every release SeaDex lists for a season, the season shows **Outside your preferences** and offers no upgrade.

Preferences and library scope take effect with the next scan. Until then the library shows a notice that its results still reflect the earlier settings.

### Correct a season match

If Sonarr groups seasons differently from AniList, open the anime's details and use the match control beside the affected season. Select its AniList entry, then **Save and rescan**. For split cours, select each entry in episode order; use **Move up** to change their order.

Season corrections affect only that season. Choose **Use automatic match** to remove a correction. Your matching corrections and exclusions survive clearing scanned data.

### Download and monitor upgrades

Download an individual release from **Details**, or open bulk review to select several upgrades. **Download** in release details sends that one release straight to its client without a review step: it skips releases already queued, but it does not ask about disk space or about extra files in whole Usenet sources. A notification confirms the send or explains why it failed. Bulk review includes titles matching your current filters across all pages. Choose **Entire library** to include titles outside those filters; hidden titles start unchecked.

In bulk review, check the release groups, selected episodes, download sizes, and available disk space before submitting. Downloads already present in qBittorrent or SABnzbd are skipped. When filenames identify the required episodes, SeaDex Companion can download only the selected files; otherwise, review the whole-torrent scope before proceeding.

Disk-space checks may be unavailable for some download paths or older client versions. Size estimates do not reserve space or include torrent overhead and library-import copies. An estimated size counts as fitting when free space is at least twice the estimate plus 5 GB; otherwise the review asks you to confirm. Run a new scan if older results are missing file-size information.

Choose **Continue in background** to keep using the app while a batch runs. Closing the page does not cancel downloads. **Review batch** reopens your latest submitted review in the same session, and download progress is recovered after a reload. After a SeaDex Companion restart, check the download client before retrying downloads reported as interrupted.

Use the download controls to pause, resume, cancel, or remove downloads. Controls are labeled per client. File deletion is optional; downloaded files are preserved by default.

### Import follow-through

A finished download is only an upgrade once Sonarr or Radarr has imported it. For downloads sent after updating to this version, SeaDex Companion keeps watching after the download completes:

- **Waiting for Sonarr to import** while the download is finished and the library still holds the old files.
- **Imported by Sonarr** once a rescan of that title finds the new release in your library. The title is rescanned on its own, so the card updates without a full library scan.
- **Sonarr has not imported this download**, with Sonarr's own reason, when its queue reports a problem such as a file that is not an upgrade under your quality profile or a name it cannot parse.
- **Not imported** when the download left the queue and the library files did not change. Check that the instance watches the download category and can reach the download folder.

SeaDex Companion only reads the queue; it never imports, retries, or removes anything in Sonarr or Radarr. Resolve the problem there, and the status updates on the next check. With several instances, the name shown is the instance the title belongs to.

### Usenet downloads

Set the download method under **Configuration → Downloads**: **Torrents only**, **Usenet only**, or **Let me choose per release**. Existing installations stay on **Torrents only** until you change it.

To download over Usenet:

- Connect SABnzbd with its server URL and full API key, enter the SABnzbd categories Sonarr and Radarr use, and run **Test connection**. The test fails if SABnzbd has no category with one of those names, because SABnzbd would otherwise file the download under its default category, where Sonarr and Radarr never import it.
- AnimeTosho is enabled by default and needs no account. Optionally enable AmeNZB and add the API key from your amenzb.moe profile.
- Release details report the last-known Usenet source, its size, and when the provider checked it. Cached results survive restarts and remain visible while older or missing information is checked in the background. If a provider rate-limits requests, background checks pause and resume on their own; the sidebar shows when they continue. In **Let me choose per release** mode, pick **Torrent** or **Usenet** per release; releases without a public magnet can become Usenet-only, and releases no source carries stay torrent-only.
- Use **Re-check** in release details or **Refresh review** in bulk downloads to force a new check. A failed refresh keeps the previous result with a warning rather than clearing it. Downloads still require a valid review and a validated NZB before anything is sent to SABnzbd.

Usenet sources cannot be split per episode: the whole upload is downloaded, including files beyond the selected episodes. Bulk review lists the known extra files and requires your acknowledgement before sending; **Download** in release details sends the whole source without asking.

If the connection to SABnzbd or qBittorrent drops before it confirms a download, SeaDex Companion never re-submits it automatically. The entry is listed as **Awaiting confirmation** and is picked up automatically once the download appears in the client. If it never appears, use **Stop tracking** on the entry: SeaDex Companion forgets it without changing anything in the client, and you can send the release again.

## Automatic scans and notifications

Set an interval, daily times, or weekdays under **Configuration → Automation**. Choose the timezone and what should happen if a scan was missed while SeaDex Companion was offline.

**Unhide anime with new best releases** is off by default. Enable it to bring hidden titles back when a scan finds a new best release. Alternative releases do not trigger this setting. Add a Discord webhook under **Configuration** if you want upgrade notifications.

Discord notifications also report a season that loses its best release because its files changed, for example when Sonarr replaced them with another grab. **Import problems** adds a message when a finished download is not imported; turn it off under **Configuration → Notifications** if you do not want those.

Under **Configuration → General** you can set the **Date & time format** used for scan times, history, and detected changes. Build a pattern from the tokens `YYYY YY MM M DD D HH H mm m ss s` — for example `DD.MM.YYYY HH:mm:ss` shows `21.11.2026 18:40:29`. A live preview updates as you type, and the default is `YYYY-MM-DD HH:mm:ss`.

To scan titles right after they change, add these webhook connections in Sonarr and Radarr using HTTP Basic Authentication with your SeaDex Companion username and password:

- Sonarr: `https://your-seadex-host/api/webhooks/sonarr`
- Radarr: `https://your-seadex-host/api/webhooks/radarr`

Each additional instance has its own address, shown with a copy button under **Configuration → Automation**.

Enable these events on the connection:

- **On Series Add** in Sonarr or **On Movie Added** in Radarr, to scan a new title as soon as it is added.
- **On File Import** and **On File Upgrade** (**On Import** and **On Upgrade** in older versions), to rescan a title as soon as its files change. Imports of titles that are not in your SeaDex Companion library are ignored.
- **On Manual Interaction Required**, optionally, to check a stuck import right away.

Keep a scheduled scan enabled as well to check existing titles for changed SeaDex recommendations.

### Status tags in Sonarr and Radarr

**Status tags in Sonarr and Radarr** under **Configuration → Automation** is off by default. When you enable it, every scan tags each series and movie with its SeaDex status, so you can filter by it in Sonarr and Radarr or use the tags in their own automation:

- `seadex-best`: every season is on its best release.
- `seadex-upgradable`: at least one season can be upgraded.
- `seadex-unlisted`: SeaDex lists no season of the title.
- `seadex-review`: the AniList match is not confirmed yet.

A title carries at most one of these tags, and titles in any other state carry none. You can rename each tag, or leave a name empty to skip that status. Only these tags are ever added or removed; your own tags and everything else in Sonarr and Radarr stay untouched. Seasons you excluded from upgrades do not make a title upgradable.

Turning the setting off leaves existing tags in place. Use **Remove these tags from all titles** to clear them.

Scans reuse recent AniList information and refresh known titles together to reduce waiting while respecting API limits. Titles with manual matches skip unnecessary automatic searches. Your first scan, scans with many new titles, and scans that refresh older information can take longer. Season information refreshes after 24 hours, on the next scan; newly added seasons are checked sooner. You can cancel a scan at any time.

Temporary SeaDex connection problems are retried automatically. If a scan still fails, your previous results remain available. Check **Scan history** or **Server log** for details before trying again later.

## Scan history

**Scan history** lists your scans under Today, Yesterday, and earlier dates. Only the latest scan with changes starts open; each scan shows its trigger, duration, and any failed, partial, or cancelled outcome, with the actionable changes summarized first. A season that loses its best release because its files changed is listed as **No longer best**, apart from seasons that became upgradable because SeaDex changed its recommendation. Scans started to check a finished download are labeled **Import check**. Long runs of titles that were only added or removed fold into one group. Filter by library app, by scans with changes or failed scans, or search a title, release group, or season such as **S02**. Older scans and long change lists load in steps.

## Server log

**Server log** shows the latest 500 backend lines and refreshes every 3 seconds. Filter by severity, with counts for what the latest lines hold, or search any part of a line, including stack traces. New output stays in view while you are at the bottom; scrolling up pauses following and shows how many entries arrived since, and **Follow latest** resumes. **Copy** and **Download** hand the visible entries to a bug report; the download keeps each line exactly as the server wrote it.

## Reviewing release changes

The library's **Unseen changes** filter shows anime with release changes you have not reviewed, including new best releases, alternatives, updated torrents or metadata, and removals. It also lists seasons that are no longer on their best release because your files changed. Its count covers matching titles across all pages, with the latest changes first. Cards label the affected seasons; open **Details → What changed** for the before/after summary and detection time. Use **Mark reviewed** for one anime, or **Mark all reviewed** for all titles matching the current library filters. Opening the app or completing another unchanged scan does not clear these changes.

Reviewed changes stay reviewed across reloads and devices. A first scan or newly discovered title starts without unseen alerts. New changes appear after a completed scan; they are not live notifications of upstream publication.

## Updating and backups

Back up the complete `seadex-data` volume before upgrading or moving to another host. Keep the encryption key and the rest of the data together so your saved integration credentials remain usable. Keep a pre-upgrade backup if you may need to return to an older version.

For the Compose setup above, update with:

```bash
docker compose pull
docker compose up -d
```

For `docker run`, pull the new image, stop and remove the old container, then run the installation command again with the same `seadex-data` volume:

```bash
docker pull hiranaka/seadex-companion:latest
docker stop seadex-companion
docker rm seadex-companion
```

New images take effect after the container is recreated. See the [release notes](https://github.com/hiranaka99/SeaDex-Companion/releases) for changes and any additional upgrade steps.

## Security

> [!IMPORTANT]
> SeaDex Companion is intended for a trusted home network. Do not expose port `8080` directly to the internet.

For remote access, prefer a private VPN. If you use a reverse proxy, require HTTPS and access controls, and forward `X-Forwarded-Proto: https` so session cookies are marked `Secure`.

- Use a unique administrator password.
- Keep the container and host patched.
- Do not grant untrusted users administrator access; configured integration URLs can reach private services on the application's network.
- SeaDex Companion changes Sonarr and Radarr only when you enable status tags, and then only those tags. Everything else it does there is read-only.
- Back up the persistent `seadex-data` volume before upgrades or host migration.

## Support and license

- Report defects through [GitHub Issues](https://github.com/hiranaka99/SeaDex-Companion/issues).
- Licensed under the [MIT License](LICENSE).

## Screenshots

### Release details

<img width="100%" alt="Anime details showing current files and recommended SeaDex releases" src="docs/screenshots/release-details.png" />

### Bulk download review

<img width="100%" alt="Bulk download review showing selected season upgrades, download size, and available disk space" src="docs/screenshots/bulk-download-review.png" />

### Bulk cancellation

<img width="100%" alt="Bulk cancellation review showing selected app-managed torrents and the optional file-deletion warning" src="docs/screenshots/bulk-cancellation.png" />

### Scan history

<img width="100%" alt="Scan history page" src="docs/screenshots/scan-history.png" />

### Sign in

<img width="100%" alt="SeaDex Companion sign-in page" src="docs/screenshots/sign-in.png" />
