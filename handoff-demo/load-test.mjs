// 大量データ負荷テスト：N件の来訪→結合→予約を投入し、集計が正しく・落ちず・妥当な速度で返るか。
import { createServer } from './app.mjs';

const N = Number(process.argv[2] || 3000);
const HOT = [{ box_key: 'beforeafter', engagement: 100 }, { box_key: 'pricing', engagement: 92 }, { box_key: 'voice', engagement: 64 }];

const server = createServer();
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const get = (p) => fetch(base + p).then(r => r.json());

async function chunk(n, fn, size = 100) {
  for (let i = 0; i < n; i += size) {
    await Promise.all(Array.from({ length: Math.min(size, n - i) }, (_, k) => fn(i + k)));
  }
}

let rc = 0;
try {
  console.log(`\n=== 負荷テスト：${N.toLocaleString()} 件の来訪→結合→予約 ===`);
  const t0 = Date.now();
  await chunk(N, async i => {
    await post('/api/attn/collect', { anon_id: 'u' + i, page_slug: 'seitai-lp-a', boxes: HOT });
    await post('/api/attn/merge', { anon_id: 'u' + i, friend_id: 'f' + i, consented: true });
    if (i % 3 === 0) await post('/api/attn/booking', { friend_id: 'f' + i });
  });
  const tIngest = Date.now() - t0;

  const c0 = Date.now();
  const cv = await get('/api/attn/conversion-by-tag?tag=' + encodeURIComponent('料金検討中'));
  const tAgg = Date.now() - c0;

  const booked = Math.floor((N - 1) / 3) + 1;
  const okN = cv.with.n === N;
  const okBooked = cv.with.booked === booked;
  console.log(`  取り込み: ${tIngest} ms（${Math.round(N / (tIngest / 1000)).toLocaleString()} 件/秒）`);
  console.log(`  集計:     ${tAgg} ms（対象 ${cv.with.n.toLocaleString()} 人）`);
  console.log(`  実測CVR:  タグ有 ${cv.with.rate}%（予約 ${cv.with.booked.toLocaleString()} 人）`);
  console.log(`  ${okN ? '✅' : '❌'} 全 ${N} 人が集計対象   ${okBooked ? '✅' : '❌'} 予約者数 ${booked} 一致`);
  console.log(`  ${tAgg < 500 ? '✅' : '⚠️'} 集計は ${tAgg}ms（${N.toLocaleString()}人でも高速）`);
  rc = (okN && okBooked) ? 0 : 1;
  console.log('\n' + (rc ? '❌ 集計に不整合' : '✅ 大量データでも集計が正しく・落ちず・高速'));
} catch (e) {
  console.error('load error:', e.message); rc = 1;
} finally {
  await new Promise(r => server.close(r));
  process.exitCode = rc;
}
