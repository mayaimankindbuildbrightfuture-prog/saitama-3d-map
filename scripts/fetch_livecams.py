#!/usr/bin/env python3
"""data/livecams.json の YouTube のライブカメラについて、今配信中の動画を調べて書き込む。

YouTube のライブ配信は配信ごとに動画IDが変わるため、チャンネルの配信一覧（/streams）から
「ライブ」の印が付いた動画を探し、その動画IDを videoId に、配信中なら live=true にする。
同じチャンネルが別の場所のカメラも配信していることがあるため、titleKeywords を書いたカメラは
その語を含むタイトルの配信だけを使う。さらに oEmbed で、ほかのサイトへの埋め込みが許可されているか
（embeddable）も確かめる。APIキーは使わず、YouTube の公開ページから読み取る。
読み取れなかったカメラは前回の値を残す。

    python3 scripts/fetch_livecams.py            # 調べて data/livecams.json を更新
    python3 scripts/fetch_livecams.py --dry-run  # 書き込まずに結果を表示
    python3 scripts/fetch_livecams.py --city sendai  # 仙台市版（sendai/data/livecams.json）
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAMS_FILE = ROOT / "data" / "livecams.json"
JST = timezone(timedelta(hours=9))
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "ja,en;q=0.8",
}

CHANNEL_ID_PATTERNS = [
    re.compile(r'<meta itemprop="identifier" content="(UC[\w-]{22})"'),
    re.compile(r'"externalId":"(UC[\w-]{22})"'),
    re.compile(r'"channelId":"(UC[\w-]{22})"'),
    re.compile(r'youtube\.com/channel/(UC[\w-]{22})'),
]
INITIAL_DATA = re.compile(r"ytInitialData\s*=\s*(\{.*?\});\s*</script>", re.S)


def fetch_text(url: str, timeout: float = 20.0) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", "replace")


def find_channel_id(html: str) -> str | None:
    for pat in CHANNEL_ID_PATTERNS:
        m = pat.search(html)
        if m:
            return m.group(1)
    return None


def parse_streams(html: str) -> list[dict]:
    """チャンネルの配信一覧（/streams）のHTMLから、動画ID・タイトル・ライブ中かどうかを読み取る。

    YouTube の一覧は lockupViewModel という形で、サムネイルの印（thumbnailBadgeViewModel）が
    ライブ中なら THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE になる。
    """
    m = INITIAL_DATA.search(html)
    if not m:
        return []
    videos = []

    def badges_of(node, out):
        if isinstance(node, dict):
            if "thumbnailBadgeViewModel" in node:
                out.append(node["thumbnailBadgeViewModel"].get("badgeStyle", ""))
            for v in node.values():
                badges_of(v, out)
        elif isinstance(node, list):
            for v in node:
                badges_of(v, out)

    def walk(node):
        if isinstance(node, dict):
            lockup = node.get("lockupViewModel")
            if isinstance(lockup, dict) and lockup.get("contentId"):
                badges = []
                badges_of(lockup.get("contentImage", {}), badges)
                title = (lockup.get("metadata", {}).get("lockupMetadataViewModel", {})
                         .get("title", {}).get("content", ""))
                videos.append({"videoId": lockup["contentId"], "title": title,
                               "live": any(b.endswith("_LIVE") for b in badges)})
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(json.loads(m.group(1)))
    return videos


def pick_live(videos: list[dict], keywords: list[str]) -> dict | None:
    for v in videos:
        if v["live"] and (not keywords or any(k in v["title"] for k in keywords)):
            return v
    return None


def is_embeddable(video_id: str, get=None) -> bool | None:
    """oEmbed が 200 なら埋め込み可、401/403 なら不可。分からなければ None。"""
    url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
    try:
        (get or fetch_text)(url)
        return True
    except urllib.error.HTTPError as err:
        return False if err.code in (401, 403) else None
    except Exception:
        return None


def resolve_channel(cam: dict, get=fetch_text) -> str | None:
    yt = cam.get("youtube") or {}
    if yt.get("channelId"):
        return yt["channelId"]
    urls = [f"https://www.youtube.com/{yt['handle']}"] if yt.get("handle") else []
    urls += [f"https://www.youtube.com/watch?v={vid}" for vid in yt.get("seedVideos", [])]
    for url in urls:
        try:
            cid = find_channel_id(get(url))
        except Exception as err:  # 消された動画などは飛ばして次を試す
            print(f"[warn] {cam['title']}: {url}: {err}", file=sys.stderr)
            continue
        if cid:
            return cid
    return None


def update_cameras(data: dict, get=fetch_text, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    cams = [c for c in data["cameras"] if c.get("type", "youtube") == "youtube"]
    for i, cam in enumerate(cams):
        yt = cam.setdefault("youtube", {})
        try:
            if i:
                time.sleep(1)
            cid = resolve_channel(cam, get)
            if not cid:
                print(f"[warn] {cam['title']}: チャンネルIDが見つかりません", file=sys.stderr)
                continue
            yt["channelId"] = cid
            videos = parse_streams(get(f"https://www.youtube.com/channel/{cid}/streams"))
            if not videos:
                print(f"[warn] {cam['title']}: 配信一覧を読み取れませんでした", file=sys.stderr)
                continue
            live = pick_live(videos, yt.get("titleKeywords", []))
            yt["videoId"] = live["videoId"] if live else None
            yt["live"] = bool(live)
            yt["embeddable"] = is_embeddable(live["videoId"], get) if live else None
            print(f"[info] {cam['title']}: channel={cid} video={yt['videoId']} live={yt['live']} "
                  f"embeddable={yt['embeddable']}", file=sys.stderr)
        except Exception as err:  # 1台の失敗で全体を止めない（前回の値を残す）
            print(f"[warn] {cam['title']}: {err}", file=sys.stderr)
    data["checkedAt"] = now.astimezone(JST).isoformat(timespec="minutes")
    return data


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--city", default="", help="市のフォルダ（例: sendai）。省略するとさいたま市")
    args = ap.parse_args(argv)
    cams_file = ROOT / args.city / "data" / "livecams.json" if args.city else CAMS_FILE
    data = update_cameras(json.loads(cams_file.read_text("utf-8")))
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if args.dry_run:
        print(text)
    else:
        cams_file.write_text(text, "utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
