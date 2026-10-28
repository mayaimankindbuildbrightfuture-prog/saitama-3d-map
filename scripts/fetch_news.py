#!/usr/bin/env python3
"""さいたま市（--city sendai なら仙台市）の最新ニュース・オタク関連・事件/防犯・グルメ・スーパーの特売・地域の口コミを RSS から取得し、地名から位置を推定して data/news.json に書き出す。

記事は scripts/news_sources.json の categories に書いたキーワードでカテゴリ（と、グルメのジャンルや
事件の種類などの細かい分類）に振り分ける。

標準ライブラリだけで動き、APIキーは不要。GitHub Actions（.github/workflows/update-news.yml）から
定期的に実行する想定。手元では次のように実行できる:

    python3 scripts/fetch_news.py            # 取得して data/news.json を更新
    python3 scripts/fetch_news.py --dry-run  # 書き込まずに結果を表示
    python3 scripts/fetch_news.py --city sendai  # 仙台市版（sendai/ 以下の設定とデータ）

どのフィードからも1件も取得できなかった場合は、既存の data/news.json を残したまま終了する。
"""

from __future__ import annotations

import argparse
import email.utils
import hashlib
import html
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES_FILE = ROOT / "scripts" / "news_sources.json"
PLACES_FILE = ROOT / "scripts" / "places.json"
TOPICS_FILE = ROOT / "data" / "topics.json"
OUTPUT_FILE = ROOT / "data" / "news.json"

JST = timezone(timedelta(hours=9))
USER_AGENT = "saitama-3d-map news fetcher (+https://github.com/)"

# 市に関係する記事かどうかの判定に使う語（news_sources.json の relevantWords で上書きできる）
RELEVANT_WORDS = ("さいたま", "大宮", "浦和", "岩槻", "与野", "見沼")


def use_city(city: str) -> None:
    """設定とデータの置き場所を、<リポジトリ>/<city>/ 以下に切り替える（例: sendai）。空ならさいたま市（リポジトリ直下）。"""
    global SOURCES_FILE, PLACES_FILE, TOPICS_FILE, OUTPUT_FILE
    base = ROOT / city if city else ROOT
    SOURCES_FILE = base / "scripts" / "news_sources.json"
    PLACES_FILE = base / "scripts" / "places.json"
    TOPICS_FILE = base / "data" / "topics.json"
    OUTPUT_FILE = base / "data" / "news.json"

# 位置推定の優先度（大きいほど具体的）
KIND_RANK = {"facility": 3, "station": 2, "area": 1, "ward": 1}  # 地域名と区名は長い方（「岩槻」より「岩槻区」）を優先

# どの地名にも当てはまらない記事を置く場所
FALLBACK_PLACE_TOPIC = "city-hall"

ATOM_NS = "{http://www.w3.org/2005/Atom}"

GOOGLE_NEWS_SEARCH = "https://news.google.com/rss/search?q={q}&hl=ja&gl=JP&ceid=JP%3Aja"


def source_url(src: dict) -> str:
    """取得元のURL。query だけなら Googleニュース検索、type=mastodon ならハッシュタグのRSSにする。"""
    if src.get("url"):
        return src["url"]
    if src.get("type") == "mastodon":
        # Mastodon のハッシュタグRSS（https://インスタンス/tags/タグ.rss）
        return f"https://{src['instance']}/tags/{urllib.parse.quote(src['tag'])}.rss"
    return GOOGLE_NEWS_SEARCH.format(q=urllib.parse.quote_plus(src["query"]))


# ---------- 取得・解析 ----------

def fetch(url: str, timeout: float = 20.0, body: dict | None = None) -> bytes:
    """URLを取得する。body を渡すと JSON を POST する（Misskey の API 用）。"""
    headers = {"User-Agent": USER_AGENT}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


# ---------- SNS（Bluesky・Misskey）の公開API ----------
# どちらも APIキー不要の公開エンドポイントを使う。仕様変更などで使えなくなっても、その取得元だけ失敗として飛ばす。

BLUESKY_SEARCH = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?{query}"


def bluesky_request(src: dict) -> tuple[str, dict | None]:
    query = urllib.parse.urlencode({"q": src["query"], "lang": "ja", "sort": "latest", "limit": src.get("limit", 50)})
    return BLUESKY_SEARCH.format(query=query), None


