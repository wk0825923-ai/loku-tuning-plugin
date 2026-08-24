// test-tag.mjs — loku-attn.js（M3・層A タグ本体）の純関数部分の単体テスト
// DOM非依存の関数（parseAdParams / resolveAnonId / computeAutoBoxes / mergeBoxStats / buildPayload）を検証する。
// 実行: node handoff-demo/test-tag.mjs
// 新規ファイルのみで完結。app.mjs / test.mjs には一切触れない。

import assert from 'node:assert/strict';
import {
  parseAdParams, resolveAnonId, computeAutoBoxes, mergeBoxStats, buildPayload,
} from './dashboard/loku-attn.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('== parseAdParams ==');
test('lt_src / lt_ad を両方読む', () => {
  const r = parseAdParams('?lt_src=line_broadcast_0820&lt_ad=creative_a');
  assert.equal(r.lt_src, 'line_broadcast_0820');
  assert.equal(r.lt_ad, 'creative_a');
});
test('片方だけの場合はもう片方null', () => {
  const r = parseAdParams('?lt_src=insta_story');
  assert.equal(r.lt_src, 'insta_story');
  assert.equal(r.lt_ad, null);
});
test('パラメータが無ければ両方null', () => {
  const r = parseAdParams('?utm_source=google');
  assert.equal(r.lt_src, null);
  assert.equal(r.lt_ad, null);
});
test('空文字/未定義searchでも落ちない', () => {
  assert.deepEqual(parseAdParams(''), { lt_src: null, lt_ad: null });
  assert.deepEqual(parseAdParams(undefined), { lt_src: null, lt_ad: null });
});
test('異常に長い値は128文字で切る', () => {
  const long = 'x'.repeat(300);
  const r = parseAdParams(`?lt_src=${long}`);
  assert.equal(r.lt_src.length, 128);
});

console.log('== resolveAnonId（巻き戻り防止） ==');
const now = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
test('cookie/storage共に無ければ新規発行', () => {
  const r = resolveAnonId({ cookieVal: null, cookieAt: null, storageVal: null, storageAt: null, now, genId: () => 'NEW' });
  assert.equal(r.anonId, 'NEW');
  assert.equal(r.isNew, true);
});
test('cookieが新鮮なら既存cookieを優先し新規発行しない', () => {
  const r = resolveAnonId({
    cookieVal: 'existing-cookie', cookieAt: now - DAY,
    storageVal: 'existing-storage', storageAt: now - DAY,
    now, genId: () => 'NEW',
  });
  assert.equal(r.anonId, 'existing-cookie');
  assert.equal(r.isNew, false);
});
test('cookieが無くstorageが新鮮ならstorageを使う（巻き戻らない）', () => {
  const r = resolveAnonId({
    cookieVal: null, cookieAt: null,
    storageVal: 'existing-storage', storageAt: now - DAY,
    now, genId: () => 'NEW',
  });
  assert.equal(r.anonId, 'existing-storage');
  assert.equal(r.isNew, false);
});
test('7日超で期限切れなら新規発行する（揮発前提）', () => {
  const r = resolveAnonId({
    cookieVal: 'old-cookie', cookieAt: now - 8 * DAY,
    storageVal: 'old-storage', storageAt: now - 8 * DAY,
    now, genId: () => 'NEW',
  });
  assert.equal(r.anonId, 'NEW');
  assert.equal(r.isNew, true);
});
test('cookieが期限切れでもstorageが新鮮ならstorageを使う', () => {
  const r = resolveAnonId({
    cookieVal: 'old-cookie', cookieAt: now - 8 * DAY,
    storageVal: 'fresh-storage', storageAt: now - DAY,
    now, genId: () => 'NEW',
  });
  assert.equal(r.anonId, 'fresh-storage');
  assert.equal(r.isNew, false);
});

console.log('== computeAutoBoxes（フォールバック自動分割） ==');
test('section/h2境界でauto_1..nに分割しラベル候補を先頭20字で作る', () => {
  const sections = [
    { tag: 'SECTION', text: '' },
    { tag: 'H2', text: 'スタジオの雰囲気についてとても長い見出しテキストの例文です' },
    { tag: 'H2', text: 'インストラクター紹介' },
  ];
  const r = computeAutoBoxes(sections);
  assert.equal(r.length, 3);
  assert.equal(r[0].box_key, 'auto_1');
  assert.equal(r[1].box_key, 'auto_2');
  assert.equal(r[1].label.length, 20);
  assert.equal(r[2].label, 'インストラクター紹介');
});
test('対象外タグ(P/DIV等)は無視される', () => {
  const r = computeAutoBoxes([{ tag: 'DIV', text: 'x' }, { tag: 'P', text: 'y' }]);
  assert.equal(r.length, 0);
});
test('入力が配列でなくても落ちない', () => {
  assert.deepEqual(computeAutoBoxes(null), []);
  assert.deepEqual(computeAutoBoxes(undefined), []);
});
test('見出しテキストの空白は正規化される', () => {
  const r = computeAutoBoxes([{ tag: 'H1', text: '  よくある\n  ご質問  ' }]);
  assert.equal(r[0].label, 'よくある ご質問');
});

