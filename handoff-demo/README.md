# Loku Attention — 引き渡しデモ（バックエンド）

社長（フルスタック）が **Loku本体（`tyatjidou`/`my-app`・Next.js + Supabase）へ写経**すれば動くように、
`collect → merge(LIFF結合) → journey → タグ発火` のロジックを **依存ゼロ・本番非接触**で実装＆テスト済み。

> このフォルダは本番Lokuに一切接続しません。ストアはインメモリ（`app.mjs` の `seedStore()`）。
> 本番では同じロジックを **Supabase（`../schema.sql`）** に置き換えるだけ。

---

## 動かす（Node 18+ / 検証は Node 24）

```bash
# 1) 自動テスト（各テストは新インスタンス＝状態隔離。数字はループ回数）
node test.mjs 10        # → pass=320 fail=0 / ✅ 全テスト通過

# 2) 使用ユーザー相当の実行テスト（jsdom＝ブラウザ相当。要 npm i）
node ui-test.mjs 3     # → pass=54 fail=0 / ランタイムエラーゼロ
#   スクロール計測→タグ点灯→LINE追加→リセット→カゴ落ち→購入 を実操作でシミュレートし、
#   console.error/未捕捉例外/jsdomError を全部拾う（../index.html と ../ec-product.html）

# 3) クロスプロセスE2E（別プロセスでサーバ起動→外から叩く→綺麗に終了）
node e2e.mjs           # → ✅ 生サーバ E2E OK / exit=0

# 4) 統合シナリオ（全機能を1本で：導入→計測→結合→サチコ→ジャーニー→予約→実測CVR）
node scenario.mjs      # → ✅ 1本で通った

# 5) 大量データ負荷（既定3,000件・集計速度と正しさを確認）
node load-test.mjs 3000

# 6) 手動サーバ（curlで触りたいとき）
node serve.mjs         # → http://127.0.0.1:8787
```

手動curl例：
```bash
curl -s localhost:8787/api/attn/collect -H 'content-type: application/json' \
  -d '{"anon_id":"a1","page_slug":"seitai-lp-a","entry":{"query":"肩こり 整体","pos":3,"device":"スマホ"},
       "boxes":[{"box_key":"pricing","engagement":80},{"box_key":"beforeafter","engagement":100}]}'
# → {"ok":true,"fired":["整体LP-A 流入","料金検討中","効果重視"]}

curl -s localhost:8787/api/attn/merge -H 'content-type: application/json' \
  -d '{"anon_id":"a1","friend_id":"f_1","consented":true}'

curl -s "localhost:8787/api/attn/journey?friend_id=f_1"
curl -s "localhost:8787/api/attn/friend-tags?friend_id=f_1"
```

---

## API（本番でもこの4本）

| メソッド | パス | 役割 | 本番の書き先 |
|---|---|---|---|
| POST | `/api/attn/collect` | 到達＋ボックス視線のバッチ受信・タグ評価 | `loku_attn_sessions` / `_box_stats` / `_tag_fires` |
| POST | `/api/attn/merge` | **匿名→友だち結合（LIFF）** ・同意時タグ適用 | `loku_attn_identity` → `friend_tags` |
| GET | `/api/attn/journey?friend_id=` | 来訪ジャーニー（同意済みのみ） | ビュー `loku_attn_friend_journey` |
| GET | `/api/attn/friend-tags?friend_id=` | 付与済みタグ | `friend_tags` |
| POST | `/api/attn/check-copy` | 改善コピーの出稿前チェック（薬機/景表/柔整・あはき・業種別） | 公開ゲート（`compliance.mjs`） |
| POST | `/api/attn/forget` | 忘れられる権利/オプトアウト：friend/anon単位で削除 | 全テーブルから削除 |
| POST | `/api/attn/search-console/ingest` | サチコAPIで引っ張った行を取り込み（来る前を搭載） | `search_console_daily`（`search-console.mjs`） |
| GET | `/api/attn/search-summary?page_slug=` | ページの検索サマリ（表示回数/クリック/順位/上位クエリ） | 集計 |

