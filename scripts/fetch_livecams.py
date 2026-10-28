#!/usr/bin/env python3
"""data/livecams.json のライブカメラについて、YouTube のチャンネルIDと今の配信を調べて書き込む。

YouTube のライブ配信は配信ごとに動画IDが変わるため、変わらない「チャンネルID」を調べておき、
画面では「そのチャンネルで今配信中のライブ」（embed/live_stream?channel=…）を埋め込む。
あわせて、その時点の配信の動画ID（videoId）と配信中かどうか（live）も記録する。
APIキーは使わず、YouTube の公開ページのHTMLから読み取る。読み取れなかったカメラは前回の値を残す。

    python3 scripts/fetch_livecams.py            # 調べて data/livecams.json を更新
    python3 scripts/fetch_livecams.py --dry-run  # 書き込まずに結果を表示
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
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
CANONICAL_VIDEO = re.compile(r'<link rel="canonical" href="https://www\.youtube\.com/watch\?v=([\w-]{11})"')


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


def parse_live_page(html: str) -> tuple[str | None, bool]:
    """チャンネルの /live ページから、今の配信の動画IDと配信中かどうかを読み取る。

    配信していないときは /live がチャンネルのトップを返し、canonical が動画を指さない。
    """
    m = CANONICAL_VIDEO.search(html)
    if not m:
        return None, False
    live = '"isLiveNow":true' in html or '"isLive":true' in html
    return m.group(1), live


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
    for i, cam in enumerate(data["cameras"]):
        yt = cam.setdefault("youtube", {})
        try:
            if i:
                time.sleep(1)
            cid = resolve_channel(cam, get)
            if not cid:
                print(f"[warn] {cam['title']}: チャンネルIDが見つかりません", file=sys.stderr)
                continue
            yt["channelId"] = cid
            video_id, live = parse_live_page(get(f"https://www.youtube.com/channel/{cid}/live"))
            yt["videoId"] = video_id
            yt["live"] = live
            print(f"[info] {cam['title']}: channel={cid} video={video_id} live={live}", file=sys.stderr)
        except Exception as err:  # 1台の失敗で全体を止めない（前回の値を残す）
            print(f"[warn] {cam['title']}: {err}", file=sys.stderr)
    data["checkedAt"] = now.astimezone(JST).isoformat(timespec="minutes")
    return data


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    data = update_cameras(json.loads(CAMS_FILE.read_text("utf-8")))
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if args.dry_run:
        print(text)
    else:
        CAMS_FILE.write_text(text, "utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
