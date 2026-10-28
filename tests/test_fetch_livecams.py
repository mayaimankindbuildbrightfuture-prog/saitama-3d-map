"""scripts/fetch_livecams.py のテスト（ネットワーク不要）。"""

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_livecams  # noqa: E402

CID = "UC" + "a" * 22
CID2 = "UC" + "b" * 22


class FetchLivecamsTest(unittest.TestCase):
    def test_channel_id_and_live_page(self):
        self.assertEqual(fetch_livecams.find_channel_id(f'<meta itemprop="identifier" content="{CID}">'), CID)
        self.assertEqual(fetch_livecams.find_channel_id(f'..."channelId":"{CID}"...'), CID)
        self.assertIsNone(fetch_livecams.find_channel_id("<html></html>"))
        live_html = '<link rel="canonical" href="https://www.youtube.com/watch?v=abcdefghijk">"isLiveNow":true'
        self.assertEqual(fetch_livecams.parse_live_page(live_html), ("abcdefghijk", True))
        offline_html = f'<link rel="canonical" href="https://www.youtube.com/channel/{CID}">'
        self.assertEqual(fetch_livecams.parse_live_page(offline_html), (None, False))

    def test_update_with_handle_seed_and_failure(self):
        pages = {
            "https://www.youtube.com/@cam-a": f'<meta itemprop="identifier" content="{CID}">',
            f"https://www.youtube.com/channel/{CID}/live":
                '<link rel="canonical" href="https://www.youtube.com/watch?v=AAAAAAAAAAA">"isLiveNow":true',
            "https://www.youtube.com/watch?v=seed0000000": f'"channelId":"{CID2}"',
            f"https://www.youtube.com/channel/{CID2}/live": f'<link rel="canonical" href="https://www.youtube.com/channel/{CID2}">',
        }

        def get(url):
            if url not in pages:
                raise OSError("404 " + url)
            return pages[url]

        data = {"cameras": [
            {"title": "A", "youtube": {"handle": "@cam-a"}},
            {"title": "B", "youtube": {"seedVideos": ["gone0000000", "seed0000000"]}},
            {"title": "C", "youtube": {"handle": "@missing", "channelId": None, "videoId": "keep0000000"}},
        ]}
        fetch_livecams.time.sleep = lambda s: None
        out = fetch_livecams.update_cameras(copy.deepcopy(data), get=get)
        a, b, c = (cam["youtube"] for cam in out["cameras"])
        self.assertEqual((a["channelId"], a["videoId"], a["live"]), (CID, "AAAAAAAAAAA", True))
        self.assertEqual((b["channelId"], b["videoId"], b["live"]), (CID2, None, False))
        self.assertEqual(c.get("videoId"), "keep0000000")  # 失敗したカメラは前回の値を残す
        self.assertIsNotNone(out["checkedAt"])

    def test_livecams_file_is_valid(self):
        data = json.loads((ROOT / "data" / "livecams.json").read_text("utf-8"))
        self.assertGreaterEqual(len(data["cameras"]), 3)
        for cam in data["cameras"]:
            self.assertTrue(cam["id"] and cam["title"] and cam["siteUrl"].startswith("https://"))
            self.assertTrue(35.8 < cam["lat"] < 36.0 and 139.5 < cam["lng"] < 139.8, cam["id"])


if __name__ == "__main__":
    unittest.main()
