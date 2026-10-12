# Library performance optimization

Validated on 2026-10-12 using the production Vite build and headless Edge
150.0.4078.65 on Windows. The local fixture contains 1,000 titles, one season
and one release per title, with no active downloads or external artwork requests.
Pagination mounts 60 cards. Measurements use the Chrome DevTools Protocol
Performance counters and instrument calls that serialize card download signatures.

| Measurement | Before | After |
| --- | ---: | ---: |
| Signature builds during 11 seconds idle (one status poll) | 60 | 0 |
| Idle JavaScript time | 3.43 ms | 1.26 ms |
| Idle browser task time | 14.91 ms | 9.64 ms |
| Signature builds across eight sort changes | 480 | 0 |
| Median sort change to two animation frames | 31.90 ms | 32.25 ms |
| Frontend JavaScript, gzip | 106.08 kB | 106.20 kB |

These are single-run local measurements, not field Core Web Vitals or a
low-end-device benchmark. The observed improvement is reduced repeated CPU
work; this fixture does not demonstrate a perceptible sort latency improvement.
The frame-based timing includes browser scheduling.

Changes:

- Memoize cards and stabilize their callbacks so unrelated status updates skip
  unchanged cards. Card state still renders live download progress and dialogs.
- Cache release signatures until season data or qBittorrent connection fields
  change, including during download-progress renders.
- Build lowercase searchable title, release-group, ownership, and season text
  once per results update. Preserve case-insensitive, trimmed, full-library search.
- Cache bulk-review group counts and the filtered collection's size delta.

Verification: `npm run test:browser` builds and typechecks the frontend and
exercises library pagination, metadata search, off-page history navigation,
hidden titles, full and filtered bulk scope, release identity changes, download
controls, keyboard dialogs, and responsive layouts including enlarged text.
Desktop and mobile screenshots were inspected with the 1,000-title fixture.

## Follow-up after library motion

Measured on 2026-10-12 against the merged v1.9 frontend with library animation.
This fixture also contains 1,000 titles, but supplies them in a deterministic
shuffled order (`index * 7919 % 1000`). All titles have the same upgrade status,
so switching between recommended and title order yields the same visible cards.
Each action is followed by 280 ms to allow motion and rendering to settle.

| Measurement | Before | After |
| --- | ---: | ---: |
| JavaScript time across eight sort changes | 209.21 ms | 16.70 ms |
| Card/grid geometry reads across those sort changes | 984 | 0 |
| JavaScript time across eight incremental search inputs | 231.73 ms | 8.68 ms |
| Sort comparisons across those search inputs | 68,288 | 0 |
| Card/grid geometry reads across those search inputs | 984 | 0 |
| Frontend JavaScript, gzip | 107.64 kB | 107.72 kB |

The search sequence is `C`, `Co`, `Col`, `Coll`, `Colle`, `Collec`, `Collect`,
`Collection`; every query matches the collection. CDP measures JavaScript
time; temporary instrumentation counts title comparisons and card/grid bounds
reads. Sorting still performs 68,288 comparisons across the eight order
changes, using reusable `Intl.Collator` instances instead of repeatedly
constructing locale comparison options. These single-run local measurements
include instrumentation overhead and are not field interaction latency scores.

The collection is now sorted once per scan-result or sort-option change;
filtering preserves that order. Size sorting computes each title's delta once
per sort instead of once per comparison. Motion depends on the visible title
keys and their order, so unchanged search results keep their existing observer
and layout baseline. Changed layouts still animate, including rapid reversal
and mobile rearrangement; live reduced-motion changes still stop movement.

Browser coverage includes a regression that types a different query matching
the same visible title and asserts that no card/grid bounds are read.
