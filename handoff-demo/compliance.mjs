// コンプライアンス機構（法務監査 legal-audit.html の対策を実装）
// ① 業種別NGワードチェッカー（薬機法・景表法・柔整/あはき広告規制）
// ② 要配慮個人情報のガード（症状/診断フィールドは結合させない）
// 目的: 施術所の広告規制違反（＝業務停止の直接原因）を出稿前に止める。

// 業種プロファイル：enumerated=true は広告可能事項が法定列挙（接骨院/鍼灸）＝規制が厳しい
// fitness＝パーソナルジム/ピラティス（2026-07-12 楔差替）。限定列挙型ではないが
// 景表法・健康増進法（痩身の断定/保証・誇大表示）が直撃する圏＝痩身NG辞書で守る。
export const INDUSTRIES = {
  rikaku:  { label: '整体・リラク（無資格）', enumerated: false },
  judo:    { label: '接骨院・整骨院（柔整法）', enumerated: true },
  ahaki:   { label: '鍼灸・あん摩（あはき法）', enumerated: true },
  fitness: { label: 'パーソナルジム・ピラティス（景表法/健康増進法）', enumerated: false },
};

// カテゴリ別NG辞書。severity: high=公開ブロック / medium=要人承認（下書き止まり）
const RULES = [
  // 薬機法：効能効果・治癒の標榜
  { cat: '薬機法', sev: 'high',   terms: ['治る', 'なおる', '治療', '完治', '全快', '根治', '完治します', '痛みが取れる', '痛みが消える', '病気が', '再発しない', '即効', '根本改善', '即効性', '必ず良くなる'] },
  { cat: '薬機法', sev: 'medium', terms: ['効果', '効く', '改善します', '改善する', '解消', '効果的'] },
  // 景表法：優良誤認・断定・最上級
  { cat: '景表法', sev: 'high',   terms: ['No.1', 'NO.1', 'No1', 'ナンバーワン', 'ナンバー1', '日本一', '地域一番', '最高', '最強', '絶対', 'ぜったい', '必ず', 'かならず', '100%', '完全に治', '唯一', '他院より', '業界初', '特許取得'] },
  { cat: '景表法', sev: 'medium', terms: ['人気', 'おすすめ', '安心', '実績多数'] },
  // 英語・ローマ字での効能/最上級（正規化で大文字化して比較）。一般語衝突リスクのある heal/best は medium
  { cat: '薬機法', sev: 'high',   terms: ['CURE', 'GUARANTEED', 'GUARANTEE', 'MIRACLE', '100PERCENT'] },
  { cat: '薬機法', sev: 'medium', terms: ['HEAL', 'EFFECTIVE', 'PERMANENT'] },
  { cat: '景表法', sev: 'high',   terms: ['NUMBER ONE', 'NUMBERONE', 'THE BEST', 'PERFECT', 'ONLY ONE'] },
  { cat: '景表法', sev: 'medium', terms: ['BEST'] },
  // カタカナ開きでの回避（ゼッタイ/カナラズ/ナオル/カンチ）
  { cat: '薬機法', sev: 'high',   terms: ['ナオル', 'ナオリ', 'カンチ', 'コンチ', 'ソッコウ'] },
  { cat: '景表法', sev: 'high',   terms: ['ゼッタイ', 'カナラズ', 'サイキョウ', 'ニホンイチ'] },
  // 柔整/あはき 広告可能事項の逸脱（enumerated業種で high 格上げ）
  { cat: '柔整・あはき広告', sev: 'medium', terms: ['体験談', '口コミ', 'お客様の声', 'ビフォーアフター', 'before/after', '症例', '肩こりに効く', '腰痛に効く', '神経痛', 'ダイエット', '小顔', '骨盤矯正で', '五十肩', '坐骨神経痛', 'ぎっくり腰', '自律神経', 'ヘルニア', '産後の骨盤'] },
  // 景表法・健康増進法：痩身の断定/保証（パーソナルジム/ピラティス圏の直撃点）。
  // high=断定・保証・楽して痩身の示唆（優良誤認/誇大表示の芽）／medium=痩身・成果を想起させる語（要人承認）
  { cat: '景表法・健康増進法（痩身）', sev: 'high',   terms: ['必ず痩せ', 'かならず痩せ', '絶対痩せ', 'ゼッタイ痩せ', '確実に痩せ', '誰でも痩せ', 'だれでも痩せ', 'リバウンドしない', 'リバウンドゼロ', '部分痩せ', '楽して痩せ', 'ラクして痩せ', '飲むだけで痩せ', '着るだけで痩せ', '寝るだけで痩せ', '脂肪が溶け', '脂肪を溶か', 'セルライトが消え', '痩せる保証', '痩身保証', '痩せなければ返金', '痩せなかったら返金', 'kg減を保証', 'キロ減を保証', '医学的に証明'] },
  { cat: '景表法・健康増進法（痩身）', sev: 'medium', terms: ['痩せる', '痩せた', 'やせる', 'ヤセる', '痩身', 'ダイエット効果', 'ボディメイク効果', '体質改善', 'くびれ', '脚やせ', '全額返金', '返金保証', 'モニター価格', '入会金無料'] },
  // 矯正系＝無資格の医業類似行為の標榜リスク（見廻り学習ノート還流・「骨盤調整」等への言い換えを促す）
  { cat: '医業類似行為の標榜', sev: 'medium', terms: ['骨盤矯正', '猫背矯正', '小顔矯正', 'O脚矯正', '姿勢矯正'] },
  // 消契法9条（返金不可条項）・即決圧力＝有利誤認の芽（見廻りサイクル3還流）
  { cat: '消契法・契約条項', sev: 'medium', terms: ['返金不可', 'いかなる場合も返金', 'キャンセル不可', '解約不可'] },
  { cat: '即決圧力', sev: 'medium', terms: ['本日限り', '当日入会で', '今日入会で', '今すぐ入会で'] },
];

