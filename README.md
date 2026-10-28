# saitama-3d-map

埼玉県さいたま市（全10区）を **3Dマップ** で表示し、名所・歴史・文化・イベント・グルメ・自然・スポーツにゆかりのある場所に、**漫画の吹き出し** でトピックを表示するWebアプリです。さいたま市の **最新ニュース** も自動で取得し、記事に出てくる地名の場所に吹き出しで表示します。

- ビルド不要の静的サイト（`index.html` + `app.js` + `style.css` + `data/topics.json`）
- **APIキー不要・無料サービスのみ** で動作します

## 主な機能

- **3Dマップ**：MapLibre GL JS 4.7.1 で、OpenFreeMap のベクタータイル（OpenStreetMap データ）と3D建物（fill-extrusion）を表示します。AWS Terrain Tiles の標高データで地形と陰影も付けています。斜め上からの立体表示で始まります。
- **操作**
  - パン：左ドラッグ
  - 回転・傾き：右ドラッグ、または Ctrl＋ドラッグ（スマホは2本指）
  - 拡大・縮小：マウスホイール、ピンチ、ズームボタン
  - 右上にコンパスとズームボタン（NavigationControl）、その下に **初期視点へ戻るボタン（⟲）**
- **漫画の吹き出し**：白地に太い黒枠で、しっぽが地点を指します。フォントは Google Fonts の「Yusei Magic」です。地図の回転・ズームに追従し、カテゴリごとに色分けしています。ズームアウト時は小さく表示され、重なる吹き出しは丸いアイコンにまとまります。
- **詳細パネル**：吹き出しをクリックすると、その地点へ飛び（flyTo）、詳細・年代・アクセス・公式サイト・関連トピック・近くのトピックを表示します。PCでは右側のパネル、スマホでは下部シートです。関連トピックをクリックすると、そのトピックへ移動します。
- **カテゴリフィルタ**：ヘッダーのボタンで表示を切り替えます。ダブルクリックするとそのカテゴリだけを表示します。
- **一覧・検索**：キーワードでトピックを絞り込めます。Enterで先頭の結果へ移動します。
- **区へ移動**：10区それぞれの付近へ視点を移動します。
- **最新ニュース**：GitHub Actions が3時間ごとにニュースを取得し、`data/news.json` を更新します。新聞風の吹き出し（NEWSタグ付き）で地図に表示し、クリックすると見出し・配信元・日時・記事へのリンクを表示します。トピックの詳細には「この付近のニュース」も出ます。ヘッダーの「📰 ニュース」をダブルクリックすると、ニュースだけを表示できます。
- **URL共有**：`#topic=railway-museum` のようなURLで、特定のトピックを開いた状態で表示できます。

## 起動方法（ローカル）

`fetch` で `data/topics.json` を読み込むため、`index.html` をダブルクリックで直接開くのではなく、ローカルサーバー経由で開いてください。

```bash
# Node.js がある場合
npx serve .

# Python がある場合
python -m http.server 8000
# → ブラウザで http://localhost:8000/ を開く
```

インターネット接続が必要です（地図タイル・ライブラリ・フォントをCDNから読み込みます）。ベースマップを取得できない場合は簡易表示に切り替わり、吹き出しと詳細表示はそのまま使えます。

## GitHub Pages での公開方法

1. このリポジトリを GitHub にプッシュします（`main` ブランチ）。
2. リポジトリの **Settings → Pages** を開きます。
3. **Build and deployment** の **Source** を「**GitHub Actions**」にします。
4. **Actions** タブで「ニュース更新と公開」を **Run workflow** で実行します（以後は `main` へのプッシュ時と3時間ごとに自動で実行されます）。
5. 数分後に `https://<ユーザー名>.github.io/saitama-3d-map/` で公開されます。

ビルド工程は無いので、ファイルをプッシュするだけで更新されます。Pages を使わない場合も、ワークフローは `data/news.json` の更新だけを行います。定期実行（schedule）はデフォルトブランチ（`main`）にワークフローがあるときだけ動きます。非公開リポジトリで GitHub Pages を使うには、有料プラン（GitHub Pro など）が必要な場合があります。

## 最新ニュースの仕組み

ブラウザから直接ニュースサイトを読み込むことはできない（CORSの制限）ため、次のように取得しています。APIキーは使いません。

1. `.github/workflows/update-news.yml` が **3時間ごと**（と手動実行・`main` へのプッシュ時）に動きます。
2. `scripts/fetch_news.py` が `scripts/news_sources.json` に書かれたRSSを取得します。初期設定は Googleニュースの「さいたま市」「大宮 さいたま」「浦和 さいたま」の検索結果（直近7日）です。
3. 見出し・概要に出てくる地名を `scripts/places.json` の地名辞書と照合して、位置を推定します。優先順位は「施設」＞「駅」＞「地域名・区名」です。どれにも当てはまらない記事は「市全体のニュース」として市役所付近に表示します。
4. 次の記事を除き、最大40件を `data/news.json` に保存してコミットします。
   - 重複している記事。見出し末尾の「（媒体名）」「｜サイト名」は取り除いてから比べ、言い回しがほとんど同じ見出しも重複とみなします。
   - 映画の上映時間・天気予報・不動産の物件情報など、除外対象の配信元や語句に当てはまる記事（`scripts/news_sources.json` の `excludeSources`・`excludeWords`）。
   - 14日より古い記事と、さいたま市と無関係な記事。
5. 同じワークフローで GitHub Pages に公開するので、サイトにも自動で反映されます。開いたままの画面も15分ごとに読み直します（一覧の🔄ボタンでも読み直せます）。

