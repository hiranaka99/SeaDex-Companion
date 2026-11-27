# SeaDex Companion

SeaDex Companion compares a Sonarr or Radarr anime library with the releases SeaDex recommends, and acquires the better ones through a torrent or a Usenet client.

## Library

**Library instance**:
One Sonarr or Radarr connection whose titles are scanned. Every result belongs to exactly one, and a download is filed under that instance's category so the same instance imports it.
_Avoid_: arr, source (a source is what a release is acquired by)

**Primary instance**:
The first Sonarr or the first Radarr, set up under its own settings. Results, rules and hidden titles saved before additional instances existed belong to it.
_Avoid_: main instance, default instance

**Additional instance**:
Any library instance after the primary instance of its kind, with its own name, categories and scope.
_Avoid_: extra instance, secondary instance

A library is **connected** when at least one library instance, primary or additional, has both an address and an API key.

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
