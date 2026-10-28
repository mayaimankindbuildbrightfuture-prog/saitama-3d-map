"""scripts/fetch_bears.py のテスト（ネットワーク不要）。

    python3 -m unittest discover -s tests
"""

import io
import json
import sys
import unittest
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_bears as B  # noqa: E402

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=B.JST)


def make_xlsx(rows: list[list[str]]) -> bytes:
    """共有文字列とふりがな（rPh）を使う、県の Excel と同じ形の最小のファイルを作る。"""
    strings, cells_xml = [], []
    for i, row in enumerate(rows, start=1):
        cells = []
        for j, v in enumerate(row):
            ref = f"{'ABCDEFGHIJ'[j]}{i}"
            if v.replace(".", "", 1).isdigit():
                cells.append(f'<c r="{ref}"><v>{v}</v></c>')
            else:
                strings.append(v)
                cells.append(f'<c r="{ref}" t="s"><v>{len(strings) - 1}</v></c>')
        cells_xml.append(f'<row r="{i}">{"".join(cells)}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rel = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    sst = "".join(f"<si><t>{s}</t><rPh sb=\"0\" eb=\"1\"><t>ヨミ</t></rPh></si>" for s in strings)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/workbook.xml", f'<workbook {ns} {rel}><sheets><sheet name="公表用シート（報告順）" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>')
        z.writestr("xl/sharedStrings.xml", f"<sst {ns}>{sst}</sst>")
        z.writestr("xl/worksheets/sheet1.xml", f"<worksheet {ns}><sheetData>{''.join(cells_xml)}</sheetData></worksheet>")
    return buf.getvalue()


ROWS = [
    ["（令和8年10月28日9時時点）"],
    ["番号", "発見日時", "", "", "事務所", "市区町村", "地区", "発見頭数", "痕跡", "市街地判定"],
    ["", "月", "日", "時刻"],
    ["1", "4", "1", "0.29166666666666669", "仙台", "仙台市青葉区", "錦ケ丘中央", "１頭", "目撃", "報告外"],
    ["1288", "10", "24", "0.75555555555555554", "仙台", "仙台市青葉区", "芋沢字横向山18-2", "１頭", "目撃", "住居集合地域等以外"],
    ["1289", "10", "25", "不明", "仙台", "仙台市泉区", "泉区朝日1丁目南側路上", "複数頭", "痕跡", "住居集合地域等"],
    ["1290", "10", "26", "0.5", "仙台", "富谷市", "明石原川戸", "１頭", "目撃", "報告外"],
    ["1291", "10", "27", "0.5", "仙台", "仙台市太白区", "どこか分からない地名", "不明", "その他", "不明"],
    ["合計", "1291"],
]


class FetchBearsTest(unittest.TestCase):
    def test_read_sheet_skips_furigana(self):
        rows = B.read_sheet(make_xlsx(ROWS))
        self.assertEqual(rows[1]["F"], "市区町村")  # 「シクマチムラ」が付かない
        self.assertEqual(rows[4]["G"], "芋沢字横向山18-2")

    def test_parse_sightings(self):
        s = B.parse_sightings(B.read_sheet(make_xlsx(ROWS)), 8)
        self.assertEqual([x["number"] for x in s], [1, 1288, 1289, 1290, 1291])  # 見出しと合計の行は除く
        self.assertEqual(s[1]["date"].date().isoformat(), "2026-10-24")
        self.assertEqual(s[1]["time"], "18:08")
        self.assertIsNone(s[2]["time"])
        # 年度なので1〜3月は翌年
        jan = B.parse_sightings([{"A": "9", "B": "1", "C": "5", "D": ""}], 8)[0]
        self.assertEqual(jan["date"].year, 2027)

    def test_reiwa_fiscal_year(self):
        self.assertEqual(B.reiwa_fiscal_year(datetime(2026, 4, 1)), 8)
        self.assertEqual(B.reiwa_fiscal_year(datetime(2027, 3, 31)), 8)

    def test_town_names(self):
        self.assertEqual(B.town_names("芋沢字横向山18-2", "青葉区"), ["芋沢"])
        self.assertEqual(B.town_names("南吉成2丁目22-20", "青葉区"), ["南吉成二丁目", "南吉成"])
        self.assertEqual(B.town_names("泉区松陵三丁目（向陽台中学校向かい側）", "泉区"), ["松陵三丁目", "松陵"])
        self.assertEqual(B.town_names("秋保町湯元字枇杷原西地内", "太白区"), ["秋保町湯元"])
        self.assertEqual(B.town_names("泉区朝日1丁目南側路上", "泉区"), ["朝日一丁目", "朝日"])
        self.assertEqual(B.to_kanji_number(12), "十二")

    def test_build_items_uses_cache_and_recent_sendai_only(self):
        sightings = B.parse_sightings(B.read_sheet(make_xlsx(ROWS)), 8)
        cache = {"青葉区/芋沢": {"lat": 38.2979, "lng": 140.77186}, "泉区/朝日一丁目": None, "泉区/朝日": None}
        calls = []

        def fake_get(url):
            calls.append(url)
            return b"[]"  # どこにも見つからない

        wards = {"泉区": {"lat": 38.32627, "lng": 140.88132}, "太白区": {"lat": 38.22432, "lng": 140.87715}}
        items = B.build_items(sightings, cache, wards, now=NOW, source="宮城県「令和8年度クマ目撃等情報」",
                              get=fake_get, sleep=lambda s: None)
        # 4月の分（古い）と富谷市の分は入らない。新しい順
        self.assertEqual([i["id"] for i in items], ["bear-2026-1291", "bear-2026-1289", "bear-2026-1288"])
        imo = items[2]
        self.assertEqual((imo["place"], imo["placeKind"], imo["lat"]), ("芋沢", "area", 38.2979))
        self.assertEqual(imo["category"], "wildlife")
        self.assertTrue(imo["official"])
        self.assertEqual(imo["title"], "青葉区 芋沢でクマ目撃（１頭）")
        self.assertIn("10月24日 18:08ごろ", imo["summary"])
        self.assertIn("住居集合地域等以外", imo["summary"])
        # 町・字が分からなければ区役所の位置
        self.assertEqual((items[1]["placeKind"], items[1]["place"]), ("ward", "泉区"))
        self.assertEqual(items[1]["title"], "泉区でクマ痕跡（複数頭）")
        # 保存済みの地名（見つからなかったものも）は問い合わせない。新しい地名だけ調べて保存する
        self.assertEqual(len(calls), 1)
        self.assertIn("太白区/どこか分からない地名", cache)

    def test_alerts(self):
        page = ("<p>現在の発令状況</p><p>1.発令内容 クマ出没注意報 2.対象地域 全市区町村（気仙沼市を除く） "
                "3.発令期間 令和8年10月1日(木曜日)から同年10月30日(金曜日)まで 4.県民の皆様へのお願い …</p>"
                "<p>1.発令内容 クマ出没警報 2.対象地域 気仙沼市 3.発令期間 令和8年10月14日から同年10月30日まで 4.お願い</p>"
                "<p>過去の発令状況 1.発令内容 クマ出没警報 2.対象地域 仙台市青葉区 3.発令期間 令和8年8月13日から</p>")
        alerts = B.parse_alerts(page)
        self.assertEqual([a["name"] for a in alerts], ["クマ出没注意報", "クマ出没警報"])  # 過去の分は読まない
        self.assertEqual(alerts[0]["period"], "令和8年10月1日(木曜日)から同年10月30日(金曜日)まで")
        self.assertEqual([B.applies_to_sendai(a) for a in alerts], [True, False])
        self.assertTrue(B.applies_to_sendai({"area": "仙台市青葉区"}))
        self.assertFalse(B.applies_to_sendai({"area": "全市区町村（仙台市を除く）"}))

    def test_saved_data_is_valid(self):
        data = json.loads((ROOT / "sendai" / "data" / "bears.json").read_text("utf-8"))
        self.assertIn("出典：宮城県", data["source"]["label"])
        for i in data["items"]:
            self.assertEqual(i["category"], "wildlife")
            self.assertTrue(38.05 < i["lat"] < 38.6 and 140.25 < i["lng"] < 141.1, i["id"])


if __name__ == "__main__":
    unittest.main()
