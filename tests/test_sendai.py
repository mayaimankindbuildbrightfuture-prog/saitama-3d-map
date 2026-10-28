"""仙台市版（sendai/）の設定とデータのテスト（ネットワーク不要）。

    python3 -m unittest discover -s tests
"""

import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_news  # noqa: E402

SENDAI = ROOT / "sendai"
NOW = datetime(2026, 10, 28, 3, 0, tzinfo=timezone.utc)


def item(title: str, url: str, hours: int = 1) -> dict:
    return {"title": title, "summary": "", "source": "テスト新聞", "url": url, "feed": "sample",
            "published": NOW - timedelta(hours=hours)}


class SendaiNewsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fetch_news.use_city("sendai")
        cls.places = fetch_news.load_places()
        cls.config = json.loads(fetch_news.SOURCES_FILE.read_text("utf-8"))

    @classmethod
    def tearDownClass(cls):
        fetch_news.use_city("")  # ほかのテストのため、さいたま市に戻す

    def test_files_point_to_sendai(self):
        self.assertEqual(fetch_news.OUTPUT_FILE, SENDAI / "data" / "news.json")
        self.assertEqual(fetch_news.TOPICS_FILE, SENDAI / "data" / "topics.json")

    def locate(self, text):
        p = fetch_news.locate(text, self.places)
        return p and p["name"]

    def test_same_named_places_elsewhere_are_ignored(self):
        # 横浜市の青葉区・泉区や相撲の宮城野部屋は、仙台市の地名として扱わない
        self.assertIsNone(self.locate("横浜市青葉区で火災"))
        self.assertIsNone(self.locate("横浜市泉区の公園"))
        self.assertIsNone(self.locate("宮城野部屋の力士が昇進"))
        self.assertEqual(self.locate("仙台市泉区で事故"), "泉区")

    def test_specific_place_wins(self):
        self.assertEqual(self.locate("泉中央駅前に新店"), "泉中央駅")
        self.assertEqual(self.locate("大崎八幡宮でどんと祭"), "大崎八幡宮")
        self.assertEqual(self.locate("楽天モバイル 最強パーク宮城で試合"), "楽天モバイル 最強パーク宮城")

    def test_area_beats_ward(self):
        # 区名より、その中の地域名（クマの出没が多い西部の地名など）を選ぶ
        self.assertEqual(self.locate("仙台市青葉区上愛子でクマ目撃"), "上愛子")
        self.assertEqual(self.locate("仙台市泉区根白石でクマ"), "根白石")

    def test_wildlife_category(self):
        cats = self.config["categories"]

        def cls(text):
            cat, kind = fetch_news.classify(text, "news", cats)
            return cat, kind and kind["label"]

        # 「警察署によると」があっても、事件ではなく害獣出没に入れる
        self.assertEqual(cls("仙台市青葉区でクマ出没 仙台北署によると"), ("wildlife", "クマ"))
        self.assertEqual(cls("泉区でイノシシが目撃される"), ("wildlife", "イノシシ"))
        self.assertEqual(cls("仙台・熊ヶ根でイノシシの食害"), ("wildlife", "イノシシ"))  # 「熊」ではない
        self.assertEqual(cls("太白区秋保でカモシカ目撃"), ("wildlife", "シカ・カモシカ"))
        # 動物の名前と似た語や、出没と関係のない記事は入れない
        self.assertEqual(cls("熊本で地震、仙台からも支援")[0], "news")
        self.assertEqual(cls("シカゴで仙台出身選手が活躍")[0], "news")
        self.assertEqual(cls("クマのぬいぐるみが人気 仙台")[0], "news")
        self.assertEqual(cls("仙台中央署 窃盗で男を逮捕")[0], "crime")

    def test_relevant_words_filter(self):
        raw = [item("仙台の新しい商業施設が開業", "https://example.com/1"),
               item("さいたま市で新店がオープン", "https://example.com/2")]
        news = fetch_news.build_news(raw, self.places, now=NOW, max_items=40, max_age_days=14,
                                     filters={"sample": True}, categories=self.config["categories"],
                                     relevant_words=self.config["relevantWords"])
        urls = {n["url"] for n in news}
        self.assertIn("https://example.com/1", urls)
        self.assertNotIn("https://example.com/2", urls)  # 仙台と関係ない
        city_wide = next(n for n in news if n["url"] == "https://example.com/1")
        self.assertEqual(city_wide["placeKind"], "city")  # 地名がなければ市役所付近に置く


class SendaiDataTest(unittest.TestCase):
    def test_topics_are_valid(self):
        data = json.loads((SENDAI / "data" / "topics.json").read_text("utf-8"))
        ids = {t["id"] for t in data["topics"]}
        self.assertIn("city-hall", ids)  # ニュースの「市全体」の置き場所
        wards = {w["name"] for w in data["wards"]}
        self.assertEqual(wards, {"青葉区", "宮城野区", "若林区", "太白区", "泉区"})
        for t in data["topics"]:
            self.assertIn(t["category"], data["categories"])
            self.assertTrue(38.1 < t["lat"] < 38.5 and 140.5 < t["lng"] < 141.1, t["id"])
            for r in t.get("related", []):
                self.assertIn(r, ids, t["id"])

    def test_livecams_are_valid(self):
        data = json.loads((SENDAI / "data" / "livecams.json").read_text("utf-8"))
        ids = [c["id"] for c in data["cameras"]]
        self.assertEqual(len(ids), len(set(ids)))
        for c in data["cameras"]:
            self.assertIn(c["type"], ("youtube", "image", "links", "link"))
            self.assertTrue(c["siteUrl"].startswith("https://"), c["id"])
            if c["type"] == "youtube":
                self.assertTrue(c["youtube"]["channelId"].startswith("UC"), c["id"])


if __name__ == "__main__":
    unittest.main()
