/* 市ごとの設定（仙台市）。app.js（リポジトリ直下と共通）はこの設定を読んで動く。 */
window.CITY = {
  id: 'sendai',
  name: '仙台市',
  wardsText: '市内5区',
  // 初期視点：都心部と泉区〜太白区が見えるように斜め上から（西の秋保・作並は地図を動かして見る）
  view: { center: [140.9, 38.262], zoom: 11.6, widthRef: 1100, minZoom: 10.4, maxZoom: 11.9, pitch: 55, bearing: -15 },
  maxBounds: [[140.2, 37.95], [141.35, 38.65]],
  // 西部は山地なので、さいたま市ほど地形を強調しない
  terrainExaggeration: 1.3,
  cityUrl: 'https://www.city.sendai.jp/',
  police: { name: '宮城県警察', url: 'https://www.police.pref.miyagi.jp/', note: '（みやぎSecurityメール・子供と女性のための安全情報 など）' },
  reviewsTag: '#仙台',
  // 仙台市だけのカテゴリ。クマ・イノシシ・シカ・サルなどの出没を伝える報道（scripts/news_sources.json の wildlife）
  feedCategories: {
    wildlife: { label: '害獣出没', color: '#7c4a1e', icon: '🐻', tag: '出没', after: 'crime' },
  },
  // ニュースと一緒に読み込む追加のデータ（scripts/fetch_bears.py が作る、宮城県のクマ目撃等情報のうち仙台市の直近30日分）
  extraFeeds: ['data/bears.json'],
  wildlife: {
    officialNote: '宮城県が市町村からの報告を取りまとめた、クマの目撃・痕跡の情報です（直近30日分）。地図の位置は地区名から推定した町・字のおおよその中心で、実際の発見地点ではありません。クマの存在や不在を証明するものではなく、情報が無い場所にもクマがいる可能性があります。',
    note: '報道機関が伝えたクマ・イノシシ・シカ・サルなどの出没情報です。地図の位置は記事中の地名からの推定で、実際の出没地点ではありません。',
    links: [
      { label: '仙台市のツキノワグマ対策（出没情報マップ・LINE/メールでの通知）', url: 'https://www.city.sendai.jp/kankyochose/kurashi/shizen/petto/yase/higai/tsukinowaguma.html' },
      { label: '仙台市のイノシシ対策', url: 'https://www.city.sendai.jp/kankyochose/kurashi/shizen/petto/yase/higai/inoshishi.html' },
    ],
  },
  // 気象庁のコード
  jma: {
    office: '040000', // 宮城県
    forecastArea: '040010', // 宮城県東部（仙台市を含む予報区）
    forecastAreaName: '宮城県東部',
    tempPoint: '34392', // 気温の地点
    tempPointName: '仙台',
    // 警報・注意報は「仙台市東部」「仙台市西部」に分けて発表される
    warningAreas: [{ code: '0410001', name: '仙台市東部' }, { code: '0410002', name: '仙台市西部' }],
    wardCodes: ['0410100', '0410200', '0410300', '0410400', '0410500'], // 青葉区・宮城野区・若林区・太白区・泉区
  },
  point: { lat: 38.2682, lng: 140.86946 }, // 市役所付近（洗濯指数の予報地点）
};
