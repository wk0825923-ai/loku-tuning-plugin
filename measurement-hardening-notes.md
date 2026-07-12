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
