/* 市ごとの設定（東京23区）。app.js（リポジトリ直下と共通）はこの設定を読んで動く。 */
window.CITY = {
  id: 'tokyo',
  name: '東京23区',
  addressPrefix: '東京都', // 詳細パネルの「📍 東京都渋谷区」
  hallName: '東京都庁', // 地名の分からない記事を置く場所
  wardsText: '23区',
  // 初期視点：23区全体（東西約30km）が見えるように斜め上から
  view: { center: [139.735, 35.675], zoom: 11.2, widthRef: 1100, minZoom: 10.1, maxZoom: 11.6, pitch: 55, bearing: -15 },
  maxBounds: [[139.2, 35.35], [140.25, 35.95]],
  // 23区の大部分は平坦なので地形を少し強調する
  terrainExaggeration: 1.8,
  cityUrl: 'https://www.metro.tokyo.lg.jp/',
  cityLinkLabel: '東京都と各区',
  police: { name: '警視庁', url: 'https://www.keishicho.metro.tokyo.lg.jp/', note: '（メールけいしちょう など）' },
  reviewsTag: '#東京',
  // カメラが多いので、画面上でこの距離（px）より近いカメラは1つのボタンにまとめる（既定は56）
  camClusterPx: 96,
  // 東京23区だけのカテゴリ。ハクビシン・アライグマ・イノシシなどの出没を伝える報道（scripts/news_sources.json の wildlife）
  feedCategories: {
    wildlife: { label: '害獣出没', color: '#7c4a1e', icon: '🦝', tag: '出没', after: 'crime' },
  },
  wildlife: {
    note: '報道機関が伝えたハクビシン・アライグマ・イノシシ・サル・クマなどの出没情報です。地図の位置は記事中の地名からの推定で、実際の出没地点ではありません。',
    links: [
      { label: '東京都（各区の相談窓口は区のサイトへ）', url: 'https://www.metro.tokyo.lg.jp/' },
    ],
  },
  // 気象庁のコード
  jma: {
    office: '130000', // 東京都
    forecastArea: '130010', // 東京地方
    forecastAreaName: '東京地方',
    tempPoint: '44132', // 気温の地点
    tempPointName: '東京',
    // 警報・注意報は区ごとに発表される
    warningAreas: [
      { code: '1310100', name: '千代田区' },
      { code: '1310200', name: '中央区' },
      { code: '1310300', name: '港区' },
      { code: '1310400', name: '新宿区' },
      { code: '1310500', name: '文京区' },
      { code: '1310600', name: '台東区' },
      { code: '1310700', name: '墨田区' },
      { code: '1310800', name: '江東区' },
      { code: '1310900', name: '品川区' },
      { code: '1311000', name: '目黒区' },
      { code: '1311100', name: '大田区' },
      { code: '1311200', name: '世田谷区' },
      { code: '1311300', name: '渋谷区' },
      { code: '1311400', name: '中野区' },
      { code: '1311500', name: '杉並区' },
      { code: '1311600', name: '豊島区' },
      { code: '1311700', name: '北区' },
      { code: '1311800', name: '荒川区' },
      { code: '1311900', name: '板橋区' },
      { code: '1312000', name: '練馬区' },
      { code: '1312100', name: '足立区' },
      { code: '1312200', name: '葛飾区' },
      { code: '1312300', name: '江戸川区' },
    ],
    wardCodes: ['1310100',  '1310200',  '1310300',  '1310400',  '1310500',  '1310600',  '1310700',  '1310800',  '1310900',  '1311000',  '1311100',  '1311200',  '1311300',  '1311400',  '1311500',  '1311600',  '1311700',  '1311800',  '1311900',  '1312000',  '1312100',  '1312200',  '1312300'],
  },
  point: { lat: 35.68974, lng: 139.693 }, // 東京都庁付近（洗濯指数の予報地点）
};
