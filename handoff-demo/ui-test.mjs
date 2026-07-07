// 使用ユーザーとしての実行テスト（jsdom・ブラウザ相当）。
// 目的: ①ランタイムエラー/例外/console.error の握り潰しを全部拾う
//       ②スクロール計測→タグ点灯→LINE追加→リセット→カゴ落ち→購入 を実操作でシミュレート
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';

const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const assert = (c, m) => { if (c) pass++; else { fail++; fails.push(m); console.log('  ✗ ' + m); } };

async function loadDom(file) {
  const html = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push('jsdomError: ' + (e && e.message)));
  vc.on('error', (...a) => errs.push('console.error: ' + a.map(String).join(' ')));
  const RECTS = new WeakMap();
  const OFF = { top: 5000, bottom: 5100, left: 0, right: 300, width: 300, height: 100 };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.innerHeight = 800;
      window.document.hasFocus = () => true;
      Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'visible' });
      window.Element.prototype.getBoundingClientRect = function () { const r = RECTS.get(this); return r ? { ...OFF, ...r } : OFF; };
    },
  });
  const w = dom.window, doc = w.document;
  doc.addEventListener('click', e => e.preventDefault(), true); // javascript:void(0) の既定ナビ抑止
  const setRect = (sel, rect) => { const el = doc.querySelector(sel); RECTS.set(el, rect); return el; };
  const offRect = (sel) => { const el = doc.querySelector(sel); RECTS.set(el, OFF); };
  return { dom, w, doc, errs, setRect, offRect };
}

async function testLP() {
  const { dom, doc, errs, setRect, offRect } = await loadDom('../index.html');
  await wait(300);
  assert(errs.length === 0, 'LP: ロード時エラーゼロ [' + errs.join(' | ') + ']');
  assert(doc.getElementById('bar_pricing') && doc.getElementById('mergeBtn'), 'LP: 主要要素が存在');

  // 料金表だけ画面内にしてスクロール読了をシミュレート
  setRect('[data-box="pricing"]', { top: 100, bottom: 300, height: 200 });
  await wait(1600);
  const w1 = parseFloat(doc.getElementById('bar_pricing').style.width) || 0;
  assert(w1 > 0, 'LP: 計測でengagement増加（bar幅>0）= ' + w1.toFixed(0) + '%');
  await wait(1500); // 合計~3s可視 → engagement>=60
  assert(doc.getElementById('td_pricing').classList.contains('on'), 'LP: 料金検討中タグが点灯');
  assert(doc.querySelector('[data-box="pricing"]').classList.contains('hot'), 'LP: 料金ボックスがhot表示');

  // LINE追加
  doc.getElementById('mergeBtn').click();
  await wait(60);
  assert(doc.getElementById('profile').classList.contains('on'), 'LP: LINE追加でprofile表示');
  assert(doc.getElementById('liveWrap').style.display === 'none', 'LP: 計測パネルが隠れる');
  assert(doc.getElementById('tagList').children.length > 0, 'LP: 友だちにタグが付与表示');
  assert(/整体LP-A 流入/.test(doc.getElementById('tagList').textContent), 'LP: 流入タグが結合先に載る');

  // リセット（料金を画面外へ戻し、描画を1周待ってから確認）
  offRect('[data-box="pricing"]');
  doc.getElementById('resetBtn').click();
  await wait(60);
  assert(!doc.getElementById('profile').classList.contains('on'), 'LP: リセットで計測に戻る');
  await wait(300);
  assert(parseFloat(doc.getElementById('bar_pricing').style.width) === 0, 'LP: リセットでスコア0化');

  // 同意ゲート：同意OFFで LINE追加しても実名結合しない
  assert(!!doc.getElementById('consentChk'), 'LP: 外部送信通知＋同意バナーが存在');
  doc.getElementById('consentChk').checked = false;
  doc.getElementById('mergeBtn').click();
  await wait(60);
  assert(doc.getElementById('tagList').children.length === 0, 'LP: 同意OFFなら実名タグを付けない');
  assert(/同意がありません/.test(doc.getElementById('summary').textContent), 'LP: 同意OFFの説明を表示（匿名集計のみ）');

  assert(errs.length === 0, 'LP: 全操作を通してエラーゼロ [' + errs.join(' | ') + ']');
  dom.window.close();
}

