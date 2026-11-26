# Scan, server, and delivery performance

Measured on 2026-11-26 on Windows with Node.js 26.13, comparing the build before and after the changes
below with the same script. The fixture is a library of 1,000 series (1,500 seasons, 60% listed on SeaDex),
sized from a live SeaDex catalog page: about 3 torrents per entry, 17 files per torrent, and 72-character
file names. These are single-run local measurements, not field data.

| Measurement | Before | After |
| --- | ---: | ---: |
| Daily scan, the app's own work (AniList answered instantly) | 18.7 s | 0.76 s |
| AniList cache writes during that scan | 1,060 | 1 |
| Bytes written to `anilist_cache.json` during that scan | 3.50 GB | 2.3 MB |
| AniList metadata requests during that scan | 60 | 30 |
| Waiting between those requests at the 2.1-second pacing | 124 s | 61 s |
| Rescan with all metadata cached | 1.37 s | 0.36 s |
| Loading 300 series from Sonarr at 25 ms per request | 9.5 s | 2.5 s |
| `GET /api/results`, bytes sent | 9.57 MB | 475 kB |
| `GET /api/results`, time on the same machine | 30 ms | 69 ms |
| First page load, bytes sent | 1,048 kB | 377 kB |
| Script needed before the library shows, bytes sent | 603 kB | 119 kB |
| Script needed before the library shows, uncompressed | 603 kB | 497 kB |
| Reload with a warm browser cache, bytes sent | 349 kB | 0 (three 304 answers) |
| `loadConfig()` | 2.2 ms | 0.08 ms |
| `loadResultSettings()` on an unchanged results file | 16 ms | 0.02 ms |

The daily scan is the first scan after the 24-hour metadata lifetime has passed. Its figures exclude network
time: AniList requests are answered at once, and the pacing wait is derived from the request count. The Sonarr
figure uses a local stand-in that answers every request after 25 ms; a real Sonarr answers at its own speed.

Compressing the results costs about 40 ms on the server, off the main thread, which is why the request is
slower when the browser and the server share a machine. The smaller body is faster on any connection below
roughly 1.9 Gbit/s. The first page load still contains the 184 kB favicon, which is sent as it is.

Changes:

- A scan matches results to the previous scan through one index instead of rebuilding it for every result.
- The AniList cache is written at most every 30 seconds and when a scan ends, without pretty-printing.
- AniList metadata is requested 50 entries at a time, the most AniList returns per page.
- Sonarr episodes and episode files are requested for four series at a time.
- JSON answers of 1 KiB or more and text assets, including the TTF font, are sent with Brotli or gzip.
- Files that keep their name across versions carry an `ETag` and `Cache-Control: no-cache`.
- The History, Configuration, and Log pages are separate chunks, fetched right after the app starts.
- While a scan runs, the browser reloads the results at most every 10 seconds instead of after every title.
- Status, download-progress, and log polling stop while the tab is hidden.
- The download store keeps its snapshot when an answer repeats, so cards render only when a download changed.
- The configuration and the result settings are read once per file version.

Not measured: the effect of the polling changes in a browser. Removed download records stay in the ledger
as an audit trail, so they were not pruned.

Verification: `npm test` (552 tests) and `npm run test:browser` pass. `npm run test:docker` was not run.
