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
