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

    def test_title_suffix_is_stripped(self):
        strip = fetch_news.strip_title_suffix
        self.assertEqual(strip("さいたま市で新しい図書館が開館（テスト新聞）"), "さいたま市で新しい図書館が開館")
        self.assertEqual(strip("さいたま市で新しい図書館が開館 (テスト新聞)"), "さいたま市で新しい図書館が開館")
        self.assertEqual(strip("さいたま市で新しい図書館が開館｜テスト新聞｜最新ニュース"), "さいたま市で新しい図書館が開館")
        # 見出しの一部の括弧や、短すぎる前半は残す
        self.assertEqual(strip("男性（70）が見つかる さいたま市"), "男性（70）が見つかる さいたま市")
        self.assertEqual(strip("短い｜見出し"), "短い｜見出し")

    def _build(self, items, **kw):
        raw = [fetch_news.clean_item({"title": t, "url": f"https://example.com/d/{i}", "summary": "",
                                      "published": NOW - timedelta(hours=i), "source": src, "feed": "f"})
               for i, (t, src) in enumerate(items)]
        return fetch_news.build_news(raw, self.places, now=NOW, max_items=40, max_age_days=14,
                                     filters={"f": True}, **kw)

    def test_near_duplicates_are_merged(self):
        news = self._build([
            ("さいたま市の小学校で給食に異物混入 原因を調査（テスト新聞）", "ポータル"),
            ("さいたま市の小学校で給食に異物混入 原因を調査 (テスト新聞)", "ポータル"),
            ("さいたま市の小学校で給食に異物混入 原因を調査｜テスト新聞｜地域の話題", "テスト新聞"),
            ("さいたま市の同じ小学校で給食に異物混入", "別の放送局"),
            ("さいたま市で秋の花火大会 来月開催", "テスト新聞"),
        ])
        self.assertEqual([n["title"] for n in news],
                         ["さいたま市の小学校で給食に異物混入 原因を調査", "さいたま市で秋の花火大会 来月開催"])

    def test_similar_but_different_news_are_kept(self):
        news = self._build([
            ("【さいたま市大宮区】氷川参道の歩行者専用区間が拡大", "テスト"),
            ("【さいたま市大宮区】駅前に新しいカフェがオープン", "テスト"),
        ])
        self.assertEqual(len(news), 2)

    def test_excluded_sources_and_words(self):
        news = self._build([
            ("イオンシネマ大宮(さいたま) の上映時間・上映スケジュール", "映画サイト"),
            ("【さいたま市南区】あすの天気予報", "テスト"),
            ("さいたま市で秋の花火大会 来月開催", "まとめ動画"),
            ("さいたま市で新しい図書館が開館", "テスト新聞"),
        ], exclude_sources=["まとめ動画"], exclude_words=["上映時間", "天気予報"])
        self.assertEqual([n["title"] for n in news], ["さいたま市で新しい図書館が開館"])

    def test_categories_and_types(self):
        import json
        categories = json.loads((ROOT / "scripts" / "news_sources.json").read_text("utf-8"))["categories"]
        cases = [
            ("大宮駅前に新しいカレー専門店がオープン", "gourmet", "curry"),
            ("浦和の町中華が移転", "gourmet", "chinese"),
            ("さいたま新都心で焼肉食べ放題フェア", "gourmet", "buffet"),  # 焼肉より食べ放題を優先
            ("岩槻の手打ちそば店", "gourmet", "japanese"),
            ("大宮でつけ麺の新店", "gourmet", "ramen"),
            ("さいたまスーパーアリーナで声優ライブ", "otaku", "vtuber"),
            ("東大宮にアニメのコラボカフェ", "otaku", "anime"),  # コラボカフェでもグルメではなくオタク
            ("浦和区で特殊詐欺の被害 埼玉県警が注意", "crime", "fraud"),
            ("飲食店で強盗 男を逮捕 さいたま市", "crime", "violent"),  # グルメ語を含んでも事件を優先
            ("見沼区で不審者の声かけ", "crime", "suspicious"),
            ("さいたま市で秋のまつり", "news", ""),
        ]
        for text, cat, typ in cases:
            got_cat, kind = fetch_news.classify(text, "news", categories)
            self.assertEqual((got_cat, kind["id"] if kind else ""), (cat, typ), text)

    def test_category_limits(self):
        categories = {"crime": {"keywords": ["逮捕"], "maxItems": 1}, "news": {"maxItems": 5}}
        raw = [fetch_news.clean_item({"title": t, "url": f"https://example.com/l/{i}", "summary": "",
                                      "published": NOW - timedelta(hours=i), "source": "テスト", "feed": "f"})
               for i, t in enumerate(["さいたま市で男を逮捕", "浦和区で女を逮捕", "大宮で祭り"])]
        news = fetch_news.build_news(raw, self.places, now=NOW, max_items=40, max_age_days=14,
                                     filters={"f": True}, categories=categories)
        self.assertEqual([(n["category"], n["title"]) for n in news],
                         [("crime", "さいたま市で男を逮捕"), ("news", "大宮で祭り")])

    def test_mastodon_post_and_reviews(self):
        import json
        config = json.loads((ROOT / "scripts" / "news_sources.json").read_text("utf-8"))
        rss = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>#さいたま</title>
