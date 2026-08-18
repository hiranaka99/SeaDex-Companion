import unittest
from unittest.mock import patch

import app


def node(mid, title, year, season, episodes, sequel=None, prequel=None,
         fmt="TV", side_story=None):
    edges = []
    if sequel:
        edges.append({"relationType": "SEQUEL", "node": {"id": sequel}})
    if prequel:
        edges.append({"relationType": "PREQUEL", "node": {"id": prequel}})
    if side_story:
        edges.append({"relationType": "SIDE_STORY", "node": {"id": side_story}})
    return {
        "id": mid,
        "format": fmt,
        "season": season,
        "seasonYear": year,
        "episodes": episodes,
        "title": {"english": title, "romaji": title},
        "coverImage": {"large": f"cover-{mid}"},
        "bannerImage": f"banner-{mid}",
        "relations": {"edges": edges},
    }


def release(group, count, best=False, hash_char="a"):
    return {
        "releaseGroup": group,
        "tracker": "Nyaa",
        "quality": "1080p Blu-ray",
        "tags": [],
        "size": count * 100,
        "file_count": count,
        "info_hashes": [hash_char * 40],
        "is_best": best,
    }


def seadex_entry(alid, candidate, bucket=0):
    return {
        "url": f"https://releases.moe/{alid}/",
        "notes": "-",
        "seasons": {bucket: {"candidates": [candidate]}},
    }


