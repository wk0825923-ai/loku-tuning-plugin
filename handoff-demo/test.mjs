// 自動テスト（依存ゼロ）。各テストは createServer() で新インスタンス＝状態隔離。
// フルスイートを N 回ループして安定性・冪等性を確認する。
import { createServer, csvCell, encryptCsv } from './app.mjs';
import { stripSensitive } from './compliance.mjs';
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  ✗ ' + msg); } }
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
  try { await fn({ post, get, raw }); } finally { await new Promise(r => server.close(r)); }
}

const HOT_BOXES = [
  { box_key: 'hero', active_view: 7, engagement: 97, revisits: 1 },
  { box_key: 'beforeafter', active_view: 3, engagement: 100, revisits: 2 },
  { box_key: 'pricing', active_view: 4, engagement: 100, revisits: 3 },
  { box_key: 'voice', active_view: 12, engagement: 71, revisits: 1 },
  { box_key: 'staff', active_view: 1, engagement: 6, revisits: 1 },
];

async function suite() {
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
}

const LOOPS = Number(process.argv[2] || 5);
console.log(`\n=== Loku Attention handoff テスト（${LOOPS}周） ===`);
for (let i = 1; i <= LOOPS; i++) {
  const before = fail;
  await suite();
  console.log(`周回 ${i}/${LOOPS}: ${fail === before ? 'OK' : 'NG'}  (累計 pass=${pass} fail=${fail})`);
}
console.log(`\n結果: pass=${pass} fail=${fail}`);
if (fail) { console.log('失敗:', fails.slice(0, 10)); process.exit(1); }
console.log('✅ 全テスト通過（手戻りゼロ確認）');
