# 計測堅牢化ノート（目付 巡回学習ループからの還流）

Loku Tuningの**計測土台**（法規制以外）の堅牢化材料。
出所＝目付(metsuke)の巡回。エージェント定義=`~/.claude/agents/metsuke.md`、蓄積ノート=`~/.claude/measure-notebook/`。

**書式**：現象 → 根拠URL（S/A） → loku-attn.js（＝index.html内tick()相当の本番計測SDK）/ app.mjs collectへの対策案 → 検証方法 → 優先度。
**鉄則**：目付はここに設計材料を書くまで。**コード実装・QA・コミットはメインターミナルの領分。ここのコードは触っていない。**

---

## 現物の現在地（2026-07-13 目付が確認した事実）

- `index.html` の `tick()` は **200ms間隔の `setTimeout` ループでクライアント側engagementを計算するデモ**。4ゲート（可視・非アイドル25s・低速スクロール・中央ゾーン）で滞在秒を積む方式。
- **決定的な穴：離脱時の送信機構が一切ない。** `sendBeacon` も `pagehide` も `visibilitychange`フラッシュも未実装。可視性は `focus`/`blur` と `document.visibilityState` を計測ゲートに使うのみで、**「データを飛ばす」処理が無い**。デモだから成立しているが、本番SDK(loku-attn.js)化する際はここが最優先の設計対象。
- `app.mjs` の `/api/attn/collect` は `anon_id` キーで session/box_stats をupsert。ただし **`sess.active_sec = d.active_sec`（上書き代入）** ＝後から届いたバッチの値で単純上書き。engagementは `Math.min(100,Math.max(0,eng))` でクランプ済み・型防御あり（ここは堅い）。

---

## 種一覧（優先度つき）

### 【P0】離脱時フラッシュを visibilitychange(hidden)＋pagehide の二段で実装する
- **現象**：本番loku-attn.jsが離脱直前にデータを送らないと、滞在・視線が「途中まで」で欠落する。特にモバイル／LINE内ブラウザでは `beforeunload`/`unload` はほぼ発火しない（例えると：お客さんが店を出る瞬間に「今日どこを見たか」を書き留めるはずが、出口に誰も立っていない状態）。
- **根拠URL（S/A）**：
  - MDN `Navigator.sendBeacon`（S）：「最も確実なのは `visibilitychange` で送ること。未対応ブラウザ用に `pagehide` をフォールバックにする。`unload`/`beforeunload` は extremely unreliable」 https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon
  - Speedkit ベンチ（A・5,200万PV実測）：`visibilitychange`＋`pagehide` の併用で **91%到達**。`beforeunload` はモバイルで壊滅 https://www.speedkit.com/blog/unload-beacon-reliability-benchmarking-strategies-for-minimal-data-loss
- **対策案**：
  - loku-attn.js に `document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden') flush(); })` と `window.addEventListener('pagehide', flush)` を追加。`flush()` は現在のsession要約＋box_statsを `navigator.sendBeacon('/api/attn/collect', blob)` で送る。
  - `flush()` は冪等に（同一 `anon_id` で複数回来る前提）。→ app.mjs側の受け口修正（下記P1）とセットで効く。
- **検証方法**：モバイルSafari実機／LINEアプリ内でLPを開き、途中でホームに戻る・タブ切替・アプリ切替 → collectが届くか、`active_sec`が途中値で保存されるかをapp.mjsのstore/監査ログで確認（E2E＝メインターミナル領分）。

### 【P1】collect受け口を「上書き」から「単調増加マージ」に変える
- **現象**：`sess.active_sec = d.active_sec` は上書き。P0で複数回flushすると、後から届いた小さい値（例：バックグラウンド復帰直後の途中スナップショット）が大きい値を**巻き戻す**恐れ。box_statsのactive_view/engagementも同様に上書き。
- **根拠URL（構造的根拠）**：P0の「離脱時＋復帰時に複数バッチが飛ぶ」前提から必然。MDN同上（複数回送信が正常運用）。
- **対策案**：
  - `sess.active_sec = Math.max(sess.active_sec||0, Number(d.active_sec)||0)`（単調増加）。
  - box_stats も `active_view`/`engagement`/`revisits` を `Math.max(既存, 新値)` でマージ。※engagementは既にクランプ済みなのでmax取りだけ追加。
  - あるいはSDK側に単調増加を保証させ、サーバは「最終値優先＋降下拒否」に。設計判断はDaiyaに委ねる。
- **検証方法**：collectを `active_sec:40` → `active_sec:12` の順で叩き、保存値が40のままか確認（app.mjs単体テスト）。

### 【P2】bot/クローラを collect 受け口で除外する（UA＋挙動ベース）
- **現象**：botが混ざると滞在時間・離脱因果・タグ発火が全部歪む。GA4は既定でIAB/ABC International Spiders & Bots List＋Google独自データで自動除外しているが、**素直にUAを名乗るbotしか捕まらない**（Puppeteer/Playwright等のヘッドレスは人間と同じにカウントされる）。自前計測(loku-attn.js)は現状ノーガード。
- **根拠URL（S/A）**：
  - Google Analytics ヘルプ「Known bot-traffic exclusion」（S）：IABリスト＋Google研究で自動除外 https://support.google.com/analytics/answer/9888366
  - 各解説（B→Aへ辿り済）：IABリストはヘッドレスブラウザ・AI学習botを取りこぼす
- **対策案**：
  - 第一段（安価・確実）：app.mjs collectで `User-Agent` を見て既知botパターン（bot/crawler/spider/headless/puppeteer/playwright等）を弾く軽量フィルタ。IAB相当の最小リストを内蔵。
  - 第二段（挙動）：loku-attn.js側で「スクロール0・マウス/タッチ0・全box一瞬でin」など人間離れした挙動をフラグ化し、collectに `suspect_bot:true` を付ける → app.mjsで隔離集計（本番数字から除外・監査には残す）。
  - デモ層では「除外した件数」を店主向けに見せると信頼になる（GA4は黙って消すだけ）。
- **検証方法**：既知botUAでcollectを叩き弾かれるか／`suspect_bot`付きが本番集計から外れ監査には残るかをテスト。

### 【P3】anon_idの寿命前提を「7日で失効しうる」に置き換える（ITP対策）
- **現象**：iOS Safari(ITP)は **script-writable storage（localStorage/sessionStorage/JS書き込みcookie/IndexedDB等）を、そのサイトへの最終インタラクションから7日で全削除**。loku-attn.jsがlocalStorageに `anon_id` を置くと、7日空けた再訪は**別人**扱い＝journeyが切れ、再訪タグ・「検討期間」の因果が狂う。CNAMEクロークだと1st party cookieも7日枠に落ちる。
- **根拠URL（S/A）**：
  - Didomi「Apple adds a 7-Day Cap on All Script-Writable Storage」（A・元はWebKit公式ポスト）：localStorage含む全script-writable storageが7日で削除 https://support.didomi.io/apple-adds-a-7-day-cap-on-all-script-writable-storage
  - cookiestatus.com Safari現況（A・追跡専門）https://www.cookiestatus.com/safari/
- **対策案**：
  - 設計前提を「anon_idは長くて7日で消える揮発ID」と明記。**再訪の主軸はanon_id持続に依存させず、LINE友だち結合(merge)後の `friend_id` を恒久キーにする**（現行app.mjsのidentity Mapは既にこの思想＝正しい）。
  - loku-attn.js：anon_id新規発行時に発行日を持たせ、7日超は「新セッション・別anon」と割り切る。無理な持続延命（CNAMEクローク等）は法規制リスクもあり非推奨→**見廻りへ申し送り**。
  - 店主向け数字では「初回来訪」と「7日以内の再訪」を区別して表示、それ以上前の再訪は結合後のfriend_id基準に。
- **検証方法**：現行仕様の再確認（ITPは頻繁に更新）を次回巡回で。実装はfriend_id恒久化の設計レビュー（メインターミナル）。

## 実装照合（2026-07-13・メインターミナルが落とし込み済み）

| 種 | 実装状況 |
|---|---|
| **P0 離脱時フラッシュ** | ✅ `index.html` SDK雛形に実装（visibilitychange(hidden)主＋pagehideフォールバック・sendBeacon・800ms間引き・`FLUSH_ENDPOINT`は本番で設定＝デモはnull）。**実機検証（LINE内/モバイルSafari）は1スタジオ目の本番化時**＝watchlist「LINE内WKWebViewライフサイクル」の白待ちと同期 |
| **P1 単調増加マージ** | ✅ `app.mjs` collect：`active_sec`/box_statsの`active_view`/`engagement`/`revisits`全てmaxマージ。QA群36（因果診断への波及なしまで検証） |
| **P2 bot除外** | ✅ 二段実装：UA入口除外（`BOT_UA_RE`・Googlebot型の前方連結UAも捕捉）＋`suspect_bot`挙動フラグ（タグ発火なし・実名導線に乗せない隔離）。**黙って消さず`GET /api/attn/bot-report`で件数可視化**（種の「店主への信頼」提案を採用）。QA群37 |
| **P3 anon_id 7日揮発** | ✅ `index.html` SDK雛形：`getAnonId()`がTTL7日で発行日管理・超過は別anon割り切り。恒久キー=friend_id（既存identity設計のまま）。CNAMEクローク延命は不採用（見廻り申し送りどおり） |
| **参考 広告ブロッカー** | ✅ ノーアクション（種の判断どおり） |

QA: `node test.mjs 50` → **pass=33,800 / fail=0**・セクションF（群36–38）新設・A〜Eは前回と完全一致＝既存無影響。詳細は `qa-report.html` 実行履歴#11。

---

### 【参考・低優先】広告ブロッカーは主戦場（LINE内ブラウザ）では影響小＝現行のまま可
- **現象**：懸念していた「広告ブロッカーによる計測スクリプト遮断」は、主戦場のLINEアプリ内ブラウザ（WKWebView）では**コンテンツブロッカー拡張が効かない**ため、実質的に無視できる。SafariのSFSafariViewController経由だと効くが、LINEは自前WKWebViewが主。
- **根拠URL（S/A）**：Apple Developer / 技術解説（A）：Content Blocker拡張はSafari本体・SFSafariViewControllerでのみ機能。WKWebViewには適用されない https://developer.apple.com/documentation/safariservices/creating-a-content-blocker
- **対策案**：現状ノーアクションでよい。ただし外部トラフィック（純Safari直踏み）向けには、計測ドメインを1st party相当に寄せると遮断リストに載りにくい（P3のCNAMEとは別問題・法規制は見廻り確認）。
- **検証方法**：次回巡回で日本モバイルの遮断率実測レポートを継続捜索（現状S/Aの数字は未取得＝watchlist継続）。
- **更新（2026-07-14・目付第3回）**：日本モバイル限定の公開実数は**存在しない**ことを確定（全体21%＝Insider Intelligence／GWI「利用率20%未満の3か国」が最新到達点）。本項目はwatchlistをクローズ・優先度を下げる。主戦場LINE内WKWebViewでは影響小の結論は不変。

- **【2026-08-10 追記＝第24回巡回・持ち越し宿題を決着／新種P番号は起こさない・この参考節への追加観点＝“維持すべき現行の良い設計”のガード】ファーストパーティ耐性という“第2レイヤー”を確定＝広告ブロッカーの影響は主戦場で三重に減衰**：
  - **現象①（ドメイン照合が土台）**：EasyList/EasyPrivacy は `google-analytics.com`／`googletagmanager.com`／`connect.facebook.net` 等の**既知トラッカーの“ドメイン／URLパターン”を列挙してページ描画前にキャンセル**する仕組み（EasyList公式リポジトリ＝S一次）。＝**弾く対象は“識別できる第三者ドメイン”**。
  - **現象②（ファーストパーティは網外・公式が裏書き）**：Plausible公式Docs＝素の（第三者）設定で取りこぼしは「audienceにより概ね**5〜25%**」、自ドメイン経由（＝ファーストパーティ）にすると「**自サイトからの要求と見分けがつかず大半のブロッカーを回避**」。Umami公式も同型（自ドメインでプロキシしスクリプト名/場所を隠す）。＝**2大OSS計測がS一次で“ファーストパーティ配信が広告ブロッカー対策の本丸”と明記**。
  - **現物との突き合わせ**：Lokuの計測は `index.html` の**インライン `<script>`（本番は同一オリジン配信の loku-attn.js）＋送信先は同一オリジンの `FLUSH_ENDPOINT='/api/attn/collect'`**（現物 464・469-473行）＝**外部トラッカードメインを一切呼ばない＝EasyListのドメイン照合に構造的に非該当**。つまり**Plausible/Umamiが“プロキシ対策後”に到達する状態を最初から満たしている**＝公式の「素で5〜25%取りこぼし」の天井は**サードパーティ前提でありLokuには当たらない**。上の対策案（線79「1st party相当に寄せる」）は**既に達成済み**と確定＝第18回以来の持ち越し宿題を「率でなく3層減衰の構造結論」で決着（①ドメイン網外②ファーストパーティで大半回避③WKWebView無効＋日本21%）。
  - **根拠URL（S/A）**：EasyList公式リポジトリ（フィルタ構文＝ドメイン/URL/要素ルール・S一次） https://github.com/easylist/easylist ／ Plausible公式Docs「Bypass adblockers with a proxy」 https://plausible.io/docs/proxy/introduction ・「Do ad blockers block Plausible?」 https://plausible.io/blog/do-ad-blockers-block-plausible-analytics ／ Umami公式Docs「Bypass ad blockers」 https://docs.umami.is/docs/bypass-ad-blockers ／ 補強：cometly https://www.cometly.com/post/ad-blockers-affecting-tracking （A/B→traced）。
  - **残る唯一の穴＝“パス／ペイロード形状／挙動”での照合**：ブロッカーはドメインだけでなく**リクエストの“パス”やスクリプトの“中身”（見覚えのあるエンドポイント形・グローバル名）**でも弾け、さらに**ヒューリスティック検知**が最前線（cometly＝A/B→traced）。＝`/api/attn/collect` は今は網外だが、EasyListは**4人の有志＋フォーラムのcommunity運営でルール追加が予測しづらい**（digiday/EasyList公式）＝将来リスト化されれば刺さりうる。
  - **対策案＝“維持すべき現行設計”のガード観点（コードは触らない・採否と実装はDaiya／メイン領分・新種P番号は起こさない）**：(a) 本番の loku-attn.js は**必ず自オリジン配信を維持**しサードパーティCDNから配らない（＝ドメイン網外の維持）。(b) collectの**パス名とペイロードのキー名を“いかにもトラッカー”な形**（`/track`・`/collect?tid=`・`ga`/`pixel`/`gtag` 等）に寄せない（現状 `/api/attn/collect`＋`anon_id`/`box_key` は比較的無難だが“attn/collect”は目立つ語＝将来フィルタ化の監視対象）。(c) **“自店のcollectパスがフィルタリストに載っていないか”を常時監視**の対象に置く。※**CNAMEクローク等の無理な延命はしない（法規制は見廻り確認・線79のCNAMEとは別問題）**。
  - **検証方法**：本番のLoku実データで「特定ブラウザ/UAの客だけ来訪が薄い」偏りが出たら**パス/形状のフィルタ化を疑う**切り分け（メイン領分）。日本全体21%（GWI/WARC・B→traced＝2026再確認）はモバイル限定の精密値が取れずとも**①②③で結論（影響小）が率の高低に依存しない**ため、精密化の優先度は下げてよい＝広告ブロッカーwatchlistは実質クローズ・パスのフィルタ化を常時監視へ移行。
  - **優先度**：低（現状ノーアクションでよい＝“既に本丸を満たしている”を確定できたのが今回の収穫）。ただし(a)(b)(c)は**新種を起こさず“維持すべき現行の良い設計”として記録**＝将来の本番実装で崩さないためのガード観点。

---

## 追加の種（2026-07-14・目付第3回巡回からの還流）

**前提**：以下は上の「実装照合」表（P0-P3・実装済み）とは**重複しない新規/更新**。P5は新規の実装検討種、AFP補遺はP3の前提更新（追加実装は不要な想定だが記録）。

### 【P5】広告→LP起源の紐付けを「クリックID非依存」に設計する（Safari/iOS 26 Link Tracking Protection対策）
- **現象**：Apple が iOS/Safari 26 で **Link Tracking Protection** を全ブラウジングへ拡大する方向。クリック時にURLの**クリックID（gclid/fbclid/msclkid）がページ読込前に剥がされる**（例えると：玄関に入る前に、封筒に印字された「どのチラシから来たか」の追跡番号を配達員が消してしまう）。着地ページ側がクリックIDを読んで保存する link decoration 方式の起源判定が壊れうる。
  - **重要な但し書き**：①**utm_source/medium/campaign 等のUTMは対象外で残る**（個人特定しない集計メタデータ扱い）。②通常ブラウジングでのクリックID既定剥がしは**2026年7月時点で段階的**（STPでは既に gclid が剥がれる／正式Safari通常モードは beta で「まだ素通り」報告が混在）。③主戦場の **LINE内WKWebView に及ぶかは未確認**（コンテンツブロッカー同様、及ばない公算だが要確認＝watchlist）。直撃するのは純Safari直踏み流入。
- **根拠URL（一次はwebkit.org・403で直踏み不可／複数の実装者・計測エージェンシー報告で裏取り・Apple WWDC25/Safari 26発表と整合）**：
  - WITHIN「iOS 26 Link Tracking Protection Explained」（B→traced）https://www.within.co/blog/ios-26
  - ppc.land「Safari 26 tracking changes to impact marketing measurement」（B→traced）https://ppc.land/safari-26-tracking-changes-to-impact-marketing-measurement/
  - WebKit一次（参照先・403）https://webkit.org/tracking-prevention/
- **対策案**：
  - loku-attn.js / app.mjs が起源判定に**クリックID（gclid/fbclid）を使っているか棚卸し**。使っているなら、**着地の最初のヒットで起源情報（UTM＋あればクリックID＋referrer）をサーバサイドで即時保存**する方式へ寄せる（クライアント側でURLに残り続ける前提を捨てる）。
  - クリックIDは「**あれば使う・無くても壊れない**」フォールバック設計に。恒久の起源キーは UTM＋friend_id結合側に持たせる。
  - 純Safari直踏み以外（LINE内WKWebView）への適用有無を確認するまでは、主戦場への影響は「小」と仮置き。設計採否・優先度の判断はDaiyaに委ねる。
- **検証方法**：`?gclid=TEST&utm_source=x` 付きURLを **Safari 26 実機 / Safari Technology Preview** で開き、着地ページのJSで各パラメータが読めるか・app.mjs collectに届くかをE2Eで確認（メインターミナル領分）。LINE内WKWebViewでも同URLを開いて剥がれないことを確認。
- **優先度**：**P5**（将来・純Safari流入向け。主戦場LINE内WKWebViewは影響小の公算だが要確認）。ITPがP3を生んだのと同じ因果でLTPがP5を生んだ関係。

### 【P3 補遺】Safari 26 AFP デフォルトON——認定スクリプトのストレージ24時間床＋フィンガープリント信号の遮断
- **現象**：Safari 17で任意ONだった **Advanced Fingerprinting Protection（AFP）** が **Safari 26（2026年）でデフォルトON**に昇格。「既知のフィンガープリント（＝端末の細かな個性で個人特定する手法）スクリプト」に対し、**canvas描画・画面サイズ・`hardwareConcurrency`（CPUコア数）・オーディオバッファ等のAPIアクセスを制限**し、**認定スクリプトの長期ストレージ設定を封じ、非対話ストレージを24時間で失効**させる。これは全サイト共通のITP 7日ルールとは別レイヤーの、より厳しい"認定された追跡屋向け"措置。
- **根拠URL（一次はwebkit.org・403／複数実装者報告で裏取り）**：
  - Billy Grace（Medium）「Safari on macOS & iOS 26 Tracking changes」（B→traced）https://medium.com/billy-grace/safari-on-macos-ios-26-tracking-changes-whats-really-changing-31e2d26cb727
  - taggrs.io「Safari 26 tracking changes explained」（B→traced）https://taggrs.io/safari-26-tracking-changes/
  - WebKit一次（参照先・403）https://webkit.org/tracking-prevention/
- **対策案（追加実装は不要な想定・前提の明文化）**：
  - **P3の設計（恒久キー＝friend_id・anon_id持続に再訪判定を依存させない）は既にこの脅威をカバー済み**。追加実装は原則不要。
  - ただし前提として「**loku-attn.js はデバイスの個性（画面サイズ・canvas・CPUコア数）を識別信号に流用しない**」を明文化。将来これらをデバイス識別に使うと、AFP環境で同一端末が別人化し再訪判定が狂う。
  - P3の「anon_idは長くて7日で揮発」に「**追跡スクリプトと認定された場合は床が24時間まで下がりうる**」但し書きを追加。
- **検証方法**：（実装変更を伴わないため）次回巡回でAFPの認定基準（loku-attn.jsが認定されうるか）の一次仕様を継続確認。実機ではSafari 26でlocalStorageのanon_idが24時間/7日どちらの寿命になるかを観察（メインターミナル領分）。
- **優先度**：**P3補遺**（設計前提の更新・追加実装は想定せず。判断はDaiya）。

---

## 前提の訂正・拡張（2026-07-15・目付第4回巡回からの還流）

**前提**：以下は**新規P番号を起こさない**。既存の P3（実装済み）・P5（未実装種）・P3補遺（AFP）の**脅威範囲の訂正／適用範囲の格上げ／技術詳細の追加**。実装照合表（P0-P3済み）とは重複させない。コードは触っていない。

### 【P3 前提訂正】ITPは全WKWebViewでデフォルトON＝主戦場LINE内ブラウザにも7日削除が効く（前回見立ての訂正）
- **現象（訂正点）**：前回（07-14）P5・watchlistで「Safari機能はLINE内WKWebViewに及ばない公算（content blocker同様）」と仮置きしたが、これは**誤り**。ITP（Intelligent Tracking Prevention）は **iOS 14 以降、すべての WKWebView アプリでデフォルトON**。アプリ側は自分で無効化できず、解除できるのはユーザーだけ（Info.plistに `NSCrossWebsiteTrackingUsageDescription` を足すとユーザー向け解除トグルが出るが、アプリが勝手にオフにはできない）。**content blocker（Safari拡張の広告ブロッカー）がWKWebViewに効かないのは事実だが、ITPはそれとは別の仕組みで標準搭載**——ここを混同したのが誤りの原因。
- **根拠URL（一次＝Apple/WebKit）**：
  - Apple WWDC20「Discover WKWebView enhancements」（S・一次／WebKitエンジニア John Wilander が「ITP is enabled by default in all WKWebView apps. Apps can't disable it on their own but users can」と明言）https://developer.apple.com/videos/play/wwdc2020/10188/
  - WebKit「App-Bound Domains」（S・一次／「iOS 14.0 / macOS Big Sur で ITP は全WKWebViewアプリでデフォルトON」）https://webkit.org/blog/10882/app-bound-domains/
  - Simo Ahava「ITP in iOS 14」（A・実装者一次）https://www.simoahava.com/privacy/intelligent-tracking-prevention-ios-14-ipados-14-safari-14/
- **含意（追加実装は不要）**：P3の脅威範囲は「純Safari直踏み流入」ではなく**主戦場LINE内WKWebViewど真ん中**。script-writable storage（localStorage含む）の7日削除が主戦場でも起きる。**既存の friend_id 恒久キー設計は既にこれをカバー済み＝設計は正解だった**。追加実装は原則不要だが、**リスク説明・ドキュメントの「どこに効くか」を主戦場基準に書き換える**必要がある（店主向けに「7日以内再訪／それ以上前は結合後friend_id基準」を主戦場前提で説明）。
- **検証方法**：実機（Safari 26 / LINE内WKWebView）で localStorage の anon_id が最終操作から7日で消えるかを観察（メインターミナル領分・1スタジオ目本番化時）。

### 【P5 適用範囲の格上げ】LTP（クリックID剥がし）もアプリ内ブラウザに及ぶ濃厚＝主戦場でも要る
- **現象（格上げ点）**：Link Tracking Protection の適用範囲について、複数の独立実装者・計測エージェンシー報告が揃って「**in-app browser（アプリ内ブラウザ・例：Instagram内ブラウザ）でリンクを開くとクリックID（gclid/fbclid/msclkid）が剥がれる**」と一致。上記でITPがLINE内WKWebViewに標準で効くと一次確認できた以上、「Safari機能はWKWebViewに及ばない」という前回の前提は崩れ、**LTPがLINEのLIFF（自前WKWebView）にも及ぶ公算は前回想定より明確に高い**。よって前回P5に付けた「主戦場LINE内WKWebViewは影響小の公算」の但し書きを**撤回し「主戦場でも要る」に格上げ**。UTMは引き続き無傷。
- **根拠URL（一次webkit.org 403・複数実装者報告で裏取り）**：
  - WITHIN「iOS 26 Link Tracking Protection Explained」（B→traced・in-app browserでの剥がしを明記）https://www.within.co/blog/ios-26/
  - Singular「iOS 26 privacy」（B→traced）https://www.singular.net/blog/ios-26-wwdc-privacy/
  - Opensend「iOS 26 & Click IDs」（B→traced）https://www.opensend.com/post/ios-26-survival-kit
  - WebKit一次（参照先・403）https://webkit.org/tracking-prevention/
- **対策案（P5本体は不変・優先度のみ格上げ）**：P5の「着地の最初のヒットでUTM＋referrer＋（あれば）クリックIDをサーバサイド即時保存／クリックIDは無くても壊れないフォールバック」を、**純Safari流入向けではなく主戦場向けの標準設計**として優先度を上げる。設計採否・優先度の最終判断はDaiya。
- **検証方法（追加）**：前回の「Safari 26/STPで gclid付きURLを開く」に加え、**LINE内WKWebViewで同URLを開き、着地JSでクリックIDが読めるか／document.referrer が取れるか**を実機E2Eで確認（メインターミナル領分）。
- **格付け注記**：ITP適用＝**S（確定）**／LTPのWKWebView適用＝**A（濃厚・一次webkit.org待ち）**と格を分けて扱う。

### 【P3補遺 拡張】AFP認定スクリプトは document.referrer とURLクエリ読み取りも失う＝P3とP5を同時破壊
- **現象（追加詳細）**：Safari 26 AFPが認定スクリプトに課す制限に、前回把握分（canvas/画面/CPUコア数のノイズ注入＋非対話ストレージ24時間床）に加えて、**「script access to URL query parameters and document.referrer（URLクエリ文字列と参照元の読み取り）の制限」**が含まれることが判明。ナビゲーション追跡（どこから来たか）のURL経由相関を防ぐ措置。
- **根拠URL（一次webkit.org 403・複数実装者/批評筋で裏取り）**：
  - taggrs.io「Safari 26 tracking changes explained」（B→traced）https://taggrs.io/safari-26-tracking-changes/
  - lapcatsoftware「AFP: a confusing feature」（A・批評/実装者・認定ロジックの不透明性を指摘）https://lapcatsoftware.com/articles/2025/9/4.html
- **含意**：もし loku-attn.js が“追跡スクリプト”と**認定されると、ストレージ（P3）だけでなく起源判定の入力（referrer・URLパラメータ＝P5）まで一度に失う**。つまり**「認定されない設計に留める（＝端末個性を識別信号に使わない・フィンガープリント的挙動を避ける）」こと自体が、P3（再訪判定）とP5（起源判定）を同時に守る単一条件**。P3補遺の「デバイス個性を識別に使わない」明文化に、この二重防御の理由を追記する意味づけ。
- **検証方法**：AFP認定時に referrer/URLパラメータが消える前提の縮退テスト（auth/起源判定が referrer 単独依存で壊れないか）。認定基準の一次仕様は webkit.org 403のため次回も継続確認（実機観察が最短）。
- **優先度**：**P3補遺の拡張**（追加実装は原則不要・設計前提の明文化。判断はDaiya）。

---

## 追加の種（2026-07-16・目付第5回巡回からの還流）

**前提**：Safari privacy 3連戦から意図的にテーマ転換し、ビート2（OSS計測＝Plausible v3.0）から拾った。以下は実装照合表（P0-P3済み）・P5・P3補遺(AFP)とは**重複しない**。新規種P6＋P0の設計判断の裏書き。コードは触っていない。

### 【P6・新規種】エンゲージメントイベントに「到達最大スクロール深度（max_scroll_pct）」を第一級シグナルとして加える
- **現象**：軽量OSS計測 Plausible が v3.0（2026）で計測モデルを刷新し、トラッカーが「エンゲージメントイベント」に**「到達した最大スクロール深度（<code>sd</code>）」と「実際に読んでいた時間（<code>e</code>）」**を載せ、time-on-page をこのイベント基準に作り直した。到達最大スクロール深度は「**ページのどこまで下まで到達したか**」＝離脱ポイントの手がかり（例えると：チラシを"どの段落まで目を通して"ゴミ箱に入れたか）。
  - **現物確認（目付が目視）**：`index.html` の `tick()` は `window.scrollY` を**「スクロール"速度"（vel = |y-lastY|/TICK）＝読んでいる/流し読みの判定ゲート」にしか使っておらず**、per-box の engagement/activeView/revisits（＝中央ゾーンで足を止めた箱）は測るが、**「そのセッションで到達した最大スクロール%」を明示的な指標として保持していない**。＝Plausibleが持つ `sd` はLoku現物に無い本物の抜け（重複ではない）。
  - **なぜ per-box では代替できないか**：per-boxのengagementは「中央ゾーンに入って足を止めた箱」を測る＝**"止まった場所"**。max_scroll_pctは**"止まらず通過も含めてどこまで到達したか"**。両方あると「料金表まで到達したが止まらず離脱」と「冒頭で離脱（料金表に未到達）」が区別できる。
- **根拠URL（GitHub公開＝一次・A）**：
  - Plausible Analytics v3.0.0 リリースノート（A・GitHub Discussion #5318／`sd`・`e`・time-on-page刷新を明記）https://github.com/plausible/analytics/discussions/5318
  - Release v3.0.0 https://github.com/plausible/analytics/releases/tag/v3.0.0
  - 参照（403・検索/GitHub経由で内容確認）: https://plausible.io/docs/scroll-depth
- **対策案**：
  - loku-attn.js に「そのセッションで到達した最大スクロール%」を保持する軽量な状態を追加（`maxScrollPct = Math.max(maxScrollPct, (scrollY + innerHeight) / documentHeight * 100)` をscrollハンドラ内で更新）。既存のscroll速度計算に相乗り可＝追加コスト極小。
  - flush（P0の離脱時送信）／定期送信の payload に `max_scroll_pct` を1フィールド追加。app.mjs collect側は単調増加マージ（P1と同じ `Math.max` 方針）で受ける＝**P1のmaxマージ設計にそのまま乗る**（受け口の新規ロジック不要）。
  - 店主向けには「見込み客が平均どこまで読んで離脱したか（例：料金表の手前で60%到達で離脱が多い）」をLP改善の当て所として提示。設計採否・優先度の判断はDaiyaに委ねる。
- **検証方法**：①スクロール不要の短いページ ②一気に最下部までスクロール ③途中で離脱 の3パターンで `max_scroll_pct` が正しく（0でなく到達値で）保存されるか。Plausibleは"スクロールしない短いページで深度が欠落する"境界を実際に踏んでいる（PR #4979）ので、そこを重点に（QA＝メインターミナル領分）。
- **優先度**：**P6**（将来・店主向けLP改善の当て所。P0/P1の既存機構に相乗りで実装コスト小。判断はDaiya）。

### 【P0 裏書き】離脱時送信は sendBeacon 主を維持する（fetch keepalive へ安易に乗り換えない）
- **現象**：上のPlausible v3.0は送信を **XMLHttpRequest → `fetch` の `keepalive` フラグ付き**に既定変更し「より確実」と説明。ただし**「より確実」は"XHRより"であって"sendBeaconより"ではない**（比較対象のすり替えに注意）。
- **根拠URL（S＋実装者A）**：
  - MDN Navigator.sendBeacon（S）：「離脱時の計測送信は **sendBeacon が目的専用で最も確実**。POST以外・カスタムヘッダ・応答取得が必要な時のみ fetch(keepalive) を使う」 https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon
  - Adwait Bokade（A・実装者失敗報告）：**高遅延地域で fetch(keepalive) の計測イベントが欠落**した実運用報告 https://www.adwait.me/writings/broke-my-analytics-events-in-high-latency-regions
  - sendBeacon vs fetch keepalive 比較（B・同64KB合計上限を共有）https://blog.zackhu.com/navigatorsendbeacon-vs-fetch-keepalive
- **含意（実装変更なし・P0の設計判断の確認）**：
  - **P0が sendBeacon を主に据えている選択は正しい**。Plausibleがkeepaliveを選んだのは「応答を読む・カスタム挙動」が必要だったためで、Lokuの離脱時beacon（撃ちっぱなしでよい）には当てはまらない。とくに**主戦場Safari/LINE内WKWebViewはsendBeaconが確実側**。
  - **新しい送信APIの登場が旧定石(sendBeacon)の正しさを再確認するのは3回目**（第1回sendBeacon→第2回fetchLater→今回fetch keepalive）。柔軟性（応答で分岐する等）が本当に要る場面が出た時だけ fetch(keepalive) を局所検討。
- **検証方法**：（実装変更を伴わない）P0の回帰確認時に sendBeacon 経路が維持されているかを見るのみ。fetch keepalive を採る場合は主戦場LINE内WKWebViewの実機で離脱時欠落率を実測（メインターミナル領分）。
- **優先度**：**P0の裏書き**（新規実装なし・設計判断の確認。判断はDaiya）。

---

## 追加の種（2026-07-18・目付第6回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済み）・P5・P3補遺(AFP)・P6（前回07-16のmax_scroll_pct）とは**重複しない新規種P7**。テーマは「ページのライフサイクルの“もう半分”＝bfcache（戻る/進むで生き返るページ）」。P0が離脱（入場）を締める一方、その**裏返しの復帰（退場）が未ハンドル**だと分かった。**コードは触っていない。**

