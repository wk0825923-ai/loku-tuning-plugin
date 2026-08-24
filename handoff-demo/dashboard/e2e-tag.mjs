// e2e-tag.mjs — M3層A E2E検証スクリプト（再実行可能）
// 目的：「タグ→collect→因果エンジン→ダッシュボード」の一気通貫をローカルで検証する。
// app.mjs/test.mjs/README.md/schema.sql は編集禁止（別セッション未コミット変更あり）のため、
// このスクリプトは外部から実HTTPで叩くだけで、上記ファイルには一切触れない。
//
// 前提：dashboard/serve-dash.mjs を別途起動しておくこと（PORT既定8788、DASH_PORT環境変数で変更可）。
//   node dashboard/serve-dash.mjs
//   node dashboard/e2e-tag.mjs
//
// タグ実装の純関数（parseAdParams/resolveAnonId/computeAutoBoxes/mergeBoxStats/buildPayload）を
// loku-attn.js から実際にimportして使い、ブラウザなしでSDKと同じペイロード組み立てロジックを再現する。

import { parseAdParams, resolveAnonId, computeAutoBoxes, mergeBoxStats, buildPayload } from './loku-attn.js';

const PORT = process.env.DASH_PORT || 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE_SLUG = 'seitai-lp-a';

function genId(seed) {
  return `e2e_${seed}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function postJSON(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function getJSON(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

// --- タグ実装の純関数を使って1セッション分のボックス滞留マップを組み立てる ---
// boxOrder = ['hero','problem','beforeafter','staff','pricing','voice','faq','cta']
function buildBoxes(engagedKeys, extra = {}) {
  // 各ボックスに単調増加マージ(mergeBoxStats)を通して確定値を作る（P1ロジック踏襲）
  return engagedKeys.map(key => {
    const incoming = { active_view: extra[key]?.active_view ?? 5, engagement: extra[key]?.engagement ?? 50, revisits: 1 };
    const merged = mergeBoxStats(undefined, incoming);
    return { box_key: key, ...merged };
  });
}

async function runVisitor({ label, adSearch, engagedKeys, extraEngagement, doMerge, doBooking }) {
  console.log(`\n=== 来訪者: ${label} ===`);

  // 1) タグ実装の関数でanon_id発行（cookie/storage両方未保持=新規発行のケースを再現）
  const { anonId, isNew } = resolveAnonId({
    cookieVal: null, cookieAt: null, storageVal: null, storageAt: null,
    now: Date.now(), genId: () => genId(label),
  });
  console.log(`anon_id=${anonId} isNew=${isNew}`);

  // 2) lt_src/lt_ad をURLクエリから解析（タグ実装の純関数）
  const adParams = parseAdParams(adSearch);
  console.log(`adParams=${JSON.stringify(adParams)}`);

  // 3) 見出し境界からの自動ブロック分割ロジックの動作確認（実LPのdata-box未設定ケース相当）
  const autoBoxes = computeAutoBoxes([
    { tag: 'H1', text: 'まずは体験にお越しください' },
    { tag: 'SECTION', text: 'お悩みではありませんか' },
  ]);
  console.log(`computeAutoBoxes sample=${JSON.stringify(autoBoxes)}`);

  // 4) ペイロード組み立て（タグ実装の buildPayload をそのまま使用）
  const boxes = buildBoxes(engagedKeys, extraEngagement);
  const payload = buildPayload({
    anonId, pageSlug: PAGE_SLUG,
    entry: { query: null, pos: null, device: 'desktop', source: null, medium: null, campaign: null },
    utm: null, referrer: 'https://line.me/', activeSec: engagedKeys.length * 8,
    boxes, adParams, noticeShown: true, // require_notice=falseだが正規手順としてnotice_shown=trueを送る
  });

  // 5) 実HTTPで /api/attn/collect へPOST（初回到達フラッシュ相当）
  const first = await postJSON('/api/attn/collect', payload);
  console.log(`collect(1st) -> ${first.status} ${JSON.stringify(first.json)}`);

  // 6) 離脱フラッシュ（sendBeacon相当）— 同一ペイロードをもう一度送り、単調増加マージを再現
  const flush = await postJSON('/api/attn/collect', payload);
  console.log(`collect(flush/beacon相当) -> ${flush.status} ${JSON.stringify(flush.json)}`);

  let friendId = null;
  let mergeResult = null;
  if (doMerge) {
    friendId = `fr_${anonId}`;
    mergeResult = await postJSON('/api/attn/merge', {
      anon_id: anonId, friend_id: friendId, consented: true,
      consent_record: { obtained_by: 'store_liff_optin', method: 'liff_optin', is_minor: false, at: Date.now() },
    });
    console.log(`merge -> ${mergeResult.status} ${JSON.stringify(mergeResult.json)}`);
  }

  let bookingResult = null;
  if (doBooking && friendId) {
    bookingResult = await postJSON('/api/attn/booking', { friend_id: friendId });
    console.log(`booking -> ${bookingResult.status} ${JSON.stringify(bookingResult.json)}`);
  }

  return { label, anonId, friendId, adParams, fired: first.json?.fired || [] };
}

async function main() {
  console.log(`BASE=${BASE}`);
  const health = await getJSON('/api/attn/presets');
  console.log(`health check /api/attn/presets -> ${health.status}`);
  if (health.status !== 200) throw new Error('サーバに接続できません。先に serve-dash.mjs を起動してください。');

  // --- 3人分、離脱パターンを変えて投入 ---
  // A: pricing離脱（beforeafter/staffは見た上で、pricingで離脱＝value_before_priceではなくprice_anxietyを狙う）
  const visitorA = await runVisitor({
    label: 'pricingExit',
    adSearch: '?lt_src=meta&lt_ad=E2E割',
    engagedKeys: ['hero', 'problem', 'beforeafter', 'staff', 'pricing'],
    extraEngagement: { beforeafter: { active_view: 8, engagement: 45 } }, // >=LOW(30)にしてvalue_before_priceを回避
    doMerge: true, doBooking: false,
  });

  // B: cta離脱（cta到達=exit_type form_abandon＝cta_friction、他は未予約）
  const visitorB = await runVisitor({
    label: 'ctaExit',
    adSearch: '?lt_src=meta&lt_ad=E2E割',
    engagedKeys: ['hero', 'problem', 'beforeafter', 'staff', 'pricing', 'voice', 'faq', 'cta'],
    extraEngagement: {},
    doMerge: true, doBooking: false,
  });

  // C: 予約到達（cta到達まで見た上で、実際にbooking APIまで通す＝outcome側の答え合わせ用）
  const visitorC = await runVisitor({
    label: 'bookingReach',
    adSearch: '?lt_src=line&lt_ad=E2E友だち限定',
    engagedKeys: ['hero', 'problem', 'beforeafter', 'staff', 'pricing', 'voice', 'faq', 'cta'],
    extraEngagement: {},
    doMerge: true, doBooking: true,
  });

  const visitors = [visitorA, visitorB, visitorC];

  // --- 因果分類の答え合わせ（diagnose） ---
  console.log('\n=== diagnose 答え合わせ ===');
  const diagnoseResults = [];
  for (const v of visitors) {
    const d = await getJSON(`/api/attn/diagnose?friend_id=${v.friendId}&preset=pilates`);
    console.log(`${v.label} (${v.friendId}) -> ${JSON.stringify(d.json)}`);
    diagnoseResults.push({ label: v.label, friendId: v.friendId, result: d.json });
  }

  // --- cause-segments / cause-outcomes ---
  console.log('\n=== cause-segments ===');
  const segments = await getJSON('/api/attn/cause-segments');
  console.log(JSON.stringify(segments.json, null, 2));

  console.log('\n=== cause-outcomes ===');
  const outcomes = await getJSON('/api/attn/cause-outcomes');
  console.log(JSON.stringify(outcomes.json, null, 2));

  // --- lt_src/lt_ad の行き先検証：journeyレスポンスに現れるか確認 ---
  console.log('\n=== lt_src/lt_ad の行き先検証（journey API） ===');
  const journeyChecks = [];
  for (const v of visitors) {
    const j = await getJSON(`/api/attn/journey?friend_id=${v.friendId}`);
    const row = j.json?.journeys?.[0] || null;
    const hasLtFields = row ? ('lt_src' in row || 'lt_ad' in row) : null;
    console.log(`${v.label} sent adParams=${JSON.stringify(v.adParams)} -> journey row keys=${row ? Object.keys(row).join(',') : 'none'} / lt_src or lt_ad present=${hasLtFields}`);
    journeyChecks.push({ label: v.label, sentAdParams: v.adParams, journeyRowKeys: row ? Object.keys(row) : [], ltFieldsPresent: hasLtFields });
  }

  // --- ダッシュボード画面1が叩くAPI（journey-intelligence / cause-outcomes）を実際に取得 ---
  console.log('\n=== ダッシュボード画面1 API検証 ===');
  const ji = await getJSON(`/api/attn/journey-intelligence?page_slug=${PAGE_SLUG}`);
  console.log(`journey-intelligence -> ${ji.status}`);
  const jiOutcomesEcho = await getJSON('/api/attn/cause-outcomes');
  console.log('screen-1 cause-outcomes echo:', JSON.stringify(jiOutcomesEcho.json, null, 2));

  return { visitors, diagnoseResults, segments: segments.json, outcomes: outcomes.json, journeyChecks, journeyIntelligenceStatus: ji.status, journeyIntelligence: ji.json };
}

main()
  .then(result => {
    console.log('\n=== SUMMARY (JSON) ===');
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error('E2E失敗:', err);
    process.exit(1);
  });