### Search Console 連携（サチコをAPIで引っ張って搭載）
- サチコの検索データはGoogle所有＝自前計測では取れないので、**Search Console API（無料）で引っ張って**取り込む。
- `search-console.mjs`：`fetchSearchConsole({fetcher})` は本番＝Google API呼び出しを渡す／デモ＝モックを渡す（差し替え式）。`ingestSearchConsole()` で取り込み（page×date×query でupsert＝再取込しても重複しない）、`searchSummary()` で集計。
- `journey` レスポンスに `search`（来る前）が合成される。本番は日次バッチで ingest を回す。LP自社ホスティングなら当方がドメイン所有権を持てるので店主は設定ほぼ不要。

### コンプライアンス（法務対策の実装 → 詳細 `../legal-audit.html` / `../ARCHITECTURE.md` C-9）
- **業種別NGワードチェッカー**：`checkCopy(text, industry)`。`industry` = `rikaku`(整体) / `judo`(接骨院) / `ahaki`(鍼灸)。high=公開ブロック（治る/必ず/No.1 等）、medium=要人承認。接骨院・鍼灸は体験談・適応症も high に格上げ。
- **要配慮個人情報ガード**：`stripSensitive()` が collect で症状・診断など健康フィールドを剥がす（結合させない）。
- **同意ゲート**：`merge` の `consented=false` は結合・タグ適用をしない。
- **忘れられる権利**：`forget` で friend/anon 単位に計測データを削除。

### 不変条件（テストで担保済み・本番でも守ること）
- **同意ゲート**：`consented=false` は journey に出さない・タグ適用しない（プライバシー）
- **冪等性**：collect/merge の再送で行・タグを重複させない（`session×box` 1行、タグは Set）
- **流入タグは到達で即発火**、温度感タグは `engagement >= 閾値(60)`、集約タグは平均 `>= 55`
- **後追いcollect**：結合後にさらに読んだら friend_tags が増える
- **バリデーション**：必須欠落=400 / 未知ページ=404 / 壊れたJSON=400

---

## 本番（Loku）移植の要点

1. **ストア差し替え**：`app.mjs` の Map 群 → Supabase（`../schema.sql`）。関数の形はそのまま。
2. **匿名→友だち結合（キモ）**：
   - SDKがページ訪問時に `anon_id`（1st-party cookie/localStorage）を発行。
   - 友だち追加リンクに `state=anon_id` を載せる（**Lokuの既存LIFF識別基盤に乗る**。ダッシュボード警告「LIFF未登録」を有効化する所と同じレール）。
   - 追加コールバックで `state` を回収し `/api/attn/merge` を呼ぶ。同意（オプトイン）が取れた友だちのみ結合。
3. **タグ適用先**：新テーブルを作らず **Lokuの既存 `friend_tags`** に入れる → 既存のシナリオ/一斉配信/クーポンがそのまま発火。
4. **RLS**：`tenant_id` で行レベルセキュリティ。collectはservice roleで書き、参照はテナントスコープ。
5. **UI**：新メニューを足さず、既存「友だち詳細」に来訪ジャーニーの**タブ1枚**だけ（`ARCHITECTURE.md` C-5 の肥大化ブレーキ）。
6. **汎用化**：`page.kind` を増やすだけで EC商品/クラファン/コース等に展開（`ARCHITECTURE.md` B-2）。

## ファイル
- `app.mjs` … サーバ本体（ロジック）。`createServer()` は都度まっさらなストア。
- `test.mjs` … 自動テスト（9シナリオ×ループ）。
- `e2e.mjs` … クロスプロセスE2E（別プロセス起動→外から検証→graceful shutdown）。
- `serve.mjs` … 手動起動（`PORT`, `ALLOW_SHUTDOWN=1` 環境変数対応）。
- `../schema.sql` … Supabaseスキーマ / `../ARCHITECTURE.md` … 全体設計 / `../loku-integration-map.html` … 機能統合マップ。