// ステマ告示（口コミ買収型）：口コミ/レビュー依頼 × 見返り特典 の共起＝high（2025-03措置命令の執行型）。
// 特典なし・任意のレビュー依頼は合法＝口コミ語の単独は既存カテゴリのmedium止まり。
const REVIEW_TERMS = ['口コミ', 'クチコミ', 'レビュー', '★5', '星5'];
const INCENTIVE_TERMS = ['特典', 'プレゼント', '割引', 'クーポン', 'キャッシュバック', '謝礼', '無料に'];
/** 口コミ依頼×見返り特典の共起を検出（ステマ告示・口コミ買収型） */
export function detectReviewIncentive(text = '') {
  const norm = normalizeForCheck(text);
  const reviews = REVIEW_TERMS.filter(t => norm.includes(normalizeForCheck(t)));
  if (reviews.length === 0) return { detected: false, reviews: [], incentives: [] };
  const incentives = INCENTIVE_TERMS.filter(t => norm.includes(normalizeForCheck(t)));
  return { detected: incentives.length > 0, reviews, incentives };
}

/**
 * 検査用の正規化。全角/半角・大小文字・文字間スペースでの回避を潰す。
 * NFKC で全角英数記号を半角化（Ｎｏ．１→No.1、１００％→100%）、
 * 全空白を除去（絶　対→絶対、ぜっ たい→ぜったい）、英字は大文字化して比較する。
 */