### 【P7・新規種】bfcache（戻る/進むキャッシュ）復帰時に「新ビュー計上＋per-viewカウンタのリセット」を入れる
- **現象**：ブラウザは離脱するページを破棄せず**丸ごと“冷凍”してメモリに保管（bfcache）**し、ユーザーが「戻る/進む」を押すと**再読み込みせず瞬時に解凍して復帰**させる（例えると：退店客を追い出さず“一時停止”で控室に寝かせ、戻ったら同じ姿勢で起こす）。**iOS Safari と主戦場のLINE内WKWebViewを含むモバイルで多用**され、「戻る」は最も多いナビゲーション。ここで問題が2つ：
  - **復帰時に `load`/`DOMContentLoaded` は再発火しない**（冷凍・解凍＝“新しい読み込み”ではない）。代わりに `pageshow` が発火し、その `event.persisted===true` が「bfcacheから生き返った」合図。**現物 loku-attn.js（index.html内SDK雛形）を grep したところ、P0の離脱時flush（`visibilitychange`(hidden)＋`pagehide`＋sendBeacon）は実装済み＝bfcacheに“入る”瞬間は正しく発火するが、`pageshow`/`event.persisted` は一切ハンドルしていない＝“戻ってくる”瞬間が完全に無反応**（出口に番人・入口は無人）。
  - 復帰時に何もしないと、(1)「戻って見直した」再訪が**丸ごと未計測**、(2)冷凍前の古いカウンタ（active_sec・per-boxエンゲージメント・到達スクロール深度=P6のmax_scroll_pct）が**そのまま復帰して二重計上/混線**。
- **根拠URL（機構＝S・実装者実例＝A）**：
  - web.dev「Back/forward cache」（S・Google公式／pageshow・event.persisted・冷凍解凍でload非発火・pagehideでの締めを規定・403のため検索経由で内容確認）https://web.dev/articles/bfcache
  - MDN `pageshow` event（S・persistedの意味）https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event
  - **Plausible Analytics PR #5082「Fix bug: bfcache pageviews not firing」（A・GitHub一次／2025-02-19 merge）**：SPA用の重複防止ガード（`if (lastPage === location.pathname) return;`）が、bfcache復帰のpageviewまで巻き込んで握り潰していたバグを修正。実在のまともな計測ライブラリが踏んだ同型の穴。https://github.com/plausible/analytics/pull/5082
- **対策案**：
  - loku-attn.js に `window.addEventListener('pageshow', function(e){ if(e.persisted){ /* 新ビュー開始 */ } })` を追加。復帰時に**新しい session/view_id を切り替え、per-viewカウンタ（active_sec・エンゲージメント・max_scroll_pct）を0にリセット**し、必要なら**復帰ping**を送る。
  - **既存の重複防止ロジックがあるなら、それがbfcache復帰を握り潰さないか要確認**（Plausibleが踏んだのはまさにこれ）。SPA判定と復帰判定を切り分ける。
  - P0（bfcache入場時のflush）と**対**で設計＝「出口で締め、入口で数え直す」。ページのライフサイクルの両端を塞ぐ。view境界の持ち方（session_id刷新かview連番か）・採否の判断はDaiyaに委ねる。
- **検証方法**：LP→別ページ→「戻る」でbfcache復帰した時に ①新ビューが1件計上されるか ②active_sec/エンゲージメント/max_scroll_pctが“0から”再カウントされ冷凍前値を持ち越さないか ③復帰pingがP1（単調増加マージ）と衝突して過去ビューの値を巻き戻さないか（＝view境界の切替が要る可能性）を実機E2Eで確認（メインターミナル領分・1スタジオ目本番化時。LINE内WKWebViewのライフサイクル実機検証＝P0の宿題と同じタイミングで一緒に検証可）。
- **優先度**：**P7**（主戦場のLINE内/iOS Safariはbfcache多用＝“戻って見直す”成約直前の往復が測れるかに直結。判断はDaiya）。

---

## 追加の種（2026-07-22・目付第7回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5・P3補遺(AFP)・P6（max_scroll_pct）・P7（bfcache復帰）とは**重複しない新規種P8**。テーマは「ページのライフサイクルの残る一角＝先読み（prerender／Speculation Rules）」。P0が離脱（出口）、P7が復帰＝戻る（戻る入口）を塞ぐのに対し、**P8は正面の入口が“人より先に開く”＝先読み**への対応。**コードは触っていない。**

### 【P8・新規種】先読み（prerender／Speculation Rules）に対応し、初期化を「活性化（activation）まで」遅らせる
- **現象**：ブラウザは「ユーザーは次にこのリンクを押しそう」と推測し、**まだ押されていないページを裏で丸ごと読み込んで待機**させる（prerender／Speculation Rules。例えると：来店しそうな客を見越して来店前に個室をセットし照明まで点けておく）。先読みページのJSは“先に”実行されるため、不用意な計測は**実際には見られていないページを「訪問」として数える＝幽霊ページビュー**を生む。**GA4は既定で活性化まで遅延して守るが、Metaピクセルや自前計測は既定では守らない**ものが多い。
  - **現物確認（目付がgrep）**：`index.html` の loku-attn.js 雛形は、`getAnonId()`（匿名ID発行・localStorageの`at`=最終操作時刻を更新／460行）と `tick()`（200ms計測ループ起動／490行）を**読み込み時に無条件で実行**。`document.prerendering` の分岐は無い。
  - **ただし既に堅い部分（重要）**：滞在秒を積むゲートが `(document.visibilityState==='visible') && hasFocus`（346・381行）＝**先読み中は visibilityState が 'hidden' 扱いなので active_sec もエンゲージメントも積まれない＝“滞在の水増し”という最悪の幽霊は既に防げている**（4ゲート設計の副次的な当たり）。素のGA4/ピクセル設定より一段堅い。
  - **残る穴は2つに絞られる**：(1) 先読みだけで `getAnonId()` が走り、**匿名IDの7日ITPタイマー（P3）が“来ていない訪問”でリセット/更新**される（`at`を現在時刻で書き戻すため）。(2) tickの時計・`sessionId` が**活性化時ではなく先読み時に基準を取る**ため、後で実際に開いたときのアイドル判定・ビュー境界がずれうる。
- **根拠URL（機構＝S・実装者/実例＝A/B）**：
  - Chrome for Developers「Prerender pages」（S・Google公式／`document.prerendering`・`prerenderingchange`・GA4は活性化まで遅延を規定・403のため検索経由で内容確認）https://developer.chrome.com/docs/web-platform/prerender-pages
  - MDN `Document.prerendering`（S・先読み中は visibilityState='hidden'）https://developer.mozilla.org/en-US/docs/Web/API/Document/prerendering
  - Erwin Hofman「Prevent skewed analytics when using Speculation Rules」（A・実装者／自前計測の防御パターン・403のため検索経由）https://www.erwinhofman.com/blog/prevent-skewed-analytics-when-using-speculation-rules/
  - Seresa「WordPress 6.8 Speculative Loading Fires GA4 Phantom Visits」（B・実測：ホバーで1訪問者最大9ピクセルビュー・修正後ページビュー約40%減）https://seresa.io/blog/wordpress-tracking/wordpress-6-8-speculative-loading-is-firing-ga4-and-meta-pixel-ghost-visits
- **対策案**：
  - loku-attn.js の初期化（`getAnonId()`・`tick()`起動・`sessionId`確定）を**「先読み中なら活性化まで待つ」**に変える：
    `if (document.prerendering){ document.addEventListener('prerenderingchange', start, {once:true}); } else { start(); }`
    ——`start()` に匿名ID発行・tick起動・sessionId確定をまとめ、**人が実際に開いた瞬間（活性化）に初めて計測を起こす**。
  - **匿名IDの発行/更新（`at`書き戻し）を活性化後に限定**することで、先読みだけで7日タイマー（P3）が動くのを止める。
  - P0（離脱で締め）・P7（戻るで数え直し）・P8（先読みは活性化まで待つ）で**ページの一生の“出口・戻る入口・正面入口”を全部塞ぐ**。採否・優先度の判断はDaiyaに委ねる。
- **検証方法**：Speculation Rules（`<script type="speculationrules">`のprerender）でLPを先読みさせ、①**未活性化のまま破棄した先読み**が匿名ID/計測に混ざらないか、②**活性化した時**に匿名IDの発行・tickの起点・sessionIdが“活性化の瞬間”を基準に正しく取り直されるか、③可視ゲートで active_sec が先読み中に積まれていないこと（現状の堅さの回帰確認）をE2Eで確認（メインターミナル領分）。※**主戦場のiOS/LINE内WKWebViewは先読みが“実装ありだが既定オフ”＝現状の露出は小**。露出はChrome/Android/PC流入側。
- **優先度**：**P8（低〜中）**——防御的・将来/Chromium流入向け・実装コスト小（既存initを活性化ガードで包むだけ）。可視ゲートで最悪の水増しは既に防げているため緊急ではないが、P3の7日タイマー精度とライフサイクル完結性のために安く正しい。**bfcache(P7)＝数え漏らし(過少)／prerender(P8)＝数えすぎ(過剰)の“取りこぼしの向きが逆の一対”**で、両方塞いで「1ロード＝1人の訪問」の等号を両側から守る。判断はDaiya。

---

## 追加の種（2026-07-23・目付第8回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5（起源クリックID非依存）・P3補遺(AFP)・P6（max_scroll_pct）・P7（bfcache復帰）・P8（先読み）とは**重複しない新規種P9**。テーマはライフサイクル（いつ数えるか）でも起源（何を測るか）でもなく、**アイデンティティ・スティッチング＝「誰の来訪として貼り合わせるか」**。ライフサイクル3点(P0/P7/P8)が完成したので鉄則どおりライフサイクル以外の鉱脈へ振り、ビート2（PostHogの帰属/identity resolution）から入って app.mjs の**結合(merge)層**の抜けに当たった。**コードは触っていない。**

### 【P9・新規種】結合(merge)を“per-匿名ID”から“per-人（複数匿名IDの束ね）”へ広げ、辿れない範囲は店主に正直にラベリングする
- **現象**：来訪の断片を「同じ一人」と貼り合わせるのが identity stitching（例えると：マスクや帽子を替えて来ても“同じ常連さん”と気づいてカルテを1冊にまとめる見分け）。計測で最も数字を狂わせる工程。
  - **現物確認①（当たり・目付がgrep）**：`POST /api/attn/merge`（LINE友だち追加のLIFFコールバック／app.mjs 324-357行）は、`store.identity.set(anon_id → {friend_id, consented})` で結合した直後、**`for (const f of store.tag_fires) if (f.session_anon === d.anon_id) f.friend_id = d.friend_id;`（350行）で、その匿名IDの過去タグに friend_id を後埋め**している。＝競合PostHogが identify 時に「名乗る前の匿名イベントを本人へ遡及付け替え（override＋background squash で person_id 書き換え）」するのと**同型の遡及を、Lokuも単一匿名IDについては実装済み＝ここは設計の当たり・追加不要**。
  - **現物確認②（残る抜け＝P9）**：結合は `session_anon === d.anon_id`、つまり**友だち追加の瞬間に手元にある「たった1個の匿名ID」しか結ばない**。ところが**P3（既確定）のとおり iOS Safari/LINE内WKWebView の匿名IDは最終操作から7日で揮発**（AFP認定なら24時間）＝「3週間かけて4回LPを見て、やっと友だち追加した」見込み客は**各来訪ごとに別の匿名ID**を持ちうる。別端末（スマホ→PC）でも割れる。結果、**友だち追加“直前”の1個だけが結ばれ、それ以前の“迷っていた複数回”は孤児(orphan)化して friend_id に付かない**。identity Map（`anon_id → {friend_id}`）にも匿名ID同士を束ねる逆引きは無い。
- **根拠URL（機構＝A/S・現物＝目付grep・業界裏取り＝B→traced＋学術）**：
  - PostHog「Identity resolution」（A(仮)／匿名IDチェーンの merge＋override＋background squash で person_id を遡及付け替え・merge は不可逆。403のため検索経由で内容確認）https://posthog.com/docs/product-analytics/identity-resolution
  - PostHog「first & last touch attribution」（A／Initial UTM Source 等の初期値を person に保持）https://posthog.com/tutorials/first-last-touch-attribution
  - Datafly Signal「ITP: why your 7-day cookies are breaking attribution」（B→traced／IDが7日でリセット→分断ジャーニー・返訪を新規客に誤カウント）https://www.dataflysignal.com/blog/itp-7-day-cookies-and-how-to-fix-them
  - Ingest Labs「First-Party Data Strategy under Safari ITP」（B→traced／サーバセット1stパーティCookieはSafariに信頼され存続＝ただし法規制/同意は要確認）https://ingestlabs.com/first-party-data-strategy-trends-tips/
  - arXiv「The Identity Fragmentation Bias」（学術／IDの分裂が因果・帰属推定を系統的に歪めることを実証）https://arxiv.org/pdf/2008.12849
  - 前提: 匿名ID7日揮発＝**P3（既確定・S）**／現物: loku-tuning-plugin/handoff-demo/app.mjs（merge 324-357行・350行）
- **対策案（コード無変更・設計材料）**：
  - **(a) 結合APIの後埋めを配列対応に**：`/api/attn/merge` が「クライアントがITPの7日窓内で保持している直近の複数匿名ID（`anon_ids: [...]`）」を受け取り、**350行のループを全IDに対して回して一括後埋め**する（tag_fires だけでなく、必要なら sessions/box_stats の集計も friend_journey 側で全匿名IDを束ねて読む）。**P1の単調増加マージ（Math.max）にそのまま乗る**＝二重計上は max で吸収。※クライアント側で「直近発行した匿名IDの短いローリング配列」を保持する実装が要る（メイン領分）。
  - **(b) 辿れない範囲は正直にラベリング（安全側の本命）**：7日超前・別端末の匿名IDは**構造的天井**——ここを無理に埋めようとITPと戦わない。代わりに**店主向けジャーニー/CSV/friend_journeyビューに「結合後に辿れた範囲」である旨を明示**し、**「1回で決めた」と誤って見せない**。過少計上を“正直な過少”として提示するのが、数字を作らない鉄則に沿う。
  - **(c) 恒久アンカーの再確認**：束ねの恒久キーは friend_id（結合後）＋**P5のサーバ側即時起源保存**（着地初回ヒットでUTM＋referrer＋あればクリックIDを保存）。匿名IDが揮発してもサーバ側に起源の断片が残る設計に寄せる。**ITP回避のサーバセット1stパーティCookie／CNAMEは法規制論点＝見廻り(lp-mimawari)へ申し送り**（目付は採否判断しない）。
- **検証方法**：同一人物を模した**2つの匿名ID×1人**を作り、①**直近1個だけを merge** → 旧 anon のセッション/タグが孤児化しジャーニーが過少になることを確認、②**`anon_ids` 配列で一括後埋め** → 両方が friend_id に付き、かつ**P1のmaxマージで二重計上・値の巻き戻しが起きない**ことを確認、③**同意ゲート（consented）／プロファイリング拒否／テナント越境RLS相当**を全匿名IDで踏襲するかを確認（E2E＝メインターミナル領分・1スタジオ目本番化時。P7/P8実機テストと同じ群で）。
- **優先度**：**P9（中）**——「実名×視線×因果」の**因果＝検討期間・検討回数の正確さ**に直結（高単価・比較検討型のパーソナル/ピラティスほど過少計上が判断を誤らせる）。ただし積極的 stitching はITPが天井なので、**まず(b)の“正直に見せる”を確実に**、(a)は7日窓内の取りこぼし低減として。判断はDaiya。
- **位置づけ**：ITP→P3・LTP→P5 が「**何を測るか**」、bfcache→P7・prerender→P8 が「**いつ数えるか**」の起源だったのに対し、**identity fragmentation→P9 は「誰の来訪として貼り合わせるか（Who）」の起源**。計測の三つ目の軸。

---

## 追加の種（2026-07-24・目付第9回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5（起源クリックID非依存）・P3補遺(AFP)・P6（max_scroll_pct）・P7（bfcache復帰）・P8（先読み）・P9（複数匿名IDの束ね）とは**重複しない新規種P10**。テーマは What（何を測るか=P3/P5）・When（いつ数えるか=P7/P8）・Who（誰の来訪か=P9）に続く**未踏の第4軸＝How-much（その成果はどれだけの価値か）**。起源地図の4軸目を埋めるべく、ビート2（広告界の value-based bidding／enhanced conversions）を物差しに現物 app.mjs の**成果(booking)層**をgrepして当たった。**コードは触っていない。**

### 【P10・新規種】成果（booking）を1ビット（予約の有無）から“粗い価値ティア”へ広げ、効果台帳・原因別成果をティア構成でも見せる
- **現象**：成果を「起きた回数」でなく「その成果がいくらの価値か」で測るのが value-based measurement（例えると：レジで「今日30件売れた」とだけ記録する店と、「500円ドリンク28件＋3万円コース2件」まで記録する店の違い。件数だけ見ると前者が繁盛に見えるが売上は後者が上）。広告界は自動入札AIに「件数」だけ教えると**「$50のガイドDL」と「$15,000の相談」を“同じ1件”**として扱い、AIが合理的に“最も安い成果”を狩る＝junk leads（安いだけの見込み客）が氾濫する、と繰り返し報告し、成果に金額(value)を持たせる value-based bidding／value optimization へ移行を促している。
  - **現物確認①（目付がgrep）＝Lokuの成果は“予約したか否か”の1ビット**：`POST /api/attn/booking`（app.mjs 429-435行）は `{friend_id}` だけを受け `store.bookings.add(d.friend_id)`（433行）＝**金額も種別も持たない `Set`**（53行 `bookings: new Set()`）。
  - **現物確認②（当たり＝過剰批判はしない）**：Lokuは**因果の判定を“行動ベース”に保ち、予約(成果)とは意図的に切り離している**（causal.mjs 25行「box_engagementだけで決める＝行動であって成果(予約)とは独立」・app.mjs 224行「因果は行動ベース＝予約(成果)には依存しない」）＝設計の当たり。また**生の金額・決済データを引き込んでいないのは privacy/特商法の観点で正しい慎重さ**。P10は「Lokuが壊れている」話ではなく、**“成果”の解像度が今1ビットで、そこに“粗い価値の重み”を1段だけ足すと効果台帳の判定が正しくなる**という話。
  - **残る本物の抜け（＝P10）**：Lokuが「打ち手が効いたか」を答え合わせする共通効果台帳 `GET /api/attn/change-outcomes` の主指標は **`booking_completed_rate`（予約人数÷来訪人数・838行）**、原因別成果 `cause-outcomes` も **`booked_rate`（予約人数÷母数・805行）**＝**どちらも“予約の有無”だけを数え、すべての予約を等価に扱う**。よって、ある打ち手が**“体験予約（低単価・気軽）”ばかりを増やし“本契約・継続（高単価）”をむしろ減らしても、件数ベースの台帳は「改善」と誤判定**する＝広告界の junk leads 問題と同型の穴が、Lokuの「効いたか」判定（因果の出口＝成果）に空いている。
- **根拠URL（機構＝S・実装解説A・数字＝ベンダー自己申告B・現物＝目付grep）**：
  - Google Ads Help「About conversion values」（S／成果に金額を持たせると“件数”でなく“事業価値”を最適化できる・公式一次）https://support.google.com/google-ads/answer/13064207
  - Google Ads Help「Value-based bidding for Search and Shopping」（S）https://support.google.com/google-ads/answer/15099424
  - Google Ads Help「About enhanced conversions for leads」（S／offline import の後継・ファーストパーティ顧客データで成約を後追い結合・CRMを握らないのが普及障壁）https://support.google.com/google-ads/answer/15713840
  - Sarah Stemen「Small Business Guide to Value-Based Bidding」（B／“$50のDLと$15,000の相談を同額に見せると安い成果を狩る”）https://www.thesarahstemen.com/blog/small-business-guide-value-based-bidding
  - hopskipmedia「Google Ads Value-Based Bidding: Fix Junk Leads」（B）https://hopskipmedia.com/google-ads-value-based-bidding-fix-junk-leads/
  - easyinsights「What is Meta Value Optimization」（B／価値最適化でROAS平均+12%＝ベンダー数字）https://easyinsights.ai/blog/what-is-meta-value-optimization/
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（booking 429-435行・store.bookings 53行・cause-outcomes 805行・change-outcomes 838行）／ causal.mjs 25行（因果は予約と独立＝当たり）
- **対策案（コード無変更・設計材料）**：
  - **(a) 成果に粗いティアを持たせる**：`POST /api/attn/booking` を `{friend_id, tier}` に拡張し、**「予約の粗いティア（例：体験／本契約／継続）」を任意フィールドで受ける**。ティアは**店主が既に手元で区別している区分＝新たな数字を作らない**（生の金額でなく“区分”）。`store.bookings` を `Set` から `Map(friend_id → {tier})` 相当へ（tierなし＝従来どおり件数集計＝後方互換）。**実名結合(friend_id)が恒久アンカーなので、成約が確定した“後”に friend_id へティアを書き足すだけで成立**（＝広告界が enhanced conversions でハッシュemail経由でやりたい後追い結合を、Lokuは friend_id で最初から持っている）。
  - **(b) 効果台帳・原因別成果をティア構成でも出す**：`cause-outcomes`／`change-outcomes` を**件数（従来）＋“ティア構成”**で返す（例：この打ち手で体験は増えたが本契約は横ばい、を並べて見せる）。件数だけの改善判定に、価値の偏りの注意書きを添えられる。
  - **(c) ティア→価値の重み付けは店主が決める**（目付は数字を作らない）。**生の金額・決済連携・LTV結合は同意/特商法論点＝見廻り(lp-mimawari)へ申し送り**（目付は採否判断しない）。P1の単調増加マージには影響しない（成果は因果とは別軸）。
- **検証方法**：同一の打ち手で「**体験だけ増え・本契約は横ばい**」の来訪群を作り、①`tier`なしの既存bookingが後方互換で壊れず従来の件数集計に一致するか、②**件数台帳は「改善」・ティア台帳は「横ばい」と出し分けられるか**、③テナント越境RLS・同意ゲートをティア集計でも踏襲するかをE2Eで確認（メインターミナル領分・1スタジオ目本番化時。P7/P8/P9実機テストと同じ群で。friend_idにティアを書き足す形＝実装は軽い）。
- **優先度**：**P10（中）**——「実名×視線×因果」の**因果の答え合わせ（効果台帳）の正しさ**に直結。件数は増えても売上が伸びない“取り違え”を防ぐ。**高単価・比較検討型（パーソナル/ピラティス）ほど体験と本契約の価値差が大きく被害大**。実名結合が恒久アンカーで後埋めが軽い＝実装コスト小。判断はDaiya。
- **位置づけ**：ITP→P3・LTP→P5 が「**何を測るか（What）**」、bfcache→P7・prerender→P8 が「**いつ数えるか（When）**」、identity fragmentation→P9 が「**誰の来訪か（Who）**」の起源だったのに対し、**value-based measurement→P10 は「その成果はどれだけの価値か（How-much）」の起源**。計測土台の第4の軸。起源地図が What/When/Who/How-much の4軸で揃った。

---

## 追加の種（2026-07-25・目付第10回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5（起源クリックID非依存）・P3補遺(AFP)・P6（max_scroll_pct）・P7（bfcache復帰）・P8（先読み）・P9（複数匿名IDの束ね）・P10（成果の価値ティア）とは**重複しない新規種P11**。テーマは What(P3/P5)・When(P7/P8)・Who(P9)・How-much(P10) に続く**未踏の第5軸＝Where（決断＝予約/問い合わせが“どの面”で起きたか）**。起源地図の最後の軸を埋めるべく、ビート3（決断面の移動＝GBPがチャット/電話を畳み、LINEはリッチメニュー/ミニアプリ内へ、Instagramはプロフィール/DMへ決断面を寄せる潮流）を入口に、現物 app.mjs の**成果(booking)層と流入(entry)層**をgrepして当たった。**コードは触っていない。**

### 【P11・新規種】成果（booking）に「決断面（どの面で予約/問い合わせが起きたか）」の粗いタグを持たせ、決断面が移っても“どこで決まったか”を測れるようにする
- **現象**：Loku Tuningの戦略は「**実名来訪者が決断する面を、面がどこに移っても測る**」。ところが2026年、主戦場3プラットフォームで**決断面（意思決定UI）がこぞって“プラットフォームの内側・会話寄り”へ移動**している（例えると：昔は店の前の看板を見て店内で注文を決めていた客が、今は店に入らずSNSのDMや予約ボタンの中で決めてしまう＝決断の現場が店の外＝自分たちの計測範囲の外へ散っていく）。
  - **GBP**：会話系決断面を畳む一貫傾向——Business Messages（チャット）は終了（Google公式リリースノートS仮／完全停止の実施時期は媒体により2024/7と2026の記述が混在＝**日付は確定させず“撤去済み”のみ採用**）、2026年の地図パックでは**「電話ボタン」がワンタップ位置から“プロフィールを開いた奥”へ格下げ**（Google公式ヘルプ「chat and call history」S仮＋複数エージェンシーB）。決断は電話/ウェブサイト/予約へ回帰。
  - **LINE（主戦場・一次あり）**：**リッチメニュー（チャット下部の固定面）＋LINEミニアプリが“チャットの中の決断面”**として拡張（LINE Developers docs／LINEヤフー媒体資料S）。リッチメニューに予約/ECの外部リンクを載せ、公式アカウント→ミニアプリで予約・決済まで**LINEの中で完結**。ミニアプリのアプリ内課金手数料が**2026年7月から適用開始**（6/30まで無料）＝プラットフォームが“中の決断面”を収益化に組み込む段階に入った裏付け。
  - **Instagram**：2026年のプロフィール/bioが「**ルーティング層**（feedで関心→bioが follow/予約/電話/DM のレーンへ振り分け）」化し、**bioリンクが“ページで終わる”から“会話（DM/チャット）を開く”へ**寄る（複数媒体B）。プロフィールのアクションボタン（Book Now/Reserve/Contact）で**Instagram内で予約が完結**。
  - **業界の物差し（ゼロクリック/ウォールドガーデン）**：検索の**58%超がクリックなしで終わる**（Similarweb 2026）＝決断がSERP/AI回答/プラットフォーム内で完結し外に出ない。ウォールドガーデンは「**成果（コンバージョン）は返すが“道のり（どこで決まったか）”は返さない**」（Improvado/AI Digital B）＝プラットフォーム横断計測への注力が2026年72%へ上昇（B）。決断面がプラットフォームの内側へ移るほど、外側の計測者は「どこで決まったか」を失う。
  - **現物確認①（目付がgrep）＝Lokuの成果は“決断面ブラインド”**：`POST /api/attn/booking`（app.mjs 429-435行）は `{friend_id}` だけを受け `store.bookings.add(d.friend_id)`（433行）＝**予約が“起きた”ことは記録するが“どの面で決まったか”（LP内CTA／電話／LINEリッチメニュー・ミニアプリ／Instagram DM／GBP予約 等）を一切持たない**。効果台帳(change-outcomes 838行)も原因別成果(cause-outcomes 805行)もこの面ブラインドの booking を母数にする。
  - **現物確認②（当たり＝過剰批判はしない・現物読みで“既に堅い部分”を切り分け・6回連続）**：(1) 流入(entry)は `entry_query`/`entry_pos`/`device`（app.mjs 283-288行）を保持＝**来訪の文脈は一部取れている**。(2) merge(323-)は**同意の由来 `obtained_by`/`method`（334-335行）を記録**＝“誰が/どの方法で名乗ったか”は当たり。(3) 起源(流入元/referrer/UTM)の紐付けは**既にP5（起源クリックID非依存化）が受け持つ種**＝ここでは二重計上しない。よってP11の射程は「**来た面(entry=P5)でも成果の価値(P10)でもなく、“決断が起きた面”という別レイヤーが booking に無い**」1点に絞る。※現物の機能棚卸し表（index.html 249-250行）は「流入元/UTM＝積む」「コンバージョン経路＝LP→LINE追加→予約を接続」と**掲げている**が、booking受け口に“決断面”フィールドが無い＝**掲示と受け口の粒度差**が本物の抜け。
- **根拠URL（機構・潮流＝S/A＋B、数字＝B、現物＝目付grep）**：
  - LINE Developers「LINEミニアプリ×公式アカウント」（S・チャット内決断面の一次）https://developers.line.biz/ja/docs/line-mini-app/service/line-mini-app-oa/ ／ LINEヤフー for Business「リッチメニュー」（S）https://www.lycbiz.com/jp/column/line-official-account/technique/20180731-01/ ／ LINEミニアプリ アプリ内課金2026年7月適用・チャネル同意簡略化（socialplus B→traced）https://blog.socialplus.jp/news/summary-202604/
  - Google Business Profile Help「Changes to chat and call history」（S仮・決断面の撤去/格下げ一次／403は検索経由）https://support.google.com/business/answer/14919056 ／ Google for Developers「Update on GBM」（S仮）https://developers.google.com/business-communications/business-messages/resources/release-notes/update-on-gbm
  - Similarweb「Zero-Click Marketing 2026」（A／58%超がノークリック）https://www.similarweb.com/blog/marketing/geo/zero-click-marketing/ ／ Improvado「Walled Garden in Advertising 2026」（B／“成果は返すが道のりは返さない”）https://improvado.io/blog/walled-garden-in-advertising ／ AI Digital「Alternatives to Walled Garden Reporting」（B）https://www.aidigital.com/blog/alternatives-to-walled-garden
  - Instagram bio＝ルーティング層（TrueFuture Media／CommonNinja B）https://www.truefuturemedia.com/articles/instagram-bio-optimization-2026
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（booking 429-435行・store.bookings 53行・entry 283-288行・merge 334-335行・cause-outcomes 805行・change-outcomes 838行）／ index.html 249-250行（機能棚卸し表の掲示）
- **対策案（コード無変更・設計材料）**：
  - **(a) 成果に“決断面”の粗いタグを持たせる**：`POST /api/attn/booking` を `{friend_id, surface}` に拡張し、**「予約/問い合わせが起きた面の粗い区分（例：lp_cta／phone／line_richmenu／line_miniapp／line_chat／instagram_dm／gbp／other）」を任意フィールドで受ける**。区分は**店主/導線側が既に知っている“どのボタン/どの面から来た予約か”＝新たな数字を作らない**（面の名札を1個付けるだけ）。`store.bookings` を `Set` から `Map(friend_id → {surface, ...})` 相当へ（surfaceなし＝従来どおり件数集計＝**後方互換**）。P10のtierと同じ器（Map化）に相乗りできる＝実装は軽い。
  - **(b) 効果台帳・原因別成果を“決断面構成”でも出す**：`cause-outcomes`／`change-outcomes` を件数（従来）＋**“決断面の内訳”**でも返す（例：この打ち手の後、LP内CTA予約は減ったが LINEリッチメニュー予約が増えた＝**決断が減ったのでなく“面が移った”**を並べて見せる）。決断面が移った時に「LP改善が効かなくなった」という誤読を防ぐ注意書きを添えられる。
  - **(c) “決断面が計測範囲の外”のものは正直に other/unknown で見せる**（P9(b)と同じ“正直な過少”の思想）。GBP予約ボタンや電話や外部予約サイトでの決断は、面の名札が取れないなら**推測で埋めず unknown**にする＝数字を作らない鉄則の安全側。生の外部プラットフォーム連携（GBP/IG API結合・電話計測）の採否は**同意/特商法論点＝見廻り(lp-mimawari)へ申し送り**。
- **検証方法**：同一の打ち手で「**LP内CTA予約が減り・LINEリッチメニュー予約が増える（＝決断面の移動）**」来訪群を作り、①`surface`なしの既存bookingが後方互換で壊れず従来の件数集計に一致するか、②**件数台帳は「横ばい」・決断面台帳は「LPからLINEへ移動」と出し分けられるか**、③テナント越境RLS・同意ゲートを面別集計でも踏襲するか、④P10のtierと同居させても衝突しないか（同じMap器）をE2Eで確認（メインターミナル領分・1スタジオ目本番化時。P7/P8/P9/P10実機テストと同じ群で。friend_idの成果に名札を1個足す形＝実装は軽い）。
- **優先度**：**P11（中）**——「面がどこに移っても測る」という Loku Tuning の**定義そのもの**に直結。2026年は主戦場3面（GBP/LINE/Instagram）で決断面が同時に“プラットフォーム内側・会話寄り”へ動いており、面ブラインドのままだと**「決断が減った」と「決断面が移った」を店主が区別できない**＝改善判断を誤らせる。実名結合(friend_id)が恒久アンカーで名札の後埋めが軽い＝実装コスト小。判断はDaiya。
- **位置づけ**：ITP→P3・LTP→P5 が「**何を測るか（What）**」、bfcache→P7・prerender→P8 が「**いつ数えるか（When）**」、identity fragmentation→P9 が「**誰の来訪か（Who）**」、value-based→P10 が「**どれだけの価値か（How-much）**」の起源だったのに対し、**決断面の移動（zero-click/walled garden）→P11 は「その決断は“どの面”で起きたか（Where）」の起源**。計測土台の第5の軸。**起源地図が What/When/Who/How-much/Where の5軸で揃った回**。

## 追加の種（2026-07-26・目付第11回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5（起源クリックID非依存）・P3補遺(AFP)・P6（max_scroll_pct）・P7（bfcache復帰）・P8（先読み）・P9（複数匿名IDの束ね）・P10（成果の価値ティア）・P11（決断面surface）とは**重複しない新規種P12**。起源地図5軸(What/When/Who/How-much/Where)が一巡したので、鉄則どおり新軸を無理に増やさず**ビート2/engaged-time堅牢化の深掘り**（＝carried-over宿題「visibilitychange多重発火・タブ復帰時のengagementリセット扱い」）へ舵。ライフサイクル3点(P0離脱/P7bfcache/P8先読み)の**残る一角＝“ページ遷移を伴わないタブ/アプリ切替（可視トグル）の時計”**に当たった。**コードは触っていない。**

