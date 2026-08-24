// Loku Tuning ダッシュボード（M2）共有フロントエンドJS。
// 役割：デモAPI(app.mjs／serve-dash.mjs経由・同一オリジン)へのfetchラッパーと、
// APIが不達のときの「内蔵ダミーデータへのフォールバック＋表示中バッジ」を提供する。
// ここには機能保証・満足度・体験談の文言は一切置かない。
window.DashAPI = (function () {
  const PAGE_SLUG = 'seitai-lp-a';
  const PRESET = 'pilates';

  async function getJSON(pathname, { timeoutMs = 4000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(pathname, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function postJSON(pathname, body, { timeoutMs = 4000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(pathname, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // seed-demo.mjsが書き出したスナップショット（実エンジンのdiagnose結果一覧）。
  // 「友だち一覧」APIがデモには無いため、投入側が知っているfriend_idの足場として使う。
  let manifestCache = null;
  async function getManifest() {
    if (manifestCache) return manifestCache;
    const res = await fetch('seed-manifest.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('seed-manifest.json not found（先に node dashboard/seed-demo.mjs を実行してください）');
    manifestCache = await res.json();
    return manifestCache;
  }

  function showFallbackBadge() {
    if (document.getElementById('dash-fallback-badge')) return;
    const b = document.createElement('div');
    b.id = 'dash-fallback-badge';
    b.textContent = 'デモデータ表示中（APIに未接続）';
    b.style.cssText = [
      'position:fixed', 'top:8px', 'left:50%', 'transform:translateX(-50%)', 'z-index:200',
      'background:#B45309', 'color:#fff', 'font-size:10.5px', 'font-weight:700',
      'padding:4px 12px', 'border-radius:20px', 'box-shadow:0 2px 8px rgba(0,0,0,.2)',
      'font-family:Inter,system-ui,sans-serif', 'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    document.body.appendChild(b);
  }

  // loader失敗時にfallbackへ自動フォールバック＋バッジ表示。機械が黙って嘘をつかない。
  async function withFallback(loader, fallback) {
    try {
      return await loader();
    } catch (e) {
      console.warn('[DashAPI] APIフォールバック:', e.message || e);
      showFallbackBadge();
      return typeof fallback === 'function' ? fallback() : fallback;
    }
  }

  return { PAGE_SLUG, PRESET, getJSON, postJSON, getManifest, withFallback, showFallbackBadge };
})();
