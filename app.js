/* さいたま市 3Dトピックマップ
 * MapLibre GL JS + OpenFreeMap（ベクタータイル）+ AWS Terrain Tiles（DEM）
 * いずれもAPIキー不要。
 */
(() => {
  'use strict';

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
  // 起動時にオンにしておくカテゴリ（ほかはボタンでオンにする）
  const DEFAULT_CATEGORIES = ['news'];
  const POLICE_URL = 'https://www.police.pref.saitama.lg.jp/';
  const FLYER_SITES = [
    { label: 'Shufoo!', url: 'https://www.shufoo.net/' },
    { label: 'トクバイ', url: 'https://tokubai.co.jp/' },
  ];

  // 初期視点：さいたま市全域（10区）が見えるように斜め上から
  const INITIAL_VIEW = {
    center: [139.652, 35.893],
    zoom: initialZoom(),
    pitch: 55,
    bearing: -18,
  };

  // 画面幅に合わせて、市域（東西約20km）が収まるズームにする
  function initialZoom() {
    const w = window.innerWidth || 1200;
    return Math.max(10.6, Math.min(12.1, 12 + Math.log2(w / 1100)));
  }

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
    camsVisible: false,
    activeCamId: null,
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
      maxBounds: [[139.2, 35.65], [140.1, 36.15]],
      attributionControl: { compact: true },
    });
    state.map = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new ResetViewControl(), 'top-right');
    map.addControl(new LiveCamControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    map.on('load', () => {
      add3DBuildings(map);
      addTerrain(map);
      buildMarkers();
      if (state.pendingNews) setNews(state.pendingNews);
      updateZoomClass();
      scheduleCollision();
      openFromHash();
    });

    map.on('zoom', updateZoomClass);
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
      // さいたま市は平坦なので少し強調する
      map.setTerrain({ source: 'terrain-dem', exaggeration: 1.8 });
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
      btn.textContent = '📹';
      btn.addEventListener('click', () => setCamsVisible(!state.camsVisible));
      this._container.appendChild(btn);
      return this._container;
    }
    onRemove() {
      this._container.remove();
    }
  }

  function setCamsVisible(visible) {
    const cams = (state.livecams && state.livecams.cameras) || [];
    if (visible && !cams.length) {
      showToast('ライブカメラの情報を読み込めませんでした。');
      return;
    }
    state.camsVisible = visible;
    const btn = $('#livecam-toggle');
    if (btn) {
      btn.setAttribute('aria-pressed', String(visible));
      btn.title = visible ? 'ライブカメラの場所を隠す' : 'ライブカメラの場所を表示';
    }
    if (visible && !state.camMarkers.length) cams.forEach(createCamMarker);
    state.camMarkers.forEach(({ marker }) => {
      if (visible) marker.addTo(state.map);
      else marker.remove();
    });
    if (visible) {
      // カメラ同士が重ならないよう、すべてのカメラが入る範囲まで寄る
      const bounds = new maplibregl.LngLatBounds();
      cams.forEach((c) => bounds.extend([c.lng, c.lat]));
      const mobile = MOBILE_QUERY.matches;
      state.map.fitBounds(bounds, {
        padding: mobile ? { top: 60, bottom: 60, left: 40, right: 60 } : { top: 120, bottom: 120, left: 160, right: 160 },
        maxZoom: 14.5, pitch: 50, duration: 1400,
      });
      showToast(`📹 ライブカメラ ${cams.length}か所を表示しました。カメラを押すと映像が見られます。`);
    } else {
      closeCam();
    }
  }

  function createCamMarker(cam) {
    const yt = cam.youtube || {};
    const el = document.createElement('div');
    el.className = 'cam-marker';
    el.dataset.id = cam.id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cam-pin';
    btn.setAttribute('aria-label', `${cam.title}の映像を見る`);
    btn.innerHTML = '<span class="cam-pin-icon" aria-hidden="true">📹</span><span class="cam-pin-label"></span>';
    btn.querySelector('.cam-pin-label').textContent = cam.title;
    if (yt.live) btn.classList.add('is-live');
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openCam(cam.id);
    });
    el.appendChild(btn);
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([cam.lng, cam.lat]);
    state.camMarkers.push({ marker, el, cam });
  }

  function camEmbedUrl(cam) {
    const yt = cam.youtube || {};
    const params = 'autoplay=1&mute=1&playsinline=1';
    // 配信ごとに動画IDが変わるので、チャンネルの「今の配信」を埋め込むのを優先する
    if (yt.channelId) return `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(yt.channelId)}&${params}`;
    if (yt.videoId) return `https://www.youtube.com/embed/${encodeURIComponent(yt.videoId)}?${params}`;
    return '';
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
    const src = camEmbedUrl(cam);
    if (src) {
      box.append(el('iframe', {
        src,
        title: `${cam.title}（ライブ映像）`,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        allowfullscreen: '',
        referrerpolicy: 'strict-origin-when-cross-origin',
      }));
    } else {
      box.append(el('p', { className: 'cam-empty' }, '映像を読み込めませんでした。「↗ 配信サイトへ」から見てください。'));
    }

    const checked = state.livecams.checkedAt ? formatDate(state.livecams.checkedAt) : '';
    const status = !checked ? '' : yt.live ? `${checked} 時点で配信中でした。` : `${checked} 時点では配信していませんでした（配信時間外の場合は映像が出ません）。`;
    const note = $('#cam-note');
    note.replaceChildren(
      el('span', {}, `📍 ${cam.ward}付近・配信: ${cam.provider}。${status}`),
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

  function closeCam() {
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

    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, 7] })
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
        offset: mobile ? [0, -ch * 0.25] : [-(detailW + 56) / 2, 40],
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
      el('p', { className: 'detail-ward' }, `📍 さいたま市${topic.ward}`),
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
      ? '📍 さいたま市全体の記事（地図上は市役所付近に表示）'
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
      const police = el('a', { href: POLICE_URL, target: '_blank', rel: 'noopener' }, '埼玉県警察の公式サイト');
      body.append(el('p', { className: 'crime-note' },
        '報道機関が伝えた警察発表などの情報です。地図の位置は記事中の地名からの推定で、事件の正確な発生場所ではありません。最新の正確な防犯情報は ',
        police, '（犯罪情報官NEWS など）で確認してください。'));
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
        'SNS（Bluesky・Misskey・Mastodon）に公開されている投稿を、地名の検索やハッシュタグ（#さいたま など）から集めたものです。投稿者がさいたま市に住んでいるとは限らず、内容は投稿者個人の感想です。地図の位置は本文中の地名からの推定です。'));
    }

    body.append(el('a', { className: 'news-link', href: n.url, target: '_blank', rel: 'noopener noreferrer' },
      topic.category === 'reviews' ? '投稿を見る（外部サイト）' : '記事を読む（外部サイト）'));

    const dl = el('dl', { className: 'info-table' });
    const addRow = (k, v) => { if (v) dl.append(el('dt', {}, k), el('dd', {}, v)); };
    addRow('分類', n.typeLabel ? `${state.data.categories[topic.category].label}／${n.typeLabel}` : state.data.categories[topic.category].label);
    addRow('配信元', n.source);
    addRow('配信日時', formatDate(n.published));
    addRow('位置の推定', n.matched
      ? `記事中の「${n.matched}」から推定（実際の場所と異なる場合があります）`
      : '地名が見つからないため、市全体の記事として表示');
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
    try {
      return await loadJSON(`${NEWS_URL}?t=${Date.now()}`);
    } catch (err) {
      console.warn('ニュースを読み込めませんでした:', err);
      return null;
    }
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

    state.newsMeta = { generatedAt: news.generatedAt, sources: news.sources || [] };
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
    box.textContent = `${counts}｜${formatDate(meta.generatedAt)} 更新${google ? '｜出典: Googleニュース検索' : ''}`;
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