### 【P12・新規種】タブ/アプリを短く離れて戻った時に「隠れていた秒」が滞在秒(active_sec)に混入するのを塞ぐ（可視復帰時に lastTick をリセット／dt をクランプ）
- **現象**：`tick()`（index.html 342-349行）は毎回 `dt=(now-lastTick)/1000; lastTick=now;` で経過秒を出し、`activeGate=(可視&&前面&&25秒以内に操作)` なら `totalActive+=dt`。ところが **`lastTick` はタブ/アプリを離れて戻る境目でリセットされない**。主戦場のLINE内ブラウザ(iOS)は**裏に回るとJS（時計刻み）が数秒の猶予後に凍る**（実測A：約20秒バックグラウンド→戻すとカウンタは戻ってから再開）。→ ユーザーが通知を**15秒**チラ見して戻ると、復帰直後の刻みが `dt≈15秒`（凍結中の経過）を持ち、離脱直前に操作していれば無操作ゲート(25秒=IDLE_MS)を通り抜け、**その15秒が「読んでいた時間」に加算**されうる（例えると：店員が別室に呼ばれている間、滞在ストップウォッチを止め忘れ、戻った瞬間に居なかった数秒を読了時間に足してしまう）。
- **現物確認（当たり＝過剰批判はしない・現物読みで“既に堅い部分”を切り分け・7回連続）**：(1) 裏に居る間に刻みが発火しても**可視ゲート(`document.visibilityState==='visible'&&hasFocus`・346行)で秒は積まれない**＝“裏で数え続ける”水増しは既に防御済み。(2) **25秒以上の離席は無操作ゲート(`now-lastActivity<IDLE_MS`・347行)が弾く**＝長時間離席は安全。よって漏れは「**25秒未満の往復1回ごとの、凍結中の数秒**」に限定＝**大穴ではなく“塵積”の防御種**。ただし主戦場LINE内は通知/アプリ切替の短い往復が頻繁ゆえ、塵積が効く。
- **他種との非重複（実装照合の要）**：P0（離脱時flush＝出口の“送信”）・P7（bfcache復帰＝“戻る操作での再読込”時の新ビュー計上/per-viewカウンタリセット）・P8（先読み活性化ゲート）とは別レイヤー。**P7の `pageshow`/`event.persisted` はタブ/アプリ切替では発火しない**（ページ遷移を伴わないため）。P12は“同一ページのままの可視トグル”の**時計(dt)**だけを対象＝別経路。実装時は「P7のbfcache復帰リセット」と「P12の可視復帰リセット」が同一往復で二重に走らないことだけ確認すればよい。
- **根拠URL（機構=S、実測=A、物差し=A/B、現物=目付grep）**：
  - Chrome for Developers「Heavy throttling of chained JS timers（Chrome 88〜）」（S・背景タブで setTimeout を強く間引く/5分以上隠れると毎分1回・403は検索経由）https://developer.chrome.com/blog/timer-throttling-in-chrome-88
  - MDN「Window: setTimeout()」背景タブのクランプ規定（S）https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout
  - Apple Developer Forums「Preventing JavaScript from Stopping in Safari When It Goes into the Background」（A・実測：iOSはバックグラウンドでJS停止・戻ると再開）https://developer.apple.com/forums/thread/777860
  - 物差し：Parse.ly「Engaged Time」heartbeatで“アクティブに関与中の時間だけ”集計（A）https://www.parse.ly/glossary/engaged-time/ ／ Chartbeat 同旨 https://help.chartbeat.com/hc/en-us/articles/360045890913-User-Engagement-Tracking-Methodology ／ GA4 engagement time＝“アクティブ前面タブの時間・背景タブ除外・止めたら一時停止”（Analytify B）https://analytify.io/track-user-engagement-time-in-google-analytics/
  - 現物: loku-tuning-plugin/index.html tick() 342-349行（`dt=(now-lastTick)/1000; lastTick=now; if(activeGate) totalActive+=dt`）・可視/無操作ゲート 346-348行・visibilitychange は hidden時のflushのみ 475行（可視復帰のハンドラなし）
- **対策案（コード無変更・設計材料）**：
  - **(a) 可視復帰時に時計を取り直す（業界標準の“pause/resume”に合わせる）**：`document.addEventListener('visibilitychange', …)` の**可視化(visible)側**で `lastTick=Date.now();`（必要なら `vel`/`velSmooth` も0に）＝**隠れていた間を dt に入れない**。GA4/Parse.ly/Chartbeat/Riveted/Marfeel が全て採る「隠れたら止め、戻ったら再開」の現物版。既存の hidden時flush(475行)に visible時reset を1行足す形＝軽い。
  - **(b) もしくは dt を刻み間隔でクランプ（頭打ち）**：`var dt=Math.min((now-lastTick)/1000, TICK/1000*2)` のように**1刻みで乗る秒に上限**を設ける＝凍結明けの巨大 dt を機械的に頭打ち。(a)より雑だが取りこぼしにくい保険。(a)と併用可。
  - **(c) `focus`/`blur`(327-328行 hasFocus)との整合**：PC等でタブは可視のままウィンドウ非フォーカスの場合も、focus復帰時に同様に `lastTick` を取り直すと二重の穴を塞げる（活性判定は既に hasFocus を見ているので、時計リセットだけ足りない）。
- **検証方法**：実機E2E（メイン領分・1スタジオ目本番化時。P7/P8/P9/P10/P11のライフサイクル/結合/価値/面 境界テストと同じ群で）。①**LINE内WKWebViewで「15秒アプリ切替→戻る」を往復**させ、active_sec と各box engagement が凍結中の秒を**拾わない**こと。②**25秒境界の前後（24秒 vs 26秒離席）**で挙動が正しく分かれること（24秒＝リセットで加算なし・26秒＝従来どおり無操作ゲートで停止済み）。③**P7のbfcache復帰テストと同じ往復群**で、可視復帰リセット(P12)とbfcache復帰リセット(P7)が二重に走らないこと。④P1(単調増加マージ)と衝突せず、途中flushが飛んでも巻き戻らないこと。
- **優先度**：**P12（低〜中）**——防御的リファイン。既存の可視ゲート＋25秒無操作ゲートで“最悪の水増し”は防げており、漏れは「25秒未満の往復ごとの数秒」に限定。ただし主戦場LINE内(iOS)は短い往復が頻繁で塵積が効き、engagement(読了率)＝タグ発火の閾値判定の分子を押し上げるため、**素通り客を「検討度が高い」と誤タグ付け→店主の初回メッセージ空振り**につながる。旧Universal Analyticsの“放置タブ込み滞在の水増し”と同型の穴。実装1〜数行で軽い。判断はDaiya。
- **位置づけ**：起源地図5軸(What=P3/P5・When=P7/P8・Who=P9・How-much=P10・Where=P11)が一巡した後、**新軸ではなく「When軸(いつ数えるか)の深掘り／ライフサイクルの残る一角」**として着地。P0(離脱=出口)・P7(bfcache=戻る入口)・P8(先読み=正面入口)が“ページの一生の入退場”を塞ぐのに対し、**P12は“滞在中に一瞬席を外して戻る”という往復の時計**を塞ぐ＝ライフサイクル4点目。「ブラウザの省電力最適化（背景タブ凍結）が、皮肉にも“戻った瞬間の水増し”という計測の穴を生む」＝bfcache(P7)・先読み(P8)と同じ“最適化が定義を揺らす”構図の3例目。

## 追加の種（2026-07-29・目付第12回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5（起源クリックID非依存）・P3補遺(AFP)・P6（max_scroll_pct）・P7（bfcache復帰）・P8（先読み）・P9（複数匿名IDの束ね）・P10（成果の価値ティア）・P11（決断面surface＝bookingの“着地面”）・P12（可視復帰の時計）とは**重複しない新規種P13**。起源地図5軸(What/When/Who/How-much/Where)が一巡した後の宿題「**新軸を無理に足さず“軸の交差”を掘る**」の初回として、**Where（P11＝決断がどの面で起きたか）×Who（P9＝誰の来訪として貼り合わせるか）**の交点を掘った。ビート3（決断面の移動）とビート2（クロスチャネルID解決＝PostHog帰属Explorer / deterministic vs probabilistic）を入口に、現物 app.mjs の**ジャーニー(journey)層と成果(booking)層**をgrepして当たった。**コードは触っていない。**

### 【P13・新規種／軸の交差 Where×Who】決断面(surface)を「per-人の来訪ジャーニー」に串刺しし、friend_journey と booking に共通の surface 軸を通して“面の道のり(surface path)”を実名1本で描けるようにする
- **現象**：Loku Tuningの戦略は「実名来訪者が決断する面を、面がどこに移っても測る」。P11で「**決断が“着地”した面**」（bookingの点）を種にしたが、**その面を per-人の“順路”（線）として描く軸が、ジャーニー側に無い**。2026年は主戦場3面（GBP／LINE／Instagram）で決断面が同時に移動し（GBPは native Chat→WhatsApp/SMS・予約は外部システム直結／LINEはリッチメニュー→ミニアプリで内製・7月課金化／Instagramは bio がDM/予約へのルーティング層化）、一人の客が**複数の面を跨いで**決断に至る（例えると：田中さんが「GoogleでLive店情報を見て→LPで料金を読んで→LINEのメニューから予約」と“売り場を順に回って最後の窓口で決めた”のに、台帳には「予約が入った」だけが残り“回った順路”が空欄）。
  - **現物確認①（目付がgrep）＝“誰の来訪か”の背骨は既にあるが“面”の軸が通っていない**：`GET /api/attn/journey?friend_id=`（app.mjs 373-401行）は、ある friend_id に結合された全セッションを**同意ゲート(380行)＋テナントRLS(377行)**を踏まえて束ね、各行に `entry_query`/`entry_pos`/`device`（392行・どう来たか）・`box_engagement`（どこを読んだか）・`exit_box`（389/397行・どこで離脱か・行動ベースで予約と独立）・来る前のサチコ要約（398行）まで載せる＝**per-人のジャーニー(friend_journeyビュー相当)は既に堅い**。だが**どの行にも「決断面(surface)」の区分が無い**。成果側 `POST /api/attn/booking`（429-433行）も `store.bookings.add(d.friend_id)`＝**面ブラインド（P11で指摘済み・未実装）**。→ **P9（人の束ね）とP11（決断面）は別々に存在するだけで、“面(surface)”という共通軸で交差していない**。
  - **現物確認②（当たり＝過剰批判はしない・現物読みで“既に堅い部分”を切り分け・8回連続）**：(1) ジャーニーは**per-人で束ね済み＋同意ゲート(380)＋RLS(377)**＝プライバシー安全に「誰の」が引ける（P9の背骨は当たり）。(2) `entry_query`/`entry_pos`/`device`＋サチコ要約で「**どう来たか**」の文脈は一部取れている（283-288/398行）。(3) 起源(referrer/UTM)の紐付けは**既にP5が受け持つ別種**＝ここでは二重計上しない。(4) merge(323-357行)の tag 後埋め(350行)で「名乗る直前の1匿名IDまで」は結合済み＝P9(a)の per-人束ねが前提として効く。よってP13の射程は「**“決断面(surface)”という区分が booking にも journey にも無く、P9とP11が“面”で交差していない**（人の背骨に面の軸が刺さっていない）」1点に絞る。
  - **業界の物差し（クロスチャネル・スティッチング／deterministic vs probabilistic）**：ウォールドガーデン/Cookie消滅で**顧客の道のりの42〜65%が不可視**（Improvado/Hashmeta B・数字は媒体差＝恒久採用しない）。面またぎの順路を描くID結合は**確定的(deterministic＝本人が同じ鍵=ログイン/ハッシュemail/電話を示した確証)**と**推測的(probabilistic＝IP/デバイス指紋/行動の統計推定)**の2系統で、確定的は精度が高いが「多くの事業で解けるのは全トラフィックの1割未満」の目安、推測的は射程が広いが**近年GDPRで“同意ゲート無しの人の束ね”として否定されつつある**（Herm.io/FlexyConsent B）。業界標準ツール(PostHog Session Attribution Explorer beta・A)は面またぎ順路を**チャネル×referrer×UTMの“帰属モデル(推測)”で繋ぐ**。**Lokuは友だち追加＝本人の行為で得た“確定的アンカー(friend_id)”ゆえ、推測もハッシュemailの授受もなしに面またぎ順路を1本で描ける**——それを実際に描くのがP13。
- **根拠URL（現物＝目付grep・機構/潮流＝S/A、数字＝B）**：
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（journey 373-401行・同意ゲート380/RLS377/entry 392/exit 389,397/サチコ398・booking 429-433行・merge 323-357行・tag後埋め350行）
  - Similarweb「Zero-Click Marketing 2026」（A・58%超ノークリック＝決断がプラットフォーム内で完結） https://www.similarweb.com/blog/marketing/geo/zero-click-marketing/
  - LINE Developers「LINEミニアプリ×公式アカウント」（S・チャット内決断面の一次） https://developers.line.biz/ja/docs/line-mini-app/service/line-mini-app-oa/ ／ LINE Developers News 2026（S・Messaging API作成のリッチメニューで表示/クリック統計取得可＝面の可視化が一次で進む） https://developers.line.biz/en/news/2026/
  - PostHog「Marketing analytics / Session Attribution Explorer」（A・面またぎ帰属を“モデル”で繋ぐbeta＝Lokuの確定的結合との対比） https://posthog.com/docs/web-analytics/marketing-analytics
  - arXiv「The Identity Fragmentation Bias」（S・学術・IDの分裂が帰属/因果を系統的に歪める＝“面が増えるほど一人を一人と束ねる価値が上がる”の実証） https://arxiv.org/pdf/2008.12849
  - 業界数字（B・媒体差あり・恒久採用しない）：Improvado「Cross-Channel Attribution 2026」（道のりの42〜65%不可視） https://improvado.io/blog/cross-channel-marketing-analytics ／ Hashmeta「Identity Resolution stitching post-cookie」 https://hashmeta.com/blog/identity-resolution-stitching-customer-journeys-post-cookie/ ／ Herm.io（deterministic 1割未満・probabilistic の限界） https://www.herm.io/blog/the-truth-about-cross-device-identity-resolution-in-2025
- **対策案（コード無変更・設計材料）**：
  - **(a) journey行とbooking に共通の `surface` 軸（粗い区分）を通す**：`POST /api/attn/booking` を `{friend_id, surface}` に（＝P11(a)）、**加えて各セッション/journey行にも `entry_surface`（そのセッションに“どの面から来たか”）を任意フィールドで持たせる**。語彙は**P11と共有**（`lp_cta` / `line_richmenu` / `line_miniapp` / `line_chat` / `phone` / `gbp` / `instagram_dm` / `unknown`）。`entry_surface` は**LIFFの起動文脈（リッチメニュー/ミニアプリ経由か）・entry_query/referrer から導ける範囲**で埋め、導けない面は `unknown`。＝**新たな数字を作らず、既に取れている文脈に“面の名札”を付け直すだけ**。
  - **(b) friend_journey を“面の道のり(surface path)”でも返す**：`/api/attn/journey` の各行に `surface` を載せ、時系列（`started_at` 順）に並べれば「**この田中さんは gbp → lp_cta（LP料金を読む）→ line_richmenu（で予約）**」という**順路**が実名1本で描ける。P11の booking-surface（着地面）は**この順路の最後の駅**として自然に接続。
  - **(c) off-LP面は推測せず `unknown`・外部連携は見廻り申し送り（P9(b)/P11(c)と同じ“正直な過少”）**：GBPプロフィール閲覧・Instagram DMの会話・LINEチャット（リッチメニュー前）等、**Lokuの計測範囲の外で起きた面は、推測(probabilistic)で埋めず `unknown`**。それらを実データで結ぶには外部プラットフォームAPI連携＝**同意/特商法論点＝見廻り(lp-mimawari)へ申し送り**。確定的アンカー(friend_id)は“名乗った後”しか届かない＝友だち追加“前”の複数面順路は構造的天井（P9の7日揮発と同じ限界）を正直に見せる。
- **検証方法**：「同一人物が **GBP情報→LP→LINEリッチメニューで予約**」の面またぎ来訪群を作り、①`surface`/`entry_surface` なしの既存 journey/booking が**後方互換**で壊れないか、②`/api/attn/journey` が**面の順路（surface path）を実名1本で時系列に返せるか**、③off-LP面が推測で埋まらず `unknown` になるか、④テナント越境RLS・同意ゲートを面別でも踏襲するか、⑤**P11(booking-surface＝着地面)とP13(journey-surface＝順路)が同じ surface 語彙を共有し二重定義にならないか**（P10ティア・P11と同じMap器に相乗り）をE2Eで確認（メイン領分・1スタジオ目本番化時。P7/P8/P9/P10/P11/P12の境界テストと同じ群で）。
- **優先度**：**P13（中）**——「面がどこに移っても測る」という Loku Tuning の定義の**完成形（点→線）**。P11が「決断が着地した面」を成果に付けるのに対し、P13は**その面を per-人ジャーニーに串刺しして“順路”にし、P9の人の束ねと交差**させる＝**実名結合(friend_id)という確定的アンカーの強みを、面またぎ順路の描画で初めて活かす**。面ブラインド＋順路ブラインドのままだと「決断が減った」と「決断面が移った」を店主が区別できず改善判断を誤る。実装は「既に取れている文脈に面の名札を付け、journeyに1軸足す」＝軽い。judgment はDaiya。
- **位置づけ（起源地図の“交差”フロンティア初回）**：ITP→P3・LTP→P5＝What、bfcache→P7・prerender→P8・背景タブ凍結→P12＝When、identity fragmentation→P9＝Who、value-based→P10＝How-much、zero-click/walled garden→P11＝Where——5軸が一巡した後、**新軸を足さず「軸の交差」を掘る**という第10回以降の推奨に従った初回。今回の交点＝**Where×Who**（P11×P9）を、起源掘り「なぜ deterministic と probabilistic のID結合が生まれ、なぜ推測へ後退したか」で照らした。**“面(Where)が増えるほど、一人を一人と束ねる確定的アンカー(Who)の価値が上がる”**の交差点。次の交差候補＝Where×How-much（P11×P10＝どの決断面が高価値ティアを生むか）。

## 追加の種（2026-07-30・目付第13回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5（起源クリックID非依存）・P3補遺(AFP)・P6（max_scroll_pct）・P7（bfcache復帰）・P8（先読み）・P9（複数匿名IDの束ね）・P10（成果の価値ティア）・P11（決断面surface＝bookingの“着地面”）・P12（可視復帰の時計）・P13（面の道のりsurface path＝journeyの“順路”）とは**重複しない新規種P14**。交差フロンティア第2回として、前回の Where×Who（P13）に続く次の交差候補＝**Where（P11＝どの面で決めたか）×How-much（P10＝その成果はどれだけの価値ティアか）**の交点＝**「どの決断面が高価値ティアを生むか」**を掘った。ビート3（決断面の移動）とビート2（広告界の value-based / revenue attribution）を入口に、現物 app.mjs の**効果台帳（cause-outcomes / change-outcomes）層**をgrepして当たった。**コードは触っていない。**

### 【P14・新規種／軸の交差 Where×How-much】効果台帳（cause-outcomes / change-outcomes）を、booking の surface(P11)×tier(P10) で交差集計する“別ビュー”でも出し、「どの決断面が高価値ティアを生むか」を実名クロスで答えられるようにする
- **現象**：P11で「決断が“着地”した面（surface）」、P10で「成果の価値ティア（体験/本契約/継続）」を別々の種として booking に載せる設計材料は用意した。だが**その2つを掛け合わせて「面×価値」を見せる出力が、効果台帳側に無い**。現物の効果台帳（`cause-outcomes`/`change-outcomes`）は成果を**「予約の“有無”という1ビット」でしか集計しておらず**、出力は単一の件数率（`booked_rate`/`booking_completed_rate`）だけ。結果、「**LINEリッチメニュー面は本契約（高価値）が多い／電話面は体験（低単価）どまり**」といった“面ごとの価値の質”が店主に見えない（例えると：予約台帳を「どの窓口で決めたか × どのランクの予約か」のマス目の表にすれば「LINE窓口は本契約が多い／電話は体験ばかり」と一目で分かるのに、今は“合計1列＝件数”に潰している）。
  - **現物確認①（目付がgrep）＝効果台帳の器は堅いが“面×価値”の軸が無い**：`GET /api/attn/cause-outcomes`（app.mjs 788-807行）は原因（離脱理由）別に `booked_rate = booked/n`（805行）を、`GET /api/attn/change-outcomes`（810-840行）は baseline/treatment 別に `booking_completed_rate = booked/visitors`（831行）を集計する。母数の成果判定は**すべて `store.bookings.has(fid)`（803/832行）＝予約の有無（1ビット）**。→ P10（tier）も P11（surface）も booking に“載せる種”はあるのに、**台帳の出力はその2軸を掛け合わせない**＝P11とP10が“面×価値”で交差していない。
  - **現物確認②（当たり＝過剰批判はしない・現物読みで“既に堅い部分”を切り分け・9回連続）**：(1) 効果台帳は**同意ゲート(793行)＋テナントRLS(797行)＋friend単位の重複除外（seen Set・792行）**で集計＝プライバシー安全に「原因別/変更別の成果」が引ける（台帳の器は当たり）。(2) **因果は行動ベースで予約から独立**（causal.mjs 25行／app.mjs 224行コメント）＝成果に価値/面の軸を足しても因果推定は汚れない設計（当たり）。(3) `surface` という語は既に app.mjs にあるが、それは `/api/attn/product-funnel?surface=`（483-493行）＝**自社画面（オンボ/管理）のドッグフーディング用**の別名前空間で、booking の決断面(P11)とは無関係＝**二重定義しない**。(4) P10（tier）・P11（surface）・P13（journeyの順路）は**入力側/順路側の種**＝P14は**“効果台帳の出力側”で掛け合わせる集計ビュー**という別レイヤー＝非重複。よってP14の射程は「**効果台帳の“出力”が単一の件数率で、booking の surface×tier を掛け合わせる“別ビュー”が無い**」1点に絞る。
  - **業界の物差し（件数→価値・面別価値）**：広告界は **CPA/CVR（件数）→ ROAS/value-based（価値）**へ物差しを移してきた（同じ件数でも“体験5千円”と“本契約50万円”を区別しないと junk leads を“改善”と誤読する）。到達点が **Google Ads「コンバージョン値ルール」＝成果の価値を location/device/audience 別に auction 時点で調整**（S）＝「価値は面・セグメントで一様でない」を広告基盤が公式化。二次では「revenue attribution beats conversions（チャネルで AOV が違う時は件数でなく金額で測る）」「average deal size by channel（どの経路が大口/小口を連れるか）」「予約業は booking value by source が“どの経路が高価値予約を生むか”を明かす」が定着（すべてB・数字は媒体差＝恒久採用しない）。**Loku は friend_id（確定的アンカー）に tier(P10) と surface(P11) の両名札を載せられるため、業界が推測的 revenue attribution で苦労する「どの面が高価値を生むか」を推測なしの実名クロス集計で出せる**——それを効果台帳に通すのがP14。
- **根拠URL（現物＝目付grep・機構＝S、数字＝B）**：
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（cause-outcomes 788-807行・`booked_rate` 805・consent793/RLS797/dedup792・成果判定 803／change-outcomes 810-840行・`booking_completed_rate` 831・成果判定 832／booking 429-433行＝surface/tierなし／因果独立 causal.mjs 25行・app.mjs 224行コメント／別名前空間 surface＝product-funnel 483-493行）
  - Google Ads Help「コンバージョン値ルール」（S・価値を location/device/audience 別に auction 時点で調整） https://support.google.com/google-ads/answer/10518330 ／「Maximize conversion value / Target ROAS」（S・件数でなく価値を最適化する一次概念） https://support.google.com/google-ads/answer/7684216
  - 業界数字/物差し（B・媒体差あり・恒久採用しない）：Factors「Revenue attribution」/ Kickbite「Revenue beats conversions」（AOVがチャネルで違う時は金額で測る） https://www.factors.ai/blog/what-is-revenue-attribution ／ Fullcast「Channel revenue attribution / average deal size by channel」 https://www.fullcast.com/content/channel-revenue-attribution/ ／ RateGain「booking value by source」（予約業版・どの経路が高価値予約を生むか） https://rategain.com/blog/what-is-a-direct-booking/ ／ LayerFive「ラストクリックの締め面偏重バイアス 2026」 https://layerfive.com/blog/ecommerce-attribution-beyond-last-click/
- **対策案（コード無変更・設計材料）**：
  - **(a) 効果台帳に surface(P11)×tier(P10) を任意の集計軸で足す**：`cause-outcomes`/`change-outcomes` の集計 rec に、booking に付いた `surface`（P11の語彙 `lp_cta`/`line_richmenu`/`line_miniapp`/`line_chat`/`phone`/`gbp`/`instagram_dm`/`unknown`）と `tier`（P10の語彙 `trial`/`contract`/`retention` 等・店主が既に持つ区分）を**第2・第3のグルーピングキーとして任意で追加**。P10/P11/P13と**同じ Map 器に相乗り**。**新しい数字は作らず、既に booking に付いた2名札を掛け合わせて数え直すだけ**。
  - **(b) 出力は「面×価値」のクロス表・件数台帳は後方互換で残す**：`{ surface, tier, n, booked, ... }` の行を返し、UIで「決断面（縦）×価値ティア（横）」のマス目に組む＝「line_richmenu × contract = n件 / phone × trial = n件」。**既存の件数率台帳（`booked_rate`/`booking_completed_rate`）は“別ビュー”としてそのまま残し**、tier/surface なしの旧集計は後方互換で一致させる（二重定義にしない）。
  - **(c) 生金額/決済/LTV結合はしない“粗いティア止まり”（P10(c)踏襲）**：価値は**店主が既に持つ粗い区分（体験/本契約/継続）**まで。生の金額・決済額・LTV を成果価値に引き込む精緻化は**同意/特商法/景表の論点＝見廻り(lp-mimawari)申し送り**。面の外部データ（GBP/IG/電話の実測）連携も見廻り領分。
- **検証方法**：「**LP内CTAで体験（低ティア）予約が増え・LINEリッチメニューで本契約（高ティア）予約が減る**」面移動群を作り、①`surface`/`tier` なしの既存 outcomes が**後方互換**で壊れないか、②**件数台帳（`booked_rate`/`booking_completed_rate`）は横ばい/上昇に見えても、面×価値のクロス台帳では“高価値面の縮小”が出る**か（junk-leads型の誤判定を面レベルで捕まえる）、③テナント越境RLS・同意ゲートを面×価値集計でも踏襲するか、④**P10/P11/P13と同じ surface/tier 語彙・同じ Map 器を共有し二重定義にならないか**をE2Eで確認（メイン領分・1スタジオ目本番化時。P7〜P13の境界テストと同じ群で）。
- **優先度**：**P14（中）**——「面がどこに移っても測る」（Where）に「**その面はどれだけの価値を生むか**」（How-much）を重ねる交差の完成形。件数だけの台帳のままだと「体験ばかり増やし本契約を減らす打ち手」を“改善”と誤判定し（junk leads 同型）、決断面が移動している今は「本当は本契約を生んでいた面（守るべき窓口）」を「予約が減った」と誤読して店主が畳む空振りにつながる。実装は「既に付いた2名札を掛けて数え直し、別ビューで出す」＝軽い。judgment はDaiya。
- **位置づけ（起源地図の“交差”フロンティア第2回）**：ITP→P3・LTP→P5＝What、bfcache→P7・prerender→P8・背景タブ凍結→P12＝When、identity fragmentation→P9＝Who、value-based→P10＝How-much、zero-click/walled garden→P11＝Where——5軸一巡後の「軸の交差」フロンティアの第2回。前回 Where×Who（P13＝面の道のり）に続き、今回 **Where×How-much（P11×P10）**を、起源掘り「なぜ ROAS がわざわざ生まれたか＝件数(CPA)では価値の差が測れなかった」（How-muchの起源=value-based bidding の“裏面”）で照らした。**“面ごとに価値の質が違う（どの面が本契約を生むか）”**の交差点。次の交差候補＝When×Who（ライフサイクル端の取りこぼしが人の束ねをどう歪めるか）／How-much×Who（高価値客ほど束ねが効くか）。

## 追加の種（2026-07-31・目付第14回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5（起源クリックID非依存）・P3補遺(AFP)・P6（max_scroll_pct）・P7（bfcache復帰）・P8（先読み）・P9（複数匿名IDの束ね）・P10（成果の価値ティア）・P11（決断面surface＝bookingの“着地面”）・P12（可視復帰の時計）・P13（面の道のりsurface path＝journeyの“順路”）・P14（面×価値の効果台帳）とは**重複しない新規種P15**。交差フロンティア第3回として、宿題どおり“Where以外”へ振り、次の交差候補＝**When（いつ数えるか＝ライフサイクル端の区切り）×Who（誰の来訪として束ねるか）**の交点＝**「同じ人が“いつ・何回”来直したか（来訪エピソードの数え上げ）」**を掘った。ビート2（OSS計測 Plausible の visits/views-per-visit・PostHog の identify/reset 跨ぎセッション継続）を入口に、現物 app.mjs の**セッション upsert 層と journey 層**をgrepして当たった。**コードは触っていない。**

### 【P15・新規種／軸の交差 When×Who】来訪エピソード（visit episode＝同じ人の“のべ訪問回数”と“間隔”）を、friend_id に紐づく一級単位として数えられるようにする
- **現象**：現物のセッション upsert は**「同一 anon×page は1行」**（app.mjs 271行のコメント）で、同じ人が日を分けて何度も来ても**同じ1行に畳まれる**。`started_at` は初回のみ（274行）、`last_seen_at` は collect のたび上書き（295行）、`active_sec` は単調増加マージ（293行・P1）で合算される。→ **再訪の“回数(frequency)”と“間隔(gap)”を数えるカウンタ／エピソード器が無い**ため、「別々に3回来てから予約した優良客」と「1回で予約した客」が**同じ“1訪問者”に潰れて**見え、再検討の厚み（買う気の強さ）が店主のレポートから消える（例えると：同じお客さんが3日連続で下見に来ても、来店台帳に“1人・合計滞在◯分”とだけ書かれ、“のべ3回来た”という熱意が記録に残らない）。`GET /api/attn/journey`（379-401行）は anon 行を列挙するが「人の再訪回数・最終来訪からの経過」は返さない。
  - **現物確認①（目付がgrep）＝セッション行の“両端”は持つが“回数”が無い**：`store.sessions` は `anon_id -> session` の Map（app.mjs 46行）で、upsert は「同一 anon×page は1行」（271行）。`started_at`（初回固定・274行）と `last_seen_at`（最新・上書き・295行）で“いつ来て・いつ最後に居たか”の両端は取れるが、**その間に“何回・いつ来直したか”のエピソード列が無い**＝翌日また来ても `started_at` は初回のまま・`last_seen_at` だけ進み・`active_sec` は合算＝**「別の来訪だった」という事実が消える**。`box_stats.revisits`（index.html 467行）は**箱の中の再表示**回数で、ページ級の再訪エピソードではない（別レイヤー）。
  - **現物確認②（当たり＝過剰批判はしない・現物読みで“既に堅い部分”を切り分け・10回連続）**：(1) `started_at`＋`last_seen_at` で recency（最終来訪からの経過）は anon 単位で導出可＝時間の両端は持っている（当たり）。(2) **P1単調増加マージ**で後着スナップショットが巻き戻さない（当たり）。(3) **P9で複数匿名IDを1人(friend_id)に束ねる**設計材料は別種で用意済み＝cross-anon の Who は非重複（P15は“束ねた人の上で回数を数える”上位レイヤー）。(4) **同意ゲート＋テナントRLS**を集計で踏襲済み（当たり）。よってP15の射程は「**同一人物の来訪エピソードの“回数(frequency)”と“間隔(gap)”を数える器が無く、翌日の再訪が同じ1行に潰れる**」1点に絞る。
  - **他種との非重複（実装照合の要）**：**P9＝複数“匿名ID”を1人に束ねる**（Who・別端末/7日TTL跨ぎの結合）／**P12＝1エピソード“内”の隠れ秒の混入**（When・時計の精度）／**P13＝journeyに“どの面(surface)”かの順路を刺す**（Where）——いずれとも別レイヤー。**P15＝“同じ人が何回・いつ来直したか”という<u>エピソードの数え上げ</u>**で、P9が束ねた「人」の上に、P12が精度化した「1回の時計」を、**“のべ回数・最終来訪・間隔”で並べ直す**位置づけ。P12の可視復帰リセット（同一ページ内の可視トグル）と、P15のエピソード境界（日をまたぐ等の“別来訪”の区切り）は別の境界＝実装時に同一往復で二重に走らないことだけ確認。
- **根拠URL（現物＝目付grep・機構＝A/S、数字＝B）**：
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（session upsert 271-296行・「同一anon×pageは1行」271／`started_at` 274／`last_seen_at` 295／`active_sec` 単調増加 293／`store.sessions` Map 46／journey 379-401行）・index.html（`getAnonId` 451-458・`anonId` 460／box `revisits` 467行）
  - Plausible Analytics v3.0.0（A・GitHub一次・「Total visits(sessions)」「Views per visit」を一級指標として別立て） https://github.com/plausible/analytics/discussions/5318 ／ CHANGELOG https://github.com/plausible/analytics/blob/master/CHANGELOG.md
  - PostHog（A・一次changelog・session replay を identify()/reset() を跨いで継続＝身元遷移でセッションを割らない設計） https://posthog.com/changelog ／ docs https://posthog.com/docs/session-replay
  - 業界数字/物差し（B・業態差あり・恒久採用しない）：マルチセッション購買＝中価格帯2〜4・高額帯5〜7回超／再訪客CVRは新規の2〜3倍 https://www.growthsuite.net/resources/shopify-conversion-rate/traffic-source-conversion/returning-visitor ／ RFM＝recency/frequency/velocityで買う気を採点 https://www.landbase.com/blog/how-to-weight-recency-vs-frequency-vs-intensity-in-email-signal-scoring ／ frequency signals https://www.saber.app/glossary/frequency-signals
- **対策案（コード無変更・設計材料）**：
  - **(a) collect 受け口で“エピソード境界”を検知して回数を持つ**：collect 時に「前回 `last_seen_at` から一定ギャップ（例：店主が持つ区分＝日をまたいだら別来訪）を超えて戻った」を検知し `visit_count++`／または `episodes: [{started_at, last_seen_at, active_sec}...]` の**エピソード列**をセッション行に持つ。**新しい数字は作らず、既にある時刻から“区切り”を数えるだけ**。P1単調増加は各エピソード内で維持。
  - **(b) journey に per-person の“のべ回数・最終来訪・間隔”を足す**：`GET /api/attn/journey` の返却に、その friend_id の**のべ訪問回数(visits)・最終来訪からの経過(recency)・平均間隔**を追加。UIで「この実名客は◯回来ていて、最後は◯日前」を店主に見せる。件数だけの既存 journey 行は後方互換で残す（別ビュー）。
  - **(c) 数字を作らない＝“ギャップ閾値”は店主の区分に寄せる／生LTVには踏み込まない**：エピソード境界の閾値は**店主が既に持つ常識（例：日をまたいだら別来訪）**に寄せ、恣意的な“セッション時間”を発明しない。生LTV/決済/来店実数との結合は**同意設計＝見廻り(lp-mimawari)申し送り**。
  - **(d) merge を跨いでエピソードを割らない（PostHog identify跨ぎと同思想）**：友だち追加（anon→friend 結合）の前後で“同一人物の来訪エピソード”を1本に保ち、「匿名の来訪」と「実名の来訪」に割れて二重計上しないようにする。P9の cross-anon 束ねと整合させる。
