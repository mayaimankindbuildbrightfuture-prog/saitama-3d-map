"""scripts/fetch_news.py のテスト（ネットワーク不要）。

    python3 -m unittest discover -s tests
"""

import email.utils
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_news  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "google_news_sample.xml"
NOW = datetime(2026, 10, 28, 3, 0, tzinfo=timezone.utc)


def sample_feed() -> bytes:
    text = FIXTURE.read_text("utf-8")
    for i, hours in ((1, 2), (2, 5), (3, 30)):
        text = text.replace(f"__D{i}__", email.utils.format_datetime(NOW - timedelta(hours=hours)))
    return text.encode("utf-8")


class FetchNewsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.places = fetch_news.load_places()
        raw = fetch_news.parse_feed(sample_feed(), "sample")
        cls.raw = raw
        cls.news = fetch_news.build_news(raw, cls.places, now=NOW, max_items=40, max_age_days=14,
                                         filters={"sample": True})
        cls.by_url = {n["url"]: n for n in cls.news}

    def test_title_and_source_are_split(self):
        first = self.by_url["https://example.com/news/1"]
        self.assertEqual(first["title"], "【テスト】鉄道博物館で企画展が始まる")
        self.assertEqual(first["source"], "テスト新聞")
        self.assertEqual(first["summary"], "")  # 見出しの繰り返しだけの概要は捨てる

    def test_facility_beats_ward_and_area(self):
        self.assertEqual(self.by_url["https://example.com/news/1"]["place"], "鉄道博物館")
        # 「浦和区」「浦和」より具体的な「浦和駅」を選ぶ
        self.assertEqual(self.by_url["https://example.com/news/2"]["place"], "浦和駅")
        self.assertEqual(self.by_url["https://example.com/news/5"]["place"], "岩槻区")

    def test_unmatched_goes_to_city_wide(self):
        item = self.by_url["https://example.com/news/3"]
        self.assertEqual(item["placeKind"], "city")
        self.assertEqual(item["place"], "市全体")

    def test_duplicates_irrelevant_and_old_are_dropped(self):
        urls = set(self.by_url)
        self.assertNotIn("https://example.com/news/3b", urls)  # 同じ見出し
        self.assertNotIn("https://example.com/news/4", urls)   # さいたま市と無関係
        self.assertNotIn("https://example.com/news/6", urls)   # 古い
        self.assertEqual(len(self.news), 4)

    def test_sorted_newest_first_with_jst_dates(self):
        dates = [n["published"] for n in self.news]
        self.assertEqual(dates, sorted(dates, reverse=True))
        self.assertTrue(dates[0].endswith("+09:00"))

    def test_atom_feed(self):
        atom = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
<entry><title>\xe5\xa4\xa7\xe5\xae\xae\xe5\x85\xac\xe5\x9c\x92\xe3\x81\xae\xe6\xa1\x9c</title>
<link rel="alternate" href="https://example.com/a"/><updated>2026-10-27T10:00:00Z</updated>
<summary>&lt;p&gt;\xe8\xaa\xac\xe6\x98\x8e&lt;/p&gt;</summary></entry></feed>"""
        items = fetch_news.parse_feed(atom, "atom")
        self.assertEqual(items[0]["title"], "大宮公園の桜")
        self.assertEqual(items[0]["summary"], "説明")
        self.assertEqual(fetch_news.locate(items[0]["title"], self.places)["name"], "大宮公園")

    def test_same_place_items_are_spread(self):
        items = [{"lat": 35.9, "lng": 139.6} for _ in range(3)]
        fetch_news.spread(items)
        self.assertEqual(len({(i["lat"], i["lng"]) for i in items}), 3)


if __name__ == "__main__":
    unittest.main()
