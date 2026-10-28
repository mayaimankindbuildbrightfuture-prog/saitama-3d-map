"""scripts/fetch_livecams.py のテスト（ネットワーク不要）。"""

import copy
import json
import sys
import unittest
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_livecams  # noqa: E402

CID = "UC" + "a" * 22
CID2 = "UC" + "b" * 22


def lockup(video_id, title, badge):
    return {"richItemRenderer": {"content": {"lockupViewModel": {
        "contentId": video_id,
        "contentImage": {"thumbnailViewModel": {"overlays": [{"thumbnailBottomOverlayViewModel": {"badges": [
            {"thumbnailBadgeViewModel": {"text": "x", "badgeStyle": badge}}]}}]}},
        "metadata": {"lockupMetadataViewModel": {"title": {"content": title}}},
    }}}}


def streams_page(*items):
    data = {"contents": {"tabs": [{"tabRenderer": {"content": {"richGridRenderer": {"contents": list(items)}}}}]}}
    return "<html><script>var ytInitialData = " + json.dumps(data, ensure_ascii=False) + ";</script></html>"


LIVE = "THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"
DEFAULT = "THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT"


class FetchLivecamsTest(unittest.TestCase):
    def test_channel_id(self):
        self.assertEqual(fetch_livecams.find_channel_id(f'<meta itemprop="identifier" content="{CID}">'), CID)
        self.assertEqual(fetch_livecams.find_channel_id(f'..."channelId":"{CID}"...'), CID)
        self.assertIsNone(fetch_livecams.find_channel_id("<html></html>"))

    def test_parse_streams_and_pick_live(self):
        html = streams_page(
            lockup("AAAAAAAAAAA", "東京日暮里 鉄道ライブカメラ", LIVE),
            lockup("BBBBBBBBBBB", "大宮 鉄道ライブカメラ（予定）", DEFAULT),
            lockup("CCCCCCCCCCC", "大宮 鉄道ライブカメラ", LIVE),
        )
        videos = fetch_livecams.parse_streams(html)
        self.assertEqual([(v["videoId"], v["live"]) for v in videos],
                         [("AAAAAAAAAAA", True), ("BBBBBBBBBBB", False), ("CCCCCCCCCCC", True)])
        self.assertEqual(fetch_livecams.pick_live(videos, [])["videoId"], "AAAAAAAAAAA")
        # 同じチャンネルが別の場所も配信しているときは、タイトルで選ぶ
        self.assertEqual(fetch_livecams.pick_live(videos, ["大宮"])["videoId"], "CCCCCCCCCCC")
        self.assertIsNone(fetch_livecams.pick_live(videos, ["京都"]))
        self.assertEqual(fetch_livecams.parse_streams("<html></html>"), [])

    def test_update_cameras(self):
        def err(code):
            return urllib.error.HTTPError("u", code, "x", {}, None)

        pages = {
            "https://www.youtube.com/@cam-a": f'<meta itemprop="identifier" content="{CID}">',
            f"https://www.youtube.com/channel/{CID}/streams": streams_page(lockup("AAAAAAAAAAA", "北浦和 ライブ", LIVE)),
            "https://www.youtube.com/watch?v=seed0000000": f'"channelId":"{CID2}"',
            f"https://www.youtube.com/channel/{CID2}/streams": streams_page(
                lockup("DDDDDDDDDDD", "京都 ライブ", LIVE), lockup("EEEEEEEEEEE", "大宮 ライブ", LIVE)),
        }

        def get(url):
            if "oembed" in url:
                if "EEEEEEEEEEE" in url:
                    raise err(401)  # 埋め込み不可
                return "{}"
            if url not in pages:
                raise err(404)
            return pages[url]

        data = {"cameras": [
            {"title": "A", "type": "youtube", "youtube": {"handle": "@cam-a"}},
            {"title": "B", "type": "youtube", "youtube": {"seedVideos": ["gone0000000", "seed0000000"], "titleKeywords": ["大宮"]}},
            {"title": "C", "type": "youtube", "youtube": {"handle": "@missing", "videoId": "keep0000000"}},
            {"title": "D", "type": "image", "images": []},
        ]}
        fetch_livecams.time.sleep = lambda s: None
        out = fetch_livecams.update_cameras(copy.deepcopy(data), get=get)
        a, b, c = (cam["youtube"] for cam in out["cameras"][:3])
        self.assertEqual((a["channelId"], a["videoId"], a["live"], a["embeddable"]), (CID, "AAAAAAAAAAA", True, True))
        self.assertEqual((b["channelId"], b["videoId"], b["live"], b["embeddable"]), (CID2, "EEEEEEEEEEE", True, False))
        self.assertEqual(c.get("videoId"), "keep0000000")  # 失敗したカメラは前回の値を残す
        self.assertNotIn("youtube", out["cameras"][3])  # YouTube 以外は触らない
        self.assertIsNotNone(out["checkedAt"])

    def test_livecams_file_is_valid(self):
        data = json.loads((ROOT / "data" / "livecams.json").read_text("utf-8"))
        self.assertGreaterEqual(len(data["cameras"]), 10)
        ids = set()
        for cam in data["cameras"]:
            self.assertNotIn(cam["id"], ids)
            ids.add(cam["id"])
            self.assertIn(cam["type"], ("youtube", "image", "links", "link"))
            self.assertTrue(cam["title"] and cam["siteUrl"].startswith("https://"), cam["id"])
            self.assertTrue(35.8 < cam["lat"] < 36.0 and 139.5 < cam["lng"] < 139.8, cam["id"])
            if cam["type"] == "image":
                self.assertTrue(cam["images"] and all(i["url"].startswith("https://") for i in cam["images"]))
            if cam["type"] == "links":
                self.assertTrue(cam["links"] and all(l["url"].startswith("https://") for l in cam["links"]))


if __name__ == "__main__":
    unittest.main()