- **検証方法**：「**同一人物が日を分けて3回LPに来てから予約**」する来訪群を作り、①`visit_count`/エピソード器を入れても**既存の単一行集計が後方互換で壊れない**か、②`journey` が per-person で**のべ3回・最終来訪◯日前**を正しく返すか、③**merge を跨いでエピソードが割れない/二重計上しない**か（匿名2回＋実名1回が“のべ3回・1人”に束なるか）、④P1単調増加・P9束ね・同意ゲート・テナントRLSをエピソード集計でも踏襲するか、⑤**P12の可視復帰リセットとP15のエピソード境界が同一往復で二重に走らない**かをE2Eで確認（メイン領分・1スタジオ目本番化時。P7〜P14の境界テストと同じ群で）。
- **優先度**：**P15（中）**——データ破損の防御ではなく“新しく測れる価値”の enrichment。再訪の厚み（マルチセッション購買・RFMの frequency/recency）は買う気の強いシグナルで、Loku は実名アンカー(friend_id)ゆえ**推測なしに「この実名客はのべ何回・最後にいつ来たか」を名指しで店主に返せる**＝GA4等の匿名セッション集計にない強み。件数だけだと「3回下見した優良客」を見逃す。実装は「既にある時刻から区切りを数え、journey に足す」＝中程度。judgment はDaiya。
- **位置づけ（起源地図の“交差”フロンティア第3回）**：ITP→P3・LTP→P5＝What、bfcache→P7・prerender→P8・背景タブ凍結→P12＝When、identity fragmentation→P9＝Who、value-based→P10＝How-much、zero-click/walled garden→P11＝Where——5軸一巡後の「軸の交差」フロンティアの第3回。Where×Who（P13＝面の道のり）→Where×How-much（P14＝面×価値）に続き、今回は宿題どおり**Where以外**を主役に **When×Who（ライフサイクルの区切り × 人への束ね）**を、起源掘り「なぜ“セッション（30分無操作で区切る1回の訪問）”という単位が生まれたか＝サーバログには“訪問”の塊が無く人工的に組み立てた」で照らした。**“来訪という塊(episode)”を匿名の集計から実名の人に紐づけて数え直す**交差点。次の交差候補＝How-much×Who（高価値客ほど束ね/再訪が効くか＝価値ティアと結合・再訪頻度の相互作用）／When×How-much（再訪の厚みが価値ティアを予告するか）。

## 追加の種（2026-08-01・目付第15回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5（起源クリックID非依存）・P3補遺(AFP)・P6（max_scroll_pct）・P7（bfcache復帰）・P8（先読み）・P9（複数匿名IDの束ね）・P10（成果の価値ティア）・P11（決断面surface＝bookingの“着地面”）・P12（可視復帰の時計）・P13（面の道のりsurface path＝journeyの“順路”）・P14（面×価値の効果台帳）・P15（来訪エピソード＝のべ回数/間隔）とは**重複しない新規種P16**。交差フロンティア第4回として、前回P15の締めが名指しした次候補どおり“How-muchを主役”に振り、**When（再訪の厚み＝P15のvisit_count/エピソード頻度）×How-much（その成果はどれだけの価値ティアか＝P10）**の交点＝**「何回も来直す“厚い”客ほど高価値ティア（本契約）になりやすいか」**を掘った。ビート2（OSS計測 PostHog Retention／Umami の cohort・retention＝返ってくる客をコホートで一級指標化）と広告界のRFM（recency/frequency/monetary）を入口に、現物 app.mjs の**効果台帳（cause-outcomes / change-outcomes）層**をgrepして当たった。**コードは触っていない。**

### 【P16・新規種／軸の交差 When×How-much】効果台帳（cause-outcomes / change-outcomes）を、booking の 再訪頻度(P15)×価値ティア(P10) で交差集計する“別ビュー”でも出し、「何回も来直す厚い客ほど高価値ティアを生むか」を実名クロスで答えられるようにする
- **現象**：現物の効果台帳は成果を**「予約の有無(1ビット)」だけ**で測る。`cause-outcomes`（app.mjs 788-807行）は原因コード別に `n` と `booked` を数え **`booked_rate`（805行）** を返すのみ、`change-outcomes`（810-840行）は baseline/treatment の **`booking_completed_rate`（831行）** を返すのみ——どちらも `store.bookings.has(fid)`（802/830行）＝**予約が起きたか否か**しか見ない。→ **「何回来てから予約したか（再訪の厚み＝P15）」も「その予約がどのくらいの価値か（ティア＝P10）」も台帳に載っていない**ため、「**3回下見してから本契約した厚い優良客**」と「**1回で体験だけ予約した薄い客**」が**同じ“予約1件”に潰れて**見え、「**厚い再訪が高価値を予告する**」という買う気の一級シグナルが店主のレポートから消える（例えると：常連になった通行人が3日通ってから高いコースを契約しても、売上台帳には“予約1件”とだけ記され、“3回通うほど本気になった”という熱の勾配が残らない）。
  - **現物確認①（目付がgrep）＝成果が1ビットで、頻度軸もティア軸も無い**：`cause-outcomes` は `rec = { cause_code, cause_label, n, booked }`（800行）に `booked++`（802行）で加算し `booked_rate = booked/n`（805行）を出すだけ＝**予約の有無の率**。`change-outcomes` の `summarize` は `booked = [...set].filter(fid => store.bookings.has(fid)).length`（830行）→ `booking_completed_rate`（831行）＝同じく**有無の率**。**どちらの出力にも「その friend_id が何回来訪したか（visit_count／エピソード数＝P15）」でバケツ分けする軸も、「予約がどの価値ティアか（P10）」で層別する軸も無い**＝頻度と価値を掛け合わせる“クロス表”を出す口が台帳に無い。
  - **現物確認②（当たり＝過剰批判はしない・現物読みで“既に堅い部分”を切り分け・11回連続）**：(1) 台帳の**器は同意ゲート（794/821行）＋テナントRLS（797/824行）＋friend重複除外（seen Set 792行）**で集計され安全（当たり）。(2) **因果は行動ベースで予約（成果）と独立**（app.mjs 224行コメント・causal.mjs 25行）＝成果側にティア/頻度を足しても因果ロジックを汚さない（当たり）。(3) 頻度そのものを“数える器”は**P15が別種で用意済み**、価値ティアは**P10が別種で用意済み**＝P16は**両者を掛け直す下流の集計軸**であって新しい生データを作らない（当たり）。(4) 生金額/決済/LTVには踏み込まず**店主が既に持つ粗いティア＋粗い頻度バケツ**で足りる（当たり）。よってP16の射程は「**効果台帳が予約の有無(1ビット)しか持たず、再訪頻度(P15)×価値ティア(P10)でクロス集計する出力が無い**」1点に絞る。
  - **他種との非重複（実装照合の要）**：**P10＝成果の価値ティア（How-muchの単軸・ティアを“作る”側）**／**P14＝Where(面surface)×How-much(ティア)＝面×価値の台帳**／**P15＝When×Who＝来訪エピソードの“のべ回数/間隔”を数える器（頻度を“作る”側）**——いずれとも別レイヤー。**P16＝When(頻度＝P15が作った visit_count)×How-much(ティア＝P10が作った tier)** を**同じ効果台帳の第2・第3軸で掛け合わせる**位置づけ。P14が「面×価値」で掛けたのと**同じ台帳・同じ Map 器**を使うが、掛ける軸が**面(surface)ではなく再訪頻度(visit_count)**＝別クロス。P15が“頻度を数える器”を作り、P16がその頻度を“価値ティアと掛ける”下流の出し分け——実装時は **P10/P11/P13/P14/P15 と同じ surface/tier/visit_count 語彙・同じ Map 器に相乗り**させ二重定義しないことだけ確認すればよい。
- **根拠URL（現物＝目付grep・機構＝S/A、数字＝B）**：
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（`cause-outcomes` 788-807行・`booked_rate` 805／`change-outcomes` 810-840行・`booking_completed_rate` 831／`store.bookings.has(fid)` 802・830／同意 794・821／RLS 797・824／seen Set 792／因果は予約と独立 224行）・causal.mjs 25行
  - RFM（S・学術一次・frequency/recency が monetary value を予告するの定式化＝Bult & Wansbeek 1995 "Optimal Selection for Direct Mail", Marketing Science／Pareto 80/20 の裏付け） https://www.techtarget.com/searchdatamanagement/definition/RFM-analysis
  - PostHog Retention（A・一次docs・first-time/recurring retention・new vs returning を anti-cohort で層別＝返ってくる客をコホートで一級指標化） https://posthog.com/docs/product-analytics/retention
  - Umami（A・GitHub一次・v3.0.0 で cohort 導入「共通イベントを持つ利用者群を経時追跡」・v3.2.0=2025-06-24 に Retention report） https://github.com/umami-software/umami/releases
  - 業界数字/物差し（B・業態差あり・恒久採用しない）：再訪客CVRは新規の2〜3倍（〜9x購買可能性）・既存客成約60〜70% vs 新規5〜20%・マルチセッション購買＝中価格帯2〜4/高額帯5〜7回超 https://www.growthsuite.net/resources/shopify-conversion-rate/traffic-source-conversion/returning-visitor ／ RFM 2026＝frequencyは習慣化/ロイヤルティの予告子 https://www.digitalapplied.com/blog/rfm-segmentation-2026-ecommerce-customer-framework
- **対策案（コード無変更・設計材料）**：
  - **(a) 効果台帳に visit_count(P15) を離散バケツで第2軸、tier(P10) を第3軸として任意で足す**：`cause-outcomes`／`change-outcomes` の集計時に、その friend_id の **再訪回数を店主区分の粗いバケツ（例：1回／2〜3回／4回以上）** に落として層別し、成果を **予約有無だけでなく価値ティア（体験/本契約/継続）** でも数える。→ 「**4回以上来た群の本契約率 vs 1回群**」のクロス表を返せる。**新しい数字は作らず、P15が数えた頻度とP10が付けたティアを掛け直すだけ**。
  - **(b) 件数率は後方互換で残す（別ビュー）**：既存の `booked_rate`（805行）・`booking_completed_rate`（831行）は**そのまま残し**、頻度×ティアのクロスは**任意パラメータ付きの別ビュー**として足す。`visit_count`／`tier` を持たない既存 booking は従来どおり集計されること。
  - **(c) “厚い再訪→高価値”を実名で見分ける＝junk-leads の逆側も捕捉**：件数だけだと「浅い1回客ばかり増やす打ち手」を改善と誤判定しうる（P10の指摘）。P16は逆に「**厚い再訪客が本契約に化ける**」打ち手を、実名アンカー(friend_id)で**推測なしに**浮かせる。「3回通った人ほど高ティア」を店主に名指しで返せる。
  - **(d) 数字を作らない＝頻度バケツ閾値は店主区分／生LTVには踏み込まない**：頻度バケツの境目は**店主が既に持つ常識**（RFM もそもそも quintile＝相対分位で絶対値を発明しない）に寄せ、恣意的な回数しきい値を作らない。生LTV/決済/来店金額との結合は**同意設計＝見廻り(lp-mimawari)申し送り**。P10/P11/P13/P14/P15 と同じ surface/tier/visit_count 語彙・同じ Map 器に相乗りし二重定義しない。
- **検証方法**：「**1回で予約**」「**3回来てから予約（厚い）**」「**3回来て未予約**」の3群を作り、①`visit_count`／`tier` を持たない既存 booking で集計しても **`booked_rate`／`booking_completed_rate` が後方互換で壊れない**か、②頻度バケツ×ティアのクロスで「**4回以上群の高ティア率＞1回群**」を正しく出し分けるか（件数率は横ばいでも厚い群の高価値を捕捉）、③**merge(P9) を跨いで頻度が割れない**（匿名2回＋実名1回が“のべ3回・1人”として同じバケツに入る）か、④**テナント越境RLS・同意ゲート**を頻度×価値集計でも踏襲するか、⑤**P10/P11/P13/P14/P15 と同じ Map 器・語彙**で二重定義せず衝突しないかをE2Eで確認（メイン領分・1スタジオ目本番化時。P7〜P15の境界テストと同じ群で。tier/visit_count は既存 booking への“任意の後埋め名札”＝実装は軽い）。
- **優先度**：**P16（中）**——データ破損の防御ではなく“新しく測れる価値”の enrichment。RFM の「**frequency（何回来たか）が monetary value（どれだけの価値になるか）を予告する**」は通販が郵送コストを削るために発見した経験則で、Loku は**実名アンカー(friend_id)ゆえ匿名コホート推定ではなく「この実名客はのべ◯回来て、結果◯ティアになった」を名指しで束ねられる**＝GA4等の匿名 retention コホートにない強み。件数だけだと「厚い再訪の優良客」も「浅い1回客」も同じ“予約1件”に潰れる。実装は「P15の頻度とP10のティアを既存台帳で掛け直す」＝中程度。judgment はDaiya。
- **位置づけ（起源地図の“交差”フロンティア第4回）**：ITP→P3・LTP→P5＝What、bfcache→P7・prerender→P8・背景タブ凍結→P12＝When、identity fragmentation→P9＝Who、value-based→P10＝How-much、zero-click/walled garden→P11＝Where——5軸一巡後の「軸の交差」フロンティアの第4回。Where×Who（P13）→Where×How-much（P14）→When×Who（P15）に続き、今回は前回P15の締めが名指しした次候補どおり**How-muchを主役**に **When×How-much（再訪の厚み × 価値ティア）**を、起源掘り「なぜRFM＝“頻度が価値を予告する”は生まれたか＝通販/ダイレクトメールが“全員に郵送するとコストで潰れる”ので過去の購買頻度で当てる必要から Bult & Wansbeek 1995 が最適選抜を定式化」で照らした。**“厚い再訪”という買う気のシグナルを、匿名コホートの近似でなく実名の人に紐づけて価値と掛け直す**交差点。残る交差候補＝**How-much×Who**（高価値客ほど束ね/結合が効くか＝価値ティアP10 × 結合P9）／**Where×When**（面×ライフサイクル区切り）。


## 追加の種（2026-08-02・目付第16回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5（起源クリックID非依存）・P3補遺(AFP)・P6（max_scroll_pct）・P7（bfcache復帰）・P8（先読み）・P9（複数匿名IDの束ね）・P10（成果の価値ティア）・P11（決断面surface＝bookingの“着地面”）・P12（可視復帰の時計）・P13（面の道のりsurface path＝journeyの“順路”）・P14（面×価値の効果台帳）・P15（来訪エピソード＝のべ回数/間隔）・P16（頻度×価値の効果台帳）とは**重複しない新規種P17**。交差フロンティア第5回として、前回P16の締めが名指しした残り候補どおり、かつ「4回離した決断面(Where)を主役に戻す」テーマローテーション指示どおりに **Where（P11＝決断がどの面で起きたか）×When（P15＝何回目の来訪で起きたか）** の交点＝**「決断面は再訪を重ねるほどどこへ移るか＝どの面がどの来訪回で本予約を決めるか」**を掘った。ビート3（決断面の移動）とビート2（マルチタッチ・アトリビューション＝first-touch/last-touchで面が変わる）を入口に、現物 app.mjs の**効果台帳（cause-outcomes / change-outcomes）層**をgrepして当たった。**コードは触っていない。**

### 【P17・新規種／軸の交差 Where×When】効果台帳（cause-outcomes / change-outcomes）を、booking の 決断面(surface=P11)×再訪頻度(visit_count=P15) で交差集計する“別ビュー”でも出し、「決断面は来訪を重ねるほどどこへ移るか（どの面がどの来訪回で予約を決めるか）」を実名クロスで答えられるようにする
- **現象**：現物の効果台帳は成果を**「予約の有無(1ビット)」だけ**で測る。`cause-outcomes`（app.mjs 788-807行）は原因コード別に `n` と `booked` を数え **`booked_rate`（805行）** を返すのみ、`change-outcomes`（810-842行）は baseline/treatment の **`booking_completed_rate`（831行）** を返すのみ——どちらも `store.bookings.has(fid)`（802/830行）＝**予約が起きたか否か**しか見ない。→ **「その予約がどの面で決まったか（決断面surface＝P11）」も「何回目の来訪で決まったか（visit_count＝P15）」も台帳に載っていない**ため、「**初回にLP内CTAで即決した客**」と「**3回下見してから4回目にLINEリッチメニューで決めた客**」が**同じ“予約1件”に潰れて**見え、「**面は再訪を重ねるほどLPからLINE（会話面）へ移る**」という決断面の移動そのものが店主のレポートから消える（例えると：常連が3日通ってから店頭でなくLINEのメニューから予約しても、売上台帳には“予約1件”とだけ記され、“通うほど決める場所が店頭からスマホの中へ移った”という導線の変化が残らない）。
  - **現物確認①（目付がgrep）＝成果が1ビットで、面軸も来訪回軸も無い**：`cause-outcomes` は `rec = { cause_code, cause_label, n, booked }`（800行）に `booked++`（802行）で加算し `booked_rate = booked/n`（805行）を出すだけ＝**予約の有無の率**。`change-outcomes` の `summarize` は `booked = [...set].filter(fid => store.bookings.has(fid)).length`（830行）→ `booking_completed_rate`（831行）＝同じく**有無の率**。**どちらの出力にも「その予約がどの決断面(surface＝P11)で起きたか」で分ける軸も、「何回目の来訪(visit_count＝P15)で起きたか」でバケツ分けする軸も無く**、面と来訪回を掛け合わせる“クロス表”を出す口が台帳に無い。
  - **現物確認②（当たり＝過剰批判はしない・現物読みで“既に堅い部分”を切り分け・12回連続）**：(1) 台帳の**器は同意ゲート（794/821行）＋テナントRLS（797/824行）＋friend重複除外（seen Set 792行）**で集計され安全（当たり）。(2) **因果は行動ベースで予約（成果）と独立**（app.mjs 224行コメント・causal.mjs 25行）＝成果側に面/来訪回を足しても因果ロジックを汚さない（当たり）。(3) 決断面そのものを“付ける器”は**P11が別種で用意済み**、来訪回を“数える器”は**P15が別種で用意済み**＝P17は**両者を掛け直す下流の集計軸**であって新しい生データを作らない（当たり）。(4) off-LP面（GBP/電話/IG DM）は推測せず**unknown**で正直に（P11の見切りを踏襲）＝外部API連携・電話計測は**見廻り申し送り**（当たり）。よってP17の射程は「**効果台帳が予約の有無(1ビット)しか持たず、決断面(P11)×再訪頻度(P15)でクロス集計する出力が無い**」1点に絞る。
  - **他種との非重複（実装照合の要）**：**P11＝bookingに決断面surfaceを付ける（Whereの単軸・“着地面”を作る側）**／**P13＝journeyに面の順路(surface path)を刺す＝“1回の来訪の中での面の順番”**／**P14＝Where(面surface)×How-much(ティア)＝面×価値の台帳**／**P15＝When×Who＝来訪エピソードの“のべ回数/間隔”を数える器（頻度を作る側）**／**P16＝When(頻度)×How-much(ティア)＝頻度×価値の台帳**——いずれとも別レイヤー。**P17＝Where(面＝P11が作ったsurface)×When(来訪回＝P15が作ったvisit_count)** を**同じ効果台帳の第2・第3軸で掛け合わせる**位置づけ。P13の“面の順路”は**同一ジャーニー内**の面の並び（P13）だが、P17は**日をまたぐ別々の来訪エピソード（P15）ごとに“どの面で決めたか”**を並べる＝別クロス。P14/P16が同じ台帳・同じ Map 器で「面×価値」「頻度×価値」を掛けたのと**同じ台帳・同じ Map 器**を使うが、掛ける2軸が**面(surface)×再訪頻度(visit_count)**＝効果台帳クロス立方体（surface/tier/visit_count の3軸）の**残る一面**（P14=面×価値・P16=頻度×価値・P17=面×頻度で立方体が揃う）。実装時は **P10/P11/P13/P14/P15/P16 と同じ surface/tier/visit_count 語彙・同じ Map 器に相乗り**させ二重定義しないことだけ確認すればよい。
- **根拠URL（現物＝目付grep・機構＝S/A、数字＝B）**：
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（`cause-outcomes` 788-807行・`booked_rate` 805／`change-outcomes` 810-842行・`booking_completed_rate` 831／`store.bookings.has(fid)` 802・830／同意 794・821／RLS 797・824／seen Set 792／因果は予約と独立 224行）・causal.mjs 25行
  - マルチタッチ・アトリビューション（A・first-touch と last-touch では“クレジットを受ける面”が違う＝面は来訪/接点を重ねるほど移る、が業界の出発点。1990年代末last-click100%→2000年代半ばに他接点も貢献と認識→first/last rule-based→MTA） https://www.nielsen.com/insights/2019/methods-models-a-guide-to-multi-touch-attribution/
  - McKinsey Consumer Decision Journey / loyalty loop（B・検討は探索→再訪→決定と面をまたいで進み、ロイヤルティ段階では決断面がループ内側＝会話/直接面へ寄る） https://umbrex.com/resources/frameworks/marketing-frameworks/mckinsey-consumer-decision-journey-loyalty-loop/
  - 業界物差し（B・業態差あり・恒久採用しない）：オムニチャネルは「探索→再訪→遅延決定を面をまたいで繰り返す」・再訪ほど評価/決定フェーズの面へ予算/接点が移る https://juiceddigital.com/omnichannel-customer-journey/ ／ RFMのrecency/frequencyはロイヤルティ・チャネル選好の予告子 https://www.omniconvert.com/blog/rfm-model/
- **対策案（コード無変更・設計材料）**：
  - **(a) 効果台帳に surface(P11) を第2軸、visit_count(P15) を離散バケツで第3軸として任意で足す**：`cause-outcomes`／`change-outcomes` の集計時に、その予約が**どの決断面(lp_cta/line_richmenu/line_miniapp/phone/instagram_dm/gbp/unknown＝P11の語彙)**で起きたかと、その friend_id の**再訪回数を店主区分の粗いバケツ（例：1回目／2〜3回目／4回目以降）**に落として層別する。→ 「**1回目の予約はLP内CTAが◯%・4回目以降の予約はLINEリッチメニューが◯%**」という面×来訪回のクロス表を返せる＝**決断面の移動を来訪回の軸で可視化**。**新しい数字は作らず、P11が付けた面とP15が数えた回数を掛け直すだけ**。
  - **(b) 件数率は後方互換で残す（別ビュー）**：既存の `booked_rate`（805行）・`booking_completed_rate`（831行）は**そのまま残し**、面×来訪回のクロスは**任意パラメータ付きの別ビュー**として足す。`surface`／`visit_count` を持たない既存 booking は従来どおり集計されること。
  - **(c) “面の移動”を実名で見分ける＝決断面が動いても取りこぼさない**：件数だけだと「LP内CTAの予約が減った」を打ち手の失敗と誤判定しうるが、実際は**同じ客が再訪を重ねてLINEリッチメニューで決めるようになった＝決断面の移動**かもしれない。P17は実名アンカー(friend_id)で「**初回LP→4回目LINE**」の面移動を**推測なしに**浮かせ、面ブラインドの件数台帳では“予約減”に見える現象を「面が移っただけで総予約は健在」と正しく読み替えられる。Loku戦略「面がどこに移っても測る」の効果台帳版。
  - **(d) 数字を作らない＝取れない面はunknown／頻度バケツ閾値は店主区分**：off-LP面（GBP/電話/IG DM）は**推測で埋めずunknown**（P11の見切り踏襲）。頻度バケツの境目は**店主が既に持つ常識**に寄せ恣意的な回数しきい値を作らない。外部プラットフォーム(GBP/IG API・電話計測)連携と生LTV結合の同意設計は**見廻り(lp-mimawari)申し送り**。P10/P11/P13/P14/P15/P16 と同じ surface/tier/visit_count 語彙・同じ Map 器に相乗りし二重定義しない。
- **検証方法**：「**1回目の来訪でLP内CTAで予約**」「**3回下見して4回目にLINEリッチメニューで予約**」「**GBP経由で来て面unknownのまま予約**」の3群を作り、①`surface`／`visit_count` を持たない既存 booking で集計しても **`booked_rate`／`booking_completed_rate` が後方互換で壊れない**か、②面×来訪回のクロスで「**初回群はLP内CTA優位・4回目以降群はLINEリッチメニュー優位**」を正しく出し分けるか（件数率は横ばいでも面の移動を捕捉）、③**merge(P9) を跨いで来訪回が割れない**（匿名2回＋実名1回が“のべ3回・1人”として同じバケツに入り面も継承）か、④off-LP面が推測で埋まらず**unknown**になるか、⑤**テナント越境RLS・同意ゲート**を面×来訪回集計でも踏襲するか、⑥**P10/P11/P13/P14/P15/P16 と同じ Map 器・語彙**で二重定義せず衝突しないかをE2Eで確認（メイン領分・1スタジオ目本番化時。P7〜P16の境界テストと同じ群で。surface/visit_count は既存 booking への“任意の後埋め名札”＝実装は軽い）。
- **優先度**：**P17（中）**——データ破損の防御ではなく“新しく測れる価値”の enrichment。マルチタッチ・アトリビューションが生まれた理由そのもの（**first-touch と last-touch では決断面が違う＝面は来訪を重ねるほど移る**）を、Loku は**実名アンカー(friend_id)ゆえ確率モデルの推測ではなく「この実名客は1回目LPで迷い、4回目にLINEで決めた」を名指しで束ねられる**＝GA4等の匿名マルチタッチ・モデルにない強み。面ブラインドの件数台帳だと「決断面の移動」が“ただの予約増減”に見えて打ち手判断を誤る。実装は「P11の面とP15の来訪回を既存台帳で掛け直す」＝中程度。judgment はDaiya。
- **位置づけ（起源地図の“交差”フロンティア第5回・効果台帳クロス立方体が揃う）**：ITP→P3・LTP→P5＝What、bfcache→P7・prerender→P8・背景タブ凍結→P12＝When、identity fragmentation→P9＝Who、value-based→P10＝How-much、zero-click/walled garden→P11＝Where——5軸一巡後の「軸の交差」フロンティアの第5回。Where×Who（P13）→Where×How-much（P14）→When×Who（P15）→When×How-much（P16）に続き、今回は前回P16の締めが名指しした残り候補どおり、かつ決断面(Where)を4回離して主役に戻し **Where×When（決断面 × 再訪回）**を、起源掘り「なぜマルチタッチ・アトリビューション(first-touch/last-touch)は生まれたか＝1990年代末last-click100%クレジットの過大評価を、2000年代半ばに“他の接点も貢献している”と業界が認識して面ごとにクレジットを割った」で照らした。**“決断面の移動”という面の勾配を、確率モデルの推測でなく実名の人の来訪回に紐づけて描き直す**交差点。**これで効果台帳のクロス立方体（surface/tier/visit_count の3軸＝P14面×価値・P16頻度×価値・P17面×頻度）が揃った**。残る交差候補＝**How-much×Who**（高価値客ほど束ね/結合が効くか＝価値ティアP10 × 結合P9）が未踏の最後の1組。

## 追加の種（2026-08-03・目付第17回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5（起源クリックID非依存）・P3補遺(AFP)・P6（max_scroll_pct）・P7（bfcache復帰）・P8（先読み）・P9（複数匿名IDの束ね）・P10（成果の価値ティア）・P11（決断面surface＝bookingの“着地面”）・P12（可視復帰の時計）・P13（面の道のりsurface path＝journeyの“順路”）・P14（面×価値の効果台帳）・P15（来訪エピソード＝のべ回数/間隔）・P16（頻度×価値の効果台帳）・P17（面×来訪回の効果台帳）とは**重複しない新規種P18**。交差フロンティア第6回（最後の1組）として、前回P17の締めが名指しした残り候補どおり、かつ「今回はWho or How-muchを主役に」というテーマローテーション指示どおりに **How-much（P10＝どれだけの価値ティアか）×Who（P9＝何本の匿名接点を1人に束ねたか＝結合の厚み）** の交点＝**「価値の高い客ほど、束ね（結合）が効いているか＝分断した匿名ジャーニーを縫い合わせる工程が、どの価値ティアで一番働いているか」**を掘った。ビート1（identity fragmentation＝計測精度の敵）とビート2（identity resolution／single customer view）を入口に、現物 app.mjs の**結合層（merge）×効果台帳層（cause-outcomes / change-outcomes）**をgrepして当たった。**コードは触っていない。**

### 【P18・新規種／軸の交差 How-much×Who】効果台帳を、booking の 価値ティア(tier=P10)×結合の厚み(merge-degree＝1 friend_id が束ねた匿名IDの本数=P9) で交差集計する“別ビュー”でも出し、「価値の高い客ほど結合(束ね)が効いているか＝分断ジャーニーの縫い合わせがどの価値ティアで一番働くか」を実名クロスで答えられるようにする
- **現象**：現物の結合層は「複数の匿名接点を1人の friend_id に畳む」までは持つ（`POST /api/attn/merge`）が、効果台帳（cause-outcomes / change-outcomes）は集計時に **friend_id を `seen` Set で1人=1にデデュープ（792/794-795行）** し、**「その1人が“何本の匿名IDから束ねられたか(結合の厚み)”を捨てる**。→ **「1本の匿名IDでそのまま実名化した客（縫い合わせ不要）」と「3本の匿名断片（別端末＋ITP7日揮発で割れた）を束ねて初めて1人になった客（縫い合わせが濃厚に効いた客）」が同じ“1人”に潰れて**見え、しかも成果は `store.bookings.has(fid)`＝**予約の有無(1ビット)**しか持たないため、**「価値の高い客ほど、束ねの工程が仕事をしているのか」＝結合(P9)の“価値ティア別ROI”が台帳から一切見えない**（例えると：常連客ほどスマホ・タブレット・店頭とバラバラの窓口から来て“別人の顔”で現れるのに、会員台帳では「会員1人・来店1回」とだけ記され、“この上客は実は4つの顔を1人に縫い合わせて初めて見えた客だ＝縫い合わせを失えばこの上客の全体像ごと消える”という縫合の手柄が残らない）。
  - **現物確認①（目付がgrep）＝結合の厚みがデデュープで捨てられ、価値軸も無い**：`cause-outcomes`（app.mjs 788-807行）は `for (const [, id] of store.identity)`（793行＝anon→friend の全対を走査）しながら `if (!id.consented || seen.has(id.friend_id)) continue; seen.add(id.friend_id)`（794-795行）で**friend_id 単位に1回だけ数える**＝**同一 friend_id に紐づく匿名IDの“本数”は数えず捨てる**。`change-outcomes`（810-842行）も baseline/treatment を `Set<friend_id>`（819・825-826行）で持ち同様にデデュープ。成果は両者とも `store.bookings.has(fid)`（802・830行）＝**予約の有無の率**（`booked_rate` 805／`booking_completed_rate` 831）。**どちらの出力にも「その予約が“何本の匿名断片を束ねた客”のものか（merge-degree＝Whoの厚み）」で分ける軸も、「どの価値ティア(tier=P10)か」で層別する軸も無く**、価値×結合の厚みを掛け合わせる“クロス表”を出す口が台帳に無い。※`store.identity`（anon→friend の Map）を friend_id で GROUP して各群の要素数を数えれば merge-degree は**既存データから導出可能**なのに、効果台帳は 794-795 行でそれを1に潰して捨てている＝新データ収集は不要。
  - **現物確認②（当たり＝過剰批判はしない・現物読みで“既に堅い部分”を切り分け・13回連続）**：(1) 結合そのものは**idempotent で重複行を作らず（344-346行コメント＋`store.identity.set` 上書き）**、同意由来（consent_record）も merge 時に記録（333-346行）＝**束ねる器は堅い**（当たり＝P9で確定済み）。(2) 台帳の**器は同意ゲート（794/821行）＋テナントRLS（797/824行）＋friend重複除外（seen Set 792行）**で安全（当たり）。(3) **因果は行動ベースで予約（成果）と独立**（app.mjs 224行・causal.mjs 25行）＝成果側に価値ティアや結合の厚みを足しても因果ロジックを汚さない（当たり）。(4) 価値ティアを“付ける器”は**P10が別種で用意済み**、結合そのもの（複数匿名IDの束ね）は**P9が別種で用意済み**＝P18は**両者を掛け直す下流の集計軸**であって新しい生データを作らない（当たり）。(5) 7日超前・別端末は**構造的に辿れない天井**（P3/P9の見切り踏襲）＝merge-degree は「辿れた範囲の本数」であり全接点の網羅ではない（正直に据える）。よってP18の射程は「**効果台帳がfriend_idを1にデデュープして結合の厚み(匿名IDの本数)を捨て、価値ティア(P10)×結合の厚み(P9)でクロス集計する出力が無い**」1点に絞る。
  - **他種との非重複（実装照合の要）**：**P9＝複数匿名IDを1 friend_id に束ねる“結合そのもの”を作る側（Whoの器）**／**P10＝bookingに価値ティアを付ける（How-muchの単軸を作る側）**／**P13＝journeyに面の順路（Where×Who）**／**P14＝面×価値（Where×How-much）**／**P15＝来訪エピソードの“のべ回数/間隔”を数える器（When×Who＝“再訪の回数”を作る側）**／**P16＝頻度×価値（When×How-much）**／**P17＝面×来訪回（Where×When）**——いずれとも別レイヤー。**P18＝How-much（価値ティア＝P10が作った tier）×Who（結合の厚み＝P9が束ねた匿名IDの“本数”＝merge-degree）** を**同じ効果台帳の第2・第3軸で掛け合わせる**位置づけ。**⚠️最重要の非重複**：P18の“Who軸”＝**merge-degree（1人が何本の匿名断片から縫い合わされたか＝身元の分断の深さ）**は、**P15の“When軸”＝visit_count（同一人物が何回来訪したか＝行動の再訪回数）とは別物**。1本の匿名IDのまま3回来た客（visit_count=3・merge-degree=1）も、3本の匿名断片を1回ずつ束ねた客（visit_count=3?・merge-degree=3）もあり得る＝**「再訪の回数」と「縫い合わせた断片の本数」は独立**。P18は後者（縫合の厚み）を価値ティアと掛ける。P14/P16/P17が effect-台帳クロス立方体（surface/tier/visit_count）を作ったのに対し、**P18は立方体の“外”＝結合の厚み(merge-degree)という新しい第4の軸を価値ティアと掛ける**（{Where/When/Who/How-much}の6ペアの最後の1組＝How-much×Who）。実装時は **P9のstore.identity から friend_id 別 anon 本数を導出し、P10のtier語彙・同じ Map 器に相乗り**させ二重定義しないことだけ確認すればよい。