export function normalizeForCheck(text = '') {
  return String(text).normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

/**
 * コピーを検査。industry で厳格度を変える。
 * @returns {{ok:boolean, blocked:boolean, industry:string, violations:Array}}
 */
export function checkCopy(text = '', industry = 'rikaku') {
  const prof = INDUSTRIES[industry] || INDUSTRIES.rikaku;
  const norm = normalizeForCheck(text);
  const violations = [];
  for (const rule of RULES) {
    for (const term of rule.terms) {
      if (norm.includes(normalizeForCheck(term))) {
        // enumerated業種では「柔整・あはき広告」逸脱を high に格上げ
        let sev = rule.sev;
        if (rule.cat === '柔整・あはき広告' && prof.enumerated) sev = 'high';
        violations.push({ term, category: rule.cat, severity: sev,
          reason: sev === 'high' ? '公開不可（違反リスク＝業務停止/罰金の芽）' : '要人承認（下書き止まり）' });
      }
    }
  }
  // ステマ告示（口コミ買収型）：口コミ依頼×見返り特典の共起は業種を問わずhigh＝公開ブロック
  const ri = detectReviewIncentive(text);
  if (ri.detected) {
    violations.push({ term: `${ri.reviews.join('/')}×${ri.incentives.join('/')}`, category: 'ステマ告示（口コミ買収）', severity: 'high',
      reason: '公開不可（口コミ依頼×見返り特典の共起＝ステマ告示の執行型・2025-03措置命令と同型）' });
  }
  // 要配慮の推知：症状名×効能想起語の共起（enumerated業種はhigh＝適応症標榜リスク）
  const inf = detectSensitiveInference(text);
  if (inf.inferred) {
    const sev = prof.enumerated ? 'high' : 'medium';
    violations.push({ term: `${inf.health.join('/')}×${inf.cues.join('/')}`, category: '要配慮の推知（適応症標榜）', severity: sev,
      reason: sev === 'high' ? '公開不可（症状×効能の共起＝適応症標榜の芽）' : '要人承認（症状×効能の共起・推知に配慮）' });
  }
  const blocked = violations.some(v => v.severity === 'high');
  return { ok: violations.length === 0, blocked, industry, industryLabel: prof.label, inference: inf, violations };
}

/**
 * 外部送信規律（改正電気通信事業法）の通知文を生成。
 * 「何を・どこへ・何のため」を明示する。事実の開示のみで、効果・優良性の主張はしない。
 * privacyPolicyUrl は店舗が自ら設定する欄（未設定なら null＝空欄のまま出さない）。
 * @returns {{legal_basis, items, destination, purposes, sensitive_excluded, opt_in_required_for_merge, privacy_policy_url}}
 */
export function buildDisclosure({ serviceName = 'Loku Tuning 計測', privacyPolicyUrl = null } = {}) {
  return {
    legal_basis: '改正電気通信事業法 外部送信規律',
    service_name: serviceName,
    items: [
      'ページの閲覧・到達',
      'ボックスごとの表示・滞在時間・再訪',
      '流入時の検索クエリ（健康・症状語は"推知"として配慮）',
      '端末種別（PC/スマホ等）',
      '匿名の識別子（Cookie/ローカル保存の匿名ID）',
    ],
    destination: { name: 'Loku（本サービス運営者）', is_third_party: false, note: '1st-party。広告等の第三者提供は行わない' },
    purposes: [
      '来訪の分析とページ導線の改善',
      '（お客様の同意がある場合のみ）LINE友だちと結合したご案内',
    ],
    sensitive_excluded: true, // 症状・診断など要配慮個人情報は送信・結合しない（stripSensitive）
    opt_in_required_for_merge: true, // 実名結合には明示同意が必要
    privacy_policy_url: privacyPolicyUrl, // 店舗が設定（未設定は空欄・当方で代筆しない）
  };
}

// 委託先（サブプロセッサ）レジストリの初期値。事実として「使う機能」は挙げるが、
// リージョン(保管国)は運用者が入れる欄＝当方で断定しない（誤った越境判定を避ける）。
export function defaultSubprocessors() {
  return [
    { id: 'supabase', name: 'Supabase', purpose: 'データベース/認証（計測データの保管）', region: null },
    { id: 'google_sc', name: 'Google Search Console API', purpose: '検索流入データの取得（readonly）', region: null },
    { id: 'line', name: 'LINE（Messaging API）', purpose: '友だちへの配信', region: null },
  ];
}

// 越境判定：region未設定=判定不可(要確認)、JP=国内、それ以外=越境(28条の情報提供が必要)。
export function classifyTransfer(region) {
  if (region == null || region === '') return 'unknown';
  return String(region).toUpperCase() === 'JP' ? 'domestic' : 'cross_border';
}

/**
 * 委託先リストに越境判定を付与し、28条対応で通知が要る先を洗い出す。
 * @returns {{subprocessors:Array, cross_border:Array, unknown:Array, needs_notice:boolean}}
 */
export function transferAssessment(subprocessors = defaultSubprocessors()) {
  const withClass = subprocessors.map(s => ({ ...s, transfer: classifyTransfer(s.region) }));
  const cross_border = withClass.filter(s => s.transfer === 'cross_border');
  const unknown = withClass.filter(s => s.transfer === 'unknown');
  return { subprocessors: withClass, cross_border, unknown, needs_notice: cross_border.length > 0 || unknown.length > 0 };
}

// 漏えい等の「個人情報保護委員会への報告・本人通知」要否判定（APPI26条＋施行規則7条）。
// 報告対象＝①要配慮個人情報が含まれる ②財産的被害のおそれ(不正目的) ③1,000人超 のいずれか、
// または不正アクセス等（故意）。1件でも要配慮を含めば対象になる点に注意。
export function assessBreach({ affected = 0, includes_sensitive = false, unauthorized_access = false, risk_of_property_harm = false } = {}) {
  const n = Number(affected) || 0;
  const reasons = [];
  if (includes_sensitive) reasons.push('要配慮個人情報を含む');
  if (risk_of_property_harm) reasons.push('財産的被害のおそれ（不正利用目的）');
  if (unauthorized_access) reasons.push('不正アクセス等（故意による漏えい）');
  if (n > 1000) reasons.push('1,000人を超える');
  const must_report = reasons.length > 0;
  return {
    affected: n,
    must_report,                 // 個人情報保護委員会への報告義務
    must_notify_subjects: must_report, // 本人通知義務（原則）
    reasons,
    deadlines: must_report ? { prompt_report: '速報：概ね3〜5日以内', full_report: '確報：30日以内（不正アクセス等は60日以内）' } : null,
  };
}

// ② 要配慮個人情報ガード：結合してはいけない健康・症状系フィールドを検出して除去
const SENSITIVE_KEYS = ['symptom', 'symptoms', 'diagnosis', 'disease', 'condition', 'health', 'medical', 'injury', '症状', '病名', '既往歴'];

// 検索クエリ等に含まれる健康・症状の語（要配慮個人情報の"推知"に配慮するため検出）
const HEALTH_TERMS = ['肩こり', '腰痛', '頭痛', '神経痛', 'ヘルニア', '五十肩', '坐骨神経痛', 'ぎっくり腰', '産後', '骨盤', '冷え', 'むくみ', '自律神経', '不眠', 'めまい', '猫背',
  // フィットネス圏（姿勢・体型の悩み語。楔差替 2026-07-12）
  '反り腰', '巻き肩', 'O脚', 'X脚', 'ぽっこりお腹', '体脂肪'];
/** テキストに含まれる健康・症状語を返す（空なら健康関連なし） */
export function detectHealthTerms(text = '') {
  const norm = normalizeForCheck(text);
  return HEALTH_TERMS.filter(t => norm.includes(normalizeForCheck(t)));
}

// 効能・改善を想起させる"やわらかい"語。単体では罰則語ではないが、
// 症状名と共起すると「適応症の標榜」に近づく（enumerated業種で特に問題）。
const BENEFIT_CUES = ['軽く', 'スッキリ', 'すっきり', '楽に', 'ラクに', '和ら'
  , '緩和', 'アプローチ', 'ケア', 'ほぐす', 'ほぐし', '改善', '解消', '整え', 'すっと'
  , '引き締', 'シェイプ']; // フィットネス圏の成果想起語（楔差替 2026-07-12）
/** 健康語×効能想起語の共起を検出（要配慮の"推知"）。共起があれば cues を返す */
export function detectSensitiveInference(text = '') {
  const norm = normalizeForCheck(text);
  const health = detectHealthTerms(text);
  if (health.length === 0) return { inferred: false, health: [], cues: [] };
  const cues = BENEFIT_CUES.filter(c => norm.includes(normalizeForCheck(c)));
  return { inferred: cues.length > 0, health, cues };
}

const SENSITIVE_KEYS_LC = SENSITIVE_KEYS.map(k => k.toLowerCase());
const isSensitiveKey = (k) => SENSITIVE_KEYS_LC.includes(String(k).toLowerCase());

/**
 * collect ペイロードから要配慮フィールドを剥がす。
 * 大文字小文字を無視し、ネストしたオブジェクト/配列も再帰的に走査する
 * （症状・診断が入れ子や表記ゆれで結合されるのを防ぐ）。剥がしたキーパスを返す。
 */
export function stripSensitive(payload = {}) {
  const stripped = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === 'object') {
      const out = {};
      for (const k of Object.keys(node)) {
        const p = path ? `${path}.${k}` : k;
        if (isSensitiveKey(k)) { stripped.push(p); continue; }
        out[k] = walk(node[k], p);
      }
      return out;
    }
    return node;
  };
  const clean = walk(payload, '');
  return { clean, stripped };
}
