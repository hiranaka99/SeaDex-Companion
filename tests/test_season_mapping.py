import unittest
from unittest.mock import patch

import app


def node(mid, title, year, season, episodes, sequel=None, prequel=None):
    edges = []
    if sequel:
        edges.append({"relationType": "SEQUEL", "node": {"id": sequel}})
    if prequel:
        edges.append({"relationType": "PREQUEL", "node": {"id": prequel}})
    return {
        "id": mid,
        "format": "TV",
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
            return app.anilist_chain("Test Series", cache)[0]

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


class CombinedCourScanTests(unittest.TestCase):
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
        self.assertEqual("Nyaa", ordered[0][1]["tracker"])

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
                patch.object(app, "anilist_chain", return_value=(chain, [])), \
                patch.object(app, "load_cache", return_value={}), \
                patch.object(app, "save_last_results"):
            app.run_scan({"sonarr_url": "http://sonarr/api/v3"})

        results = app._get_state()["results"]
        season_one, season_two = results
        self.assertEqual([140960, 142838], season_one["anilist_ids"])
        self.assertEqual("ABdex + NAN0", season_one["best_group"])
        self.assertEqual(["Cour 1", "Cour 2"],
                         [rel["part"] for rel in season_one["releases"]])
        self.assertEqual(158927, season_two["anilist_id"])
        self.assertEqual("https://releases.moe/158927/", season_two["url"])


if __name__ == "__main__":
    unittest.main()