def parse_bluesky(data: bytes, source_name: str) -> list[dict]:
    items = []
    for post in json.loads(data).get("posts", []):
        record = post.get("record") or {}
        text = (record.get("text") or "").strip()
        handle = (post.get("author") or {}).get("handle", "")
        rkey = post.get("uri", "").rsplit("/", 1)[-1]
        if not text or not handle or not rkey:
            continue
        items.append({
            "title": "", "rawTitle": "", "summary": re.sub(r"\s+", " ", text),
            "url": f"https://bsky.app/profile/{handle}/post/{rkey}",
            "published": parse_date(record.get("createdAt") or post.get("indexedAt")),
            "source": "", "feed": source_name, "account": handle,
        })
    return items


def misskey_request(src: dict) -> tuple[str, dict]:
    return f"https://{src['instance']}/api/notes/search-by-tag", {"tag": src["tag"], "limit": src.get("limit", 50)}


def parse_misskey(data: bytes, source_name: str, instance: str) -> list[dict]:
    items = []
    for note in json.loads(data):
        user = note.get("user") or {}
        text = (note.get("text") or "").strip()
        # ボット、注意書き付き（CW）の投稿、本文の無いリノートは使わない
        if not text or note.get("cw") or user.get("isBot") or note.get("visibility") not in (None, "public"):
            continue
        items.append({
            "title": "", "rawTitle": "", "summary": re.sub(r"\s+", " ", text),
            "url": f"https://{instance}/notes/{note.get('id')}",
            "published": parse_date(note.get("createdAt")),
            "source": "", "feed": source_name,
            "account": f"{user.get('username', '')}@{user.get('host') or instance}",
        })
    return items


def expand_sources(sources: list[dict]) -> list[dict]:
    """複数のサーバー・タグ・検索語をまとめて書いた取得元を、1つずつに展開する。

    例: {"type": "mastodon", "instances": ["mstdn.jp"], "tags": ["大宮", "浦和"], "category": "reviews"}
    """
    out = []
    labels = {"mastodon": "Mastodon", "misskey": "Misskey", "bluesky": "Bluesky"}
    for src in sources:
        t = src.get("type")
        if t in ("mastodon", "misskey") and "instances" in src:
            for inst in src["instances"]:
                for tag in src["tags"]:
                    one = {k: v for k, v in src.items() if k not in ("instances", "tags")}
                    out.append({**one, "instance": inst, "tag": tag, "name": f"{labels[t]} #{tag}（{inst}）"})
        elif t == "bluesky" and "queries" in src:
            for q in src["queries"]:
                one = {k: v for k, v in src.items() if k != "queries"}
                out.append({**one, "query": q, "name": f"Bluesky「{q}」"})
        else:
            out.append(src)
    return out


def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(text).replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.strip()
    try:
        dt = email.utils.parsedate_to_datetime(value)  # RSS 2.0 (RFC 822)
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))  # Atom (ISO 8601)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def parse_feed(xml_bytes: bytes, source_name: str) -> list[dict]:
    """RSS 2.0 と Atom の両方に対応した簡易パーサー。"""
    root = ET.fromstring(xml_bytes)
    items = []

    for item in root.iter("item"):  # RSS 2.0
        src = item.find("source")
        items.append({
            "title": (item.findtext("title") or "").strip(),
            "url": (item.findtext("link") or "").strip(),
            "summary": strip_html(item.findtext("description") or ""),
            "published": parse_date(item.findtext("pubDate")),
            "source": (src.text or "").strip() if src is not None and src.text else "",
            "feed": source_name,
        })

    for entry in root.iter(f"{ATOM_NS}entry"):  # Atom
        link = entry.find(f"{ATOM_NS}link[@rel='alternate']")
        if link is None:
            link = entry.find(f"{ATOM_NS}link")
        items.append({
            "title": strip_html(entry.findtext(f"{ATOM_NS}title") or ""),
            "url": link.get("href", "").strip() if link is not None else "",
            "summary": strip_html(entry.findtext(f"{ATOM_NS}summary") or entry.findtext(f"{ATOM_NS}content") or ""),
            "published": parse_date(entry.findtext(f"{ATOM_NS}updated") or entry.findtext(f"{ATOM_NS}published")),
            "source": strip_html(entry.findtext(f"{ATOM_NS}author/{ATOM_NS}name") or ""),
            "feed": source_name,
        })

    for i in items:
        i["rawTitle"] = i["title"]
        # Mastodon の投稿などタイトルの無い項目は、本文の先頭を見出しにする
        if not i["title"] and i["summary"]:
            i["title"] = post_title(i["summary"])
    return [clean_item(i) for i in items if i["title"] and i["url"]]


