# Loku Tuning — アーキテクチャ / 一体化設計

> 位置づけ：**Loku本体（`tyatjidou` / `my-app`・Next.js + Supabase）に組み込む計測プラグイン**。
> 独立SaaSではない。Loku AIアシスタント（MCPツール群）でもない。
> Lokuの「友だち追加以降」しか無いCRMを、**「来る前（検索）＋来た後（ページ視線）」まで延伸する背骨**。

関連メモ: `project_lp_agent.md`（★重心転換 / ★Lokuプラグイン振り切り）, `project_loku_chan_market.md`, `feedback_avoid_feature_bloat.md`

---

## 0. 3層ジャーニー（このプロダクトが1画面に統合するもの）

| 層 | 何を持つか | 誰のデータ | 取得手段 |
|---|---|---|---|
| **来る前** | 検索クエリ・掲載順位・表示回数・CTR | Google所有 | Search Console **無料API** / GA4 Data API（無料） |
| **来た後** | ページ内のボックス単位 注意スコア・読了率・経路 | 自社（自前計測） | 計測SDK `loku-attn.js` |
| **その後** | 友だち追加・タグ・シナリオ配信・予約・決済 | Loku所有 | Loku本体DB（既存） |

GA4もサチコも「来た後→その後」で**匿名のまま途切れる**。Lokuは実名の予約・決済を持つので、
**匿名セッション → 友だちID の結合**を標準機能にできる。これが構造的な堀。

---

## B. 「LP限定」をやめて "Lokuページ全体の計測レイヤ" にする

LPは入口の一例にすぎない。同じSDKを **Lokuが作る/配る全ページ** に効かせる：

- LP（広告・アンケート流入）
- 予約ページ / メニュー表 / スタッフ紹介
- EC商品ページ / カート
- キャンペーン・クーポンページ
- Lokuちゃんマーケット / LP秘書ショップの出品ページ

→ 「**Lokuで配るページは全部、誰が何を見たか実名で分かる**」= Loku独自の**行動シグナル層**。
計測単位は `page` × `box`（セクション/画像/価格表/CTA）。ページ種別に依存しない汎用スキーマにする（下記）。

**PM判断**：まずLP 1種で価値実証（`project_lp_agent.md`の鉄則「①が売れるまで拡張しない」）。
SDKとスキーマは最初から汎用に作り、対象ページを段階解禁する（作りは汎用・見せ方は段階）。