class AniListChainTests(unittest.TestCase):
    def _chain(self, nodes):
        base_id = next(iter(nodes))
        cache = {}
        base = {"id": base_id, "cover": f"cover-{base_id}",
                "banner": f"banner-{base_id}"}
        with patch.object(app, "anilist_lookup", return_value=base), \
                patch.object(app, "_al_media",
                             side_effect=lambda _q, variables: nodes.get(variables["id"], {})), \
                patch.object(app, "save_cache"):
            return app.anilist_chain("Test Series", cache)

    def test_spy_family_cour_two_stays_in_season_one(self):
        nodes = {
            140960: node(140960, "SPY x FAMILY", 2022, "SPRING", 12,
                         sequel=142838),
            142838: node(142838, "SPY x FAMILY Cour 2", 2022, "FALL", 13,
                         sequel=158927, prequel=140960),
            158927: node(158927, "SPY x FAMILY Season 2", 2023, "FALL", 12,
                         sequel=177937, prequel=142838),
            177937: node(177937, "SPY x FAMILY Season 3", 2025, "FALL", 13,
                         prequel=158927),
        }

        chain = self._chain(nodes)

        self.assertEqual([[140960, 142838], [158927], [177937]],
                         [entry["ids"] for entry in chain])
        self.assertEqual([1, 2, 3], [entry["season"] for entry in chain])
        self.assertEqual(25, chain[0]["episodeCount"])
        self.assertEqual(158927, chain[1]["id"])

    def test_normal_numbered_seasons_are_not_merged(self):
        nodes = {
            1: node(1, "Example", 2020, "SPRING", 12, sequel=2),
            2: node(2, "Example Season 2", 2021, "SPRING", 12,
                    sequel=3, prequel=1),
            3: node(3, "Example Season 3", 2022, "SPRING", 12, prequel=2),
        }

        chain = self._chain(nodes)

        self.assertEqual([[1], [2], [3]], [entry["ids"] for entry in chain])

    def test_search_prefers_canonical_title_over_side_story_or_sequel(self):
        frieren = [
            {"id": 170068, "format": "ONA", "seasonYear": 2023,
             "title": {"romaji": "Sousou no Frieren: ●● no Mahou"}},
            {"id": 154587, "format": "TV", "seasonYear": 2023,
             "title": {"english": "Frieren: Beyond Journey’s End"}},
        ]
        fate = [
            {"id": 21379, "format": "TV", "seasonYear": 2016,
             "title": {"english": "Fate/kaleid liner Prisma☆Illya 3rei!!"}},
            {"id": 14829, "format": "ONA", "seasonYear": 2013,
             "title": {"english": "Fate/kaleid liner Prisma☆Illya"}},
        ]

        self.assertEqual(
            154587,
            app._pick_anilist_search_result(
                frieren, "Frieren: Beyond Journey's End")["id"],
        )
        self.assertEqual(
            14829,
            app._pick_anilist_search_result(
                fate, "Fate/kaleid liner PRISMA ILLYA")["id"],
        )

    def test_frieren_tv_seasons_are_not_confused_with_side_story_onas(self):
        nodes = {
            154587: node(154587, "Frieren: Beyond Journey’s End", 2023,
                           "FALL", 28, sequel=182255, side_story=170068),
            182255: node(182255, "Frieren: Beyond Journey’s End Season 2", 2026,
                           "WINTER", 10, prequel=154587, side_story=206425),
            170068: node(170068, "Frieren: ●● no Mahou", 2023, "FALL", 12,
                           fmt="ONA"),
            206425: node(206425, "Frieren: ●● no Mahou Part 3", 2026,
                           "WINTER", None, fmt="ONA"),
        }
        cache = {}
        base = {"id": 154587, "cover": "cover-154587", "banner": "banner-154587"}
        with patch.object(app, "anilist_lookup", return_value=base), \
                patch.object(app, "_al_media",
                             side_effect=lambda _q, variables: nodes.get(variables["id"], {})), \
                patch.object(app, "save_cache"):
            chain = app.anilist_chain("Frieren: Beyond Journey's End", cache)

        self.assertEqual([[154587], [182255]], [entry["ids"] for entry in chain])

    def test_undated_future_season_does_not_sort_before_earlier_seasons(self):
        # KonoSuba regression: Season 4 (187924) has no seasonYear/season on
        # AniList yet (it's not aired). Sorting by (seasonYear or 0) previously
        # put it BEFORE Season 2 (21699) and Season 3 (136804), so Sonarr S02
        # wrongly mapped to releases.moe/136804 (Season 3's page).
        nodes = {
            21202: node(21202, "KONOSUBA S1", 2016, "WINTER", 10, sequel=21699),
            21699: node(21699, "KONOSUBA S2", 2017, "WINTER", 10,
                         sequel=102976, prequel=21202),
            102976: node(102976, "KONOSUBA Legend of Crimson", 2019, "FALL", 1,
                         fmt="MOVIE", sequel=136804, prequel=21699),
            136804: node(136804, "KONOSUBA S3", 2024, "SPRING", 11,
                         sequel=187924, prequel=102976),
            187924: node(187924, "KONOSUBA S4", None, None, None,
                         prequel=136804),
        }
        cache = {}
        base = {"id": 21202, "cover": "cover-21202", "banner": "banner-21202"}
        with patch.object(app, "anilist_lookup", return_value=base), \
                patch.object(app, "_al_media",
                             side_effect=lambda _q, variables: nodes.get(variables["id"], {})), \
                patch.object(app, "save_cache"):
            chain = app.anilist_chain("KONOSUBA", cache)

        self.assertEqual([[21202], [21699], [136804], [187924]],
                         [entry["ids"] for entry in chain])
        self.assertEqual(21699, chain[1]["id"])
        self.assertEqual(136804, chain[2]["id"])
        self.assertEqual(187924, chain[3]["id"])

    def test_fate_kaleid_chain_starts_at_original_series(self):
        nodes = {
            14829: node(14829, "Fate/kaleid liner Prisma☆Illya", 2013,
                        "SUMMER", 10, sequel=20467),
            20467: node(20467, "Fate/kaleid liner Prisma☆Illya 2wei!", 2014,
                        "SUMMER", 10, sequel=20845, prequel=14829),
            20845: node(20845, "Fate/kaleid liner Prisma☆Illya 2wei Herz!", 2015,
                        "SUMMER", 10, sequel=21379, prequel=20467),
            21379: node(21379, "Fate/kaleid liner Prisma☆Illya 3rei!!", 2016,
                        "SUMMER", 12, prequel=20845, side_story=87488),
            87488: node(87488, "Fate/kaleid liner Prisma☆Illya 3rei!! Short Anime",
                        2016, None, 6, fmt="SPECIAL"),
        }
        cache = {}
        base = {"id": 14829, "cover": "cover-14829", "banner": "banner-14829"}
        with patch.object(app, "anilist_lookup", return_value=base), \
                patch.object(app, "_al_media",
                             side_effect=lambda _q, variables: nodes.get(variables["id"], {})), \
                patch.object(app, "save_cache"):
            chain = app.anilist_chain("Fate/kaleid liner PRISMA ILLYA", cache)

        self.assertEqual([[14829], [20467], [20845], [21379]],
                         [entry["ids"] for entry in chain])


