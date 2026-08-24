# Loku Tuning ダッシュボード（M2・動くダッシュボード）

M1のモック（`dashboard-design\`）を、デモAPI（`handoff-demo\app.mjs`）に実際に接続した5画面。
`app.mjs` は無改変（読み取り専用の既存エンドポイントのみ使用）。

## 起動（3行）

```
node dashboard/serve-dash.mjs
node dashboard/seed-demo.mjs
```
→ ブラウザで `http://127.0.0.1:8788/` を開く（`screen-1-today.html` が起点、下部ナビで5画面を行き来）

- `serve-dash.mjs`：ダッシュボード5画面の静的配信＋デモAPI（`app.mjs`のcreateServer()）を同一オリジンで提供
- `seed-demo.mjs`：collect→merge→booking→diagnose を実際にHTTPで叩き、causal.mjsの因果エンジンを通した48件のデモ来訪を投入し、`seed-manifest.json` に結果を保存
- APIに繋がらない/manifest未生成の場合は各画面が自動で内蔵ダミーデータへフォールバックし、画面上部に「デモデータ表示中」バッジが出る（黙って嘘をつかない）
