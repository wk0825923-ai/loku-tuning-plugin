// コンプライアンス機構（法務監査 legal-audit.html の対策を実装）
// ① 業種別NGワードチェッカー（薬機法・景表法・柔整/あはき広告規制）
// ② 要配慮個人情報のガード（症状/診断フィールドは結合させない）
// 目的: 施術所の広告規制違反（＝業務停止の直接原因）を出稿前に止める。

// 業種プロファイル：enumerated=true は広告可能事項が法定列挙（接骨院/鍼灸）＝規制が厳しい
export const INDUSTRIES = {
  rikaku: { label: '整体・リラク（無資格）', enumerated: false },
  judo:   { label: '接骨院・整骨院（柔整法）', enumerated: true },
  ahaki:  { label: '鍼灸・あん摩（あはき法）', enumerated: true },
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
];

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
const HEALTH_TERMS = ['肩こり', '腰痛', '頭痛', '神経痛', 'ヘルニア', '五十肩', '坐骨神経痛', 'ぎっくり腰', '産後', '骨盤', '冷え', 'むくみ', '自律神経', '不眠', 'めまい', '猫背'];
/** テキストに含まれる健康・症状語を返す（空なら健康関連なし） */
export function detectHealthTerms(text = '') {
  const norm = normalizeForCheck(text);
  return HEALTH_TERMS.filter(t => norm.includes(normalizeForCheck(t)));
}

// 効能・改善を想起させる"やわらかい"語。単体では罰則語ではないが、
// 症状名と共起すると「適応症の標榜」に近づく（enumerated業種で特に問題）。
const BENEFIT_CUES = ['軽く', 'スッキリ', 'すっきり', '楽に', 'ラクに', '和ら'
  , '緩和', 'アプローチ', 'ケア', 'ほぐす', 'ほぐし', '改善', '解消', '整え', 'すっと'];
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
