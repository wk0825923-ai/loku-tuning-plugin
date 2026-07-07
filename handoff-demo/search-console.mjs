// Search Console コネクタ（サチコを「API連携で引っ張って搭載」する部分）
// 本番: Google Search Analytics API（無料）を OAuth で叩く。
//   POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
//   body: { startDate, endDate, dimensions:['query'] or ['query','page'], rowLimit:25000 }
// デモ: 実APIの代わりに fetcher を差し替え可能にする（下の fetchSearchConsole）。
// レスポンス行の形は本番と同じ: { keys:[query, page?], clicks, impressions, ctr, position }

// 必要最小のスコープ＝Search Consoleの読み取り専用（スコープ最小化：Google APIs規約・目的外利用禁止）。
export const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
// 明示的に禁止する書き込み可能スコープ（サイトマップ送信等ができてしまう）。
const WRITE_SCOPES = ['https://www.googleapis.com/auth/webmasters', 'https://www.googleapis.com/auth/siteverification'];

/**
 * 付与スコープがreadonlyに収まっているか検証。書き込み可能スコープが混じれば拒否。
 * @param {string[]|string} granted OAuthで付与されたスコープ
 */
export function assertReadonlyScope(granted) {
  const list = (Array.isArray(granted) ? granted : String(granted || '').split(/\s+/)).filter(Boolean);
  if (list.length === 0) throw new Error('scope required（readonlyスコープの付与が必要）');
  const bad = list.filter(s => WRITE_SCOPES.includes(s) || (s.includes('/auth/webmasters') && !s.endsWith('.readonly')));
  if (bad.length) throw new Error(`書き込み可能スコープは禁止（readonly限定）: ${bad.join(', ')}`);
  if (!list.includes(REQUIRED_SCOPE)) throw new Error(`readonlyスコープ(${REQUIRED_SCOPE})が必要`);
  return true;
}

/** 本番はGoogle API・デモはモックを渡す。fetcher(siteUrl,start,end) => rows[] */
export async function fetchSearchConsole({ siteUrl, startDate, endDate, fetcher, scopes = REQUIRED_SCOPE }) {
  assertReadonlyScope(scopes); // スコープ最小化を実行時に強制（write混入を拒否）
  if (typeof fetcher !== 'function') throw new Error('fetcher required (本番はGoogle API呼び出しを渡す)');
  return await fetcher(siteUrl, startDate, endDate);
}

/** 引っ張った行を search_console_daily 相当に取り込む（同一 page×date×query は1行=upsert） */
export function ingestSearchConsole(store, { tenant_id, page_id, date, rows }) {
  let n = 0;
  for (const r of rows || []) {
    const query = Array.isArray(r.keys) ? r.keys[0] : r.query;
    if (!query) continue;
    const idx = store.search_console.findIndex(x => x.tenant_id === tenant_id && x.page_id === page_id && x.date === date && x.query === query);
    const row = {
      tenant_id, page_id, date, query,
      impressions: r.impressions || 0, clicks: r.clicks || 0,
      ctr: r.ctr != null ? r.ctr : (r.impressions ? r.clicks / r.impressions : 0),
      position: r.position || 0,
    };
    if (idx >= 0) store.search_console[idx] = row; else store.search_console.push(row);
    n++;
  }
  return n;
}

/** あるページの検索サマリ（来る前を1画面に合成するための集計） */
export function searchSummary(store, page_id) {
  const rows = store.search_console.filter(x => x.page_id === page_id);
  if (!rows.length) return null;
  const impressions = rows.reduce((a, r) => a + r.impressions, 0);
  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const wpos = rows.reduce((a, r) => a + r.position * r.impressions, 0);
  const top = rows.slice().sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, 3).map(r => ({ query: r.query, impressions: r.impressions, clicks: r.clicks, position: Math.round(r.position * 10) / 10 }));
  return {
    impressions, clicks,
    ctr: impressions ? Math.round((clicks / impressions) * 1000) / 10 : 0, // %
    avg_position: impressions ? Math.round((wpos / impressions) * 10) / 10 : 0,
    top,
  };
}
