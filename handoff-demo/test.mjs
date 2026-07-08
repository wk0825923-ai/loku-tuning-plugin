// 自動テスト（依存ゼロ）。各テストは createServer() で新インスタンス＝状態隔離。
// フルスイートを N 回ループして安定性・冪等性を確認する。
import { createServer, csvCell, encryptCsv } from './app.mjs';
import { stripSensitive } from './compliance.mjs';
import { assertReadonlyScope, REQUIRED_SCOPE, fetchSearchConsole } from './search-console.mjs';
import { deriveExit, inferCause, suggestActions, CAUSE_LABEL, CAUSE_CODES, BOX_ORDER } from './causal.mjs';
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const fails = [];
// セクション別集計（元機能A / ③新機能B / 相互作用・回帰C を分けて数える）
const sections = {};
let curSection = 'misc';
function section(name) { curSection = name; if (!sections[name]) sections[name] = { pass: 0, fail: 0 }; }
function ok(cond, msg) {
  if (!sections[curSection]) sections[curSection] = { pass: 0, fail: 0 };
  if (cond) { pass++; sections[curSection].pass++; }
  else { fail++; sections[curSection].fail++; fails.push(msg); console.log('  ✗ ' + msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// 1テスト = サーバ起動→処理→クローズ
async function withServer(fn) {
  const server = createServer();
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const raw = (p, text) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
  const get = (p) => fetch(base + p);
  // ヘッダ付き（RLSのx-tenant-id検証用）
  const postH = (p, body, headers) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const getH = (p, headers) => fetch(base + p, { headers });
  try { await fn({ post, get, raw, postH, getH }); } finally { await new Promise(r => server.close(r)); }
}

const HOT_BOXES = [
  { box_key: 'hero', active_view: 7, engagement: 97, revisits: 1 },
  { box_key: 'beforeafter', active_view: 3, engagement: 100, revisits: 2 },
  { box_key: 'pricing', active_view: 4, engagement: 100, revisits: 3 },
  { box_key: 'voice', active_view: 12, engagement: 71, revisits: 1 },
  { box_key: 'staff', active_view: 1, engagement: 6, revisits: 1 },
];

async function suite() {
  section('A. 元機能（計測/結合/タグ/法務/集計/堅牢性）');
  // 1) ハッピーパス：熱い閲覧→同意結合→journey に実名で出る＋タグ適用
  await withServer(async ({ post, get }) => {
    const c = await (await post('/api/attn/collect', { anon_id: 'A1', page_slug: 'seitai-lp-a', entry: { query: '肩こり 整体 世田谷', pos: 3, device: 'スマホ' }, active_sec: 42, boxes: HOT_BOXES })).json();
    ok(c.ok, 'collect ok');
    ok(c.fired.includes('整体LP-A 流入'), '流入タグ発火');
    ok(c.fired.includes('料金検討中'), '料金検討中 発火');
    ok(c.fired.includes('効果重視'), '効果重視 発火');
    ok(c.fired.includes('口コミ重視'), '口コミ重視 発火(voice=71)');

    const m = await (await post('/api/attn/merge', { anon_id: 'A1', friend_id: 'f_100', consented: true })).json();
    ok(m.ok && m.applied, 'merge 同意 適用');

    const j = await (await get('/api/attn/journey?friend_id=f_100')).json();
    eq(j.journeys.length, 1, 'journey 1件');
    eq(j.journeys[0].entry_query, '肩こり 整体 世田谷', 'journey 検索語');
    eq(j.journeys[0].box_engagement.pricing, 100, 'journey pricing=100');

    const t = await (await get('/api/attn/friend-tags?friend_id=f_100')).json();
    ok(t.tags.includes('整体LP-A 流入') && t.tags.includes('料金検討中') && t.tags.includes('効果重視'), 'friend_tags 適用済み');
  });

  // 1b) APPI31条（個人関連情報の第三者提供）：提供元Lokuの同意 確認・記録
  await withServer(async ({ post, get }) => {
    await post('/api/attn/collect', { anon_id: 'CR1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    // 由来つき同意 → 記録が"完全"
    const m = await (await post('/api/attn/merge', { anon_id: 'CR1', friend_id: 'f_CR', consented: true,
      consent_record: { obtained_by: '店舗LIFF同意画面', method: 'liff_optin' } })).json();
    ok(m.consent_record_complete, '由来つき同意は記録完全');
    const cr = await (await get('/api/attn/consent-record?friend_id=f_CR')).json();
    ok(cr.all_complete && cr.records[0].record.method === 'liff_optin', '確認記録を引ける(誰が/方法/日時)');
    // 由来なし同意 → 結合はするが記録は"不完全"としてフラグ（記録義務の未充足を可視化）
    await post('/api/attn/collect', { anon_id: 'CR2', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    const m2 = await (await post('/api/attn/merge', { anon_id: 'CR2', friend_id: 'f_CR2', consented: true })).json();
    ok(!m2.consent_record_complete && m2.applied, '由来なしは適用されるが記録は不完全フラグ');
    eq((await (await get('/api/attn/consent-record?friend_id=f_CR2')).json()).all_complete, false, '不完全な記録はall_complete=false');
  });

  // 1c) 越境移転（APPI28条）：委託先レジストリ＋越境判定・リージョンは運用者が登録
  await withServer(async ({ post, get }) => {
    // 初期はリージョン未設定＝判定不可(要確認)で通知が必要
    const a0 = await (await get('/api/attn/subprocessors')).json();
    ok(a0.needs_notice && a0.unknown.length >= 1, '初期は保管国未設定＝要確認で通知必要');
    // 国内(JP)を登録すると越境ではない
    await post('/api/attn/subprocessors', { id: 'google_sc', region: 'JP' });
    await post('/api/attn/subprocessors', { id: 'line', region: 'JP' });
    const sp = await (await post('/api/attn/subprocessors', { id: 'supabase', region: 'US' })).json();
    ok(sp.assessment.cross_border.some(x => x.id === 'supabase'), 'US保管は越境として検出(28条の情報提供が必要)');
    const a1 = await (await get('/api/attn/subprocessors')).json();
    ok(a1.needs_notice && a1.unknown.length === 0, '全て登録済でも越境が1つあれば通知必要');
    // 全てJPなら通知不要
    await post('/api/attn/subprocessors', { id: 'supabase', region: 'JP' });
    eq((await (await get('/api/attn/subprocessors')).json()).needs_notice, false, '全て国内なら通知不要');
    // バリデーション
    eq((await post('/api/attn/subprocessors', { id: 'nope', region: 'JP' })).status, 404, '未知の委託先→404');
    eq((await post('/api/attn/subprocessors', { id: 'supabase' })).status, 400, 'region欠落→400');
  });

  // 1d) プロファイリングの透明性と拒否権：付与根拠の開示＋停止（既存タグ撤回＋再付与しない）
  await withServer(async ({ post, get }) => {
    // 透明化：どのタグを何を根拠に付けるか開示
    const info = await (await get('/api/attn/profiling-info?page_slug=seitai-lp-a')).json();
    ok(info.profiles.length > 0 && info.profiles.every(p => p.tag && p.basis), 'タグと付与根拠を開示');
    // タグが付いた状態を作る
    await post('/api/attn/collect', { anon_id: 'PR1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'PR1', friend_id: 'f_PR', consented: true });
    ok((await (await get('/api/attn/friend-tags?friend_id=f_PR')).json()).tags.length > 0, '停止前はタグあり');
    // 拒否：既存タグ撤回
    ok((await (await post('/api/attn/profiling-opt-out', { friend_id: 'f_PR' })).json()).ok, 'プロファイリング拒否OK');
    eq((await (await get('/api/attn/friend-tags?friend_id=f_PR')).json()).tags.length, 0, '拒否で既存タグ撤回');
    // 拒否後は後追いcollectでも再付与されない
    await post('/api/attn/collect', { anon_id: 'PR1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    eq((await (await get('/api/attn/friend-tags?friend_id=f_PR')).json()).tags.length, 0, '拒否後は再付与されない');
    eq((await post('/api/attn/profiling-opt-out', {})).status, 400, 'friend_id欠落→400');
  });

  // 1e) 未成年の同意：未成年は本人＋保護者同意が揃って初めて記録完全
  await withServer(async ({ post, get }) => {
    // 未成年＋保護者同意あり → 完全
    await post('/api/attn/collect', { anon_id: 'MN1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    const ok1 = await (await post('/api/attn/merge', { anon_id: 'MN1', friend_id: 'f_MN1', consented: true,
      consent_record: { obtained_by: '店舗対面', method: 'paper', is_minor: true, guardian_consent: true } })).json();
    ok(ok1.consent_record_complete, '未成年＋保護者同意ありは記録完全');
    // 未成年＋保護者同意なし → 結合はするが不完全
    await post('/api/attn/collect', { anon_id: 'MN2', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    const ng = await (await post('/api/attn/merge', { anon_id: 'MN2', friend_id: 'f_MN2', consented: true,
      consent_record: { obtained_by: '店舗対面', method: 'paper', is_minor: true } })).json();
    ok(!ng.consent_record_complete && ng.applied, '未成年で保護者同意なしは不完全フラグ(結合自体はする)');
    const cr = await (await get('/api/attn/consent-record?friend_id=f_MN2')).json();
    ok(cr.records[0].record.is_minor === true && cr.records[0].record.guardian_consent === false, '未成年フラグ・保護者同意欠落が証跡に残る');
    // 成人（is_minor未指定）は従来どおり obtained_by+method だけで完全
    await post('/api/attn/collect', { anon_id: 'MN3', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    ok((await (await post('/api/attn/merge', { anon_id: 'MN3', friend_id: 'f_MN3', consented: true,
      consent_record: { obtained_by: 'LIFF', method: 'liff_optin' } })).json()).consent_record_complete, '成人は従来どおり完全');
  });

  // 1f) 開示・削除請求への本人確認：本人起点の請求は identity_verified 必須（なりすまし防止）
  await withServer(async ({ post, get }) => {
    await post('/api/attn/collect', { anon_id: 'IV1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'IV1', friend_id: 'f_IV', consented: true });
    // 本人起点＋本人確認なし → 403（削除も開示も）
    eq((await post('/api/attn/forget', { friend_id: 'f_IV', subject_request: true })).status, 403, '本人起点の削除で本人確認なし→403');
    eq((await post('/api/attn/export', { friend_id: 'f_IV', actor: 'self', subject_request: true })).status, 403, '本人起点の開示で本人確認なし→403');
    // データはまだ消えていない
    ok((await (await get('/api/attn/journey?friend_id=f_IV')).json()).journeys.length > 0, '本人確認前は削除されていない');
    // 本人確認あり → 実行できる
    const ex = await (await post('/api/attn/export', { friend_id: 'f_IV', actor: 'self', subject_request: true, identity_verified: true })).json();
    ok(ex.ok, '本人確認ありの開示は実行');
    const log = await (await get('/api/attn/audit-log?friend_id=f_IV')).json();
    ok(log.entries.some(e => e.action === 'export' && e.subject_request && e.identity_verified), '本人確認の有無が証跡に残る');
    ok((await (await post('/api/attn/forget', { friend_id: 'f_IV', subject_request: true, identity_verified: true })).json()).ok, '本人確認ありの削除は実行');
    // 社内運用（subject_request無し）は従来どおり本人確認不要
    await post('/api/attn/collect', { anon_id: 'IV2', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'IV2', friend_id: 'f_IV2', consented: true });
    ok((await (await post('/api/attn/export', { friend_id: 'f_IV2', actor: 'staff_a' })).json()).ok, '社内運用は従来どおり本人確認不要');
  });

  // 1g) 利用目的の変更→再同意（目的外利用の防止）：目的バージョンを上げると旧同意は再同意待ち・タグ付与停止
  await withServer(async ({ post, get }) => {
    await post('/api/attn/collect', { anon_id: 'PV1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'PV1', friend_id: 'f_PV', consented: true });
    ok((await (await get('/api/attn/friend-tags?friend_id=f_PV')).json()).tags.length > 0, '目的変更前はタグあり');
    eq((await (await get('/api/attn/reconsent-status?friend_id=f_PV')).json()).needs_reconsent, false, '変更前は再同意不要');
    // 目的バージョンを上げる（目的の拡大）
    ok((await (await post('/api/attn/purpose-version', { version: 2, purpose: '広告配信にも利用' })).json()).ok, '目的バージョンを2へ');
    eq((await (await get('/api/attn/reconsent-status?friend_id=f_PV')).json()).needs_reconsent, true, '旧同意は再同意待ちになる');
    // 再同意待ちの間は後追いcollectでもタグが増えない
    await post('/api/attn/collect', { anon_id: 'PV1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    // 再同意（新バージョンでmerge）すると再同意待ち解消
    await post('/api/attn/merge', { anon_id: 'PV1', friend_id: 'f_PV', consented: true });
    eq((await (await get('/api/attn/reconsent-status?friend_id=f_PV')).json()).needs_reconsent, false, '再同意で解消');
    // バリデーション：現行以下のバージョンは拒否
    eq((await post('/api/attn/purpose-version', { version: 2 })).status, 400, '現行以下のバージョンは拒否');
  });

  // 1h) 漏えい時の報告・本人通知（APPI26条）：インシデント記録＋要否判定
  await withServer(async ({ post, get }) => {
    // 要配慮を含む漏えいは1件でも報告・本人通知の対象
    const s = await (await post('/api/attn/incident', { summary: '症状メモの誤送信', affected: 1, includes_sensitive: true })).json();
    ok(s.incident.assessment.must_report && s.incident.assessment.must_notify_subjects, '要配慮1件でも報告＋本人通知');
    ok(s.incident.assessment.reasons.includes('要配慮個人情報を含む'), '理由に要配慮が入る');
    // 通常データ500件は報告対象外／1001件は対象
    ok(!(await (await post('/api/attn/incident', { summary: '軽微', affected: 500 })).json()).incident.assessment.must_report, '通常500件は報告対象外');
    ok((await (await post('/api/attn/incident', { summary: '大規模', affected: 1001 })).json()).incident.assessment.must_report, '1000人超は報告対象');
    // 不正アクセスは件数不問で対象＋期限が出る
    const ua = await (await post('/api/attn/incident', { summary: '不正アクセス', affected: 3, unauthorized_access: true })).json();
    ok(ua.incident.assessment.must_report && ua.incident.assessment.deadlines, '不正アクセスは対象＋報告期限を提示');
    // 台帳に残り、報告義務ありの件数が数えられる
    const list = await (await get('/api/attn/incidents')).json();
    ok(list.incidents.length === 4 && list.open_report_obligations === 3, '台帳に記録・報告義務3件を集計');
    eq((await post('/api/attn/incident', {})).status, 400, 'summary欠落→400');
  });

  // 1i) 外部送信通知のタイミング保証：ポリシーON時は通知提示前の計測を拒否
  await withServer(async ({ post, get }) => {
    // 既定OFF：通知フラグ無しでも従来どおり計測できる（非破壊）
    eq((await (await get('/api/attn/notice-policy')).json()).require_notice, false, '既定は通知必須OFF');
    ok((await (await post('/api/attn/collect', { anon_id: 'NT0', page_slug: 'seitai-lp-a', boxes: HOT_BOXES })).json()).ok, 'OFF時は通知なしでも計測OK');
    // ポリシーON
    ok((await (await post('/api/attn/notice-policy', { require: true })).json()).ok, '通知必須ポリシーON');
    eq((await post('/api/attn/collect', { anon_id: 'NT1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES })).status, 403, 'ON時は通知未提示の計測を拒否(403)');
    ok((await (await post('/api/attn/collect', { anon_id: 'NT2', page_slug: 'seitai-lp-a', notice_shown: true, boxes: HOT_BOXES })).json()).ok, 'notice_shown:trueなら計測OK');
    eq((await post('/api/attn/notice-policy', { require: 'yes' })).status, 400, 'requireは真偽値必須→400');
  });

  // 1j) 保有個人データに関する事項の公表：利用目的・種類・委託先・請求手続きを本人が知り得る状態に
  await withServer(async ({ post, get }) => {
    const pn = await (await get('/api/attn/public-notice?page_slug=seitai-lp-a')).json();
    ok(pn.purposes.length > 0 && pn.retained_data_kinds.length > 0, '利用目的と保有データの種類を公表');
    ok(pn.subject_rights.disclosure && pn.subject_rights.deletion && pn.subject_rights.stop_profiling, '開示・削除・プロファイリング停止の請求手続きを明示');
    ok('transfer' in pn && 'purpose_version' in pn, '委託先/越境の状況と利用目的バージョンを含む');
    eq(pn.subject_rights.contact, null, '苦情窓口は空欄（運用者が補う・代筆しない）');
    // 店舗がポリシーURLを設定すると公表に反映
    await post('/api/attn/privacy-policy', { page_slug: 'seitai-lp-a', url: 'https://example.com/privacy' });
    eq((await (await get('/api/attn/public-notice?page_slug=seitai-lp-a')).json()).privacy_policy_url, 'https://example.com/privacy', '設定したポリシーURLが公表に載る');
    eq((await get('/api/attn/public-notice?page_slug=nope')).status, 404, '未知ページ→404');
  });

  // 2) 同意なし：journey に出ない・タグ適用されない（プライバシーゲート）
  await withServer(async ({ post, get }) => {
    await post('/api/attn/collect', { anon_id: 'A2', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    const m = await (await post('/api/attn/merge', { anon_id: 'A2', friend_id: 'f_200', consented: false })).json();
    ok(!m.applied, 'merge 非同意 未適用');
    const j = await (await get('/api/attn/journey?friend_id=f_200')).json();
    eq(j.journeys.length, 0, '非同意は journey に出ない');
    const t = await (await get('/api/attn/friend-tags?friend_id=f_200')).json();
    eq(t.tags.length, 0, '非同意はタグ適用なし');
  });

  // 3) 冪等性：collect2回・merge2回で重複しない
  await withServer(async ({ post, get }) => {
    await post('/api/attn/collect', { anon_id: 'A3', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/collect', { anon_id: 'A3', page_slug: 'seitai-lp-a', boxes: HOT_BOXES }); // 再送
    await post('/api/attn/merge', { anon_id: 'A3', friend_id: 'f_300', consented: true });
    await post('/api/attn/merge', { anon_id: 'A3', friend_id: 'f_300', consented: true }); // 再送
    const j = await (await get('/api/attn/journey?friend_id=f_300')).json();
    eq(j.journeys.length, 1, '再送してもjourney 1件（重複なし）');
    const t = await (await get('/api/attn/friend-tags?friend_id=f_300')).json();
    // Set なので重複しない：整体LP-A流入/料金検討中/効果重視/口コミ重視(+ホットリードは平均次第)
    ok(new Set(t.tags).size === t.tags.length, 'タグ重複なし');
  });

  // 4) 流入タグは到達（薄い閲覧）でも即発火
  await withServer(async ({ post }) => {
    const c = await (await post('/api/attn/collect', { anon_id: 'A4', page_slug: 'seitai-lp-a', boxes: [{ box_key: 'hero', active_view: 0.5, engagement: 7 }] })).json();
    ok(c.fired.includes('整体LP-A 流入'), '薄い閲覧でも流入タグ');
    ok(!c.fired.includes('料金検討中'), '薄い閲覧で温度感タグは出ない');
  });

  // 5) 閾値境界：engagement=60 で発火、59 で不発
  await withServer(async ({ post }) => {
    const c60 = await (await post('/api/attn/collect', { anon_id: 'A5a', page_slug: 'seitai-lp-a', boxes: [{ box_key: 'pricing', engagement: 60 }] })).json();
    ok(c60.fired.includes('料金検討中'), '60ちょうどで発火');
    const c59 = await (await post('/api/attn/collect', { anon_id: 'A5b', page_slug: 'seitai-lp-a', boxes: [{ box_key: 'pricing', engagement: 59 }] })).json();
    ok(!c59.fired.includes('料金検討中'), '59では不発');
  });

  // 6) 集約タグ：全ボックス高でホットリード発火
  await withServer(async ({ post }) => {
    const all = ['hero','problem','beforeafter','staff','pricing','voice','faq','cta'].map(k => ({ box_key: k, engagement: 90 }));
    const c = await (await post('/api/attn/collect', { anon_id: 'A6', page_slug: 'seitai-lp-a', boxes: all })).json();
    ok(c.fired.includes('ホットリード'), '全体高でホットリード');
  });

  // 7) 友だち隔離：別friendのjourneyは混ざらない
  await withServer(async ({ post, get }) => {
    await post('/api/attn/collect', { anon_id: 'B1', page_slug: 'seitai-lp-a', boxes: [{ box_key:'pricing', engagement:100 }] });
    await post('/api/attn/collect', { anon_id: 'B2', page_slug: 'seitai-lp-a', boxes: [{ box_key:'voice', engagement:100 }] });
    await post('/api/attn/merge', { anon_id: 'B1', friend_id: 'f_A', consented: true });
    await post('/api/attn/merge', { anon_id: 'B2', friend_id: 'f_B', consented: true });
    const jA = await (await get('/api/attn/journey?friend_id=f_A')).json();
    const jB = await (await get('/api/attn/journey?friend_id=f_B')).json();
    eq(jA.journeys.length, 1, 'f_A 1件');
    eq(jB.journeys.length, 1, 'f_B 1件');
    eq(jA.journeys[0].box_engagement.pricing, 100, 'f_A は pricing');
    eq(jB.journeys[0].box_engagement.voice, 100, 'f_B は voice');
  });

  // 8) 後追いcollect：結合後にさらに読んだら friend_tags が増える
  await withServer(async ({ post, get }) => {
    await post('/api/attn/collect', { anon_id: 'C1', page_slug: 'seitai-lp-a', boxes: [{ box_key:'hero', engagement:20 }] });
    await post('/api/attn/merge', { anon_id: 'C1', friend_id: 'f_C', consented: true });
    let t = await (await get('/api/attn/friend-tags?friend_id=f_C')).json();
    ok(!t.tags.includes('料金検討中'), '結合時点では料金タグなし');
    await post('/api/attn/collect', { anon_id: 'C1', page_slug: 'seitai-lp-a', boxes: [{ box_key:'pricing', engagement:80 }] }); // 後で料金熟読
    t = await (await get('/api/attn/friend-tags?friend_id=f_C')).json();
    ok(t.tags.includes('料金検討中'), '後追いで料金検討中が付く');
  });

  // 9) バリデーション：不正入力は 400/404、壊れたJSONも 400
  await withServer(async ({ post, get, raw }) => {
    const r1 = await post('/api/attn/collect', { page_slug: 'seitai-lp-a' }); eq(r1.status, 400, 'anon_id欠落→400');
    const r2 = await post('/api/attn/collect', { anon_id: 'X', page_slug: 'no-such' }); eq(r2.status, 404, '未知ページ→404');
    const r3 = await post('/api/attn/merge', { anon_id: 'X' }); eq(r3.status, 400, 'friend_id欠落→400');
    const r4 = await get('/api/attn/journey'); eq(r4.status, 400, 'friend_id欠落→400');
    const r5 = await raw('/api/attn/collect', '{ this is not json'); eq(r5.status, 400, '壊れたJSON→400');
    const r6 = await get('/api/attn/nope'); eq(r6.status, 404, '未知ルート→404');
  });

  // 10) コンプラ：NGワードチェッカー（業種で厳格度が変わる）
  await withServer(async ({ post }) => {
    const bad = await (await post('/api/attn/check-copy', { text: '肩こりが必ず治る！地域No.1', industry: 'rikaku' })).json();
    ok(bad.blocked, 'NG: 「治る/必ず/No.1」で公開ブロック');
    ok(bad.violations.some(v => v.category === '薬機法') && bad.violations.some(v => v.category === '景表法'), '薬機・景表を検出');
    const clean = await (await post('/api/attn/check-copy', { text: '駅前の整体院。初回¥5,500・完全予約制', industry: 'rikaku' })).json();
    ok(clean.ok && !clean.blocked, 'クリーンなコピーは通過');
    // 業種格上げ：体験談は整体(rikaku)ではmedium、接骨院(judo)ではhigh=ブロック
    const taikenR = await (await post('/api/attn/check-copy', { text: 'お客様の声を多数掲載', industry: 'rikaku' })).json();
    const taikenJ = await (await post('/api/attn/check-copy', { text: 'お客様の声を多数掲載', industry: 'judo' })).json();
    ok(!taikenR.blocked && taikenJ.blocked, '体験談: 整体は要承認/接骨院はブロック（業種で厳格度が変わる）');
    const r = await post('/api/attn/check-copy', {}); eq(r.status, 400, 'text欠落→400');
    // 正規化バイパス対策：全角・文字間スペース・ひらがな開きでも回避できない
    ok((await (await post('/api/attn/check-copy', { text: 'Ｎｏ．１の実績', industry: 'rikaku' })).json()).blocked, '全角「Ｎｏ．１」もブロック');
    ok((await (await post('/api/attn/check-copy', { text: 'ＮＯ１', industry: 'rikaku' })).json()).blocked, '区切りなし全角「ＮＯ１」もブロック');
    ok((await (await post('/api/attn/check-copy', { text: '１００％効く', industry: 'rikaku' })).json()).blocked, '全角「１００％」もブロック');
    ok((await (await post('/api/attn/check-copy', { text: '絶　対', industry: 'rikaku' })).json()).blocked, '文字間スペース「絶　対」もブロック');
    ok((await (await post('/api/attn/check-copy', { text: 'ぜっ たい に な お る', industry: 'rikaku' })).json()).blocked, 'ひらがな開き＋スペース「ぜったい/なおる」もブロック');
    // 英語・ローマ字での効能/最上級
    ok((await (await post('/api/attn/check-copy', { text: 'Guaranteed to cure your pain', industry: 'rikaku' })).json()).blocked, '英語「guaranteed/cure」もブロック');
    ok((await (await post('/api/attn/check-copy', { text: 'We are the BEST, Number One', industry: 'rikaku' })).json()).blocked, '英語「the best/number one」もブロック');
    // カタカナ開き
    ok((await (await post('/api/attn/check-copy', { text: 'ゼッタイに良くなる', industry: 'rikaku' })).json()).blocked, 'カタカナ「ゼッタイ」もブロック');
    ok((await (await post('/api/attn/check-copy', { text: 'カンチします', industry: 'rikaku' })).json()).blocked, 'カタカナ「カンチ(完治)」もブロック');
    // 誤検知防止：正常な日本語コピーは通過
    ok((await (await post('/api/attn/check-copy', { text: '丁寧なカウンセリングと予約制', industry: 'judo' })).json()).ok, '正常コピーはクリーン(英語辞書追加の副作用なし)');
    // 要配慮ガード stripSensitive：大文字キー・ネスト・配列内も剥がす
    {
      const r = stripSensitive({ box: 'a', Symptom: '腰痛', profile: { diagnosis: 'ヘルニア', name: '田中' }, items: [{ condition: 'x', box: 'b' }] });
      ok(r.stripped.includes('Symptom'), '大文字「Symptom」も剥がす');
      ok(r.stripped.includes('profile.diagnosis'), 'ネスト「profile.diagnosis」も剥がす');
      ok(r.stripped.includes('items[0].condition'), '配列内「condition」も剥がす');
      ok(r.clean.profile.name === '田中' && r.clean.items[0].box === 'b', '非該当フィールドは保持する');
    }
  });

  // 11) 要配慮個人情報ガード：症状フィールドは結合させず剥がす
  await withServer(async ({ post, get }) => {
    const c = await (await post('/api/attn/collect', { anon_id: 'S1', page_slug: 'seitai-lp-a', symptom: '慢性腰痛', diagnosis: '椎間板ヘルニア', boxes: HOT_BOXES })).json();
    ok(Array.isArray(c.stripped) && c.stripped.includes('symptom') && c.stripped.includes('diagnosis'), '症状/診断フィールドを剥がした');
    await post('/api/attn/merge', { anon_id: 'S1', friend_id: 'f_S', consented: true });
    const j = await (await get('/api/attn/journey?friend_id=f_S')).json();
    ok(!JSON.stringify(j).includes('腰痛') && !JSON.stringify(j).includes('ヘルニア'), '要配慮情報はjourneyに一切残らない');
  });

  // 12) 忘れられる権利/オプトアウト：friend単位で計測データを削除
  await withServer(async ({ post, get }) => {
    await post('/api/attn/collect', { anon_id: 'D1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'D1', friend_id: 'f_D', consented: true });
    let t = await (await get('/api/attn/friend-tags?friend_id=f_D')).json();
    ok(t.tags.length > 0, '削除前はタグあり');
    const del = await (await post('/api/attn/forget', { friend_id: 'f_D' })).json();
    ok(del.ok && del.forgotten.includes('D1'), 'forget 実行');
    const j = await (await get('/api/attn/journey?friend_id=f_D')).json();
    eq(j.journeys.length, 0, '削除後は journey 空');
    t = await (await get('/api/attn/friend-tags?friend_id=f_D')).json();
    eq(t.tags.length, 0, '削除後はタグも撤回');
    const r = await post('/api/attn/forget', {}); eq(r.status, 400, 'anon/friend欠落→400');
  });

  // 12b) 保持期間purge：保存期間を過ぎた計測データを消去（now注入で古さを再現）
  await withServer(async ({ post, get }) => {
    const DAY = 86400000, now = Date.now();
    await post('/api/attn/collect', { anon_id: 'P_old', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/collect', { anon_id: 'P_new', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    // now を 800日先に進めて実行 → P_old(=約800日前)は消え、直前collectのP_newは… 両方古くなるので個別に確認
    // まず未来800日: 両方expire
    let pg = await (await post('/api/attn/purge', { retention_days: 730, now: now + 800 * DAY })).json();
    ok(pg.ok && pg.purgedAnons.includes('P_old') && pg.purgedAnons.includes('P_new'), '保持超過の全セッションをpurge');
    // 再投入して現在時刻でpurge → 新しいので残る
    await post('/api/attn/collect', { anon_id: 'P_fresh', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    pg = await (await post('/api/attn/purge', { retention_days: 730 })).json();
    ok(!pg.purgedAnons.includes('P_fresh'), '保持期間内の新しいデータは残す');
    // purge後は journey も空（結合済みでも生データ消去で復活しない）
    await post('/api/attn/collect', { anon_id: 'P_j', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'P_j', friend_id: 'f_Pj', consented: true });
    await post('/api/attn/purge', { retention_days: 0, now: now + DAY });
    const j = await (await get('/api/attn/journey?friend_id=f_Pj')).json();
    eq(j.journeys.length, 0, 'purge後は journey 空');
    // バリデーション
    eq((await post('/api/attn/purge', { retention_days: -1 })).status, 400, '負のretention_days→400');
    eq((await post('/api/attn/purge', { retention_days: 'x' })).status, 400, '非数値retention_days→400');
  });

  // 12c) 外部送信規律の通知（改正電通法）：何を・どこへ・何のため を開示
  await withServer(async ({ post, get }) => {
    const disc = await (await get('/api/attn/disclosure?page_slug=seitai-lp-a')).json();
    ok(disc.items.length > 0 && disc.purposes.length > 0, '送信情報と利用目的を明示');
    eq(disc.destination.is_third_party, false, '送信先はLoku(1st-party)・第三者提供なし');
    eq(disc.sensitive_excluded, true, '要配慮(症状/診断)は送信対象外を明示');
    eq(disc.privacy_policy_url, null, 'ポリシーURL未設定は空欄（代筆しない）');
    eq((await get('/api/attn/disclosure?page_slug=nope')).status, 404, '未知ページ→404');
    // 店舗がポリシーURLを登録すると通知に反映
    ok((await (await post('/api/attn/privacy-policy', { page_slug: 'seitai-lp-a', url: 'https://example.com/privacy' })).json()).ok, 'ポリシーURL登録OK');
    eq((await (await get('/api/attn/disclosure?page_slug=seitai-lp-a')).json()).privacy_policy_url, 'https://example.com/privacy', '登録後は通知にURLが載る');
    eq((await post('/api/attn/privacy-policy', { page_slug: 'seitai-lp-a', url: 'javascript:alert(1)' })).status, 400, 'http(s)以外のURLは拒否');
    eq((await post('/api/attn/privacy-policy', { url: 'https://x' })).status, 400, 'page_slug欠落→400');
  });

  // 12d) CSVエクスポートの安全管理：持ち出しログ・数式インジェクション対策・任意AES暗号化
  // csvCell 数式インジェクション（=,+,-,@ 始まりを無害化・区切り文字はクォート）
  eq(csvCell('=SUM(A1)'), "'=SUM(A1)", 'CSV数式(=)を無害化');
  eq(csvCell('+1234'), "'+1234", 'CSV数式(+)を無害化');
  eq(csvCell('a,b"c'), '"a,b""c"', 'カンマ/クォートはRFC4180でエスケープ');
  // 暗号化ラウンドトリップ（AES-256-GCM）
  {
    const enc = encryptCsv('h\r\nv', 'pw');
    eq(enc.alg, 'aes-256-gcm', 'AES-256-GCMで暗号化');
    const key = crypto.scryptSync('pw', Buffer.from(enc.salt, 'base64'), 32);
    const dec = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
    dec.setAuthTag(Buffer.from(enc.tag, 'base64'));
    const pt = Buffer.concat([dec.update(Buffer.from(enc.ciphertext, 'base64')), dec.final()]).toString('utf8');
    eq(pt, 'h\r\nv', '正パスフレーズで復号一致');
  }
  await withServer(async ({ post, get }) => {
    await post('/api/attn/collect', { anon_id: 'X1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'X1', friend_id: 'f_X', consented: true });
    // actor必須（持ち出しログ）
    eq((await post('/api/attn/export', { friend_id: 'f_X' })).status, 400, 'actor欠落→400(誰が持ち出したか必須)');
    eq((await post('/api/attn/export', { actor: 'staff_a' })).status, 400, 'friend_id欠落→400');
    // 平文CSV＋持ち出しログ
    const ex = await (await post('/api/attn/export', { friend_id: 'f_X', actor: 'staff_a' })).json();
    ok(ex.ok && !ex.encrypted && ex.csv.includes('friend_id'), '平文CSVを返す');
    const log = await (await get('/api/attn/audit-log')).json();
    ok(log.entries.some(e => e.action === 'export' && e.actor === 'staff_a'), '持ち出しログにactorが残る');
    // 暗号化エクスポート
    const enc2 = await (await post('/api/attn/export', { friend_id: 'f_X', actor: 'staff_a', passphrase: 's3cret' })).json();
    ok(enc2.encrypted && enc2.payload.alg === 'aes-256-gcm' && !enc2.csv, 'passphrase指定で暗号化・平文は返さない');
  });

  // 12e) Google連携のスコープ最小化：Search Consoleは readonly 限定（書き込みスコープを拒否）
  ok(REQUIRED_SCOPE.endsWith('/webmasters.readonly'), '必要スコープはwebmasters.readonly');
  ok(assertReadonlyScope(REQUIRED_SCOPE), 'readonlyスコープは通過');
  ok(assertReadonlyScope([REQUIRED_SCOPE]), '配列でのreadonly指定も通過');
  const rejects = (fn) => { try { fn(); return false; } catch { return true; } };
  ok(rejects(() => assertReadonlyScope([REQUIRED_SCOPE, 'https://www.googleapis.com/auth/webmasters'])), '書き込み可能scope混入を拒否');
  ok(rejects(() => assertReadonlyScope('https://www.googleapis.com/auth/siteverification')), 'サイト認証scopeを拒否');
  ok(rejects(() => assertReadonlyScope('')), 'scope未指定を拒否');
  {
    const rows = await fetchSearchConsole({ siteUrl: 's', startDate: 'a', endDate: 'b', fetcher: () => [{ keys: ['k'], clicks: 1, impressions: 10 }] });
    eq(rows.length, 1, 'readonly既定でfetch成功');
    let threw = false;
    try { await fetchSearchConsole({ siteUrl: 's', fetcher: () => [], scopes: 'https://www.googleapis.com/auth/webmasters' }); } catch { threw = true; }
    ok(threw, 'fetch時に書き込みscopeを拒否');
  }

  // 12f) RLSテナント分離（アプリ層ミラー）：x-tenant-idで自テナントのみ・他テナントは403
  await withServer(async ({ post, get, getH, postH }) => {
    // t_1のLP-Aに来た人をf_T1に結合、t_2のLP-Bに来た人をf_T2に結合
    await post('/api/attn/collect', { anon_id: 'T1a', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'T1a', friend_id: 'f_T1', consented: true });
    await post('/api/attn/collect', { anon_id: 'T2a', page_slug: 'seitai-lp-b', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'T2a', friend_id: 'f_T2', consented: true });
    // 管理ビュー（ヘッダなし）は従来どおり見える（非破壊）
    eq((await get('/api/attn/journey?friend_id=f_T1')).status, 200, 'ヘッダなしは従来どおり200');
    // 自テナントは可
    eq((await getH('/api/attn/journey?friend_id=f_T1', { 'x-tenant-id': 't_1' })).status, 200, '自テナントのjourneyは200');
    eq((await getH('/api/attn/friend-tags?friend_id=f_T1', { 'x-tenant-id': 't_1' })).status, 200, '自テナントのtagsは200');
    // 他テナントは403（RLS相当）
    eq((await getH('/api/attn/journey?friend_id=f_T1', { 'x-tenant-id': 't_2' })).status, 403, '他テナントのjourneyは403');
    eq((await getH('/api/attn/friend-tags?friend_id=f_T1', { 'x-tenant-id': 't_2' })).status, 403, '他テナントのtagsは403');
    // export（持ち出し）も他テナントは403
    eq((await postH('/api/attn/export', { friend_id: 'f_T1', actor: 'staff_x' }, { 'x-tenant-id': 't_2' })).status, 403, '他テナントのexportは403');
    eq((await postH('/api/attn/export', { friend_id: 'f_T1', actor: 'staff_x' }, { 'x-tenant-id': 't_1' })).status, 200, '自テナントのexportは200');
    // disclosure（ページ単位）も他テナントは403
    eq((await getH('/api/attn/disclosure?page_slug=seitai-lp-a', { 'x-tenant-id': 't_2' })).status, 403, '他テナントページのdisclosureは403');
    eq((await getH('/api/attn/disclosure?page_slug=seitai-lp-a', { 'x-tenant-id': 't_1' })).status, 200, '自テナントページのdisclosureは200');
  });

  // 13) サチコ連携：APIで引っ張った行を取り込み、来る前をjourneyに搭載
  await withServer(async ({ post, get }) => {
    const rows = [
      { keys: ['肩こり 整体 世田谷'], impressions: 1200, clicks: 74, position: 3.1 },
      { keys: ['整体 産後 骨盤'], impressions: 800, clicks: 33, position: 5.4 },
      { keys: ['デスクワーク 肩こり'], impressions: 500, clicks: 39, position: 2.2 },
    ];
    const ing = await (await post('/api/attn/search-console/ingest', { page_slug: 'seitai-lp-a', date: '2026-07-07', rows })).json();
    eq(ing.ingested, 3, 'サチコ3行を取り込み');
    const sum = await (await get('/api/attn/search-summary?page_slug=seitai-lp-a')).json();
    eq(sum.search.impressions, 2500, '表示回数の合計を集計');
    eq(sum.search.clicks, 146, 'クリック合計を集計');
    ok(sum.search.top[0].query === '肩こり 整体 世田谷', 'クリック上位クエリを抽出');
    // 冪等：同じ行を再取り込みしても重複しない
    await post('/api/attn/search-console/ingest', { page_slug: 'seitai-lp-a', date: '2026-07-07', rows });
    const sum2 = await (await get('/api/attn/search-summary?page_slug=seitai-lp-a')).json();
    eq(sum2.search.impressions, 2500, '再取込でも重複せず合計不変');
    // journey に「来る前」が載る
    await post('/api/attn/collect', { anon_id: 'SC1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'SC1', friend_id: 'f_SC', consented: true });
    const j = await (await get('/api/attn/journey?friend_id=f_SC')).json();
    ok(j.journeys[0].search && j.journeys[0].search.clicks === 146, 'journeyに検索サマリ（来る前）が合成される');
    const r = await post('/api/attn/search-console/ingest', { page_slug: 'seitai-lp-a' }); eq(r.status, 400, 'rows欠落→400');
  });

  // 14) 自己改善サイクル：自分の画面(オンボ)のステップ別残存率を実データで集計
  await withServer(async ({ post, get }) => {
    for (let k = 0; k < 5; k++) await post('/api/attn/product-event', { surface: 'onboarding', step: 1 });
    for (let k = 0; k < 4; k++) await post('/api/attn/product-event', { surface: 'onboarding', step: 2 });
    for (let k = 0; k < 3; k++) await post('/api/attn/product-event', { surface: 'onboarding', step: 3 });
    const f = await (await get('/api/attn/product-funnel?surface=onboarding')).json();
    eq(f.funnel.length, 3, '3ステップ集計');
    eq(f.funnel[0].rate, 100, '先頭は100%');
    eq(f.funnel[1].rate, 80, 'step2 残存80%');
    eq(f.funnel[2].rate, 60, 'step3 残存60%（離脱が見える）');
    const r = await post('/api/attn/product-event', { surface: 'x' }); eq(r.status, 400, 'step欠落→400');
  });

  // 15) 実測CVR：タグ有/無の予約率を実データから集計（比較表の数字の裏付け）
  await withServer(async ({ post, get }) => {
    const thin = [{ box_key: 'hero', engagement: 10 }];
    // タグ有(料金検討中) 3人：A,B,C
    for (const [a, f] of [['A', 'f_A'], ['B', 'f_B'], ['C', 'f_C']]) {
      await post('/api/attn/collect', { anon_id: a, page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
      await post('/api/attn/merge', { anon_id: a, friend_id: f, consented: true });
    }
    // タグ無 2人：D,E
    for (const [a, f] of [['D', 'f_D'], ['E', 'f_E']]) {
      await post('/api/attn/collect', { anon_id: a, page_slug: 'seitai-lp-a', boxes: thin });
      await post('/api/attn/merge', { anon_id: a, friend_id: f, consented: true });
    }
    // 予約：A,B（タグ有2/3）、D（タグ無1/2）
    for (const f of ['f_A', 'f_B', 'f_D']) await post('/api/attn/booking', { friend_id: f });
    const conv = await (await get('/api/attn/conversion-by-tag?tag=' + encodeURIComponent('料金検討中'))).json();
    eq(conv.with.rate, 67, 'タグ有の予約率 2/3=67%');
    eq(conv.without.rate, 50, 'タグ無の予約率 1/2=50%');
    ok(conv.with.rate > conv.without.rate, 'タグ有 > タグ無（タグに意味がある）');
    const r = await post('/api/attn/booking', {}); eq(r.status, 400, 'friend_id欠落→400');
  });

  // 16) エッジケース：空・未知・二重でも壊れない（手戻り防止の要）
  await withServer(async ({ post, get }) => {
    const c0 = await (await get('/api/attn/conversion-by-tag?tag=' + encodeURIComponent('存在しないタグ'))).json();
    eq(c0.with.n, 0, '該当0人でもエラーなし');
    eq(c0.with.rate, 0, '0除算せず0%');
    const f0 = await (await get('/api/attn/product-funnel?surface=none')).json();
    eq(f0.funnel.length, 0, 'イベント無し→空ファネル');
    const s0 = await (await get('/api/attn/search-summary?page_slug=seitai-lp-a')).json();
    eq(s0.search, null, 'サチコ未取込→null（落ちない）');
    const j0 = await (await get('/api/attn/journey?friend_id=nobody')).json();
    eq(j0.journeys.length, 0, '未知friend→空');
    // 二重booking は冪等
    await post('/api/attn/collect', { anon_id: 'z', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'z', friend_id: 'f_z', consented: true });
    await post('/api/attn/booking', { friend_id: 'f_z' });
    await post('/api/attn/booking', { friend_id: 'f_z' });
    const cv = await (await get('/api/attn/conversion-by-tag?tag=' + encodeURIComponent('料金検討中'))).json();
    eq(cv.with.booked, 1, '二重bookingでも予約者1人（Set）');
    // forget後は再取得しても空のまま（復活しない）
    await post('/api/attn/forget', { friend_id: 'f_z' });
    const jz = await (await get('/api/attn/journey?friend_id=f_z')).json();
    eq(jz.journeys.length, 0, 'forget後は空のまま（復活しない）');
    const tz = await (await get('/api/attn/friend-tags?friend_id=f_z')).json();
    eq(tz.tags.length, 0, 'forget後はタグも空');
  });

  // 17) 型の頑健性：不正な型でも落とさず安全化
  await withServer(async ({ post, get }) => {
    let j = await (await post('/api/attn/collect', { anon_id: 't1', page_slug: 'seitai-lp-a', boxes: 'not-array' })).json();
    ok(j.ok && j.fired.includes('整体LP-A 流入'), 'boxes非配列でも落ちず流入タグ');
    await post('/api/attn/collect', { anon_id: 't2', page_slug: 'seitai-lp-a', boxes: [{ box_key: 'pricing', engagement: 'abc' }] });
    await post('/api/attn/collect', { anon_id: 't3', page_slug: 'seitai-lp-a', boxes: [{ box_key: 'pricing', engagement: 999 }] });
    await post('/api/attn/merge', { anon_id: 't2', friend_id: 'f_t2', consented: true });
    await post('/api/attn/merge', { anon_id: 't3', friend_id: 'f_t3', consented: true });
    eq((await (await get('/api/attn/journey?friend_id=f_t2')).json()).journeys[0].box_engagement.pricing, 0, '文字列engagementは0に安全化');
    eq((await (await get('/api/attn/journey?friend_id=f_t3')).json()).journeys[0].box_engagement.pricing, 100, '999はclamp 100');
    ok((await (await post('/api/attn/collect', { anon_id: 't4', page_slug: 'seitai-lp-a', boxes: [{ engagement: 80 }] })).json()).ok, 'box_key欠落boxは無視して継続');
    const r = await post('/api/attn/product-event', { surface: 'x', step: 'abc' }); eq(r.status, 400, 'step非数→400');
  });

  // 18) 並行リクエスト：同時でも一貫（競合で壊れない）
  await withServer(async ({ post, get }) => {
    await Promise.all([0, 1, 2, 3, 4].map(() => post('/api/attn/collect', { anon_id: 'p1', page_slug: 'seitai-lp-a', boxes: HOT_BOXES })));
    await Promise.all([0, 1, 2].map(() => post('/api/attn/merge', { anon_id: 'p1', friend_id: 'f_p1', consented: true })));
    const j = await (await get('/api/attn/journey?friend_id=f_p1')).json();
    eq(j.journeys.length, 1, '同時collect/mergeでも重複せず1件');
    eq(j.journeys[0].box_engagement.pricing, 100, '値も一貫');
  });

  // 19) 境界値：集約タグは平均55で発火・54で不発
  await withServer(async ({ post }) => {
    const mk = v => ['hero', 'problem', 'beforeafter', 'staff', 'pricing', 'voice', 'faq', 'cta'].map(k => ({ box_key: k, engagement: v }));
    ok((await (await post('/api/attn/collect', { anon_id: 'b55', page_slug: 'seitai-lp-a', boxes: mk(55) })).json()).fired.includes('ホットリード'), '平均55ちょうどでホットリード発火');
    ok(!(await (await post('/api/attn/collect', { anon_id: 'b54', page_slug: 'seitai-lp-a', boxes: mk(54) })).json()).fired.includes('ホットリード'), '平均54では不発');
  });

  // 20) 契約テスト：各APIのレスポンス形（本番Supabase移植後も同じ形を保証）
  await withServer(async ({ post, get }) => {
    const has = (o, keys, m) => ok(o && keys.every(k => k in o), m + ' 契約: {' + keys.join(',') + '}');
    has(await (await post('/api/attn/collect', { anon_id: 'k', page_slug: 'seitai-lp-a', boxes: HOT_BOXES })).json(), ['ok', 'fired', 'stripped'], 'collect');
    has(await (await post('/api/attn/merge', { anon_id: 'k', friend_id: 'f_k', consented: true })).json(), ['ok', 'friend_id', 'consented', 'applied'], 'merge');
    const j = await (await get('/api/attn/journey?friend_id=f_k')).json();
    has(j, ['friend_id', 'journeys'], 'journey');
    has(j.journeys[0], ['friend_id', 'page_slug', 'page_kind', 'entry_query', 'box_engagement', 'search'], 'journey.row');
    has(await (await post('/api/attn/check-copy', { text: '必ず治る', industry: 'judo' })).json(), ['ok', 'blocked', 'industry', 'violations'], 'check-copy');
    const cv = await (await get('/api/attn/conversion-by-tag?tag=x')).json();
    has(cv, ['tag', 'with', 'without'], 'conversion-by-tag');
    has(cv.with, ['n', 'booked', 'rate'], 'conversion.with');
    has(await (await get('/api/attn/product-funnel?surface=onboarding')).json(), ['surface', 'funnel'], 'product-funnel');
    has(await (await get('/api/attn/search-summary?page_slug=seitai-lp-a')).json(), ['page_slug', 'search'], 'search-summary');
  });

  // 21) 法務ハードニング：NG拡充・健康語の推知フラグ・配信オプトアウト
  await withServer(async ({ post, get }) => {
    // NG拡充：接骨院で「五十肩」等の適応症＋薬機表現をブロック
    ok((await (await post('/api/attn/check-copy', { text: '五十肩が改善します', industry: 'judo' })).json()).blocked, '接骨院で適応症「五十肩」＋改善をブロック');
    ok((await (await post('/api/attn/check-copy', { text: '根本改善で即効性', industry: 'rikaku' })).json()).blocked, '「根本改善/即効性」を薬機NGでブロック');
    // 症状名×効能想起の共起（推知）：症状名単独は可、共起で整体=要承認/接骨院=ブロック
    ok(!(await (await post('/api/attn/check-copy', { text: '肩こりでお悩みの方へ', industry: 'judo' })).json()).blocked, '症状名の単独言及はブロックしない');
    {
      const rk = await (await post('/api/attn/check-copy', { text: '肩こりがスッキリ軽くなります', industry: 'rikaku' })).json();
      const jd = await (await post('/api/attn/check-copy', { text: '肩こりがスッキリ軽くなります', industry: 'judo' })).json();
      ok(!rk.blocked && rk.violations.some(v => v.category === '要配慮の推知（適応症標榜）'), '整体は共起を要承認で検出（非ブロック）');
      ok(jd.blocked && jd.violations.some(v => v.category === '要配慮の推知（適応症標榜）'), '接骨院は症状×効能の共起をブロック（適応症標榜）');
    }
    // 健康語の推知フラグ
    await post('/api/attn/collect', { anon_id: 'h1', page_slug: 'seitai-lp-a', entry: { query: '肩こり 整体 世田谷' }, boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'h1', friend_id: 'f_h1', consented: true });
    eq((await (await get('/api/attn/journey?friend_id=f_h1')).json()).journeys[0].entry_health, true, '健康語を含む検索は推知フラグを立てる');
    await post('/api/attn/collect', { anon_id: 'h2', page_slug: 'seitai-lp-a', entry: { query: '駅前 整体 予約' }, boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'h2', friend_id: 'f_h2', consented: true });
    eq((await (await get('/api/attn/journey?friend_id=f_h2')).json()).journeys[0].entry_health, false, '健康語なしはフラグ立たず');
    // 配信オプトアウト
    await post('/api/attn/opt-out', { friend_id: 'f_h1' });
    eq((await (await get('/api/attn/can-send?friend_id=f_h1')).json()).can_send, false, '配信停止した人には送らない');
    eq((await (await get('/api/attn/can-send?friend_id=f_h2')).json()).can_send, true, '停止していない人は送れる');
    const r = await post('/api/attn/opt-out', {}); eq(r.status, 400, 'friend_id欠落→400');
  });

  // 22) 監査ログ：機微操作の証跡（安全管理措置・従業者の監督）
  await withServer(async ({ post, get }) => {
    await post('/api/attn/collect', { anon_id: 'a', page_slug: 'seitai-lp-a', boxes: HOT_BOXES });
    await post('/api/attn/merge', { anon_id: 'a', friend_id: 'f_a', consented: true });
    await post('/api/attn/opt-out', { friend_id: 'f_a' });
    await post('/api/attn/forget', { friend_id: 'f_a' });
    const log = await (await get('/api/attn/audit-log?friend_id=f_a')).json();
    const actions = log.entries.map(e => e.action);
    ok(actions.includes('merge') && actions.includes('opt-out') && actions.includes('forget'), '結合/配信停止/削除がすべて監査ログに残る');
    ok(log.entries.every(e => e.at && e.friend_id), '各証跡に時刻とfriend_id');
  });

  // ===== ③ 因果エンジン（roadmap P0–P3）=====
  section('B. ③新機能（因果エンジン P0–P3）');

  // 23) 純関数ユニット：deriveExit（離脱点）／inferCause（因果）
  eq(deriveExit({}).exit_type, 'no_data', 'P0 空はno_data');
  eq(deriveExit({ hero: 40 }).exit_type, 'bounce', 'P0 FVのみはbounce');
  eq(deriveExit({ hero: 50, pricing: 70 }).exit_box, 'pricing', 'P0 最深ボックスが離脱点');
  eq(deriveExit({ hero: 50, cta: 20 }).exit_type, 'form_abandon', 'P0 cta到達はform_abandon');
  eq(deriveExit({ hero: 50, cta: 20 }, { booked: true }).exit_type, 'converted', 'P0 予約はconverted優先');
  eq(inferCause({ box_engagement: { hero: 50, problem: 40, pricing: 70 } }).code, 'value_before_price', 'P1 価値提示前に料金離脱');
  eq(inferCause({ box_engagement: { hero: 50, beforeafter: 80, pricing: 70 } }).code, 'price_anxiety', 'P1 実績を見た後の料金離脱');
  eq(inferCause({ box_engagement: { hero: 50, pricing: 40, faq: 80 } }).code, 'unresolved_doubt', 'P1 FAQ熟読後に離脱');
  eq(inferCause({ box_engagement: { hero: 50, beforeafter: 70 } }).code, 'proof_gap', 'P1 信頼形成の途中で離脱');
  eq(inferCause({ box_engagement: { hero: 40 } }).code, 'weak_hook', 'P1 FVで直帰');
  eq(inferCause({ box_engagement: { hero: 50, cta: 30 }, booked: true }).code, 'converted', 'P1 予約済みはconverted');
  eq(inferCause({ box_engagement: { hero: 50, cta: 30 } }).code, 'cta_friction', 'P1 予約導線で離脱');
  ok(CAUSE_CODES.every(c => CAUSE_LABEL[c] && inferCause({ box_engagement: { hero: 10 } })), 'P1 全因果コードにラベル');

  // 24) 診断エンドポイント（P1+P2）：各因果を実データ経路で当てる
  await withServer(async ({ post, get }) => {
    const P = {
      converted:  [{ box_key: 'hero', engagement: 50 }, { box_key: 'pricing', engagement: 70 }, { box_key: 'cta', engagement: 40 }],
      cta:        [{ box_key: 'hero', engagement: 50 }, { box_key: 'pricing', engagement: 60 }, { box_key: 'cta', engagement: 30 }],
      faq:        [{ box_key: 'hero', engagement: 50 }, { box_key: 'pricing', engagement: 40 }, { box_key: 'faq', engagement: 80 }],
      valuebp:    [{ box_key: 'hero', engagement: 50 }, { box_key: 'problem', engagement: 40 }, { box_key: 'pricing', engagement: 70 }],
      priceanx:   [{ box_key: 'hero', engagement: 50 }, { box_key: 'beforeafter', engagement: 80 }, { box_key: 'pricing', engagement: 70 }],
      proof:      [{ box_key: 'hero', engagement: 50 }, { box_key: 'problem', engagement: 40 }, { box_key: 'beforeafter', engagement: 70 }],
      weak:       [{ box_key: 'hero', engagement: 40 }],
    };
    const mk = async (anon, fid, boxes, book) => {
      await post('/api/attn/collect', { anon_id: anon, page_slug: 'seitai-lp-a', boxes });
      await post('/api/attn/merge', { anon_id: anon, friend_id: fid, consented: true });
      if (book) await post('/api/attn/booking', { friend_id: fid });
    };
    const code = async (fid) => (await (await get('/api/attn/diagnose?friend_id=' + fid)).json()).diagnoses[0].cause.code;
    await mk('DG1', 'f_conv', P.converted, true);   eq(await code('f_conv'), 'converted', 'diagnose: converted');
    await mk('DG2', 'f_cta', P.cta);                eq(await code('f_cta'), 'cta_friction', 'diagnose: cta_friction');
    await mk('DG3', 'f_faq', P.faq);                eq(await code('f_faq'), 'unresolved_doubt', 'diagnose: unresolved_doubt');
    await mk('DG4', 'f_vbp', P.valuebp);            eq(await code('f_vbp'), 'value_before_price', 'diagnose: value_before_price');
    await mk('DG5', 'f_pa', P.priceanx);            eq(await code('f_pa'), 'price_anxiety', 'diagnose: price_anxiety');
    await mk('DG6', 'f_pf', P.proof);               eq(await code('f_pf'), 'proof_gap', 'diagnose: proof_gap');
    await mk('DG7', 'f_wk', P.weak);                eq(await code('f_wk'), 'weak_hook', 'diagnose: weak_hook');
    // 説明文と打ち手が付く（P2）
    const dg = await (await get('/api/attn/diagnose?friend_id=f_pa')).json();
    ok(dg.diagnoses[0].explanation && dg.diagnoses[0].actions.funnel.length > 0, 'diagnose: 説明＋導線案が付く');
    ok(dg.diagnoses[0].actions.outreach.has_message, 'diagnose: 離脱者への一言（下書き）が付く');
    // 未知friendは空・friend_id欠落は400
    eq((await (await get('/api/attn/diagnose?friend_id=nobody')).json()).diagnoses.length, 0, 'diagnose: 未知friendは空');
    eq((await get('/api/attn/diagnose')).status, 400, 'diagnose: friend_id欠落→400');
  });

  // 25) 因果セグメント（P3入力）：離脱理由でグルーピング（複数条件の複合）
  await withServer(async ({ post, get }) => {
    const priceanx = [{ box_key: 'hero', engagement: 50 }, { box_key: 'beforeafter', engagement: 80 }, { box_key: 'pricing', engagement: 70 }];
    const weak = [{ box_key: 'hero', engagement: 40 }];
    const cta = [{ box_key: 'hero', engagement: 50 }, { box_key: 'cta', engagement: 30 }];
    const mk = async (anon, fid, boxes) => { await post('/api/attn/collect', { anon_id: anon, page_slug: 'seitai-lp-a', boxes }); await post('/api/attn/merge', { anon_id: anon, friend_id: fid, consented: true }); };
    await mk('S1', 'f_s1', priceanx); await mk('S2', 'f_s2', weak); await mk('S3', 'f_s3', priceanx); await mk('S4', 'f_s4', cta);
    const seg = await (await get('/api/attn/cause-segments')).json();
    const find = c => seg.segments.find(s => s.cause_code === c);
    eq(find('price_anxiety').count, 2, 'セグメント: 料金不安2人');
    eq(find('weak_hook').count, 1, 'セグメント: FV直帰1人');
    eq(find('cta_friction').count, 1, 'セグメント: 予約導線1人');
    ok(find('price_anxiety').friends.includes('f_s1') && find('price_anxiety').friends.includes('f_s3'), 'セグメントにfriend_idが入る');
  });

  // 26) dispatch-plan（P3・Loku受け渡し）：コンプラゲート・opt-out除外・承認前提・テナント分離
  await withServer(async ({ post, get, postH, getH }) => {
    const pa = [{ box_key: 'hero', engagement: 50 }, { box_key: 'beforeafter', engagement: 80 }, { box_key: 'pricing', engagement: 70 }];
    for (const [a, f] of [['DA', 'f_DA'], ['DB', 'f_DB'], ['DC', 'f_DC']]) {
      await post('/api/attn/collect', { anon_id: a, page_slug: 'seitai-lp-a', boxes: pa });
      await post('/api/attn/merge', { anon_id: a, friend_id: f, consented: true });
    }
    await post('/api/attn/opt-out', { friend_id: 'f_DB' });            // 配信停止
    await post('/api/attn/profiling-opt-out', { friend_id: 'f_DC' });  // プロファイリング拒否
    const plan = await (await post('/api/attn/dispatch-plan', { cause_code: 'price_anxiety' })).json();
    ok(plan.requires_approval && !plan.auto_sent, 'dispatch: 承認前提・自動送信しない（human-in-the-loop）');
    ok(plan.delivery_via.includes('Loku'), 'dispatch: 撃つのはLoku本体AI配信');
    ok(plan.segment.includes('f_DA'), 'dispatch: 対象者はセグメントに入る');
    ok(!plan.segment.includes('f_DB'), 'dispatch: 配信停止者を除外');
    ok(!plan.segment.includes('f_DC'), 'dispatch: プロファイリング拒否者を除外');
    ok(plan.outreach.has_message && !plan.outreach.blocked && plan.outreach.message, 'dispatch: 一言はcheckCopy（接骨院基準）を通過');
    ok(plan.funnel.length > 0, 'dispatch: 導線チューニング案が付く');
    // 安全弁：全プリセットの一言が接骨院基準を通過（主張を作らない設計の担保）
    for (const c of CAUSE_CODES) {
      const p = await (await post('/api/attn/dispatch-plan', { cause_code: c })).json();
      ok(!p.outreach.blocked, `dispatch: 「${c}」の下書きは接骨院基準を通過`);
    }
    // バリデーション
    eq((await post('/api/attn/dispatch-plan', { cause_code: 'nope' })).status, 400, 'dispatch: 未知cause→400');
    eq((await post('/api/attn/dispatch-plan', {})).status, 400, 'dispatch: cause_code欠落→400');
    // テナント分離：t_2のfriendは t_1呼び出しのセグメントに混ざらない
    await post('/api/attn/collect', { anon_id: 'DT2', page_slug: 'seitai-lp-b', boxes: pa });
    await post('/api/attn/merge', { anon_id: 'DT2', friend_id: 'f_DT2', consented: true });
    const planT1 = await (await postH('/api/attn/dispatch-plan', { cause_code: 'price_anxiety' }, { 'x-tenant-id': 't_1' })).json();
    ok(!planT1.segment.includes('f_DT2'), 'dispatch: 他テナントのfriendは混ざらない');
  });

  // 27) 複合条件の網羅（64通り）：深度×予約×FAQ×実績 の総当りで不変条件を検証
  {
    const CODES = new Set(CAUSE_CODES);
    const EXITS = new Set(['converted', 'form_abandon', 'bounce', 'dropoff', 'no_data']);
    for (let depth = 0; depth <= 7; depth++) {
      for (const booked of [false, true]) {
        for (const faqHi of [false, true]) {
          for (const baHi of [false, true]) {
            const be = {};
            for (let i = 0; i <= depth; i++) be[BOX_ORDER[i]] = 10 + i; // >0
            if (faqHi && depth >= 6) be.faq = 80;
            if (baHi && depth >= 2) be.beforeafter = 80;
            const r = inferCause({ box_engagement: be, booked });
            const tag = `d${depth}/b${booked ? 1 : 0}/f${faqHi ? 1 : 0}/a${baHi ? 1 : 0}`;
            ok(CODES.has(r.code), `combo ${tag}: 有効な因果コード`);
            ok(EXITS.has(r.exit_type), `combo ${tag}: 有効なexit_type`);
            ok(!!r.label && !!r.explanation, `combo ${tag}: ラベル/説明あり`);
            ok(booked ? r.code === 'converted' : r.code !== 'converted', `combo ${tag}: convertedは予約と一致`);
            const act = suggestActions(r.code);
            ok(Array.isArray(act.funnel) && typeof act.outreach.message === 'string', `combo ${tag}: actionsの形`);
          }
        }
      }
    }
  }

  // 28) 契約テスト（③エンジン）：新APIのレスポンス形を固定
  await withServer(async ({ post, get }) => {
    const has = (o, keys, m) => ok(o && keys.every(k => k in o), m + ' 契約: {' + keys.join(',') + '}');
    await post('/api/attn/collect', { anon_id: 'CT', page_slug: 'seitai-lp-a', boxes: [{ box_key: 'hero', engagement: 50 }, { box_key: 'beforeafter', engagement: 80 }, { box_key: 'pricing', engagement: 70 }] });
    await post('/api/attn/merge', { anon_id: 'CT', friend_id: 'f_CT', consented: true });
    const dg = await (await get('/api/attn/diagnose?friend_id=f_CT')).json();
    has(dg, ['friend_id', 'diagnoses'], 'diagnose');
    has(dg.diagnoses[0], ['page_slug', 'exit_box', 'exit_type', 'cause', 'evidence', 'explanation', 'actions'], 'diagnose.row');
    has(dg.diagnoses[0].cause, ['code', 'label', 'confidence'], 'diagnose.cause');
    has(dg.diagnoses[0].actions, ['funnel', 'outreach'], 'diagnose.actions');
    has(await (await get('/api/attn/cause-segments')).json(), ['segments'], 'cause-segments');
    const plan = await (await post('/api/attn/dispatch-plan', { cause_code: 'price_anxiety' })).json();
    has(plan, ['ok', 'cause_code', 'cause_label', 'segment', 'count', 'funnel', 'outreach', 'requires_approval', 'auto_sent', 'delivery_via'], 'dispatch-plan');
    has(plan.outreach, ['has_message', 'message', 'blocked', 'violations'], 'dispatch-plan.outreach');
    // P0：journeyに離脱点が載る
    has((await (await get('/api/attn/journey?friend_id=f_CT')).json()).journeys[0], ['exit_box', 'exit_type'], 'journey.exit');
  });

  // ===== ③追加による元機能への影響（回帰・相互作用）=====
  section('C. ③×元機能 相互作用/回帰');

  // 29) 複合場面：新機能が既存の法務ゲート・削除・テナント・契約を迂回/破壊しないか
  await withServer(async ({ post, get, getH }) => {
    const pa = [{ box_key: 'hero', engagement: 50 }, { box_key: 'beforeafter', engagement: 80 }, { box_key: 'pricing', engagement: 70 }];
    // (a) forget後は diagnose も cause-segments も空（新経路から漏れない）
    await post('/api/attn/collect', { anon_id: 'IX1', page_slug: 'seitai-lp-a', boxes: pa });
    await post('/api/attn/merge', { anon_id: 'IX1', friend_id: 'f_ix1', consented: true });
    ok((await (await get('/api/attn/diagnose?friend_id=f_ix1')).json()).diagnoses.length > 0, '回帰: forget前はdiagnoseあり');
    await post('/api/attn/forget', { friend_id: 'f_ix1' });
    eq((await (await get('/api/attn/diagnose?friend_id=f_ix1')).json()).diagnoses.length, 0, '回帰: forget後はdiagnose空（新経路も漏れない）');
    ok(!(await (await get('/api/attn/cause-segments')).json()).segments.some(s => s.friends.includes('f_ix1')), '回帰: forget後はセグメントにも出ない');
    // (b) 非同意は diagnose に出ない（プライバシーゲートが新経路にも効く）
    await post('/api/attn/collect', { anon_id: 'IX2', page_slug: 'seitai-lp-a', boxes: pa });
    await post('/api/attn/merge', { anon_id: 'IX2', friend_id: 'f_ix2', consented: false });
    eq((await (await get('/api/attn/diagnose?friend_id=f_ix2')).json()).diagnoses.length, 0, '回帰: 非同意はdiagnoseに出ない');
    // (c) 要配慮情報は diagnose 出力にも一切残らない
    await post('/api/attn/collect', { anon_id: 'IX3', page_slug: 'seitai-lp-a', symptom: '慢性腰痛', diagnosis: 'ヘルニア', boxes: pa });
    await post('/api/attn/merge', { anon_id: 'IX3', friend_id: 'f_ix3', consented: true });
    const dgS = JSON.stringify(await (await get('/api/attn/diagnose?friend_id=f_ix3')).json());
    ok(!dgS.includes('腰痛') && !dgS.includes('ヘルニア'), '回帰: 要配慮情報はdiagnose出力にも残らない');
    // (d) 他テナントは diagnose も 403（RLSが新経路にも効く）
    await post('/api/attn/collect', { anon_id: 'IX4', page_slug: 'seitai-lp-a', boxes: pa });
    await post('/api/attn/merge', { anon_id: 'IX4', friend_id: 'f_ix4', consented: true });
    eq((await getH('/api/attn/diagnose?friend_id=f_ix4', { 'x-tenant-id': 't_2' })).status, 403, '回帰: 他テナントのdiagnoseは403');
    eq((await getH('/api/attn/diagnose?friend_id=f_ix4', { 'x-tenant-id': 't_1' })).status, 200, '回帰: 自テナントのdiagnoseは200');
    // (e) journey は元フィールド＋新フィールドが両立（契約非破壊）
    const jr = (await (await get('/api/attn/journey?friend_id=f_ix4')).json()).journeys[0];
    ok(['friend_id', 'page_slug', 'entry_query', 'box_engagement', 'search'].every(k => k in jr) && 'exit_box' in jr, '回帰: journeyは元契約＋離脱点を両立');
    // (f) 元のタグ発火は新機能追加後も従来どおり
    ok((await (await get('/api/attn/friend-tags?friend_id=f_ix4')).json()).tags.includes('効果重視'), '回帰: beforeafter高で効果重視タグは従来どおり発火');
    // (g) notice-policy ON中の未提示collectは従来どおり403（新機能は迂回路を作らない）
    await post('/api/attn/notice-policy', { require: true });
    eq((await post('/api/attn/collect', { anon_id: 'IX6', page_slug: 'seitai-lp-a', boxes: pa })).status, 403, '回帰: 通知必須ON時の未提示collectは403のまま');
    // (h) purge後は diagnose も空（保持期間管理が新経路にも効く）
    await post('/api/attn/notice-policy', { require: false });
    await post('/api/attn/collect', { anon_id: 'IX7', page_slug: 'seitai-lp-a', boxes: pa });
    await post('/api/attn/merge', { anon_id: 'IX7', friend_id: 'f_ix7', consented: true });
    await post('/api/attn/purge', { retention_days: 0, now: Date.now() + 86400000 });
    eq((await (await get('/api/attn/diagnose?friend_id=f_ix7')).json()).diagnoses.length, 0, '回帰: purge後はdiagnose空');
  });
}

const LOOPS = Number(process.argv[2] || 5);
console.log(`\n=== Loku Tuning handoff テスト（${LOOPS}周） ===`);
for (let i = 1; i <= LOOPS; i++) {
  const before = fail;
  await suite();
  console.log(`周回 ${i}/${LOOPS}: ${fail === before ? 'OK' : 'NG'}  (累計 pass=${pass} fail=${fail})`);
}
console.log(`\n結果: pass=${pass} fail=${fail}`);
// HTMLレポート蓄積用の機械可読サマリ（1行JSON）
console.log('QA_JSON:' + JSON.stringify({ loops: LOOPS, pass, fail, sections, at: new Date().toISOString() }));
if (fail) { console.log('失敗:', fails.slice(0, 10)); process.exit(1); }
console.log('✅ 全テスト通過（手戻りゼロ確認）');
