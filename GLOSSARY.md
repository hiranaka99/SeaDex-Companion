# SeaDex Companion

SeaDex Companion compares a Sonarr or Radarr anime library with the releases SeaDex recommends, and acquires the better ones through a torrent or a Usenet client.

## Library

**Library instance**:
One Sonarr or Radarr connection whose titles are scanned. Every result belongs to exactly one, and a download is filed under that instance's category so the same instance imports it.
_Avoid_: arr, source (a source is what a release is acquired by)

**Primary instance**:
The first Sonarr or the first Radarr, set up under its own settings. Results and rules saved before additional instances existed belong to it.
_Avoid_: main instance, default instance

**Additional instance**:
Any library instance after the primary instance of its kind, with its own name, categories and scope.
_Avoid_: extra instance, secondary instance

A library is **connected** when at least one library instance, primary or additional, has both an address and an API key.

## Upgrades

**Part**:
One piece of a season that SeaDex lists releases for separately, labelled as SeaDex labels it ("Cour 2", "Part 1"); a season SeaDex does not split has a single unnamed part.
_Avoid_: cour (except as a part's label)

**Excluded release**:
A listed release that the release preferences, or a private tracker Prowlarr cannot reach, rule out as a download target. It stays listed and can still be downloaded on its own.
_Avoid_: ignored release

**Ignored**:
A season or part the user has set aside: no bulk download, notification or upgrade tag is made for it, although the library still shows that a better release exists.
_Avoid_: excluded (that is a release ruled out by preferences), hidden (a removed feature)

**Upgrade available**:
SeaDex lists a better release for a season than the library holds. It is a fact about the catalog and the library, whatever the user has ignored.
_Avoid_: upgradable (when wanted parts are meant)

**Wanted part**:
A part of a season with an upgrade available that is not ignored, not already settled by the library, and has a release that is not excluded. Wanted parts are what Bulk download fetches and what notifications and upgrade tags announce.
_Avoid_: upgrade part, upgradable part

## Usenet acquisition

**Source**:
What a release is acquired by: a BitTorrent v1 info hash, or, for a private-tracker release without a public hash, its file-list identity `files:<sha1>`.
_Avoid_: torrent (for a file-list source), hash (for a file-list source)

**Hash indexer**:
A Usenet indexer that is asked for an NZB by info hash (AnimeTosho, AmeNZB).
_Avoid_: provider (when Prowlarr's indexers are meant too)

**Usenet copy**:
An NZB that carries the files of a source, from a hash indexer or found through Prowlarr.
_Avoid_: Usenet release, NZB match

**Prowlarr fallback**:
Searching Prowlarr by file list for a public source that every enabled hash indexer answered "no NZB" for.
_Avoid_: private search (for a public source)

**Grab**:
One NZB fetched through Prowlarr; the indexer counts it against its download limit.
_Avoid_: download (for the NZB fetch itself)

**Intent**:
Why a Usenet copy is being looked for (looking, searching, checking, reviewing, accepting, sweeping), which decides what may be waited for and spent.
_Avoid_: mode, resolve option