console.log('== mergeBoxStats（単調増加マージ・P1準拠） ==');
test('新規は0から加算', () => {
  const r = mergeBoxStats(undefined, { active_view: 3, engagement: 20, revisits: 1 });
  assert.deepEqual(r, { active_view: 3, engagement: 20, revisits: 1 });
});
test('後着の小さい値で確定値を巻き戻さない（max取り）', () => {
  const prev = { active_view: 10, engagement: 80, revisits: 3 };
  const r = mergeBoxStats(prev, { active_view: 4, engagement: 30, revisits: 1 });
  assert.deepEqual(r, { active_view: 10, engagement: 80, revisits: 3 });
});
test('より大きい値が来れば更新される', () => {
  const prev = { active_view: 10, engagement: 80, revisits: 3 };
  const r = mergeBoxStats(prev, { active_view: 15, engagement: 95, revisits: 5 });
  assert.deepEqual(r, { active_view: 15, engagement: 95, revisits: 5 });
});
test('engagementは0-100に丸める', () => {
  const r = mergeBoxStats(undefined, { active_view: 1, engagement: 150, revisits: 0 });
  assert.equal(r.engagement, 100);
  const r2 = mergeBoxStats(undefined, { active_view: 1, engagement: -20, revisits: 0 });
  assert.equal(r2.engagement, 0);
});
test('不正値(NaN等)でも落ちずに0扱い', () => {
  const r = mergeBoxStats(undefined, { active_view: 'x', engagement: undefined, revisits: null });
  assert.deepEqual(r, { active_view: 0, engagement: 0, revisits: 0 });
});

console.log('== buildPayload（collectペイロード組み立て） ==');
test('必須フィールド＋boxesを正しく組み立てる', () => {
  const p = buildPayload({
    anonId: 'a1', pageSlug: 'test-pilates-lp',
    activeSec: 12.34, boxes: [{ box_key: 'hero', active_view: 3, engagement: 40, revisits: 1 }],
  });
  assert.equal(p.anon_id, 'a1');
  assert.equal(p.page_slug, 'test-pilates-lp');
  assert.equal(p.active_sec, 12.34);
  assert.deepEqual(p.boxes, [{ box_key: 'hero', active_view: 3, engagement: 40, revisits: 1 }]);
});
test('lt_src/lt_adはadParamsに値がある時だけ乗る', () => {
  const withAd = buildPayload({ anonId: 'a', pageSlug: 'p', adParams: { lt_src: 's', lt_ad: null } });
  assert.equal(withAd.lt_src, 's');
  assert.equal(withAd.lt_ad, null);
  const noAd = buildPayload({ anonId: 'a', pageSlug: 'p', adParams: { lt_src: null, lt_ad: null } });
  assert.equal('lt_src' in noAd, false);
});
test('entry/utm/referrerは値がある時だけ乗る（app.mjsの入力仕様に合わせる）', () => {
  const minimal = buildPayload({ anonId: 'a', pageSlug: 'p' });
  assert.equal('entry' in minimal, false);
  assert.equal('utm' in minimal, false);
  assert.equal('referrer' in minimal, false);
  const full = buildPayload({
    anonId: 'a', pageSlug: 'p',
    entry: { query: 'q', device: 'mobile' }, utm: { source: 'line' }, referrer: 'https://line.me/',
  });
  assert.deepEqual(full.entry, { query: 'q', device: 'mobile' });
  assert.deepEqual(full.utm, { source: 'line' });
  assert.equal(full.referrer, 'https://line.me/');
});
test('boxesが未指定/非配列でも空配列で落ちない', () => {
  assert.deepEqual(buildPayload({ anonId: 'a', pageSlug: 'p' }).boxes, []);
  assert.deepEqual(buildPayload({ anonId: 'a', pageSlug: 'p', boxes: null }).boxes, []);
});
test('notice_shownはデフォルトfalse・明示すればtrue', () => {
  assert.equal(buildPayload({ anonId: 'a', pageSlug: 'p' }).notice_shown, false);
  assert.equal(buildPayload({ anonId: 'a', pageSlug: 'p', noticeShown: true }).notice_shown, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
