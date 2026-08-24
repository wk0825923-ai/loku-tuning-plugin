// loku-attn.js — Loku Tuning 計測タグ本体（M3・層A）
// 既存LPに <script type="module" src=".../loku-attn.js" data-site="xxx" data-endpoint="https://.../api/attn/collect"></script>
// を1行足すだけで動く後付け設計。本番Loku本体・DBには一切触れない（このファイル単体で完結）。
//
// 機能:
//  (a) anon_id発行（1stパーティcookie＋localStorage併用・7日揮発・巻き戻り防止）
//  (b) lt_src / lt_ad のURLパラメータ捕捉→anon_idに紐づけ保存・collectペイロードに含める
//  (c) ブロック計測: data-box属性 or フォールバック自動分割(auto_1..n)
//  (d) IntersectionObserverで滞留計測・単調増加マージ(P1準拠)
//  (e) 離脱フラッシュ（visibilitychange + pagehide + sendBeacon・P0準拠）
//  (f) 設定はscriptタグのdata-site/data-endpoint属性で注入
//
// 純関数部分（パラメータ解析・分割ロジック・マージ・ペイロード組み立て）は
// DOM/window非依存で export しており、handoff-demo/test-tag.mjs から node で単体テストできる。

const ANON_COOKIE = 'lt_anon';
const ANON_STORAGE_KEY = 'lt_anon';
const AD_STORAGE_KEY = 'lt_ad_params';
const ANON_TTL_DAYS = 7;
const HEADING_LABEL_LEN = 20;
// フォールバック自動分割の境界タグ（見出し境界で粗く分割）
const AUTO_SPLIT_TAGS = new Set(['SECTION', 'ARTICLE', 'H1', 'H2']);

// ---------------------------------------------------------------------------
// 純関数（テスト対象）
// ---------------------------------------------------------------------------

/**
 * URLの search 文字列から lt_src / lt_ad を読み取る。無ければ null。
 * @param {string} search 例: "?lt_src=line_broadcast_0820&lt_ad=creative_a"
 * @returns {{lt_src: string|null, lt_ad: string|null}}
 */
export function parseAdParams(search) {
  const params = new URLSearchParams(search || '');
  const lt_src = params.get('lt_src');
  const lt_ad = params.get('lt_ad');
  return {
    lt_src: lt_src ? lt_src.slice(0, 128) : null,
    lt_ad: lt_ad ? lt_ad.slice(0, 128) : null,
  };
}

/**
 * cookie値・localStorage値・現在時刻から使用すべき anon_id を決める。
 * 巻き戻り防止＝既存の値がある限り新規発行しない（両方あれば cookie を正とする）。
 * 期限切れ(7日)の場合のみ新規発行する。
 * @param {{cookieVal: string|null, cookieAt: number|null, storageVal: string|null, storageAt: number|null, now: number, genId: () => string}} args
 * @returns {{anonId: string, isNew: boolean}}
 */
export function resolveAnonId({ cookieVal, cookieAt, storageVal, storageAt, now, genId }) {
  const ttlMs = ANON_TTL_DAYS * 24 * 60 * 60 * 1000;
  const cookieFresh = cookieVal && Number.isFinite(cookieAt) && now - cookieAt < ttlMs;
  const storageFresh = storageVal && Number.isFinite(storageAt) && now - storageAt < ttlMs;

  if (cookieFresh) return { anonId: cookieVal, isNew: false };
  if (storageFresh) return { anonId: storageVal, isNew: false };
  return { anonId: genId(), isNew: true };
}

/**
 * ブロック計測用の見出し境界からフォールバック自動分割を行う。
 * data-box が無い既存LP向け＝画面5「AIブロック推定」の入力になる。
 * @param {Array<{tag: string, text: string}>} sections DOM順に並んだ見出し/セクション候補
 * @returns {Array<{box_key: string, label: string}>}
 */
export function computeAutoBoxes(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const out = [];
  let n = 0;
  for (const s of list) {
    if (!s || typeof s.tag !== 'string') continue;
    if (!AUTO_SPLIT_TAGS.has(s.tag.toUpperCase())) continue;
    n += 1;
    const rawText = (s.text || '').trim().replace(/\s+/g, ' ');
    out.push({
      box_key: `auto_${n}`,
      label: rawText.slice(0, HEADING_LABEL_LEN),
    });
  }
  return out;
}

/**
 * 1ブロックの滞留統計を単調増加でマージする（サーバー側P1ロジックと同一方針）。
 * 離脱フラッシュ等で複数回送るスナップショットが、確定値を巻き戻さないようにする。
 * @param {{active_view?: number, engagement?: number, revisits?: number}|undefined} prev
 * @param {{active_view?: number, engagement?: number, revisits?: number}} incoming
 * @returns {{active_view: number, engagement: number, revisits: number}}
 */