# 自動で記事やブログを転載しているアカウントの名前に含まれやすい語
BOT_ACCOUNT_PATTERN = re.compile(r"rss|bot|feed|news|blog", re.IGNORECASE)


def clean_social_posts(items: list[dict]) -> list[dict]:
    """SNS（Mastodon）の投稿を口コミとして使える形にする。

    - サーバーによっては <title> に「ユーザー名@サーバー: 本文」が入るため、見出しは本文から作り直し、
      投稿者名は使わない
    - 記事やブログを自動転載するアカウント、リンクの紹介だけの投稿は除く
    """
    posts = []
    for it in items:
        if BOT_ACCOUNT_PATTERN.search(post_account(it)):
            continue
        body = it["summary"]
        if re.match(r"^(?:https?://|[\w.\-]+\.(?:com|net|org|jp|io|info)/)", body):  # リンクで始まる転載
            continue
        words = re.sub(r"#\S+", "", remove_urls(body)).strip()
        if len(words) < 8:
            continue
        posts.append({**it, "summary": remove_urls(body), "title": post_title(body), "source": it["feed"]})
    return posts


def post_account(item: dict) -> str:
    """投稿のアカウント（ユーザー名@サーバー）。<title> の「名前@サーバー:」か、投稿URLの /@名前 から取る。"""
    if item.get("account"):
        return item["account"]
    m = re.match(r"^\s*([\w.\-]+@[\w.\-]+)\s*:", item.get("rawTitle", ""))
    if m:
        return m.group(1)
    m = re.match(r"^https?://([^/]+)/@([\w.\-]+)", item.get("url", ""))
    return f"{m.group(2)}@{m.group(1)}" if m else ""


# Mastodon は長いURLを表示用のタグで分けるため、HTMLを外すと「https:// example.com/…」のように空白が入る
URL_PATTERN = re.compile(r"https?://\s*(?:www\.\s*)?\S+|\b(?:www\.)?[\w\-]+(?:\.[\w\-]+)*\.(?:com|net|org|jp|io|info)/\S*")


def remove_urls(text: str) -> str:
    return re.sub(r"\s{2,}", " ", URL_PATTERN.sub("", text)).strip()


def post_title(text: str, length: int = 60) -> str:
    """SNS投稿の本文から見出しを作る（末尾のハッシュタグの並びとURLを除く）。"""
    text = remove_urls(text)
    text = re.sub(r"(\s*#\S+)+\s*$", "", text).strip() or text.strip()
    return text if len(text) <= length else text[:length - 1] + "…"


def clean_item(item: dict) -> dict:
    title, source = item["title"], item["source"]
    # Googleニュースの見出しは「見出し - 媒体名」の形なので媒体名を切り離す
    m = re.match(r"^(.*\S)\s+-\s+([^-]{1,40})$", title)
    if m and (not source or m.group(2).strip() == source):
        title, source = m.group(1), m.group(2).strip()
    title = strip_title_suffix(title)
    summary = item["summary"]
    # 概要が見出し（＋媒体名）の繰り返しだけなら捨てる
    if summary and (summary.startswith(title) or title.startswith(summary)) and len(summary) <= len(title) + len(source) + 4:
        summary = ""
    return {**item, "title": title, "source": source or item["feed"], "summary": summary[:200]}


def strip_title_suffix(title: str) -> str:
    """見出しの末尾に付く媒体名やサイト名を取り除く。

    例: 「見出し（埼玉新聞）」「見出し (埼玉新聞)」「見出し｜埼玉新聞｜埼玉の最新ニュース」
    """
    # 「｜」「 | 」以降はサイト名であることが多い（前半が十分長い場合のみ切る）
    m = re.match(r"^(.{12,}?)\s*(?:｜| \| ).*$", title)
    if m:
        title = m.group(1)
    # 末尾の（媒体名）。中身が短いものだけを対象にし、本文の一部の括弧は残す
    title = re.sub(r"\s*[（(][^（）()]{1,20}[）)]$", "", title)
    return title.strip()


# ---------- 位置推定 ----------

# 地名と同じ文字を含むが地名ではない語（人名など）。scripts/places.json の ignoreWords から読み込む
PLACE_IGNORE_WORDS: list[str] = []


