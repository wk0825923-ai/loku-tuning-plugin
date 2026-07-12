// ③ 因果エンジン（roadmap P0–P2）
// 「誰が・どこで折れたか（数値化）」→「なぜ折れたか（因果）」→「次の一手（提案）」を
// ルールベース（LLM不要・決定的）で導く。L2（業種知識）はプリセットとして注入する。
//
// 思想の遵守：
//  - 主張（効果/保証）は作らない。因果は"事実の説明"、打ち手は"構成の提案"と"事実ベースの一言"のみ。
//  - 送信はしない。ここは「因果＋セグメント＋下書き」を作るだけ。撃つのは Loku 本体（app側で連携）。
//  - outreach（離脱者への一言）は app 側で必ず checkCopy を通す（安全弁）。
//
// L1/L2の分離（実装思想「構造で作ってお任せ」）：
//  - L1＝BOX_ORDER・deriveExit・classify・因果コード：業種非依存で不変。
//  - L2＝PRESETS（ボックス辞書/説明文/導線案/一言）：業種ごとの設定データ。コードは業種ごとに書かない。
//  - 楔（2026-07-12差替）＝pilates（パーソナルジム/ピラティス・景表法/健康増進法圏）。
//    judo（接骨院）は温存＝エンジン既定・回帰基準として残す（既存QAの完全一致を保証）。

// LPの標準ボックス構造（seedStore と 1:1）。順序＝スクロール深度。キーは全プリセット共通（L1）。
export const BOX_ORDER = ['hero', 'problem', 'beforeafter', 'staff', 'pricing', 'voice', 'faq', 'cta'];

const HIGH = 60; // 「熟読/注視した」とみなす注視度（既存 heat 閾値と揃える）
const LOW  = 30; // 「ほぼ見ていない」とみなす上限
const ordOf = (k) => BOX_ORDER.indexOf(k);
const eng = (be, k) => Number(be?.[k]) || 0;

/**
 * P0：離脱点の導出。box_engagement（見た深さ）だけで決める＝"行動"であって"成果(予約)"とは独立。
 * 予約は後段の outcome（cause-outcomes / diagnose.booked）で別軸に測る。業種非依存（L1）。
 * @returns {{exit_box:string|null, exit_type:'form_abandon'|'bounce'|'dropoff'|'no_data', reached_depth:number}}
 */
export function deriveExit(boxEngagement = {}) {
  const engaged = BOX_ORDER.filter(k => eng(boxEngagement, k) > 0);
  if (engaged.length === 0) return { exit_box: null, exit_type: 'no_data', reached_depth: -1 };
  const reached_depth = Math.max(...engaged.map(ordOf));
  const exit_box = BOX_ORDER[reached_depth];
  let exit_type;
  if (exit_box === 'cta') exit_type = 'form_abandon'; // 予約導線まで来た（予約有無は別軸）
  else if (reached_depth <= 0) exit_type = 'bounce';  // FVだけで離脱
  else exit_type = 'dropoff';                         // 途中離脱
  return { exit_box, exit_type, reached_depth };
}

// 因果カタログ（L1）。上から順に最初に当たった規則を採用（決定的）。
// test は "code" と confidence を検証するので、規則の順序＝優先度が仕様。業種非依存。
function classify(be, exit) {
  const { exit_box, exit_type, reached_depth } = exit;
  if (exit_type === 'no_data') return { code: 'no_data', confidence: 'low' };
  if (exit_type === 'form_abandon') return { code: 'cta_friction', confidence: 'high' };

  // FAQを熟読して離脱＝不安が解消されなかった（faqまで到達＆faq注視が高い）
  if (reached_depth >= ordOf('faq') && eng(be, 'faq') >= HIGH) return { code: 'unresolved_doubt', confidence: 'high' };

  // 料金で離脱：価値提示（実績/口コミ）を見る前なら "順序" の問題として格上げ
  if (exit_box === 'pricing') {
    if (eng(be, 'beforeafter') < LOW && eng(be, 'voice') < LOW) return { code: 'value_before_price', confidence: 'high' };
    return { code: 'price_anxiety', confidence: 'medium' };
  }

  // 料金到達より手前（悩み/実績/人物紹介）で離脱＝信頼形成の途中で離脱
  if (['problem', 'beforeafter', 'staff'].includes(exit_box)) return { code: 'proof_gap', confidence: 'medium' };

  // FVで離脱＝つかみ切れず（信頼未形成）
  if (exit_type === 'bounce' || exit_box === 'hero') return { code: 'weak_hook', confidence: 'medium' };

  return { code: 'unclassified', confidence: 'low' };
}