export function mergeBoxStats(prev, incoming) {
  const av = Number(incoming?.active_view);
  const eng = Number(incoming?.engagement);
  const rv = Number(incoming?.revisits);
  return {
    active_view: Math.max(prev?.active_view || 0, Number.isFinite(av) ? av : 0),
    engagement: Math.max(prev?.engagement || 0, Number.isFinite(eng) ? Math.min(100, Math.max(0, eng)) : 0),
    revisits: Math.max(prev?.revisits || 0, Number.isFinite(rv) ? rv : 0),
  };
}

/**
 * /api/attn/collect に送るペイロードを組み立てる。
 * app.mjs 側の入力仕様（anon_id, page_slug, entry{}, utm{}, referrer, active_sec, boxes[]）に合わせる。
 * lt_src/lt_ad は utm と別枠の adParams として乗せ、サーバー側の型は変えず後方互換を保つ
 * （utm.source/campaign に流用せず、専用フィールドとして送ることで由来を混同しない）。
 * @param {{
 *   anonId: string, pageSlug: string,
 *   entry?: {query?: string|null, pos?: number|null, device?: string|null, source?: string|null, medium?: string|null, campaign?: string|null},
 *   utm?: Record<string,string>, referrer?: string|null, activeSec?: number,
 *   boxes?: Array<{box_key: string, active_view?: number, engagement?: number, revisits?: number}>,
 *   adParams?: {lt_src?: string|null, lt_ad?: string|null},
 *   noticeShown?: boolean,
 * }} args
 */