<item><guid>https://mstdn.example/@a/1</guid><link>https://mstdn.example/@a/1</link>
<pubDate>__D__</pubDate>
<description>&lt;p&gt;大宮駅の近くの新しいラーメン屋さん、美味しかった！ https://example.com/x &lt;a href="https://mstdn.example/tags/さいたま"&gt;#さいたま&lt;/a&gt;&lt;/p&gt;</description></item>
<item><guid>https://mstdn.example/@b/2</guid><link>https://mstdn.example/@b/2</link>
<pubDate>__D__</pubDate>
<description>&lt;p&gt;浦和はクソみたいな街 #浦和&lt;/p&gt;</description></item>
</channel></rss>""".replace("__D__", email.utils.format_datetime(NOW - timedelta(hours=1)))
        raw = fetch_news.parse_feed(rss.encode("utf-8"), "Mastodon #さいたま")
        self.assertEqual(raw[0]["title"], "大宮駅の近くの新しいラーメン屋さん、美味しかった！")
        for r in raw:
            r["feedCategory"] = "reviews"
        news = fetch_news.build_news(raw, self.places, now=NOW, max_items=40, max_age_days=14,
                                     filters={"Mastodon #さいたま": True}, categories=config["categories"])
        # 「ラーメン」を含んでもグルメ記事ではなく口コミのまま。不適切な語を含む投稿は除く
        self.assertEqual([(n["category"], n["type"], n["place"]) for n in news], [("reviews", "food", "大宮駅")])
        self.assertEqual(news[0]["source"], "Mastodon #さいたま")

    def test_supermarket(self):
        import json
        categories = json.loads((ROOT / "scripts" / "news_sources.json").read_text("utf-8"))["categories"]
        cases = [
            ("ヤオコー大宮店で特売セール", "supermarket", "sale"),
            ("浦和にロピアがオープン", "supermarket", "opening"),
            ("さいたま市のスーパーが閉店セール", "supermarket", "closing"),
            ("さいたまスーパーアリーナでセール開催", "news", ""),  # スーパーアリーナはスーパーではない
            ("業務スーパーの新店でカレーが人気", "supermarket", "opening"),  # グルメより先に判定
        ]
        for text, cat, typ in cases:
            got_cat, kind = fetch_news.classify(text, "news", categories)
            self.assertEqual((got_cat, kind["id"] if kind else ""), (cat, typ), text)

    def test_mastodon_url(self):
        url = fetch_news.source_url({"type": "mastodon", "instance": "mstdn.jp", "tag": "さいたま"})
        self.assertEqual(url, "https://mstdn.jp/tags/%E3%81%95%E3%81%84%E3%81%9F%E3%81%BE.rss")

    def test_social_posts_are_cleaned(self):
        def post(title, body, url):
            return {"title": title, "rawTitle": title, "summary": body, "url": url,
                    "published": NOW, "source": "", "feed": "Mastodon #さいたま"}
        items = [
            # <title> に投稿者名が入るサーバー: 名前は使わず本文から見出しを作る
            post("someone@pixel.example: “<p>見沼田んぼ", "見沼田んぼの夕焼けがきれいだった #さいたま", "https://pixel.example/p/someone/1"),
            # 記事を自動転載するアカウント（サーバー名・アカウント名で判定）
            post("", "浦和が3得点で勝利 https:// blog.example.jp/archives/1", "https://rss-mstdn.example/@blog_soccer/2"),
            post("", "大宮で新店オープン https://example.com/x", "https://social.example/@news/3"),
            # リンクで始まる転載・リンクとハッシュタグだけの投稿
            post("", "https://www. wacoca.example.com/news/1/ 聴き逃し配信", "https://social.example/@alice/4"),
            post("", "https://example.com/a #さいたま #大宮", "https://social.example/@bob/5"),
        ]
        posts = fetch_news.clean_social_posts(items)
        self.assertEqual([p["title"] for p in posts], ["見沼田んぼの夕焼けがきれいだった"])
        self.assertEqual(posts[0]["source"], "Mastodon #さいたま")
        self.assertEqual(fetch_news.remove_urls("駅前 https:// blog.example.jp/a/b すごい"), "駅前 すごい")

    def test_not_words_and_place_ignore_words(self):
        import json
        categories = json.loads((ROOT / "scripts" / "news_sources.json").read_text("utf-8"))["categories"]
        self.assertEqual(fetch_news.classify("給食に異物混入 パスタから金属 さいたま市", "news", categories)[0], "news")
        self.assertEqual(fetch_news.classify("大宮で選挙関係のランチ会", "news", categories)[0], "news")
        # 人名の「浦和希」は地名「浦和」として扱わない
        self.assertIsNone(fetch_news.locate("声優・浦和希さんがイベントに出演", self.places))
        self.assertEqual(fetch_news.locate("浦和希さんが浦和駅でイベント", self.places)["name"], "浦和駅")

    def test_bluesky_and_misskey(self):
        import json
        bsky = json.dumps({"posts": [
            {"uri": "at://did:plc:abc/app.bsky.feed.post/3kxyz", "author": {"handle": "taro.bsky.social"},
             "record": {"text": "浦和駅の西口、\n夜はきれい", "createdAt": "2026-10-27T10:00:00.000Z"}},
            {"uri": "at://did:plc:def/app.bsky.feed.post/3kabc", "author": {"handle": "saitama-news-bot.bsky.social"},
             "record": {"text": "さいたま市で新店オープン https://example.com/a", "createdAt": "2026-10-27T10:00:00.000Z"}},
        ]}).encode("utf-8")
        posts = fetch_news.clean_social_posts(fetch_news.parse_bluesky(bsky, "Bluesky「浦和駅」"))
        self.assertEqual([(p["title"], p["url"]) for p in posts],
                         [("浦和駅の西口、 夜はきれい", "https://bsky.app/profile/taro.bsky.social/post/3kxyz")])

        notes = json.dumps([
            {"id": "a1", "text": "大宮公園の紅葉がきれい #さいたま", "createdAt": "2026-10-27T10:00:00.000Z",
             "visibility": "public", "user": {"username": "hanako", "host": None, "isBot": False}},
            {"id": "a2", "text": "定期投稿です #さいたま", "createdAt": "2026-10-27T10:00:00.000Z",
             "visibility": "public", "user": {"username": "x", "host": None, "isBot": True}},
            {"id": "a3", "text": "ネタバレ注意", "cw": "ネタバレ", "createdAt": "2026-10-27T10:00:00.000Z",
             "visibility": "public", "user": {"username": "y", "host": None, "isBot": False}},
            {"id": "a4", "text": None, "renoteId": "zz", "createdAt": "2026-10-27T10:00:00.000Z",
             "visibility": "public", "user": {"username": "z", "host": None, "isBot": False}},
        ]).encode("utf-8")
        posts = fetch_news.clean_social_posts(fetch_news.parse_misskey(notes, "Misskey #さいたま", "misskey.io"))
        self.assertEqual([(p["title"], p["url"]) for p in posts], [("大宮公園の紅葉がきれい", "https://misskey.io/notes/a1")])

    def test_expand_sources(self):
        srcs = fetch_news.expand_sources([
            {"type": "mastodon", "instances": ["a.example", "b.example"], "tags": ["大宮", "浦和"], "category": "reviews"},
            {"type": "bluesky", "queries": ["岩槻"], "category": "reviews"},
            {"name": "x", "query": "さいたま"},
        ])
        self.assertEqual([s["name"] for s in srcs],
                         ["Mastodon #大宮（a.example）", "Mastodon #浦和（a.example）", "Mastodon #大宮（b.example）",
                          "Mastodon #浦和（b.example）", "Bluesky「岩槻」", "x"])
        self.assertEqual(srcs[0]["category"], "reviews")

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