// 因果コード → 店主向けの短い日本語ラベル（L1・業種非依存の言い回し）
export const CAUSE_LABEL = {
  cta_friction:       '予約導線で離脱（あと一歩）',
  unresolved_doubt:   'FAQ熟読後に離脱（不安が未解消）',
  value_before_price: '価値提示の前に料金へ到達',
  price_anxiety:      '料金への納得感が不足',
  proof_gap:          '信頼形成の途中で離脱（料金到達前）',
  weak_hook:          'FVでつかめず直帰（信頼未形成）',
  unclassified:       '分類不能',
  no_data:            'データ不足（計測なし）',
};

// ============================================================
// L2 プリセット（業種知識＝設定データ）。エンジンのコードは触らずここだけ差し替える。
// ============================================================

// ---- 接骨院/整骨院プリセット（旧楔・回帰基準として温存） ----
const JUDO_PRESET = {
  key: 'judo',
  label: '接骨院・整骨院',
  industry: 'judo', // checkCopy の既定業種（柔整法＝限定列挙で最も厳しい）
  wedge: false,     // 2026-07-12 楔差替：広告経由LPが2025広告GLで規制対象化＋LP文化薄 → 一次営業先から外す
  box_dictionary: {
    hero:        { label: 'ファーストビュー', role: 'つかみ・第一印象' },
    problem:     { label: '悩み共感',        role: '課題の自分ごと化' },
    beforeafter: { label: '施術例・変化',     role: '実績による信頼形成' },
    staff:       { label: '院長・スタッフ',   role: '人柄・専門性の信頼' },
    pricing:     { label: '料金',            role: '価格の提示' },
    voice:       { label: 'お客様の声',       role: '第三者評価' },
    faq:         { label: 'よくある質問',     role: '不安・疑問の解消' },
    cta:         { label: '予約導線',         role: '行動（予約）' },
  },
  // 因果コード → 店主向けの説明文（"なぜ"の言語化）。事実の説明のみ・効果の主張はしない。
  cause_explain: {
    cta_friction:       '予約導線まで到達しましたが予約に至っていません。フォームや導線の摩擦が最後の一歩を止めている可能性があります。',
    unresolved_doubt:   'よくある質問を長く読んだ後に離脱しています。疑問や不安がページ内で解消し切れなかった可能性があります。',
    value_before_price: '実績やお客様の声をほとんど見ないまま料金に到達し、そこで離脱しています。価値が伝わる前に価格を見た可能性があります。',
    price_anxiety:      '料金セクションで離脱しています。価格に対する納得感が不足している可能性があります。',
    proof_gap:          '料金に到達する前、信頼を形成する区間で離脱しています。実績や院の信頼が伝わり切る前に離れた可能性があります。',
    weak_hook:          'ファーストビュー付近で離脱しています。最初のつかみで関心・信頼を持てなかった可能性があります。',
    unclassified:       '明確な離脱パターンに当てはまりませんでした。追加の計測が必要です。',
    no_data:            '計測データがありません。',
  },
  // 因果コード → 導線チューニング案（"どう並べるか"であって"何を言うか"ではない）
  cause_funnel: {
    cta_friction:       ['予約フォームの項目数を減らす', 'CTAの直前に「予約後の流れ」を1行で添える'],
    unresolved_doubt:   ['FAQで多く読まれた項目をCTA直前に繰り上げる', '未解消になりやすい疑問を上位に並べ替える'],
    value_before_price: ['料金の前に施術例（beforeafter）とお客様の声（voice）を配置し、価値提示を先行させる'],
    price_anxiety:      ['料金に「初回の流れ」を併記して心理的ハードルを下げる', '料金の近くに施術例を再配置する'],
    proof_gap:          ['実績（beforeafter）と院長紹介（staff）を早い位置に繰り上げる'],
    weak_hook:          ['ファーストビューの情報量を絞り、次のセクションへの誘導を明確にする'],
    unclassified:       [],
    no_data:            [],
  },
  // 因果コード → 離脱者への一言（下書き）。事実ベース・効果や主張はしない。
  // ※ app 側で checkCopy(judo) を必ず通す。接骨院で通る中立文のみを用意する。
  cause_outreach: {
    cta_friction:       'ご予約ページまでお進みいただきありがとうございました。ご予約の操作でご不明な点があれば、このままご返信ください。',
    unresolved_doubt:   'よくあるご質問をご覧いただきありがとうございました。ほかに気になる点があれば、お気軽にご返信ください。',
    value_before_price: 'ページをご覧いただきありがとうございました。料金や初回のご案内について、ご質問があればご返信ください。',
    price_anxiety:      '先日はページをご覧いただきありがとうございました。料金や初回の流れについて、ご不明点があればこのままご返信ください。',
    proof_gap:          'ご覧いただきありがとうございました。院やスタッフのこと、通い方など、気になる点があればご返信ください。',
    weak_hook:          'ご訪問ありがとうございました。もしご都合が合えば、空き状況だけでもご案内します。',
    unclassified:       '',
    no_data:            '',
  },
};