def strip_place_ignore_words(text: str) -> str:
    for w in PLACE_IGNORE_WORDS:
        text = text.replace(w, "")
    return text


def load_places() -> list[dict]:
    config = json.loads(PLACES_FILE.read_text("utf-8"))
    PLACE_IGNORE_WORDS[:] = config.get("ignoreWords", [])
    topics = {t["id"]: t for t in json.loads(TOPICS_FILE.read_text("utf-8"))["topics"]}
    wards = {w["name"]: w for w in json.loads(TOPICS_FILE.read_text("utf-8"))["wards"]}
    places = []
    for p in config["places"]:
        p = dict(p)
        if "topic" in p:
            t = topics[p["topic"]]
            p.setdefault("lat", t["lat"])
            p.setdefault("lng", t["lng"])
            p.setdefault("ward", t["ward"])
        elif p.get("kind") == "ward":
            w = wards[p["ward"]]
            p["lat"], p["lng"] = w["lat"], w["lng"]
        places.append(p)
    return places


def locate(text: str, places: list[dict]) -> dict | None:
    """本文中の地名のうち、最も具体的（同じ種類なら最も長い）ものを選ぶ。"""
    text = strip_place_ignore_words(text)
    best, best_key = None, None
    for p in places:
        for alias in p["aliases"]:
            if alias in text:
                key = (KIND_RANK.get(p["kind"], 0), len(alias))
                if best_key is None or key > best_key:
                    best, best_key = {**p, "matched": alias}, key
    return best


def place_info(place: dict | None, places: list[dict]) -> dict:
    if place is None:
        hall = next(p for p in places if p.get("topic") == FALLBACK_PLACE_TOPIC)
        return {
            "name": "市全体",
            "kind": "city",
            "matched": "",
            "lat": hall["lat"],
            "lng": hall["lng"],
            "ward": "",
        }
    return {k: place.get(k, "") for k in ("name", "kind", "matched", "lat", "lng", "ward")}


def spread(items: list[dict]) -> None:
    """同じ地点に複数の記事があるとき、吹き出しが完全に重ならないよう少しずつずらす。"""
    seen: dict[tuple, int] = {}
    for item in items:
        key = (item["lat"], item["lng"])
        n = seen.get(key, 0)
        seen[key] = n + 1
        if n:
            # 黄金角で渦巻き状に配置（1件あたり約40〜60m）
            angle = n * 2.39996
            r = 0.00045 * math.sqrt(n)
            item["lat"] = round(item["lat"] + r * math.cos(angle), 6)
            item["lng"] = round(item["lng"] + r * math.sin(angle) * 1.23, 6)


# ---------- まとめ ----------

def normalize_title(title: str) -> str:
    return re.sub(r"[\s　「」『』【】、。！!？?・…,，.．:：;；\-ー〜~／/]", "", title).lower()


def bigrams(text: str) -> set[str]:
    return {text[i:i + 2] for i in range(len(text) - 1)}


def is_duplicate(norm: str, grams: set[str], kept: list[tuple[str, set[str]]], threshold: float,
                 overlap: float = 0.7) -> bool:
    """次のどれかに当てはまれば重複とみなす。

    - 同じ見出し、または片方がもう片方の先頭部分
    - 文字の2文字組の Dice 係数が threshold 以上（言い回しがほぼ同じ）
    - 短い方の見出しの2文字組のうち overlap 以上がもう片方に含まれる（同じ出来事を別の媒体が報じた場合など）
    """
    for other, other_grams in kept:
        if norm == other:
            return True
        short, long_ = sorted((norm, other), key=len)
        if len(short) >= 15 and long_.startswith(short):
            return True
        if grams and other_grams:
            common = len(grams & other_grams)
            if 2 * common / (len(grams) + len(other_grams)) >= threshold:
                return True
            if min(len(grams), len(other_grams)) >= 10 and common / min(len(grams), len(other_grams)) >= overlap:
                return True
    return False


def is_excluded(item: dict, exclude_sources: list[str], exclude_words: list[str]) -> bool:
    if any(src and src in item["source"] for src in exclude_sources):
        return True
    text = f'{item["title"]} {item["summary"]}'
    return any(w and w in text for w in exclude_words)


# ---------- カテゴリ分け ----------

