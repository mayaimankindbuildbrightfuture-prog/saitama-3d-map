#!/usr/bin/env python3
"""さいたま市の最新ニュースを RSS から取得し、地名から位置を推定して data/news.json に書き出す。

標準ライブラリだけで動き、APIキーは不要。GitHub Actions（.github/workflows/update-news.yml）から
定期的に実行する想定。手元では次のように実行できる:

    python3 scripts/fetch_news.py            # 取得して data/news.json を更新
    python3 scripts/fetch_news.py --dry-run  # 書き込まずに結果を表示

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

# さいたま市に関係する記事かどうかの判定に使う語
RELEVANT_WORDS = ("さいたま", "大宮", "浦和", "岩槻", "与野", "見沼")

# 位置推定の優先度（大きいほど具体的）
KIND_RANK = {"facility": 3, "station": 2, "area": 1, "ward": 1}  # 地域名と区名は長い方（「岩槻」より「岩槻区」）を優先

# どの地名にも当てはまらない記事を置く場所
FALLBACK_PLACE_TOPIC = "city-hall"

ATOM_NS = "{http://www.w3.org/2005/Atom}"


# ---------- 取得・解析 ----------

def fetch(url: str, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


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

    return [clean_item(i) for i in items if i["title"] and i["url"]]


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

def load_places() -> list[dict]:
    topics = {t["id"]: t for t in json.loads(TOPICS_FILE.read_text("utf-8"))["topics"]}
    wards = {w["name"]: w for w in json.loads(TOPICS_FILE.read_text("utf-8"))["wards"]}
    places = []
    for p in json.loads(PLACES_FILE.read_text("utf-8"))["places"]:
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


def build_news(raw_items: list[dict], places: list[dict], *, now: datetime, max_items: int, max_age_days: int,
               filters: dict[str, bool], exclude_sources: list[str] = (), exclude_words: list[str] = (),
               similarity: float = 0.6, overlap: float = 0.7) -> list[dict]:
    cutoff = now - timedelta(days=max_age_days)
    kept_titles: list[tuple[str, set[str]]] = []
    news = []

    for item in sorted(raw_items, key=lambda i: i["published"] or now, reverse=True):
        text = f'{item["title"]} {item["summary"]}'
        located = locate(text, places)
        # さいたま市に関係する語も、辞書の地名も含まない記事は除く
        if filters.get(item["feed"], True) and located is None and not any(w in text for w in RELEVANT_WORDS):
            continue
        if item["published"] and item["published"] < cutoff:
            continue
        if is_excluded(item, exclude_sources, exclude_words):
            continue
        norm = normalize_title(item["title"])
        grams = bigrams(norm)
        if is_duplicate(norm, grams, kept_titles, similarity, overlap):
            continue
        kept_titles.append((norm, grams))

        place = place_info(located, places)
        published = item["published"].astimezone(JST).isoformat(timespec="minutes") if item["published"] else None
        news.append({
            "id": "news-" + hashlib.sha1(item["url"].encode("utf-8")).hexdigest()[:10],
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
        if len(news) >= max_items:
            break

    spread(news)
    return news


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="data/news.json を書き換えずに結果を表示する")
    ap.add_argument("--feed-file", action="append", default=[],
                    help="ネットワークの代わりにローカルのRSS/Atomファイルを読む（テスト用、複数指定可）")
    args = ap.parse_args(argv)

    config = json.loads(SOURCES_FILE.read_text("utf-8"))
    places = load_places()
    now = datetime.now(timezone.utc)

    raw, used, filters = [], [], {}
    feeds = [{"name": Path(f).name, "file": f, "filter": True} for f in args.feed_file] or config["sources"]
    for src in feeds:
        filters[src["name"]] = src.get("filter", True)
        try:
            data = Path(src["file"]).read_bytes() if "file" in src else fetch(src["url"])
            items = parse_feed(data, src["name"])
        except Exception as err:  # 1つのフィードの失敗で全体を止めない
            print(f"[warn] {src['name']}: {err}", file=sys.stderr)
            continue
        print(f"[info] {src['name']}: {len(items)}件", file=sys.stderr)
        raw.extend(items)
        used.append({"name": src["name"], "url": src.get("url", "")})

    if not raw:
        print("[warn] ニュースを1件も取得できなかったため、既存のファイルを残します。", file=sys.stderr)
        return 0 if OUTPUT_FILE.exists() else 1

    news = build_news(raw, places, now=now, max_items=config.get("maxItems", 40),
                      max_age_days=config.get("maxAgeDays", 14), filters=filters,
                      exclude_sources=config.get("excludeSources", []),
                      exclude_words=config.get("excludeWords", []),
                      similarity=config.get("duplicateSimilarity", 0.6),
                      overlap=config.get("duplicateOverlap", 0.7))
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
        print(f"[info] {OUTPUT_FILE.relative_to(ROOT)} に {len(news)} 件を書き出しました。", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
