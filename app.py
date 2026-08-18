#!/usr/bin/env python3
"""SeaDex Companion - Web UI backend.

Compares your Sonarr/Radarr library against the "best" releases on
releases.moe (SeaDEX) and shows which upgrades you're missing, with
anime artwork. Config is editable through the UI and persisted to disk.
"""
import json
import logging
import os
import re
import time
import threading
from logging.handlers import RotatingFileHandler

import requests
from flask import Flask, request, jsonify, send_from_directory

SEADEX  = "https://releases.moe/api"
ANILIST = "https://graphql.anilist.co"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", BASE_DIR)
os.makedirs(DATA_DIR, exist_ok=True)

CONFIG_FILE  = os.path.join(DATA_DIR, "config.json")
CACHE_FILE   = os.path.join(DATA_DIR, "anilist_cache.json")
RESULTS_FILE = os.path.join(DATA_DIR, "last_results.json")
NOTIFIED_FILE = os.path.join(DATA_DIR, "notified.json")
LOG_DIR  = os.path.join(DATA_DIR, "logs")
LOG_FILE = os.path.join(LOG_DIR, "app.log")

# ---------------------------------------------------------------------------
# Logging: rotating file (read by the Log tab) + stdout echo
# ---------------------------------------------------------------------------
os.makedirs(LOG_DIR, exist_ok=True)
log = logging.getLogger("seadex")
log.setLevel(logging.INFO)
if not log.handlers:
    _fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s",
                             datefmt="%Y-%m-%d %H:%M:%S")
    _fh = RotatingFileHandler(LOG_FILE, maxBytes=5 * 1024 * 1024,
                              backupCount=3, encoding="utf-8")
    _fh.setFormatter(_fmt)
    _sh = logging.StreamHandler()
    _sh.setFormatter(_fmt)
    log.addHandler(_fh)
    log.addHandler(_sh)

DEFAULT_CONFIG = {
    "sonarr_url": "https://sonarr-anime.hiranet.de/api/v3",
    "sonarr_key": "REDACTED_SONARR_KEY",
    "radarr_url": "https://radarr-anime.hiranet.de/api/v3",
    "radarr_key": "REDACTED_RADARR_KEY",
    "sonarr_category": "sonarr-anime",
    "radarr_category": "radarr-anime",
    "qbittorrent_url":  "",
    "qbittorrent_user": "",
    "qbittorrent_pass": "",
    "webhook":    "https://discord.com/api/webhooks/1538889176194228225/REDACTED_DISCORD_WEBHOOK_TOKEN",
    "notify_enabled": True,
    "autocheck_minutes": 60,
    "hidden": [],
}

app = Flask(__name__, static_folder="static", static_url_path="")

# ---------------------------------------------------------------------------
# Scan state (in-memory, guarded by a lock)
# ---------------------------------------------------------------------------
scan_state = {
    "running": False,
    "progress": 0,
    "total": 0,
    "message": "Idle",
    "results": [],
    "error": None,
    "last_run": None,
}
state_lock = threading.Lock()


def _set_state(**kw):
    with state_lock:
        scan_state.update(kw)


def _get_state():
    with state_lock:
        return dict(scan_state)


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------
def load_config():
    if not os.path.exists(CONFIG_FILE):
        return dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_FILE) as f:
            c = json.load(f)
        merged = dict(DEFAULT_CONFIG)
        merged.update(c)
        return merged
    except Exception as ex:
        log.warning("Could not read config (%s), using defaults", ex)
        return dict(DEFAULT_CONFIG)


def save_config(c):
    tmp = CONFIG_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(c, f, indent=2)
    os.replace(tmp, CONFIG_FILE)


def load_cache():
    if not os.path.exists(CACHE_FILE):
        return {}
    try:
        return json.load(open(CACHE_FILE))
    except Exception:
        return {}


def save_cache(c):
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(c, f, indent=2)
    os.replace(tmp, CACHE_FILE)


def save_last_results(results, last_run):
    tmp = RESULTS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"results": results, "last_run": last_run}, f)
    os.replace(tmp, RESULTS_FILE)


def load_last_results():
    if not os.path.exists(RESULTS_FILE):
        return None
    try:
        return json.load(open(RESULTS_FILE))
    except Exception:
        return None


def load_notified():
    if not os.path.exists(NOTIFIED_FILE):
        return set()
    try:
        return set(json.load(open(NOTIFIED_FILE)))
    except Exception:
        return set()


def save_notified(keys):
    tmp = NOTIFIED_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(sorted(keys), f)
    os.replace(tmp, NOTIFIED_FILE)


# ---------------------------------------------------------------------------
# Data sources
# ---------------------------------------------------------------------------
def api(url, key=None, **kw):
    h = {"X-Api-Key": key} if key else {}
    try:
        r = requests.get(url, headers=h, timeout=60, **kw)
        if r.status_code >= 400:
            log.error("API %s → HTTP %d", url, r.status_code)
            r.raise_for_status()
        return r.json()
    except requests.exceptions.RequestException as ex:
        log.error("API request to %s failed: %s", url, ex)
        raise


def guess_quality(fn):
    res = re.search(r'(2160p|1080p|720p)', fn, re.I)
    src = re.search(r'(Blu-ray|Web-DL|WebRip|BD-Remux)', fn, re.I)
    return f"{res.group(1) if res else '?'} {src.group(1) if src else ''}".strip()


def _seasons_from_files(files):
    """Detect which seasons a torrent covers from its SxxEyy file names."""
    seasons = set()
    for f in files or []:
        for m in re.finditer(r'S(\d{1,3})E(\d{1,3})', f.get("name", ""), re.I):
            seasons.add(int(m.group(1)))
    return seasons


