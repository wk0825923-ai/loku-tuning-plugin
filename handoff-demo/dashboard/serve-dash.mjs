// ダッシュボード配信サーバ（M2）：dashboard\の5画面(静的) + デモAPI(app.mjs)を同一オリジンで提供する。
//
// app.mjs は一切変更しない。createServer() が内部で http.createServer(callback) に
// 渡しているリクエストハンドラを listeners('request') 経由でそのまま再利用し、
// /api/ 配下・/journey-intelligence だけをそのハンドラへ委譲する（別ポートを立てずCORSも発生しない）。
// createServer() の中で作られる store は1個だけ・このプロセスの寿命の間ずっと同じ
// （seed-demo.mjs が collect/merge/booking で書き込んだ内容を、画面のfetchがそのまま読む）。
//
// 起動: node dashboard\serve-dash.mjs  → http://127.0.0.1:8788

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../app.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASH_PORT || 8788);

// APIサーバはこのプロセス内に生成するだけ（listen()しない＝ポートを消費しない）。
// allowShutdown=falseでも問題ない：/__shutdownはダッシュボード側からは呼ばない。
const apiServer = createServer({ allowShutdown: false });
const apiHandler = apiServer.listeners('request')[0];
if (typeof apiHandler !== 'function') {
  throw new Error('app.mjs の createServer() からリクエストハンドラを取得できませんでした');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // デモAPI・Journey Intelligence UIはapp.mjsの既存ハンドラへそのまま委譲（挙動は一切変えない）
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/journey-intelligence')) {
    return apiHandler(req, res);
  }

  // 静的配信：dashboard\配下のファイルのみ（ディレクトリトラバーサル対策でdashboard外は404）
  let rel = url.pathname === '/' ? '/screen-1-today.html' : decodeURIComponent(url.pathname);
  const full = path.normalize(path.join(__dirname, rel));
  const ext = path.extname(full);
  if (!full.startsWith(__dirname) || !existsSync(full) || !statSync(full).isFile() || !MIME[ext]) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[ext] });
  res.end(readFileSync(full));
});

server.listen(PORT, () => {
  console.log(`Loku Tuning ダッシュボード（M2） http://127.0.0.1:${PORT}`);
  console.log('  データ投入がまだなら: node dashboard/seed-demo.mjs');
});
