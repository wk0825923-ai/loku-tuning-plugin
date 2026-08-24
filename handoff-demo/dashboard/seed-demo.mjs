// ダッシュボード用デモデータ投入（M2）。
//
// serve-dash.mjs（既定 http://127.0.0.1:8788）に対して、既存の公開API
//   POST /api/attn/collect → POST /api/attn/attn/merge → POST /api/attn/booking → GET /api/attn/diagnose
// を「実際にHTTPで叩く」ことで causal.mjs の因果エンジンを本当に通す。
// app.mjs は一切変更しない・読み取り専用の集計に使う既存エンドポイントしか呼ばない。
//
// box_engagement のパターンは causal.mjs の classify() のルールに合わせて設計してあるので、
// 生成される因果コード(cause_code)は決め打ちで再現できる（乱数に頼らない＝毎回同じ絵になる）。
//
// 実行後、dashboard/seed-manifest.json に「seed時点でのdiagnose結果」を書き出す。
// これは店主向け画面が「誰が全友だちか」を集計するための足場（本番はSupabase側でfriendを
// 一覧できるが、このデモAPIには友だち一覧エンドポイントが無いため、投入した側が知っている
// friend_id一覧をmanifestとして残す＝フェイクデータではなく実エンジンの出力そのもの）。
//
// 実行: node dashboard/seed-demo.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.DASH_BASE || 'http://127.0.0.1:8788';
const PAGE_SLUG = 'seitai-lp-a'; // pg_lpA / tenant t_1（app.mjs seedStore準拠）
const PRESET = 'pilates';        // 現行の楔（一次営業先）。診断の言い回しをピラティス基準に揃える

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function get(pathname) {
  const res = await fetch(BASE + pathname);
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// causal.mjs classify() のルールに沿って、狙った因果コードが確実に出るbox_engagementパターン。
// BOX_ORDER = hero, problem, beforeafter, staff, pricing, voice, faq, cta
const PROFILES = [
  { code: 'weak_hook', boxes: { hero: 25 } },
  { code: 'proof_gap', boxes: { hero: 70, problem: 60, beforeafter: 55, staff: 50 } },
  { code: 'value_before_price', boxes: { hero: 65, problem: 55, beforeafter: 15, staff: 20, pricing: 40 } },
  { code: 'price_anxiety', boxes: { hero: 70, problem: 60, beforeafter: 55, staff: 50, pricing: 45 } },
  { code: 'unresolved_doubt', boxes: { hero: 70, problem: 60, beforeafter: 55, staff: 50, pricing: 45, voice: 50, faq: 65 } },
  { code: 'cta_friction', boxes: { hero: 70, problem: 60, beforeafter: 55, staff: 50, pricing: 45, voice: 50, faq: 40, cta: 35 } },
];
// プロファイルごとの予約(booked)率イメージ：8人中 何人予約させるか（先頭から）
const BOOKED_PER_PROFILE = { weak_hook: 0, proof_gap: 1, value_before_price: 2, price_anxiety: 2, unresolved_doubt: 4, cta_friction: 3 };
const N_PER_PROFILE = 8;

const ADS = [
  { name: '夏割A', source: 'meta', medium: 'cpc', query: null },
  { name: '固定投稿', source: 'instagram', medium: 'social', query: null },
  { name: '紹介', source: 'referral', medium: 'referral', query: null },
];
const DEVICES = ['mobile', 'mobile', 'desktop'];

async function main() {
  console.log(`Loku Tuning デモデータ投入 → ${BASE} (page=${PAGE_SLUG}, preset=${PRESET})`);
  const manifest = [];
  let seq = 0;

  for (const profile of PROFILES) {
    const bookedCount = BOOKED_PER_PROFILE[profile.code] || 0;
    for (let i = 0; i < N_PER_PROFILE; i++) {
      seq++;
      const anonId = `demo_a_${seq}`;
      const friendId = `demo_f_${seq}`;
      const ad = ADS[seq % ADS.length];
      const device = DEVICES[seq % DEVICES.length];
      const boxes = Object.entries(profile.boxes).map(([box_key, engagement]) => ({
        box_key, engagement, active_view: Math.round(engagement * 1.2), revisits: engagement > 60 ? 2 : 0,
      }));

      await post('/api/attn/collect', {
        anon_id: anonId, page_slug: PAGE_SLUG,
        entry: { query: ad.query, pos: 1, device, source: ad.source, medium: ad.medium, campaign: ad.name },
        utm: { source: ad.source, medium: ad.medium, campaign: ad.name },
        active_sec: 20 + Object.keys(profile.boxes).length * 15,
        boxes,
      });

      await post('/api/attn/merge', {
        anon_id: anonId, friend_id: friendId, consented: true,
        consent_record: { obtained_by: '店舗のLIFF同意画面', method: 'liff_optin', at: Date.now() },
      });

      const booked = i < bookedCount;
      if (booked) await post('/api/attn/booking', { friend_id: friendId });

      manifest.push({ friend_id: friendId, anon_id: anonId, seed_cause_code: profile.code, source_label: ad.name, booked });
    }
  }

  console.log(`投入完了：${manifest.length}件（friend）。causal.mjs経由で診断を取得中...`);

  // 実エンジンに実際に診断させる（seed時点のスナップショット。ロジックはcausal.mjsそのまま・追加改変なし）
  for (const row of manifest) {
    const diag = await get(`/api/attn/diagnose?friend_id=${row.friend_id}&preset=${PRESET}`);
    const d = diag.diagnoses?.[0];
    row.exit_box = d?.exit_box ?? null;
    row.cause_code = d?.cause?.code ?? null;
    row.cause_label = d?.cause?.label ?? null;
    row.explanation = d?.explanation ?? null;
  }

  const outPath = path.join(__dirname, 'seed-manifest.json');
  writeFileSync(outPath, JSON.stringify({ page_slug: PAGE_SLUG, preset: PRESET, generated_at: new Date().toISOString(), friends: manifest }, null, 2));
  console.log(`manifest書き出し完了: ${outPath}`);
  console.log('ブラウザで http://127.0.0.1:8788/ を開いてください。');
}

main().catch(e => { console.error('seed失敗:', e); process.exit(1); });