class CombinedCourScanTests(unittest.TestCase):
    def test_best_flag_takes_priority_over_episode_count_match(self):
        # Banished from the Hero's Party regression: TTGA is SeaDEX's Best but
        # contains an extra file, while the 13-file YURASUKA encode is an Alt.
        # Episode-count matching must not promote that explicitly non-best Alt.
        ttga = release("TTGA", 14, True, "a")
        yurasuka = release("YURASUKA", 13, False, "b")

        best, alts = app._pick_best([ttga, yurasuka], episode_count=13)
        ordered = app._ordered_part_releases(best, alts)

        self.assertEqual("TTGA", best["releaseGroup"])
        self.assertEqual(
            [("best", "TTGA"), ("alt", "YURASUKA")],
            [(kind, rel["releaseGroup"]) for kind, rel in ordered],
        )

    def test_ordered_releases_only_keeps_one_row_per_release_group(self):
        best = release("Flugel", 12, True, "a")
        best["tracker"] = "Nyaa"
        alt_tracker = release("Flugel", 12, False, "b")
        alt_tracker["tracker"] = "AB"
        other = release("Okay-Subs", 12, False, "c")
        other["tracker"] = "Nyaa"

        ordered = app._ordered_part_releases(best, [alt_tracker, other])

        self.assertEqual(["Flugel", "Okay-Subs"],
                         [rel["releaseGroup"] for _, rel in ordered])
        self.assertEqual("Nyaa", ordered[0][1]["tracker"])

    def test_ordered_releases_prefers_downloadable_tracker(self):
        best = release("Bunny-Apocalypse", 12, True, "private")
        best["tracker"] = "AB"
        downloadable = release("Bunny-Apocalypse", 12, False, "b")
        downloadable["tracker"] = "Nyaa"

        ordered = app._ordered_part_releases(best, [downloadable])

        self.assertEqual(1, len(ordered))
        self.assertEqual("best", ordered[0][0])
        self.assertEqual("Nyaa", ordered[0][1]["tracker"])

    def test_common_best_requires_the_exact_same_release_hashes(self):
        shared = "a" * 40
        first = release("Group", 2, True, "x")
        first["info_hashes"] = [shared, "b" * 40]
        second = release("Group", 2, True, "x")
        second["info_hashes"] = [shared, "c" * 40]
        resolved = [
            {"best": first, "alts": []},
            {"best": second, "alts": []},
        ]

        self.assertIsNone(app._common_best_release(resolved, {"group"}))

    def test_owned_common_best_torrent_satisfies_both_cours(self):
        chain = [
            {
                "season": 1,
                "id": 1,
                "ids": [1],
                "parts": [{"id": 1, "episodeCount": 12}],
                "cover": "cover-1",
                "banner": "banner-1",
            },
            {
                "season": 2,
                "id": 21,
                "ids": [21, 22],
                "parts": [
                    {"id": 21, "episodeCount": 13},
                    {"id": 22, "episodeCount": 12},
                ],
                "cover": "cover-2",
                "banner": "banner-2",
            },
        ]

        def entry(alid, candidates):
            return {
                "url": f"https://releases.moe/{alid}/",
                "notes": "-",
                "seasons": {2: {"candidates": candidates}},
            }

        # Both public torrents occur on both cour pages and are marked best by
        # SeaDEX. Per-cour episode-count matching would otherwise select the
        # private MTBB copy for Cour 1 and the private Diddy copy for Cour 2.
        mtbb_cour_1 = release("MTBB", 25, True, "a")
        mtbb_cour_2 = release("MTBB", 25, True, "a")
        diddy_cour_1 = release("Diddy", 24, True, "b")
        diddy_cour_2 = release("Diddy", 24, True, "b")
        mtbb_private = release("MTBB", 13, True, "private")
        mtbb_private["tracker"] = "AB"
        diddy_private = release("Diddy", 12, True, "private")
        diddy_private["tracker"] = "AB"
        best = {
            21: entry(21, [mtbb_cour_1, mtbb_private, diddy_cour_1]),
            22: entry(22, [mtbb_cour_2, diddy_cour_2, diddy_private]),
        }
        items = [{
            "arr": "Sonarr",
            "id": 10,
            "title": "Combined Season",
            "slug": "combined-season",
            "seasons": {2: {"groups": ["MTBB"], "size": 2500}},
        }]

        with patch.object(app, "seadex_best", return_value=best), \
                patch.object(app, "local_items", return_value=items), \
                patch.object(app, "anilist_chain", return_value=chain), \
                patch.object(app, "load_cache", return_value={}), \
                patch.object(app, "save_last_results"):
            app.run_scan({"sonarr_url": "http://sonarr/api/v3"})

        result = app._get_state()["results"][0]
        self.assertEqual("best", result["status"])
        self.assertEqual("MTBB", result["best_group"])
        # The exact same torrent covers both cours, so its size is counted once.
        self.assertEqual(2500, result["best_size"])
        # releases.moe flags BOTH MTBB and Diddy as best, so each cour lists
        # both as a "best" release (Diddy as a downloadable alternative to the
        # owned MTBB torrent) instead of dropping Diddy entirely.
        self.assertEqual(["MTBB", "Diddy", "MTBB", "Diddy"],
                         [rel["releaseGroup"] for rel in result["releases"]])
        self.assertEqual(["best", "best", "best", "best"],
                         [rel["kind"] for rel in result["releases"]])
        self.assertEqual(["Cour 1", "Cour 1", "Cour 2", "Cour 2"],
                         [rel["part"] for rel in result["releases"]])

    def test_scan_checks_both_cours_and_maps_actual_season_two(self):
        chain = [
            {
                "season": 1,
                "id": 140960,
                "ids": [140960, 142838],
                "parts": [
                    {"id": 140960, "episodeCount": 12},
                    {"id": 142838, "episodeCount": 13},
                ],
                "cover": "cover-1",
                "banner": "banner-1",
            },
            {
                "season": 2,
                "id": 158927,
                "ids": [158927],
                "parts": [{"id": 158927, "episodeCount": 12}],
                "cover": "cover-2",
                "banner": "banner-2",
            },
        ]
        best = {
            140960: seadex_entry(140960, release("ABdex", 12, True, "a")),
            142838: seadex_entry(142838, release("NAN0", 13, True, "b")),
            158927: seadex_entry(158927, release("NAN0", 12, True, "c")),
        }
        items = [{
            "arr": "Sonarr",
            "id": 10,
            "title": "SPY x FAMILY",
            "slug": "spy-x-family",
            "seasons": {
                1: {"groups": ["ABdex"], "size": 2500},
                2: {"groups": ["scoot"], "size": 1200},
            },
        }]

        with patch.object(app, "seadex_best", return_value=best), \
                patch.object(app, "local_items", return_value=items), \
                patch.object(app, "anilist_chain", return_value=chain), \
                patch.object(app, "load_cache", return_value={}), \
                patch.object(app, "save_last_results"):
            app.run_scan({"sonarr_url": "http://sonarr/api/v3"})

        results = app._get_state()["results"]
        season_one, season_two = results
        self.assertEqual([140960, 142838], season_one["anilist_ids"])
        self.assertEqual("upgrade", season_one["status"])
        self.assertEqual("ABdex + NAN0", season_one["best_group"])
        self.assertEqual(["Cour 1", "Cour 2"],
                         [rel["part"] for rel in season_one["releases"]])
        self.assertEqual(158927, season_two["anilist_id"])
        self.assertEqual("https://releases.moe/158927/", season_two["url"])

    def test_owning_a_non_largest_best_flagged_release_is_best_quality(self):
        # Call of the Night S01: two releases are both flagged best by
        # releases.moe (a fansub and its dub). The user owns the smaller one
        # (Okay-Subs), not the largest (NTRX) that _pick_best() selects as the
        # primary best. Owning ANY best-flagged release means the season is
        # already best quality, so it must not be reported as "upgrade".
        ntrx = release("NTRX", 13, True, "a")
        okay = release("Okay-Subs", 13, True, "b")
        ntrx["size"] = 15300  # larger -> selected as the primary best
        okay["size"] = 14600  # smaller -> owned by the user
        best = {
            100: {
                "url": "https://releases.moe/100/",
                "notes": "-",
                "seasons": {1: {"candidates": [ntrx, okay]}},
            },
        }
        chain = [{
            "season": 1,
            "id": 100,
            "ids": [100],
            "parts": [{"id": 100, "episodeCount": 13}],
            "cover": "cover-100",
            "banner": "banner-100",
        }]
        items = [{
            "arr": "Sonarr",
            "id": 10,
            "title": "Call of the Night",
            "slug": "call-of-the-night",
            "seasons": {1: {"groups": ["Okay-Subs"], "size": 14600}},
        }]

        with patch.object(app, "seadex_best", return_value=best), \
                patch.object(app, "local_items", return_value=items), \
                patch.object(app, "anilist_chain", return_value=chain), \
                patch.object(app, "load_cache", return_value={}), \
                patch.object(app, "save_last_results"):
            app.run_scan({"sonarr_url": "http://sonarr/api/v3"})

        result = app._get_state()["results"][0]
        self.assertEqual("best", result["status"])
        # Both best-flagged releases are still shown (NTRX + Okay-Subs).
        self.assertEqual(["NTRX", "Okay-Subs"],
                         [rel["releaseGroup"] for rel in result["releases"]])
        self.assertEqual(["best", "best"],
                         [rel["kind"] for rel in result["releases"]])


if __name__ == "__main__":
    unittest.main()