### B-1. Loku既存機能マップとの関係（重複させない）
Lokuは単なるLINE配信ツールではなく、メッセージ配信＋コンテンツ（予約/クーポン/フォーム/リッチメニュー/**トラッキング/流入経路/分析**）＋会員ロイヤルティ＋コミュニティ（アプリ/掲示板/**コース**）＋**ショップ(EC)**＋**Mall(出品/クラファン)**＋代理店の統合プラットフォーム。
- **既に「トラッキング/流入経路/分析」がある** → Tuningは新タブでなく、これらの**解像度を上げる増築**（ボックス単位視線＋実名紐付け）。UIも新メニューを足さず既存分析＋友だち詳細に溶かす。
- **LIFF識別が結合レール** → ダッシュボード警告「リッチメニューからの友だち識別が無効（LIFF未登録）＝クーポン/フォームが誰のものか紐づかない」は、まさに匿名→実名問題。**anon→friend結合はLokuの既存LIFF識別基盤に乗る**（C-2の`state`回収と同一レール）。発明不要。

### B-2. kind別の計測対象（`page.kind`を増やすだけ）
| kind | 対象 | box例 | 発火する自動化 |
|---|---|---|---|
| `lp` | 広告/アンケLP | hero/料金/BA/CTA | 流入・温度感タグ → 配信 |
| `ec_product` | ショップ商品 | 画像/説明/価格/レビュー/カート | **カゴ落ちタグ → リマインダー+クーポン** |
| `mall_listing` | Mall出品 | 出品説明/画像/価格 | 関心タグ → 配信 |
| `crowdfunding` | クラファン | リターン/ストーリー/進捗 | **迷いリターン → 締切リマインド** |
| `community_course` | コース教材 | 各レッスンブロック | **つまずき箇所 → フォロー配信・完走率↑** |
| `form` | フォーム | 設問ブロック | 離脱設問の改善シグナル |
| `member` | 会員証/スタンプ/紹介 | 各ページ | 離脱点の特定 |

一目でわかる統合マップ＝`loku-integration-map.html`。

---

## C. 一体化設計

### C-1. コンポーネント
```
[ブラウザ: Lokuが配るページ]
   └ loku-attn.js  … ボックス計測(Attention Score) + sendBeacon
        │  anon_session_id (1st party cookie / localStorage)
        ▼
[Collector API]  POST /api/attn/collect   … CORS開放・軽量・バッチ受信
        ▼
[Supabase (Loku本体DB)]
   sessions / box_stats / tag_fires …（下記スキーマ）
        │
        ├─ Identity Merge … LINE友だち追加コールバックで anon_session_id → friend_id 結合
        ├─ Tag Engine     … 事前ルール（流入タグ + ボックス閾値タグ）を評価し friend_tags へ
        └─ Search Console Connector … 日次バッチで無料APIから検索指標を取り込み page に紐付け
        ▼
[Loku UI 内の1画面]  … 既存の友だち詳細に「この人の来訪ジャーニー」タブを1枚足すだけ
```

### C-2. 匿名 → 実名の結合（キモ）
1. ページ訪問時、SDKが `anon_session_id` を発行（1st-party・有効期限付き）。
2. CTAの友だち追加リンクに **`state=anon_session_id`** を載せる（LIFF / LINEログインの `state`、または追加後の初回LIFF起動で回収）。
3. 友だち追加コールバック（既存のLoku友だち登録フロー）で `state` を受け取り、
   `session_identity(anon_session_id → friend_id)` を書く。
4. これで当該セッションの全 `box_stats` が friend にJOIN可能になる。
   同意（オプトイン）が取れた友だちのみ結合する。

> 補足：`state` を運べない導線用のフォールバック＝短時間の IP+UA+直近クリック突合（確度低・任意）。基本は `state` 一択。

### C-3. タグエンジン（事前設計 → 自動付与）
- **流入タグ（route）**：`page.route_tag` を **ページ到達で即付与**（例「整体LP-A 流入」）。
- **ボックス閾値タグ（heat）**：`tag_rules(page_id, box_key, threshold, tag)` を満たしたら付与
  （例 `pricing.engagement >= 60 → 料金検討中`）。
- **集約タグ**：ページ平均 engagement ≥ 55 → `ホットリード`。
- 付与先は **Lokuの既存 `friend_tags`**（新テーブルを作らず本体のタグ資産に乗る）。
  → 付与後は既存のシナリオ/配信/予約導線がそのまま発火＝因果ループが地続き。

### C-4. Search Console コネクタ（無料）
- 店ごとに Google アカウント連携（OAuth）→ 対象プロパティを登録。
- 日次バッチで Search Analytics API（無料・25,000行/req・ページング）を叩き `search_console_daily` に格納。
- `page.url` と Search Console の `page` を突合し「このページに、どの検索語で、何位で、何人来たか」を1画面に。

### C-5. UI規律（本末転倒チェック／`feedback_avoid_feature_bloat`）
- **新しいメニューを増やさない。** 既存の「友だち詳細」に**タブ1枚**（来訪ジャーニー）を足すだけ。
- 店主に見せるのは3つだけ：①どの検索/広告で来たか ②どこを熱心に見たか ③自動で付いたタグ。
- 分析ダッシュボードは作らない。判断に使う1画面に絞る（Lokuの肥大化＝社長の詰め込み癖への明確なブレーキ）。

### C-6. プライバシー / 同意
- 実名紐付けは **友だち追加時の同意**（プライバシーポリシー・計測結合のオプトイン）を前提。
- 同意なしは匿名集計のみ（結合しない）。オプトアウトで `box_stats` の friend 紐付けを解除。
- Cookie は 1st-party のみ・第三者送信なし。

### C-7. コスト
- 計測：自社配信で数十円/店/月レンジ（`project_lp_agent.md`のコスト感）。
- 検索指標：Search Console API / GA4 Data API とも **無料**（クォータのみ）。
- サマリ文面のLLM化は任意（ルールベースで足りる。必要時のみHaiku/Sonnet）。

### C-8. ロールアウト
1. **Phase 1**：LP 1種でSDK＋collect＋friend結合＋タグ発火＋友だち詳細タブ（＝プロトタイプの実DB版）。
2. **Phase 2**：Search Console コネクタで「来る前」を1画面に合流。
3. **Phase 3**：計測対象を予約/EC/メニュー等へ解禁（汎用スキーマのまま対象を増やすだけ）。
4. **Phase 4**：溜まった行動シグナルを `project_loku_chan_market` の広告マーケット/ショップの燃料に。

---

### C-9. コンプライアンス設計（法務監査 legal-audit.html の対策を実装）
業務停止・行政処分の芽を、仕組みで塞ぐ。実装は `handoff-demo/compliance.mjs` ＋ `app.mjs`。

| リスク（法令） | 対策 | 実装 |
|---|---|---|
| 施術所広告規制＝**業務停止の直接原因**（柔整法/あはき法/薬機/景表） | コピー自動公開しない＋**業種別NGワードチェッカー**（high=公開ブロック / medium=要人承認） | `checkCopy(text, industry)` ＋ `POST /api/attn/check-copy`。integ=rikaku/judo/ahaki で厳格度可変（接骨院/鍼灸は体験談・適応症も high） |
| 要配慮個人情報（症状＋個人） | **症状は結合しない**（行動データのみ）＋明示同意ゲート | `stripSensitive()` が collect で健康フィールドを剥がす／`merge` の `consented=false` は結合・タグ適用しない |
| 忘れられる権利/オプトアウト | friend/anon 単位で計測データ削除 | `POST /api/attn/forget` → sessions/box_stats/identity/tag_fires/friend_tags を削除 |
| 外部送信規律（改正電通事業法） | 通知・公表の標準設置 | 各LPに外部送信通知＋プライバシーポリシー導線（訪問者UIに実装） |
| 安全管理措置 | tenant分離RLS・保持期間・削除 | `schema.sql` の RLS ポリシー例＋purge方針 |
| 責任分界 | 広告表現＝店舗一次責任／要配慮・外部送信＝店舗＋Loku（DPA） | 利用規約・委託契約（DPA）で明確化 |

> 最終確認は弁護士＋（必要に応じ）個人情報保護委員会。本設計は違反を機械的に減らすためのもので、法的助言ではない。

## D. ③因果エンジン（診断 → 次アクション）の実装/移植仕様

「数値化→**因果**→**次アクション**」の心臓。実装は `handoff-demo/causal.mjs`（純関数・依存ゼロ）＋ `app.mjs`（エンドポイント）。roadmap P0–P3＋P4基盤に対応。

### D-1. 設計原則（移植時に絶対に崩さない）
- **因果＝行動ベース**（`box_engagement` の到達深度だけで決まる）。**予約(booked)＝成果**は別軸。予約が離脱理由を上書きしない（`deriveExit` に booked を渡さない）。成果は `diagnose.booked` と `cause-outcomes` で測る。
- **新テーブル不要**。exit/cause は既存 `box_stats`（＋予約は既存 `bookings` 相当）から**都度導出**する純ロジック。Supabaseへは「関数/ビュー」として移植し、永続化する新スキーマは足さない（本末転倒チェック）。
- **主張を作らない**：outreach（離脱者への一言）は下書きのみ。送信経路の直前で必ず `checkCopy(text, プリセット既定の業種)` を通す**安全弁**（pilates→`fitness`／judo→`judo`。明示 `industry` 指定が優先）。NGなら下書きを渡さない。
- **送信は作り直さない**：撃つのは Loku本体のAI配信（`broadcasts_*_with_ai` / `scenarios` / `auto_responses`）。本エンジンは「因果＋セグメント＋下書き」を渡すだけ。

### D-2. L1/L2/L3（構造で作ってお任せ）
- **L1 エンジン（汎用）**：`deriveExit`（離脱点5種→現状は form_abandon/bounce/dropoff/no_data）・`classify`（因果推定の順序＝優先度）。業種非依存。
- **L2 業種プリセット（データ）**：`PRESETS`（`causal.mjs`）＝ `judo`（接骨院・温存＝回帰基準）と `pilates`（**現行の楔**・2026-07-12差替・`wedge:true`）。各プリセット＝ボックス辞書＋因果カタログ（EXPLAIN/FUNNEL/OUTREACH）＋checkCopy既定業種。**横展開はここに足すだけ**（コードを業種ごとに書かない）。エンジン既定は `judo`（後方互換）・API は `preset` パラメータで選択。`GET /api/attn/presets` で台帳を返す。※さらなる横展開の解禁は「③が楔業種で証明された後」＝GATE後。
- **L3 自己最適化**：`cause-outcomes`（因果別の実測予約率）が入力。適応的な重み学習の本体は**実データの経時蓄積待ち**（現状は計測の土台まで）。

### D-3. エンドポイント（本番も同一契約で移植）
| メソッド/パス | 役割 | 主なガード |
|---|---|---|
| `GET /api/attn/presets` | L2プリセット台帳（`wedge:true`＝現行の楔） | — |
| `GET /api/attn/diagnose?friend_id=&preset=` | 離脱点＋因果＋説明＋打ち手＋`booked`（言語化はプリセット・因果コードは非依存） | 同意ゲート・RLSテナント・未知preset→400 |
| `GET /api/attn/cause-segments` | 離脱理由でセグメント化（P3入力） | 同意・自テナントのみ |
| `POST /api/attn/dispatch-plan` | Loku配信"計画"を生成（**送信しない**） | `requires_approval:true`／opt_out・profiling_opt_out・**予約済み**・他テナントを除外／outreachは`checkCopy`通過 |
| `GET /api/attn/cause-outcomes` | 因果別の実測予約率（P4基盤の答え合わせ） | 同意・自テナントのみ |
| （既存）`GET /journey` | `exit_box`/`exit_type` を付与（P0） | 従来の同意・RLSを踏襲 |

### D-4. QA（移植後も担保）
`handoff-demo/test.mjs` の群23–35＋セクション別計測（A元機能/B新機能/C回帰/D-P4基盤/E楔差替）。`node test.mjs 50` で **pass=32,800 / fail=0**（2026-07-12・楔差替込み）。**セクションA〜Dは楔差替の前後で完全一致＝エンジン無傷の証拠**。セクションE＝fitness痩身NG辞書・pilatesプリセット・L1不変（因果コードはプリセット非依存）・judo既定の回帰ガード。移植後も同じ契約・同じ不変条件（複合条件64通り総当り含む）を回すこと。

---

## 移植メモ（実装者向け）
- SDKの計測ロジックは `index.html` の `tick()` がそのまま雛形（絶対スコア＝読んだ秒÷目安・4ゲート）。
- しきい値定数（`COVER_GATE / ZONE_LO/HI / VEL_STOP / IDLE_MS / HEAT_TH / READ_CPS`）は `page_boxes` か設定に外出しして店/ページ別に較正可能にする。
- スキーマは `schema.sql` を参照（Supabase/Postgres）。