async function testAdmin() {
  const { dom, doc, errs } = await loadDom('../loku-admin-view.html');
  await wait(50);
  assert(errs.length === 0, 'ADMIN: ロード時エラーゼロ [' + errs.join(' | ') + ']');
  assert(!!doc.getElementById('compchk'), 'ADMIN: 送信前の広告規制チェック表示あり');
  assert(/同意済/.test(doc.querySelector('.cbadge').textContent), 'ADMIN: 計測結合の同意バッジ表示');
  // 店主リテンション：今日のホーム＋人カードから開ける
  assert(!!doc.querySelector('.home'), 'ADMIN: 今日のホーム（成果＋今声かける人）あり');
  doc.querySelector('[data-hot="tanaka"]').click();
  await wait(30);
  assert(/田中/.test(doc.getElementById('dname').textContent), 'ADMIN: ホームの人カードから相手を開ける');
  // 懐疑派：実測の根拠カード
  assert(!!doc.querySelector('.evidence'), 'ADMIN: 実測の根拠カード（予測でなく実測）あり');
  // 友だち切替（佐藤＝カゴ落ち）でタグ更新
  doc.querySelector('.fitem[data-f="sato"]').click();
  await wait(30);
  assert(/カゴ落ち|価格検討/.test(doc.getElementById('dtags').textContent), 'ADMIN: 佐藤に切替でタグが更新');
  // 忘れられる権利（削除ボタン）
  doc.getElementById('forgetBtn').click();
  await wait(30);
  assert(doc.getElementById('toast2').classList.contains('on'), 'ADMIN: データ削除ボタンが動作');
  assert(errs.length === 0, 'ADMIN: 操作後もエラーゼロ [' + errs.join(' | ') + ']');
  dom.window.close();
}

async function testEC() {
  const { dom, doc, errs, setRect } = await loadDom('../ec-product.html');
  await wait(300);
  assert(errs.length === 0, 'EC: ロード時エラーゼロ [' + errs.join(' | ') + ']');
  assert(!!doc.getElementById('consentChk'), 'EC: 外部送信通知＋同意バナーが存在');

  // カートを凝視（未購入）→ カゴ落ち予備軍
  setRect('[data-box="cart"]', { top: 100, bottom: 300, height: 200 });
  await wait(2300);
  assert(doc.getElementById('td_cart').classList.contains('on'), 'EC: カゴ落ち予備軍タグが点灯（未購入）');

  // 購入したらカゴ落ちは消える
  doc.getElementById('buyBtn').click();
  assert(doc.getElementById('bought').textContent === '済', 'EC: 購入フラグが立つ');
  await wait(300);
  assert(!doc.getElementById('td_cart').classList.contains('on'), 'EC: 購入後はカゴ落ちタグが消える');

  // LINE登録→profile
  doc.getElementById('mergeBtn').click();
  await wait(60);
  assert(doc.getElementById('profile').classList.contains('on'), 'EC: LINE登録でprofile表示');
  assert(errs.length === 0, 'EC: 全操作を通してエラーゼロ [' + errs.join(' | ') + ']');
  dom.window.close();
}

// 全ページ共通：ロード＋主要インタラクションでランタイムエラーが出ないか
async function testPageNoErrors(file, clicks) {
  const { dom, doc, errs } = await loadDom('../' + file);
  await wait(60);
  (clicks || []).forEach(function (sel) {
    doc.querySelectorAll(sel).forEach(function (el) { try { el.click(); } catch (e) { errs.push('click例外(' + sel + '): ' + e.message); } });
  });
  await wait(60);
  assert(errs.length === 0, file + ': ロード＆全操作でエラーゼロ [' + errs.join(' | ') + ']');
  dom.window.close();
}

async function testAllPages() {
  await testPageNoErrors('onboarding.html', ['[data-next]', '[data-back]', '#lineBtn', '#gBtn', '#gSkip', '[data-pick]', '[data-restart]']);
  await testPageNoErrors('admin-console.html', ['.roles button', '[data-tgl]', '#ngFix', '#expBtn', '#delBtn', '#invBtn']);
  await testPageNoErrors('comparison.html', ['summary']);
  await testPageNoErrors('self-optimization.html', ['[data-ver]']);
  await testPageNoErrors('ga4-comparison.html', ['summary']);
  await testPageNoErrors('legal-audit.html', []);
  await testPageNoErrors('loku-integration-map.html', []);
  await testPageNoErrors('test-report.html', []);
}

const LOOPS = Number(process.argv[2] || 3);
console.log(`\n=== 使用ユーザー実行テスト（jsdom・${LOOPS}周） ===`);
for (let i = 1; i <= LOOPS; i++) {
  const before = fail;
  await testLP();
  await testEC();
  await testAdmin();
  await testAllPages();
  console.log(`周回 ${i}/${LOOPS}: ${fail === before ? 'OK' : 'NG'}  (累計 pass=${pass} fail=${fail})`);
}
console.log(`\n結果: pass=${pass} fail=${fail}`);
if (fail) { console.log('失敗:', fails.slice(0, 12)); process.exitCode = 1; }
else console.log('✅ ブラウザ相当の実行テスト 全通過（ランタイムエラーゼロ）');