def seadex_best():
    """Return {alID: {url, notes, seasons: {season: {best: {...}, alts: [...]}}}}.

    Each season carries the single "best" release plus a list of "alt"
    releases (other tracker releases that cover the same season). A release
    is one (season, releaseGroup) pair: when a group ships a season as N
    per-episode torrents, all N are summed into that single release's size
    (matching what releases.moe displays) and their info hashes are kept so
    the whole season can be downloaded at once.
    """
    best, page = {}, 1
    while True:
        d = api(f"{SEADEX}/collections/entries/records?page={page}&perPage=500&expand=trs")
        for e in d["items"]:
            alid = e["alID"]
            trs = (e.get("expand") or {}).get("trs") or []
            if not trs:
                continue
            entry = best.setdefault(alid, dict(
                url=f"https://releases.moe/{alid}/",
                notes=e.get("notes", "") or "-",
                seasons={},
            ))
            # Two-pass: first detect seasons across all torrents, then
            # assign torrents that lack SxxEyy tags to the entry's seasons.
            torrent_infos = []
            entry_seasons = set()
            for t in trs:
                files = t.get("files") or []
                seas = _seasons_from_files(files)
                if seas:
                    entry_seasons.update(seas)
                torrent_infos.append((t, files, seas))
            for t, files, seas in torrent_infos:
                if not seas:
                    seas = entry_seasons if entry_seasons else {0}
                quality = guess_quality(" ".join(f.get("name", "") for f in files))
                sizes = {}   # per-season byte totals from file lengths
                counts = {}  # per-season file counts
                for f in files:
                    m = re.search(r"S(\d{1,3})E", f.get("name", ""), re.I)
                    s = int(m.group(1)) if m else 0
                    sizes[s] = sizes.get(s, 0) + (f.get("length") or 0)
                    counts[s] = counts.get(s, 0) + 1
                for s in seas:
                    slot = entry["seasons"].setdefault(s, {"candidates": []})
                    size = sizes.get(s, 0)
                    if not size and 0 in sizes and s != 0:
                        size = sizes[0]  # files lacked SxxEyy; use total
                    count = counts.get(s, 0)
                    if not count and 0 in counts and s != 0:
                        count = counts[0]
                    # Aggregate per (season, releaseGroup, tracker): the same group
                    # name on two different trackers is TWO separate releases (e.g.
                    # a public Nyaa copy and a private AB copy) and must NOT be
                    # summed into one (that produced bogus 12.5 GB sizes).
                    gkey = (t["releaseGroup"].lower(), (t.get("tracker") or "").lower())
                    rel = next((a for a in slot["candidates"]
                                if (a["releaseGroup"].lower(),
                                    (a.get("tracker") or "").lower()) == gkey), None)
                    if rel is None:
                        rel = dict(
                            releaseGroup=t["releaseGroup"],
                            tracker=t["tracker"],
                            quality=quality,
                            tags=t.get("tags", []),
                            size=0,
                            file_count=0,
                            info_hashes=[],
                            is_best=False,
                        )
                        slot["candidates"].append(rel)
                    rel["size"] += size
                    rel["file_count"] += count
                    rel["is_best"] = rel["is_best"] or bool(t.get("isBest"))
                    ih = t.get("infoHash") or ""
                    if ih and ih not in rel["info_hashes"]:
                        rel["info_hashes"].append(ih)
            # NOTE: the "best" release is picked in run_scan() via _pick_best(),
            # because it depends on the entry's episode count (from AniList), not
            # just on releases.moe data.
        if page >= d["totalPages"]:
            break
        page += 1
    return best


def local_items(cfg):
    """Return items with per-season release groups: {arr, id, title, seasons: {season: [groups]}}."""
    items = []
    if cfg.get("sonarr_url") and cfg.get("sonarr_key"):
        try:
            series = api(cfg["sonarr_url"] + "/series", cfg["sonarr_key"])
        except Exception:
            series = []
        for s in series:
            seasons = {}
            for season in s.get("seasons") or []:
                num = season.get("seasonNumber", 0)
                if num == 0:
                    continue  # Sonarr's specials season is not tracked
                stats = season.get("statistics") or {}
                rgs = stats.get("releaseGroups") or []
                if rgs:
                    seasons[num] = dict(groups=rgs, size=stats.get("sizeOnDisk") or 0)
            if seasons:
                items.append(dict(arr="Sonarr", id=s["id"], title=s["title"],
                                  slug=s.get("titleSlug"), seasons=seasons))
    if cfg.get("radarr_url") and cfg.get("radarr_key"):
        try:
            movies = api(cfg["radarr_url"] + "/movie", cfg["radarr_key"])
        except Exception:
            movies = []
        for m in movies:
            stats = m.get("statistics") or {}
            rgs = stats.get("releaseGroups") or []
            if rgs:
                items.append(dict(arr="Radarr", id=m["id"], title=m["title"],
                                  slug=m.get("titleSlug"),
                                  seasons={0: dict(groups=rgs, size=stats.get("sizeOnDisk") or 0)}))
    return items


def _arr_item_url(cfg, it):
    """Build the Sonarr/Radarr web-UI link for a library item (None if not configured)."""
    base = (cfg.get(f"{it['arr'].lower()}_url") or "").rstrip("/")
    # The configured URL is the API endpoint (…/api/v3); strip it to get the web base.
    base = re.sub(r"/api/v\d+$", "", base)
    if not base:
        return None
    path = "series" if it["arr"] == "Sonarr" else "movie"
    # The web UI routes use the title slug, not the internal numeric id:
    # Sonarr uses a text slug (…/series/call-of-the-night) and Radarr uses
    # the TMDB id (…/movie/1218925). Fall back to the id if no slug exists.
    ident = it.get("slug") or it["id"]
    return f"{base}/{path}/{ident}"