- **根拠URL（現物＝目付grep・機構＝S/A、数字＝B）**：
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（`merge` 323-357行・`store.identity.set` 346／`cause-outcomes` 788-807行・`for (const [, id] of store.identity)` 793・`seen.has(id.friend_id)`/`seen.add` 794-795・`booked_rate` 805／`change-outcomes` 810-842行・`Set<friend_id>` 819/825-826・`booking_completed_rate` 831／`store.bookings.has(fid)` 802・830／同意 794・821／RLS 797・824／因果は予約と独立 224行）・causal.mjs 25行
  - 高価値客ほど身元が分断される（B・業界複数一致・“見込み客がスマホで広告→仕事用ノートでブログ→自宅PCでウェビナー→タブレットでデモ申込＝多くの解析は4人の別訪問者に見える”＝上客ほど長く多デバイスの検討で分断が深い） https://www.cometly.com/post/attribution-for-high-ticket-products ／ 高価値客はマルチタッチで関与が厚い https://www.useproactiveai.com/blog/high-value-customers/
  - 確定的(deterministic)結合＝認証キー(email/電話/ログイン/会員ID)は確実だが解けるのは認証済みの一部・匿名は解けない（B・英大手食品小売はロイヤルティ会員の約40%までしかデジタル到達できず、来店取引を照合して初めて75%超へ拡張＝“束ねの成否が価値の見え方を左右する”実例） https://cdp.com/glossary/identity-resolution/ ／ https://www.metarouter.io/post/what-is-identity-resolution
  - 2026の到達点＝quality over quantity（B・過剰結合は別人を1人に潰し誤クレジットを生む＝confidence/suppression/QAが要る。Lokuのfriend_id確定アンカーはこの害を構造回避） https://www.opensend.com/post/cross-broser-identity-tools-ecommerce ／ match rate 目安: 確定60-80%・+推測で85-95%（媒体差B・恒久採用しない） https://www.saber.app/glossary/identity-stitching
- **対策案（コード無変更・設計材料）**：
  - **(a) 効果台帳に tier(P10) を第2軸、merge-degree(P9) を離散バケツで第3軸として任意で足す**：`cause-outcomes`／`change-outcomes` の集計時に、その予約の friend_id が**どの価値ティア(体験/本契約/継続＝P10の語彙)**かと、その friend_id に **`store.identity` で紐づく匿名IDの本数を店主区分の粗いバケツ（例：1本＝縫合なし／2本／3本以上＝縫合が濃厚に効いた）** に落として層別する。→ 「**本契約(高ティア)の予約は◯%が“3本以上を束ねた客”・体験(低ティア)は◯%が“1本のまま”**」という価値×結合の厚みのクロス表を返せる＝**結合(P9)がどの価値ティアで一番働いているかを可視化**。**新しい数字は作らず、P10が付けたティアとP9が既に持つ匿名IDの本数を掛け直すだけ**。
  - **(b) 件数率は後方互換で残す（別ビュー）**：既存の `booked_rate`（805行）・`booking_completed_rate`（831行）は**そのまま残し**、価値×結合の厚みのクロスは**任意パラメータ付きの別ビュー**として足す。`tier`／merge-degree を持たない既存 booking は従来どおり集計されること。
  - **(c) “上客ほど縫合が効く”を実名で見分ける＝結合失敗が高価値側に偏っていないかを監視**：件数だけだと「結合(merge)の取りこぼし」が成果に見えないが、実際は**縫い合わせに失敗した匿名断片が孤児化し、その裏で高価値客の全体像が割れている**かもしれない。P18は「**高ティアの成約ほど、実は複数断片の束ねに支えられている**」を実名で浮かせ、逆に「**高ティア側で merge-degree が不自然に低い（束ねられていない）**」＝結合の取りこぼしが上客に偏る危険信号を効果台帳の側から早期に読めるようにする。「上客ほど身元が分断される」（cometly B）＝**縫合の投資対効果が最も高いのは高価値ティア**という業界事実の、Loku効果台帳版。
  - **(d) 数字を作らない＝天井は正直に／バケツ閾値は店主区分**：merge-degree は**“辿れた範囲の匿名IDの本数”**であって全接点の網羅ではない（7日超前・別端末は構造的に辿れない＝P3/P9の見切り踏襲・過剰結合の推測はしない）。バケツの境目は**店主が既に持つ常識**に寄せ恣意的なしきい値を作らない。生LTV/金額結合・外部プラットフォーム連携の同意設計は**見廻り(lp-mimawari)申し送り**（価値は粗いティア止まり）。P9/P10/P13/P14/P15/P16/P17 と同じ tier 語彙・同じ Map 器・同じ `store.identity` から導出し二重定義しない。
- **検証方法**：「**1本の匿名IDのまま実名化して体験(低ティア)予約**」「**別端末＋ITP揮発で割れた3本の匿名断片を束ねて本契約(高ティア)予約**」「**2本を束ねたが未予約**」の3群を作り、①`tier`／merge-degree を持たない既存 booking で集計しても **`booked_rate`／`booking_completed_rate` が後方互換で壊れない**か、②価値×結合の厚みのクロスで「**高ティア群は“3本以上を束ねた客”の比率が高い＝上客ほど縫合が効いている**」を正しく出し分けるか（件数率は横ばいでも結合の価値別ROIを捕捉）、③**merge(P9) を跨いで結合の厚み(本数)が正しく数えられる**（匿名2本＋実名1回が“束ね本数=3・1人”として同じバケツに入る／visit_count＝再訪回数とは独立に数える）か、④7日超前・別端末が推測で埋まらず**辿れた本数のまま**（天井を正直に）か、⑤**テナント越境RLS・同意ゲート**を価値×結合集計でも踏襲するか、⑥**P9/P10/P13/P14/P15/P16/P17 と同じ Map 器・語彙**で二重定義せず衝突しないかをE2Eで確認（メイン領分・1スタジオ目本番化時。P7〜P17の境界テストと同じ群で。tier は既存 booking への“任意の後埋め名札”・merge-degree は `store.identity` からの導出＝実装は軽い）。
- **優先度**：**P18（中）**——データ破損の防御ではなく“新しく測れる価値”の enrichment。identity resolution／single customer view が生まれた理由そのもの（**同じ人がデバイス・接点ごとに別人に割れる＝上客ほど分断が深い**）を、Loku は**friend_id＝LINE友だち追加という確定アンカー1本ゆえ確率モデルの推測に頼らず**「この本契約客は実は3つの匿名断片を1人に縫い合わせて初めて見えた」を**名指しで束ねられる**＝2026業界が警戒する“過剰結合で別人を潰す誤クレジット”の害を構造回避しつつ、GA4等の匿名モデルにない強み。結合ブラインドの件数台帳だと「上客の縫合ROI」も「高価値側の結合取りこぼし」も見えず、束ねの工程(P9)への投資判断を誤る。実装は「P10のティアとP9の匿名IDの本数を既存台帳で掛け直す」＝中程度。judgment はDaiya。
- **位置づけ（起源地図の“交差”フロンティア第6回・最後の1組＝6ペア完了）**：ITP→P3・LTP→P5＝What、bfcache→P7・prerender→P8・背景タブ凍結→P12＝When、identity fragmentation→P9＝Who、value-based→P10＝How-much、zero-click/walled garden→P11＝Where——5軸一巡後の「軸の交差」フロンティアの第6回（最後）。Where×Who（P13）→Where×How-much（P14）→When×Who（P15）→When×How-much（P16）→Where×When（P17）に続き、今回は前回P17の締めが名指しした残りの最後の1組どおり、かつ「今回はWho or How-muchを主役に」というローテーション指示どおり **How-much×Who（価値ティア × 結合の厚み）**を、起源掘り「なぜ“単一顧客ビュー(Single Customer View)＝バラバラの接点を1人の1枚に畳む”という発想が生まれたか＝社内で別々の台帳に別人として散らばる同一客を確定キーでgolden recordに解決する土台の起源」で照らした。**“結合(縫い合わせ)そのものの価値”を、確率モデルの推測でなく実名の人の価値ティアに紐づけて測り直す**交差点。**これで {Where/When/Who/How-much} の6ペア（P13〜P18）が全て完了＝交差フロンティアは出尽くし**。次は鉄則どおり**一度ビート1の“生の計測精度”（bot/beacon/ITP/離脱時送信の新定石）へ単軸で戻るか、ビート2のOSS計測指標定義の深掘りへ**明確に舵を切る（同じ「軸の交差」メタテーマを6回やったので枯渇）。

## 追加の種（2026-08-04・目付第18回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5・P3補遺(AFP)・P6・P7・P8・P9・P10・P11・P12・P13〜P18（軸の交差6ペア）とは**重複しない新規種P19**、および**既実装 P2（bot除外・UA＋挙動）への追加観点**。第17回で交差フロンティア(P13〜P18)が6ペアで出尽くしたため、鉄則どおり**テーマを「軸の交差」から「ビート1＝生の計測精度」単軸へ明確に転換**。今回は**離脱時送信（sendBeacon）の2026版定石の再点検**を主題に、現物 index.html の離脱時フラッシュ(473行)をgrepして当たった。**コードは触っていない。**

### 【P19・新規種／ビート1 離脱時送信】離脱時フラッシュの `sendBeacon` の返り値(false)を見て、キュー溢れ／ペイロード64KiB超で黙って落ちた時に `fetch(keepalive:true)` へフォールバックする（＋ペイロードを軽量に保つ）
- **現象**：現物 index.html の `flush()`（465-476行）は離脱時（visibilitychange(hidden)主・pagehideフォールバック＝P0で実装済み）に `try{ navigator.sendBeacon(FLUSH_ENDPOINT, new Blob([flushPayload()],{type:'application/json'})); }catch(e){}` で送る（473行）。だが **`navigator.sendBeacon()` は「送信キューに載せられなかった時＝(1)ブラウザが保持中のビーコンの合計バイトが上限を超えた／(2)1本のペイロードが 64KiB を超えた 時」に、例外を投げるのではなく戻り値 `false` を返す**（＝「受け取れませんでした」の合図）。現状のコードは **`try/catch` で“投げられた例外”しか見ておらず、この `false` を完全に無視**している＝**「送れたつもりで、離脱直前の滞在・視線データが丸ごと静かに落ちる」**（例えると：閉店間際に「今日どこを見たか」のメモをポストに投げ込む時、投函口が満杯でメモが入らず床に落ちても、今のコードは“投げた”だけで確認せず立ち去る＝落ちた事実が誰にも残らない）。
- **根拠URL（S/A）**：
  - MDN `Navigator.sendBeacon`（S）：「確実性が要る所は sendBeacon を主に、非対応時のフォールバックを置く」「戻り値は、UA がビーコンをキューに載せられれば true、できなければ false」 https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon
  - Huli「The 64KiB Limitation of navigator.sendBeacon」（A・実装解析）：Chromium/WebKit とも sendBeacon（および fetch keepalive）に **64KiB のペイロード上限**を実装。上限超過で false を返す。**呼んだ直後に戻り値を確認し、false なら通常 fetch／リトライへフォールバックせよ** https://blog.huli.tw/2025/01/06/en/navigator-sendbeacon-64kib-and-source-code/
  - xgwang「You May Not Know Beacon」（A）：「sendBeacon が false を返したら、keepalive なし fetch や非同期 XHR へフォールバックするのが定石。離脱時保証は失うが通常セッションではデータを落とさない」 https://xgwang.me/posts/you-may-not-know-beacon/
- **対策案（コード無変更・設計材料）**：
  - **(a) 返り値をチェックし、false 時のみ fetch keepalive へフォールバック**：`flush()` を `var ok=false; try{ ok = navigator.sendBeacon(FLUSH_ENDPOINT, blob); }catch(e){}` にし、`if(!ok){ fetch(FLUSH_ENDPOINT,{method:'POST',body:flushPayload(),keepalive:true,headers:{'Content-Type':'application/json'}}).catch(function(){}); }` を置く。**sendBeacon は主のまま**＝**P0裏書き「離脱時送信は sendBeacon 主を維持し、安易に fetch keepalive へ乗り換えない」を堅持**し、keepalive は **false 時の“最後の砦”としてのみ**使う（矛盾しない）。
  - **(b) ペイロードを軽量に保って 64KiB 上限そのものを踏まない**：`flushPayload()`（465-468行）は box ごとに active_view/engagement/revisits を積む＝**box 数が増える／将来 P6(max_scroll)等でフィールドが増えると肥大**する。要約（重要 box のみ・丸め）や、大きい時は分割送信を検討。**sendBeacon の実体は `fetch(keepalive:true)` ＝keepalive 経路も同じ 64KiB 上限を共有**するので、フォールバックだけでなく“太らせない”のが本筋。
  - **(c) 受け口は既に単調増加マージ(P1)＝二重着信でも安全**：sendBeacon が実は届いていた上に fetch フォールバックも届く二重着信があっても、app.mjs collect は `Math.max` の単調増加マージ(P1)なので巻き戻らない＝**フォールバック併用は既存設計と衝突しない**。
- **検証方法**：①`flushPayload()` を意図的に 64KiB 超に膨らませた時／②送信中ビーコンのキューを満杯にした状況で、`sendBeacon` が false を返し **fetch keepalive フォールバックが発火して欠測しない**か、③フォールバックの二重着信でも **単調増加マージ(P1)で active_sec/box_stats が巻き戻らない**か、④LINE内WKWebView／モバイルSafari で「離脱二段(P0＝visibilitychange(hidden)＋pagehide)」と**二重に走っても冪等**か、をE2Eで確認（メイン領分・1スタジオ目本番化時・P7〜P18の境界テストと同じ本番タイミング）。
- **優先度**：**P19（中）**——現状 Loku の salon LP は box 約10個＝ペイロードは 64KiB に遠く**発火はまれ**だが、(1) 修正は数行で軽く、(2)「送れたつもりで静かに落ちる」は**欠測した事実すらログに残らない**目付が最も嫌う型の計測腐食で、(3) box 数増・フィールド追加で将来顕在化する。データ破損の“予防接種”。judgment はDaiya。
- **非重複（実装照合の要）**：**P0＝離脱時フラッシュの“送る仕組み”（二段発火＋sendBeacon）を入れた種（実装済✅）**／**P1＝受け口の単調増加マージ（実装済✅）**。**P19＝その sendBeacon が“実際に受理されたか”を戻り値で見て、落ちたら fetch keepalive で拾い直す**＝**P0の一段深い層（送信の成否の検知と回収）**。P0/P1 とは別レイヤーで、P0裏書き（sendBeacon 主・keepalive へ安易に乗り換えない）とも両立（keepalive は false 時のみ）。
- **位置づけ（テーマ転換・ビート1単軸 第1回）**：交差フロンティア(P13〜P18・6ペア)出尽くし後、鉄則「毎回同じテーマを繰り返さない」に従い**ビート1の生の計測精度へ単軸で復帰**した第1回。離脱時送信(sendBeacon)は P0 で“仕組み”を入れたが“成否の検知”は未装備だった＝定石内の深掘り。fetchLater(P4)は WebKit 未搭載のまま（26.6安定/27beta とも未搭載）ゆえ、当面 sendBeacon を堅くするのが正解。

### 【P2 への追加観点（拡張候補・新種ではない）】bot除外を UA＋挙動フラグ の二段から、「クラウドプロバイダ IP 帯の遮断」「1来訪あたりアクション上限」まで広げる余地
- **前提**：P2（bot除外）は**実装照合表で✅済み**（UA入口除外 `BOT_UA_RE`＋`suspect_bot` 挙動フラグ＋`bot-report` 件数可視化）。これは**新種ではなく、既実装 P2 の“現行定石に照らした拡張観点”**。今回ビート1単軸で bot 除外の現行定石を一次確認した副産物として記録する。
- **現象／根拠（A 一次）**：Cloudflare Radar（A）＝2026 Q2 で bot は全HTTP要求の 33.2%（前年30.4%）、HTML 要求の 57.5% が自動化（機械が過半）。**ただし主要 LLM クローラ（GPTBot/ClaudeBot/Perplexity/CCBot）は JavaScript を実行しない**（searchoptimo/digitalapplied・A→traced）＝**クライアントJS計測の loku-attn.js は tick も collect も踏まれず、これら bot の波には born で強い**。残る脅威は **JS を実行するブラウザ自動化AIエージェント（ヘッドレスChrome/Playwright/CDP駆動）**＝UA を偽装し `BOT_UA_RE` を抜け、素朴な「スクロール0/無操作」も欺きうる。Matomo（A・OSS実装者FAQ）は「JS トラッカーは JS 実行ブラウザの活動しか記録しない＝伝統的 bot は自動除外／高度な bot・ヘッドレスは JS を実行し人間に見える」と明言し、UA の外に **(a) ヘッドレス検知（navigator 兆候・UA偽装には無力）(b) クラウドプロバイダ IP 帯遮断（AWS/Azure/GCP/DigitalOcean/Oracle）(c) サーバ側ライブラリ検知（curl/Guzzle/Postman）(d) 1来訪あたりアクション上限（通常100〜300で頭打ち）** を Tracking Spam Prevention として持つ。PostHog（A）は **AIエージェントをトラフィックの独立クラス**として UA 分類。
  - Matomo Tracking Spam Prevention（A）: https://matomo.org/faq/how-to/block-spam-and-bot-traffic-with-tracking-spam-prevention/ ／ https://plugins.matomo.org/TrackingSpamPrevention
  - Cloudflare Radar Bots（A・33.2%/57.5%）: https://radar.cloudflare.com/bots ／ LLMクローラのJS非実行: https://searchoptimo.com/blog/do-ai-crawlers-render-javascript
- **対策案（コード無変更・設計材料）**：Loku の `BOT_UA_RE` は (c) の一部（curl/wget）を既にカバー・(a) は `suspect_bot` が近い。**未カバーは (b) クラウドIP帯 と (d) アクション上限**。主戦場（LINE→LP・モバイル実機）の正規客は**モバイルキャリア/家庭回線**から来る＝**データセンターIP からの collect はほぼ確実に自動化**。app.mjs collect で送信元 IP がクラウド帯なら `suspect_bot` 相当で隔離、「1匿名IDが短時間に不自然な回数 collect を叩く」上限（例：1来訪あたりアクション数）を足すと、**UA を偽装した JS 実行エージェントも“来る場所”と“叩く回数”で捕まえられる**＝P2 の穴（UA 偽装ヘッドレス）を塞ぐ次の一手。
- **検証方法**：クラウドIP帯の collect が `suspect_bot` として隔離され `bot-report` に残るか／アクション上限超の匿名IDが本番集計から外れ監査には残るか。
- **優先度**：**中〜低（P2 の enrichment）**。実装とQAはメイン領分、採否・優先度はDaiya。**⚠️見廻り申し送り**：(b) クラウドIP判定＝送信元 IP を条件に使うのは個人情報/プライバシー（IP アドレスの扱い）の観点があり得る＝可否・設計の線引きは法規制領分。

## 追加の種（2026-08-05・目付第19回巡回からの還流）

**前提**：以下は**新規P番号を起こさない**。既存 P15（来訪エピソード＝のべ回数/間隔）の**未指定だった「エピソード境界のギャップ閾値」に外部アンカーを与える追加観点**。前回（第18回）ビート1（離脱時送信/beacon）を離れ、鉄則のテーマローテーションで**ビート2＝計測ツールの指標“定義”の一次深掘り**へ振り、第16回以来ずっと持ち越していた宿題「visitの区切り（セッションタイムアウト）定義の一次」を消化した副産物として記録する。**コードは触っていない・実装照合表（P0-P3済）とも P4〜P19 とも重複しない（P15 の閾値“根拠づけ”＋取り違え防止に限定）。**

### 【P15 への追加観点（外部アンカー＋取り違え注意・新種ではない）】来訪エピソードの“境界ギャップ閾値”を「30分無操作＝業界横断の収束値・店主調整可」で埋め、`IDLE_MS`(25秒)との取り違えを実装照合の要にする
- **前提**：P15（来訪エピソードの数え上げ）は対策案(a)/(c)で「collect 時に前回 `last_seen_at` から一定ギャップを超えて戻ったらエピソード境界」と設計しつつ、**その“一定ギャップ”の具体値は意図的に空欄**（(c)「恣意的なセッション時間を発明しない・店主の区分＝日をまたいだら別来訪に寄せる」）にしていた。今回その空欄に、計測ツール業界一次から**外部の物差し**を与える。これは**新種ではなく P15 の閾値根拠づけ**。
- **現象／根拠（S/A 一次・3ツール独立収束）**：**「1回の来訪(visit/session)」を“無操作の空き時間(gap)”で区切る**のは計測ツール界の共通言語で、区切りの既定は**3ツールが独立に「30分の無操作」に収束**する：
  - **GA4（S・Google公式）**：セッションは `session_start` イベントで始まり、**30分の無操作で終了**（イベントごとに時計リセット）。既定30分は **5分〜7時間55分で調整可**（Admin→Data Streams）。 https://support.google.com/analytics/answer/12798876
  - **Plausible（A・docs）**：**「visit＝session。訪問者が着地した時に始まり、30分アクションが無いと終わる。1人が後で／別の日に戻れば複数visitになる」**（visitとsessionを明示的に同義で使用）。 https://plausible.io/docs/metrics-definitions ／ https://plausible.io/docs/dashboard-faq
  - **PostHog（A・docs）**：**「セッションは最初のイベントで始まり、30分の無操作で終わる」**。加えて**最長24時間で強制的に新セッション**、無操作の秒数は **`session_idle_timeout_seconds`** で設定可、同一ブラウザ・端末ならタブ跨ぎは1セッション。 https://posthog.com/docs/data/sessions
  - **出所（沿革）**：この「30分」は GA/GA4 以前の計測ソフト **Urchin（2000年代前半）の既定30分**に遡り、そのまま業界慣習値として受け継がれた（＝どれか1社の恣意でなく、20年以上の共通既定）。 https://support.google.com/urchin/answer/2605089
- **⚠️最重要の非重複メモ（実装照合の要）＝桁が3つ違う2つの時間を混同しない**：現物 index.html には既に **`IDLE_MS=25000`（25<b>秒</b>・289行）** があるが、これは**滞在秒 active_sec を数える時の「今この瞬間、活動しているか」の活動ゲート**（25秒無操作なら active_sec に加算しない／P6・P12の領分＝秒オーダー）であって、**来訪の区切り（エピソード境界＝分オーダー）とは無関係**。P15 のエピソード境界に **`IDLE_MS` を流用してはならない**：もし25秒を境界に使うと「**30秒読んで一息ついて、また読む**」だけで**1来訪が何十もの偽エピソードに割れ**、`visit_count` が異常膨張して「再訪の厚み」が逆に信用できない数字になる。**業界が「秒」でなく「30分」を来訪境界に置くのは、まさにこの誤分割を避けるため**。＝「滞在秒の活動ゲート(25秒)」と「来訪エピソードの境界(30分)」は**別レイヤー・別変数**として持つ。
- **対策観点（コード無変更・設計材料／P15 本体は変えない）**：
  - **(1) 既定＝30分無操作**：P15 のエピソード境界ギャップの**既定値を「30分無操作」**に置く。これは GA4/Plausible/PostHog が独立収束した業界値＝**恣意的発明でなく“妥当な既定”**として置ける（P15(c)「発明しない」と矛盾しない）。
  - **(2) 店主上書き可の二段**：GA4 が5分〜7時間55分で調整可にしているのと同じ思想で、**閾値を店主が動かせる設定値**にする。予約業（検討が日をまたぐ）は長め・都度消費は短め、と業態で最適が違う。P15 元案の「日をまたいだら別来訪」という粗い区分も、この設定の一つの選択肢として両立（“30分の細かい区切り”と“日境界の粗い区切り”を店主が選ぶ二段）。
  - **(3) `IDLE_MS`(25秒) 非流用の明示**：エピソード境界用の閾値変数を `IDLE_MS` とは**別に**持ち、コード・レビューで取り違えないよう明記。既にある `started_at`／`last_seen_at`（両端の時刻）の差分で判定でき、**新しい数字は作らない**。
- **検証方法**：P15 の検証群（「同一人物が日を分けて3回来てから予約」）に、①**30分超の空き**を挟んで戻った時／**日をまたいで**戻った時に別エピソードとして `visit_count` が増えるか（閾値が店主設定値で動くか）、②**負のテスト＝「30秒読み→一息→再読」で1来訪が複数エピソードに割れないか**（`IDLE_MS`=25秒を境界に誤流用していないことの確認）、③merge(P9)跨ぎでエピソードが割れない、④P12の可視復帰リセット(秒)とP15のエピソード境界(分)が同一往復で二重に走らない、を追加（メイン領分・1スタジオ目本番化時・P7〜P19と同じ群で）。
- **優先度**：**P15 と同じ中**（データ破損防御でなく“新しく測れる価値”の enrichment＋実装時の取り違え防止）。実装・QA・採否・優先度はメイン領分／Daiya。
- **位置づけ（テーマ転換・ビート2 指標定義 単軸）**：前回（P19・ビート1 離脱時送信）からローテーションし、ビート2＝計測ツールの**指標の“定義”**（session/visit の区切り）を一次で深掘り。engaged-time(P6)→visits(P15)→retention cohort(P16)→**session の区切り定義(今回)**とビート2「指標設計」鉱脈を継続。P15 の“交差フロンティア”本体には戻らず、その閾値の外部根拠づけに限定した。

---

## 追加の種（2026-08-06・目付第20回巡回からの還流）

**前提**：以下は**新規P番号を起こさない**。ビート3（決断面の移動＝GBP/LINE/Instagram の意思決定UIの変化）を久々に主役にした偵察の還流で、既存の **P11（決断面surface＝bookingの着地面）** と **P5（起源クリックID非依存化＝流入の紐付け）** への**追加観点（enrichment＋入口ブラインドの拡大への対処）**。実装照合表（P0-P3済）・P5・P6・P7〜P19 とは重複させない。**コードは触っていない。**

### 【P11 への追加観点＋P5 への波及（新種ではない）】LINE「ミニアプリタブ」新設で生まれた“LP非経由の到達路”を、決断面タグ(P11)と流入タグ(P5)の両方で正直に扱えるようにする

- **現象（ビート3・一次/準一次）**：LINEヤフーが **「ウォレットタブ」を「ミニアプリタブ」へ刷新**（2026年2月頃開始・3月から順次リリース）＝予約/会員証/EC等の“決断面”が、LINEアプリの**一級タブ（常設のディスカバリ棚）へ格上げ**。お気に入り登録・人気/カテゴリ別おすすめ・キャンペーンバナーから、**自店LP（1枚ページ）やリッチメニューを踏まずに、タブから直接ミニアプリ（予約面）へ着地する新経路**が生まれた。同時に、認証済ミニアプリのビジネスマネージャー組織連携／チャネル同意の簡略化が 2026-01-08 以降の日本の新規ミニアプリチャネルで必須化＝プラットフォームが“中の決断面”の入り口と同意を整流。
  - **3ビート横断で同方向**：GBP＝Business Messages完全終了（2024-07-31確定）＋2026年ローカルパックからワンタップ電話ボタン撤去（決断面がプロフィール奥へ後退）／Instagram＝bio最大5リンク＋comment-to-DM自動送信がMeta公式Graph APIで常態化（決断がbioからDM会話へ）。3プラットフォームがそろって「決断面を自分の内側・会話寄り・自前タブへ引き込む」。
- **現物確認（目付がgrep・過剰批判はしない）**：(1) `POST /api/attn/booking`（app.mjs 429-435行）は `{friend_id}` のみを受け `store.bookings.add(d.friend_id)`＝**“どの面で決めたか”を持たない**のは P11 で既特定（＝決断面ブラインド）。(2) 今回の新論点は**その一段手前＝「その面へ“どの到達路(reach path)”で来たか（LP経由/リッチメニュー経由/ミニアプリタブ発見経由）」を持たない**こと。(3) 流入 `entry_query/entry_pos/entry_health`（app.mjs 283-288行・P5が受け持つ）は、**タブ経由だと `entry_query/referrer` が空になりやすい**＝LP非経由のLINE内流入が増えるほど**入口ブラインドが拡大**。(4) ⚠️既存の `surface`（app.mjs 478-493行＝`/api/attn/product-events` / `product-funnel`＝**自己改善画面のステップ計測**）とは**別名前空間**（P14で確認済み）＝流用しない。
- **根拠URL（潮流＝S/一次寄り＋B、現物＝目付grep）**：
  - LINEヤフー株式会社（公式リリース S一次・本文403だが公式ドメインでタイトル/存在確定）「LINE、『ウォレットタブ』を『ミニアプリタブ』へ刷新」 https://www.lycorp.co.jp/ja/news/release/019865/ ／ ECのミカタ（B→traced・公式引用）https://ecnomikata.com/ecnews/ec_site_operation/48786/ ／ LINEヤフー for Business ミニアプリ4-6月まとめ（S公式column）https://www.lycbiz.com/jp/column/line-mini-app/service-information/mini_matome_202607/
  - Google for Developers「Update on Google Business Messages」（S仮）https://developers.google.com/business-communications/business-messages/resources/release-notes/update-on-gbm ／ GBP電話ボタン撤去2026（B）https://www.gosite.com/blog/google-business-profile-updates-removal-of-chat-and-call-history
  - Instagram Graph API comment-to-DM / bio最大5リンク（S寄り・機能／CV率はB）https://setsmart.io/blog/instagram-link-in-bio ／ https://www.truefuturemedia.com/articles/instagram-bio-optimization-2026
- **対策案（射程を絞る・2択を提示・採否はDaiya/メイン判断）**：新種P番号は起こさない。
  - **(a)** P11 の面 enum に `line_miniapp` の**到達路サブ属性**を任意で足す（例：`reach_path: lp / richmenu / miniapp_tab / unknown`）＝「面はどこで決めたか」と「その面へどう来たか」を二軸で分離。件数率は後方互換（reach_path なし＝従来集計に一致）。
  - **(b)** P5 側で「LP非経由のLINE内流入」を `entry_health` と同型の**入口フラグで正直にラベリング**（`entry_query/referrer` 空＝タブ発見経由の可能性を unknown で明示・推測で埋めない）。
  - いずれも **off-LP外部面（Instagram DM/GBP内予約）は推測で埋めず unknown**＝天井を正直に（P11の設計思想を踏襲）。**生金額/決済/同意設計は見廻り申し送り**。
- **検証方法**：実機E2E（メイン領分・1スタジオ目本番化時・P7〜P19と同じ群で）。①ミニアプリタブ→ミニアプリ→予約が `reach_path=miniapp_tab` で記録され unknown に落ちないか ②LP経由予約の後方互換（reach_path なしが従来集計に一致）③P11/P17の面別台帳でタブ経由予約が「面=line_miniapp・到達路=tab」の二軸で出るか ④product-funnel の `surface`（別名前空間）と混線しないか。
- **優先度**：**中**（データ破損防御でなく“新しく測れる価値”の enrichment＋入口ブラインド拡大への対処。ただし2026の決断面インナー化潮流に対する土台防御）。実装・QA・採否・優先度はメイン領分／Daiya。
- **位置づけ（テーマ転換・ビート3 決断面 単軸）**：前回（P19→P15追加観点＝ビート1/ビート2）からローテーションし、**久しく主役にしていなかったビート3＝決断面の移動**を偵察。P11（決断面タグ）の“実装すべき歴史的必然”を、ミニアプリタブ格上げという2026の具体的な面移動で一段強めた。新種は起こさず、既存P11/P5への追加観点に留める（seed-sprawl回避）。

---

## 追加の種（2026-08-07・目付第21回巡回からの還流）

**前提**：以下は**新規P番号を起こさない**。ビート2（計測ツールの指標の“定義”）を単軸にし、第19回で名指し・第20回で持ち越した宿題「engaged session／engagement rate の各ツール一次定義の突き合わせ」を消化した還流。既存の **実装照合表（P0-P3済）・P6（max_scroll_pct）・P12（可視復帰の時計）・タグ発火（HEAT_TH＝index.html 372-374行）** とは**重複しない**「セッション単位の engaged 下限アンカー＋“engaged”3語の取り違え防止guard」。**コードは触っていない。**

### 【P12＋タグ発火閾値への追加観点（新種ではない）】“engaged-session の10秒下限”を Loku の「この訪問はそもそも“関わった訪問”か」のセッション下限アンカーとして持ち、タグ誤点火をP12と別の側から backstop する＋“engaged”3語の取り違え防止guard

- **現象（ビート2・一次）**：GA4（公式ヘルプ＝S一次）と PostHog（公式docs＝A一次）が**独立に同一定義へ収束**＝**エンゲージ・セッション＝「10秒超 or 2ページ以上 or キーイベント(成約)1回以上」のOR条件**、しきい値は**最大60秒まで調整可**。Plausible（公式docs＝A一次）は裏返し（bounce＝関与なし離脱・1ページ訪問は0秒算入）で同義。＝**engagement率＝直帰率の置き換え（第19回で確定）に対し、今回“何秒で線を引くか＝10秒”の中身が3ツール収束で確定**（第18回の session=30分収束と同じ“独立3社が同じ数字へ”の型）。
- **現物確認（目付がgrep・過剰批判はしない＝当たりを認める）**：
  - (1) Loku の `active_sec` 積算ゲート（index.html 346-349・381行＝`(document.visibilityState==='visible') && hasFocus && (now-lastActivity < IDLE_MS)` で `totalActive+=dt`）は、GA4 の「エンゲージメント時間＝**アクティブで前面のタブの時間だけ・背景タブ除外**」の定義と**同じ思想**＝素のピクセル計測より一段堅い（P8/P12で既確認の可視ゲートの当たりの再確認）。
  - (2) ただし **Loku のタグ点火の実際の門番は滞在秒ではなく“箱ごと読了率”**（`firedTags()`＝index.html 370-375行＝`byId[rl.box].engagement>=HEAT_TH(60)` で箱タグ／`avg>=55` でホットリード）＝「10秒タブを閉じなかった」より**一段細かい“質”の門番＝Lokuの強み**。だが **“セッション全体でそもそも関与したか”のセッション単位の下限を1本も持たない**。
  - (3) **1枚もの（LP＝Loku主戦場）では『2ページ以上』の道が構造的に無効**＝GA4/PostHog自身も時間かキーイベントに頼るしかない＝**Lokuが“ページ数(量)”でなく“active_sec＋読了率(質)”で測る設計の正しさを外部標準が裏書き**（因果は行動ベースで成約と独立＝causal.mjs 25行/app.mjs 224行の既確認と接続）。
- **根拠URL（S/A一次）**：
  - GA4「Engagement rate and bounce rate」（S一次）https://support.google.com/analytics/answer/12195621?hl=en
  - PostHog「Sessions」docs（A一次・bounce＝1view/no-autocapture/<10s・engaged＝>10s or conversion or ≥2views・閾値変更可）https://posthog.com/docs/data/sessions
  - Plausible「Metrics definitions」（A一次・bounce＝関与なし離脱・1ページ訪問0秒算入）https://plausible.io/docs/metrics-definitions
  - GA4エンゲージメント時間＝前面/背景除外の言い換え（B）https://analytify.io/track-user-engagement-time-in-google-analytics/ ／ 現物: loku-tuning-plugin/index.html tick() 342-367・370-375行