def classify(text: str, feed_category: str, categories: dict) -> tuple[str, dict | None]:
    """記事のカテゴリと細かい分類（types）を決める。

    キーワードを持つカテゴリを categories に書かれた順に調べ、最初に当てはまったものにする。
    どれにも当てはまらなければ一般の「news」。オタク・グルメなど専用の検索で拾った記事でも、
    そのカテゴリのキーワードを含まなければ一般ニュース扱いにする（検索結果には関係の薄い記事も混ざるため）。
    """
    # 口コミのように「どこから取ったか」で決まるカテゴリは、キーワードより優先する
    if categories.get(feed_category, {}).get("keepFeedCategory"):
        return feed_category, classify_type(text, categories[feed_category])
    for cat_id, cat in categories.items():
        if cat.get("keepFeedCategory"):
            continue
        if matches_category(text, cat):
            return cat_id, classify_type(text, cat)
    if feed_category in categories and not has_keywords(categories[feed_category]):
        return feed_category, classify_type(text, categories[feed_category])
    return "news", None


def has_keywords(cat: dict) -> bool:
    return bool(cat.get("keywords") or cat.get("keywordGroups"))


def matches_category(text: str, cat: dict) -> bool:
    """keywords のどれかを含む、または keywordGroups の各グループから1語ずつ含めば当てはまる。

    ignoreWords の語（例: 「スーパーアリーナ」）は、判定の前に本文から取り除く。
    notWords の語（例: グルメの「給食」）を含む場合は、そのカテゴリには入れない。
    """
    for w in cat.get("ignoreWords", []):
        text = text.replace(w, "")
    if any(w in text for w in cat.get("notWords", [])):
        return False
    keywords = cat.get("keywords") or []
    if keywords and any(k in text for k in keywords):
        return True
    groups = cat.get("keywordGroups") or []
    return bool(groups) and all(any(k in text for k in g) for g in groups)


def classify_type(text: str, cat: dict) -> dict | None:
    types = cat.get("types") or []
    if not types:
        return None
    for t in types:
        if any(k in text for k in t.get("keywords", [])):
            return t
    return cat.get("otherType", {"id": "other", "label": "その他"})


def service_of(item: dict) -> str:
    """取得元の名前からサービス名を取り出す（例: 「Bluesky「大宮駅」」→ Bluesky、「Mastodon #浦和（mstdn.jp）」→ Mastodon）。"""
    return re.split(r"[\s「#（]", item.get("feed", ""), maxsplit=1)[0]