_last_anilist = [0.0]  # pace AniList calls to ~30/min (its rate limit)

def _al_media(query, variables):
    """Paced AniList GraphQL query. Returns data.Media (dict) or {}."""
    data = {}
    for _ in range(6):
        wait = 2.05 - (time.time() - _last_anilist[0])
        if wait > 0:
            time.sleep(wait)
        _last_anilist[0] = time.time()
        try:
            r = requests.post(ANILIST, json={"query": query, "variables": variables}, timeout=30)
        except requests.exceptions.RequestException as ex:
            log.warning("AniList network error, retrying: %s", ex)
            time.sleep(3)  # transient network error -> retry
            continue
        if r.status_code == 429:  # safety net
            log.warning("AniList rate limit (HTTP 429), backing off")
            time.sleep(int(r.headers.get("Retry-After", "60")) + 1)
            continue
        try:
            payload = r.json()
        except ValueError:
            payload = None  # empty / non-JSON body (transient proxy hiccup)
        # A GraphQL error (e.g. a transient 400) yields {"data": null}; coerce
        # the null/missing "data" to {} so .get("Media") never crashes.
        data = ((payload or {}).get("data") or {}).get("Media") or {}
        break
    return data


def _al_search(query, variables):
    """Paced AniList search query. Returns a list of Media candidates."""
    data = {}
    for _ in range(6):
        wait = 2.05 - (time.time() - _last_anilist[0])
        if wait > 0:
            time.sleep(wait)
        _last_anilist[0] = time.time()
        try:
            r = requests.post(ANILIST, json={"query": query, "variables": variables}, timeout=30)
        except requests.exceptions.RequestException as ex:
            log.warning("AniList search network error, retrying: %s", ex)
            time.sleep(3)
            continue
        if r.status_code == 429:
            log.warning("AniList search rate limit (HTTP 429), backing off")
            time.sleep(int(r.headers.get("Retry-After", "60")) + 1)
            continue
        try:
            payload = r.json()
        except ValueError:
            payload = None
        page = ((payload or {}).get("data") or {}).get("Page") or {}
        data = page.get("media") or []
        break
    return data


