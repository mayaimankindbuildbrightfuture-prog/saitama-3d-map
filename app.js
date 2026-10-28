/* 3Dトピックマップ（さいたま市・仙台市で共通）
 * 市ごとの違いは city.js（window.CITY）に書く。
 * MapLibre GL JS + OpenFreeMap（ベクタータイル）+ AWS Terrain Tiles（DEM）
 * いずれもAPIキー不要。
 */
(() => {
  'use strict';

  const CITY = window.CITY;

  const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
  const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const DATA_URL = 'data/topics.json';
  const NEWS_URL = 'data/news.json';
  const LIVECAMS_URL = 'data/livecams.json';
  const NEWS_REFRESH_MS = 15 * 60 * 1000; // 開いたままでも15分ごとに news.json を読み直す
  const NEWS_NEARBY_KM = 1.5;
  // data/news.json の記事のカテゴリ（scripts/news_sources.json の categories に対応）。
  // 名所などのトピックのカテゴリ「gourmet」と区別するため、グルメ記事は foodnews として扱う
  const FEED_CATEGORIES = {
    news: { label: 'ニュース', color: '#111111', icon: '📰', tag: 'NEWS' },
    otaku: { label: 'オタク', color: '#e84393', icon: '🎮', tag: 'OTAKU' },
    crime: { label: '事件・防犯', color: '#2c3e50', icon: '🚨', tag: '事件・防犯' },
    foodnews: { label: 'グルメ情報', color: '#e67e22', icon: '🍜', tag: 'GOURMET' },
    supermarket: { label: 'スーパー特売', color: '#16a085', icon: '🛒', tag: 'SALE' },
    reviews: { label: '口コミ', color: '#6c5ce7', icon: '💬', tag: '口コミ' },
  };
  const FEED_CATEGORY_OF = {
    news: 'news', otaku: 'otaku', crime: 'crime', gourmet: 'foodnews', supermarket: 'supermarket', reviews: 'reviews',
  };
  // city.js の feedCategories で、その市だけのカテゴリ（仙台市の「害獣出没」など）を after のカテゴリの後ろに加える
  Object.entries(CITY.feedCategories || {}).forEach(([id, { after, ...cat }]) => {
    const entries = Object.entries(FEED_CATEGORIES);
    const at = entries.findIndex(([k]) => k === after);
    entries.splice(at >= 0 ? at + 1 : entries.length, 0, [id, cat]);
    Object.keys(FEED_CATEGORIES).forEach((k) => delete FEED_CATEGORIES[k]);
    entries.forEach(([k, v]) => { FEED_CATEGORIES[k] = v; });
    FEED_CATEGORY_OF[id] = id;
  });
  // 起動時にオンにしておくカテゴリ（ほかはボタンでオンにする）
  const DEFAULT_CATEGORIES = ['news'];
  const FLYER_SITES = [
    { label: 'Shufoo!', url: 'https://www.shufoo.net/' },
    { label: 'トクバイ', url: 'https://tokubai.co.jp/' },
  ];

  // 初期視点：市全域が見えるように斜め上から
  const INITIAL_VIEW = {
    center: CITY.view.center,
    zoom: initialZoom(),
    pitch: CITY.view.pitch,
    bearing: CITY.view.bearing,
  };

  // 画面幅に合わせて、市域が収まるズームにする
  function initialZoom() {
    const w = window.innerWidth || 1200;
    const v = CITY.view;
    return Math.max(v.minZoom, Math.min(v.maxZoom, v.zoom + Math.log2(w / v.widthRef)));
  }

  // 地形の陰に入ったと判定された吹き出しは薄く表示されるが、誤判定が多いため常に濃く表示する
  const MARKER_OPTIONS = { opacity: '1', opacityWhenCovered: '1' };

  const FOCUS_ZOOM = 16;
  const FOCUS_PITCH = 60;
  const MOBILE_QUERY = window.matchMedia('(max-width: 720px)');

  const state = {
    map: null,
    data: null,
    topics: [],
    byId: new Map(),
    markers: new Map(), // id -> { marker, el, topic }
    activeCategories: new Set(),
    query: '',
    activeId: null,
    typeFilter: '', // 「カテゴリ:分類」（例 foodnews:curry）。空ならすべて
    collisionFrame: 0,
    newsMeta: null, // { generatedAt, sources }
    savedView: null, // トピックを開く前の視点
    livecams: null, // data/livecams.json
    camMarkers: [], // [{ marker, el, cam }]
    camClusterMarkers: [], // 近いカメラをまとめたボタン
    camImageTimer: 0,
    camsVisible: false,
    activeCamId: null,
    hazardVisible: false,
    weatherVisible: false,
    weatherTab: 'radar',
    weatherLayer: 'rain',
    weatherMap: null,
    weatherBox: null,
    radarFrames: [], // [{ basetime, validtime, forecast }]
    radarIndex: 0,
    radarTimer: 0,
    weatherRefreshTimer: 0,
    hazardLayer: 'flood_l2',
    hazardMap: null,
    hazardBox: null,
  };

  const $ = (sel) => document.querySelector(sel);

  // ---------- 起動 ----------
  init().catch((err) => {
    console.error(err);
    showToast('読み込みに失敗しました。ローカルサーバー経由で開いているか確認してください。');
  });

  async function init() {
    const [data, style, news, livecams] = await Promise.all([
      loadJSON(DATA_URL), loadStyle(), loadNews(),
      loadJSON(LIVECAMS_URL).catch((err) => { console.warn('ライブカメラの一覧を読み込めませんでした:', err); return null; }),
    ]);
    state.livecams = livecams;
    state.data = data;
    Object.assign(data.categories, FEED_CATEGORIES);
    state.topics = data.topics.slice();
    state.topics.forEach((t) => state.byId.set(t.id, t));
    DEFAULT_CATEGORIES.forEach((c) => state.activeCategories.add(c));

    buildMap(style);
    buildFilters();
    buildWardSelect();
    buildList();
    bindUI();
    state.pendingNews = news;
    setInterval(refreshNews, NEWS_REFRESH_MS);
  }

  async function loadJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  // スタイルが取得できない環境でも吹き出しとUIは動くよう、簡易スタイルにフォールバックする
  async function loadStyle() {
    try {
      return await loadJSON(STYLE_URL);
    } catch (err) {
      console.warn('ベースマップのスタイルを取得できませんでした:', err);
      showToast('地図タイルを読み込めませんでした（オフライン表示）。吹き出しと詳細は利用できます。');
      return {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9efe4' } }],
      };
    }
  }

  // ---------- 地図 ----------
  function buildMap(style) {
    const map = new maplibregl.Map({
      container: 'map',
      style,
      ...INITIAL_VIEW,
      maxPitch: 75,
      minZoom: 9,
      maxBounds: CITY.maxBounds,
      attributionControl: { compact: true },
    });
    state.map = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new ResetViewControl(), 'top-right');
    map.addControl(new LiveCamControl(), 'top-right');
    map.addControl(new HazardControl(), 'top-right');
    map.addControl(new WeatherControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    map.on('load', () => {
      add3DBuildings(map);
      addTerrain(map);
      buildMarkers();
      // ライブカメラの場所は最初から地図に出しておく（📹 カメラ のボタンで隠せる）
      setCamsVisible(true, { fit: false });
      if (state.pendingNews) setNews(state.pendingNews);
      updateZoomClass();
      scheduleCollision();
      openFromHash();
    });

    map.on('zoom', updateZoomClass);
    map.on('moveend', updateCamMarkers);
    map.on('move', scheduleCollision);
    map.on('moveend', scheduleCollision);
    map.on('error', (e) => {
      // タイル1枚の取得失敗などは致命的ではないので警告に留める
      console.warn('map error:', e && e.error ? e.error.message : e);
    });
  }

  function add3DBuildings(map) {
    const style = map.getStyle();
    const hasExtrusion = style.layers.some((l) => l.type === 'fill-extrusion');
    if (hasExtrusion || !style.sources.openmaptiles) return;

    // 念のため：スタイルに3D建物が無い場合は自前で追加する
    const firstSymbol = style.layers.find((l) => l.type === 'symbol');
    map.addLayer({
      id: 'building-3d-custom',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': '#e3d9cc',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.85,
      },
    }, firstSymbol && firstSymbol.id);
  }

  function addTerrain(map) {
    try {
      map.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: [DEM_TILES],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
        attribution: '地形: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">AWS Terrain Tiles</a>',
      });
      // 陰影表示は地形とは別ソースにする（MapLibre推奨）
      map.addSource('hillshade-dem', {
        type: 'raster-dem',
        tiles: [DEM_TILES],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
      });
      const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol');
      map.addLayer({
        id: 'hillshade',
        type: 'hillshade',
        source: 'hillshade-dem',
        paint: {
          'hillshade-exaggeration': 0.35,
          'hillshade-shadow-color': '#5a4a3a',
        },
      }, firstSymbol && firstSymbol.id);
      map.setTerrain({ source: 'terrain-dem', exaggeration: CITY.terrainExaggeration });
      if (typeof map.setSky === 'function') {
        map.setSky({
          'sky-color': '#9fd3ff',
          'horizon-color': '#fdf1d6',
          'fog-color': '#f3efe6',
          'sky-horizon-blend': 0.6,
          'horizon-fog-blend': 0.5,
          'fog-ground-blend': 0.6,
        });
      }
    } catch (err) {
      console.warn('地形を追加できませんでした:', err);
    }
  }

  class ResetViewControl {
    onAdd(map) {
      this._container = document.createElement('div');
      this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group reset-ctrl';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = '初期視点に戻す';
      btn.setAttribute('aria-label', '初期視点に戻す');
      btn.textContent = '⟲';
      btn.addEventListener('click', () => resetView());
      this._container.appendChild(btn);
      return this._container;
    }
    onRemove() {
      this._container.remove();
    }
  }

  // ---------- ハザードマップ（乗算で重ねる） ----------
  // 国土交通省「重ねるハザードマップ」の公開タイル（APIキー不要）。河川の浸水想定区域や、
  // 内水・土砂災害の区域が含まれる。
  const HAZARD_TILE_BASE = 'https://disaportaldata.gsi.go.jp/raster/';
  const HAZARD_ATTRIBUTION = 'ハザード: <a href="https://disaportal.gsi.go.jp/" target="_blank" rel="noopener">ハザードマップポータルサイト（国土交通省）</a>';
  const FLOOD_DEPTH_LEGEND = [
    ['#f7f5a9', '0.5m未満'], ['#ffd8c0', '0.5〜3m'], ['#ffb7b7', '3〜5m'],
    ['#ff9191', '5〜10m'], ['#f285c9', '10〜20m'], ['#dc7adc', '20m以上'],
  ];
  const HAZARD_LAYERS = [
    { id: 'flood_l2', label: '洪水 浸水の深さ（想定最大規模）', path: '01_flood_l2_shinsuishin_data', legend: FLOOD_DEPTH_LEGEND },
    { id: 'flood_l1', label: '洪水 浸水の深さ（計画規模）', path: '01_flood_l1_shinsuishin_newlegend_data', legend: FLOOD_DEPTH_LEGEND },
    // 以下は凡例の色をここに書かず、ハザードマップポータルの凡例を案内する
    { id: 'keizoku', label: '洪水 浸水が続く時間（想定最大規模）', path: '01_flood_l2_keizoku_data' },
    { id: 'kaokutoukai', label: '家屋倒壊等氾濫想定区域（氾濫流）', path: '01_flood_l2_kaokutoukai_hanran_data' },
    { id: 'naisui', label: '内水（大雨で下水があふれる）浸水想定', path: '02_naisui_data' },
    { id: 'dosha', label: '土砂災害警戒区域（急傾斜地の崩壊）', path: '05_kyukeishakeikaikuiki' },
  ];

  class HazardControl {
    onAdd() {
      this._container = document.createElement('div');
      this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group hazard-ctrl';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'hazard-toggle';
      btn.title = 'ハザードマップを重ねる';
      btn.setAttribute('aria-label', 'ハザードマップを重ねる');
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = '🌊 ハザード';
      btn.addEventListener('click', () => setHazardVisible(!state.hazardVisible));
      this._container.appendChild(btn);
      return this._container;
    }
    onRemove() {
      this._container.remove();
    }
  }

  function hazardTiles(layer) {
    return [`${HAZARD_TILE_BASE}${layer.path}/{z}/{x}/{y}.png`];
  }

  // 本体の地図の上に、タイルだけを描く透明な地図を重ね、CSS の mix-blend-mode: multiply（乗算）で合成する。
  // 視点は本体の地図に合わせて動かし、地形の高さもそろえて傾けたときのずれを防ぐ。
  // ハザードと天気（雨雲など）でそれぞれ1枚ずつ使う。
  function createOverlayMap({ className, tiles, maxzoom, resampling = 'nearest' }) {
    const main = state.map;
    const box = document.createElement('div');
    box.className = `blend-overlay ${className}`;
    box.setAttribute('aria-hidden', 'true');
    const canvasContainer = main.getCanvasContainer();
    canvasContainer.insertBefore(box, main.getCanvas().nextSibling);
    const overlay = new maplibregl.Map({
      container: box,
      style: {
        version: 8,
        sources: {
          tiles: { type: 'raster', tiles, tileSize: 256, minzoom: 2, maxzoom },
          'terrain-dem': { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 },
        },
        layers: [{ id: 'tiles', type: 'raster', source: 'tiles', paint: { 'raster-opacity': 1, 'raster-resampling': resampling } }],
        terrain: main.getTerrain() ? { source: 'terrain-dem', exaggeration: main.getTerrain().exaggeration } : undefined,
      },
      interactive: false,
      attributionControl: false,
      maxPitch: 75,
      center: main.getCenter(),
      zoom: main.getZoom(),
      bearing: main.getBearing(),
      pitch: main.getPitch(),
      fadeDuration: 0,
    });
    overlay.on('error', (e) => {
      const err = e && e.error;
      if (err && err.name === 'AbortError') return; // 地図を動かしたときの読み込みの取り消しは問題ない
      console.warn(`${className} error:`, err ? err.message : e);
    });
    const sync = () => overlay.jumpTo({
      center: main.getCenter(), zoom: main.getZoom(), bearing: main.getBearing(), pitch: main.getPitch(),
    });
    main.on('move', sync);
    main.on('resize', () => { overlay.resize(); sync(); });
    return { map: overlay, box };
  }

  function ensureHazardMap() {
    if (state.hazardMap) return state.hazardMap;
    const layer = HAZARD_LAYERS.find((l) => l.id === state.hazardLayer) || HAZARD_LAYERS[0];
    const { map, box } = createOverlayMap({ className: 'hazard-overlay', tiles: hazardTiles(layer), maxzoom: 17 });
    state.hazardMap = map;
    state.hazardBox = box;
    return map;
  }

  function setHazardVisible(visible) {
    state.hazardVisible = visible;
    const btn = $('#hazard-toggle');
    if (btn) {
      btn.setAttribute('aria-pressed', String(visible));
      btn.title = visible ? 'ハザードマップを消す' : 'ハザードマップを重ねる';
    }
    if (visible) {
      ensureHazardMap();
      state.hazardBox.hidden = false;
      state.hazardMap.resize();
      renderHazardPanel();
    } else if (state.hazardBox) {
      state.hazardBox.hidden = true;
    }
    $('#hazard-panel').hidden = !visible;
  }

  function setHazardLayer(id) {
    const layer = HAZARD_LAYERS.find((l) => l.id === id);
    if (!layer) return;
    state.hazardLayer = id;
    const src = state.hazardMap && state.hazardMap.getSource('tiles');
    if (src && src.setTiles) src.setTiles(hazardTiles(layer));
    renderHazardPanel();
  }

  function renderHazardPanel() {
    const layer = HAZARD_LAYERS.find((l) => l.id === state.hazardLayer) || HAZARD_LAYERS[0];
    const select = $('#hazard-select');
    if (!select.options.length) {
      HAZARD_LAYERS.forEach((l) => select.append(el('option', { value: l.id }, l.label)));
      select.addEventListener('change', () => setHazardLayer(select.value));
      $('#hazard-strength').addEventListener('input', (e) => {
        if (state.hazardBox) state.hazardBox.style.opacity = String(Number(e.target.value) / 100);
      });
      $('#hazard-close').addEventListener('click', () => setHazardVisible(false));
    }
    select.value = layer.id;
    const legend = $('#hazard-legend');
    if (layer.legend) {
      legend.replaceChildren(...layer.legend.map(([color, label]) => {
        const sw = el('span', { className: 'hazard-swatch' });
        sw.style.background = color;
        return el('li', {}, sw, label);
      }));
    } else {
      legend.replaceChildren(el('li', { className: 'hazard-legend-note' }, '色の意味は ',
        el('a', { href: 'https://disaportal.gsi.go.jp/', target: '_blank', rel: 'noopener' }, 'ハザードマップポータルサイト'),
        ' の凡例をご覧ください。'));
    }
    $('#hazard-source').innerHTML = `${HAZARD_ATTRIBUTION}。地図の色と<b>乗算</b>で重ねています。避難の判断には <a href="${CITY.cityUrl}" target="_blank" rel="noopener">${CITY.cityLinkLabel || CITY.name}</a> の最新のハザードマップも確認してください。`;
  }

  // ---------- 天気（雨雲レーダー・天気予報・警報・洗濯指数・地震） ----------
  // 気象庁の公開データ（bosai）と Open-Meteo を使う。どちらも APIキー不要で、ブラウザから直接読める（CORS 許可あり）。
  const JMA = 'https://www.jma.go.jp/bosai';
  const JMA_PAGE = 'https://www.jma.go.jp/bosai/nowc/';
  const WEATHER_REFRESH_MS = 5 * 60 * 1000;

  // 雨雲などのナウキャストの種類。targets は時刻一覧のファイル（N1: 実況、N2: 降水の予報、N3: 雷・竜巻）
  const WEATHER_LAYERS = [
    { id: 'rain', label: '☔ 雨雲（降水ナウキャスト）', element: 'hrpns', targets: ['targetTimes_N1.json', 'targetTimes_N2.json'],
      legend: [['#f2f2ff', '1mm/h未満'], ['#a0d2ff', '1〜5'], ['#218cff', '5〜10'], ['#0041ff', '10〜20'],
        ['#faf500', '20〜30'], ['#ff9900', '30〜50'], ['#ff2800', '50〜80'], ['#b40068', '80以上']] },
    { id: 'thunder', label: '⚡ 雷（雷ナウキャスト）', element: 'thns', targets: ['targetTimes_N3.json'] },
    { id: 'tornado', label: '🌪 竜巻（竜巻発生確度）', element: 'trns', targets: ['targetTimes_N3.json'] },
  ];

  // 気象庁の警報・注意報のコード。2026年5月下旬からの新しい防災気象情報では、大雨・土砂災害・高潮に
  // 警戒レベル（２〜５）が付き、レベル４の「危険警報」が加わった（気象庁の警報・注意報のページのコード表と同じ）
  const WARNING_NAMES = {
    33: 'レベル５大雨特別警報', 43: 'レベル４大雨危険警報', '03': 'レベル３大雨警報', 10: 'レベル２大雨注意報',
    39: 'レベル５土砂災害特別警報', 49: 'レベル４土砂災害危険警報', '09': 'レベル３土砂災害警報', 29: 'レベル２土砂災害注意報',
    38: 'レベル５高潮特別警報', 48: 'レベル４高潮危険警報', '08': 'レベル３高潮警報', 19: 'レベル２高潮注意報',
    35: '暴風特別警報', '05': '暴風警報', 15: '強風注意報', 32: '暴風雪特別警報', '02': '暴風雪警報', 13: '風雪注意報',
    36: '大雪特別警報', '06': '大雪警報', 12: '大雪注意報', 37: '波浪特別警報', '07': '波浪警報', 16: '波浪注意報',
    14: '雷注意報', 17: '融雪注意報', 20: '濃霧注意報', 21: '乾燥注意報', 22: 'なだれ注意報', 23: '低温注意報',
    24: '霜注意報', 25: '着氷注意報', 26: '着雪注意報',
  };
  // 発表中として扱わない状態
  const WARNING_INACTIVE = ['解除', '発表警報・注意報はなし'];

  class WeatherControl {
    onAdd() {
      this._container = document.createElement('div');
      this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group weather-ctrl';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'weather-toggle';
      btn.title = '天気（雨雲レーダー・洗濯指数・地震）を表示';
      btn.setAttribute('aria-label', '天気を表示');
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = '🌦 天気';
      btn.addEventListener('click', () => setWeatherVisible(!state.weatherVisible));
      this._container.appendChild(btn);
      return this._container;
    }
    onRemove() {
      this._container.remove();
    }
  }

  function jmaTime(t) {
    // 「20261028052000」（UTC）→ Date
    return new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12)));
  }

  function hhmm(date) {
    return date.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  }

  function radarTiles(frame, element) {
    return [`${JMA}/jmatile/data/nowc/${frame.basetime}/none/${frame.validtime}/surf/${element}/{z}/{x}/{y}.png`];
  }

  async function loadRadarFrames(layer) {
    const lists = await Promise.all(layer.targets.map((f) => loadJSON(`${JMA}/jmatile/data/nowc/${f}?t=${Date.now()}`)));
    const frames = [];
    const seen = new Set();
    lists.flat().forEach((t) => {
      if (!t.elements.includes(layer.element) || seen.has(t.validtime)) return;
      seen.add(t.validtime);
      frames.push({ basetime: t.basetime, validtime: t.validtime, forecast: t.basetime !== t.validtime });
    });
    frames.sort((a, b) => a.validtime.localeCompare(b.validtime));
    return frames;
  }

  async function refreshRadar({ keepPosition = false } = {}) {
    const layer = WEATHER_LAYERS.find((l) => l.id === state.weatherLayer) || WEATHER_LAYERS[0];
    let frames;
    try {
      frames = await loadRadarFrames(layer);
    } catch (err) {
      console.warn('ナウキャストの時刻一覧を読み込めませんでした:', err);
      $('#radar-time').textContent = '雨雲などの情報を読み込めませんでした';
      return;
    }
    if (!frames.length) return;
    const prev = state.radarFrames[state.radarIndex];
    state.radarFrames = frames;
    // 既定は「今」（実況の最新）。読み直したときは同じ時刻を保つ
    const latestObs = frames.map((f) => !f.forecast).lastIndexOf(true);
    const same = keepPosition && prev ? frames.findIndex((f) => f.validtime === prev.validtime) : -1;
    state.radarIndex = same >= 0 ? same : Math.max(0, latestObs);
    const slider = $('#radar-slider');
    slider.max = String(frames.length - 1);
    slider.value = String(state.radarIndex);
    showRadarFrame();
  }

  function showRadarFrame() {
    const layer = WEATHER_LAYERS.find((l) => l.id === state.weatherLayer) || WEATHER_LAYERS[0];
    const frame = state.radarFrames[state.radarIndex];
    if (!frame) return;
    if (!state.weatherMap) {
      const { map, box } = createOverlayMap({ className: 'weather-overlay', tiles: radarTiles(frame, layer.element), maxzoom: 10 });
      state.weatherMap = map;
      state.weatherBox = box;
    } else {
      const src = state.weatherMap.getSource('tiles');
      if (src && src.setTiles) src.setTiles(radarTiles(frame, layer.element));
    }
    state.weatherBox.hidden = false;
    const t = jmaTime(frame.validtime);
    $('#radar-time').textContent = `${hhmm(t)}（${frame.forecast ? '予報' : '実況'}）`;
    $('#radar-time').classList.toggle('is-forecast', frame.forecast);
  }

  function stopRadarAnimation() {
    clearInterval(state.radarTimer);
    state.radarTimer = 0;
    const btn = $('#radar-play');
    if (btn) btn.textContent = '▶ 再生';
  }

  function toggleRadarAnimation() {
    if (state.radarTimer) {
      stopRadarAnimation();
      return;
    }
    $('#radar-play').textContent = '⏸ 停止';
    state.radarTimer = setInterval(() => {
      state.radarIndex = (state.radarIndex + 1) % state.radarFrames.length;
      $('#radar-slider').value = String(state.radarIndex);
      showRadarFrame();
    }, 700);
  }

  function renderWeatherLegend() {
    const layer = WEATHER_LAYERS.find((l) => l.id === state.weatherLayer) || WEATHER_LAYERS[0];
    const legend = $('#radar-legend');
    if (layer.legend) {
      legend.replaceChildren(...layer.legend.map(([color, label]) => {
        const sw = el('span', { className: 'hazard-swatch' });
        sw.style.background = color;
        return el('li', {}, sw, label);
      }));
    } else {
      legend.replaceChildren(el('li', { className: 'hazard-legend-note' }, '色の意味は ',
        el('a', { href: JMA_PAGE, target: '_blank', rel: 'noopener' }, '気象庁のナウキャスト'), ' の凡例をご覧ください。'));
    }
  }

  // ---- 洗濯指数（このアプリ独自の目安） ----
  // 日中（9〜15時）の気温・湿度・風・日照と、降水確率・降水量から 0〜100 の点数を出し、5段階にする。
  function laundryScore(day) {
    let score = 40;
    score += (day.tempMax - 15) * 2;
    score += (60 - day.humidity) * 0.8;
    score += Math.min(day.wind, 6) * 3;
    score += day.sunshineHours * 4;
    score -= day.popMax * 0.6;
    if (day.precip >= 1) score = Math.min(score, 30); // 雨が降る日はよくても「やや乾きにくい」まで
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  const LAUNDRY_LEVELS = [
    { min: 80, level: 5, icon: '👕☀️', label: '大変よく乾く', note: '厚手のものも乾きやすい日です。' },
    { min: 60, level: 4, icon: '👕', label: 'よく乾く', note: '外干しに向いています。' },
    { min: 40, level: 3, icon: '🧺', label: '乾く', note: '厚手のものは乾きにくいかもしれません。' },
    { min: 20, level: 2, icon: '🌥', label: 'やや乾きにくい', note: '部屋干しや乾燥機の併用がおすすめです。' },
    { min: 0, level: 1, icon: '☔', label: '部屋干し推奨', note: '外干しには向かない日です。' },
  ];

  function laundryDays(om) {
    const days = [];
    om.daily.time.forEach((date, i) => {
      const idx = om.hourly.time.map((t, j) => [t, j]).filter(([t]) => t.startsWith(date))
        .filter(([t]) => { const h = +t.slice(11, 13); return h >= 9 && h <= 15; }).map(([, j]) => j);
      const avg = (key) => idx.reduce((a, j) => a + om.hourly[key][j], 0) / Math.max(1, idx.length);
      const day = {
        date,
        tempMax: om.daily.temperature_2m_max[i],
        humidity: avg('relative_humidity_2m'),
        wind: avg('wind_speed_10m'),
        sunshineHours: idx.reduce((a, j) => a + om.hourly.sunshine_duration[j], 0) / 3600,
        popMax: om.daily.precipitation_probability_max[i] ?? 0,
        precip: om.daily.precipitation_sum[i] ?? 0,
      };
      day.score = laundryScore(day);
      day.level = LAUNDRY_LEVELS.find((l) => day.score >= l.min);
      days.push(day);
    });
    return days;
  }

  async function loadForecastInfo() {
    const om = `https://api.open-meteo.com/v1/forecast?latitude=${CITY.point.lat}&longitude=${CITY.point.lng}`
      + '&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation_probability,precipitation,sunshine_duration'
      + '&daily=sunshine_duration,precipitation_sum,precipitation_probability_max,temperature_2m_max'
      + '&timezone=Asia%2FTokyo&forecast_days=2&wind_speed_unit=ms';
    const [forecast, warning, meteo] = await Promise.allSettled([
      loadJSON(`${JMA}/forecast/data/forecast/${CITY.jma.office}.json?t=${Date.now()}`),
      // 新しい防災気象情報（2026年5月下旬から）のデータ。以前の warning/data/warning/ は更新が止まっている
      loadJSON(`${JMA}/warning/data/r8/${CITY.jma.office}.json?t=${Date.now()}`),
      loadJSON(om),
    ]);
    renderForecast(forecast.status === 'fulfilled' ? forecast.value : null);
    renderWarnings(warning.status === 'fulfilled' ? warning.value : null);
    renderLaundry(meteo.status === 'fulfilled' ? meteo.value : null);
  }

  function renderForecast(data) {
    const box = $('#wx-forecast');
    if (!data) {
      box.replaceChildren(el('p', { className: 'wx-note' }, '天気予報を読み込めませんでした。'));
      return;
    }
    const series = data[0].timeSeries;
    const area = series[0].areas.find((a) => a.area.code === CITY.jma.forecastArea) || series[0].areas[0];
    const pops = (series[1].areas.find((a) => a.area.code === CITY.jma.forecastArea) || series[1].areas[0]);
    const temps = (series[2].areas.find((a) => a.area.code === CITY.jma.tempPoint) || series[2].areas[0]);
    const rows = series[0].timeDefines.slice(0, 2).map((t, i) => {
      const date = new Date(t);
      const label = i === 0 ? '今日' : '明日';
      const dayKey = date.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const popVals = series[1].timeDefines.map((pt, j) => [pt, pops.pops[j]])
        .filter(([pt]) => new Date(pt).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }) === dayKey)
        .map(([, v]) => v).filter((v) => v !== '');
      // 気温は 0時の値が最低、9時の値が最高。昼・夕方の発表では、今日の分は 9時→0時 の順に並び、
      // この 0時の値は最低気温ではない（最高と同じ値などが入る）ので使わない
      const indexAt = (hour) => series[2].timeDefines.findIndex((tt) => {
        const d = new Date(tt);
        return d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }) === dayKey
          && Number(d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false }).replace(/\D/g, '')) === hour;
      });
      const valueAt = (j) => (j >= 0 && temps.temps[j] !== '' ? Number(temps.temps[j]) : null);
      const iMin = indexAt(0);
      const iMax = indexAt(9);
      const tMin = iMax >= 0 && iMin > iMax ? null : valueAt(iMin);
      const tMax = valueAt(iMax);
      const tempText = [tMin != null && tMin !== tMax ? `最低 ${tMin}℃` : '', tMax != null ? `最高 ${tMax}℃` : ''].filter(Boolean).join('／');
      return el('li', { className: 'wx-day' },
        el('span', { className: 'wx-day-label' }, label),
        el('span', { className: 'wx-weather' }, area.weathers[i].replace(/\s+/g, ' ')),
        el('span', { className: 'wx-sub' }, [popVals.length ? `降水確率 ${popVals.map((v) => `${v}%`).join('・')}` : '', tempText].filter(Boolean).join('　')));
    });
    box.replaceChildren(el('ul', { className: 'wx-days' }, ...rows),
      el('p', { className: 'wx-note' }, `${formatDate(data[0].reportDatetime)} ${data[0].publishingOffice}発表（${CITY.jma.forecastAreaName}・気温は「${CITY.jma.tempPointName}」）`));
  }

  // data: 気象庁の報（大雨、風、波などの種類ごと）の配列。どの報も、区域ごとに今発表中のものが書かれている
  function renderWarnings(data) {
    const box = $('#wx-warnings');
    if (!Array.isArray(data)) {
      box.replaceChildren(el('p', { className: 'wx-note' }, '警報・注意報を読み込めませんでした。'));
      return;
    }
    // 仙台市のように市が「東部」「西部」などに分かれて発表されることがあるので、区域ごとに集める
    const areas = CITY.jma.warningAreas;
    const rows = areas.map((x) => {
      const codes = new Set();
      data.forEach((report) => ((report.warning && report.warning.class20Items) || []).forEach((item) => {
        if (item.areaCode !== x.code) return;
        item.kinds.forEach((k) => { if (k.code && !WARNING_INACTIVE.includes(k.status)) codes.add(k.code); });
      }));
      return { ...x, codes: [...codes] };
    }).filter((x) => x.codes.length);
    const latest = data.map((r) => r.reportDatetime).filter(Boolean).sort().pop();
    if (!rows.length) {
      box.replaceChildren(el('p', { className: 'wx-ok' }, `✅ ${CITY.name}に発表中の警報・注意報はありません`),
        el('p', { className: 'wx-note' }, `${formatDate(latest)} までの発表を確認。`));
      return;
    }
    const chips = (codes) => codes.map((code) => {
      const name = WARNING_NAMES[code] || WARNING_NAMES[Number(code)] || `コード${code}`;
      const kind = name.includes('特別警報') ? 'special' : name.includes('危険警報') ? 'danger'
        : name.includes('警報') ? 'warning' : 'advisory';
      return el('li', { className: `wx-warning is-${kind}` }, name);
    });
    // 東京23区のように区域が多いときは、同じ警報・注意報が出ている区域をまとめて表示する
    const groups = [];
    rows.forEach((x) => {
      const key = [...x.codes].sort().join(',');
      const g = groups.find((gr) => gr.key === key);
      if (g) g.names.push(x.name);
      else groups.push({ key, codes: x.codes, names: [x.name] });
    });
    const label = (names) => (areas.length > 2 && names.length === areas.length ? `${CITY.wardsText}すべて` : names.join('・'));
    const lists = groups.flatMap((g) => [
      ...(areas.length > 1 ? [el('p', { className: 'wx-sub' }, label(g.names))] : []),
      el('ul', { className: 'wx-warning-list' }, ...chips(g.codes)),
    ]);
    box.replaceChildren(el('p', { className: 'wx-subtitle' }, `⚠️ ${CITY.name}に発表中`), ...lists,
      el('p', { className: 'wx-note' }, `${formatDate(latest)} 発表。`,
        el('a', { href: `${JMA}/warning/#area_type=class20s&area_code=${rows[0].code}`, target: '_blank', rel: 'noopener' }, '気象庁で詳しく見る')));
  }

  function renderLaundry(om) {
    const box = $('#wx-laundry');
    if (!om) {
      box.replaceChildren(el('p', { className: 'wx-note' }, '洗濯指数の元になる予報を読み込めませんでした。'));
      return;
    }
    const days = laundryDays(om);
    const cards = days.map((d, i) => el('li', { className: `wx-laundry-card level-${d.level.level}` },
      el('span', { className: 'wx-day-label' }, i === 0 ? '今日' : '明日'),
      el('span', { className: 'wx-laundry-icon', 'aria-hidden': 'true' }, d.level.icon),
      el('span', { className: 'wx-laundry-label' }, `${d.level.label}（指数 ${d.score}）`),
      el('span', { className: 'wx-meter', 'aria-hidden': 'true' }, ...[1, 2, 3, 4, 5].map((n) => el('span', { className: n <= d.level.level ? 'on' : '' }))),
      el('span', { className: 'wx-sub' }, d.level.note),
      el('span', { className: 'wx-sub' }, `日中の湿度 ${Math.round(d.humidity)}%・風 ${d.wind.toFixed(1)}m/s・日照 ${d.sunshineHours.toFixed(1)}時間・最高 ${Math.round(d.tempMax)}℃・降水確率 ${d.popMax}%`)));
    box.replaceChildren(el('ul', { className: 'wx-laundry-list' }, ...cards),
      el('p', { className: 'wx-note' }, '洗濯指数はこのアプリ独自の目安です（',
        el('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener' }, 'Open-Meteo'),
        ' の予報の気温・湿度・風・日照・降水から計算）。'));
  }

  // ---- 地震情報 ----
  function parseEpicenter(cod) {
    // 「+35.8+140.1-70000/」→ 緯度・経度・深さ(km)
    const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+)?/.exec(cod || '');
    if (!m) return null;
    return { lat: Number(m[1]), lng: Number(m[2]), depthKm: m[3] ? Math.abs(Number(m[3])) / 1000 : null };
  }

  const INTENSITY_LABELS = { 1: '1', 2: '2', 3: '3', 4: '4', '5-': '5弱', '5+': '5強', '6-': '6弱', '6+': '6強', 7: '7' };
  const INTENSITY_ORDER = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];

  function cityIntensity(q) {
    let best = null;
    (q.int || []).forEach((p) => (p.city || []).forEach((c) => {
      if (CITY.jma.wardCodes.includes(c.code) && (!best || INTENSITY_ORDER.indexOf(c.maxi) > INTENSITY_ORDER.indexOf(best))) best = c.maxi;
    }));
    return best;
  }

  async function loadQuakes() {
    const box = $('#wx-quakes');
    let list;
    try {
      list = await loadJSON(`${JMA}/quake/data/list.json?t=${Date.now()}`);
    } catch (err) {
      box.replaceChildren(el('p', { className: 'wx-note' }, '地震情報を読み込めませんでした。'));
      return;
    }
    // 同じ地震（eid）の最新の情報だけを、震源と震度のそろったものから使う
    const byEvent = new Map();
    list.forEach((q) => {
      if (!q.cod || !q.mag || !['震源・震度情報', '震源に関する情報'].includes(q.ttl)) return;
      if (!byEvent.has(q.eid)) byEvent.set(q.eid, q);
    });
    const all = [...byEvent.values()];
    const quakes = all.slice(0, 15);
    state.quakes = quakes;
    const lastFelt = all.find((q) => cityIntensity(q));
    const items = quakes.map((q) => {
      const local = cityIntensity(q);
      const ep = parseEpicenter(q.cod);
      const li = el('li', { className: `wx-quake${local ? ' felt' : ''}` },
        el('span', { className: `wx-shindo s${(q.maxi || '').replace('+', 'p').replace('-', 'm')}` }, INTENSITY_LABELS[q.maxi] || '-'),
        el('span', { className: 'wx-quake-text' },
          el('b', {}, q.anm), ` M${q.mag}${ep && ep.depthKm != null ? `・深さ${Math.round(ep.depthKm)}km` : ''}`, el('br'),
          el('span', { className: 'wx-sub' }, `${formatDate(q.at)}　${local ? `${CITY.name}の震度 ${INTENSITY_LABELS[local]}` : `${CITY.name}では震度1以上なし`}`)));
      return li;
    });
    const feltLine = lastFelt
      ? el('p', { className: 'wx-felt' }, `🏠 直近で${CITY.name}が揺れた地震: ${formatDate(lastFelt.at)} ${lastFelt.anm} M${lastFelt.mag}（${CITY.name}の震度 ${INTENSITY_LABELS[cityIntensity(lastFelt)]}）`)
      : el('p', { className: 'wx-felt' }, `🏠 最近の情報の中に、${CITY.name}で震度1以上の地震はありません。`);
    box.replaceChildren(
      feltLine,
      el('p', { className: 'wx-subtitle' }, '最近の地震（全国・左の数字は最大震度）'),
      el('ul', { className: 'wx-quake-list' }, ...items),
      el('p', { className: 'wx-note' }, `気象庁の地震情報。${CITY.name}の震度は${CITY.wardsText}のうち最も大きいもの。`,
        el('a', { href: `${JMA}/map.html#contents=earthquake_map`, target: '_blank', rel: 'noopener' }, '気象庁で詳しく見る')));
    renderQuakeMarkers(quakes);
  }

  // 地図に映る範囲に震源がある地震だけ、震源の印を出す
  function renderQuakeMarkers(quakes) {
    (state.quakeMarkers || []).forEach((m) => m.remove());
    state.quakeMarkers = [];
    if (!state.weatherVisible || state.weatherTab !== 'quake') return;
    const bounds = state.map.getMaxBounds();
    quakes.forEach((q) => {
      const ep = parseEpicenter(q.cod);
      if (!ep || (bounds && !bounds.contains([ep.lng, ep.lat]))) return;
      const elx = el('div', { className: 'quake-marker', title: `${q.anm} M${q.mag}` });
      elx.style.setProperty('--size', `${14 + Number(q.mag) * 6}px`);
      elx.append(el('span', {}, '×'));
      state.quakeMarkers.push(new maplibregl.Marker({ element: elx, ...MARKER_OPTIONS }).setLngLat([ep.lng, ep.lat]).addTo(state.map));
    });
  }

  function setWeatherTab(tab) {
    state.weatherTab = tab;
    document.querySelectorAll('.wx-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('.wx-pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    // 雨雲の重ね合わせは「雨雲」タブのときだけ出す（ほかのタブでは地図を見やすく）
    if (state.weatherBox) state.weatherBox.hidden = tab !== 'radar';
    if (tab !== 'radar') stopRadarAnimation();
    if (tab === 'radar') refreshRadar({ keepPosition: true });
    if (tab === 'forecast') loadForecastInfo();
    if (tab === 'quake') loadQuakes();
    else renderQuakeMarkers([]);
  }

  function setWeatherVisible(visible) {
    state.weatherVisible = visible;
    const btn = $('#weather-toggle');
    if (btn) btn.setAttribute('aria-pressed', String(visible));
    $('#weather-panel').hidden = !visible;
    clearInterval(state.weatherRefreshTimer);
    if (visible) {
      if (!$('#weather-layer').options.length) bindWeatherPanel();
      setWeatherTab(state.weatherTab);
      // 開いている間は5分ごとに読み直す（ナウキャストは5分ごとに更新される）
      state.weatherRefreshTimer = setInterval(() => setWeatherTab(state.weatherTab), WEATHER_REFRESH_MS);
    } else {
      stopRadarAnimation();
      if (state.weatherBox) state.weatherBox.hidden = true;
      renderQuakeMarkers([]);
    }
  }

  function bindWeatherPanel() {
    const select = $('#weather-layer');
    WEATHER_LAYERS.forEach((l) => select.append(el('option', { value: l.id }, l.label)));
    select.value = state.weatherLayer;
    select.addEventListener('change', () => {
      state.weatherLayer = select.value;
      stopRadarAnimation();
      renderWeatherLegend();
      refreshRadar();
    });
    $('#radar-slider').addEventListener('input', (e) => {
      stopRadarAnimation();
      state.radarIndex = Number(e.target.value);
      showRadarFrame();
    });
    $('#radar-play').addEventListener('click', toggleRadarAnimation);
    $('#weather-strength').addEventListener('input', (e) => {
      if (state.weatherBox) state.weatherBox.style.opacity = String(Number(e.target.value) / 100);
    });
    document.querySelectorAll('.wx-tab').forEach((b) => b.addEventListener('click', () => setWeatherTab(b.dataset.tab)));
    $('#weather-close').addEventListener('click', () => setWeatherVisible(false));
    renderWeatherLegend();
  }

  // ---------- ライブカメラ ----------
  // 地図右上の 📹 ボタンで、ライブカメラの場所の表示・非表示を切り替える
  class LiveCamControl {
    onAdd() {
      this._container = document.createElement('div');
      this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group livecam-ctrl';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'livecam-toggle';
      btn.title = 'ライブカメラの場所を表示';
      btn.setAttribute('aria-label', 'ライブカメラの場所を表示');
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = '📹 カメラ';
      btn.addEventListener('click', () => setCamsVisible(!state.camsVisible));
      this._container.appendChild(btn);
      return this._container;
    }
    onRemove() {
      this._container.remove();
    }
  }

  // fit: すべてのカメラが入る範囲まで寄るか（起動時は寄らない）
  function setCamsVisible(visible, { fit = true } = {}) {
    const cams = (state.livecams && state.livecams.cameras) || [];
    if (visible && !cams.length) {
      if (fit) showToast('ライブカメラの情報を読み込めませんでした。');
      return;
    }
    state.camsVisible = visible;
    const btn = $('#livecam-toggle');
    if (btn) {
      btn.setAttribute('aria-pressed', String(visible));
      btn.title = visible ? 'ライブカメラの場所を隠す' : 'ライブカメラの場所を表示';
    }
    if (visible && !state.camMarkers.length) {
      cams.forEach(createCamMarker);
    }
    updateCamMarkers();
    if (visible && fit) {
      fitToCams();
      showToast(`📹 ライブカメラ ${cams.length}か所を表示しました。カメラを押すと映像が見られます。`);
    } else if (!visible) {
      closeCam();
    }
  }

  // 画面上で近いカメラ同士は重なって押せないため、まとめたボタン（📹 N）にする。押すとその範囲へ寄る
  const CAM_CLUSTER_PX = CITY.camClusterPx || 56; // カメラの多い市（東京23区）は city.js で広げる

  function updateCamMarkers() {
    if (!state.map) return;
    state.camClusterMarkers.forEach((m) => m.remove());
    state.camClusterMarkers = [];
    if (!state.camsVisible) {
      state.camMarkers.forEach(({ marker }) => marker.remove());
      return;
    }
    const groups = [];
    state.camMarkers.forEach((item) => {
      const p = state.map.project([item.cam.lng, item.cam.lat]);
      const g = groups.find((gr) => Math.hypot(gr.x - p.x, gr.y - p.y) < CAM_CLUSTER_PX);
      if (g) g.items.push(item);
      else groups.push({ x: p.x, y: p.y, items: [item] });
    });
    groups.forEach((g) => {
      if (g.items.length === 1) {
        g.items[0].marker.addTo(state.map);
        return;
      }
      g.items.forEach(({ marker }) => marker.remove());
      state.camClusterMarkers.push(createCamCluster(g.items.map((i) => i.cam)));
    });
  }

  function createCamCluster(cams) {
    const el = document.createElement('div');
    el.className = 'cam-marker cam-cluster';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cam-pin';
    btn.setAttribute('aria-label', `ライブカメラ ${cams.length}か所。押すと近づいて表示します`);
    btn.innerHTML = '<span class="cam-pin-icon" aria-hidden="true">📹</span>';
    btn.append(`ライブカメラ ${cams.length}`);
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      fitToCams(cams, { zoomIn: true });
    });
    el.appendChild(btn);
    const lng = cams.reduce((a, c) => a + c.lng, 0) / cams.length;
    const lat = cams.reduce((a, c) => a + c.lat, 0) / cams.length;
    return new maplibregl.Marker({ element: el, anchor: 'bottom', ...MARKER_OPTIONS }).setLngLat([lng, lat]).addTo(state.map);
  }

  // zoomIn: まとめたボタンから呼ばれたとき。範囲が狭くても今より必ず寄る
  function fitToCams(cams = state.livecams.cameras, { zoomIn = false } = {}) {
    const bounds = new maplibregl.LngLatBounds();
    cams.forEach((c) => bounds.extend([c.lng, c.lat]));
    const h = state.map.getContainer().clientHeight;
    const mobile = MOBILE_QUERY.matches;
    // 傾けると手前（画面下）が広がるので、下の余白を多めにとる
    const padding = mobile
      ? { top: 70, bottom: Math.round(h * 0.25), left: 50, right: 70 }
      : { top: 120, bottom: Math.round(h * 0.25), left: 200, right: 200 };
    const cam = state.map.cameraForBounds(bounds, { padding, maxZoom: 16 });
    let zoom = cam ? cam.zoom : state.map.getZoom() + 1;
    if (zoomIn) zoom = Math.max(zoom, state.map.getZoom() + 1);
    state.map.flyTo({ center: cam ? cam.center : bounds.getCenter(), zoom, pitch: 35, duration: 1400, essential: true });
  }

  function createCamMarker(cam) {
    const yt = cam.youtube || {};
    const el = document.createElement('div');
    el.className = 'cam-marker';
    el.dataset.id = cam.id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cam-pin';
    btn.setAttribute('aria-label', `${cam.title}を見る`);
    btn.innerHTML = `<span class="cam-pin-icon" aria-hidden="true">${CAM_ICONS[cam.type] || '📹'}</span><span class="cam-pin-label"></span>`;
    btn.classList.add(`cam-type-${cam.type || 'youtube'}`);
    btn.querySelector('.cam-pin-label').textContent = cam.title;
    if (yt.live) btn.classList.add('is-live');
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openCam(cam.id);
    });
    el.appendChild(btn);
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom', ...MARKER_OPTIONS }).setLngLat([cam.lng, cam.lat]);
    state.camMarkers.push({ marker, el, cam });
  }

  // カメラの種類ごとのピンのアイコン（youtube: 動画、image: 静止画、links/link: 配信元へのリンク）
  const CAM_ICONS = { youtube: '📹', image: '📷', links: '☁️', link: '🔗' };
  const CAM_IMAGE_REFRESH_MS = 60 * 1000;

  function camEmbedUrl(cam) {
    const yt = cam.youtube || {};
    // enablejsapi: 再生できないときのエラーを YouTube の IFrame Player API で受け取るため
    const params = `autoplay=1&mute=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
    // 自動の確認で見つけた配信中の動画を優先する（同じチャンネルが別の場所を配信していることがあるため）
    if (yt.live && yt.videoId) return `https://www.youtube.com/embed/${encodeURIComponent(yt.videoId)}?${params}`;
    // タイトルで配信を選ぶカメラは、チャンネルの「今の配信」だと別の場所が映るおそれがあるので使わない
    if (yt.channelId && !(yt.titleKeywords || []).length) {
      return `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(yt.channelId)}&${params}`;
    }
    return '';
  }

  function renderYouTubeCam(box, cam) {
    const yt = cam.youtube || {};
    if (yt.live && yt.embeddable === false) {
      showCamError(cam, 150);
      return;
    }
    const src = camEmbedUrl(cam);
    if (!src) {
      showCamError(cam, yt.channelId ? 100 : null);
      return;
    }
    const frame = el('iframe', {
      id: 'cam-frame',
      src,
      title: `${cam.title}（ライブ映像）`,
      allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
      allowfullscreen: '',
      referrerpolicy: 'strict-origin-when-cross-origin',
    });
    box.append(frame);
    watchYouTubeErrors(frame, cam);
  }

  // 定期的に更新される静止画（国土交通省の道路カメラなど）。上り・下りなど複数あるときは切り替えボタンを出す
  function renderImageCam(box, cam) {
    const wrap = el('div', { className: 'cam-image-wrap' });
    const img = el('img', { className: 'cam-image', alt: `${cam.title}の最新の画像` });
    const tabs = el('div', { className: 'cam-tabs' });
    let current = 0;
    const show = () => {
      // 同じURLのまま新しい画像を読み込むため、時刻を付けてキャッシュを避ける
      const url = cam.images[current].url;
      img.src = `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / CAM_IMAGE_REFRESH_MS)}`;
      [...tabs.children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === current)));
    };
    img.addEventListener('error', () => {
      if (img.isConnected) showCamError(cam, 'image');
    });
    if (cam.images.length > 1) {
      cam.images.forEach((im, i) => {
        const b = el('button', { type: 'button', className: 'cam-tab', 'aria-pressed': 'false' }, im.label);
        b.addEventListener('click', () => { current = i; show(); });
        tabs.append(b);
      });
      wrap.append(tabs);
    }
    wrap.append(img, el('p', { className: 'cam-credit' }, `画像: ${cam.provider}（約1分ごとに読み直します）`));
    box.append(wrap);
    show();
    clearInterval(state.camImageTimer);
    state.camImageTimer = setInterval(() => {
      if (img.isConnected) show();
      else clearInterval(state.camImageTimer);
    }, CAM_IMAGE_REFRESH_MS);
  }

  // 配信元のページでしか見られないカメラ（利用規約で転載できない、埋め込みが許可されていないなど）
  function renderLinkCam(box, cam) {
    const links = cam.type === 'links' ? cam.links : [{ label: `${cam.title}（${cam.provider}）`, url: cam.siteUrl }];
    const list = el('ul', { className: 'cam-link-list' });
    links.forEach((l) => list.append(el('li', {}, el('a', {
      className: 'cam-btn cam-open-site', href: l.url, target: '_blank', rel: 'noopener',
    }, `▶ ${l.label}`))));
    box.append(el('div', { className: 'cam-empty cam-links' },
      el('p', {}, 'このカメラは配信元のサイトで見られます。'), list));
  }

  function openCam(id) {
    const cam = state.livecams.cameras.find((c) => c.id === id);
    if (!cam) return;
    // スマホでは下部シートが重なるので、トピックの詳細は閉じる
    if (MOBILE_QUERY.matches && !$('#detail-panel').hidden) closeDetail({ restoreView: false });
    state.activeCamId = id;
    state.camMarkers.forEach(({ el }) => el.classList.toggle('active', el.dataset.id === id));

    const yt = cam.youtube || {};
    $('#cam-title').textContent = cam.title;
    $('#cam-live').hidden = !yt.live;
    const site = $('#cam-site');
    site.href = cam.siteUrl;
    site.title = `${cam.provider} の配信ページを開く`;

    const box = $('#cam-video');
    box.replaceChildren();
    clearInterval(state.camImageTimer);
    const type = cam.type || 'youtube';
    if (type === 'youtube') renderYouTubeCam(box, cam);
    else if (type === 'image') renderImageCam(box, cam);
    else renderLinkCam(box, cam);

    const checked = state.livecams.checkedAt ? formatDate(state.livecams.checkedAt) : '';
    let status = '';
    if (type === 'youtube') {
      status = checked && yt.live ? `${checked} 時点で配信中でした。` : '配信時間外は映像が出ません。';
    }
    const note = $('#cam-note');
    note.replaceChildren(
      el('span', {}, `📍 ${cam.ward}付近（地図上の位置はおおよそ）・配信: ${cam.provider}。${status}`),
      el('br'),
      el('span', {}, cam.description),
    );
    const links = state.livecams.officialLinks || [];
    if (links.length) {
      note.append(el('br'), el('span', {}, '河川の監視カメラ（静止画）: '));
      links.forEach((l, i) => {
        if (i) note.append('・');
        note.append(el('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.label));
      });
    }
    $('#cam-panel').hidden = false;
    $('.app-main').classList.add('cam-open');
  }

  // ---- YouTube の再生エラー（「この動画は再生できません」など）を受け取って、分かりやすい案内に差し替える ----
  let ytApiPromise = null;
  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (!ytApiPromise) {
      ytApiPromise = new Promise((resolve, reject) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          if (typeof prev === 'function') prev();
          resolve(window.YT);
        };
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        tag.onerror = () => reject(new Error('YouTube IFrame API を読み込めませんでした'));
        document.head.appendChild(tag);
      });
    }
    return ytApiPromise;
  }

  function watchYouTubeErrors(frame, cam) {
    loadYouTubeApi().then((YT) => {
      if (!frame.isConnected) return; // もう別のカメラに切り替わった
      // eslint-disable-next-line no-new
      new YT.Player(frame, {
        events: {
          onError: (e) => {
            if (frame.isConnected && state.activeCamId === cam.id) showCamError(cam, e.data);
          },
        },
      });
    }).catch((err) => console.warn(err.message));
  }

  // code: YouTube のエラー番号（101・150 は埋め込み不可、100 は見つからない／配信していない）
  function showCamError(cam, code) {
    const box = $('#cam-video');
    let msg;
    if (code === 'image') {
      msg = '画像を読み込めませんでした（点検などで更新が止まっていることがあります）。';
    } else if (code === 101 || code === 150 || code === 152) {
      msg = 'このカメラは、配信元の設定により、このサイトの中では再生できません。YouTube で直接見てください。';
    } else if (code === 100) {
      msg = '今は配信していないか、配信が見つかりませんでした。配信時間外の可能性があります。';
    } else if (code == null) {
      msg = '映像を読み込めませんでした。';
    } else {
      msg = `映像を再生できませんでした（エラー ${code}）。`;
    }
    const link = el('a', { className: 'cam-btn cam-open-site', href: cam.siteUrl, target: '_blank', rel: 'noopener' }, '▶ 配信サイトで見る');
    box.replaceChildren(el('div', { className: 'cam-empty' }, el('p', {}, msg), link));
  }

  function closeCam() {
    clearInterval(state.camImageTimer);
    $('#cam-panel').hidden = true;
    $('#cam-video').replaceChildren(); // 映像を止める
    $('.app-main').classList.remove('cam-open');
    state.activeCamId = null;
    state.camMarkers.forEach(({ el }) => el.classList.remove('active'));
  }

  function resetView() {
    closeDetail({ restoreView: false });
    state.map.flyTo({ ...INITIAL_VIEW, zoom: initialZoom(), duration: 1800, essential: true });
  }

  // ---------- 吹き出しマーカー ----------
  function buildMarkers() {
    state.topics.forEach(createMarker);
    state.markersReady = true;
    applyFilter();
  }

  function createMarker(topic) {
    const cat = state.data.categories[topic.category];
    const el = document.createElement('div');
    el.className = topic.news ? 'topic-marker is-news' : 'topic-marker';
    el.dataset.id = topic.id;
    el.dataset.category = topic.category;
    el.style.setProperty('--cat', cat.color);

    const inner = document.createElement('div');
    inner.className = 'marker-inner';

    const bubble = document.createElement('button');
    bubble.type = 'button';
    bubble.className = 'bubble';
    bubble.setAttribute('aria-label', `${topic.title}（${cat.label}）の詳細を見る`);
    bubble.innerHTML = `
      <span class="bubble-icon" aria-hidden="true">${(topic.news && topic.news.typeIcon) || cat.icon}</span>
      <span class="bubble-text">
        <span class="bubble-title"></span>
        <span class="bubble-line"></span>
      </span>`;
    if (topic.news) {
      const tag = document.createElement('span');
      tag.className = 'news-tag';
      tag.textContent = cat.tag || 'NEWS';
      bubble.querySelector('.bubble-text').prepend(tag);
    }
    bubble.querySelector('.bubble-title').textContent = topic.title;
    bubble.querySelector('.bubble-line').textContent = topic.bubble;

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'dot';
    dot.title = topic.title;
    dot.setAttribute('aria-label', `${topic.title}の詳細を見る`);
    dot.textContent = (topic.news && topic.news.typeIcon) || cat.icon;

    const pin = document.createElement('span');
    pin.className = 'pin';

    inner.append(bubble, dot, pin);
    el.appendChild(inner);

    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectTopic(topic.id);
    });

    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, 7], ...MARKER_OPTIONS })
      .setLngLat([topic.lng, topic.lat])
      .addTo(state.map);

    state.markers.set(topic.id, { marker, el, bubble, topic });
  }

  function updateZoomClass() {
    const z = state.map.getZoom();
    const container = state.map.getContainer();
    container.classList.toggle('zoom-far', z < 12.6);
    // ズームに応じて吹き出しを拡大縮小（ズームアウト時は小さく）
    const scale = Math.max(0.78, Math.min(1.08, 0.78 + (z - 11.5) * 0.1));
    container.style.setProperty('--bubble-scale', scale.toFixed(3));
    state.scale = scale;
  }

  function scheduleCollision() {
    if (state.collisionFrame) return;
    state.collisionFrame = requestAnimationFrame(() => {
      state.collisionFrame = 0;
      resolveCollisions();
    });
  }

  // 優先度の高い吹き出しから順に配置し、重なるものは小さな丸アイコンにする
  function resolveCollisions() {
    const map = state.map;
    if (!map || !state.markers.size) return;
    const scale = state.scale || 1;
    const { width: cw, height: ch } = map.getContainer().getBoundingClientRect();
    const placed = []; // 吹き出し＋丸アイコン
    const bubbles = []; // 吹き出しのみ
    const margin = 4;

    const items = [...state.markers.values()]
      .filter((m) => !m.el.classList.contains('is-filtered'))
      .map((m, i) => ({ m, i, p: map.project(m.marker.getLngLat()) }))
      .sort((a, b) => rank(a.m.topic) - rank(b.m.topic) || a.i - b.i);

    for (const { m, p } of items) {
      const w = m.bubble.offsetWidth * scale;
      const h = (m.bubble.offsetHeight + 22) * scale;
      const box = { x1: p.x - w / 2 - margin, x2: p.x + w / 2 + margin, y1: p.y - h - margin, y2: p.y + margin };
      const offscreen = box.x2 < 0 || box.x1 > cw || box.y2 < 0 || box.y1 > ch;
      const collapsed = !offscreen && placed.some((b) => overlaps(b, box));
      let tucked = false;
      if (!offscreen) {
        if (!collapsed) {
          placed.push(box);
          bubbles.push(box);
        } else {
          // 丸アイコンも場所を確保し、後から置く吹き出しに覆われないようにする。
          // 中心が既存の吹き出しの下に隠れる場合だけ非表示にする（ズームインすると現れる）
          const dotBox = { x1: p.x - 16, x2: p.x + 16, y1: p.y - 36, y2: p.y + 4 };
          const c = { x1: p.x, x2: p.x + 0.1, y1: p.y - 20, y2: p.y - 19.9 };
          tucked = bubbles.some((b) => overlaps(b, c));
          if (!tucked) placed.push(dotBox);
        }
      }
      m.el.classList.toggle('collapsed', collapsed);
      m.el.classList.toggle('tucked', tucked);
      // 吹き出しは丸アイコンより上、同種どうしは手前（画面下側）を上に重ねる。選択中は最前面
      m.el.style.zIndex = m.topic.id === state.activeId ? 100000 : String(Math.round(p.y) + (collapsed ? 1000 : 50000));
    }
  }

  function overlaps(a, b) {
    return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  }

  function rank(topic) {
    if (topic.id === state.activeId) return -1;
    return topic.priority || 3;
  }

  // ---------- 選択・詳細表示 ----------
  function selectTopic(id, { fly = true } = {}) {
    const topic = state.byId.get(id);
    if (!topic) return;

    // 絞り込みで非表示のトピックが選ばれたら、そのカテゴリを表示に戻す
    if (!state.activeCategories.has(topic.category)) {
      state.activeCategories.add(topic.category);
      syncChips();
      applyFilter();
    }

    if (state.activeId && state.markers.has(state.activeId)) {
      state.markers.get(state.activeId).el.classList.remove('active');
    }
    state.activeId = id;
    const entry = state.markers.get(id);
    if (entry) entry.el.classList.add('active');

    renderDetail(topic);
    highlightListItem(id);
    if (history.replaceState) history.replaceState(null, '', `#topic=${encodeURIComponent(id)}`);

    if (fly) {
      const map = state.map;
      // 最初のトピックを開く前の視点を覚えておき、閉じたときに戻す（トピックからトピックへ移っても最初の視点のまま）
      if (!state.savedView) {
        state.savedView = {
          center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
        };
      }
      const mobile = MOBILE_QUERY.matches;
      const detailW = $('#detail-panel').offsetWidth || 380;
      const ch = map.getContainer().clientHeight;
      map.flyTo({
        center: [topic.lng, topic.lat],
        zoom: Math.max(map.getZoom(), FOCUS_ZOOM),
        pitch: FOCUS_PITCH,
        bearing: map.getBearing(),
        // パネルに隠れないよう中心をずらす（スマホは下部シートの分だけ上へ）
        offset: mobile ? [0, -ch * 0.25] : [-(detailW + 104) / 2, 40],
        speed: 1.1,
        curve: 1.5,
        essential: true,
      });
    }
    scheduleCollision();
  }

  function renderDetail(topic) {
    const cat = state.data.categories[topic.category];
    const panel = $('#detail-panel');
    const badge = $('#detail-category');
    panel.style.setProperty('--cat', cat.color);
    badge.style.setProperty('--cat', cat.color);
    badge.textContent = `${cat.icon} ${cat.label}`;

    const body = $('#detail-body');
    body.replaceChildren();
    if (topic.news) renderNewsBody(body, topic);
    else renderTopicBody(body, topic);

    panel.hidden = false;
    body.scrollTop = 0;
    // スマホでは一覧・ライブカメラと詳細を同時に開かない
    if (MOBILE_QUERY.matches) {
      setListOpen(false);
      closeCam();
    }
  }

  function renderTopicBody(body, topic) {
    body.append(
      el('h2', { className: 'detail-title', id: 'detail-title' }, topic.title),
      el('p', { className: 'detail-ward' }, `📍 ${CITY.addressPrefix || CITY.name}${topic.ward}`),
      el('p', { className: 'detail-quote' }, topic.bubble),
      el('p', { className: 'detail-desc' }, topic.description),
    );

    const dl = el('dl', { className: 'info-table' });
    const addRow = (k, v) => { if (v) dl.append(el('dt', {}, k), el('dd', {}, v)); };
    addRow('年代', topic.era);
    addRow('アクセス', topic.access);
    if (topic.url) {
      const a = el('a', { href: topic.url, target: '_blank', rel: 'noopener' }, hostLabel(topic.url));
      addRow('公式・参考', a);
    }
    const gmap = el('a', {
      href: `https://www.google.com/maps/search/?api=1&query=${topic.lat},${topic.lng}`,
      target: '_blank',
      rel: 'noopener',
    }, '地図アプリで開く');
    addRow('位置', gmap);
    body.append(dl);

    const related = (topic.related || []).map((id) => state.byId.get(id)).filter(Boolean);
    if (related.length) {
      body.append(section('🔗 関連トピック', related.map((t) => relatedItem(t, topic))));
    }

    const relatedIds = new Set([topic.id, ...(topic.related || [])]);
    const nearby = nearest(topic, (t) => !t.news && !relatedIds.has(t.id), 3);
    if (nearby.length) {
      body.append(section('🧭 近くのトピック', nearby.map((t) => relatedItem(t, topic))));
    }

    const news = nearest(topic, (t) => t.news && distanceKm(topic, t) <= NEWS_NEARBY_KM, 5);
    if (news.length) {
      body.append(section('📰 この付近のニュース', news.map((t) => relatedItem(t, topic))));
    }
  }

  function renderNewsBody(body, topic) {
    const n = topic.news;
    const placeText = n.placeKind === 'city'
      ? `📍 ${CITY.name}全体の記事（地図上は${CITY.hallName || '市役所'}付近に表示）`
      : `📍 ${n.place}${n.ward && !n.place.endsWith(n.ward) ? `（${n.ward}）` : ''}付近`;
    body.append(
      el('h2', { className: 'detail-title news-title', id: 'detail-title' }, n.title),
      el('p', { className: 'detail-ward' }, placeText),
      el('p', { className: 'news-meta' }, `${n.source}｜${formatDate(n.published)}`),
    );
    if (n.typeLabel) {
      body.append(el('p', { className: 'type-badge' }, `${n.typeIcon || state.data.categories[topic.category].icon} ${n.typeLabel}`));
    }
    if (n.summary) body.append(el('p', { className: 'detail-desc' }, n.summary));
    if (topic.category === 'crime') {
      const police = el('a', { href: CITY.police.url, target: '_blank', rel: 'noopener' }, `${CITY.police.name}の公式サイト`);
      body.append(el('p', { className: 'crime-note' },
        '報道機関が伝えた警察発表などの情報です。地図の位置は記事中の地名からの推定で、事件の正確な発生場所ではありません。最新の正確な防犯情報は ',
        police, `${CITY.police.note || ''}で確認してください。`));
    }
    if (topic.category === 'wildlife' && CITY.wildlife) {
      const links = [];
      CITY.wildlife.links.forEach((l, i) => {
        if (i) links.push('・');
        links.push(el('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.label));
      });
      const note = n.official ? CITY.wildlife.officialNote : CITY.wildlife.note;
      body.append(el('p', { className: 'crime-note' }, note, ' 最新の出没情報は ', ...links, ' で確認してください。'));
      const alerts = activeBearAlerts();
      if (alerts.length) {
        body.append(el('p', { className: 'type-badge' }, `⚠️ 発令中：${alerts.map((a) => `${a.name}（${a.period}）`).join('・')}`));
      }
      if (n.official) {
        const src = (state.newsMeta.extras || []).map((x) => x.source).find(Boolean);
        if (src) body.append(el('p', { className: 'news-meta' }, `${src.label}${src.asOf ? `（${src.asOf}）` : ''}`));
      }
    }
    if (topic.category === 'supermarket') {
      const links = [];
      FLYER_SITES.forEach((f, i) => {
        if (i) links.push('・');
        links.push(el('a', { href: f.url, target: '_blank', rel: 'noopener' }, f.label));
      });
      body.append(el('p', { className: 'crime-note' },
        'スーパーのセール・新店などを伝える記事です。お店の毎週のチラシや特売の内容は、各店の公式サイトやチラシサイト（',
        ...links, '）で確認してください。'));
    }
    if (topic.category === 'reviews') {
      body.append(el('p', { className: 'crime-note' },
        `SNS（Bluesky・Misskey・Mastodon）に公開されている投稿を、地名の検索やハッシュタグ（${CITY.reviewsTag} など）から集めたものです。投稿者が${CITY.name}に住んでいるとは限らず、内容は投稿者個人の感想です。地図の位置は本文中の地名からの推定です。`));
    }

    body.append(el('a', { className: 'news-link', href: n.url, target: '_blank', rel: 'noopener noreferrer' },
      topic.category === 'reviews' ? '投稿を見る（外部サイト）' : n.official ? '宮城県の公式サイトへ（外部サイト）' : '記事を読む（外部サイト）'));

    const dl = el('dl', { className: 'info-table' });
    const addRow = (k, v) => { if (v) dl.append(el('dt', {}, k), el('dd', {}, v)); };
    addRow('分類', n.typeLabel ? `${state.data.categories[topic.category].label}／${n.typeLabel}` : state.data.categories[topic.category].label);
    addRow('配信元', n.source);
    addRow('配信日時', formatDate(n.published));
    addRow('位置の推定', n.official
      ? `地区名の「${n.matched}」のおおよその中心に表示（実際の発見地点ではありません）`
      : n.matched
      ? `記事中の「${n.matched}」から推定（実際の場所と異なる場合があります）`
      : `地名が見つからないため、${CITY.name}全体の記事として表示`);
    body.append(dl);

    const nearby = nearest(topic, (t) => !t.news, 3);
    if (nearby.length) {
      body.append(section('🧭 近くのトピック', nearby.map((t) => relatedItem(t, topic))));
    }
    const others = nearest(topic, (t) => t.news && t.id !== topic.id && distanceKm(topic, t) <= NEWS_NEARBY_KM, 5);
    if (others.length) {
      body.append(section('📰 この付近の他のニュース', others.map((t) => relatedItem(t, topic))));
    }
  }

  function nearest(from, pred, limit) {
    return state.topics
      .filter((t) => t.id !== from.id && pred(t))
      .map((t) => ({ t, d: distanceKm(from, t) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map(({ t }) => t);
  }

  function section(title, items) {
    const ul = el('ul', { className: 'related-list' });
    items.forEach((li) => ul.append(li));
    return el('div', { className: 'detail-section' }, el('h3', {}, title), ul);
  }

  function relatedItem(t, from) {
    const cat = state.data.categories[t.category];
    const btn = el('button', { type: 'button', className: 'topic-list-item' },
      el('span', { className: 'list-icon', 'aria-hidden': 'true' }, cat.icon),
      el('span', { className: 'list-text' },
        el('span', { className: 'list-title' }, t.title),
        el('span', { className: 'list-sub' }, t.news ? t.bubble : `${cat.label}・${t.ward}`)),
      el('span', { className: 'distance' }, formatDistance(distanceKm(from, t))));
    btn.style.setProperty('--cat', cat.color);
    btn.addEventListener('click', () => selectTopic(t.id));
    return el('li', {}, btn);
  }

  // restoreView: トピックを開く前の視点（ズーム・傾き・向き）に戻すか
  function closeDetail({ restoreView = true } = {}) {
    const wasOpen = !$('#detail-panel').hidden;
    $('#detail-panel').hidden = true;
    if (state.activeId && state.markers.has(state.activeId)) {
      state.markers.get(state.activeId).el.classList.remove('active');
    }
    state.activeId = null;
    highlightListItem(null);
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
    if (restoreView && wasOpen && state.savedView) {
      state.map.flyTo({ ...state.savedView, duration: 1400, essential: true });
    }
    state.savedView = null;
    scheduleCollision();
  }

  function openFromHash() {
    const m = location.hash.match(/topic=([^&]+)/);
    if (m) selectTopic(decodeURIComponent(m[1]));
  }

  // ---------- フィルタ・一覧・検索 ----------
  function buildFilters() {
    const wrap = $('#category-filters');
    const allBtn = el('button', { type: 'button', className: 'chip-all', id: 'chip-all' }, '');
    allBtn.addEventListener('click', () => {
      const all = Object.keys(state.data.categories);
      state.activeCategories = all.every((c) => state.activeCategories.has(c))
        ? new Set(DEFAULT_CATEGORIES)
        : new Set(all);
      syncChips();
      applyFilter();
    });
    wrap.append(allBtn);
    Object.entries(state.data.categories).forEach(([key, cat]) => {
      const chip = el('button', { type: 'button', className: 'chip', 'aria-pressed': 'true' },
        `${cat.icon} ${cat.label}`, el('span', { className: 'chip-count' }, ''));
      chip.dataset.category = key;
      chip.style.setProperty('--cat', cat.color);
      chip.title = `${cat.label}の表示を切り替え（ダブルクリックでこのカテゴリだけ表示）`;
      chip.addEventListener('click', () => {
        if (state.activeCategories.has(key)) state.activeCategories.delete(key);
        else state.activeCategories.add(key);
        syncChips();
        applyFilter();
      });
      chip.addEventListener('dblclick', () => {
        state.activeCategories = new Set([key]);
        syncChips();
        applyFilter();
      });
      wrap.append(chip);
    });
    updateChipCounts();
    syncChips();
  }

  function updateChipCounts() {
    document.querySelectorAll('.chip').forEach((chip) => {
      const count = state.topics.filter((t) => t.category === chip.dataset.category).length;
      chip.querySelector('.chip-count').textContent = String(count);
    });
  }

  function syncChips() {
    document.querySelectorAll('.chip').forEach((chip) => {
      chip.setAttribute('aria-pressed', String(state.activeCategories.has(chip.dataset.category)));
    });
    const allBtn = $('#chip-all');
    if (allBtn) {
      const allOn = Object.keys(state.data.categories).every((c) => state.activeCategories.has(c));
      allBtn.textContent = allOn ? '📰 ニュースだけに戻す' : '✅ すべて表示';
    }
  }

  function buildWardSelect() {
    const select = $('#ward-select');
    state.data.wards.forEach((w) => {
      const count = state.topics.filter((t) => !t.news && t.ward.includes(w.name)).length;
      select.append(el('option', { value: w.name }, `${w.name}（${count}件）`));
    });
    select.addEventListener('change', () => {
      const w = state.data.wards.find((x) => x.name === select.value);
      if (w) {
        state.map.flyTo({ center: [w.lng, w.lat], zoom: 13.6, pitch: 55, essential: true });
      }
      select.value = '';
    });
  }

  function buildList() {
    const ul = $('#topic-list');
    state.topics.forEach((t) => ul.append(createListItem(t)));
    ul.append(el('li', { className: 'empty-note', id: 'list-empty', hidden: true }, '該当するトピックがありません。'));
  }

  function createListItem(t) {
    const cat = state.data.categories[t.category];
    const sub = t.news ? `${t.bubble}｜${t.news.place}` : `${cat.label}・${t.ward}｜${t.bubble}`;
    const btn = el('button', { type: 'button', className: 'topic-list-item' },
      el('span', { className: 'list-icon', 'aria-hidden': 'true' }, cat.icon),
      el('span', { className: 'list-text' },
        el('span', { className: 'list-title' }, t.title),
        el('span', { className: 'list-sub' }, sub)));
    btn.style.setProperty('--cat', cat.color);
    btn.dataset.id = t.id;
    btn.addEventListener('click', () => selectTopic(t.id));
    const li = el('li', { className: t.news ? 'is-news' : '' }, btn);
    li.dataset.id = t.id;
    return li;
  }

  // ---------- ニュース ----------
  // data/news.json は GitHub Actions（scripts/fetch_news.py）が定期的に更新する
  async function loadNews() {
    let news;
    try {
      news = await loadJSON(`${NEWS_URL}?t=${Date.now()}`);
    } catch (err) {
      console.warn('ニュースを読み込めませんでした:', err);
      return null;
    }
    // city.js の extraFeeds（仙台市版の「宮城県のクマ目撃等情報」など）の記事も、ニュースと同じように並べる
    const extras = await Promise.all((CITY.extraFeeds || []).map((url) => loadJSON(`${url}?t=${Date.now()}`)
      .catch((err) => { console.warn(`${url} を読み込めませんでした:`, err); return null; })));
    news.extras = extras.filter(Boolean);
    news.items = [...(news.items || []), ...news.extras.flatMap((x) => x.items || [])];
    return news;
  }

  // 害獣出没（仙台市版）：宮城県のクマ出没注意報・警報が仙台市に出ていれば、起動時に一度だけ知らせる
  function activeBearAlerts() {
    return (state.newsMeta && state.newsMeta.extras || []).flatMap((x) => x.alerts || []).filter((a) => a.sendai);
  }

  function announceBearAlerts() {
    if (state.bearAlertShown) return;
    const alerts = activeBearAlerts();
    if (!alerts.length) return;
    state.bearAlertShown = true;
    showToast(`🐻 宮城県の${alerts.map((a) => `${a.name}（${a.period}）`).join('・')}が${CITY.name}に発令中です。「🐻 害獣出没」で最近の目撃情報を見られます。`);
  }

  async function refreshNews() {
    const btn = $('#news-refresh');
    if (btn) btn.disabled = true;
    const news = await loadNews();
    if (btn) btn.disabled = false;
    if (news) setNews(news);
    else showToast('ニュースを読み込めませんでした。');
  }

  function setNews(news) {
    const items = Array.isArray(news.items) ? news.items : [];
    const activeId = state.activeId;

    // 以前のニュースを取り除く
    state.topics.filter((t) => t.news).forEach((t) => {
      const m = state.markers.get(t.id);
      if (m) m.marker.remove();
      state.markers.delete(t.id);
      state.byId.delete(t.id);
      document.querySelector(`#topic-list li[data-id="${t.id}"]`)?.remove();
    });
    state.topics = state.topics.filter((t) => !t.news);

    const entries = items
      .filter((n) => Number.isFinite(n.lat) && Number.isFinite(n.lng) && n.title && n.url)
      .map((n) => ({
        id: n.id,
        category: FEED_CATEGORY_OF[n.category] || 'news',
        title: n.title,
        bubble: `${n.typeLabel ? `${n.typeLabel}｜` : ''}${n.source}・${formatRelative(n.published)}`,
        description: n.summary,
        ward: n.ward || '',
        lat: n.lat,
        lng: n.lng,
        priority: 2.5,
        news: n,
      }));

    // 一覧ではニュースを先頭に（新しい順）
    const ul = $('#topic-list');
    const firstTopic = ul.querySelector('li[data-id]');
    entries.forEach((t) => {
      state.topics.push(t);
      state.byId.set(t.id, t);
      if (state.markersReady) createMarker(t);
      ul.insertBefore(createListItem(t), firstTopic);
    });

    state.newsMeta = { generatedAt: news.generatedAt, sources: news.sources || [], extras: news.extras || [] };
    announceBearAlerts();
    renderNewsStatus(entries);
    buildTypeSelect(entries);
    updateChipCounts();
    applyFilter();

    if (activeId && state.byId.has(activeId)) {
      state.markers.get(activeId)?.el.classList.add('active');
      highlightListItem(activeId);
    } else if (activeId) {
      closeDetail();
    }
  }

  function renderNewsStatus(entries) {
    const box = $('#news-status-text');
    if (!box) return;
    const meta = state.newsMeta;
    if (!meta || !meta.generatedAt) {
      box.textContent = '📰 ニュースはまだ取得されていません（GitHub Actions で自動取得されます）';
      return;
    }
    const counts = Object.entries(FEED_CATEGORIES)
      .map(([id, c]) => `${c.icon}${c.label} ${entries.filter((t) => t.category === id).length}件`)
      .join('・');
    const google = meta.sources.some((s) => /Google/.test(s.name));
    const extraSources = (meta.extras || []).map((x) => x.source && x.source.label).filter(Boolean);
    box.textContent = `${counts}｜${formatDate(meta.generatedAt)} 更新${google ? '｜出典: Googleニュース検索' : ''}`
      + extraSources.map((l) => `｜${l}`).join('');
  }

  // オタク・事件・グルメの細かい分類（ジャンル）で絞り込むセレクトボックス
  function buildTypeSelect(entries) {
    const select = $('#type-select');
    if (!select) return;
    const current = state.typeFilter;
    select.replaceChildren(el('option', { value: '' }, '🍴 ジャンルで絞り込み…'));
    Object.entries(FEED_CATEGORIES).forEach(([catId, cat]) => {
      const types = new Map();
      entries.filter((t) => t.category === catId && t.news.type).forEach((t) => {
        const prev = types.get(t.news.type) || { label: t.news.typeLabel, icon: t.news.typeIcon, count: 0 };
        prev.count += 1;
        types.set(t.news.type, prev);
      });
      if (!types.size) return;
      const group = el('optgroup', { label: `${cat.icon} ${cat.label}` });
      types.forEach((v, id) => {
        group.append(el('option', { value: `${catId}:${id}` }, `${v.icon ? `${v.icon} ` : ''}${v.label}（${v.count}件）`));
      });
      select.append(group);
    });
    // 再読み込み後も同じ絞り込みを保つ（その分類が無くなっていれば解除）
    state.typeFilter = [...select.options].some((o) => o.value === current) ? current : '';
    select.value = state.typeFilter;
  }

  function matchesType(t) {
    if (!state.typeFilter) return true;
    const [catId, typeId] = state.typeFilter.split(':');
    return t.category === catId && t.news && t.news.type === typeId;
  }

  function matchesQuery(t, q) {
    if (!q) return true;
    const cat = state.data.categories[t.category];
    const hay = [t.title, t.bubble, t.description, t.ward, t.era, t.access, cat.label, t.news && t.news.place]
      .join(' ').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  }

  function applyFilter() {
    const q = state.query.trim().toLowerCase();
    let shown = 0;
    state.topics.forEach((t) => {
      const visible = state.activeCategories.has(t.category) && matchesQuery(t, q) && matchesType(t);
      if (visible) shown += 1;
      const m = state.markers.get(t.id);
      if (m) m.el.classList.toggle('is-filtered', !visible);
      const li = document.querySelector(`#topic-list li[data-id="${t.id}"]`);
      if (li) li.hidden = !visible;
    });
    $('#list-count').textContent = `${shown} / ${state.topics.length} 件を表示中`;
    const empty = $('#list-empty');
    if (empty) empty.hidden = shown > 0;
    scheduleCollision();
  }

  function highlightListItem(id) {
    document.querySelectorAll('#topic-list .topic-list-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.id === id);
    });
  }

  function setListOpen(open) {
    $('#list-panel').hidden = !open;
    $('#list-toggle').setAttribute('aria-expanded', String(open));
    if (open && MOBILE_QUERY.matches) $('#detail-panel').hidden = true;
  }

  function bindUI() {
    $('#list-toggle').addEventListener('click', () => {
      const open = $('#list-panel').hidden;
      setListOpen(open);
      if (open) $('#search-input').focus();
    });
    $('#search-input').addEventListener('input', (e) => {
      state.query = e.target.value;
      applyFilter();
    });
    $('#search-input').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const first = state.topics.find((t) => !state.markers.get(t.id)?.el.classList.contains('is-filtered'));
      if (first) selectTopic(first.id);
    });
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.close === 'detail-panel') closeDetail();
        else setListOpen(false);
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#detail-panel').hidden) closeDetail();
      else if (!$('#cam-panel').hidden) closeCam();
    });
    window.addEventListener('hashchange', openFromHash);
    $('#news-refresh').addEventListener('click', refreshNews);
    $('#cam-close').addEventListener('click', closeCam);
    bindThemeSelect();
    // ほかの地域（さいたま市・仙台市・東京23区）のマップへ移動する
    const citySelect = $('#city-select');
    if (citySelect) citySelect.addEventListener('change', () => { if (citySelect.value) location.href = citySelect.value; });
    $('#type-select').addEventListener('change', (e) => {
      state.typeFilter = e.target.value;
      // 選んだ分類のカテゴリが非表示なら表示に戻す
      const catId = state.typeFilter.split(':')[0];
      if (catId && !state.activeCategories.has(catId)) {
        state.activeCategories.add(catId);
        syncChips();
      }
      applyFilter();
    });

    // 操作ヒントは最初の操作後に消す
    const hint = $('#help-hint');
    const hideHint = () => { hint.hidden = true; };
    setTimeout(hideHint, 12000);
    $('#map').addEventListener('pointerdown', hideHint, { once: true });
  }

  // ---------- デザインテーマ ----------
  const THEMES = ['pop', 'cool', 'simple', 'nostalgic', 'gorgeous'];
  const THEME_KEY = 'saitama3d-theme';

  function bindThemeSelect() {
    const select = $('#theme-select');
    const current = document.documentElement.dataset.theme;
    select.value = THEMES.includes(current) ? current : 'pop';
    select.addEventListener('change', () => {
      const theme = THEMES.includes(select.value) ? select.value : 'pop';
      if (theme === 'pop') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 保存できなくても切り替えは有効 */ }
      // 枠の太さや文字の大きさが変わるので、吹き出しの重なりを計算し直す
      requestAnimationFrame(scheduleCollision);
    });
  }

  // ---------- ユーティリティ ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'className') node.className = v;
      else if (k === 'hidden') node.hidden = v;
      else node.setAttribute(k, v);
    });
    children.forEach((c) => node.append(c instanceof Node ? c : document.createTextNode(c)));
    return node;
  }

  function hostLabel(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  function distanceKm(a, b) {
    const R = 6371;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function formatDate(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '日時不明';
    return d.toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function formatRelative(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '日時不明';
    const min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'たった今';
    if (min < 60) return `${min}分前`;
    if (min < 60 * 24) return `${Math.floor(min / 60)}時間前`;
    if (min < 60 * 24 * 7) return `${Math.floor(min / 1440)}日前`;
    return d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
  }

  function formatDistance(km) {
    return km < 1 ? `約${Math.round(km * 100) * 10}m` : `約${km.toFixed(1)}km`;
  }

  let toastTimer = 0;
  function showToast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 8000);
  }
})();
