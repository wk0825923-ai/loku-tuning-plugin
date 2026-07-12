// Loku Tuning — 引き渡しデモ用バックエンド（依存ゼロ・node:http）
// 本番Lokuには一切触れない。ロジック（collect / merge / journey / tag発火）を
// schema.sql と 1:1 対応させ、社長が Next.js + Supabase へ写経すれば動く形にする。
//
// createServer() は「その都度まっさらなストア」を持つサーバを返す（テスト隔離のため）。

import http from 'node:http';
import crypto from 'node:crypto';
import { checkCopy, stripSensitive, detectHealthTerms, buildDisclosure, defaultSubprocessors, transferAssessment, assessBreach } from './compliance.mjs';
import { ingestSearchConsole, searchSummary } from './search-console.mjs';
import { deriveExit, inferCause, suggestActions, CAUSE_LABEL, CAUSE_CODES, PRESETS, DEFAULT_PRESET, getPreset } from './causal.mjs';

// 計測堅牢化（目付還流P2）：既知botのUAパターン。素直に名乗るbot＝GA4のIABリスト相当の最小版。
// ※ヘッドレス偽装は捕まらない＝SDK側の挙動フラグ(suspect_bot)との二段構え。
// 「Googlebot」のように前に語が付く形も捕まえるため、先頭側の語境界は付けない（後方のみ\b）
const BOT_UA_RE = /(bot|crawler|spider|scrapy|headlesschrome|puppeteer|playwright|phantomjs|python-requests|selenium)\b|curl\/|wget\//i;

// ---- サンプルページ定義（本番は loku_attn_pages / _boxes 相当） ----
function seedStore() {
  const boxesDef = [
    { box_key: 'hero',        type: 'text',  expected: 7.2 },
    { box_key: 'problem',     type: 'text',  expected: 21.7 },
    { box_key: 'beforeafter', type: 'image', expected: 3.0 },
    { box_key: 'staff',       type: 'text',  expected: 18.1 },
    { box_key: 'pricing',     type: 'price', expected: 4.0 },
    { box_key: 'voice',       type: 'text',  expected: 16.9 },
    { box_key: 'faq',         type: 'text',  expected: 14.5 },
    { box_key: 'cta',         type: 'text',  expected: 4.8 },
  ];
  return {
    pages: [
      { id: 'pg_lpA', tenant_id: 't_1', kind: 'lp', slug: 'seitai-lp-a', route_tag: '整体LP-A 流入' },
      { id: 'pg_lpB', tenant_id: 't_2', kind: 'lp', slug: 'seitai-lp-b', route_tag: '整体LP-B 流入' }, // 別テナント（RLS分離の検証用）
    ],
    boxes: [
      ...boxesDef.map((b, i) => ({ id: `bx_${b.box_key}`, page_id: 'pg_lpA', ord: i, ...b })),
      ...boxesDef.map((b, i) => ({ id: `bxB_${b.box_key}`, page_id: 'pg_lpB', ord: i, ...b })),
    ],
    tag_rules: [
      { id: 'r_route',  page_id: 'pg_lpA', kind: 'route',     box_key: null,          threshold: null, tag: '整体LP-A 流入' },
      { id: 'r_price',  page_id: 'pg_lpA', kind: 'heat',      box_key: 'pricing',     threshold: 60,   tag: '料金検討中' },
      { id: 'r_ba',     page_id: 'pg_lpA', kind: 'heat',      box_key: 'beforeafter', threshold: 60,   tag: '効果重視' },
      { id: 'r_voice',  page_id: 'pg_lpA', kind: 'heat',      box_key: 'voice',       threshold: 60,   tag: '口コミ重視' },
      { id: 'r_hot',    page_id: 'pg_lpA', kind: 'aggregate', box_key: null,          threshold: 55,   tag: 'ホットリード' },
    ],
    sessions: new Map(),      // anon_id -> session
    box_stats: new Map(),     // `${anon_id}::${box_key}` -> stat
    identity: new Map(),      // anon_id -> { friend_id, consented }
    tag_fires: [],            // { session_anon, rule_id, tag, friend_id }
    friend_tags: new Map(),   // friend_id -> Set(tag)  ← 本番Lokuの friend_tags 相当
    search_console: [],       // Search Console API から引っ張った行（来る前）
    product_events: [],       // 自分の画面(オンボ/管理)の利用イベント（自己改善サイクル）
    bookings: new Set(),      // 予約が入った friend_id（実測CVRの母数）
    opt_out: new Set(),       // 配信停止した friend_id（送らない）
    bot_excluded: [],         // botとして計測から除外した記録（黙って消さず可視化する＝bot-report）
    audit_log: [],            // 機微操作の証跡（安全管理措置・従業者の監督）
    privacy_policy_urls: new Map(), // tenant_id -> 店舗が設定したプライバシーポリシーURL
    subprocessors: defaultSubprocessors(), // 委託先レジストリ（越境移転28条・委託先監督25条）
    profiling_opt_out: new Set(), // プロファイリング（タグ付け）を拒否した friend_id
    purpose_version: 1, // 利用目的のバージョン。上げると旧同意は"再同意待ち"になる（目的外利用の防止）
    incidents: [], // 漏えい等インシデント台帳（APPI26条 報告・本人通知の管理）
    require_notice: false, // trueで「外部送信の通知を出す前の計測」を拒否（取得タイミングの保証）
  };
}

// 保持期間purge：last_seen_at が cutoff より古いセッションと関連データを消す。
// forget と同じカスケード（sessions/box_stats/identity/tag_fires）。付与済み friend_tags は残す
// （生の計測データのみ消去。友だち単位の完全削除は forget 側の責務）。
export function purgeExpired(store, cutoff) {
  const purgedAnons = [];
  for (const [anon, sess] of store.sessions) {
    const last = sess.last_seen_at ?? sess.started_at ?? 0;
    if (last < cutoff) purgedAnons.push(anon);
  }
  let boxStatsRemoved = 0;
  for (const anon of purgedAnons) {
    store.sessions.delete(anon);
    for (const key of [...store.box_stats.keys()]) if (key.startsWith(anon + '::')) { store.box_stats.delete(key); boxStatsRemoved++; }
    store.identity.delete(anon);
  }
  if (purgedAnons.length) {
    const gone = new Set(purgedAnons);
    store.tag_fires = store.tag_fires.filter(f => !gone.has(f.session_anon));
  }
  return { purgedAnons, boxStatsRemoved };
}

