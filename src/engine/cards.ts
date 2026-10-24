// カード定義（test ブランチ：レベル版）．
// 各カードは「レベル」「取得コスト」「排除コスト」を持つ．
//   取得：レベルが0以上の行を行き先に選び，そのレベル以下のカードを，列の値（支払える額）の範囲で取得コストを払って買う
//   排除：レベルが−の行を行き先に選び，その絶対値以下のレベルの場のカードを，列の値の範囲で排除コストを払って消す
// 排除コストは多くが1（粗大ごみとレベル3は2）．取得コストと同じにすると，高いカードを捨てるのに1手番で
// 長い並びが要り，ほぼ捨てられなくなる（シミュレーションで確認．testブランチの改善要求.md）

export type CardKind =
  | 'R' | 'D' | 'U' | 'J'                                // 初期カード（→，↓，↑，粗大ごみ）
  | 'RD' | 'RU' | 'P' | 'BAG'                            // レベル1
  | 'R+' | 'D+' | 'U+' | 'UD'                            // レベル2
  | 'RD2' | 'RU2' | 'RUD' | 'ALL';                       // レベル3

export interface CardDef {
  kind: CardKind;
  name: string;
  /** 置けるマスへの移動（行, 列）．→ [0,1]，↓ [1,0]，↑ [-1,0] */
  moves: [number, number][];
  /** ＋ の数（置いたときに引く枚数） */
  draw: number;
  /** 手番の終わりに，コストを払わずに自分を排除する */
  selfRemove: boolean;
  /** 粗大ごみ（矢印がなく，レベルとコストが高い．見た目のため） */
  bulky: boolean;
  /** レベル（0〜3）．取得にも排除にも，行き先の行のレベル（の絶対値）がこれ以上必要 */
  level: number;
  /** 取得コスト */
  cost: number;
  /** 排除コスト */
  removeCost: number;
}

export const MOVES: Record<string, [number, number]> = { '→': [0, 1], '↓': [1, 0], '↑': [-1, 0] };

const def = (kind: CardKind, name: string, arrows: string, o: Partial<CardDef> & { level: number; cost: number }): CardDef => ({
  kind, name,
  moves: [...arrows].filter(a => a in MOVES).map(a => MOVES[a]),
  draw: 0, selfRemove: false, bulky: false, removeCost: o.level >= 3 ? 2 : 1, ...o,
});

export const CARDS: Record<CardKind, CardDef> = {
  // 基本カードはレベル0：レベル0の行（スタートの行）でも取得でき，−の行ならどこでも排除できる
  'R':   def('R',   '→',          '→',   { level: 0, cost: 1 }),
  'D':   def('D',   '↓',          '↓',   { level: 0, cost: 1 }),
  'U':   def('U',   '↑',          '↑',   { level: 0, cost: 1 }),
  'J':   def('J',   '粗大ごみ',    '',    { level: 2, cost: 2, removeCost: 2, bulky: true }),
  // レベル1
  'RD':  def('RD',  '仕分け箱',    '→↓',  { level: 1, cost: 2 }),
  'RU':  def('RU',  '棚',          '→↑',  { level: 1, cost: 2 }),
  'P':   def('P',   'リスト',      '',    { level: 1, cost: 1, draw: 2 }),
  'BAG': def('BAG', '紙袋',        '→',   { level: 1, cost: 1, draw: 1, selfRemove: true }),
  // レベル2
  'R+':  def('R+',  '台車',        '→',   { level: 2, cost: 2, draw: 1 }),
  'D+':  def('D+',  '通路',        '↓',   { level: 2, cost: 2, draw: 1 }),
  'U+':  def('U+',  '脚立',        '↑',   { level: 2, cost: 2, draw: 1 }),
  'UD':  def('UD',  'エレベーター', '↑↓',  { level: 2, cost: 3 }),
  // レベル3（取得しづらく，捨てるのも大変）
  'RD2': def('RD2', 'ハブ',        '→↓',  { level: 3, cost: 4, draw: 2 }),
  'RU2': def('RU2', 'ショーケース', '→↑',  { level: 3, cost: 4, draw: 2 }),
  'RUD': def('RUD', '交差点',      '→↑↓', { level: 3, cost: 3 }),
  'ALL': def('ALL', '司令塔',      '→↑↓', { level: 3, cost: 7, draw: 2 }),
};

/** 矢印のない（行き止まりになる）カードか */
export const isDeadEnd = (k: CardKind) => CARDS[k].moves.length === 0;
/** 2方向以上に伸ばせるカードか */
export const isBranch = (k: CardKind) => CARDS[k].moves.length >= 2;
export const hasUp = (k: CardKind) => CARDS[k].moves.some(m => m[0] < 0);
export const hasDown = (k: CardKind) => CARDS[k].moves.some(m => m[0] > 0);

export type Deck = { kind: CardKind; count: number }[];

/** 市場で売り切れない基本カード（行き詰まり防止） */
export const UNLIMITED_KINDS: CardKind[] = ['R', 'D', 'U'];

/** 開始時に市場へ並べられる候補（基本カードは別に必ず並ぶ） */
export const MARKET_CANDIDATES: CardKind[] = ['RD', 'RU', 'P', 'BAG', 'R+', 'D+', 'U+', 'UD', 'RD2', 'RU2', 'RUD', 'ALL'];
/** 候補から選ぶ種類数 */
export const MARKET_PICK = 8;
/** 標準の市場（候補から MARKET_PICK 種類） */
export const STANDARD_PICK: CardKind[] = ['RD', 'RU', 'BAG', 'R+', 'D+', 'UD', 'RD2', 'ALL'];
/** 標準に入っていない候補 */
export const PROTOTYPE_KINDS: CardKind[] = MARKET_CANDIDATES.filter(k => !STANDARD_PICK.includes(k));

/** 市場に並ぶカード（標準） */
export const MARKET_KINDS: CardKind[] = [...UNLIMITED_KINDS, ...STANDARD_PICK];

/** 開始時に選んだ市場の候補を確かめ，基本カードを加えた市場を返す．不正なら理由を投げる */
export function marketFromPick(pick: string[]): CardKind[] {
  const kinds = [...new Set(pick)];
  if (kinds.some(k => !(MARKET_CANDIDATES as string[]).includes(k))) throw new Error('市場の候補にないカードがあります');
  if (kinds.length !== MARKET_PICK) throw new Error(`市場のカードは${MARKET_PICK}種類選んでください（今 ${kinds.length}種類）`);
  return [...UNLIMITED_KINDS, ...MARKET_CANDIDATES.filter(k => kinds.includes(k))];
}
export const UNLIMITED = 99;

/** 初期デッキ */
export const STARTING_DECK: Deck = [
  { kind: 'U', count: 1 }, { kind: 'R', count: 3 }, { kind: 'D', count: 1 }, { kind: 'J', count: 1 },
];

export const HAND_SIZE = 3;
/** 手元に置いておける枚数（次の手番以降に使える） */
export const RESERVE_SIZE = 1;
export const MAX_ROUNDS = 60;
