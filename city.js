/* 市ごとの設定（さいたま市）。app.js はこの設定を読んで動く。
 * 仙台市版は sendai/city.js。
 */
window.CITY = {
  id: 'saitama',
  name: 'さいたま市',
  wardsText: '市内10区',
  // 初期視点：市全域が見えるように斜め上から。画面幅 widthRef px のとき zoom になり、minZoom〜maxZoom に収める
  view: { center: [139.652, 35.893], zoom: 12, widthRef: 1100, minZoom: 10.6, maxZoom: 12.1, pitch: 55, bearing: -18 },
  maxBounds: [[139.2, 35.65], [140.1, 36.15]],
  // さいたま市は平坦なので地形を少し強調する
  terrainExaggeration: 1.8,
  cityUrl: 'https://www.city.saitama.lg.jp/',
  police: { name: '埼玉県警察', url: 'https://www.police.pref.saitama.lg.jp/', note: '（犯罪情報官NEWS など）' },
  reviewsTag: '#さいたま',
  // 気象庁のコード
  jma: {
    office: '110000', // 埼玉県
    forecastArea: '110010', // 埼玉県南部（さいたま市を含む予報区）
    forecastAreaName: '埼玉県南部',
    tempPoint: '43241', // 気温の地点
    tempPointName: 'さいたま',
    warningAreas: [{ code: '1110000', name: 'さいたま市' }], // 警報・注意報の区域
    wardCodes: ['1110100', '1110200', '1110300', '1110400', '1110500', '1110600', '1110700', '1110800', '1110900', '1111000'],
  },
  point: { lat: 35.8617, lng: 139.6455 }, // 市役所付近（洗濯指数の予報地点）
};