// CSVセル安全化：数式インジェクション対策（=,+,-,@,tab,CR で始まる値はクォート内に'を前置）
// ＋ダブルクォート/カンマ/改行を含む値はRFC4180でクォート。
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 表計算ソフトでの数式実行を防ぐ
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// friend単位の計測データをCSV文字列に。開示請求・データポータビリティ対応。
export function buildFriendCsv(store, friendId) {
  const header = ['friend_id', 'page_slug', 'page_kind', 'entry_query', 'entry_pos', 'device', 'entry_health', 'active_sec', 'box_engagement'];
  const lines = [header.join(',')];
  let count = 0;
  for (const [anon, id] of store.identity) {
    if (id.friend_id !== friendId || !id.consented) continue; // 同意ゲートを踏襲
    const sess = store.sessions.get(anon);
    if (!sess) continue;
    const page = store.pages.find(p => p.id === sess.page_id);
    const be = {};
    for (const b of store.boxes.filter(x => x.page_id === sess.page_id)) {
      const st = store.box_stats.get(`${anon}::${b.box_key}`);
      be[b.box_key] = st ? Math.round(st.engagement) : 0;
    }
    lines.push([friendId, page?.slug, page?.kind, sess.entry_query, sess.entry_pos, sess.device,
      !!sess.entry_health, sess.active_sec, JSON.stringify(be)].map(csvCell).join(','));
    count++;
  }
  return { csv: lines.join('\r\n'), rows: count };
}

// パスフレーズでCSVをAES-256-GCM暗号化（持ち出しCSVの漏洩対策）。scryptで鍵導出。
export function encryptCsv(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { alg: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: tag.toString('base64'), ciphertext: ct.toString('base64') };
}

const pageBySlug = (s, slug) => s.pages.find(p => p.slug === slug);

// RLS(tenant_id = auth.jwt()->>'tenant_id')のアプリ層ミラー。
// friendが属するテナント＝その友だちに結合されたセッションのテナント。
// 同意が現在の利用目的に対して有効か（目的バージョンが上がると旧同意は"再同意待ち"）。
// 記録が無い古い同意は現行扱い（後方互換）。friendが再同意待ちなら true。
export function needsReconsent(store, friendId) {
  for (const [, id] of store.identity) {
    if (id.friend_id !== friendId || !id.consented) continue;
    const v = id.consent_purpose_version ?? store.purpose_version;
    if (v < store.purpose_version) return true;
  }
  return false;
}

export function tenantOfFriend(store, friendId) {
  for (const [anon, id] of store.identity) {
    if (id.friend_id !== friendId) continue;
    const sess = store.sessions.get(anon);
    if (sess?.tenant_id) return sess.tenant_id;
  }
  return null;
}
// caller のテナント（本番はJWTから・ここでは x-tenant-id ヘッダ）で対象へのアクセス可否を判定。
// caller未指定なら本番はゲートウェイがJWTを必ず注入する前提（デモの管理ビューは全体可）。
export function tenantAccessAllowed(callerTenant, ownerTenant) {
  if (!callerTenant) return true;      // 明示なし＝スコープ判定を課さない（本番はJWT必須）
  if (!ownerTenant) return true;       // 対象にテナントが無い（未結合など）は素通し
  return callerTenant === ownerTenant; // 自テナントのみ
}
const rulesForPage = (s, page_id) => s.tag_rules.filter(r => r.page_id === page_id);

// タグ発火評価：あるセッションの現在の box_stats からルールを評価して発火タグ集合を返す
function evalTags(store, anon_id, page) {
  const rules = rulesForPage(store, page.id);
  const stat = (k) => store.box_stats.get(`${anon_id}::${k}`);
  const fired = [];
  for (const r of rules) {
    if (r.kind === 'route') { fired.push({ rule_id: r.id, tag: r.tag }); }
    else if (r.kind === 'heat') {
      const st = stat(r.box_key);
      if (st && st.engagement >= r.threshold) fired.push({ rule_id: r.id, tag: r.tag });
    } else if (r.kind === 'aggregate') {
      const boxes = store.boxes.filter(b => b.page_id === page.id);
      const vals = boxes.map(b => stat(b.box_key)?.engagement ?? 0);
      const avg = vals.reduce((a, c) => a + c, 0) / (vals.length || 1);
      if (avg >= r.threshold) fired.push({ rule_id: r.id, tag: r.tag });
    }
  }
  return fired;
}

// tag_fires を「セッション単位で重複させず」更新（idempotent）
function recordFires(store, anon_id, fired) {
  for (const f of fired) {
    const exists = store.tag_fires.find(x => x.session_anon === anon_id && x.tag === f.tag);
    if (!exists) store.tag_fires.push({ session_anon: anon_id, rule_id: f.rule_id, tag: f.tag, friend_id: null });
  }
}

function applyTagsToFriend(store, friend_id, tags) {
  if (store.profiling_opt_out?.has(friend_id)) return; // プロファイリング拒否者にはタグを付けない
  if (needsReconsent(store, friend_id)) return; // 再同意待ち（目的変更後）はタグを付けない
  if (!store.friend_tags.has(friend_id)) store.friend_tags.set(friend_id, new Set());
  const set = store.friend_tags.get(friend_id);
  for (const t of tags) set.add(t);
}

// ③因果エンジン用：結合済み(同意)friendの来訪行（box_engagement＋予約有無）を作る
function friendJourneyRows(store, fid) {
  const rows = [];
  const booked = store.bookings.has(fid);
  for (const [anon, id] of store.identity) {
    if (id.friend_id !== fid || !id.consented) continue; // 同意ゲートを踏襲
    const sess = store.sessions.get(anon);
    if (!sess) continue;
    const page = store.pages.find(p => p.id === sess.page_id);
    const box_engagement = {};
    for (const b of store.boxes.filter(x => x.page_id === sess.page_id)) {
      const st = store.box_stats.get(`${anon}::${b.box_key}`);
      box_engagement[b.box_key] = st ? Math.round(st.engagement) : 0;
    }
    rows.push({ page_slug: page.slug, box_engagement, booked });
  }
  return rows;
}

