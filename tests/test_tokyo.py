"""東京23区版（tokyo/）の設定とデータのテスト（ネットワーク不要）。

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

TOKYO = ROOT / "tokyo"
NOW = datetime(2026, 10, 28, 3, 0, tzinfo=timezone.utc)
WARDS = {"千代田区", "中央区", "港区", "新宿区", "文京区", "台東区", "墨田区", "江東区", "品川区", "目黒区", "大田区", "世田谷区",
         "渋谷区", "中野区", "杉並区", "豊島区", "北区", "荒川区", "板橋区", "練馬区", "足立区", "葛飾区", "江戸川区"}


class TokyoNewsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fetch_news.use_city("tokyo")
        cls.places = fetch_news.load_places()
        cls.config = json.loads(fetch_news.SOURCES_FILE.read_text("utf-8"))

    @classmethod
    def tearDownClass(cls):
        fetch_news.use_city("")  # ほかのテストのため、さいたま市に戻す

    def locate(self, text):
        p = fetch_news.locate(text, self.places)
        return p and p["name"]

    def test_same_named_wards_elsewhere_are_ignored(self):
        # 中央区・港区・北区はほかの市にもある。「東京都」などが付いたときだけ東京の区にする
        self.assertIsNone(self.locate("大阪市中央区で火災"))
        self.assertIsNone(self.locate("名古屋市港区の工場"))
        self.assertIsNone(self.locate("大阪市北区梅田のビル"))
        self.assertEqual(self.locate("東京都北区で事故"), "北区")
        self.assertEqual(self.locate("東京都港区六本木で事故"), "六本木")

    def test_other_cities_and_lines_are_ignored(self):
        self.assertIsNone(self.locate("岡山後楽園の紅葉"))
        self.assertIsNone(self.locate("川崎・等々力で試合"))
        self.assertIsNone(self.locate("大阪日本橋の電気街"))
        self.assertIsNone(self.locate("銀座線が運転見合わせ"))  # 路線名の「銀座」は地名にしない
        self.assertIsNone(self.locate("（京都）亀岡市大井町小金岐でクマ出没"))  # 京都府亀岡市の大井町
        self.assertEqual(self.locate("大井町駅前に新店"), "大井町駅")

    def test_specific_place_wins(self):
        self.assertEqual(self.locate("練馬区石神井公園でイベント"), "石神井公園駅")
        self.assertEqual(self.locate("浅草寺の雷門"), "浅草寺")
        self.assertEqual(self.locate("国立競技場で試合"), "国立競技場")

    def test_relevant_words_filter(self):
        raw = [{"title": "東京23区の新しい制度", "summary": "", "source": "テスト新聞", "url": "https://example.com/1",
                "feed": "sample", "published": NOW - timedelta(hours=1)},
               {"title": "都内のホテルで記者会見", "summary": "", "source": "テスト新聞", "url": "https://example.com/2",
                "feed": "sample", "published": NOW - timedelta(hours=1)}]
        news = fetch_news.build_news(raw, self.places, now=NOW, max_items=40, max_age_days=14,
                                     filters={"sample": True}, categories=self.config["categories"],
                                     relevant_words=self.config["relevantWords"])
        urls = {n["url"] for n in news}
        self.assertIn("https://example.com/1", urls)
        self.assertNotIn("https://example.com/2", urls)  # 「都内」だけでは23区の記事とみなさない

    def test_wildlife_category(self):
        cat, kind = fetch_news.classify("世田谷区でハクビシン目撃", "news", self.config["categories"])
        self.assertEqual((cat, kind["label"]), ("wildlife", "ハクビシン・アライグマ・タヌキ"))
        self.assertEqual(fetch_news.classify("熊谷で猛暑", "news", self.config["categories"])[0], "news")


class TokyoDataTest(unittest.TestCase):
    def test_topics_are_valid(self):
        data = json.loads((TOKYO / "data" / "topics.json").read_text("utf-8"))
        ids = {t["id"] for t in data["topics"]}
        self.assertIn("city-hall", ids)  # ニュースの「23区全体」の置き場所（東京都庁）
        self.assertEqual({w["name"] for w in data["wards"]}, WARDS)
        self.assertEqual({t["ward"] for t in data["topics"]}, WARDS)  # どの区にもトピックがある
        for t in data["topics"]:
            self.assertIn(t["category"], data["categories"])
            self.assertTrue(35.5 < t["lat"] < 35.85 and 139.55 < t["lng"] < 139.92, t["id"])
            for r in t.get("related", []):
                self.assertIn(r, ids, t["id"])

    def test_livecams_are_valid(self):
        data = json.loads((TOKYO / "data" / "livecams.json").read_text("utf-8"))
        ids = [c["id"] for c in data["cameras"]]
        self.assertEqual(len(ids), len(set(ids)))
        for c in data["cameras"]:
            self.assertIn(c["type"], ("youtube", "image", "links", "link"))
            self.assertIn(c["ward"], WARDS, c["id"])
            if c["type"] == "youtube":
                self.assertTrue(c["youtube"]["channelId"].startswith("UC"), c["id"])

    def test_city_config_has_all_wards(self):
        text = (TOKYO / "city.js").read_text("utf-8")
        for w in WARDS:
            self.assertIn(f"name: '{w}'", text)
        self.assertEqual(text.count("code: '131"), 23)


if __name__ == "__main__":
    unittest.main()