- **対策案（射程を絞る・新種P番号は起こさない・採否はDaiya/メイン判断）**：
  - **(a)** タグ点火（`firedTags()`）の前段に、**「セッション `totalActive`(active_sec) が engaged 下限（既定10秒＝GA4/PostHog標準・店主調整可）に達しているか」の粗い前提ゲート**を任意で足す＝engaged未満のセッションはホット/検討タグを抑止（読了率門番HEAT_THはそのまま・その“上流”に下限を1枚かませるだけ）。
  - **(b)** あるいはタグに「engaged未満」フラグを添え、店主に「まだ関与が薄い」を正直に示す（抑止せず注記する軽い案）。
  - **(2ページ条件は採用しない)**：1枚LPで無効なので、Loku下限は**時間(active_sec)ベースのみ**を採る＝GA4の3条件のうちLPで生きる条件だけを移植する。
- **⚠️取り違え防止guard（最重要・第19回の“30分vs25秒”guardと同型の桁/レイヤーguard）**：以下の“engaged”3語を実装で混同しない——
  - **① engaged-SESSION**＝yes/noの下限（10秒 or 2view or event）＝**セッション単位**（今回の追加アンカー）。
  - **② engagement-TIME**＝分量(秒)＝Loku `active_sec`＝**P12が時計精度を担当**。
  - **③ Loku 箱ごと engagement**＝読了率(%)＝**要素単位の質**（HEAT_TH=60の門番）。
  - **桁guard**：**10秒（engaged下限・session）を `IDLE_MS=25000`（25秒＝無操作ゲート・moment単位）と混同しない**（別レイヤー。秒を流用するとゲートが壊れる＝第19回の“30分session区切り vs 25秒IDLE_MS”取り違えと同型の別事例）。
- **検証方法**：実機E2E（メイン領分・1スタジオ目本番化時・P7〜P19と同じ境界テスト群で）。①**「3秒流し見で偶然1箱だけ中央ゾーンに止まり読了率60%超」**の負のテストで、active_sec下限ゲートありならホットタグが**抑止**され、なしでは誤点火する、の出し分け ②真に10秒超関与した訪問は従来どおりタグ点火（後方互換）③下限値を店主設定で動かせるか（HEAT_THと独立に）④P12の可視復帰リセットと二重に働かないか。
- **優先度**：**低〜中**（データ破損防御でなく防御的refine＝P12の姉妹。既存の読了率門番で“質”は測れているので破損はしないが、“素通り客の偶発1箱ホット化”をセッション側から塞ぐ backstop）。実装・QA・採否・優先度はメイン領分／Daiya。
- **位置づけ（テーマ転換・ビート2 指標定義 単軸）**：前回（P20・ビート3 決断面）からローテーションし、“決断面/ミニアプリの連続”を避けて**ビート2＝指標の“定義”（engaged session/engagement rate）**を一次で深掘り。交差フロンティア(P13〜P18)には戻らず。engaged-time(P6/P12)→session区切り30分(P15追加観点)→今回engaged-session下限10秒、とビート2“指標定義”鉱脈を継続。起源掘りは“閾値で見られたかを数える”思想の始祖＝MRC/IABビューアビリティ(50%×1秒・2014)を選び、現物 `COVER_GATE=0.5` の歴史的根拠づけとした。

---

## 追加の種（2026-08-08・目付第22回巡回からの還流）

**前提**：以下は**新規P番号を起こさない**。既実装 **P2（bot除外・UA＋挙動＝実装照合表で✅済み）** への**追加観点 第2弾**。第18回（2026-08-04）の「P2への追加観点（クラウドIP・アクション上限を"抽象"で提示）」を、今回**同業OSSの実数つき既定値で"一次具体化"**し、さらに**2枚の新観点（第1層UAリストの鮮度・第3層エージェンティックブラウザ指紋）**を足した。**第18回P2追加観点・実装照合表（P0-P3済）とは重複させない（第18回は"手法名の列挙"どまり／今回は"実数つき既定値＋新脅威の名指し"）。コードは触っていない。** テーマ転換＝前回まで2回入っていたビート2（指標定義）を離れ、鉄則「ビート2の3連続を避け・次はビート1へ明確に舵」に従いビート1（計測精度の敵＝bot除外の現行定石）単軸。

### 【P2への追加観点 第2弾（新種ではない）】bot除外の"現行の当たり前3層"を一次で具体化＝(1)UAリストの鮮度 (2)クラウドIP帯遮断の実数 (3)アクション上限の実数 ＋2026新脅威エージェンティックブラウザは第3層(suspect_bot)が最後の砦

- **現象（ビート1・一次）＝現行定石は3層**：同業のオープンソース計測ツールが"既定で"持つbot除外は3層に整理できる。
  - **第1層＝UA(名札)で弾く／本家＝IAB/ABC国際スパイダー&ボットリスト（S・業界標準）**：GA4が既定使用。**2006年ABC(英)+IAB(米)発足・毎月更新・許可リスト+拒否リストの3ステップUA照合**。ただし**"素直に名乗る良性bot(検索クローラ/監視ツール)しか捕まえない"**（名札を偽る相手には無力）。
  - **第2層＝IP(来る場所)で弾く／Plausible（A・OSS一次）**：**データセンター/クラウドIP帯を約32,000帯"既定で"除外**。2023年2月以降で**偽ページビュー約14億件ブロック**を公表。層構成＝①UA照合 ②リファラースパム除外 ③データセンターIP遮断(≒32,000帯) ④不自然挙動検知の4段。
  - **第2/第3層の実装例＝Matomo（A・OSS一次）TrackingSpamPrevention**：(a)クラウドIP遮断(AWS/Azure/DigitalOcean/GoogleCloud/Oracle・「人間はVPN経由でない限りクラウドから計測要求を出さない」と明記) (b)ヘッドレス検知(**UAをカスタム偽装されると検知不能**) (c)1来訪あたりアクション上限(**通常約100〜300で頭打ち・超過は記録停止＋IPを最大24時間遮断＋管理者へメール通知**)。加えて「JSトラッカーはJS実行ブラウザの活動しか記録しない＝伝統的botは自動除外／高度bot・ヘッドレスはJSを実行し人間に見える」と一次明言。
- **現物確認（目付がgrep・過剰批判はしない＝当たりを認める）**：
  - Loku の P2 は**二段実装＝UA入口除外（`BOT_UA_RE`・handoff-demo/app.mjs 13-16行）＋挙動フラグ `suspect_bot`（277行・タグ発火させず実名導線に乗せない隔離）＋`GET /api/attn/bot-report`（692-699行）で除外件数を可視化**（GA4は黙って消すが、うちは"消した件数"を店主に見せる＝信頼の担保）。**3層のうち第1層(UA)と第3層(挙動)を既に持ち、"黙って消さない"点は同業より一段誠実＝当たり。**
  - **抜けは第2層＝クラウド/データセンターIP帯の遮断を1本も持たない**（P2はUA＋挙動のみ・IP層なし）。
  - 第1層の `BOT_UA_RE` は**固定約10語のリスト**（`/(bot|crawler|spider|scrapy|headlesschrome|puppeteer|playwright|phantomjs|python-requests|selenium)\b|curl\/|wget\//i`）＝コメントで自称する「IABリスト相当の最小版」だが、**IAB/ABCが"毎月"更新するのに対し書いた時点で凍結**＝新規の名乗りbotを取りこぼす"鮮度ギャップ"がある。
- **根拠URL（S/A一次・egress遮断のため検索経由でtraced）**：
  - IAB Tech Lab「IAB/ABC International Spiders and Bots List」（S）https://iabtechlab.com/software/iababc-international-spiders-and-bots-list/ ／ IAB Europe Q&A https://iabeurope.eu/international-iababc-spiders-and-bots-list/
  - Plausible「Google Analytics counts bots as real traffic」（A）https://plausible.io/blog/testing-bot-traffic-filtering-google-analytics ／ 約32,000帯・14億件＝同社X告知 https://x.com/PlausibleHQ/status/1816447266208485510
  - Matomo「Tracking Spam Prevention」（A）https://matomo.org/faq/how-to/block-spam-and-bot-traffic-with-tracking-spam-prevention/
  - Google Analytics Help「Known bot-traffic exclusion」（S・GA4がIABリスト既定使用）https://support.google.com/analytics/answer/9888366
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs 13-16/263-268/277/692-699行
- **対策案（射程を絞る・新種P番号は起こさない・採否はDaiya/メイン判断）**：
  - **① 第2層＝クラウドIP帯の隔離**：`app.mjs` collect で送信元IPがクラウド帯（AWS/Azure/GCP/DO/Oracle）なら `suspect_bot` 相当で隔離。主戦場（LINE→LP・モバイル実機）の正規客はモバイルキャリア/家庭回線＝**データセンターIPからの collect はほぼ確実に自動化**。**全弾きでなく `bot-report` に載せて可視化**（現状 `suspect_bot` 思想を踏襲）。
  - **② 第3層＝アクション上限**：1匿名IDが短時間に不自然回数 collect を叩いたら隔離（Matomo＝約100〜300が目安）。
  - **③【新】第1層＝UAリストの鮮度**：`BOT_UA_RE`（固定約10語）を、維持されているリストの参照 or 定期更新に寄せ、新規の名乗りbotの取りこぼしを減らす。
  - **④【新】第3層＝エージェンティックブラウザ指紋**（下記の2026新脅威対策）。
- **【2026新シグナル＝エージェンティックブラウザ（A→traced）】**：AIが代わりにページを操作するブラウザが一般化。**Perplexity Comet＝エージェント経由トラフィックの48.12%（前年比+7,851%）・ChatGPT Atlas＝21.33%・2製品で約70%**（Human Security・2026年4月）。両者とも**Chromiumベース＝"普通のブラウザ"の名札／CometはユーザーPC上のChromiumセッションで動く＝住宅回線IP＋普通のUA＋JS実行**で来て人間の来訪と見分けがつかない（PerplexityはIP/ASNを広くローテーション）。＝**第1層(UA)も第2層(IP帯)も素通りし、第3層＝挙動（Lokuの `suspect_bot`）だけが最後の砦**。第18回が「JS実行ヘッドレスAIエージェント」と抽象で呼んだ脅威が、名前と実測シェアを持つ製品になった到達点。
  - **対策案④**：`suspect_bot` ヒューリスティクスに**「高アクション密度＋滞在ほぼ0（active_sec≒0）＋スクロール深度0 の同時成立」**を明示条件として追加。**Lokuが既に持つ `active_sec`／箱ごと読了率／スクロール深度（=人間らしい関与のムラ）がそのままこの挙動検知の入力になる**＝UA/IPを欺く相手を"やったこと"で捕まえる。素のピクセル計測(PVだけ)よりこの波に構造的に強い。
  - 根拠URL：Human Security「ChatGPT Atlas vs Perplexity Comet」https://www.humansecurity.com/learn/blog/chatgpt-atlas-vs-perplexity-comet-agentic-browsers/ ／ Vouched「Perplexity Agent Detection Guide」https://www.vouched.id/learn/blog/perplexity-agent-detection-guide ／ Seresa「...Already in Your Analytics」https://seresa.io/blog/ai-bot-filtering/chatgpt-atlas-and-perplexity-comet-are-already-in-your-analytics
- **検証方法**：実機E2E（メイン領分・1スタジオ目本番化時・P7〜P19と同じ境界テスト群で）。①クラウドIP帯の collect が `suspect_bot` として隔離され `bot-report` に残るか ②アクション上限超の匿名IDが本番集計から外れ監査には残るか ③**負のテスト＝企業VPN/商用VPN経由の"本物客"がクラウドIP判定で誤隔離されないか／正規のヘビー閲覧客がアクション上限で誤って切られないか**（データセンター遮断リスト＋VPN許可リストCIDRの併用が2026定石＝全弾きは危険）④エージェンティックブラウザ指紋（高密度＋滞在0＋スクロール0）で AI来訪が隔離され、迷い/止まり/ムラのある本物客は素通りするか。
- **優先度**：**中〜低（P2のenrichment）**。UA偽装ヘッドレス＋エージェンティックブラウザという"UA/IPを欺く相手"が急増中（+7,851% YoY）＝挙動層の質が数字の信頼度を左右するため、①②③は"データ破損防御"寄りで中、③④は"精度refine"で低〜中。実装・QA・採否・優先度はメイン領分／Daiya。
- **⚠️見廻り（lp-mimawari）へ申し送り**：第2層（クラウドIP判定）は**送信元IPアドレスを条件に使う**＝個人情報/プライバシー（IPの扱い・保存期間）の論点があり得る。可否・保存設計の線引きは法規制領分＝見廻りの判断を仰ぐべき点（第18回申し送りの再掲・継続）。
- **位置づけ（テーマ転換・ビート1 bot除外 単軸）**：前回P21（ビート2 engaged-session定義）からローテーションし、"ビート2の3連続"を避けてビート1（計測精度の敵）へ明確に舵。交差フロンティア(P13〜P18)には戻らず。テーマ履歴＝bot(第18)→session区切り(第19)→決断面(第20)→engaged-session(第21)→bot除外現行定石(第22)。起源掘りは"botの自己申告(robots.txt/UA honor system・1994 Koster→RFC9309 2022)"を選び、"なぜ第3層(挙動)が最後の砦になるのか"の歴史的根拠（名乗りに頼る第1層の前提=正直な相手、がエージェンティックブラウザで完全に崩れた）とした。

## 追加の種（2026-08-09・目付第23回巡回からの還流）

**前提**：以下は**新規P番号を起こさない**。ビート3（決断面の移動）を3回ぶりに主役へ戻した偵察の還流で、既存の **P11（決断面surface＝bookingの着地面）** と **P5（起源クリックID非依存化＝流入の紐付け）／reach_path 追加観点（第20回・2026-08-06）** への**追加観点「第2弾」**。実装照合表（P0-P3済）・P5・P6・P7〜P19・P20系（reach_path第1弾）・P21（engaged下限）とは重複させない。**コードは触っていない。**

### 【P11＋P5 reach_path 追加観点 第2弾（新種ではない）】決断面が“LPの前＝AI回答面／AI予約代行”へ一段移った現象を、reach_path で正直に扱い、かつ「一度もLokuに触れない構造的天井」を明示する

- **現象（ビート3・S一次/準一次）**：Google I/O 2026（2026-05-19・公式ブログ）で AI Mode の**エージェント予約（agentic booking）**をローカルサービスへ拡張。**美容・ペットケア・住宅修理など選択カテゴリで「本人に代わってAIが店へ電話・予約」が2026年夏に全米展開**（美容＝Loku主戦場スタジオの隣）。レストラン予約は先行して4月に8か国展開済み。＝**予約という決断が検索結果（AI回答）の中で完結し、客は自店LPにもGBPにも来ずに決着する**。さらに実測（Sterling Sky／Joy Hawkins）で**新AIローカルパックに載る店は旧3枠の約32%（5,943 vs 18,330店・322市場の88%で減少）**＝決断面がAI回答へ寄るほどLP到達の母数そのものが構造的に縮む。第20回（LINEミニアプリタブ＝LP非経由の“到達路”）の**次の段＝そもそもLP“来訪”自体が発生しない面**が現れた。
  - **3ビート横断で同方向（第20回の再確認＋一段進行）**：GBP＝ローカルパックのワンタップ電話ボタン撤去が2026も継続（Google公式一次告知は今回も出ず＝2026-07-16見切り継続）／Instagram＝キャプション直リンクはMeta Verified限定のまま全体展開なし／Google検索＝**ローカル検索の68%にAI Overviews出現・AIO出現時83%ゼロクリック・AI Overviewのリンクは1.5%しか店サイトへ行かない（下段B）**。3プラットフォームがそろって「決断を自分の内側・AI回答の中へ引き込む」方向で一貫。
- **現物確認（目付がgrep・過剰批判はしない・現物読みで“既に堅い部分”を切り分け）**：(1) `POST /api/attn/booking`（app.mjs 429-435行）は `{friend_id}` のみで `store.bookings.add(d.friend_id)`＝**“どの面で決めたか”を持たない**のは P11 既特定。(2) 第20回で足した論点＝**「その面へどの到達路（reach_path）で来たか（lp/richmenu/miniapp_tab/unknown）」を持たない**。(3) **今回の新論点＝reach_path の enum が“LP経由 or LINE内経由”しか想定しておらず、「AI回答面（AI Overview/AI Mode）経由でLPへ来た来訪」と「AIが予約を代行し一度もLPに来ない来訪」を区別する値が無い**こと。(4) 流入 `entry_query/entry_pos/entry_health`（app.mjs 283-288行・P5が受け持つ）は、**AI回答経由だと referrer が google系AI面 or 空になりやすく**、入口ブラインドが第20回のタブ経由に続いて更に拡大。(5) ⚠️既存の `surface`（app.mjs 478-493行＝`/api/attn/product-events`/`product-funnel`＝自己改善画面のステップ計測）とは**別名前空間**（P14で確認済）＝流用しない。
- **対策案（射程を絞る・新種P番号は起こさない・採否はDaiya/メイン判断）**：
  - **① reach_path に AI回答面の値を任意で足す**：第20回の `reach_path: lp / richmenu / miniapp_tab / unknown` に **`ai_answer`（AI Overview/AI Mode等の回答面からLPへ着地）** を1値追加。referrer が空/AI面ドメインのときに推測でLPに寄せず `ai_answer` or `unknown` で正直にラベリング。件数率は後方互換（reach_path なし＝従来集計に一致）。
  - **②【本質・より重要】“AI予約代行＝一度もLokuに触れない構造的天井”を明示的に扱う**：agentic booking で予約が完結した客は **LP来訪0のまま実名台帳にも因果の入力（来訪データ）にも現れない**＝これは「reach_path=unknown」ですらなく**レコードが存在しない天井**。P9で確立した規律「**7日超前・別端末は推測で埋めず“辿れた範囲”を正直に**」と同型で、**この天井を推測で埋めない／“予約数とLP来訪数の乖離”を異常でなく「AI経由（測れない）」と説明できる注記を効果台帳・ダッシュボードに持つ**ことを観点として記録（数字は作らない）。外部（GBP/Google予約・電話計測）との突合で母数を補足するのは**見廻り／メイン領分**。
- **根拠URL**：Google公式ブログ「Search's I/O 2026 updates: AI agents and more」（2026-05-19・agentic booking 美容/ペットケア/住宅修理・全米夏展開） https://blog.google/products-and-platforms/products/search/search-io-2026/ （本文egress遮断＝検索経由trace・存在/要旨確定＝S一次） ／ Sterling Sky「The State of Local SEO in 2026」（Joy Hawkins・AIローカルパック32%＝5,943 vs 18,330店・322市場88%減少・A→traced） https://www.sterlingsky.ca/the-state-of-local-seo-in-2026/ ／ 補強 https://www.getpassionfruit.com/blog/google-i-o-2026-every-announcement-and-what-it-means-for-seo-and-geo （B→traced）
- **検証方法**：実機E2E（メイン領分・1スタジオ目本番化時・P7〜P19と同じ境界テスト群で）。①AI回答経由のLP着地が `reach_path=ai_answer`（or 正直に unknown）で記録され、LP直来訪と切り分くか ②reach_path なしの後方互換（従来件数集計に一致）③P11/P17の面別台帳で reach_path 軸が第20回の miniapp_tab と ai_answer の両方を取れるか ④product-funnel の `surface`（別名前空間）と非混線 ⑤**“乖離注記”＝AI完結予約でLP来訪0の期間に、予約数だけ動きLP来訪が動かない状態を「異常」でなく「AI経由（測れない天井）」と表示できるか（負のテスト＝正常な乖離をアラートで誤検知しない）**。
- **優先度**：**中**（データ破損防御でなく“新しく測れる価値”の enrichment＋入口ブラインド拡大／構造的天井の正直な明示。2026の「決断面がLPの前＝AI回答面へ移る」潮流に対する土台防御）。実装・QA・採否・優先度はメイン領分／Daiya。
- **⚠️見廻り（lp-mimawari）へ申し送り**：AIが本人に代わって予約・電話を代行＝「誰が申し込んだか（本人同意・なりすまし）」「AI経由予約でもLP上の予約導線・特商法/景表法表示の射程は変わるか」の法規制論点。可否・表示設計の線引きは法規制領分＝見廻りの判断を仰ぐ点。
- **位置づけ（テーマ転換・ビート3 決断面 単軸・久々に主役復帰）**：前回P22（ビート1 bot除外）からローテーションし、"bot/ビート1の連続"を避けて**3回ぶりにビート3＝決断面の移動**へ。テーマ履歴＝session区切り(第19)→決断面(第20)→engaged-session(第21)→bot除外(第22)→決断面/AI回答面(第23)。交差フロンティア(P13〜P18)には戻らず。**第20回のreach_path(LINEミニアプリタブ)に続く“第2弾”＝前回が「LP非経由の到達路」で残した所を、今回「そもそもLP来訪が発生しないAI回答面/AI予約代行」で一段深めた**（第22回の"追加観点 第2弾＝前回が抽象/構造で残した所を新シグナルで埋める"還流の型を、ビート3でも適用）。起源掘りは Duplex(2018)→Reserve with Google→agentic booking(2026) の系譜を選び、07-25「決断面が移動する“方向”」の到達点＝“決断の主体が客からAIへ交代した瞬間”の歴史的必然を根拠づけた。**新種は起こさず既存P11/P5への追加観点に留める（seed-sprawl回避）。**

## 追加の種（2026-08-11・目付第25回巡回からの還流）

**前提**：以下は**新規P番号を起こさない**。既存の **効果台帳＝cause-outcomes / change-outcomes（app.mjs 788-841行）＋その上に載るクロス立方体 P14（面×価値）・P16（頻度×価値）・P17（面×来訪回）・P15（来訪エピソード）・P18（価値×結合の厚み）** への**「最小セル閾値ガード」追加観点**。ビート2（計測ツールの“指標定義以外”の定石）を単軸にし、第24回の締めが名指しした「ビート1/広告ブロッカーの連続を避け・ビート2の指標定義以外 or ビート3の決断面以外へ」の（a）を選択。**P14〜P18は“クロス集計を出す”種／今回は“出したマスを門番する”ガード＝非重複。実装照合表（P0-P3済）とも重複させない。コードは触っていない。**

### 【効果台帳（P14〜P18クロス集計 / cause-outcomes / change-outcomes）への追加観点＝「最小セル閾値ガード」（新種ではない）】少人数の1マスで出した“率”を、そのまま断定値として出さない（伏せる／注記／“その他(サンプル不足)”へ丸める）

- **現象（ビート2・一次/準一次で3方向が同一結論へ収束）**：計測ツール界は「少人数のマスで出した率を信じるな／見せるな」を、**別々の力から同じ結論**として標準装備している——
  - **(1) 性能/コスト＝高基数の(other)丸め**：GA4は1日500種超の値を持つ列を「高基数」と呼び、1レポート1日50,000行で頭打ち→あふれを `(other)` に丸める（**S一次** support.google.com/analytics/answer/12226705）。PostHogも内訳は上位25値＋最大3プロパティに初期制限（**A一次** posthog.com/docs/product-analytics/trends/breakdowns）。
  - **(2) プライバシー/再識別＝小セル秘匿（thresholding）**：GA4は「レポート閲覧者が個々のユーザーの身元を推測できないよう閾値を適用」＝**人数が少なすぎるマス（目安50人未満・Google Signals併用時＝閾値はB→traced）を丸ごと伏せる**（Google公式記述＝**S一次**／数値は kissmetrics/analytify **B→traced**）。源流は k-anonymity（Sweeney 2002・**学術S**・米国民87%がZIP+生年月日+性別で一意）。
  - **(3) 統計＝最小サンプル/「率は幅」**：A/Bは「1条件あたり成約おおむね100件以上で率がやっと安定」「50人3成約=6%は統計的に無意味」「率はひとつの数字でなく幅」（AB Tasty/Invesp/Kaushik/Sophisticated Cloud＝**A/B→traced**）。
- **現物確認（目付がgrep・過剰批判はしない・現物読みで“既に堅い部分”を切り分け・19回連続）**：
  - **`change-outcomes`（app.mjs 810-841行）＝半分堅い＝当たり**：(a) 母数 `visitors`/`booked` を**生で返す**（分母を隠さない＝「率は幅」の前提を満たす）／(b) **勝敗を自動宣言しない**＝`result: (baseline.visitors===0 || treatment.visitors===0) ? 'unknown' : 'pending_review'`＝**ゼロセルは抑制・それ以外は“人（番人）の判断待ち”**＝A/Bの「少人数で勝ちと言うな」と一致。
  - **穴は1点＝“ゼロ以外の薄いマス”に最小サンプルの床が無い**：`change-outcomes` は n=1/n=2 でも `booking_completed_rate` と `delta_pp` を計算して出す（ゼロだけ 'unknown'）。`cause-outcomes`（788-807行）は**最小母数の門番が無く** `booked_rate = Math.round(r.booked/r.n*100)`＝離脱理由 n=1 が偶然1件予約すると `booked_rate:100`。しかも `cause-outcomes` は自己最適化（打ち手優先度学習）の**入力**（コメント「母数が多い順=着手優先度の目安」＝n重要は認識済だが率自体は素で出す）。
  - **クロス立方体（P14〜P18）は“最も痩せる位置”**：surface×tier×visit_count の3軸クロスは、**1スタジオ目の小母数で各マスが客1〜3人**になりやすい＝薄いマスが最も量産される。
  - **非該当を正直に切り分け**：Lokuは**店内メモリの単一テナント台帳**（列指向巨大DBでない）＝(other)の“コスト崩壊”は非該当／クロス軸は**店主区分の低基数enum名札**（surface/tier/visit_count）＝高基数(other)問題の主因にも非該当。**＝効く力は(2)小セル秘匿＋(3)最小サンプルの2つに絞れる**（(1)コストは非該当）。⚠️既存 `surface`（app.mjs 478-493行＝product-events/product-funnel＝自己改善画面ステップ・別名前空間・P14で確認済）とは無関係＝流用しない。
- **対策案（コードは触らない・採否と閾値kはDaiya／プライバシー面は見廻り）**：
  - **(a) 最小セル床を“ゼロ”から“k”へ一般化**：`change-outcomes` の `visitors===0 → 'unknown'` を `visitors < MIN_CELL → 'insufficient_sample'（率=null＋n併記）` へ引き上げ。`cause-outcomes` の `booked_rate` も `n < MIN_CELL` のとき率を出さず「n少・参考値」注記 or 別バケツへ。**既存ゼロガードの一般化＝新機構でない**。
  - **(b) クロス立方体は“その他(サンプル不足)”へ丸める**：P14〜P18の各マスで `n < MIN_CELL` のマスを個別の率で出さず `(サンプル不足)` バケツへ集約（GA4の(other)・PostHogの上位N＝“薄いマスは並べない”の移植）。
  - **(c) 率は必ず母数(n)同伴**：どの台帳の率も `{rate, n}` セットで返し、率だけの独り歩きを構造的に禁じる（`change-outcomes` は既にこれ＝台帳全体へ横展開）。
  - **(d) 断定でなく“保留/幅”を既定に**：`result:'pending_review'` の思想（自動で勝ちと言わない）を cause-outcomes/クロス立方体にも敷衍。閾値 k の既定値・匿名集計としての可否は**見廻り（k-anonymity=再識別防止の法規制論点）**の判断を仰ぐ。
- **根拠URL**：GA4 Cardinality（S一次）https://support.google.com/analytics/answer/12226705 ／ GA4 Data Thresholds（Google記述=S一次・数値=B→traced）https://kissmetrics.io/blog/ga4-data-thresholds-fix ・ https://analytify.io/ga4-data-thresholding/ ／ PostHog breakdowns（A一次）https://posthog.com/docs/product-analytics/trends/breakdowns ／ A/B最小サンプル（A/B→traced）https://www.invespcro.com/blog/calculating-sample-size-for-an-ab-test/ ／「率は幅」https://www.sophisticatedcloud.com/all-blogs/your-websites-conversion-rate-is-a-range-not-a-number ・ https://www.kaushik.net/avinash/excellent-analytics-tip5-conversion-rate-basics-best-practices/ ／ k-anonymity（学術S）https://epic.org/wp-content/uploads/privacy/reidentification/Sweeney_Article.pdf ／ 現物: handoff-demo/app.mjs（cause-outcomes 788-807／change-outcomes 810-841）
- **検証方法**：実機E2E（メイン領分・1スタジオ目本番化時・P7〜P19と同じ境界テスト群で）。①n=1の離脱理由/クロスマスで `booked_rate:100` でなく「参考値(n=1)」or “サンプル不足”バケツで出るか（負のテスト＝偶然の1件を必勝面と誤学習しない）②`change-outcomes` の n=1/2 が 'insufficient_sample' で保留され、'pending_review' の自動誤宣言を招かないか ③MIN_CELL 未満のマスを丸めても、母数が閾値を超えたら従来どおり率が出る（後方互換）④率が必ず n 同伴で返る ⑤テナント越境RLS・同意ゲートを小セル集計でも踏襲。
- **優先度**：**中**（データ破損防御でなく“数字の誠実さ”＝小母数の偽陽性で自己最適化の打ち手優先度を誤学習させない防御＋再識別の副次防御。1スタジオ目=小母数=クロス立方体が最も痩せる本番タイミングに直結）。実装・QA・採否・閾値k・優先度はメイン領分／Daiya。プライバシー面（kの根拠・匿名集計の可否）は見廻り。
- **⚠️見廻り（lp-mimawari）へ申し送り**：最小セル閾値は統計の誠実さであると同時に**再識別防止（k-anonymity）**の顔を持つ。1スタジオ目の小母数で「来訪回×価値×決断面」の1マスに該当1名＝**匿名集計でも実名の1人が透ける**可能性。閾値 k の値・匿名集計としての可否・保存設計は法規制領分＝見廻りの判断を仰ぐ（第22回のクラウドIP判定申し送りに続く“集計×プライバシー”の論点）。
- **⚠️番人(qa-auditor)へ申し送り**：`change-outcomes` の `result:'pending_review'`（少人数で勝ちと言わない）は当たり＝この保留を人が握る運用を維持。QA境界テスト＝台帳の各マスに**母数nを必ず併記**し、n=1で率が“注記付き参考値”として出ること・MIN_CELL丸めの後方互換を確認。
- **位置づけ（テーマ転換・ビート2 指標定義以外 単軸）**：第24回（ビート1 広告ブロッカー）からローテーションし「ビート1の連続を避け・ビート2の指標定義以外へ」の指示どおりビート2へ。ただし**session/engaged/bounce の“指標定義”鉱脈（第18/19/21）とは別サブ＝“データモデリング/標本の規律（小セル・基数・最小サンプル）”**＝“指標定義以外”を満たす。テーマ履歴＝決断面/AI(23)→広告ブロッカー(24)→**小セル/最小サンプル(25)**。交差フロンティア(P13〜P18)には戻らず、**その上に載る“ガード”**として非重複。第24回の還流型「新種ゼロで実り多い＝良い設計(change-outcomesの母数開示/pending_review)を明文化して守る＋残る穴(最小サンプル床)を1点に絞る」を継承。起源掘りは統計局のセル秘匿→Sweeney k-anonymity(1998/2002)の系譜で「集計すれば匿名/安心」という前提が壊れた瞬間を根拠づけた。

## 追加の種（2026-08-12・目付第26回巡回からの還流）

**前提**：以下は**新規P番号を起こさない**。ビート1（生の計測精度）単軸で「背景タブのタイマー凍結×可視復帰の時計(dt)」を再点検し、既存の **P12（可視復帰の時計＝2026-07-29）** ／ **P12＋タグ発火（engaged-session 10秒下限＝2026-08-07）** ／ **P15（来訪エピソード境界＝分オーダー）** とは**重複しない「P12 の“長時間離席は安全”という自己前提の1点訂正＋対策の主従入れ替え」**。今回の横断探索で得た新シグナル（WKWebViewの**JS完全凍結**をApple一次で確定＝機構の格上げ／web-vitals公式の“復帰境界を信用しない”定石）で、P12本体が抽象で残していた「復帰境界のすり抜け条件」を精緻化した。**コードは触っていない。**

### 【P12 への追加観点（新種ではない）＝“25秒超の離席は無操作ゲートが弾く＝長時間離席は安全”に1つ例外＝「復帰直後のタップ自身がゲートをリセット」→ 対策(b)dtクランプ／異常dt加算スキップを“保険”から“必須の芯”へ格上げ】
- **P12本体の結論の訂正点（1点）**：P12は現象整理で「(2) 25秒以上の離席は無操作ゲート(`now-lastActivity<IDLE_MS`・347行)が弾く＝**長時間離席は安全**、漏れは25秒未満の往復ごとの数秒＝“塵積”」と評価していた（314-316行）。**この(2)は“離席する<u>直前</u>の操作”だけを想定している**。だが `lastActivity` は `scroll/mousemove/touchstart/touchmove/keydown/wheel/pointerdown`（325-326行）で更新される＝**復帰してLPを再び触る“<u>そのタップ／スクロール自身</u>”が `lastActivity=now` にリセットする**。もしその操作が**復帰後の最初の `tick()` より先**に発火すると、たとえ3分離席していても `now-lastActivity≈0 < IDLE_MS(25秒)` となり `activeGate=true`＝**復帰直後の1刻みの巨大 `dt`（＝離席まるごと・数分）が `totalActive` と“可視中の箱”の `activeView`(362行) に一発加算**されうる（例えると：店員が別室に3分呼ばれ、戻った瞬間にお客さんが「すみません」と声をかけた＝その声で“今も接客中”とみなし、居なかった3分を接客時間に足してしまう）。**＝P12の「長時間離席は安全」には“復帰即操作”という例外があり、最悪ケースの上限は「数秒の塵積」でなく「復帰即タップ客の分単位の単発スパイク」まで伸びる**。
- **主戦場での機構の格上げ（今回のS一次）＝“間引き”でなく“完全凍結”ゆえスパイクはほぼ確実**：P12本体は「iOSは裏に回るとJSが数秒の猶予後に凍る（実測A）」と書いていた。今回**Apple一次（radar rdar://7739943＋Apple Developer Forums）で「WKWebViewはアプリが背景化するとJS実行を<u>完全に停止</u>し、前面復帰で再開する」**を確認＝主戦場のLINE内ブラウザでは復帰 `dt` は**確率的でなくほぼ確実に「離席していた全時間」**になる。加えて非WKWebView（PC/Android等）でも背景タイマーは**budget方式で約1秒に丸め・5分超で毎分1回**（MDN/Chrome S）＝復帰dtは任意に巨大化しうる。→ **P12の`lastTick`凍結前提そのものが、主戦場では“猶予後に凍る”でなく“即・完全に凍る”へ強まる**。
- **対策の主従入れ替え（P12対策案 324-327行の(a)(b)の重みを更新）**：
  - P12は **(a)可視復帰で `lastTick=Date.now()` 取り直し** を第一対策、**(b)`dt=Math.min(…, TICK/1000*2)` のクランプ** を「(a)より雑だが取りこぼしにくい保険」と位置づけていた。今回の例外を踏まえると、**(a)は `visibilitychange(visible)` ハンドラと復帰後最初の `tick()`／ユーザーのタップの“発火順序”に依存**する（(a)が刻みより先に走れば穴は塞がるが、順序保証は仕様上ない）。**順序に依存せず必ず効くのは(b)側**＝刻みの計上時点で `dt` を頭打ちにする／**「`dt` が刻み間隔TICKを大きく超えたら“復帰境界”とみなしその刻みは加算をスキップ（`lastTick` だけ取り直す）」**。→ **(b)（またはこの“異常dtゲート”）を「保険」から「必須の芯」へ格上げ**し、(a)は併用の補助に降ろす。＝**「(a)で境界を消せなくても、(b)で巨大dtは必ず頭打ち」の二段**にすると順序race耐性ができる。**コードは触らない・設計材料のみ。**
  - 業界の裏書き（A・機構=S）：**web-vitals（Google公式）は「背景化するとブラウザは追加コールバックを発火しない前提で、`visibilitychange(hidden)` の瞬間に値を確定させ、復帰を跨いだ積み上げを信用しない」**設計＝**“復帰の境目は信用しない（跨いで積まない）”が定石**。`requestAnimationFrame` も背景で停止＝復帰まで時間が“凍る”ため、ゲームループ等では**delta-timeを必ずクランプ**するのが常識（MDN/一般定石）。Lokuの(b)クランプはこの定石の現物版。