def normalize_title(t):
    """Clean a Sonarr/Radarr title so AniList's character-sensitive search can match it.

    Handles Unicode lookalikes (× -> x, ' -> ', – -> -) and drops the
    trailing "The Movie" / "Movie" / "Theatrical" that AniList omits.
    """
    if not t:
        return ""
    s = (t.replace("\u00d7", "x")      # × multiplication sign
          .replace("\u2019", "'")      # ' right single quote
          .replace("\u2018", "'")      # ' left single quote
          .replace("\u2013", "-")      # – en dash
          .replace("\u2014", "-")      # — em dash
          .replace("\u2026", "...")    # …
          .replace("\u00ab", "")
          .replace("\u00bb", ""))
    s = re.sub(r"\s*[:\-]\s*(The\s+Movie|Movie|Theatrical)\b.*$", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _search_candidates(title):
    """Ordered AniList search strings, most specific first."""
    norm = normalize_title(title)
    cands = [title, norm]
    # "KissXSis" -> "Kiss X Sis": space out an X sitting between letters
    spaced = re.sub(r"([a-z])\s*([Xx])\s*([A-Z])", r"\1 \2 \3", norm)
    if spaced:
        cands.append(spaced)
    seen, out = set(), []
    for c in cands:
        if not c:
            continue
        k = c.lower()
        if k not in seen:
            seen.add(k)
            out.append(c)
    return out


def _title_key(title):
    """Normalize a title for comparing AniList search candidates."""
    if not title:
        return ""
    # AniList uses typographic apostrophes and ☆ in some titles while Sonarr
    # commonly sends ASCII punctuation. Comparing alphanumeric characters
    # avoids letting those presentation differences choose a sequel or side
    # story over the canonical entry.
    return re.sub(r"[^a-z0-9]+", "", title.lower().replace("\u2019", "'"))


def _pick_anilist_search_result(candidates, title):
    """Choose the canonical media result rather than AniList's first hit.

    SEARCH_MATCH often ranks a sequel, ONA, or special above the franchise's
    base entry when the query omits a subtitle. An exact normalized title is a
    much stronger signal; chronological season order is only a tie breaker.
    """
    wanted = _title_key(title)

    def score(media):
        titles = media.get("title") or {}
        keys = {_title_key(titles.get(k)) for k in ("english", "romaji", "native")}
        exact = wanted and wanted in keys
        # Prefer actual season formats when no title is exact, but retain ONA
        # because AniList uses it for some legitimate main series.
        season_format = media.get("format") in {"TV", "TV_SHORT", "ONA"}
        return (
            3 if exact else 0,
            1 if season_format else 0,
            -(media.get("seasonYear") or 9999),
            -(media.get("id") or 0),
        )

    return max(candidates or [], key=score, default=None)


def anilist_lookup(title, cache):
    # v2 deliberately bypasses the old title cache. The previous resolver
    # accepted AniList's first SEARCH_MATCH result, which cached side stories
    # and later seasons as the franchise base (notably Frieren and Fate/kaleid).
    cache_key = "lookup:v2:" + title
    if cache_key in cache:
        return cache[cache_key]
    # SEARCH_MATCH is useful for finding candidates, but its first result is
    # not guaranteed to be the canonical entry when a franchise has several
    # related entries.
    q = ('query($t:String){Page(perPage:10){media(search:$t,type:ANIME,sort:SEARCH_MATCH){'
         'id format season seasonYear episodes title{romaji english native} '
         'coverImage{large extraLarge} bannerImage}}}')
    for cand in _search_candidates(title):
        data = _pick_anilist_search_result(_al_search(q, {"t": cand}), cand)
        if data:
            cover = data.get("coverImage") or {}
            entry = {
                "id": data["id"],
                "cover": cover.get("extraLarge") or cover.get("large"),
                "banner": data.get("bannerImage"),
            }
            cache[cache_key] = entry
            save_cache(cache)
            return entry
    return None


# Formats that represent a TV "season". Movies, manga, and other non-season
# formats are NOT seasons and must not be counted as one (a franchise can list
# a movie and a TV season as sequels of the same entry).
_SEASON_FORMATS = {"TV", "TV_SHORT", "ONA"}
_SEASON_ORDER = {"WINTER": 0, "SPRING": 1, "SUMMER": 2, "FALL": 3}

# AniList creates a separate media entry for many split cours even though
# Sonarr keeps those episodes in one season.  A continuation explicitly named
# "Part 2" / "Cour 2" must therefore stay attached to its prequel rather than
# consuming the next Sonarr season number.
_COUR_PART_RE = re.compile(
    r"\b(?:part|cour)\s*(?:[-:]\s*)?"
    r"(\d+|first|second|third|fourth|1st|2nd|3rd|4th)\b",
    re.I,
)
_COUR_ORDINALS = {
    "first": 1, "1st": 1,
    "second": 2, "2nd": 2,
    "third": 3, "3rd": 3,
    "fourth": 4, "4th": 4,
}


def _cour_part_number(media):
    """Return an explicit cour/part number from an AniList media title."""
    titles = media.get("title") or {}
    for title in (titles.get("english"), titles.get("romaji"), titles.get("native")):
        m = _COUR_PART_RE.search(title or "")
        if m:
            value = m.group(1).lower()
            return int(value) if value.isdigit() else _COUR_ORDINALS.get(value)
    return None


def _media_part(mid, data, fallback=None):
    """Convert one AniList media node to the compact cached part shape."""
    fallback = fallback or {}
    cover = data.get("coverImage") or {}
    titles = data.get("title") or {}
    return {
        "id": mid,
        "cover": (cover.get("extraLarge") or cover.get("large")
                  or fallback.get("cover")),
        "banner": data.get("bannerImage") or fallback.get("banner"),
        "episodeCount": data.get("episodes"),
        "title": titles.get("english") or titles.get("romaji"),
    }


def anilist_chain(title, cache):
    """Resolve a title to an ordered list of per-season AniList entries.

    Anime season 2+ is usually a *separate* AniList entry linked from the
    first one via a SEQUEL relation. A single SEQUEL pointer is NOT enough:
    a franchise can *branch* (a movie and a TV season can both be sequels of
    the same entry) and can interleave movies between TV seasons. Following
    only the first pointer therefore skips real seasons and counts movies as
    seasons (off-by-one). So we walk the *whole* SEQUEL graph (BFS), keep
    only the entries that are actual TV seasons (dropping non-season formats
    such as movies and manga), and order them chronologically. That yields the
    correct 1:1 mapping between Sonarr seasons and releases.moe entries.

    Split cours are grouped into one item, represented by ``parts``.  For
    example SPY x FAMILY resolves to season IDs
    ``[[140960, 142838], [158927], [177937]]`` rather than assigning Cour 2
    its own Sonarr season.

    Returns [{season, id, ids, parts, cover, banner}, ...] where season 1 is
    the base and ``id`` remains the first part's ID for backwards compatibility.
    """
    base = anilist_lookup(title, cache)
    if not base:
        return []
    # v6 groups split cours into their Sonarr season.  Older cached chains
    # assigned every AniList TV entry a new season and caused this bug.
    # v8 orders TV seasons by their BFS SEQUEL-chain discovery distance so
    # future seasons that lack a release date (e.g. KonoSuba S4) no longer
    # sort before earlier seasons.
    chain_key = "chain:v8:" + str(base["id"])
    if chain_key in cache:
        return cache[chain_key].get("chain", [])

    # NOTE: AniList's Media field for the episode total is "episodes" (not
    # "episodeCount" — that field does not exist and 400s the whole query).
    q = ('query($id:Int){Media(id:$id,type:ANIME){id format season seasonYear episodes '
         'title{romaji english native} coverImage{large extraLarge} bannerImage '
         'relations{edges{relationType node{id}}}}}')

    # BFS the SEQUEL graph, collecting every reachable entry.
    nodes = {}
    seen = {base["id"]}
    queue = [base["id"]]
    while queue and len(nodes) < 50:  # safety cap on API calls
        mid = queue.pop(0)
        d = _al_media(q, {"id": mid})
        if not d:
            continue
        nodes[mid] = d
        for edge in (d.get("relations") or {}).get("edges") or []:
            if edge.get("relationType") != "SEQUEL":
                continue
            nid = (edge.get("node") or {}).get("id")
            if nid and nid not in seen:
                seen.add(nid)
                queue.append(nid)

    # BFS discovery order follows the SEQUEL graph (base -> S2 -> ...) and
    # therefore encodes the correct release order even when AniList lacks a
    # date for a future season (seasonYear/season are None -> previously
    # sorted to the front). Keep it as the primary key so those entries land
    # in their true chronological position; dates still break ties between
    # parallel branches discovered at the same BFS level.
    discovery_index = {mid: i for i, mid in enumerate(nodes)}

    def _season_order(mid):
        d = nodes.get(mid) or {}
        return (discovery_index.get(mid, 0),
                d.get("seasonYear") or 0,
                _SEASON_ORDER.get(d.get("season") or "", 4),
                mid)

    # Keep only real TV seasons (drop movies / manga / other non-season
    # formats) and order them by the SEQUEL chain (with dates as a
    # tiebreaker). The base entry is always season 1.
    season_ids = [mid for mid in nodes
                  if mid != base["id"]
                  and (nodes[mid].get("format") in _SEASON_FORMATS)]
    season_ids.sort(key=_season_order)

    # Build logical Sonarr seasons. An explicitly named Part/Cour 2+ joins its
    # direct PREQUEL's group. Falling back to the latest group handles sparse
    # relation data while still requiring an explicit split-cour title.
    season_groups = [[base["id"]]]
    group_by_id = {base["id"]: season_groups[0]}
    for mid in season_ids:
        d = nodes[mid]
        group = None
        if (_cour_part_number(d) or 0) >= 2:
            prequels = [((edge.get("node") or {}).get("id"))
                        for edge in (d.get("relations") or {}).get("edges") or []
                        if edge.get("relationType") == "PREQUEL"]
            group = next((group_by_id[pid] for pid in prequels
                          if pid in group_by_id), season_groups[-1])
        if group is None:
            group = []
            season_groups.append(group)
        group.append(mid)
        group_by_id[mid] = group

    chain = []
    for season, mids in enumerate(season_groups, start=1):
        parts = [_media_part(
            mid,
            nodes.get(mid) or {},
            base if mid == base["id"] else None,
        ) for mid in mids]
        first = parts[0]
        counts = [p.get("episodeCount") for p in parts]
        chain.append({
            "season": season,
            "id": first["id"],
            "ids": [p["id"] for p in parts],
            "parts": parts,
            "cover": first.get("cover"),
            "banner": first.get("banner"),
            "episodeCount": (sum(counts) if all(c is not None for c in counts)
                             else None),
        })

    cache[chain_key] = {"chain": chain}
    save_cache(cache)
    return chain


def _is_dl(rel):
    """True if the release has a public info hash (magnet downloadable)."""
    return any(re.fullmatch(r"[0-9a-fA-F]{40}", h)
               for h in (rel.get("info_hashes") or []))


def _pick_best(candidates, episode_count=None):
    """Pick the best release from a season's candidates.

    Prefers a release whose file count matches the entry's episode count (a
    per-episode release for exactly this season — this keeps a combined
    multi-entry torrent, e.g. one that spans several entries, from being
    reported as the size of a single season). Then isBest-flagged, then
    downloadable, then largest. Returns (best, alts).
    """
    if not candidates:
        return None, []
    pool = list(candidates)
    if episode_count and episode_count > 0:
        matching = [a for a in pool if a.get("file_count") == episode_count]
        if matching:
            pool = matching
    flagged = [a for a in pool if a.get("is_best")]
    pool2 = flagged or pool
    dl = [a for a in pool2 if _is_dl(a)]
    chosen = max(dl or pool2, key=lambda a: a.get("size") or 0)
    alts = [a for a in candidates if a is not chosen]
    return chosen, alts


def _release_dict(kind, rel, part=None, url=None):
    ihs = list(rel.get("info_hashes") or [])
    result = dict(
        kind=kind,
        releaseGroup=rel["releaseGroup"],
        tracker=rel["tracker"],
        quality=rel["quality"],
        tags=rel.get("tags", []),
        size=rel.get("size") or 0,
        info_hashes=ihs,
        downloadable=_is_dl(rel),
    )
    if part:
        result["part"] = part
    if url:
        result["url"] = url
    return result


def _seadex_slot(entry, season):
    """Find the best candidate bucket for one AniList/SeaDEX entry."""
    slot = entry["seasons"].get(season)
    if slot and slot.get("candidates"):
        return slot
    # Files with bare episode numbers are stored in bucket 0.  A separate
    # AniList entry already identifies the logical season, so use its nearest
    # populated bucket when the Sonarr season number is absent.
    buckets = [(s, value) for s, value in entry["seasons"].items()
               if value.get("candidates")]
    if not buckets:
        return None
    return min(buckets, key=lambda pair: (abs(pair[0] - season), pair[0]))[1]


def _entry_parts(entry):
    """Return parts for new grouped chains and legacy single entries."""
    return entry.get("parts") or [{
        "id": entry["id"],
        "episodeCount": entry.get("episodeCount"),
        "title": None,
    }]


def _ordered_part_releases(best_rel, alts):
    """Deduplicate one cour's releases while preserving its best first.

    The UI displays the release group, but not the tracker.  Keeping the
    tracker in this key therefore produced two visually identical rows when
    the same release was available on both Nyaa and AB.  Prefer the
    downloadable copy when one exists; otherwise keep the first (best-first)
    candidate.

    A release is labelled "best" when releases.moe flags it as such
    (``is_best``) — several groups can share that flag, e.g. a fansub and its
    dub — or when it is this cour's selected primary best.  Everything else
    is an "alt".
    """
    by_group = {}
    for rel in [best_rel] + list(alts):
        key = rel["releaseGroup"].strip().lower()
        current = by_group.get(key)
        if current is None or (_is_dl(rel) and not _is_dl(current)):
            # Tracker deduplication may replace the selected private copy with
            # a downloadable public copy of the same release group. It is
            # still the selected best release; only its download source changed.
            by_group[key] = rel
    best_key = best_rel["releaseGroup"].strip().lower()
    ordered = [best_key] + [key for key in by_group if key != best_key]
    return [
        ("best" if (key == best_key or by_group[key].get("is_best")) else "alt",
         by_group[key])
        for key in ordered
    ]


def _common_best_release(resolved, local_group_keys):
    """Return one owned SeaDEX-best torrent shared by every cour.

    Split cours can be separate AniList/SeaDEX entries while a single torrent
    contains both of them. In that case each entry exposes the same info hash.
    Matching that stable torrent identity avoids incorrectly requiring a
    different per-cour group selected by episode-count heuristics.
    """
    if len(resolved) < 2:
        return None

    common_keys = None
    releases_by_key = {}
    for part in resolved:
        part_keys = set()
        for rel in [part["best"], *part["alts"]]:
            if (not rel.get("is_best") or not _is_dl(rel)
                    or rel["releaseGroup"].strip().lower() not in local_group_keys):
                continue
            hashes = frozenset(
                info_hash.lower() for info_hash in rel.get("info_hashes") or []
                if re.fullmatch(r"[0-9a-fA-F]{40}", info_hash)
            )
            if not hashes:
                continue
            key = (rel["releaseGroup"].strip().lower(), hashes)
            part_keys.add(key)
            releases_by_key.setdefault(key, rel)
        common_keys = (part_keys if common_keys is None
                       else common_keys & part_keys)
        if not common_keys:
            return None

    # Deterministic when malformed data associates several common hashes with
    # one group: prefer the largest complete torrent, like _pick_best().
    return max((releases_by_key[key] for key in common_keys),
               key=lambda rel: rel.get("size") or 0,
               default=None)


def run_scan(cfg):
    started = time.time()
    try:
        log.info("Scan started")
        _set_state(running=True, error=None, progress=0, total=0,
                   message="Loading SeaDEX best releases…", last_run=None)
        best = seadex_best()
        log.info("releases.moe: %d best-release entries loaded", len(best))
        _set_state(message="Loading local library…")
        items = local_items(cfg)
        log.info("Local library: %d item(s) from Sonarr/Radarr", len(items))
        _set_state(total=len(items))
        cache = load_cache()
        results = []
        for i, it in enumerate(items):
            _set_state(progress=i, message=f"Resolving: {it['title']}")
            arr_url = _arr_item_url(cfg, it)
            chain = anilist_chain(it["title"], cache)
            if not chain:
                log.warning("No AniList match for: %s", it["title"])
                for season, ls in sorted(it["seasons"].items()):
                    results.append(dict(
                        key=f"{it['arr']}:item{it['id']}:{season}:missing",
                        group_id=None,
                        arr=it["arr"], title=it["title"], season=season,
                        status="missing",
                        have=sorted(ls["groups"]),
                        local_size=ls.get("size") or 0,
                        best_group=None, best_size=0,
                        releases=[],
                        url=None, notes=None,
                        image=None, banner=None,
                        anilist_id=None,
                        arr_url=arr_url,
                    ))
                continue
            # Map each local season to the correct AniList entry in the chain.
            # Season N uses chain entry N (falling back to the base entry for
            # movies / untagged, or when the chain is shorter than the season).
            for season, ls in sorted(it["seasons"].items()):
                local_groups = ls["groups"]
                slabel = f"S{season:02d}" if season else "Movie"
                _set_state(message=f"Resolving: {it['title']} ({slabel})")
                # Season 0 is a Radarr movie; numbered seasons map to their
                # AniList chain entry (falling back to the base entry).
                entry = chain[season - 1] if 1 <= season <= len(chain) else chain[0]
                alid = entry["id"]
                parts = _entry_parts(entry)
                common = dict(
                    group_id=chain[0]["id"],  # stable id of the base entry
                    arr=it["arr"], title=it["title"], season=season,
                    have=sorted(local_groups),
                    local_size=ls.get("size") or 0,
                    url=None, notes=None,
                    image=entry.get("cover"), banner=entry.get("banner"),
                    anilist_id=alid,
                    arr_url=arr_url,
                )
                # Resolve every AniList cour belonging to this Sonarr season.
                # SPY x FAMILY S01, for example, evaluates both 140960 and
                # 142838, while Sonarr S02 starts at 158927.
                resolved = []
                sources = []
                missing_part = False
                uncovered_part = False
                for part_index, part in enumerate(parts, start=1):
                    part_alid = part["id"]
                    b = best.get(part_alid)
                    if not b:
                        missing_part = True
                        continue
                    label = f"Cour {part_index}" if len(parts) > 1 else None
                    sources.append({"label": label or "releases.moe", "url": b["url"]})
                    slot = _seadex_slot(b, season)
                    if not slot:
                        uncovered_part = True
                        continue
                    best_rel, alts = _pick_best(
                        slot["candidates"], part.get("episodeCount"))
                    if not best_rel:
                        uncovered_part = True
                        continue
                    resolved.append({
                        "label": label,
                        "source": b,
                        "best": best_rel,
                        "alts": alts,
                    })

                common["urls"] = sources
                common["anilist_ids"] = [part["id"] for part in parts]
                if sources:
                    common["url"] = sources[0]["url"]
                    notes = []
                    for source in resolved:
                        note = source["source"].get("notes") or "-"
                        if note != "-" and note not in notes:
                            notes.append(note)
                    common["notes"] = "\n".join(notes) if notes else "-"

                if missing_part:
                    # At least one cour is not on releases.moe. Do not report a
                    # partially checked combined season as already best.
                    results.append(dict(common,
                        key=f"{it['arr']}:{alid}:{season}:missing",
                        status="missing",
                        best_group=None, best_size=0, releases=[],
                    ))
                    continue
                if uncovered_part or len(resolved) != len(parts):
                    results.append(dict(common,
                        key=f"{it['arr']}:{alid}:{season}:uncovered",
                        status="uncovered",
                        best_group=None, best_size=0, releases=[],
                    ))
                    continue

                best_rels = [part["best"] for part in resolved]
                best_groups = list(dict.fromkeys(
                    rel["releaseGroup"] for rel in best_rels))
                best_group = " + ".join(best_groups)
                best_size = sum(rel.get("size") or 0 for rel in best_rels)
                local_group_keys = {group.lower() for group in local_groups}
                owns_all_best = all(rel["releaseGroup"].lower() in local_group_keys
                                    for rel in best_rels)

                # A single torrent can span every AniList cour in this Sonarr
                # season. If that exact SeaDEX-best info hash is present on all
                # cour pages and its group is owned, it satisfies the season as
                # one release instead of requiring one independently selected
                # group per cour (and its size must only be counted once).
                common_best = _common_best_release(resolved, local_group_keys)
                if common_best:
                    best_rels = [common_best]
                    best_group = common_best["releaseGroup"]
                    best_size = common_best.get("size") or 0
                    owns_all_best = True

                # Already own the *best* release -> "best" (green).
                # For a split cour, every cour's best must be owned.
                if owns_all_best:
                    # Show every releases.moe "best" release for each cour, not
                    # just the single owned torrent: several groups can share
                    # the best flag (e.g. a fansub and its dub) and the user
                    # should still see those alternatives.
                    releases = []
                    for part in resolved:
                        primary = common_best or part["best"]
                        for kind, rel in _ordered_part_releases(
                                primary, part["alts"]):
                            if kind != "best":
                                continue
                            releases.append(_release_dict(
                                kind, rel, part["label"],
                                part["source"]["url"]))
                    results.append(dict(common,
                        key=f"{it['arr']}:{alid}:{season}:{best_group}",
                        status="best",
                        best_group=best_group,
                        best_size=best_size,
                        releases=releases,
                    ))
                    continue

                # Keep cour releases separate: their torrents and best groups
                # can differ (SPY x FAMILY uses ABdex then NAN0). This lets the
                # user download only the cour that needs upgrading.
                releases = []
                for part in resolved:
                    for kind, rel in _ordered_part_releases(part["best"], part["alts"]):
                        releases.append(_release_dict(
                            kind, rel, part["label"], part["source"]["url"]))
                results.append(dict(common,
                    key=f"{it['arr']}:{alid}:{season}:{best_group}",
                    status="upgrade",
                    best_group=best_group,
                    best_size=best_size,
                    releases=releases,
                ))
        last_run = time.strftime("%Y-%m-%d %H:%M:%S")
        _set_state(progress=len(items), message="Done", results=results, last_run=last_run)
        save_last_results(results, last_run)
        auto_notify_new(cfg)
        log.info("Scan finished in %.1fs — %d upgrade(s) found",
                 time.time() - started, len(results))
    except Exception as ex:
        log.error("Scan failed: %s", ex, exc_info=True)
        _set_state(error=str(ex))
    finally:
        _set_state(running=False)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/config", methods=["GET"])
def get_config():
    return jsonify(load_config())


@app.route("/api/config", methods=["POST"])
def post_config():
    data = request.get_json(force=True)
    cfg = load_config()
    for k in DEFAULT_CONFIG:
        if k not in data:
            continue
        default = DEFAULT_CONFIG[k]
        if isinstance(default, bool):
            cfg[k] = bool(data[k])
        elif isinstance(default, int):
            try:
                cfg[k] = max(0, int(data[k]))
            except (TypeError, ValueError):
                cfg[k] = default
        elif isinstance(default, list):
            cfg[k] = list(data[k] or [])
        else:
            cfg[k] = (str(data[k]) if data[k] is not None else "").strip()
    save_config(cfg)
    log.info("Config saved (autocheck=%sm, notify=%s)",
             cfg.get("autocheck_minutes"), cfg.get("notify_enabled"))
    return jsonify(cfg)


@app.route("/api/status", methods=["GET"])
def get_status():
    st = _get_state()
    return jsonify({
        "running": st["running"],
        "progress": st["progress"],
        "total": st["total"],
        "message": st["message"],
        "error": st["error"],
        "last_run": st["last_run"],
        "next_check": autocheck_state.get("next"),
    })


@app.route("/api/results", methods=["GET"])
def get_results():
    st = _get_state()
    if st["results"]:
        return jsonify({"results": st["results"], "last_run": st["last_run"]})
    return jsonify(load_last_results() or {"results": [], "last_run": None})


@app.route("/api/logs", methods=["GET"])
def get_logs():
    n = request.args.get("lines", 500, type=int)
    n = max(1, min(n, 2000))
    lines = []
    if os.path.exists(LOG_FILE):
        try:
            with open(LOG_FILE, encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
        except Exception:
            lines = []
    return jsonify({"lines": [ln.rstrip("\n") for ln in lines[-n:]],
                    "total": len(lines)})


@app.route("/api/scan", methods=["POST"])
def start_scan():
    if _get_state()["running"]:
        return jsonify({"ok": False, "error": "Scan already running"}), 409
    cfg = load_config()
    threading.Thread(target=run_scan, args=(cfg,), daemon=True).start()
    return jsonify({"ok": True})


def send_to_discord(webhook, results):
    sent = 0
    for r in results:
        season = r.get("season")
        title = r["title"] + (f"  (S{season:02d})" if season else "")
        best_rel = (r.get("releases") or [{}])[0]
        msg = (f"{r['arr']} · {title}\n"
               f"  have : {', '.join(r['have'])}\n"
               f"  best : {r['best_group']}  ({best_rel.get('quality', '')}, {best_rel.get('tracker', '')})\n"
               f"  notes: {r['notes']}\n"
               f"  tags : {', '.join(best_rel.get('tags', [])) or '-'}\n"
               f"  {r['url']}")
        try:
            requests.post(webhook, json={"content": msg[:1900]}, timeout=30)
            sent += 1
            time.sleep(0.5)  # respect Discord rate limit
        except requests.exceptions.RequestException as ex:
            log.error("Discord webhook failed for %s: %s", title, ex)
    if sent:
        log.info("Discord: sent %d/%d notification(s)", sent, len(results))
    return sent


def auto_notify_new(cfg):
    """Discord-alert upgrades that have not been notified before."""
    if not cfg.get("notify_enabled", True) or not cfg.get("webhook"):
        return 0
    results = _get_state().get("results") or []
    notified = load_notified()
    new = [r for r in results
           if r.get("status") == "upgrade" and r.get("key")
           and r["key"] not in notified]
    if not new:
        return 0
    sent = send_to_discord(cfg["webhook"], new)
    notified.update(r["key"] for r in new)
    save_notified(notified)
    return sent


@app.route("/api/hidden", methods=["POST"])
def hide():
    """Persist which cards are hidden in the library view (survives restarts)."""
    data = request.get_json(force=True)
    key = (data.get("key") or "").strip()
    if not key:
        return jsonify({"ok": False, "error": "No key provided"}), 400
    cfg = load_config()
    hidden = set(cfg.get("hidden") or [])
    if data.get("hidden"):
        hidden.add(key)
    else:
        hidden.discard(key)
    cfg["hidden"] = sorted(hidden)
    save_config(cfg)
    return jsonify({"ok": True, "hidden": cfg["hidden"]})


# ---------------------------------------------------------------------------
# qBittorrent: send best releases to the user's client
# ---------------------------------------------------------------------------
qb_state = {"session": None, "lock": threading.Lock()}


def _qb_login(base, user, pw):
    s = requests.Session()
    r = s.post(base + "/api/v2/auth/login",
               data={"username": user, "password": pw}, timeout=30)
    # qBittorrent 5.x returns 204 (empty body) on success; older versions
    # returned 200 with an "Ok" body. Anything else is a failure.
    if r.status_code == 204 or (r.status_code == 200 and "Ok" in r.text):
        return s
    raise RuntimeError(f"qBittorrent login failed (HTTP {r.status_code})")


def qb_add_torrent(cfg, magnet, category=None):
    """Add a magnet to qBittorrent under the given category (re-logs in once on 403)."""
    base = (cfg.get("qbittorrent_url") or "").rstrip("/")
    if not base:
        raise RuntimeError("qBittorrent is not configured (Config tab)")
    data = {"urls": magnet}
    if category:
        data["category"] = category
    with qb_state["lock"]:
        for attempt in (1, 2):
            if qb_state["session"] is None:
                qb_state["session"] = _qb_login(
                    base, cfg.get("qbittorrent_user", ""), cfg.get("qbittorrent_pass", ""))
            r = qb_state["session"].post(base + "/api/v2/torrents/add",
                                         data=data, timeout=30)
            if r.status_code == 403 and attempt == 1:  # SID expired -> re-login once
                qb_state["session"] = _qb_login(
                    base, cfg.get("qbittorrent_user", ""), cfg.get("qbittorrent_pass", ""))
                continue
            if r.status_code == 200:
                # Older qBittorrent returns the text "Ok"; 5.x returns JSON
                # like {"success_count":1, "added_torrent_ids":[...]}.
                if "Ok" in r.text:
                    return
                try:
                    data = r.json()
                    if data.get("success_count", 0) > 0 or data.get("added_torrent_ids"):
                        return
                except ValueError:
                    pass
            raise RuntimeError(f"qBittorrent rejected the torrent (HTTP {r.status_code}: {r.text[:120]})")


@app.route("/api/download", methods=["POST"])
def download():
    data = request.get_json(force=True)
    key = (data.get("key") or "").strip()
    try:
        idx = int(data.get("release", 0))
    except (TypeError, ValueError):
        idx = 0
    if not key:
        return jsonify({"ok": False, "error": "No key provided"}), 400
    st = _get_state()
    results = st["results"] or (load_last_results() or {}).get("results", [])
    r = next((x for x in results if x.get("key") == key), None)
    if not r:
        return jsonify({"ok": False, "error": "Result not found — run a scan first"}), 404
    releases = r.get("releases") or []
    if idx < 0 or idx >= len(releases):
        return jsonify({"ok": False, "error": "Release not found"}), 404
    rel = releases[idx]
    ihs = [h.lower() for h in (rel.get("info_hashes") or [])
           if re.fullmatch(r"[0-9a-f]{40}", h)]
    if not ihs:
        return jsonify({"ok": False, "error": "No magnet available for this release (private tracker)"}), 400
    cfg = load_config()
    category = (cfg.get(f"{r['arr'].lower()}_category") or "").strip()
    try:
        for ih in ihs:
            qb_add_torrent(cfg, "magnet:?xt=urn:btih:" + ih, category)
    except Exception as ex:
        log.error("Download failed for %s (release %d): %s", key, idx, ex)
        return jsonify({"ok": False, "error": str(ex)}), 502
    log.info("Sent to qBittorrent: %s release %d, %d torrent(s) (category: %s)",
             key, idx, len(ihs), category or "-")
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Auto-check scheduler: re-scan on a fixed interval and alert on new upgrades
# ---------------------------------------------------------------------------
autocheck_state = {"last": time.time(), "next": None}


def scheduler_loop():
    while True:
        time.sleep(30)
        try:
            cfg = load_config()
            minutes = cfg.get("autocheck_minutes", 0) or 0
            if minutes <= 0:
                autocheck_state["next"] = None
                continue
            interval = minutes * 60
            if time.time() - autocheck_state["last"] >= interval:
                autocheck_state["last"] = time.time()
                autocheck_state["next"] = time.time() + interval
                if _get_state()["running"]:
                    log.info("Auto-check due, but a scan is already running — skipping")
                    continue
                log.info("Auto-check triggered (interval %d min)", minutes)
                run_scan(cfg)
        except Exception as ex:
            log.error("Scheduler error: %s", ex)


threading.Thread(target=scheduler_loop, daemon=True).start()


if __name__ == "__main__":
    from waitress import serve
    port = int(os.environ.get("PORT", "8080"))
    log.info("Server starting on 0.0.0.0:%d (data dir: %s)", port, DATA_DIR)
    serve(app, host="0.0.0.0", port=port)