// 統合シナリオ E2E：1人の店主の「導入 → 運用 → 成果」を全機能1本で通す。
// オンボ完了 → お客様LP閲覧 → LINE結合(タグ発火) → サチコ取込 → ジャーニー → 予約 → 実測CVR。
import { createServer } from './app.mjs';

const server = createServer();
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(base + p).then(r => r.json());
const HOT = [{ box_key: 'beforeafter', engagement: 100 }, { box_key: 'pricing', engagement: 92 }, { box_key: 'voice', engagement: 64 }];
let ng = 0; const ok = (c, m) => console.log((c ? '  ✅ ' : '  ❌ ') + m) || (c || ng++);

try {
  console.log('\n=== 統合シナリオ：整体サロンRecovery 田中さんの1日 ===\n');

  console.log('① 店主が導入ガイドを完了');
  for (let s = 1; s <= 5; s++) await post('/api/attn/product-event', { surface: 'onboarding', step: s });
  const fn = await get('/api/attn/product-funnel?surface=onboarding');
  ok(fn.funnel.length === 5, `導入ファネル記録：${fn.funnel.map(x => x.rate + '%').join(' → ')}`);

  console.log('② お客様がLPを閲覧（料金とBefore/Afterでじっくり）');
  const c = await post('/api/attn/collect', { anon_id: 'visit1', page_slug: 'seitai-lp-a', entry: { query: '肩こり 整体 世田谷', pos: 3, device: 'スマホ' }, active_sec: 42, boxes: HOT });
  ok(c.fired.includes('料金検討中'), `計測→タグ自動発火：${c.fired.join(' / ')}`);

  console.log('③ LINE登録 → 匿名が「田中さん」に結合（同意あり）');
  const m = await post('/api/attn/merge', { anon_id: 'visit1', friend_id: 'f_tanaka', consented: true });
  ok(m.applied, 'LINE友だちにタグ適用');

  console.log('④ サチコ（検索データ）を無料APIで取り込み');
  await post('/api/attn/search-console/ingest', { page_slug: 'seitai-lp-a', date: '2026-07-07', rows: [
    { keys: ['肩こり 整体 世田谷'], impressions: 1200, clicks: 74, position: 3.1 },
    { keys: ['デスクワーク 肩こり'], impressions: 500, clicks: 39, position: 2.2 },
  ] });

  console.log('⑤ 店主の画面：来訪ジャーニー（来る前＋来た後＋タグ）');
  const j = await get('/api/attn/journey?friend_id=f_tanaka');
  const jr = j.journeys[0];
  ok(jr.search && jr.search.clicks === 113, `来る前：検索クリック合計 ${jr.search && jr.search.clicks}・上位「${jr.search && jr.search.top[0].query}」`);
  ok(jr.box_engagement.pricing === 92, `来た後：料金 ${jr.box_engagement.pricing}／写真 ${jr.box_engagement.beforeafter}`);
  const t = await get('/api/attn/friend-tags?friend_id=f_tanaka');
  ok(t.tags.includes('料金検討中'), `付与タグ：${t.tags.join(' / ')}`);

  console.log('⑥ 「料金の案内」を送信 → 田中さん予約！');
  await post('/api/attn/booking', { friend_id: 'f_tanaka' });
  // 比較のためタグ無しの人も1名（予約せず）
  await post('/api/attn/collect', { anon_id: 'visit2', page_slug: 'seitai-lp-a', boxes: [{ box_key: 'hero', engagement: 10 }] });
  await post('/api/attn/merge', { anon_id: 'visit2', friend_id: 'f_other', consented: true });
  const conv = await get('/api/attn/conversion-by-tag?tag=' + encodeURIComponent('料金検討中'));
  ok(conv.with.rate > conv.without.rate, `実測CVR：タグ有 ${conv.with.rate}% ＞ タグ無 ${conv.without.rate}%`);

  console.log('\n' + (ng ? `❌ ${ng}件の不整合` : '✅ 導入→計測→結合→サチコ→ジャーニー→予約→実測CVR が1本で通った'));
} finally {
  await new Promise(r => server.close(r));
  process.exitCode = ng ? 1 : 0;
}
