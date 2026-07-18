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