// friendの「代表的な因果」を1つ選ぶ：到達深度が最大（＝最も予約に近づいた）来訪を採用（打ち手が具体的）。
// 因果は行動ベース＝予約(成果)には依存しない。予約は cause-outcomes / diagnose.booked で別軸に測る。
function primaryCause(store, fid) {
  const rows = friendJourneyRows(store, fid);
  if (rows.length === 0) return null;
  let best = null;
  for (const r of rows) {
    const cause = inferCause(r);
    if (!best || cause.reached_depth > best.reached_depth) best = cause;
  }
  return best;
}

// ---- HTTP ハンドラ ----
function handle(store, req, res, body) {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  // RLS相当：呼び出し元テナント（本番はJWT・デモは x-tenant-id ヘッダ）。未指定なら管理ビュー扱い。
  const callerTenant = req.headers?.['x-tenant-id'] || null;
  const denyCrossTenant = (ownerTenant) => !tenantAccessAllowed(callerTenant, ownerTenant);

  // POST /api/attn/collect — SDKからのバッチ（到達＋ボックス視線）
  if (req.method === 'POST' && url.pathname === '/api/attn/collect') {
    let raw; try { raw = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    // 要配慮個人情報ガード：症状/診断など健康フィールドは結合させない（剥がす）
    const { clean: d, stripped } = stripSensitive(raw);
    if (!d.anon_id || !d.page_slug) return send(400, { error: 'anon_id, page_slug required' });
    const page = pageBySlug(store, d.page_slug);
    if (!page) return send(404, { error: 'unknown page' });
    // 外部送信規律：通知を出す前に計測データを取らない（取得タイミングの保証）。ポリシーON時のみ強制。
    if (store.require_notice && d.notice_shown !== true) return send(403, { error: '外部送信の通知が未提示（notice_shown required）' });

    // 計測堅牢化P2（目付還流）：既知botは計測に入れない（滞在・因果・タグを歪ませない）。
    // GA4は黙って消すが、うちは件数を可視化する（bot-report）＝店主への信頼の担保。
    const ua = String(req.headers?.['user-agent'] || '');
    if (BOT_UA_RE.test(ua)) {
      store.bot_excluded.push({ reason: 'bot_ua', ua: ua.slice(0, 160), page_slug: d.page_slug, at: Date.now() });
      return send(200, { ok: true, excluded: 'bot_ua' });
    }

    // upsert session（同一 anon×page は1行）
    const sess = store.sessions.get(d.anon_id) || {
      anon_id: d.anon_id, tenant_id: page.tenant_id, page_id: page.id,
      entry_query: null, entry_pos: null, device: null, active_sec: 0, started_at: Date.now(),
    };
    // 計測堅牢化P2（挙動ベースの二段目）：SDKが「人間離れした挙動」を検知したらフラグ。
    // 隔離集計＝タグ発火・実名導線には乗せないが、データは監査用に残す（一度suspectになったら戻さない）
    if (d.suspect_bot === true) sess.suspect_bot = true;
    if (d.entry) {
      sess.entry_query = d.entry.query ?? sess.entry_query;
      sess.entry_pos = d.entry.pos ?? sess.entry_pos;
      sess.device = d.entry.device ?? sess.device;
      // 検索クエリの健康語＝要配慮個人情報の"推知"に配慮するフラグ
      sess.entry_health = detectHealthTerms(String(d.entry.query || '')).length > 0;
    }
    // 計測堅牢化P1（目付還流）：単調増加マージ。離脱時フラッシュ(P0)で複数バッチが届く前提なので、
    // 後着の途中スナップショット（小さい値）が確定値を巻き戻さないよう max を取る。
    if (typeof d.active_sec === 'number' && Number.isFinite(d.active_sec)) {
      sess.active_sec = Math.max(sess.active_sec || 0, d.active_sec);
    }
    sess.last_seen_at = Date.now();
    store.sessions.set(d.anon_id, sess);

    // upsert box_stats（型を防御：不正値でも落とさず安全化・P1単調増加マージ）
    const boxList = Array.isArray(d.boxes) ? d.boxes : [];
    for (const b of boxList) {
      if (!b || typeof b.box_key !== 'string') continue;
      const eng = Number(b.engagement), av = Number(b.active_view), rv = Number(b.revisits);
      const key = `${d.anon_id}::${b.box_key}`;
      const prev = store.box_stats.get(key);
      store.box_stats.set(key, {
        anon_id: d.anon_id, box_key: b.box_key,
        active_view: Math.max(prev?.active_view || 0, Number.isFinite(av) ? av : 0),
        engagement: Math.max(prev?.engagement || 0, Number.isFinite(eng) ? Math.min(100, Math.max(0, eng)) : 0),
        revisits: Math.max(prev?.revisits || 0, Number.isFinite(rv) ? rv : 0),
      });
    }

    // suspect_botセッションはタグ発火させない（実名導線・配信対象に乗せない＝隔離）
    const fired = sess.suspect_bot ? [] : evalTags(store, d.anon_id, page);
    recordFires(store, d.anon_id, fired);
    // 既に結合済みなら即 friend_tags へ反映（後追いcollectでもタグが増える）
    const id = store.identity.get(d.anon_id);
    if (id && id.consented) applyTagsToFriend(store, id.friend_id, fired.map(f => f.tag));

    return send(200, { ok: true, fired: fired.map(f => f.tag), stripped });
  }

  // POST /api/attn/merge — LINE友だち追加のLIFFコールバックで anon→friend 結合
  if (req.method === 'POST' && url.pathname === '/api/attn/merge') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (!d.anon_id || !d.friend_id) return send(400, { error: 'anon_id, friend_id required' });
    const consented = d.consented === true;

    // APPI31条(個人関連情報の第三者提供)：提供元Lokuの「本人同意の確認・記録義務」。
    // 同意の由来(誰が・どの方法で・いつ)を記録する。obtained_by/method が揃って初めて記録が"完全"。
    const cr = d.consent_record || {};
    const is_minor = cr.is_minor === true; // 本人が未成年か
    const consent_record = consented ? {
      obtained_by: cr.obtained_by || null, // 例: 店舗のLIFF同意画面 / スタッフ対面
      method: cr.method || null,           // 例: 'liff_optin' / 'paper' / 'verbal'
      is_minor,
      guardian_consent: is_minor ? (cr.guardian_consent === true) : null, // 未成年は保護者同意が必須
      at: Number.isFinite(cr.at) ? cr.at : Date.now(),
    } : null;
    // 未成年は「本人＋保護者同意」が揃って初めて記録完全（保護者同意欠落は不完全）
    const consent_record_complete = !!(consented && consent_record.obtained_by && consent_record.method
      && (!is_minor || consent_record.guardian_consent === true));

    // idempotent：同じ結合は上書きのみ、重複行を作らない
    // 同意は「その時点の利用目的バージョン」に紐づく（後で目的を広げたら再同意が要る）
    store.identity.set(d.anon_id, { friend_id: d.friend_id, consented, consent_record, consent_record_complete, consent_purpose_version: store.purpose_version });
    store.audit_log.push({ action: 'merge', friend_id: d.friend_id, consented, consent_record_complete, purpose_version: store.purpose_version, at: Date.now() });

    // tag_fires に friend_id を後埋め
    for (const f of store.tag_fires) if (f.session_anon === d.anon_id) f.friend_id = d.friend_id;

    // 同意があればタグを friend_tags に適用（同意なしは適用しない）
    if (consented) {
      const tags = store.tag_fires.filter(f => f.session_anon === d.anon_id).map(f => f.tag);
      applyTagsToFriend(store, d.friend_id, tags);
    }
    return send(200, { ok: true, friend_id: d.friend_id, consented, applied: consented, consent_record_complete });
  }

  // GET /api/attn/consent-record?friend_id= — APPI31条の確認・記録（提供元Lokuの証跡）
  if (req.method === 'GET' && url.pathname === '/api/attn/consent-record') {
    const fid = url.searchParams.get('friend_id');
    if (!fid) return send(400, { error: 'friend_id required' });
    if (denyCrossTenant(tenantOfFriend(store, fid))) return send(403, { error: 'tenant scope violation' }); // RLS相当
    const records = [];
    for (const [, id] of store.identity) {
      if (id.friend_id !== fid) continue;
      records.push({ consented: id.consented, complete: !!id.consent_record_complete, record: id.consent_record || null });
    }
    return send(200, { friend_id: fid, records, all_complete: records.length > 0 && records.every(r => !r.consented || r.complete) });
  }

  // GET /api/attn/journey?friend_id= — 結合後の来訪ジャーニー（同意済みのみ／friend_journeyビュー相当）
  if (req.method === 'GET' && url.pathname === '/api/attn/journey') {
    const fid = url.searchParams.get('friend_id');
    if (!fid) return send(400, { error: 'friend_id required' });
    if (denyCrossTenant(tenantOfFriend(store, fid))) return send(403, { error: 'tenant scope violation' }); // RLS相当
    const rows = [];
    for (const [anon, id] of store.identity) {
      if (id.friend_id !== fid || !id.consented) continue;         // 同意ゲート
      const sess = store.sessions.get(anon);
      if (!sess) continue;
      const page = store.pages.find(p => p.id === sess.page_id);
      const box_engagement = {};
      for (const b of store.boxes.filter(x => x.page_id === sess.page_id)) {
        const st = store.box_stats.get(`${anon}::${b.box_key}`);
        box_engagement[b.box_key] = st ? Math.round(st.engagement) : 0;
      }
      const exit = deriveExit(box_engagement); // P0:離脱点（行動ベース・予約とは独立）
      rows.push({
        friend_id: fid, page_slug: page.slug, page_kind: page.kind,
        entry_query: sess.entry_query, entry_pos: sess.entry_pos, device: sess.device,
        entry_health: !!sess.entry_health, // 健康関連検索（要配慮推知に配慮）
        active_sec: sess.active_sec, box_engagement,
        exit_box: exit.exit_box, exit_type: exit.exit_type, // P0:離脱ポイント
        search: searchSummary(store, sess.page_id), // 来る前（サチコAPI取込・無ければnull）
      });
    }
    return send(200, { friend_id: fid, journeys: rows });
  }

  // GET /api/attn/friend-tags?friend_id= — 付与済みタグ（Loku friend_tags 相当）
  if (req.method === 'GET' && url.pathname === '/api/attn/friend-tags') {
    const fid = url.searchParams.get('friend_id');
    if (!fid) return send(400, { error: 'friend_id required' });
    if (denyCrossTenant(tenantOfFriend(store, fid))) return send(403, { error: 'tenant scope violation' }); // RLS相当
    return send(200, { friend_id: fid, tags: [...(store.friend_tags.get(fid) || [])] });
  }

  // POST /api/attn/search-console/ingest — サチコAPIで引っ張った行を取り込む（来る前を搭載）
  if (req.method === 'POST' && url.pathname === '/api/attn/search-console/ingest') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (!d.page_slug || !Array.isArray(d.rows)) return send(400, { error: 'page_slug, rows required' });
    const page = pageBySlug(store, d.page_slug);
    if (!page) return send(404, { error: 'unknown page' });
    const n = ingestSearchConsole(store, { tenant_id: page.tenant_id, page_id: page.id, date: d.date || 'today', rows: d.rows });
    return send(200, { ok: true, ingested: n });
  }

  // GET /api/attn/search-summary?page_slug= — ページの検索サマリ（来る前）
  if (req.method === 'GET' && url.pathname === '/api/attn/search-summary') {
    const page = pageBySlug(store, url.searchParams.get('page_slug'));
    if (!page) return send(404, { error: 'unknown page' });
    return send(200, { page_slug: page.slug, search: searchSummary(store, page.id) });
  }

  // POST /api/attn/booking — 予約が入った友だちを記録（実測CVRの母数）
  if (req.method === 'POST' && url.pathname === '/api/attn/booking') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (!d.friend_id) return send(400, { error: 'friend_id required' });
    store.bookings.add(d.friend_id);
    return send(200, { ok: true });
  }

  // POST /api/attn/opt-out — 配信停止（お客様がいつでも止められる：LINE規約・特商法）
  if (req.method === 'POST' && url.pathname === '/api/attn/opt-out') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (!d.friend_id) return send(400, { error: 'friend_id required' });
    store.opt_out.add(d.friend_id);
    store.audit_log.push({ action: 'opt-out', friend_id: d.friend_id, at: Date.now() });
    return send(200, { ok: true });
  }

  // GET /api/attn/audit-log?friend_id= — 機微操作の証跡（安全管理措置・従業者の監督）
  if (req.method === 'GET' && url.pathname === '/api/attn/audit-log') {
    const fid = url.searchParams.get('friend_id');
    const entries = store.audit_log.filter(e => !fid || e.friend_id === fid || String(e.friend_id).includes(fid));
    return send(200, { friend_id: fid || null, entries });
  }

  // GET /api/attn/can-send?friend_id= — 配信可否（停止した人には送らない）
  if (req.method === 'GET' && url.pathname === '/api/attn/can-send') {
    const fid = url.searchParams.get('friend_id');
    if (!fid) return send(400, { error: 'friend_id required' });
    return send(200, { friend_id: fid, can_send: !store.opt_out.has(fid) });
  }

  // GET /api/attn/conversion-by-tag?tag= — タグ有/無の"実測"予約率（比較表の数字の裏付け）
  if (req.method === 'GET' && url.pathname === '/api/attn/conversion-by-tag') {
    const tag = url.searchParams.get('tag');
    if (!tag) return send(400, { error: 'tag required' });
    const friends = [...store.friend_tags.keys()];
    const has = f => store.friend_tags.get(f).has(tag);
    const booked = f => store.bookings.has(f);
    const rate = arr => arr.length ? Math.round(arr.filter(booked).length / arr.length * 100) : 0;
    const wit = friends.filter(has), wo = friends.filter(f => !has(f));
    return send(200, { tag,
      with: { n: wit.length, booked: wit.filter(booked).length, rate: rate(wit) },
      without: { n: wo.length, booked: wo.filter(booked).length, rate: rate(wo) } });
  }

  // POST /api/attn/product-event — 自分の画面(オンボ/管理)の利用イベント（ドッグフーディング）
  if (req.method === 'POST' && url.pathname === '/api/attn/product-event') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    const pstep = Number(d.step);
    if (!d.surface || !Number.isFinite(pstep)) return send(400, { error: 'surface, finite step required' });
    store.product_events.push({ surface: d.surface, step: pstep, event: d.event || 'reach', at: Date.now() });
    return send(200, { ok: true });
  }

  // GET /api/attn/product-funnel?surface= — 自分の画面のステップ別残存率（自己改善の"気づき"）
  if (req.method === 'GET' && url.pathname === '/api/attn/product-funnel') {
    const surface = url.searchParams.get('surface');
    if (!surface) return send(400, { error: 'surface required' });
    const rows = store.product_events.filter(e => e.surface === surface && e.event === 'reach');
    const byStep = {};
    for (const r of rows) byStep[r.step] = (byStep[r.step] || 0) + 1;
    const steps = Object.keys(byStep).map(Number).sort((a, b) => a - b);
    const base = steps.length ? byStep[steps[0]] : 0;
    const funnel = steps.map(s => ({ step: s, reach: byStep[s], rate: base ? Math.round(byStep[s] / base * 100) : 0 }));
    return send(200, { surface, funnel });
  }

  // POST /api/attn/check-copy — 改善コピーの出稿前チェック（薬機/景表/柔整・あはき）
  if (req.method === 'POST' && url.pathname === '/api/attn/check-copy') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (typeof d.text !== 'string') return send(400, { error: 'text required' });
    return send(200, checkCopy(d.text, d.industry));
  }

  // POST /api/attn/forget — オプトアウト/削除権：匿名 or 友だち単位で計測データを消す
  if (req.method === 'POST' && url.pathname === '/api/attn/forget') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (!d.anon_id && !d.friend_id) return send(400, { error: 'anon_id or friend_id required' });
    // 本人起点の削除請求は本人確認が必須（なりすまし削除の防止）。社内運用(subject_request無し)は対象外。
    if (d.subject_request === true && d.identity_verified !== true) return send(403, { error: '本人確認が未了（identity_verified required）' });
    // 対象 anon_id 群を決定
    let anons = [];
    if (d.anon_id) anons = [d.anon_id];
    else { for (const [anon, id] of store.identity) if (id.friend_id === d.friend_id) anons.push(anon); }
    let removed = 0;
    for (const anon of anons) {
      store.sessions.delete(anon);
      for (const key of [...store.box_stats.keys()]) if (key.startsWith(anon + '::')) { store.box_stats.delete(key); removed++; }
      store.identity.delete(anon);
      store.tag_fires = store.tag_fires.filter(f => f.session_anon !== anon);
    }
    if (d.friend_id) store.friend_tags.delete(d.friend_id); // 付与済みタグも撤回
    store.audit_log.push({ action: 'forget', friend_id: d.friend_id || anons.join(','), subject_request: d.subject_request === true, identity_verified: d.identity_verified === true, at: Date.now() });
    return send(200, { ok: true, forgotten: anons, boxStatsRemoved: removed });
  }

  // POST /api/attn/export — friend単位の計測データをCSVで持ち出し（開示請求対応）
  // 安全管理：actor必須(誰が)＝持ち出しログ・数式インジェクション対策・任意でAES暗号化。
  if (req.method === 'POST' && url.pathname === '/api/attn/export') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (!d.friend_id) return send(400, { error: 'friend_id required' });
    if (!d.actor) return send(400, { error: 'actor required（持ち出しログのため誰が実行したか必須）' });
    if (d.subject_request === true && d.identity_verified !== true) return send(403, { error: '本人確認が未了（identity_verified required）' }); // 本人起点の開示請求は本人確認必須
    if (denyCrossTenant(tenantOfFriend(store, d.friend_id))) return send(403, { error: 'tenant scope violation' }); // 他テナントの持ち出し禁止
    const { csv, rows } = buildFriendCsv(store, d.friend_id);
    const encrypted = d.passphrase != null && d.passphrase !== '';
    // 持ち出しログ（安全管理措置・従業者の監督）
    store.audit_log.push({ action: 'export', friend_id: d.friend_id, actor: String(d.actor), rows, encrypted, subject_request: d.subject_request === true, identity_verified: d.identity_verified === true, at: Date.now() });
    if (encrypted) return send(200, { ok: true, friend_id: d.friend_id, rows, encrypted: true, payload: encryptCsv(csv, d.passphrase) });
    return send(200, { ok: true, friend_id: d.friend_id, rows, encrypted: false, csv });
  }

  // GET /api/attn/public-notice?page_slug= — 保有個人データに関する事項の公表（本人が知り得る状態に置く）
  if (req.method === 'GET' && url.pathname === '/api/attn/public-notice') {
    const slug = url.searchParams.get('page_slug');
    const page = slug ? pageBySlug(store, slug) : null;
    if (slug && !page) return send(404, { error: 'unknown page' });
    if (page && denyCrossTenant(page.tenant_id)) return send(403, { error: 'tenant scope violation' });
    const ppUrl = (page && store.privacy_policy_urls?.get(page.tenant_id)) || null;
    const disclosure = buildDisclosure({ privacyPolicyUrl: ppUrl });
    return send(200, {
      business_operator: 'Loku（本サービス運営者）', // 実際の事業者名・所在地・代表者は運用者が設定
      purposes: disclosure.purposes,                   // 利用目的
      purpose_version: store.purpose_version,
      retained_data_kinds: disclosure.items,           // 保有個人データの種類
      transfer: transferAssessment(store.subprocessors), // 委託先・越境の状況
      subject_rights: {                                // 開示・訂正・利用停止・削除の請求手続き
        disclosure: 'POST /api/attn/export（本人起点はidentity_verified必須）',
        deletion: 'POST /api/attn/forget（本人起点はidentity_verified必須）',
        stop_delivery: 'POST /api/attn/opt-out',
        stop_profiling: 'POST /api/attn/profiling-opt-out',
        contact: null, // 苦情・請求の窓口は運用者が設定（当方で代筆しない）
      },
      privacy_policy_url: ppUrl,
      note: '本オブジェクトは「本人が知り得る状態」に置くための公表用。事業者名/所在地/窓口は運用者が補う欄。',
    });
  }

  // GET/POST /api/attn/notice-policy — 「通知前は計測しない」ポリシーの取得/設定（取得タイミングの保証）
  if (url.pathname === '/api/attn/notice-policy') {
    if (req.method === 'GET') return send(200, { require_notice: store.require_notice });
    if (req.method === 'POST') {
      let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
      if (typeof d.require !== 'boolean') return send(400, { error: 'require (boolean) required' });
      store.require_notice = d.require;
      return send(200, { ok: true, require_notice: store.require_notice });
    }
  }

  // POST /api/attn/incident — 漏えい等インシデントを記録し、報告・本人通知の要否を判定（APPI26条）
  if (req.method === 'POST' && url.pathname === '/api/attn/incident') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (!d.summary) return send(400, { error: 'summary required（インシデントの概要）' });
    const assessment = assessBreach(d);
    const incident = { id: `inc_${store.incidents.length + 1}`, summary: String(d.summary),
      affected: assessment.affected, includes_sensitive: d.includes_sensitive === true,
      unauthorized_access: d.unauthorized_access === true, assessment, at: Date.now() };
    store.incidents.push(incident);
    store.audit_log.push({ action: 'incident', friend_id: incident.id, must_report: assessment.must_report, at: Date.now() });
    return send(200, { ok: true, incident });
  }
  // GET /api/attn/incidents — インシデント台帳（報告義務の管理）
  if (req.method === 'GET' && url.pathname === '/api/attn/incidents') {
    return send(200, { incidents: store.incidents, open_report_obligations: store.incidents.filter(i => i.assessment.must_report).length });
  }

  // GET/POST /api/attn/purpose-version — 利用目的のバージョン。上げると旧同意は再同意待ちに（目的外利用の防止）
  if (url.pathname === '/api/attn/purpose-version') {
    if (req.method === 'GET') return send(200, { purpose_version: store.purpose_version });
    if (req.method === 'POST') {
      let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
      const v = Number(d.version);
      if (!Number.isInteger(v) || v <= store.purpose_version) return send(400, { error: `version must be an integer > ${store.purpose_version}` });
      store.purpose_version = v;
      store.audit_log.push({ action: 'purpose-version-bump', friend_id: `v${v}`, purpose: d.purpose || null, at: Date.now() });
      return send(200, { ok: true, purpose_version: v, note: '旧バージョンで同意した友だちは再同意が必要（それまでタグ付与は停止）' });
    }
  }
  // GET /api/attn/reconsent-status?friend_id= — 目的変更後に再同意が必要か
  if (req.method === 'GET' && url.pathname === '/api/attn/reconsent-status') {
    const fid = url.searchParams.get('friend_id');
    if (!fid) return send(400, { error: 'friend_id required' });
    if (denyCrossTenant(tenantOfFriend(store, fid))) return send(403, { error: 'tenant scope violation' });
    return send(200, { friend_id: fid, current_version: store.purpose_version, needs_reconsent: needsReconsent(store, fid) });
  }

  // GET /api/attn/profiling-info?page_slug= — プロファイリングの透明化（どのタグを何を根拠に付けるか）
  if (req.method === 'GET' && url.pathname === '/api/attn/profiling-info') {
    const slug = url.searchParams.get('page_slug');
    const page = slug ? pageBySlug(store, slug) : null;
    if (slug && !page) return send(404, { error: 'unknown page' });
    if (page && denyCrossTenant(page.tenant_id)) return send(403, { error: 'tenant scope violation' });
    const rules = page ? rulesForPage(store, page.id) : store.tag_rules;
    const basis = (r) => r.kind === 'route' ? 'ページに到達したら付与'
      : r.kind === 'heat' ? `「${r.box_key}」への注視度が${r.threshold}以上で付与`
      : r.kind === 'aggregate' ? `ページ全体の注視度の平均が${r.threshold}以上で付与` : 'その他';
    return send(200, {
      page_slug: slug || null,
      note: '視線・行動データからタグ（見込み度合い）を自動付与します。付与を望まない場合は停止できます。',
      profiles: rules.map(r => ({ tag: r.tag, basis: basis(r) })),
      opt_out_endpoint: 'POST /api/attn/profiling-opt-out',
    });
  }
  // POST /api/attn/profiling-opt-out — プロファイリング（タグ付け）の拒否。既存タグも撤回。
  if (req.method === 'POST' && url.pathname === '/api/attn/profiling-opt-out') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (!d.friend_id) return send(400, { error: 'friend_id required' });
    if (denyCrossTenant(tenantOfFriend(store, d.friend_id))) return send(403, { error: 'tenant scope violation' });
    store.profiling_opt_out.add(d.friend_id);
    store.friend_tags.delete(d.friend_id); // 既に付与済みのタグを撤回
    store.audit_log.push({ action: 'profiling-opt-out', friend_id: d.friend_id, at: Date.now() });
    return send(200, { ok: true, friend_id: d.friend_id, profiling: 'stopped' });
  }

  // GET /api/attn/subprocessors — 委託先レジストリ＋越境判定（APPI28条 越境移転／25条 委託先監督）
  if (req.method === 'GET' && url.pathname === '/api/attn/subprocessors') {
    return send(200, transferAssessment(store.subprocessors));
  }
  // POST /api/attn/subprocessors — 委託先のリージョン(保管国)を運用者が登録（当方で断定しない）
  if (req.method === 'POST' && url.pathname === '/api/attn/subprocessors') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (!d.id || !d.region) return send(400, { error: 'id and region required（保管国コード 例:JP/US）' });
    const sp = store.subprocessors.find(s => s.id === d.id);
    if (!sp) return send(404, { error: 'unknown subprocessor' });
    sp.region = String(d.region).toUpperCase();
    return send(200, { ok: true, subprocessor: sp, assessment: transferAssessment(store.subprocessors) });
  }

  // POST /api/attn/privacy-policy — 店舗が自らのプライバシーポリシーURLを登録（当方で代筆しない）
  if (req.method === 'POST' && url.pathname === '/api/attn/privacy-policy') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (!d.page_slug || !d.url) return send(400, { error: 'page_slug and url required' });
    const page = pageBySlug(store, d.page_slug);
    if (!page) return send(404, { error: 'unknown page' });
    if (!/^https?:\/\//.test(String(d.url))) return send(400, { error: 'url must be http(s)' });
    store.privacy_policy_urls.set(page.tenant_id, d.url);
    return send(200, { ok: true, tenant_id: page.tenant_id, url: d.url });
  }

  // GET /api/attn/disclosure?page_slug= — 外部送信の通知（何を・どこへ・何のため）をLPに埋め込む
  if (req.method === 'GET' && url.pathname === '/api/attn/disclosure') {
    const slug = url.searchParams.get('page_slug');
    const page = slug ? pageBySlug(store, slug) : null;
    if (slug && !page) return send(404, { error: 'unknown page' });
    if (page && denyCrossTenant(page.tenant_id)) return send(403, { error: 'tenant scope violation' }); // RLS相当
    // 店舗が設定したポリシーURLがあれば載せる（無ければ空欄のまま）
    const ppUrl = (page && store.privacy_policy_urls?.get(page.tenant_id)) || null;
    return send(200, buildDisclosure({ privacyPolicyUrl: ppUrl }));
  }

  // POST /api/attn/purge — 保持期間を過ぎた計測データを消去（安全管理措置・保存期間の管理）
  // 本番は cron で定期実行する想定。retention_days 既定=730(24ヶ月・schema.sql準拠)。
  if (req.method === 'POST' && url.pathname === '/api/attn/purge') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    const days = d.retention_days == null ? 730 : Number(d.retention_days);
    if (!Number.isFinite(days) || days < 0) return send(400, { error: 'retention_days must be >= 0' });
    const now = Number.isFinite(d.now) ? d.now : Date.now();
    const cutoff = now - days * 86400000;
    const res2 = purgeExpired(store, cutoff);
    store.audit_log.push({ action: 'purge', friend_id: `retention:${days}d`, purged: res2.purgedAnons.length, at: now });
    return send(200, { ok: true, retention_days: days, cutoff, ...res2 });
  }

  // GET /api/attn/bot-report — 計測から除外したbotの可視化（目付還流P2）。
  // GA4は黙って消すが、うちは「何件弾いたか」を店主に見せる＝数字の信頼の担保。
  if (req.method === 'GET' && url.pathname === '/api/attn/bot-report') {
    const suspects = [...store.sessions.values()].filter(s => s.suspect_bot && !denyCrossTenant(s.tenant_id));
    return send(200, {
      excluded_count: store.bot_excluded.length,          // UAで入口除外した数
      suspect_count: suspects.length,                     // 挙動フラグで隔離中の数
      recent_excluded: store.bot_excluded.slice(-10),     // 直近の除外記録（監査用）
      note: '除外・隔離は黙って消さず件数で可視化する（店主に見せる数字の信頼担保）',
    });
  }

  // GET /api/attn/presets — L2プリセット台帳（楔=wedge:true が現行の一次営業先）
  if (req.method === 'GET' && url.pathname === '/api/attn/presets') {
    const presets = Object.values(PRESETS).map(p => ({ key: p.key, label: p.label, industry: p.industry, wedge: p.wedge }));
    return send(200, { default: DEFAULT_PRESET, presets });
  }

  // GET /api/attn/diagnose?friend_id=&preset= — ③因果診断（P1+P2）：離脱点→なぜ→次の一手
  // preset=L2業種プリセット（既定 judo・後方互換）。因果コードはプリセット非依存＝言語化だけが変わる。
  if (req.method === 'GET' && url.pathname === '/api/attn/diagnose') {
    const fid = url.searchParams.get('friend_id');
    if (!fid) return send(400, { error: 'friend_id required' });
    const presetKey = url.searchParams.get('preset') || DEFAULT_PRESET;
    if (!PRESETS[presetKey]) return send(400, { error: 'unknown preset' });
    if (denyCrossTenant(tenantOfFriend(store, fid))) return send(403, { error: 'tenant scope violation' }); // RLS相当
    const booked = store.bookings.has(fid); // 成果（因果とは別軸）
    const diagnoses = friendJourneyRows(store, fid).map(r => {
      const cause = inferCause(r, presetKey);
      const actions = suggestActions(cause.code, presetKey);
      return {
        page_slug: r.page_slug, exit_box: cause.exit_box, exit_type: cause.exit_type,
        cause: { code: cause.code, label: cause.label, confidence: cause.confidence },
        booked, // 予約に至ったか（後段のLINE配信等の成果を含む）
        evidence: cause.evidence, explanation: cause.explanation, actions,
      };
    });
    return send(200, { friend_id: fid, preset: presetKey, diagnoses });
  }

  // GET /api/attn/cause-segments — ③離脱理由でセグメント化（P3の入力・Loku受け渡しの材料）
  if (req.method === 'GET' && url.pathname === '/api/attn/cause-segments') {
    const seen = new Set(); const byCode = {};
    for (const [, id] of store.identity) {
      if (!id.consented || seen.has(id.friend_id)) continue;
      seen.add(id.friend_id);
      if (denyCrossTenant(tenantOfFriend(store, id.friend_id))) continue; // 自テナントのみ
      const cause = primaryCause(store, id.friend_id);
      if (!cause) continue;
      (byCode[cause.code] ||= { cause_code: cause.code, cause_label: cause.label, friends: [] }).friends.push(id.friend_id);
    }
    const segments = Object.values(byCode).map(s => ({ ...s, count: s.friends.length }));
    return send(200, { segments });
  }

  // POST /api/attn/dispatch-plan — ③の出口（P3）：因果セグメントを Loku 配信の"計画"に変換。
  // 送信はしない（撃つのは Loku 本体AI配信）。承認前提＋一言はcheckCopyを必ず通す（安全弁）。
  if (req.method === 'POST' && url.pathname === '/api/attn/dispatch-plan') {
    let d; try { d = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
    if (!d.cause_code) return send(400, { error: 'cause_code required' });
    if (!CAUSE_CODES.includes(d.cause_code)) return send(400, { error: 'unknown cause_code' });
    const presetKey = d.preset || DEFAULT_PRESET; // L2プリセット（既定 judo・後方互換）
    if (!PRESETS[presetKey]) return send(400, { error: 'unknown preset' });
    // 検査業種：明示指定 > プリセット既定。judo既定＝最も厳しい基準（限定列挙）で検査
    const industry = d.industry || getPreset(presetKey).industry;
    // セグメント抽出：同意済み・自テナント・配信可(opt_out除外)・プロファイリング拒否は除外
    const seen = new Set(); const segment = [];
    for (const [, id] of store.identity) {
      if (!id.consented || seen.has(id.friend_id)) continue;
      seen.add(id.friend_id);
      const fid = id.friend_id;
      if (denyCrossTenant(tenantOfFriend(store, fid))) continue;
      if (store.opt_out.has(fid)) continue;            // 配信停止者は送らない
      if (store.profiling_opt_out.has(fid)) continue;  // プロファイリング拒否者は対象外
      if (store.bookings.has(fid)) continue;           // 予約済み（成果達成）には追客しない
      const cause = primaryCause(store, fid);
      if (cause && cause.code === d.cause_code) segment.push(fid);
    }
    const actions = suggestActions(d.cause_code, presetKey);
    const msg = actions.outreach.message;
    const check = msg ? checkCopy(msg, industry) : { ok: true, blocked: false, violations: [] };
    return send(200, {
      ok: true, cause_code: d.cause_code, cause_label: CAUSE_LABEL[d.cause_code], preset: presetKey,
      segment, count: segment.length,
      funnel: actions.funnel, // 導線チューニング案（店主向け・構成の提案）
      outreach: {
        has_message: actions.outreach.has_message,
        message: check.blocked ? null : msg, // NGならブロック＝配信下書きを渡さない（安全弁）
        blocked: check.blocked, violations: check.violations, checked_industry: industry,
      },
      requires_approval: true, auto_sent: false, // human-in-the-loop・本APIは送信しない
      delivery_via: 'Loku本体 AI配信（シナリオ/ブロードキャスト）',
      note: '本APIは送信しない。因果＋セグメント＋下書きを作るのみ。承認後にLokuが配信する。',
    });
  }

  // GET /api/attn/cause-outcomes — ③P4基盤：因果ごとの実測成果（予約率）。
  // 「どの離脱理由が結局は予約に至るか」の答え合わせ信号。自己最適化(打ち手の優先度学習)の入力。
  // ※適応的な重み学習そのものは実データの経時蓄積が要る。ここは"計測の土台"まで。
  if (req.method === 'GET' && url.pathname === '/api/attn/cause-outcomes') {
    const seen = new Set(); const byCode = {};
    for (const [, id] of store.identity) {
      if (!id.consented || seen.has(id.friend_id)) continue;
      seen.add(id.friend_id);
      const fid = id.friend_id;
      if (denyCrossTenant(tenantOfFriend(store, fid))) continue; // 自テナントのみ
      const cause = primaryCause(store, fid);
      if (!cause) continue;
      const rec = (byCode[cause.code] ||= { cause_code: cause.code, cause_label: cause.label, n: 0, booked: 0 });
      rec.n++;
      if (store.bookings.has(fid)) rec.booked++;
    }
    const outcomes = Object.values(byCode)
      .map(r => ({ ...r, booked_rate: r.n ? Math.round(r.booked / r.n * 100) : 0 }))
      .sort((a, b) => b.n - a.n); // 母数が多い順（着手優先度の目安）
    return send(200, { outcomes });
  }

  // デモ専用：graceful shutdown（allowShutdown時のみ有効。本番には載せない）
  if (url.pathname === '/__shutdown' && store._allowShutdown) {
    res.setHeader('connection', 'close');
    send(200, { ok: true });
    setTimeout(() => {
      try { store._server.closeAllConnections?.(); } catch {}
      store._server.close(() => process.exit(0)); // 接続を閉じてから正常終了
    }, 50);
    return;
  }

  return send(404, { error: 'not found' });
}

export function createServer(opts = {}) {
  const store = seedStore();
  store._allowShutdown = opts.allowShutdown === true;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { handle(store, req, res, body); } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); } });
  });
  server._store = store;
  store._server = server;
  return server;
}