export function buildPayload(args) {
  const {
    anonId, pageSlug, entry = null, utm = null, referrer = null,
    activeSec = 0, boxes = [], adParams = null, noticeShown = false,
  } = args || {};

  const payload = {
    anon_id: anonId,
    page_slug: pageSlug,
    active_sec: Number.isFinite(Number(activeSec)) ? Number(activeSec) : 0,
    boxes: (Array.isArray(boxes) ? boxes : []).map(b => ({
      box_key: b.box_key,
      active_view: Number(b.active_view) || 0,
      engagement: Number(b.engagement) || 0,
      revisits: Number(b.revisits) || 0,
    })),
    notice_shown: noticeShown === true,
  };
  if (entry) payload.entry = entry;
  if (utm) payload.utm = utm;
  if (referrer != null) payload.referrer = referrer;
  if (adParams && (adParams.lt_src || adParams.lt_ad)) {
    payload.lt_src = adParams.lt_src || null;
    payload.lt_ad = adParams.lt_ad || null;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// DOM/window依存部分（ブラウザ実行時のみ動く。node単体テストの対象外）
// ---------------------------------------------------------------------------

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function genRandomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function readCookie(name) {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function writeCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${d.toUTCString()}; path=/; SameSite=Lax`;
}

function safeStorageGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function safeStorageSet(key, val) {
  try { window.localStorage.setItem(key, val); } catch { /* ignore（プライベートモード等） */ }
}

/**
 * cookie/localStorageの値+タイムスタンプから anon_id を確定し、両ストアへ同期する。
 */
function getOrCreateAnonId() {
  const cookieRaw = readCookie(ANON_COOKIE);
  const storageRaw = safeStorageGet(ANON_STORAGE_KEY);
  let cookieVal = null, cookieAt = null, storageVal = null, storageAt = null;
  try { if (cookieRaw) ({ v: cookieVal, t: cookieAt } = JSON.parse(cookieRaw)); } catch { /* ignore */ }
  try { if (storageRaw) ({ v: storageVal, t: storageAt } = JSON.parse(storageRaw)); } catch { /* ignore */ }

  const { anonId, isNew } = resolveAnonId({
    cookieVal, cookieAt, storageVal, storageAt, now: Date.now(), genId: genRandomId,
  });

  const record = JSON.stringify({ v: anonId, t: isNew ? Date.now() : (cookieAt ?? storageAt ?? Date.now()) });
  writeCookie(ANON_COOKIE, record, ANON_TTL_DAYS);
  safeStorageSet(ANON_STORAGE_KEY, record);
  return anonId;
}

/**
 * lt_src/lt_ad をURLから読み、既に保存済みならそれを維持しつつ新規パラメータで上書き保存する。
 */
function resolveAdParams(anonId) {
  const fromUrl = parseAdParams(window.location.search);
  const key = `${AD_STORAGE_KEY}::${anonId}`;
  let stored = null;
  try { stored = JSON.parse(safeStorageGet(key) || 'null'); } catch { /* ignore */ }
  const merged = {
    lt_src: fromUrl.lt_src || stored?.lt_src || null,
    lt_ad: fromUrl.lt_ad || stored?.lt_ad || null,
  };
  if (merged.lt_src || merged.lt_ad) safeStorageSet(key, JSON.stringify(merged));
  return merged;
}

/** data-box要素を集める。無ければフォールバック自動分割候補を集める。 */
function collectBoxElements(root) {
  const explicit = Array.from(root.querySelectorAll('[data-box]'));
  if (explicit.length > 0) {
    return { mode: 'explicit', els: explicit.map(el => ({ el, box_key: el.getAttribute('data-box') })) };
  }
  const candidateEls = Array.from(root.querySelectorAll('section, article, h1, h2'));
  const sections = candidateEls.map(el => ({
    tag: el.tagName,
    text: el.tagName === 'H1' || el.tagName === 'H2'
      ? el.textContent
      : (el.querySelector('h1,h2')?.textContent || ''),
  }));
  const auto = computeAutoBoxes(sections);
  return {
    mode: 'auto',
    els: candidateEls
      .filter(el => AUTO_SPLIT_TAGS.has(el.tagName))
      .map((el, i) => ({ el, box_key: auto[i]?.box_key, label: auto[i]?.label })),
  };
}

function initTag() {
  if (!isBrowser()) return;
  const scriptEl = document.currentScript
    || document.querySelector('script[data-site][data-endpoint]');
  if (!scriptEl) return;
  const site = scriptEl.getAttribute('data-site');
  const endpoint = scriptEl.getAttribute('data-endpoint');
  if (!site || !endpoint) return;

  const anonId = getOrCreateAnonId();
  const adParams = resolveAdParams(anonId);

  const entry = {
    query: new URLSearchParams(window.location.search).get('q') || null,
    pos: null,
    device: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
    source: new URLSearchParams(window.location.search).get('utm_source') || null,
    medium: new URLSearchParams(window.location.search).get('utm_medium') || null,
    campaign: new URLSearchParams(window.location.search).get('utm_campaign') || null,
  };
  const utmParams = new URLSearchParams(window.location.search);
  const utm = {};
  ['source', 'medium', 'campaign', 'content', 'term'].forEach(k => {
    const v = utmParams.get(`utm_${k}`);
    if (v) utm[k] = v;
  });

  const { els: boxTargets } = collectBoxElements(document);
  // box_key -> {active_view(sec), engagement(0-100の粗い近似), revisits, lastEnter, visible}
  const boxState = new Map();
  boxTargets.forEach(({ box_key }) => {
    if (!box_key) return;
    boxState.set(box_key, { active_view: 0, engagement: 0, revisits: 0, visible: false, lastTick: null });
  });

  let pageActiveSec = 0;
  let pageVisible = document.visibilityState === 'visible';
  let lastTick = Date.now();

  function tick() {
    const now = Date.now();
    const deltaSec = (now - lastTick) / 1000;
    lastTick = now;
    if (pageVisible && deltaSec > 0 && deltaSec < 5) {
      pageActiveSec += deltaSec;
      boxState.forEach(st => {
        if (st.visible) {
          st.active_view += deltaSec;
          st.engagement = Math.min(100, st.engagement + deltaSec * 4);
        }
      });
    }
  }
  const tickTimer = window.setInterval(tick, 1000);

  if ('IntersectionObserver' in window && boxTargets.length > 0) {
    const io = new IntersectionObserver(entries => {
      tick();
      entries.forEach(en => {
        const box_key = boxTargets.find(t => t.el === en.target)?.box_key;
        if (!box_key) return;
        const st = boxState.get(box_key);
        if (!st) return;
        const wasVisible = st.visible;
        st.visible = en.isIntersecting;
        if (st.visible && !wasVisible) st.revisits += 1;
      });
    }, { threshold: 0.4 });
    boxTargets.forEach(({ el }) => el && io.observe(el));
  }

  document.addEventListener('visibilitychange', () => {
    tick();
    pageVisible = document.visibilityState === 'visible';
    if (document.visibilityState === 'hidden') flush(true);
  });

  function buildCurrentPayload() {
    tick();
    const boxes = Array.from(boxState.entries()).map(([box_key, st]) => ({
      box_key,
      active_view: Math.round(st.active_view * 10) / 10,
      engagement: Math.round(st.engagement),
      revisits: st.revisits,
    }));
    return buildPayload({
      anonId, pageSlug: site, entry, utm, referrer: document.referrer || null,
      activeSec: Math.round(pageActiveSec * 10) / 10, boxes, adParams, noticeShown: true,
    });
  }

  function flush(useBeacon) {
    const payload = buildCurrentPayload();
    const body = JSON.stringify(payload);
    if (useBeacon && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(endpoint, blob);
    } else {
      fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
        .catch(() => { /* 計測失敗はページ動作に影響させない */ });
    }
  }

  window.addEventListener('pagehide', () => flush(true));
  window.addEventListener('beforeunload', () => flush(true));

  // 初回到達を軽く送っておく（離脱前にタブが放置されるケースの保険）
  window.setTimeout(() => flush(false), 3000);

  window.__lokuAttn = { flush, getState: () => ({ anonId, adParams, pageActiveSec, boxState }) };
}

if (isBrowser()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTag);
  } else {
    initTag();
  }
}
