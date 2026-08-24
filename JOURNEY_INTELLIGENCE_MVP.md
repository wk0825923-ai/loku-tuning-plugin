# Loku Tuning — Journey Intelligence MVP仕様

更新日: 2026-08-04

## 1. プロダクトゴール

既存LPからLoku内の問い合わせ・予約までを正確につなぎ、利用者が手作業なしで次の4つを把握できる状態を作る。

1. どこから来たか
2. 何人がLokuへ進んだか
3. 何人が問い合わせ・予約などの成果につながったか
4. 成果者と未成果者が何を見て、Loku内で何に迷ったか

Loku Tuningは「高性能ヒートマップ」ではなく、Attention Sensor・Journey Analytics・Marketer Autopilotを統合したJourney Intelligenceとして扱う。

## 2. North Starと成功判定

### North Star

`attributed_outcomes` = LP流入元とLPセッションを持ち、Loku上の同意済み友だちへ結合され、成果イベントまで接続できたユニーク人数。

### MVP技術ゲート

- collect/merge/成果イベントの再送で人数が増えない。
- bot・挙動疑義セッションを成果ファネルとAttention比較へ混ぜない。
- 他テナントの集計を返さない。
- 非同意ユーザーを個人ジャーニー・質問テーマ集計へ含めない。
- 会話本文・症状・診断を保存しない。
- Attentionを「視線」と断定せず、推定注目度として扱う。
- 流入、Loku到達、成果、Attention、質問テーマを1回の集計で返す。
- 週次配信へ渡せる事実ベースのpayloadを自動生成する。

### 実案件ゲート

- LP訪問→Loku到達の結合率を母数付きで確認できる。
- Loku到達→予約の接続漏れを実台帳との突合で説明できる。
- 週次集計に必要な人手を導入前後で計測する。
- 最低2週間または十分な母数が集まるまで傾向を断定しない。
- 店舗担当者が4つの答えを5分以内に説明できる。

数値目標は初回実案件のbaseline取得後に固定する。根拠のない改善率・精度・工数削減率は作らない。

## 3. 構造

### A. Attention Sensor

LP内のボックスごとに、中央表示、アクティブ時間、表示面積、スクロール速度、再訪を使って推定注目度を記録する。予約者と未予約者を混ぜずに比較する。

### B. Loku Journey Analytics（中核）

`流入 → LPセッション → Loku到達 → 質問テーマ → 成果`を結合する。匿名セッションから友だちへの結合はLoku既存のLIFF識別レールを使い、明示同意がある場合のみ個人ジャーニーへ昇格する。

### C. Marketer Autopilot

4つの答えを集計し、LINE・メール・Loku管理画面へ渡せる週次payloadを生成する。MVPでは外部送信そのものを再実装せず、Loku既存配信へ渡す。

## 4. イベント契約

| イベント | 冪等キー | 必須 | 保存しないもの |
|---|---|---|---|
| LP collect | `anon_id × page` | page、流入、Attention | 症状、診断、生の入力内容 |
| identity merge | `anon_id` | friend、同意、同意由来 | 不要なプロフィール情報 |
| conversation event | `event_id` | friend、theme | 会話本文、健康情報 |
| booking/outcome | 本番ではLoku成果ID | friend、成果種別、発生時刻 | 決済詳細など集計に不要な情報 |

質問テーマallowlistは `pricing / schedule / access / trial_flow / eligibility / cancellation / other`。テーマ追加は法務・必要性を確認してから行う。

## 5. 集計API

### `GET /api/attn/journey-intelligence?page_slug=`

- `funnel.lp_visitors`
- `funnel.loku_reached`
- `funnel.outcomes`
- `source_breakdown`
- `attention_by_outcome.booked / not_booked`
- `hesitation_themes`
- `inferred_dropoff_causes`
- `evidence`（母数）
- `caveat`（推定・データ不足の注意）

### `GET /api/attn/weekly-report?page_slug=`

上記集計と、外部配信へ渡せる短い事実文を返す。自動で勝敗・原因・改善効果を断定しない。

## 6. MVP非対象

- LPの自動書き換え
- 改善コピーの自動公開
- GA4全機能の再現
- 広告媒体APIの大量連携
- カメラや専用機器なしでの実視線計測という主張
- 少数データからの自動因果断定
- 新しい配信基盤の再実装

## 7. 本末転倒チェック

裏側の計測粒度は高くても、利用者へ最初に見せるのは4つの答えだけにする。生データ探索、詳細ボックス、診断は必要時に開く二層目へ置く。機能追加が新しい集計作業を生むなら採用しない。

## 8. 現在の証拠と残作業

### 実装済み

- Attention collect、単調増加merge、bot隔離
- LIFF想定の匿名→友だち結合、同意ゲート
- 予約成果、成果者/未成果者Attention比較
- 質問テーマの本文なし記録
- 4つの答えの統合集計
- 週次配信用payload
- 週次購読、cron生成、Loku配信用outbox（同じ週の再実行は冪等）
- Supabase移植用スキーマ
- 4つの答えに絞った実UI（API接続／デモ切替）

### 残作業

- 本番Lokuの実テーブル・LIFFコールバックへの移植
- 予約以外の問い合わせ/来店/成約イベント型の確定
- Loku既存配信workerによるoutboxの実送信接続
- 実案件での結合精度・工数削減・継続価値の検証
