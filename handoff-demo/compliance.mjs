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

/** collect ペイロードから要配慮フィールドを剥がす。剥がしたキー名を返す（記録・監査用） */
export function stripSensitive(payload = {}) {
  const stripped = [];
  const clean = { ...payload };
  for (const k of Object.keys(clean)) {
    if (SENSITIVE_KEYS.includes(k)) { delete clean[k]; stripped.push(k); }
  }
  return { clean, stripped };
}