- **他種との非重複（実装照合の要）**：**P12本体**（可視復帰の時計＝穴の特定＋対策(a)(b)提示）に対し、本追加観点は**「(2)長時間安全という結論の例外条件の特定」＋「(a)(b)の主従入れ替え」**の2点差分＝結論と優先順位の訂正。**P12＋engaged10秒下限**（第21回・セッション側からのタグ誤点火backstop）とは別軸（あちらは“関与の下限”、本件は“時計のdt上限”）。**P15**（来訪エピソード境界＝分オーダーの“別来訪”区切り）とも別レイヤー（本件は同一エピソード内の秒オーダーの時計）。実装時は「(a)可視復帰リセット」「(b)dtクランプ」「P7 bfcache復帰リセット」が**同一往復で二重に走らない**ことだけ確認（P12本体317行の非重複メモを踏襲）。**新種P番号は起こさない。**
- **根拠URL（機構＝S、定石＝A、現物＝目付grep）**：
  - Apple radar rdar://7739943「WKWebView does not suspend JS when app is backgrounded」＋Apple Developer Forums（WKWebViewは背景でJS<u>完全停止</u>・前面復帰で再開）https://openradar.appspot.com/7739943
  - MDN「Window: setTimeout()」背景タブのクランプ（背景は約1秒・S）https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout ／ Chrome for Developers「Heavy throttling of chained JS timers（Chrome 88〜・5分超で毎分1回）」https://developer.chrome.com/blog/timer-throttling-in-chrome-88
  - GitHub GoogleChrome/web-vitals（背景化後はコールバック不発火→hiddenで確定・復帰跨ぎを信用しない・A）https://github.com/GoogleChrome/web-vitals
  - MDN「Window: requestAnimationFrame()」（背景で停止＝復帰まで時間が凍る・S）https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
  - 現物: loku-tuning-plugin/index.html `tick()` 342-349行（`dt=(now-lastTick)/1000; lastTick=now; if(activeGate) totalActive+=dt`・per-box `activeView+=dt*coverage` 362行）／`markActivity` と操作リスナ 325-326行／`IDLE_MS=25000` 289行／可視復帰ハンドラは無し（visibilitychange は hidden時flushのみ 475行）
- **検証方法（P12検証②の拡張）**：実機E2E（メイン領分・1スタジオ目本番化時・P7〜P19と同じ境界テスト群で）。①**「3分アプリ切替→戻って“即タップ”」**（復帰後最初の刻みより先に touchstart/scroll を起こす）で、`active_sec` と各box `engagement` が**3分を拾わない**こと＝**現状(dtクランプ無し)では条件次第で拾い／(b)クランプor異常dtスキップ後は拾わない**の出し分けを確認（従来のP12検証①②「15秒往復・24秒 vs 26秒」に加える負のテスト）。②(a)可視復帰リセットのみ実装した場合でも、**ハンドラ順序を人為的に入れ替えた**時に穴が残らないか（=(b)が芯として効くか）。③P7 bfcache復帰リセット・P12(a)可視復帰リセット・(b)クランプが**同一往復で二重に走らない**こと。④P1(単調増加マージ)と衝突せず途中flushが飛んでも巻き戻らないこと。
- **優先度**：**P12据え置き（低〜中）**——防御的リファインの範囲は変えないが、**最悪ケースの上限の見立てを「25秒未満の往復ごとの数秒（塵積）」→「復帰即タップ客の分単位の単発スパイク」へ訂正**。頻度は小さいが**1件あたりの歪みが大きく、当たる相手が最重要（戻ってタップ＝最も買う気の客）**＝engagement/タグ/因果入力への影響は無視しにくい。実装1〜数行で軽い（(b)は `tick()` 1行）。**採否・優先度・実装・QAはDaiya／メイン領分。コードは触っていない。**
- **位置づけ**：交差フロンティア(P13〜P18)出尽くし後の成熟モード＝**新種を起こさず「既存種P12の結論の1点訂正＋対策の主従入れ替え」**（第22回“追加観点第2弾”／第24回“良い設計を守るガード”／第25回“既存ゼロガードの一般化”に続く**“既存種を新シグナルで精緻化する還流型”の4例目**）。テーマは背景タブ凍結(P12)の起源(2026-07-26既掘)に対し、今回は現物への当てはめを一段深く＝「省電力最適化(可視API/タイマー凍結)が計測の穴を生む」構図の実装面での詰め。

## 追加の種（2026-08-13・目付第27回巡回からの還流）

**前提**：以下は**新規P番号を起こさない**。ビート3（決断面の移動）を単軸にし、既存の **P11（決断面surface＝bookingの着地面）** と **P5（起源/流入の紐付け）／reach_path 追加観点（第20回=ミニアプリタブ・2026-08-06／第23回=AI回答面 ai_answer・2026-08-09）** への**追加観点「第3弾」**。実装照合表（P0-P3済）・P5・P6・P7〜P19・P20系(reach_path第1弾)・P21(engaged下限)・P23系(reach_path第2弾ai_answer)・第25(小セル)・第26(P12訂正)とは重複させない。**コードは触っていない。**

### 【P11＋P5 reach_path 追加観点 第3弾（新種ではない）】Instagramの comment-to-DM（Meta公式 Private Replies API）で“予約という決断がDMの会話内で完結する面”を確定＝reach_path に `ig_dm` を足し、かつ「まだら計測（LP経由=測れる／DM内完結=天井）」を第23回 ai_answer の規律で横展開
- **現象（ビート3・S一次）**：Instagramの「投稿にコメント→自動で個別DMが届く→そのDMで予約完結」というコメント誘導DM（comment-to-DM）は、外部ツールの裏技でなく**Meta公式の「Private Replies」API**で動く正規機能だと一次で確定。仕様＝**自分の投稿/広告への公開コメントに対し、投稿から7日以内に“1通だけ”の個別DMを自動送信**（元コメントへのリンク自動付与）・送信は `/<IG_ID>/messages`・宛先はIGSID・**ビジネス/クリエイター垢向けに Messenger API for Instagram で明示サポート**。＝**予約という決断が“公開の投稿”でなく“1対1の会話(DM)の内側”で起きる面**が公式土台に載った。第23回のGoogle AI回答面（決断がAI回答内で完結）に続く**「決断が会話・回答の内側へ入る」流れのMeta版**。
  - **3ビート横断で同方向（潮流の一貫）**：Google＝ローカルパックの電話ボタン撤去＋予約格上げ＋AI予約代行(第23回)／Instagram＝今回のcomment-to-DM(S一次)／LINE＝ミニアプリタブ・2026年5月アクションボタンUI刷新・同意簡略化必須化(2026-01-08)。主戦場3面すべてで「決断をプラットフォームの内側・会話の中へ引き込む」方向で一貫。
- **現物確認（目付がgrep・過剰批判はしない・現物読みで“既に堅い部分”を切り分け）**：(1) `POST /api/attn/booking`（app.mjs 429-435行）は `{friend_id}` のみで surface/reach_path を持たない＝P11 既特定。(2) **surface enum には `instagram_dm` が既にある**（P11(a)・app.mjs booking拡張案の語彙 `lp_cta/phone/line_richmenu/line_miniapp/line_chat/instagram_dm/gbp/unknown`）＝**今回は“新しい面”ではなく“既存面 instagram_dm の到達路と計測可否”の観点**。(3) 第20回 reach_path（lp/richmenu/miniapp_tab/unknown）・第23回 ai_answer の enum に、**IG DM経由でLPへ着地した来訪を区別する値が無い**。(4) この面は**“まだら”**＝(a)DM内の予約リンクが**自店LPを開けば計測できる**（第23回 ai_answer が「referrer空/AI面で入口ブラインド」だったのに対し、**DMは店主が導線=リンク先を握れるぶん計測余地がある**のが差）／(b)DM内でそのまま外部予約ページ（Google/専用スケジューラ）へ飛んで完結すると**一度もLPに来ない＝レコードが存在しない天井**（第23回 ai_answer の「一度もLokuに触れない構造的天井」と同型）。(5) ⚠️既存 `surface`（app.mjs 478-493行=product-events/product-funnel=自己改善画面ステップ・別名前空間・P14で確認済）とは無関係＝流用しない。
- **対策案（コードは触らない・採否はDaiya／同意設計は見廻り）**：
  - **① reach_path に IG DM経由の値を任意で足す**：第20/23回の `reach_path: lp / richmenu / miniapp_tab / ai_answer / unknown` に **`ig_dm`（Instagramのコメント誘導DM経由でLPへ着地）** を1値追加。referrer が Instagram系/空のときに推測でLPに寄せず `ig_dm` or `unknown` で正直にラベリング。件数率は後方互換（reach_path なし＝従来集計に一致）。
  - **②【本質】“まだら”を明示的に扱う＝測れる(a)と天井(b)を分ける**：DM内リンクが**自店LPを開いた予約**は `reach_path=ig_dm` で計測（＝ai_answer より測れる面）／**DM内で外部予約完結した予約**は第23回と同じ規律で**「一度もLokuに触れない天井」＝推測で埋めず“予約数とLP来訪数の乖離”を異常でなく「IG DM経由（会話内で決断・測れない）」と説明できる注記**を効果台帳/ダッシュボードに持つ（数字は作らない）。P9で確立した「名乗る前・7日超前・別端末は推測で埋めない」の横展開。
- **根拠URL（機構＝S一次、潮流＝B）**：
  - Meta for Developers「Private Replies — Instagram Messaging」（公開コメントへ7日以内に単発の個別DM・自動でコメントへのリンク付与＝S一次）https://developers.facebook.com/docs/messenger-platform/instagram/features/private-replies/
  - Meta for Developers「Send Messages — Instagram API」（`/<IG_ID>/messages`・IGSID宛＝S一次）https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/
  - LINE側の決断面内側化（S(仮)）https://www.lycbiz.com/jp/column/line-mini-app/service-information/mini_matome_202607/（2026年5月=LIFFブラウザのヘッダー/アクションボタンUI刷新・6月=OA連携基盤強化）
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（booking 429-435行=surface/reach_pathなし／surface語彙に instagram_dm 既存＝P11(a)案／別名前空間 surface=product-funnel 478-493行）
- **検証方法**：実機E2E（メイン領分・1スタジオ目本番化時・P7〜P19と同じ境界テスト群で）。①IG DM内リンク経由のLP着地が `reach_path=ig_dm`（or 正直に unknown）で記録され、LP直来訪と切り分くか ②reach_path なしの後方互換（従来件数集計に一致）③P11/P17の面別台帳で reach_path 軸が miniapp_tab / ai_answer / ig_dm を取れるか ④product-funnel の `surface`（別名前空間）と非混線 ⑤**“乖離注記”＝IG DM完結（外部予約）でLP来訪0の期間に、予約数だけ動きLP来訪が動かない状態を「異常」でなく「IG DM経由（測れない天井）」と表示できるか（負のテスト＝正常な乖離をアラートで誤検知しない）**。
- **優先度**：**P11据え置き（低〜中）**——reach_path 名札1個の追加＝実装は軽い。効くのは「IG DM経由の予約がunknownに潰れず正直に出る」＋「DM完結型の予約でLP来訪が伴わない乖離を誤読（LP不良/計測バグ）しない」の2点。主戦場（美容/スタジオ×日本ローカル）での IG DM経由予約の実比率は未取得＝本番待ち（watchlist）。**採否・実装・QA・優先度はDaiya／メイン領分。コードは触っていない。**
- **⚠️見廻り（lp-mimawari）へ申し送り**：Meta Private Replies は「投稿から7日以内・1通のみ・コメント者への自動DM」という同意/送信の枠がAPI仕様＝**IG DM経由の予約導線を組む際の事前同意/自動送信の法規制・Metaポリシー適合**は見廻り領分。LINEの**チャネル同意簡略化（2026-01-08必須化）**も同意設計の論点。
- **⚠️番人(qa-auditor)へ申し送り**：「予約数は動くがLP来訪データが動かない」乖離を**“計測バグ/LP不良”と誤検知しないための負のテスト**（IG DM完結・LINE内完結・AI予約の3天井で乖離が“正常”と出るか）をQA境界テストに。
- **位置づけ（テーマ転換・ビート3 決断面 単軸）**：前回P12訂正(第26=ビート1)からローテーションし、"ビート1/タイマー・可視復帰の連続を避け・ビート3の決断面へ"の宿題どおりビート3へ（直近ビート3は第23=4回離れ・手薄＝主役復帰圏内）。テーマ履歴＝小セル(25)→タイマー凍結/可視復帰(26)→**決断面/IG comment-to-DM(27)**。交差フロンティア(P13〜P18)には戻らず。**第20回reach_path(ミニアプリタブ)・第23回reach_path第2弾(AI回答面)に続く“第3弾”＝別の面(IG DM)・別のAPI(Meta Private Replies=S一次)・新論点(まだら計測=DMは店主が導線を握れるぶんai_answerより測れる)で一段広げた**（第22/23回の“追加観点 第N弾”還流型をビート3で継続）。起源掘りは会話コマース(Chris Messina 2015造語→2016宣言・Uber×Messenger)を選び、07-25「決断面が内側へ移る方向」・08-06「LINEミニアプリの器」・08-09「AI予約の主体交代」に続いて“会話が取引の場になった原点”を根拠づけた。**新種は起こさず既存P11/P5への追加観点に留める（seed-sprawl回避）。**

## 追加の種（2026-08-14・目付第28回巡回からの還流）

**前提**：ビート2（計測・分析技術）の**未踏サブ＝「イベント設計／計測実装の堅牢化」**（第26回で名指し・指標定義でも小セルでもない別サブ）へローテーション。実装照合表（P0-P3済）・P5・P3補遺(AFP)・P6・P7〜P19・reach_path系(第20/23/27)・小セル(第25)・P12訂正(第26)とは**重複しない新規種P20**。テーマは「**入り口で受け取るイベントのキー(box_key)を、宣言済みの箱に照合せず“何でも”受け入れている**＝カーディナリティ無制限＋スキーマ非検証」。現物 `collect` 受け口を grep して当たった。**新種を起こす前に還流ノートのP番号一覧(P0〜P19)を grep し衝突なしを確認済（P20は未使用）。コードは触っていない。**

### 【P20・新規種／ビート2 イベント設計・堅牢化】collect受け口で `box_key` を「そのページが宣言した箱の一覧(allowlist)」に照合し、未知キーは捨てずに `(other)` バケツへ畳んで“件数を可視化”する＋1バッチの `boxes` 本数に上限を置く（＝カーディナリティ爆発とスキーマ汚染を入り口で弾く）
- **現象（目付がgrep）＝入り口は既に型防御が堅いが“キーの正しさ”は無検査**：`POST /api/attn/collect`（app.mjs 244-311行）は既に**JSON parse ガード(246)・要配慮情報の剥がし(248)・必須フィールド検証(249)・target_id/change_id/measurement_phase の正規表現/enum検証(256-259)・`active_sec` の `Number.isFinite` 型防御(292)・box の `engagement` を0〜100にクランプ(308)・P1単調増加マージ**まで施された“当たり”の受け口。ところが**box のキー `box_key` は「文字列でありさえすれば何でも」通す**（300-301行 `if (!b || typeof b.box_key !== 'string') continue;`）。**そのページが宣言した箱の一覧（`store.boxes` を `page_id` で絞ったもの＝hero/problem/…/cta の8個）に照合していない**し、**1バッチの `boxes` 配列の本数にも上限が無い**（299行 `Array.isArray(d.boxes) ? d.boxes : []` をそのまま全件ループ）。
  - **下流は宣言済みの箱しか読まない＝未知キーは“書かれるが二度と読まれない”純粋な汚染**：journey(108-110行)・evalTags(174-175行)・friend journey(209-211行)は**いずれも `store.boxes.filter(page_id==)` を回して `box_stats.get(anon::box_key)` を引く**＝**宣言済みの箱だけを集計**する。よって collect が受けた未知の `box_key` は `box_stats` Map に**格納されるが、どの集計にも二度と現れない**。＝バグったSDK版・キーのtypo/rename・悪意ある改ざん（collectは公開受け口＝クライアントが自由にPOST可能）で**無限に増えうる別キー**が、静かに Map を膨らませ続ける（例えると：お店のアンケート箱に、実在しない架空の設問番号の回答用紙が毎日投げ込まれ、集計には一切使われないのに箱だけが際限なく膨らんでいく）。
  - **カーディナリティ爆発は purge も遅くする（二次被害）**：`purgeExpired`(69-85行)は**セッションが失効した時だけ** box_stats をカスケード削除し、しかも**purge対象 anon 1件ごとに `[...store.box_stats.keys()]` 全走査**（80行）＝box_stats が肥大するほど purge が **O(anon数 × box_stats総数)** に悪化。未知キーは「座って容量を食う」だけでなく「掃除のたびに全部を舐めさせる」。
- **他種との非重複（実装照合の要）**：**P2**（bot除外＝UA/挙動でリクエスト<u>丸ごと</u>隔離）とは別レイヤー——P20は正規の人間の来訪でも起きる“キー単位”の検証。**P1**（単調増加マージ）は**正しいキー前提**で値の巻き戻りを防ぐ種＝キーの正当性は見ていない（P20が上流で補完）。**P6**（max_scroll＝新しい信号を<u>足す</u>）とも逆向き（P20は<u>受け取りを絞る</u>）。**小セル抑制（第25回）**は“数え上げが少なすぎる1マス”を伏せる話＝**カーディナリティは逆に“別キーが多すぎる”反対側の失敗**（GA4でいう高カーディナリティ→`(other)` 行）。→ P20＝**入り口のスキーマ検証（schema-on-write）／カーディナリティ上限**という未踏の機構。
- **対策案（コードは触らない・採否/しきい値はDaiya・同意/スキーマ版の法規制面は見廻り）**：
  - **① `box_key` を allowlist 照合**：collect の box ループで `store.boxes.filter(b=>b.page_id===page.id)` の `box_key` 集合に**含まれるキーだけ** box_stats へ書く。含まれないキーは**捨てるのでなく `(other)` 相当のバケツ（例：`__other__`）に畳み、かつ「未知キーを何件畳んだか」を bot-report と同じ思想で可視化**（黙って消さない＝店主/実装者が“SDKのtypoかキーrenameか改ざんか”に気づける）。＝Snowplowの「スキーマ違反イベントを bad-events に隔離して見える化」、GA4の「上限超過分を `(other)` に畳む」の現物版。
  - **② 1バッチの `boxes` 本数に上限**：`boxList` を先頭 K 本（例：宣言済み箱数＋余裕）に切り、超過は①と同じく `(other)` へ集約＋件数記録。1回のPOSTで Map を任意に膨らませられる穴を塞ぐ。
  - **③【隣接・任意】collectペイロードに `schema_version`（or `sdk_version`）を1個持たせる**：同意には既に `purpose_version`（60行・上げると旧同意は再同意待ち）があるが、**計測ペイロードのスキーマにはバージョン印が無い**。イベント設計の定石は「payload に明示的な `schema_version` を載せ、消費側が複数版を並行受理／不整合を検知」——将来 loku-attn.js のフィールドが増減した時に**古いキャッシュSDKと新受け口の食い違いを検知**できる。まずは受理して記録するだけ（弾かない）で十分。
- **根拠URL（機構＝S、定石＝A/S、現物＝目付grep）**：
  - Snowplow「Iglu schema registry / self-describing events / failed events」＝**スキーマレジストリに登録した JSON Schema でイベントを検証し、違反は bad-events に隔離**（schema-on-write の代表実装・A/S） https://docs.snowplow.io/docs/api-reference/iglu/ ／ https://docs.snowplow.io/docs/events/custom-events/self-describing-events/ ／ https://docs.snowplow.io/docs/api-reference/failed-events/
  - Google「[GA4] Cardinality」＝**1日500ユニーク超＝高カーディナリティ／レポート日次5万行上限を超えた分は `(other)` に畳む**（S一次） https://support.google.com/analytics/answer/12226705
  - 「Analytics Implementation Guide 2026」/ Trackingplan＝**payload を取込前にスキーマ検証・本番は strict validation＋エラーログ／`event_version`(schema_version) を各イベントに載せ複数版を並行受理**（A/B） https://webflow.trackingplan.com/blog/analytics-implementation-guide-2026-error-detection-en ／ Segment Protocols Tracking Plan https://segment.com/docs/protocols/tracking-plan/create/
  - Confluent「Schema Registry / Data Contracts」＝**書き込み境界に立つインラインの門で、スキーマ非互換メッセージがトピックに入る前に弾く**（schema-on-write の起源・A） https://docs.confluent.io/platform/current/schema-registry/fundamentals/data-contracts.html
  - PostHog「Schema management」＝**型付きプロパティグループでイベント構造を定義・強制**（A） https://posthog.com/docs/product-analytics/schema-management.md
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（collect 244-311行＝型防御は堅いが `box_key` は文字列チェックのみ300-301行・allowlist照合なし・`boxes` 本数上限なし299行／宣言済み箱 `store.boxes` 20-37行=8キー／下流集計は宣言済み箱のみ 108-110・174-175・209-211行／purge の box_stats 全走査 80行／同意版 `purpose_version` 60行に対しペイロードスキーマ版は無し）
- **検証方法**：実機/ユニットE2E（メイン領分・1スタジオ目本番化時・P7〜P19と同じ境界テスト群で）。①**未知の `box_key`（例 `hero_v2`・`__inject__`）を含むバッチ**を投げ、box_stats に生キーで積まれず `(other)` へ畳まれ＋「未知キーN件」がレポートに出るか（負のテスト＝汚染キーが黙って溜まらない）②**`boxes` を1万本**送っても上限で頭打ちになり Map が線形に膨らまないか③**宣言済みキーだけのバッチは従来どおり**P1単調増加マージで積まれる後方互換④purge が box_stats 肥大でも線形コストに留まるか⑤`schema_version` を載せた/載せないバッチが両方受理され、版が記録されるか。
- **優先度**：**P20（低〜中）**——データ破損の即時被害は小さい（未知キーは下流に出ないため“数字を狂わせる”より“静かに溜める/掃除を重くする”害）。ただし**collectは公開受け口**でクライアント改ざん・SDKのtypo/rename・スキーマドリフトが**構造的に起こりうる**入り口＝“入場ゲートでキーを検める”のは計測土台の衛生の基本。効くのは(1)未知キーが `(other)` に畳まれ**件数が可視化**（SDK不整合の早期発見）(2)1バッチのキー爆発でMap/purgeが暴れない(3)将来のスキーマ変更に `schema_version` で備える、の3点。実装は「allowlist 1照合＋length 1クランプ＋任意の版フィールド記録」＝軽い。**採否・しきい値(K)・実装・QAはDaiya／メイン領分。コードは触っていない。**
- **⚠️見廻り（lp-mimawari）へ申し送り**：`schema_version`（計測ペイロードのスキーマ版）を導入する場合、同意の `purpose_version`（上げると再同意待ち）と**似て非なる**——スキーマ版は“収集フィールドの構造”の版、目的版は“利用目的”の版。**新フィールド追加が「利用目的の変更」に当たるか（＝再同意要否）**の線引きは見廻り領分。`(other)` バケツに畳んだ未知キーの保持も、生キー文字列に個人情報が紛れないかの観点で一応の確認を。
- **⚠️番人(qa-auditor)へ申し送り**：**負のテスト**として「未知 `box_key`／`boxes` 過剰本数／`schema_version` 不一致」の3ケースを QA 境界テストに追加——(1)未知キーが宣言済み箱の集計（読了率・タグ発火）に**混入しない**(2)`(other)` 件数が**可視化**される(3)宣言済みキーの**後方互換**が壊れない、を確認。P1マージ・P0離脱二段との二重処理でも冪等。
- **⚠️物見(intel-scout)へ申し送り**：**スキーマレジストリ／データコントラクト／schema-on-write**（Snowplow Iglu・Confluent Schema Registry・Segment Protocols・PostHog Schema management）は2026の計測ガバナンスの本流。「イベント契約に必ず責任者を置き版管理する」思想は業界ニュースの継続鉱脈。
- **位置づけ（テーマ転換・ビート2 イベント設計/堅牢化＝第26回名指し宿題の消化）**：第27回(ビート3/IG-DM)からローテーションし、宿題「(b)ビート2のイベント設計/計測実装の堅牢化＝未踏・第26回で名指し」を消化。テーマ履歴＝小セル(25)→タイマー凍結(26)→決断面/IG-DM(27)→**イベント設計/カーディナリティ・スキーマ検証(28)**。reach_path/決断面(第20/23/27)の3連続を回避し、交差フロンティア(P13〜P18)にも戻らず。**seed-sprawl下でも“新機構（入り口のスキーマ検証）”は既存P0〜P19のどれとも重ならないと確認できたため新種P20として起こした**（追加観点でなく新種＝過去6回の追加観点連続からの転換・ただし現物の“既に堅い型防御”を過剰批判せず「無検査なのは box_key の正当性1点」に射程を絞る規律は継続）。起源掘りは「なぜ計測は“壊れたイベントを入り口で弾く”（schema-on-write／スキーマレジストリ）を発明したのか」を選び、P20の対策思想（入場ゲートでキーを検める）を根拠づけた。

## 追加の種（2026-08-15・目付第29回巡回からの還流）

**前提**：ビート1（計測精度の敵）の**未踏サブ＝「同意モード（consent mode）が計測数字に与える歪み＝同意/通知拒否の分母欠落」**（第28回で名指し・第26/28宿題の最有力候補「ITP系の新定石／consent mode の計測影響＝タイマー/beacon/bot/広告ブロッカー/可視復帰/イベント設計以外の未踏サブ」）へローテーション。実装照合表（P0-P3済）・P5・AFP補遺・P6・P7〜P19・reach_path系(第20/23/27)・小セル(第25)・P12訂正(第26)・P20 box_keyスキーマ(第28)とは**重複しない新規種P21**。**新種を起こす前に還流ノートのP番号一覧(P0〜P20)を grep し衝突なし（“同意/分母/cookieless/denominator”は既存種になし＝consented は既存種が“踏襲する制約”として言及するのみで、種の主題にした種は無い）を確認済。コードは触っていない。**

### 【P21・新規種／ビート1 計測精度の敵】同意/通知を拒否した来訪を「起きた事実（匿名の分母）」として1件だけ数え、店主に“拒否率”を数字で見せる（＝拒否率の上昇を「来訪減・予約率上昇」と取り違えない分母ガード）
- **現象（目付がgrep）＝匿名計測は当たり・だが“拒否された来訪”が黙って消え、拒否率が数字にならない**：現物の同意モデルは2層に分かれている。
  - **(当たり＝過剰批判しない)** サーバ受け口 `POST /api/attn/collect`（app.mjs 244-311行）は**`consented` を一切見ない**＝匿名の来訪計測（セッション/箱ごと読了）は同意の有無に関わらず走る。プロファイリング側 `merge`/`journey`(380行)/`evalTags` だけが `consented` ゲートを踏む。＝**「同意なしでも“来た事実”は匿名で数える／同意ありで初めて実名プロファイル・タグを作る」＝Google が advanced consent mode で「拒否時も cookieless ping で“来訪の分母”は残し、同意時だけフル計測」とした思想と構造が同型＝設計の当たり**（client index.html 429行の掲示「匿名の集計にのみ使用」＝意図もこの方向）。ここは**追加不要**。
  - **(本物の抜け＝1点に絞る)** ところが**「同意/通知を“拒否された”という事実そのもの」を数える受け皿が無い**。①client `doMerge`（index.html 422-432行）は consent 未チェックなら**その場で return＝画面上は「同意なし」と出すが、サーバへ“拒否が1件起きた”という信号は送らない**。②サーバは `require_notice`（app.mjs 62行）が ON の時、`notice_shown!==true` の collect を**403で丸ごと突き返す**（261-262行）＝**通知前の来訪は分母からも消える**。③そもそも collect には「この来訪は同意あり/なし/未定」の**consent状態フィールドが無い**（244-311行）。結果、**同意/通知の姿勢が厳しくなった（既定オフ化・通知UI変更・プライバシー意識の高い層の流入増）だけで、店主から見える来訪数が静かに目減りする**のに、**その原因が「拒否率が上がった」なのか「本当に客足が減った」なのか区別できない**（例えると：お店の入口で「アンケートに答えますか？」に首を振った客を、断った瞬間に“来店者名簿からも消して”しまうので、後で「今月お客が減った」のか「アンケート嫌いの人が増えて数え落としただけ」なのか、店主には永遠に分からない）。
  - **害の質＝“分母デフレ”で率が水増しされる**：業界の記録では**同意バナーだけで2026年下限で約20%、条件次第で「10万セッションと見えて実は16万」規模の分母欠落**が起きる（B）。Loku の効果台帳・実測CVR は `bookings`（予約が入った friend_id＝分子）を**来訪の分母**で割る。分母（測れた来訪）が拒否率上昇で縮むと、**予約率・改善効果が“実力以上に良く”見える**＝店主に見せる数字が上振れする方向に狂う。これは「数字を狂わせるより静かに溜める」P20とは逆で、**直接“率”を上向きに歪める**タチの悪さ。
- **他種との非重複（実装照合の要）**：**P3**（anon_id が ITP 7日で揮発）は**同じ人の再訪キーが切れる**話＝“縦（時間）の取りこぼし”。P21は**同意/通知を断った来訪が分母から抜ける**＝“横（母集団）の取りこぼし”で別軸。**P2**（bot 丸ごと隔離＋bot-report で可視化）とは**「黙って消さず件数を見せる」思想が同型**だが、対象が「非人間」でなく「拒否した人間の来訪」で別レイヤー。**P20**（未知 box_key を `(other)` で可視化）とも“可視化して黙って消さない”思想は同じだが、P20は分子側の汚染・P21は**分母側の欠落**で反対側。→ P21＝**同意/通知拒否の観測可能化（consent-state の記録＋拒否率の分母ガード）**という未踏の機構。
- **対策案（コードは触らない・採否/しきい値はDaiya・同意方式の法規制面は見廻り）**：
  - **① collect に軽量な `consent_state`（`granted`/`denied`/`unknown`）を1個持たせ、拒否でも“来訪1件”は匿名で必ず数える**：client が同意を断った時も、**実名プロファイル・タグは作らず**（現行の当たりを維持）、**「来訪が起き、consent=denied だった」という匿名1件だけ**を collect で送る（＝advanced consent mode の cookieless ping の現物版・index.html 429行の“匿名集計にのみ使用”の掲示を実装で裏づける）。個人識別子(anon_id の永続化)は積まなくてよい＝“数える”だけ。
  - **② 店主レポートに「同意/通知の拒否率（denied ÷ 全来訪）」を1行出す**：bot-report と同じ「黙って消さず可視化」思想で、**拒否率そのものを数字にする**。これで来訪数の変動を「拒否率が○%へ上昇」と「実来訪が減少」に**切り分けられる**＝分母デフレを率の改善と誤読しない。
  - **③【隣接・任意】`require_notice` ON時の403も“拒否/未通知として1件記録”してから弾く**：通知前の来訪を突き返すのは規律として正しい（取得タイミングの保証）。ただし**「何件を通知前で弾いたか」を数えて残す**と、通知UIの出し遅れ・不達を店主/実装者が発見できる（現行は黙って403＝消える）。弾く判断は変えず、**弾いた件数の可視化だけ**足す。
