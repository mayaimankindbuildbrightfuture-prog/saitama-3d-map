#!/usr/bin/env python3
"""宮城県の「クマ目撃等情報」から仙台市の分を取り出し、sendai/data/bears.json に書き出す（仙台市版の「害獣出没」用）。

宮城県は、市町村から報告されたクマの目撃・痕跡の情報を Excel で公開しており、
「出典を明記することを条件に、自由に複製・加工・編集や頒布などの二次利用が可能」としている。
（仙台市の「クマ出没情報マップ」は利用規約で転載が禁じられているので使わない。）

- 年度ごとのページ（r8kumamokugeki.html など）から最新の Excel のURLを探して読む
- 直近 MAX_AGE_DAYS 日の仙台市の分だけを使う
- 位置は「地区」（例: 芋沢字横向山18-2）から町・字の名前（芋沢）を取り出し、OpenStreetMap の
  Nominatim で調べた中心の座標にする（正確な発見地点ではない）。調べた結果は sendai/data/bear_places.json に
  保存し、同じ地名は二度と問い合わせない（Nominatim の利用方針に合わせる）
- 宮城県のクマ出没注意報・警報の現在の発令状況も読み取る

標準ライブラリだけで動き、APIキーは不要。GitHub Actions から定期的に実行する。

    python3 scripts/fetch_bears.py            # 取得して sendai/data/bears.json を更新
    python3 scripts/fetch_bears.py --dry-run  # 書き込まずに結果を表示
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import fetch_news

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_FILE = ROOT / "sendai" / "data" / "bears.json"
CACHE_FILE = ROOT / "sendai" / "data" / "bear_places.json"
TOPICS_FILE = ROOT / "sendai" / "data" / "topics.json"

PREF = "https://www.pref.miyagi.jp"
YEAR_PAGE = PREF + "/soshiki/sizenhogo/r{reiwa}kumamokugeki.html"
ALERT_PAGE = PREF + "/soshiki/sizenhogo/tyuuihoutouzyoukyou.html"
NOMINATIM = "https://nominatim.openstreetmap.org/search?"
USER_AGENT = "saitama-3d-map bear-info fetcher (+https://github.com/mayaimankindbuildbrightfuture-prog/saitama-3d-map)"

JST = timezone(timedelta(hours=9))
MAX_AGE_DAYS = 30
CITY_PREFIX = "仙台市"
SENDAI_BOUNDS = (38.05, 38.60, 140.25, 141.10)  # 緯度・経度の範囲（ほかの市の同じ地名を避ける）
M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def fetch(url: str, timeout: float = 30.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def reiwa_fiscal_year(now: datetime) -> int:
    """年度（4月〜翌3月）の令和の年。2026年4月〜2027年3月は令和8年度。"""
    year = now.year if now.month >= 4 else now.year - 1
    return year - 2018


# ---------- Excel（標準ライブラリで読む） ----------

def _text(si: ET.Element) -> str:
    """共有文字列の文字。ふりがな（rPh）は含めない。"""
    out = []
    for ch in si:
        if ch.tag == M + "t":
            out.append(ch.text or "")
        elif ch.tag == M + "r":
            t = ch.find(M + "t")
            out.append((t.text or "") if t is not None else "")
    return "".join(out)


def read_sheet(xlsx: bytes, name: str | None = None) -> list[dict[str, str]]:
    """シート（name を省くと最初のシート）を、列名（A, B, …）→ 値 の行の一覧にする。"""
    with zipfile.ZipFile(io.BytesIO(xlsx)) as z:
        strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            strings = [_text(si) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(M + "si")]
        book = ET.fromstring(z.read("xl/workbook.xml"))
        rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
        sheets = book.find(M + "sheets")
        sheet = next((s for s in sheets if name is None or s.get("name") == name), None)
        if sheet is None:
            raise ValueError(f"シート「{name}」がありません")
        target = rels[sheet.get(R + "id")].lstrip("/")
        path = target if target.startswith("xl/") else "xl/" + target
        rows = []
        for row in ET.fromstring(z.read(path)).find(M + "sheetData").findall(M + "row"):
            cells = {}
            for c in row.findall(M + "c"):
                col = "".join(ch for ch in c.get("r", "") if ch.isalpha())
                v = c.find(M + "v")
                if v is not None:
                    cells[col] = strings[int(v.text)] if c.get("t") == "s" else (v.text or "")
                else:
                    inline = c.find(M + "is")
                    cells[col] = _text(inline) if inline is not None else ""
            rows.append(cells)
        return rows


# ---------- 目撃等情報 ----------

def parse_time(value: str) -> str | None:
    """Excel の時刻（1日を1とする小数）を「HH:MM」にする。不明なら None。"""
    try:
        minutes = round(float(value) * 24 * 60)
    except (TypeError, ValueError):
        return None
    if not 0 <= minutes < 24 * 60:
        return None
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def parse_sightings(rows: list[dict[str, str]], reiwa: int) -> list[dict]:
    """「番号・発見日時（月・日・時刻）・事務所・市区町村・地区・発見頭数・痕跡・市街地判定」の表を読む。"""
    out = []
    for r in rows:
        number, month, day = r.get("A", ""), r.get("B", ""), r.get("C", "")
        if not (number.isdigit() and month.isdigit() and day.isdigit()):
            continue  # 見出しや合計の行
        m, d = int(month), int(day)
        year = 2018 + reiwa + (1 if m <= 3 else 0)  # 年度なので1〜3月は翌年
        try:
            date = datetime(year, m, d, tzinfo=JST)
        except ValueError:
            continue
        out.append({
            "number": int(number), "date": date, "time": parse_time(r.get("D", "")),
            "city": r.get("F", "").strip(), "district": r.get("G", "").strip(),
            "count": r.get("H", "").strip(), "kind": r.get("I", "").strip(), "urban": r.get("J", "").strip(),
        })
    return out


KANJI_DIGITS = "〇一二三四五六七八九"


def to_kanji_number(n: int) -> str:
    if n < 10:
        return KANJI_DIGITS[n]
    tens, ones = divmod(n, 10)
    return ("" if tens == 1 else KANJI_DIGITS[tens]) + "十" + (KANJI_DIGITS[ones] if ones else "")


def town_names(district: str, ward: str) -> list[str]:
    """地区から、地図で調べる町・字の名前の候補を、細かい順に返す。

    例: 「芋沢字横向山18-2」→ ["芋沢"]、「南吉成2丁目22-20」→ ["南吉成二丁目", "南吉成"]、
        「泉区松陵三丁目（向陽台中学校向かい側）」→ ["松陵三丁目", "松陵"]
    """
    s = unicodedata.normalize("NFKC", district)
    s = re.sub(r"[（(].*?[）)]", "", s)  # 括弧の中の補足
    s = s.replace(ward, "", 1) if s.startswith(ward) else s
    s = re.sub(r"^仙台市", "", s)
    s = s.split("字")[0]  # 「字」より後は小さな地名・番地
    s = re.sub(r"(地内|付近|周辺|地先|の?[東西南北]側.*|路上.*|道路上.*)$", "", s)
    s = re.sub(r"(\d+)丁目", lambda m: to_kanji_number(int(m.group(1))) + "丁目", s)
    s = re.sub(r"[\d\-－‐ー番地号の\s]+$", "", s)
    s = s.strip()
    names = []
    if s:
        names.append(s)
    base = re.sub(r"[一二三四五六七八九十]+丁目$", "", s)
    if base and base != s:
        names.append(base)
    return names


def geocode(name: str, ward: str, get=fetch) -> dict | None:
    """「仙台市○○区 地名」を Nominatim で調べる。仙台市のその区の結果だけを使う。"""
    query = urllib.parse.urlencode({"q": f"{CITY_PREFIX}{ward} {name}", "format": "json", "limit": 5,
                                    "countrycodes": "jp", "accept-language": "ja"})
    for r in json.loads(get(NOMINATIM + query)):
        lat, lng = float(r["lat"]), float(r["lon"])
        south, north, west, east = SENDAI_BOUNDS
        if south < lat < north and west < lng < east and ward in r.get("display_name", ""):
            return {"lat": round(lat, 5), "lng": round(lng, 5)}
    return None


def locate(s: dict, cache: dict, wards: dict, get=fetch, sleep=time.sleep) -> dict:
    """発見場所の座標。町・字が分からなければ区役所の位置にする。"""
    ward = s["city"].replace(CITY_PREFIX, "")
    for name in town_names(s["district"], ward):
        key = f"{ward}/{name}"
        if key not in cache:
            try:
                sleep(1.1)  # Nominatim は1秒に1回まで
                cache[key] = geocode(name, ward, get)
            except Exception as err:  # 一時的な失敗は保存せず、次回また調べる
                print(f"[warn] {key}: {err}", file=sys.stderr)
                continue
        if cache[key]:
            return {**cache[key], "place": name, "placeKind": "area"}
    w = wards.get(ward)
    if w:
        return {"lat": w["lat"], "lng": w["lng"], "place": ward, "placeKind": "ward"}
    return {}


def build_items(sightings: list[dict], cache: dict, wards: dict, *, now: datetime, source: str,
                get=fetch, sleep=time.sleep) -> list[dict]:
    recent = [s for s in sightings if s["city"].startswith(CITY_PREFIX)
              and now - timedelta(days=MAX_AGE_DAYS) <= s["date"] <= now + timedelta(days=1)]
    recent.sort(key=lambda s: (s["date"], s["time"] or "", s["number"]), reverse=True)
    items = []
    for s in recent:
        pos = locate(s, cache, wards, get, sleep)
        if not pos:
            continue
        ward = s["city"].replace(CITY_PREFIX, "")
        kind = s["kind"] if s["kind"] in ("目撃", "痕跡") else "情報"
        when = f"{s['date'].month}月{s['date'].day}日" + (f" {s['time']}ごろ" if s["time"] else "")
        count = f"（{s['count']}）" if s["count"] and s["count"] != "不明" else ""
        published = s["date"].replace(hour=int((s["time"] or "00:00")[:2]), minute=int((s["time"] or "00:00")[3:]))
        summary = f"{when}、{ward}{s['district'].replace(ward, '', 1)}でクマの{kind}{count}。"
        if s["urban"] and s["urban"] not in ("報告外", "不明"):
            summary += f"市街地判定: {s['urban']}。"
        items.append({
            "id": f"bear-{s['date'].year}-{s['number']}",
            "category": "wildlife",
            "type": "bear-official",
            "typeLabel": "クマ（宮城県の目撃等情報）",
            "typeIcon": "🐾",
            "official": True,
            # 吹き出しでは後ろが省略されるので、場所を先に書く
            "title": f"{ward}{' ' + pos['place'] if pos['placeKind'] == 'area' else ''}でクマ{kind}{count}",
            "summary": summary,
            "source": source,
            "url": PREF + "/",
            "published": published.isoformat(timespec="minutes"),
            "place": pos["place"],
            "placeKind": pos["placeKind"],
            "matched": pos["place"],
            "ward": ward,
            "lat": pos["lat"],
            "lng": pos["lng"],
        })
    fetch_news.spread(items)
    return items


# ---------- 出没注意報・警報 ----------

def parse_alerts(page: str) -> list[dict]:
    """「現在の発令状況」の「1.発令内容 2.対象地域 3.発令期間」を読み取る。"""
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"<script.*?</script>", "", page, flags=re.S)))
    text = text.replace("&nbsp;", " ")
    start = text.find("現在の発令状況")
    end = text.find("過去の発令状況", start)
    section = text[start:end] if start >= 0 else ""
    alerts = []
    for m in re.finditer(r"1\.\s*発令内容\s*(.+?)\s*2\.\s*対象地域\s*(.+?)\s*3\.\s*発令期間\s*(.+?)\s*(?:4\.|記者発表|$)", section):
        alerts.append({"name": m.group(1).strip(), "area": m.group(2).strip(), "period": m.group(3).strip()})
    return alerts


def applies_to_sendai(alert: dict) -> bool:
    area = alert["area"]
    excluded = re.search(r"[（(](.+?)を除く[）)]", area)
    if "全市区町村" in area or "県内全域" in area:
        return not (excluded and CITY_PREFIX in excluded.group(1))
    return CITY_PREFIX in area


# ---------- 実行 ----------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    now = datetime.now(JST)

    reiwa = reiwa_fiscal_year(now)
    page = None
    for r in (reiwa, reiwa - 1):  # 年度の初めは新しいページがまだ無いことがある
        try:
            page = fetch(YEAR_PAGE.format(reiwa=r)).decode("utf-8", "replace")
            reiwa = r
            break
        except Exception as err:
            print(f"[warn] 令和{r}年度のページ: {err}", file=sys.stderr)
    if page is None:
        print("[warn] クマ目撃等情報のページを読めなかったため、既存のファイルを残します。", file=sys.stderr)
        return 0
    m = re.search(r'href="([^"]+\.xlsx)"', page)
    if not m:
        print("[warn] Excel ファイルが見つからないため、既存のファイルを残します。", file=sys.stderr)
        return 0
    xlsx_url = urllib.parse.urljoin(YEAR_PAGE.format(reiwa=reiwa), m.group(1))
    rows = read_sheet(fetch(xlsx_url))
    sightings = parse_sightings(rows, reiwa)
    # 表の上の「（令和8年10月28日9時時点）」
    as_of = next((m for r in rows[:5] for v in r.values() if (m := re.search(r"令和\d+年\d+月\d+日\d+時時点", v))), None)

    try:
        alerts = parse_alerts(fetch(ALERT_PAGE).decode("utf-8", "replace"))
    except Exception as err:
        print(f"[warn] 出没注意報等のページ: {err}", file=sys.stderr)
        alerts = []

    cache = json.loads(CACHE_FILE.read_text("utf-8")) if CACHE_FILE.exists() else {}
    topics = json.loads(TOPICS_FILE.read_text("utf-8"))
    wards = {w["name"]: w for w in topics["wards"]}
    source = f"宮城県「令和{reiwa}年度クマ目撃等情報」"
    items = build_items(sightings, cache, wards, now=now, source=source)

    out = {
        "generatedAt": now.isoformat(timespec="minutes"),
        "source": {"label": f"出典：{source}", "asOf": as_of.group(0) if as_of else "", "url": PREF + "/"},
        "alerts": [{**a, "sendai": applies_to_sendai(a)} for a in alerts],
        "items": items,
    }
    text = json.dumps(out, ensure_ascii=False, indent=2) + "\n"
    if args.dry_run:
        print(text)
    else:
        OUTPUT_FILE.write_text(text, "utf-8")
        CACHE_FILE.write_text(json.dumps(dict(sorted(cache.items())), ensure_ascii=False, indent=2) + "\n", "utf-8")
        print(f"[info] {OUTPUT_FILE.relative_to(ROOT)} に {len(items)} 件（{len(sightings)} 件中、仙台市・直近{MAX_AGE_DAYS}日）"
              f"・発令 {len(alerts)} 件を書き出しました", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