def build_news(raw_items: list[dict], places: list[dict], *, now: datetime, max_items: int, max_age_days: int,
               filters: dict[str, bool], exclude_sources: list[str] = (), exclude_words: list[str] = (),
               similarity: float = 0.6, overlap: float = 0.7, categories: dict | None = None,
               relevant_words: tuple[str, ...] | list[str] = RELEVANT_WORDS) -> list[dict]:
    """取得した記事を絞り込み・重複除去・カテゴリ分けして、新しい順に並べる。

    max_items / max_age_days は、categories で個別に指定していないカテゴリに使う。
    """
    categories = categories or {}
    kept_titles: list[tuple[str, set[str]]] = []
    counts: dict[str, int] = {}
    service_counts: dict[tuple[str, str], int] = {}
    news = []

    def limit(cat_id: str, key: str, default):
        return categories.get(cat_id, {}).get(key, default)

    for item in sorted(raw_items, key=lambda i: i["published"] or now, reverse=True):
        text = f'{item["title"]} {item["summary"]}'
        located = locate(text, places)
        # 市に関係する語も、辞書の地名も含まない記事は除く
        if (filters.get(item["feed"], True) and located is None
                and not any(w in strip_place_ignore_words(text) for w in relevant_words)):
            continue
        if is_excluded(item, exclude_sources, exclude_words):
            continue
        cat_id, kind = classify(text, item.get("feedCategory", "news"), categories)
        if any(w in text for w in limit(cat_id, "excludeWords", [])):
            continue
        if item["published"] and item["published"] < now - timedelta(days=limit(cat_id, "maxAgeDays", max_age_days)):
            continue
        if counts.get(cat_id, 0) >= limit(cat_id, "maxItems", max_items):
            continue
        # 口コミなどは、新しい投稿の多いSNSだけで埋まらないよう、サービスごとの上限を設ける
        service = service_of(item)
        per_service = limit(cat_id, "maxPerService", None)
        if per_service and service_counts.get((cat_id, service), 0) >= per_service:
            continue
        norm = normalize_title(item["title"])
        grams = bigrams(norm)
        if is_duplicate(norm, grams, kept_titles, similarity, overlap):
            continue
        kept_titles.append((norm, grams))
        counts[cat_id] = counts.get(cat_id, 0) + 1
        service_counts[(cat_id, service)] = service_counts.get((cat_id, service), 0) + 1

        place = place_info(located, places)
        published = item["published"].astimezone(JST).isoformat(timespec="minutes") if item["published"] else None
        news.append({
            "id": "news-" + hashlib.sha1(item["url"].encode("utf-8")).hexdigest()[:10],
            "category": cat_id,
            "type": kind["id"] if kind else "",
            "typeLabel": kind["label"] if kind else "",
            "typeIcon": kind.get("icon", "") if kind else "",
            "title": item["title"],
            "summary": item["summary"],
            "source": item["source"],
            "url": item["url"],
            "published": published,
            "place": place["name"],
            "placeKind": place["kind"],
            "matched": place["matched"],
            "ward": place["ward"],
            "lat": place["lat"],
            "lng": place["lng"],
        })

    spread(news)
    return news


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="data/news.json を書き換えずに結果を表示する")
    ap.add_argument("--feed-file", action="append", default=[],
                    help="ネットワークの代わりにローカルのRSS/Atomファイルを読む（テスト用、複数指定可）")
    ap.add_argument("--city", default="", help="市のフォルダ（例: sendai）。省略するとさいたま市")
    args = ap.parse_args(argv)
    use_city(args.city)

    config = json.loads(SOURCES_FILE.read_text("utf-8"))
    places = load_places()
    now = datetime.now(timezone.utc)

    raw, used, filters = [], [], {}
    feeds = ([{"name": Path(f).name, "file": f, "filter": True} for f in args.feed_file]
             or expand_sources(config["sources"]))
    for i, src in enumerate(feeds):
        filters[src["name"]] = src.get("filter", True)
        kind = src.get("type")
        try:
            if "file" in src:
                data = Path(src["file"]).read_bytes()
            else:
                if i:
                    # 取得元に負担をかけないよう間隔をあける（Misskey は短い間隔だと 429 を返すので長めに）
                    time.sleep(3 if kind == "misskey" else 1)
                if kind in ("bluesky", "misskey"):
                    url, body = (bluesky_request if kind == "bluesky" else misskey_request)(src)
                    data = fetch(url, body=body)
                else:
                    data = fetch(source_url(src))
            if kind == "bluesky":
                items = parse_bluesky(data, src["name"])
            elif kind == "misskey":
                items = parse_misskey(data, src["name"], src["instance"])
            else:
                items = parse_feed(data, src["name"])
            if kind in ("mastodon", "bluesky", "misskey"):
                items = clean_social_posts(items)
        except Exception as err:  # 1つのフィードの失敗で全体を止めない
            print(f"[warn] {src['name']}: {err}", file=sys.stderr)
            continue
        print(f"[info] {src['name']}: {len(items)}件", file=sys.stderr)
        for it in items:
            it["feedCategory"] = src.get("category", "news")
        raw.extend(items)
        used.append({"name": src["name"], "category": src.get("category", "news"),
                     "url": source_url(src) if "file" not in src and kind not in ("bluesky", "misskey") else ""})

    if not raw:
        print("[warn] ニュースを1件も取得できなかったため、既存のファイルを残します。", file=sys.stderr)
        return 0 if OUTPUT_FILE.exists() else 1

    news = build_news(raw, places, now=now, max_items=config.get("maxItems", 40),
                      max_age_days=config.get("maxAgeDays", 14), filters=filters,
                      exclude_sources=config.get("excludeSources", []),
                      exclude_words=config.get("excludeWords", []),
                      similarity=config.get("duplicateSimilarity", 0.6),
                      overlap=config.get("duplicateOverlap", 0.7),
                      categories=config.get("categories"),
                      relevant_words=config.get("relevantWords", RELEVANT_WORDS))
    out = {
        "generatedAt": now.astimezone(JST).isoformat(timespec="minutes"),
        "sources": used,
        "items": news,
    }
    text = json.dumps(out, ensure_ascii=False, indent=2) + "\n"
    if args.dry_run:
        print(text)
    else:
        OUTPUT_FILE.write_text(text, "utf-8")
        per_cat: dict[str, int] = {}
        for n in news:
            per_cat[n["category"]] = per_cat.get(n["category"], 0) + 1
        print(f"[info] {OUTPUT_FILE.relative_to(ROOT)} に {len(news)} 件を書き出しました: {per_cat}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
