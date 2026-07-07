// クロスプロセス E2E：別プロセスで serve.mjs を起動し、外から叩いてクリーンに落とす。
// 単一コマンド `node e2e.mjs` で完結（Bashのjob control不要＝Windowsでも綺麗に終了）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(BASE + p).then(r => r.json());

const child = spawn(process.execPath, [join(here, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT), ALLOW_SHUTDOWN: '1' }, stdio: 'ignore' });
const childExit = new Promise(r => child.on('exit', r));

async function waitUp(n = 60) {
  for (let i = 0; i < n; i++) {
    try { await fetch(BASE + '/api/attn/journey?friend_id=ping'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server not up');
}

let rc = 1;
try {
  await waitUp();
  console.log('→ 別プロセスの生サーバに疎通OK (port ' + PORT + ')');

  const c = await post('/api/attn/collect', {
    anon_id: 'live_1', page_slug: 'seitai-lp-a',
    entry: { query: 'デスクワーク 肩こり 改善', pos: 2, device: 'PC' }, active_sec: 55,
    boxes: [{ box_key: 'beforeafter', engagement: 100 }, { box_key: 'pricing', engagement: 88 }, { box_key: 'voice', engagement: 40 }],
  });
  console.log('collect 発火タグ:', c.fired);
  const m = await post('/api/attn/merge', { anon_id: 'live_1', friend_id: 'f_live', consented: true });
  console.log('merge:', m);
  const j = await get('/api/attn/journey?friend_id=f_live');
  console.log('journey:', JSON.stringify(j.journeys[0]));
  const t = await get('/api/attn/friend-tags?friend_id=f_live');
  console.log('friend_tags:', t.tags);

  const okAll = c.fired.includes('整体LP-A 流入') && c.fired.includes('効果重視') && c.fired.includes('料金検討中')
    && j.journeys.length === 1 && j.journeys[0].entry_query === 'デスクワーク 肩こり 改善'
    && t.tags.includes('料金検討中');
  console.log(okAll ? '\n✅ 生サーバ E2E OK' : '\n❌ 生サーバ E2E NG');
  rc = okAll ? 0 : 1;
} catch (e) {
  console.error('E2E error:', e.message);
} finally {
  // 信号killせず、HTTPで子を自発終了させてから待つ（Windowsのlibuvアサート回避）
  try { await fetch(BASE + '/__shutdown', { method: 'POST', headers: { connection: 'close' } }); } catch {}
  await Promise.race([childExit, new Promise(r => setTimeout(r, 2000))]);
  // process.exit で即死させず、exitCode を立てて自然終了（親側ソケットも綺麗に閉じる）
  process.exitCode = rc;
}