// ---- パーソナルジム/ピラティス プリセット（新楔・2026-07-12差替） ----
// 「広告→LP→LINE」が業界定石ど真ん中＝決断面がLPにある業種。規制は景表法/健康増進法
// （痩身断定・ビフォーアフター保証等）＝限定列挙型ではなく「事実だけ・主張を触らない」防波堤がそのまま効く。
const PILATES_PRESET = {
  key: 'pilates',
  label: 'パーソナルジム・ピラティス',
  industry: 'fitness', // checkCopy の既定業種（景表法/健康増進法）
  wedge: true,         // 現行の楔（一次営業先）。最初の1店舗候補=demo-pilates-lp（YUKIさん）
  box_dictionary: {
    hero:        { label: 'ファーストビュー',       role: 'つかみ・第一印象' },
    problem:     { label: '悩み共感（姿勢・体型）',  role: '課題の自分ごと化' },
    beforeafter: { label: '変化事例・レッスン風景',  role: '実績による信頼形成' },
    staff:       { label: 'インストラクター紹介',    role: '人柄・専門性の信頼' },
    pricing:     { label: '料金プラン',             role: '価格の提示' },
    voice:       { label: 'お客様の声',             role: '第三者評価' },
    faq:         { label: 'よくある質問',           role: '不安・疑問の解消' },
    cta:         { label: '体験予約導線',           role: '行動（体験予約）' },
  },
  cause_explain: {
    cta_friction:       '体験予約の導線まで到達しましたが予約に至っていません。フォームや導線の摩擦が最後の一歩を止めている可能性があります。',
    unresolved_doubt:   'よくある質問を長く読んだ後に離脱しています。疑問や不安がページ内で解消し切れなかった可能性があります。',
    value_before_price: '変化事例やお客様の声をほとんど見ないまま料金プランに到達し、そこで離脱しています。価値が伝わる前に価格を見た可能性があります。',
    price_anxiety:      '料金プランのセクションで離脱しています。価格に対する納得感が不足している可能性があります。',
    proof_gap:          '料金に到達する前、信頼を形成する区間で離脱しています。スタジオやインストラクターの信頼が伝わり切る前に離れた可能性があります。',
    weak_hook:          'ファーストビュー付近で離脱しています。最初のつかみで関心・信頼を持てなかった可能性があります。',
    unclassified:       '明確な離脱パターンに当てはまりませんでした。追加の計測が必要です。',
    no_data:            '計測データがありません。',
  },
  cause_funnel: {
    cta_friction:       ['体験予約フォームの項目数を減らす', 'CTAの直前に「体験当日の流れ」を1行で添える'],
    unresolved_doubt:   ['FAQで多く読まれた項目をCTA直前に繰り上げる', '未解消になりやすい疑問（持ち物・服装・勧誘の有無など）を上位に並べ替える'],
    value_before_price: ['料金プランの前に変化事例（beforeafter）とお客様の声（voice）を配置し、価値提示を先行させる'],
    price_anxiety:      ['料金プランに「体験当日の流れ」を併記して心理的ハードルを下げる', '料金の近くにレッスン風景を再配置する'],
    proof_gap:          ['レッスン風景（beforeafter）とインストラクター紹介（staff）を早い位置に繰り上げる'],
    weak_hook:          ['ファーストビューの情報量を絞り、次のセクションへの誘導を明確にする'],
    unclassified:       [],
    no_data:            [],
  },
  // 事実ベースの中立文のみ。「痩せる」「引き締まる」等の効果・成果の示唆は一切入れない
  // （景表法/健康増進法圏＝checkCopy(fitness) を必ず通過する文だけを置く）。
  cause_outreach: {
    cta_friction:       '体験レッスンのご予約ページまでお進みいただきありがとうございました。ご予約の操作でご不明な点があれば、このままご返信ください。',
    unresolved_doubt:   'よくあるご質問をご覧いただきありがとうございました。ほかに気になる点があれば、お気軽にご返信ください。',
    value_before_price: 'ページをご覧いただきありがとうございました。料金プランや体験レッスンのご案内について、ご質問があればご返信ください。',
    price_anxiety:      '先日はページをご覧いただきありがとうございました。料金プランや体験当日の流れについて、ご不明点があればこのままご返信ください。',
    proof_gap:          'ご覧いただきありがとうございました。スタジオやインストラクターのこと、通い方など、気になる点があればご返信ください。',
    weak_hook:          'ご訪問ありがとうございました。もしご都合が合えば、体験レッスンの空き状況だけでもご案内します。',
    unclassified:       '',
    no_data:            '',
  },
};

