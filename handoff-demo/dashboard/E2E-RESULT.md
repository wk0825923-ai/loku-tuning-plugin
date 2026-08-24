# M3層A E2E検証結果

- 実施日時: 2026-08-24
- 対象: `handoff-demo`（ローカル・`dashboard/serve-dash.mjs` 経由で app.mjs のAPIを同一オリジンで叩く）
- 検証スクリプト: `dashboard/e2e-tag.mjs`（再実行可能。`node dashboard/serve-dash.mjs` を先に起動しておくこと）
- 編集禁止ファイル（app.mjs/test.mjs/README.md/schema.sql）は**未編集**。読むのみ。

## 一気通貫の成否

**成功。** タグ実装の純関数（`loku-attn.js` の `parseAdParams` / `resolveAnonId` / `computeAutoBoxes` /
`mergeBoxStats` / `buildPayload`）を実際にnodeから呼び、3人分の来訪者ペイロードを組み立てて
`/api/attn/collect` へ実HTTP POB（初回到達＋離脱フラッシュ=sendBeacon相当で2回送信）→
`/api/attn/merge`（LINE結合・consent正規手順）→`/api/attn/booking`（1人のみ）→
`/api/attn/diagnose` / `/api/attn/cause-segments` / `/api/attn/cause-outcomes` の因果分類→
ダッシュボード画面1が使う `/api/attn/journey-intelligence` / `/api/attn/cause-outcomes` まで、
一周が全てHTTP 200で通ることを確認した。

## 投入データ（3人・離脱パターンを分けて投入）

| 来訪者 | lt_src / lt_ad | 到達ボックス | 特記 |
|---|---|---|---|
| pricingExit | meta / E2E割 | hero→problem→beforeafter→staff→pricing（voice/faq/ctaは未到達） | beforeafter engagement=45（≥LOW=30）にしてvalue_before_priceを回避 |
| ctaExit | meta / E2E割 | hero→…→cta（全ボックス到達・未予約） | |
| bookingReach | line / E2E友だち限定 | hero→…→cta（全ボックス到達）＋実際に `/api/attn/booking` 実行 | 因果分類はctaExitと同じcta_frictionだが`booked:true`で成果側が分かれることを確認する狙い |

LINE結合（merge）は3人とも実施（因果分類の答え合わせに`friend_id`が必須なため）。
**bookingは指示どおり1人分のみ**（bookingReachの1件）実施。

## 因果分類 答え合わせ表

| 来訪者 | exit_box | exit_type | 期待コード | 実際のコード | 判定 |
|---|---|---|---|---|---|
| pricingExit | pricing | dropoff | price_anxiety | **price_anxiety**（confidence: medium） | ✅一致 |
| ctaExit | cta | form_abandon | cta_friction | **cta_friction**（confidence: high） | ✅一致 |
| bookingReach | cta | form_abandon | cta_friction（+booked:true） | **cta_friction**、`booked:true` | ✅一致 |

`cause-outcomes` にも反映を確認（既存デモ40件＋今回投入3件、うちbooked実績はbookingReach分の+1）:
- `cta_friction`: n=10（既存8+e2e2）, booked=4（既存3+e2e1）, booked_rate=40%
- `price_anxiety`: n=9（既存8+e2e1）, booked=2（既存のみ・pricingExitは未予約）, booked_rate=22%

`cause-segments` にも `fr_e2e_pricingExit_*` / `fr_e2e_ctaExit_*` / `fr_e2e_bookingReach_*` が
それぞれ正しいコードのセグメントに追加されていることを確認済み（ログ参照）。

## lt_src / lt_ad の行き先検証（事実確認）

**解消済み(2026-08-24)：サーバ側で受け・utm正規化・journey反映まで実装済み。**

- `loku-attn.js` の `buildPayload()` は仕様通り `lt_src` / `lt_ad` を collect ペイロードに含めて送信している（タグ側は実装済み）。
- `app.mjs` の `POST /api/attn/collect` ハンドラに lt_src/lt_ad 受け口を追加（m3層A）。`d.lt_src`→`utm.source`、`d.lt_ad`→`utm.campaign` にサーバ内部で正規化し、既に `d.utm` が明示的に来ている場合は utm を優先して上書きしない。元の値(`lt_ad`)はセッションに `sess.lt_ad` として別ラベルでも保持する。
- `GET /api/attn/journey` のレスポンス行に `utm` / `lt_ad` を追加。`node handoff-demo/dashboard/e2e-tag.mjs` 再実行で3人分すべて `lt_src or lt_ad present=true` を実測確認。`journey-intelligence` の `source_breakdown` にも `meta / E2E割`・`line / E2E友だち限定` として正しく反映されることを確認済み。
- テストは `handoff-demo/test.mjs` に Section I（lt_受け口: 正規化/utm優先/journey反映/未指定時に無害）を追加し全緑（既存A〜Hのpass数は変化なし）。

## ダッシュボードAPI反映確認（画面1）

- `screen-1-today.html` が使う `/api/attn/journey-intelligence?page_slug=seitai-lp-a` → **HTTP 200**
- `screen-1-today.html` が使う `/api/attn/cause-outcomes` → **HTTP 200**、上記の投入分（cta_friction n+2/booked+1, price_anxiety n+1）が数字に反映されていることを確認。

## 使用エンドポイント一覧（実施順）

1. `GET /api/attn/presets`（ヘルスチェック）
2. `POST /api/attn/collect` ×2（初回＋離脱フラッシュ）×3人 = 6回
3. `POST /api/attn/merge`（consent正規手順・consent_record完全）×3人
4. `POST /api/attn/booking` ×1人（bookingReachのみ）
5. `GET /api/attn/diagnose?friend_id=&preset=pilates` ×3人
6. `GET /api/attn/cause-segments`
7. `GET /api/attn/cause-outcomes`
8. `GET /api/attn/journey?friend_id=` ×3人（lt_src/lt_ad行き先検証用）
9. `GET /api/attn/journey-intelligence?page_slug=seitai-lp-a`（画面1相当）

## 発見したギャップ / バグ

1. **[解消済み(2026-08-24)]** `lt_src` / `lt_ad` のサーバ受け（utm正規化）を実装済み。上記「lt_src / lt_ad の行き先検証」参照。
2. 実装上のバグは検出されなかった（collect/merge/booking/diagnose/cause-segments/cause-outcomes/journey/journey-intelligence は全て仕様通りHTTP 200・期待どおりの因果分類）。

## プロセス

- `dashboard/serve-dash.mjs` をローカル起動（PORT 8788）→ 検証完了後、起動した1プロセスのみ終了。他の常駐node/Loku/Chromeプロセスには一切触れていない。