- **根拠URL（機構＝S/A、業界数字＝B、現物＝目付grep）**：
  - Google「About consent mode」/「consent mode modeling」/ Tag Platform「Consent mode overview」＝**advanced は拒否時も cookieless ping を送り“来訪の分母”を残しモデリングで補完／basic は拒否時に何も送らずタグを完全ブロック＝分母ごと欠落**（S一次） https://support.google.com/analytics/answer/10000067 ／ https://support.google.com/google-ads/answer/10548233 ／ https://developers.google.com/tag-platform/security/concepts/consent-mode
  - Apple/WebKit「Full Third-Party Cookie Blocking and More」＝ITP は script-writable storage を7日で削除（S・P3の根拠＝縦の取りこぼし側で別軸だが同意と並ぶ“分母/母集団を削る力”の一次） https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
  - 「consent-denied traffic / denominator distortion 2026」＝**同意バナーだけで2026下限20%の分母欠落・conversion rate は過少分母で過大表示・ROAS 誤配分／10万と見えて実16万規模**（B・数字は作らず引用） https://calibrate-analytics.com/insights/2026/04/05/How-Privacy-Laws-and-Consent-Mechanics-Are-Impacting-GA4-Measurement/ ／ https://yassersoliman.com/blog/the-analytics-trust-gap-why-your-ga4-is-lying-to-you/ ／ Google Consent Mode 2026-06-15 更新（ad_storage 一本化）secureprivacy/ALM（B・答え合わせ側の版更新） https://secureprivacy.ai/blog/google-consent-mode-june-2026-ad-storage-is-now-the-only-gate-on-ga4-ads-data
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（collect 244-311行＝`consented` 非参照＝匿名計測は同意ゲートなし＝当たり／`require_notice` 62行＋403弾き 261-262行＝通知前来訪を丸ごと突き返す／collect に consent_state フィールド無し／journey 380行 `consented` ゲート／identity `{friend_id, consented}` 48行）・index.html（consentbar 138-140行 既定checked／doMerge 422-432行＝未同意でその場return・サーバへ拒否信号なし・429行「匿名の集計にのみ使用」の掲示）
- **検証方法**：実機/ユニットE2E（メイン領分・1スタジオ目本番化時・P7〜P20と同じ境界テスト群で）。①**同意を断った来訪**で、実名プロファイル/タグが作られないまま `consent_state=denied` の匿名1件が collect され、店主レポートに拒否率が出るか（負のテスト＝断った客が“来訪ゼロ”に丸められない）②**拒否率だけを人為的に上げた**来訪群で、実測CVR/効果台帳が**上振れしない**（分母が拒否分も保つ）か③`require_notice` ON で通知前来訪を403で弾いても「弾いた件数」が残るか④consent_state を足しても P1単調増加マージ・P20 allowlist・P0離脱二段と二重に走らず冪等か⑤既存の consented ゲート（merge/journey/tag）が**従来どおり実名側だけを止める**後方互換。
- **優先度**：**P21（中）**——P20（低〜中）より一段高い。理由＝**分母デフレは“率”を直接上向きに歪め、店主の意思決定（この打ち手は効いた/効かない）に直結する**から。効くのは(1)拒否率が数字になり来訪変動の原因を切り分けられる(2)効果台帳・実測CVRが拒否率上昇で水増しされない(3)advanced consent mode の“分母を残す”定石を、実名プロファイルは同意時のみという現行の当たりを崩さずに実装できる、の3点。実装は「collect に enum 1フィールド＋レポートに1行＋403前に1カウント」＝軽い。**採否・しきい値・実装・QAはDaiya／メイン領分。コードは触っていない。**
- **⚠️見廻り（lp-mimawari）へ申し送り**：`consent_state=denied` の匿名来訪を1件数える設計は、**「同意なしで“来訪が起きた事実”を匿名集計する」ことが APPI/GDPR 上どこまで許されるか（＝個人関連情報に当たらない純粋なカウントか）**の線引きが要る。Google が advanced consent mode の cookieless ping を「個人識別子なし」と位置づけている整理が参考。`require_notice`（外部送信通知）ON時の“弾いた件数”記録も、記録内容に個人情報が紛れない設計であることの確認を。**採否・法適合の判断は見廻り／Daiya領分**。
- **⚠️番人(qa-auditor)へ申し送り**：**負のテスト**として「同意拒否の来訪／`require_notice` ON の通知前来訪／拒否率だけ上昇」の3ケースを QA 境界テストに追加——(1)拒否客が実名プロファイル/タグを一切生成しない(2)にもかかわらず匿名の分母には1件残る(3)拒否率上昇で実測CVR/効果台帳が上振れしない、を確認。P1マージ・P0離脱二段・P20 allowlist との二重処理でも冪等。
- **⚠️物見(intel-scout)へ申し送り**：**Google Consent Mode 2026-06-15 更新（ad_storage 一本化＝GA4/Ads の同意ゲート統合）**と「consent-denied による分母欠落を“モデリング/cookieless ping で埋める”か“正直に欠落を見せる”か」の議論は、2026 の計測ガバナンスの本流。プライバシー規制×計測の交点は継続鉱脈（見廻りと領分が重なるので一次の規制発表は見廻りへ、計測技術としての“分母の埋め方”は目付/物見へ振り分け）。
- **位置づけ（テーマ転換・ビート1 consent mode 計測影響＝第28回名指し宿題の消化）**：第28回(ビート2/イベント設計P20)からローテーションし、宿題「(a)ビート1のITP系/consent mode計測影響＝未踏サブが最有力」を消化。テーマ履歴＝タイマー凍結(26)→決断面/IG-DM(27)→イベント設計/box_key(28)→**consent mode/分母欠落(29)**＝直近ビート1(26=タイマー凍結)から“別サブ”へ・イベント設計(28直近)の連続も回避。**現物の“collect が consented 非参照＝匿名計測は当たり”を過剰批判せず「拒否率が数字にならない1点」に射程を絞る規律を継続（第9回以降・連続維持）。**seed-sprawl下でも“新機構（consent-state の観測可能化・分母ガード）”は既存P0〜P20のどれとも重ならないと確認し新種P21として起こした。起源掘りは「なぜ consent mode／cookieless ping は生まれたのか＝同意拒否で計測がゼロになるのを避ける発明」を選び、P21の対策思想（拒否でも分母は残す）を根拠づけた。

## 追加観点（2026-08-16・目付第30回巡回からの還流）

**前提**：以下は**新規P番号を起こさない**。既存の P11（決断面 surface）・P5（流入 reach_path）・reach_path 追加観点 第2弾（`ai_answer`）・第3弾（`ig_dm`）の**enum 精緻化**であり、実装照合表（P0-P3済）・P0〜P21 のどれとも重複させない（着手前に P0〜P21 を grep し「RwG/Reserve with Google/Google内予約完結」を主題に持つ既存種が無いことを確認済）。**コードは触っていない。** 採否・実装・QAはDaiya／メイン領分。

### 【P11＋P5 reach_path 追加観点 第4弾（新種ではない）】Google AI Mode のエージェント予約が「Reserve with Google（RwG）」を土台に“予約という決断を Google の中で完結”させる面を、reach_path で正直に扱い、かつ「RwG未接続＝AI予約に載らず母数が縮む／接続済み＝Google内完結でLP非経由の天井」の二重の穴を明示する

- **現象（ビート3・S一次→traced＋公式プログラム）**：Google I/O 2026（S一次・第23回で確認）で AI Mode の**エージェント予約（agentic booking）**を、レストラン予約（春に多国先行）に続き**美容・ウェルネスの施術予約＋イベントチケット**へ拡張。客が会話で条件を伝えると Google が**在庫・価格を集めてその場で予約完結**、選択カテゴリ（美容/ペットケア/住宅修理）では**「本人に代わってAIが店へ電話」**まで踏み込む。**2026年夏に全米ローローアウト・早8月時点で進行中**。＝第23回で `ai_answer` と抽象化した「AI予約代行」の具体的土台が **Reserve with Google（RwG）** と判明。
  - **RwG＝配管の正体（Google公式プログラム）**：店が RwG の**予約パートナー（予約SaaS）**を繋ぐと、Maps/検索の店リストに**「Book online」ボタン**が出て客はサイトに来ず1〜2タップで予約（88か国超）。AI Mode/AIローカルパックが「その店で今すぐ予約できるか」を判断する材料も、この RwG パートナーが同期する**リアルタイム在庫・価格**。→ここに**2つの穴が同時に開く**：**(a)** RwG未接続の店は AI Mode の予約候補に**載らない**＝LP到達の**母数そのものが縮む**（第23回 Sterling Sky「新AIローカルパックに載るのは旧3枠の約32%＝5,943 vs 18,330店」の掲載母数縮みの"配管版"）／**(b)** RwG接続済みの店は予約が**Google内で完結**＝客は一度もLPに来ない（第23回 `ai_answer` の"真っ暗天井"が配管まで具体化）。
  - **3ビート横断で同方向（第20/23/27の潮流の現在地）**：Google=RwG/AI Mode内完結（今回）／LINE=ミニアプリタブ・リッチメニュー内で決断（第20・S一次）／Instagram=comment-to-DM＝Meta公式 Private Replies（第27・S一次）。決断面の内側化は主戦場3面すべてで進行。
- **現物確認（目付がgrep・過剰批判はしない・現物読みで“既に堅い部分”を切り分け）**：(1) `POST /api/attn/booking`（app.mjs 429-435行）は `{friend_id}` のみで `store.bookings.add(d.friend_id)`＝**“どの面で決めたか（surface）”も“どの到達路で来たか（reach_path）”も持たない**のは P11／第2・3弾で既特定。(2) reach_path enum（提案値 `lp / richmenu / miniapp_tab / ai_answer / ig_dm / unknown`）は、**`ai_answer`（AI回答面からLPへ着地）は持つが、「RwG/AI Mode の中で予約が完結し一度もLPに来ない」真っ暗天井を区別する値／注記が無い**。(3) 流入 `entry_query/entry_pos/entry_health`（app.mjs 283-288行・P5）は、RwG/AI Mode 経由だと **referrer が Google系AI面 or 空**になりやすく入口ブラインドが拡大。(4) **母数側の穴＝RwG未接続で AI Mode に載らず来訪母数が縮む**現象は、Loku の“来訪データ”には**そもそもレコードが発生しない**ため、現物のどの層でも捕捉できない（＝第23回の掲載母数縮みと同じ「測る以前の欠落」）。(5) ⚠️既存の `surface`（app.mjs 478-493行＝`/api/attn/product-events`/`product-funnel`＝自己改善画面のステップ計測）とは**別名前空間**（P14で確認済）＝流用しない。
- **対策案（射程を絞る・新種P番号は起こさない・採否はDaiya/メイン判断）**：
  - **① `gbp` 面を"まだら"で割る（第27回 ig_dm の濃淡を横展開）**：予約の決断面 surface=`gbp` を、reach_path で **(a) `gbp_rwg`（RwG/AI Mode の中で予約完結＝真っ暗天井・LPレコードが存在しない）** と **(b) `gbp`（GBPプロフィール→自店LPへ着地＝`reach_path=gbp` で測れる）** に区別する任意サブ値を1つ足す。referrer が Google系AI面/空で、かつ booking 前に当該 friend_id のLP来訪レコードが皆無なら **推測で `lp` に寄せず `gbp_rwg`（or `unknown`）で正直にラベリング**。件数率は後方互換（reach_path なし＝従来集計に一致）。
  - **② "母数側の欠落"を店主レポに正直に注記する（数える受け皿は作れない＝正直さで代替）**：RwG未接続による掲載母数の縮みは**Loku側にレコードが発生しない構造的天井**なので、bot-report/拒否率（P21）のような"件数の可視化"はできない。代わりに、**「予約実数（店主が別途RwG/GBPで知る値）とLP来訪起点の予約数の乖離」を"異常"でなく"AI Mode/RwG経由（測れない天井）"として注記**する運用ラベルを持たせる（第23回 ai_answer・第27回 ig_dm と同じ「天井は正直に明示する」規律）。
  - **③【隣接・任意】RwG採用フラグを店設定に1個持つ**：その店が RwG パートナーに繋いでいるか（`store.rwg_connected` 相当）を店主が申告できると、乖離の原因を「RwG完結（天井）」か「本当の集客減」かに一段切り分けやすくなる。※外部API（RwG/Google予約の実データ突合）連携・同意設計は見廻り/メイン領分。
- **根拠URL（現象＝S一次→traced、RwG＝Google公式プログラム、実測母数＝A→traced、現物＝目付grep）**：
  - Google「Search's I/O 2026 updates: AI agents and more」＝AI Mode agentic booking のローカルサービス（美容/ウェルネス/イベント）拡張・夏 全米展開（S一次・第23回で確認・egress遮断のため今回は検索経由で再確認） https://blog.google/products-and-platforms/products/search/search-io-2026/
  - Search Engine Journal「Google Extends AI Travel Planning And Agentic Booking In Search」（B→traced） https://www.searchenginejournal.com/google-extends-ai-travel-planning-and-agentic-booking-in-search/561251/
  - Reserve with Google＝Google公式予約連携プログラム（Book online on Maps/Search・88か国超・予約パートナー経由でリアルタイム在庫同期）＝bukkii.ai/reserve-with-google（B・公式プログラム解説）／Professional Beauty「The New Rules of Google for Salons」（2026・B・美容店はRwGパートナー接続でAI検索に在庫を読ませる必要）／capconvert「Google's Agentic Booking for Local Services」（2026・B）
  - Sterling Sky（Joy Hawkins）＝新AIローカルパックに載る店は旧3枠の約32%（5,943 vs 18,330店・322市場88%減）＝掲載母数の縮み（A→traced・第23回で確認）
  - 現物: loku-tuning-plugin/handoff-demo/app.mjs（booking 429-435行＝`{friend_id}`のみ・面/reach_pathブラインド／entry 283-288行＝referrerブラインド／product-funnel surface 478-493行＝別名前空間）
- **検証方法**：実機/ユニットE2E（メイン領分・1スタジオ目本番化時・P7〜P21と同じ境界テスト群で）。①`reach_path` なしの既存 booking が後方互換で従来件数に一致②RwG/AI Mode 完結の予約が `gbp_rwg`（or `ai_answer`）で記録され `unknown`/`lp` に誤って落ちない（負のテスト＝推測でLP経由に丸めない）③RwG未接続による母数縮みを「計測障害」と誤検知せず"天井"として注記できるか④P11面別台帳・reach_path 第2弾（`ai_answer`）/第3弾（`ig_dm`）値との二重定義にならないか。
- **優先度**：**中**（reach_path 第2/3弾と同格）——RwG/AI Mode の美容/ウェルネス展開は主戦場ど真ん中で進行中だが、実比率は本番待ち＝“来た時に正直にラベリングできる器”を先に用意する備え。件数を狂わせるより「決断がLPの外で起きた事実を天井として明示する」正直さの担保が主眼。
- **⚠️見廻り(lp-mimawari)へ申し送り**：RwG/AI Mode 経由の予約は予約データ（氏名・連絡先・来店実績）が Google→予約パートナー→店をまたいで流れる＝APPI/GDPR上の「第三者提供・委託」の整理と、プライバシー通知への Google/RwG 連携の明記が要る可能性。RwG採用時の同意・データ連携の法規制面は見廻りの領分。
- **⚠️番人(qa-auditor)へ申し送り**：上の検証方法①〜④を境界テストに追加。特に②の負のテスト（推測で `lp` に丸めない）と③（母数縮みを障害と誤検知しない）を重視。P1マージ・P11面別・reach_path 第2/3弾との二重処理でも冪等。
- **⚠️物見(intel-scout)へ申し送り**：Reserve with Google の採用動向・AI Mode 予約の日本展開時期／エージェンティックブラウザのシェア勢力図（HUMAN Security Jun 2026＝Claude Chrome が20.8%で2位浮上・Comet 47.6%・Atlas 16.5%）は業界動向の本流。決断面の内側化＝一次のプラットフォーム発表は目付が計測影響として拾い、純ニュース面は物見へ。
- **位置づけ（テーマローテーション13手目＝第29回名指し宿題「(a)ビート3 決断面＝主役復帰圏・手薄」の消化）**：第29回(ビート1/consent mode P21)からローテーションし、宿題「(a)ビート3の決断面（第27から3回離れ・手薄・主役復帰圏。GBP/LINE/Instagram の意思決定UIの新動き）」を消化。テーマ履歴＝イベント設計/box_key(28)→consent/分母(29)→**決断面/AI Mode・RwG(30)**＝直近3回でビート2×1/ビート1×1/ビート3×1＝均等化を維持。reach_path・決断面は第27から2回空けた第30ゆえOK（3連続=第20/23/27の再来は回避）。**新種を無闇に増やさず既存 reach_path enum の精緻化（第4弾）に収めた**＝seed-sprawl回避の規律を継続（第22〜27の追加観点方式へ回帰）。

## 追加の種（2026-08-17・目付第31回巡回からの還流）

**前提**：以下は実装照合表（P0-P3済）・P5・P3補遺(AFP)・P6〜P21・reach_path追加観点第2〜4弾とは**重複しない新規種P22**。テーマは「ビート2＝計測ツールの新機能を一次で深掘り」。GA4/PostHog/Clarity が2026に揃って**「自分の計測が黙って壊れていないか」を測る機能（instrumentation health／data observability）**を実装したのを入口に、現物 index.html の `flush()` と app.mjs の `collect` をgrepして**「計測が黙って止まったことを誰も知れない」メタ層の穴**に当たった。着手前に P0〜P21 を grep し、既存種はいずれも「データは来る」前提＝**メタ層＝装置そのものの死活**は未踏と確認して新種P22とした。**コードは触っていない。** 採否・実装・QAはDaiya／メイン領分。

### 【P22・新規種／ビート2 計測ツール新機能＝計測の死活監視】計測パイプラインの"死活"を店主/実装者に見せる — (a)ページ別"最終受信ヒートビート"で「計測停止の疑い」を「客が減った」と取り違えない (b)collectの拒否(400/404/403)を黙って捨てず件数化する

- **現象（ビート2・A×2＋B＝3社が別動機で同結論へ収束）**：計測ツール業界が2026に「自分の計測の健全性を測る」機能を揃って実装。
  - **PostHog「Health Checks（Beta）」（A）**＝**「No live events（プロジェクトがイベントを受信しなくなった＝計測が沈黙）」「古いSDK」「ingestion warnings（`null`のような不正IDでの送信等）」「壊れたデータモデル」**を検知し **Self-driving Inbox** へ Signal 化（リポ接続でエージェントが原因特定～修正PRまで）。＝"送られてくる数字が正しいか"の手前で"そもそも送られてきているか"を見張る層。
  - **Microsoft Clarity（A）**＝Copilotがセッション録画を自動要約し**異常（rage click＝苛立ちの連打／dead click＝空クリック）**を報告＋**AI bot activity reporting**（どの自動化システムが自サイトに来て何に触れたか可視化）。＝「計測を歪めうる異常・非人間の来訪」自体を一級レポート化。
  - **GA4（B→traced）**＝**データストリームが不活性/誤設定になると通知する診断**・**閾値を店側が決める異常検知**（モデル予測と実データの乖離で急落/急増を旗立て）。
  - ＝**3社・別々の動機（開発者/UX/マーケ計測）で同じ「自分の計測の健全性を測れ」へ合流**＝一本崩れても結論が残る多重根拠（第25回“異分野合流”と同型）。背景思想＝**data observability（Barr Moses/Monte Carlo 2019・“silent data downtime＝データが黙って壊れる期間”）**＝「エラーを出さずに間違った値を出し続ける」最悪の失敗モードを監視対象へ格上げ。
- **現物確認（目付がgrep・過剰批判はしない・現物読みで"既に堅い部分"を切り分け）**：Lokuの受け口は既に堅い（P0-P21＝JSON検証/要配慮剥がし/型防御/engagementクランプ/P1単調増加マージ/box_key allowlist/consent分母）が、**その堅い受け口が「黙って止まった」ことを誰も知れない**のが最後の穴。
  - (1) **client `flush()`（index.html 469-476行）は `navigator.sendBeacon` を `try/catch` で包み失敗を握り潰す（473行 `catch(e){}`）**＝送信不達を誰も知らない。※P19（返り値false→fetchフォールバック）は"1発の送信"の信頼性で別レイヤー。
  - (2) **server `collect`（app.mjs 244-311行）は `sess.last_seen_at = Date.now()` を刻む（295行）が、これは purge用（66-72行）**で、**ページ別に"最後にデータが来た時刻／沈黙したか"を集計する店主向けビューは無い**。
  - (3) **拒否パス（bad json 400=246行・anon/slug無 400=249行・unknown page 404=251行・notice未提示 403=262行）は全て件数を残さず `return`＝黙って消える**（P21が require_notice 403 で指摘した"黙って消える"の一般形＝**unknown page 404 スパイク＝スラッグ古い/スニペット貼り間違いが不可視**）。
  - (4) 既存の店主向けレポは bot-report（P2・692行）/diagnose/conversion-by-tag/product-funnel＝**"計測が生きているか"のレポは無い**。
- **対策案（射程を絞る・採否はDaiya/メイン判断・コードは触らない）**：
  - **① ページ別"最終受信ヒートビート＋期待cadence"**：`page_id` 別に `last_collect_at` を持ち、"直近Nの窓でゼロ＝沈黙"を store owner レポに**「計測停止の疑い」**として出す（drop-to-zero を"客が減った"に丸めない）。bot-report/拒否率(P21)と同じ「黙って消さず可視化」思想。
  - **② collect拒否の件数化**：400/404/403 を**理由別カウンタ**に残す（unknown page 404 スパイク＝スラッグ不整合／400スパイク＝SDK破損 を実装者が発見）。弾く判断は変えず件数だけ足す（P21③「弾いた件数の可視化」の一般化）。
  - **③【隣接・任意】client 側 flush の失敗**（sendBeacon false／try/catch 捕捉）を"次バッチにピギーバック"で1カウントだけ運ぶ＝不達の可視化（P19の返り値チェックと同居可能・別目的）。
- **根拠URL（機構＝A/S、業界＝B、起源＝B、現物＝目付grep）**：
  - PostHog Docs「Health Checks (Beta)」＝**No live events／古いSDK／ingestion warnings／壊れたデータモデルを Signal 化**（A・posthog.com公式docs・egress遮断のため検索経由で内容確認） https://posthog.com/docs/health-checks ／ https://posthog.com/docs/health-checks/no-live-events ／ https://posthog.com/docs/data/ingestion-warnings
  - Microsoft Clarity（A・2026 AI機能＝Copilotセッション異常サマリ＋AI bot activity reporting） https://clarity.microsoft.com/blog/ ／ https://learn.microsoft.com/en-us/clarity/faq
  - GA4 ストリーム診断/異常検知（B→traced・support.google.comコミュニティ「No stream data detected」/「Data stream not flowing」・tatvic/whistlerbillboards）
  - data observability＝Barr Moses/Monte Carlo 2019「silent data downtime」（B・起源） https://www.accel.com/spotlight-on/episodes/montecarlo-barr-moses
  - 現物: loku-tuning-plugin/index.html（flush 469-476行＝sendBeacon try/catch握り潰し）・handoff-demo/app.mjs（collect 244-311行＝last_seen_at 295行=purge用66-72行・拒否 246/249/251/262行が件数残さず return・bot-report 692行のみで死活レポ無し）
- **検証方法**：実機/ユニットE2E（メイン領分・1スタジオ目本番化時・P7〜P21と同じ境界テスト群で）。①あるページの collect を止めた時、店主レポに**「計測停止の疑い」**が出るか（負のテスト＝"客ゼロ"に丸めない）②stale slug で 404 が出た時、拒否カウンタが増え原因が辿れるか③ヒートビート/カウンタを足しても P0離脱二段・P1マージ・P20 allowlist・P21分母と冪等か④正常時に誤検知（生きてるのに"停止"）しないか⑤死活ログ/拒否カウンタに個人情報が紛れない（page_slug・時刻・件数のみ）か。
- **優先度**：**中**——サイレント計測障害は"率"でなく**"母集団の存在自体"を偽り**、店主が「効く施策を殺す／死んだ計測を信じる」に直結。効くのは(1)沈黙を"客減"と取り違えない(2)拒否スパイクで実装ミス（スラッグ/SDK）を早期発見(3)Lokuの"黙って消さず可視化"思想（bot-report/拒否率）を計測装置自身にも適用。実装は"page別last_collect_at＋拒否カウンタ＋レポ1画面"＝中規模。**採否・しきい値・実装・QAはDaiya／メイン領分。コードは触っていない。**
- **非重複（4象限＋メタ層＝新種判断の要）**：**P20=分子の汚染（汚いキーが来る）／P21=分母の欠落（拒否した人間が消える）／P3=縦の連続性（ITPキーが7日で失効）／P2=非人間（botの除外）**＝いずれも**「データは来る」前提**。**P22＝メタ層＝計測装置そのものの死活（データが来ない／丸ごと拒否される＝"黙って止まった"を検知）＝4象限のどれとも直交**。P0（1セッションの離脱送信）/P19（1発beaconのfalse→fallback）とも別＝**スニペットが外れたページは `flush()` すら呼ばれない＝per-send ガードでは原理的に見えない"集計の沈黙"**。
- **⚠️見廻り(lp-mimawari)へ申し送り**：計測死活ログ／拒否カウンタに**個人情報を紛れさせない設計**（page_slug・時刻・件数のみで来訪者個人が復元されない）の確認を。"黙って消さず記録"は監視に有用だが、記録内容の匿名性の線引きは見廻り/Daiya領分。
- **⚠️番人(qa-auditor)へ申し送り**：上の検証方法①〜⑤を境界テストに追加。特に①の負のテスト（計測停止を"客ゼロ"に丸めない）と④（正常時の誤検知なし）を重視。P0離脱二段・P1マージ・P20 allowlist・P21分母との二重処理でも冪等。
- **⚠️物見(intel-scout)へ申し送り**：data observability（Monte Carlo等）／計測監視の専業製品（Trackingplan等）の市場拡大と、PostHog Self-driving Inbox のような「計測障害をエージェントが自動修復」する潮流は2026の計測ガバナンスの本流＝業界動向として継続鉱脈。LIFF v2.30.0「複数OA連携」（9月日本先行）は決断面/導線ニュースとして純ニュース面は物見へ。
- **位置づけ（テーマローテーション14手目＝第30回名指し宿題「(a)ビート2の計測ツール新機能一次深掘り＝最有力」の消化）**：第30回(ビート3/決断面RwG)からローテーションし、宿題「(a)ビート2の計測ツール新機能一次深掘り（Clarity/PostHog/GA4 の未消化一次）」を消化。テーマ履歴＝consent/分母(29)→決断面/RwG(30)→**計測の死活監視(31)**＝決断面/reach_path(第30直近)の連続を回避・交差フロンティア(P13〜P18)に戻らず。ビート2でも指標定義(18/19/21)/小セル(25)/イベント設計(28)と別サブ＝「計測ツールが"自分の計測"を監視する新機能」は未踏サブ。**新種は第28 P20/第29 P21以来3回目だが、P0〜P21のどれとも機構が直交（メタ層＝装置の死活）と grep 確認した上で起こした＝「害の型が既存4象限の"外側"にあれば新種・内側なら追加観点」の判断を機械化。**

---

## 追加観点（2026-08-18・目付第32回巡回からの還流）

**前提**：以下は**新規P番号を起こさない**。既存の P3補遺（AFP＝Safari 26の高度フィンガープリント保護・07-14）／P3補遺拡張（AFP認定スクリプトは referrer/URLクエリも失う＝P3とP5を同時破壊・07-15）の**「認定“基準”」欄を埋める追加観点**。テーマは「ビート1＝計測精度の敵＝ITP系/AFP認定基準/fingerprint（第31回名指し宿題・積年の未踏サブ）」。P3補遺は「AFPが認定スクリプトに何を課すか（制限内容）」までは書いていたが、**「そもそもどのスクリプトが“認定”されるか＝認定基準」が未確定**（watchlist 07-14 以来）だった。今回それを一次/学術/実装者逆解析で特定。着手前に P0〜P22 を grep し、機構は既存 P3補遺の範囲内＝**新種は起こさない**（seed-sprawl回避）。**コードは触っていない。** 採否・実装・QAはDaiya／メイン領分。

### 【P3補遺への追加観点＝AFP認定基準の正体と“認定されない挙動条件”（新種ではない）】Safari 26 AFP の認定は「名指しリスト」でなく「挙動ベース分類器→端末内“既知トラッカー表”→ITPに畳まれ既定ON」＝loku-attn.js が表に載らない単一の挙動条件を満たせば P3(保存)と P5(referrer) を同時に守れる

- **現象（S/A＝認定“基準”の枠組みを特定・積年宿題の消化）**：AFPが「既知のフィンガープリントスクリプト」をどう選ぶかが判明。
  - **(1) 認定は“挙動ベースの分類器”（S/A）**＝WebKit「Tracking Prevention Policy」（S一次）が「**単一・少数の特徴でなく、検知した“挙動”に基づいてスクリプトを分類する**」方針を明記。学術系譜 **FP-Inspector**（USENIX/PETS 2020・S）が **AST（構文木）＋実行時のAPI呼び出しパターンを機械学習で「フィンガープリンタか否か」に分類**する手法を確立＝WebKit AFP の実装路線。同系の分類特許 US 12143369（A・機構裏取り／出願人はApple確定できず）も**関数フック＋実行帰属＋階層分析**で追跡目的のフィンガープリントを選り分けると記述。＝**認定は“どのドメインか（素性）”ではなく“どんな高エントロピーAPIをどう触るか（ふるまい）”で決まる**。触られる高エントロピーAPI＝canvas 2D読み出し・WebGL・Web Audio 読み出し・`hardwareConcurrency`（CPUコア数）・精密な画面寸法・SpeechSynthesis 音声一覧 等。
  - **(2) 分類の“出力”は端末内「既知トラッカー表」＝Safari本体と独立更新（A＋B→traced）**＝実装者 lapcatsoftware の逆解析（A）＝制限（保存24時間床＋referrer/URLクエリ封じ）は**端末内に置かれる「既知トラッカー表」ファイル**に載ったスクリプトへ適用され、その表は**Safari本体と独立に随時更新**される（第三者WebKitコード解析でも「追跡ルールは別システムライブラリに格納・独立更新」と一致＝B→traced）。
  - **(3) 独立トグルでなくITPに畳まれ既定ON（A＝前回P3補遺の前提を1つ訂正）**＝lapcat の逆解析＝これらの制限は**「高度な追跡・フィンガープリント保護」トグルではなく、ITP＝「サイト越えトラッキングを防ぐ」（既定ON）に紐づく**。＝P3補遺（07-14）が「AFP＝ITP 7日ルールとは別レイヤー・AFPトグル依存」と書いた前提を**「ITPに畳まれ既定ONで効く／表はITPと同じ機械」に訂正**。主戦場（LINE内WKWebView＝ITP既定ON＝07-15確定）では AFP由来制限も**ITPの延長として既定で効きうる**と見るのが安全。
  - **(4) 複数実装者の一致（B→traced）**＝2026の実装者ソース（ppc.land/taggrs/singular/stape 等）が揃って「**AFPは正当なファーストパーティ計測ではなく既知フィンガープリンタ／サイト越え追跡を狙う**」「**ファーストパーティは単一ドメイン内で動くので原則無傷**」「canvas/audio/screen を狙う」と述べる。
- **根拠URL（一次webkit.org 403・allowed_domains検索でS確認／学術S／実装者逆解析A／実装者一致B→traced）**：
  - WebKit「Tracking Prevention Policy」（S一次・挙動ベース分類の方針） https://webkit.org/tracking-prevention-policy/
  - WebKit「News from WWDC25: Safari 26 beta」（S一次・known fingerprinting scripts への高エントロピーAPI遮断） https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/
  - FP-Inspector「Fingerprinting the Fingerprinters」USENIX/PETS 2020（S・挙動ベース分類の学術系譜） https://arxiv.org/abs/2008.04480
  - フィンガープリント分類特許 US 12143369（A・機構裏取り・出願人未確認） https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12143369
  - lapcatsoftware「Safari 26 advanced fingerprinting protection: A confusing feature」（A・実装者逆解析＝ITP畳み込み／端末内表／未文書のクエリ隠しを試行錯誤で発見） https://lapcatsoftware.com/articles/2025/9/4.html
- **対策案（“認定されない挙動条件”の明文化・追加実装は原則不要・採否はDaiya/メイン判断・コードは触らない）**：loku-attn.js が**端末内「既知トラッカー表」に載らない単一の挙動条件**＝
  - **① ファーストパーティ同一オリジン配信**（collect も自ドメイン受け口）＝サイト越え追跡屋のふるまいをしない。※現状の loku-attn.js/app.mjs は自前配信・自前受け口＝当たり。
  - **② 高エントロピーAPI（canvas読み出し/WebGL/Web Audio/`hardwareConcurrency`/画面精密寸法/音声一覧）を“識別（匿名IDの補強）”に触らない**を明文化＝将来これらを端末識別に流用すると**挙動が“フィンガープリンタ”に寄り認定され得る**。※現状の匿名IDは端末個性に依存しない設計＝当たりを維持すること自体が条件。
  - **③ 既知トラッカー扱いのCDP/タグマネージャ（Segment/Tealium 等が分類対象化＝B→traced）と同ページ相乗り・経由をしない**＝“表”の巻き添えで loku-attn.js まで認定されるのを避ける。
  - ＝**この単一条件が P3(anon_id 保存＝再訪判定)と P5(referrer/URLクエリ＝起源判定)を同時に守る**（P3補遺拡張 07-15 が「単一条件で二重防御」と書いた線の、“基準”側を今回確定）。
- **検証方法**：AFP認定“閾値”自体はWebKit非公開ゆえ、最終判断は**実機観察（メイン領分・1スタジオ目本番化時）**＝Safari 26/LINE内WKWebView で ①anon_id 寿命が 7日/24時間どちらか ②`document.referrer`/URLクエリが着地JSで読めるか の縮退テスト（万一認定された場合の劣化確認）。＋**番人へ**：loku-attn.js が高エントロピーAPIを識別目的で触っていないかのコード監査（“フィンガープリンタの挙動”非該当の確認）。
- **優先度**：**中（前提の明文化・追加実装は原則不要）**。効くのは(1)「認定されるか否か」が**Loku側が制御できる挙動変数**だと確定した点(2)“認定されない挙動条件”をコード監査の物差しにできる点(3)P3補遺/拡張の「認定基準」欄が埋まり、P3(再訪)とP5(起源)を守る単一条件が言語化された点。**採否・実装・QAはDaiya／メイン領分。コードは触っていない。**
- **非重複（P3補遺の“基準”欄を埋める追加観点＝新種ではない）**：P3補遺（AFPの**制限内容**＝24時間床＋API遮断）／P3補遺拡張（referrer/URLクエリも失う＝**二重破壊の含意**）に対し、今回は**「認定“基準”＝挙動ベース分類器→端末内表→ITP畳み込み」**を埋める＝機構は既存 P3補遺の範囲内で**新種P番号は起こさない**（seed-sprawl回避・P0〜P22 grep 済）。同時に前回前提（別レイヤー・AFPトグル依存）を**ITP畳み込み・既定ONへ訂正**。
- **位置づけ（テーマローテーション15手目＝第31回名指し宿題「(a)ビート1のITP系/AFP認定基準/fingerprint の未踏サブ＝最有力」の消化）**：第31回(ビート2/計測死活監視)からローテーションし、宿題「(a)ビート1のITP系/AFP認定基準/fingerprint」を消化。計測死活監視(第31直近)/決断面reach_path(第30直近)の連続を回避・交差フロンティア(P13〜P18)に戻らず。ビート1でも consent(29)/タイマー(26)/bot(22)/beacon(18-19)と別サブ＝**AFPの認定“基準”は 07-14 以来の積年の未踏サブ**。**追加観点に留め新種を起こさなかった＝「制限内容(既出)の“基準”欄を埋める」は既存機構の精緻化＝seed-sprawl回避の規律を維持。**