// プリセット台帳。楔の差替＝ここに足す/wedgeを付け替えるだけ（エンジンは不変）。
export const PRESETS = {
  judo: JUDO_PRESET,
  pilates: PILATES_PRESET,
};

// エンジン既定は judo（後方互換・既存QAの回帰基準）。未知キーも judo にフォールバック（決定的）。
export const DEFAULT_PRESET = 'judo';
export function getPreset(key) {
  return PRESETS[key] || PRESETS[DEFAULT_PRESET];
}

// ---- 後方互換エクスポート（既存の呼び出し・移植仕様 ARCHITECTURE.md D章 と互換） ----
export const BOX_DICTIONARY = JUDO_PRESET.box_dictionary;

/**
 * P1：因果推定。journey 相当の1行から「なぜ折れたか」を返す。
 * @param row {{ box_engagement:object }}  ※因果は行動ベース＝予約(booked)には依存しない
 * @param presetKey L2プリセット（既定 judo）。因果コードはプリセット非依存＝L1で決まる。
 * @returns {{code,label,confidence,evidence,explanation}}
 */
export function inferCause(row = {}, presetKey = DEFAULT_PRESET) {
  const preset = getPreset(presetKey);
  const be = row.box_engagement || {};
  const exit = deriveExit(be);
  const c = classify(be, exit);
  return {
    code: c.code,
    label: CAUSE_LABEL[c.code],
    confidence: c.confidence,
    exit_box: exit.exit_box,
    exit_type: exit.exit_type,
    reached_depth: exit.reached_depth,
    evidence: {
      exit_box: exit.exit_box,
      reached: exit.exit_box ? preset.box_dictionary[exit.exit_box]?.label : null,
      beforeafter: eng(be, 'beforeafter'),
      voice: eng(be, 'voice'),
      pricing: eng(be, 'pricing'),
      faq: eng(be, 'faq'),
    },
    explanation: preset.cause_explain[c.code],
  };
}

/**
 * P2：次アクションの提案（導線チューニング案＋離脱者への一言の下書き）。
 * outreach.message は app 側で checkCopy を通す前提の"下書き"。
 * @returns {{ funnel:string[], outreach:{ has_message:boolean, message:string } }}
 */
export function suggestActions(code, presetKey = DEFAULT_PRESET) {
  const preset = getPreset(presetKey);
  return {
    funnel: preset.cause_funnel[code] || [],
    outreach: { has_message: !!preset.cause_outreach[code], message: preset.cause_outreach[code] || '' },
  };
}

// 全因果コード（テスト・網羅性チェック用）
export const CAUSE_CODES = Object.keys(CAUSE_LABEL);