位置は地名から機械的に推定しているので、実際の場所と異なることがあります（詳細パネルに「記事中の『○○』から推定」と表示されます）。

### 手動でニュースを更新する

- GitHub の **Actions** タブ →「ニュース更新と公開」→ **Run workflow**
- 手元で実行する場合（Python 3.9以上、追加ライブラリ不要）:

```bash
python3 scripts/fetch_news.py            # data/news.json を更新
python3 scripts/fetch_news.py --dry-run  # 書き込まずに結果だけ表示
python3 -m unittest discover -s tests    # テスト（ネットワーク不要）
```

### 取得元・地名を追加する

- `scripts/news_sources.json` の `sources` に、RSS 2.0 または Atom のURLを追加できます（例：さいたま市や区の公式サイトの新着情報フィード）。
- 不要な記事が多い場合は、同じファイルの `excludeSources`（配信元名の一部）や `excludeWords`（見出し・概要に含まれる語）に追加してください。重複の判定が厳しすぎる・緩すぎる場合は `duplicateSimilarity`・`duplicateOverlap`（0〜1、大きいほど判定が厳しくなり、残る記事が増える）で調整できます。
- `scripts/places.json` に `{"name": "...", "kind": "facility", "lat": ..., "lng": ..., "aliases": ["..."]}` を追加すると、その地名を含む記事がその場所に表示されます。

## ファイル構成

```
index.html        画面の骨組み（MapLibre・Google Fonts を固定バージョン／URLで読み込み）
style.css         吹き出し・パネル・スマホ用下部シートなどのスタイル
app.js            地図の初期化、3D建物・地形、吹き出しマーカー、重なり回避、詳細表示、検索・フィルタ、ニュース表示
data/topics.json  カテゴリ・区・トピックのデータ
data/news.json    最新ニュース（GitHub Actions が自動更新）
scripts/fetch_news.py     ニュースの取得と位置推定（Python 標準ライブラリのみ）
scripts/news_sources.json ニュースの取得元（RSS/Atom）
scripts/places.json       位置推定に使う地名辞書
tests/                    fetch_news.py のテスト
.github/workflows/update-news.yml  定期取得と GitHub Pages への公開
```

## トピックデータの形式（`data/topics.json`）

```jsonc
{
  "id": "railway-museum",          // 一意なID（URLの #topic= にも使用）
  "category": "landmark",          // categories のキー
  "title": "鉄道博物館",
  "bubble": "本物の車両がずらり！",   // 吹き出しに出す短い一言
  "ward": "大宮区",
  "lat": 35.9214, "lng": 139.6177,
  "priority": 1,                   // 1が最優先。重なったとき優先して吹き出しを表示
  "era": "2007年開館",
  "description": "詳細説明",
  "access": "アクセス",
  "url": "https://...",            // 公式・参考サイト（無ければ空文字）
  "related": ["omiya-station"]     // 関連トピックのid
}
```

カテゴリ（`categories`）の色・アイコン・表示名もこのファイルで変更できます。

## 収録トピック（25件）

| 区 | トピック | カテゴリ |
| --- | --- | --- |
| 大宮区 | 武蔵一宮 氷川神社 | 歴史 |
| 大宮区 | 氷川参道と十日市 | イベント |
| 大宮区 | 鉄道博物館 | 名所 |
| 大宮区 | 大宮駅と「鉄道のまち」 | 歴史 |
| 大宮区 | 大宮ナポリタン | グルメ |
| 大宮区 | 大宮公園 | 自然 |
| 大宮区 | NACK5スタジアム大宮（大宮アルディージャ） | スポーツ |
| 北区 | 大宮盆栽村 | 文化 |
| 北区 | 大宮盆栽美術館 | 文化 |
| 北区 | さいたま市立漫画会館（北沢楽天） | 文化 |
| 中央区 | さいたまスーパーアリーナ | イベント |
| 中央区・大宮区 | さいたま新都心 | 名所 |
| 中央区 | 与野公園のばらまつり | イベント |
| 緑区 | 埼玉スタジアム2002 | スポーツ |
| 緑区 | 見沼通船堀 | 歴史 |
| 浦和区 | 浦和駒場スタジアム（浦和レッズ） | スポーツ |
| 浦和区 | 浦和のうなぎ | グルメ |
| 浦和区 | 中山道 浦和宿 | 歴史 |
| 浦和区 | 調神社 | 歴史 |
| 浦和区 | さいたま市の誕生（市役所） | 歴史 |
| 南区 | 別所沼公園 | 自然 |
| 桜区 | 田島ヶ原サクラソウ自生地 | 自然 |
| 見沼区・緑区など | 見沼田んぼ | 自然 |
| 岩槻区 | 岩槻人形博物館 | 文化 |
| 岩槻区 | 岩槻城址公園 | 歴史 |

※ 緯度経度は各施設の代表地点です。見沼田んぼのような広い場所は、そのおおよその中心を示しています。営業時間や行事の開催日などは変わることがあるため、お出かけ前に公式サイトで確認してください。

## 利用しているデータ・ライブラリ

- [MapLibre GL JS](https://maplibre.org/)（BSD-3-Clause）
- 地図：[OpenFreeMap](https://openfreemap.org/)（© [OpenMapTiles](https://www.openmaptiles.org/)、データ © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)）
- ニュース：[Googleニュース](https://news.google.com/) のRSS（各記事の著作権は配信元に帰属します。地図には見出しとリンクだけを表示します）
- 地形：[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
- フォント：[Yusei Magic](https://fonts.google.com/specimen/Yusei+Magic)、[Zen Maru Gothic](https://fonts.google.com/specimen/Zen+Maru+Gothic)（SIL Open Font License）
