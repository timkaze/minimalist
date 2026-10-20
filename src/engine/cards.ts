// カード定義．コストはカードに印刷する値（アイコン数からは計算しない）

export type CardKind =
  | 'R' | 'D' | 'J' | 'X'                    // 初期カード（→，↓，粗大ごみ，ゴミ袋）
  | 'R+' | 'D+' | 'RD' | 'P' | 'RD2'         // 市場：コスト1〜3
  | 'BAG'                                    // 市場：紙袋（使い捨て）
  | 'TRK' | 'ST' | 'LD' | 'LR' | 'CUT' | 'PT' | 'SELL'; // 試作・不採用のカード（training/card-lab.ts で試せる）

export interface CardDef {
  kind: CardKind;
  name: string;
  right: boolean;
  down: boolean;
  /** 置けるマスへの移動（行, 列）．→ [0,1]，↓ [1,0]，↘ [1,1]，⇒ [0,2]，⇓ [2,0] */
  moves: [number, number][];
  /** 矢印の先が段ボールでも置ける */
  cutter: boolean;
  /** 手番の終わりに，捨欲を使わずに自分を排除する */
  selfRemove: boolean;
  /** 排除したとき，排除した枚数に追加で数える枚数（段ボールが早く開く） */
  bonus: number;
  /** 排除したとき，この手番の物欲に足す値 */
  sell: number;
  /** ✕ の数（捨欲 +1 ずつ） */
  x: number;
  /** ＋ の数（置いたときに引く枚数） */
  draw: number;
  /** ∞ 置くと捨欲が無制限（持ち運べるゴミ捨て場） */
  goal: boolean;
  /** 粗大ごみ（扱いは RULE.bulky で決まる） */
  bulky: boolean;
  cost: number;
}

const MOVES: Record<string, [number, number]> = { '→': [0, 1], '↓': [1, 0], '↘': [1, 1], '⇒': [0, 2], '⇓': [2, 0] };

const def = (kind: CardKind, name: string, arrows: string, o: Partial<CardDef> & { cost: number }): CardDef => ({
  kind, name, right: arrows.includes('→'), down: arrows.includes('↓'),
  moves: [...arrows].filter(a => a in MOVES).map(a => MOVES[a]),
  x: 0, draw: 0, goal: false, bulky: false, cutter: false, selfRemove: false, bonus: 0, sell: 0, ...o,
});

export const CARDS: Record<CardKind, CardDef> = {
  'R':   def('R',   '初期→',     '→',  { cost: 1 }),
  'D':   def('D',   '初期↓',     '↓',  { cost: 1 }),
  'J':   def('J',   '粗大ごみ',   '',   { cost: 0, bulky: true }),
  'X':   def('X',   'ゴミ袋',     '',   { cost: 2, x: 1 }),
  'R+':  def('R+',  '台車',       '→',  { cost: 2, draw: 1 }),
  'D+':  def('D+',  '通路',       '↓',  { cost: 3, draw: 2 }),
  'RD':  def('RD',  '仕分け箱',   '→↓', { cost: 2 }),
  'P':   def('P',   'リスト',     '',   { cost: 1, draw: 2 }),
  'RD2': def('RD2', 'ハブ',       '→↓', { cost: 3, draw: 2 }),
  'BAG': def('BAG', '紙袋',       '→',  { cost: 1, draw: 1, selfRemove: true }),
  // 試作・不採用のカード（標準の市場には並ばない．開始時に選ぶか，MARKET_ADD で試せる）
  'TRK':  def('TRK',  'ゴミ収集車', '↓',  { cost: 3, goal: true }),
  'ST':   def('ST',   '階段',       '↘',  { cost: 2 }),
  'LD':   def('LD',   'はしご',     '⇓',  { cost: 2 }),
  'LR':   def('LR',   'ローラー',   '⇒',  { cost: 2 }),
  'CUT':  def('CUT',  'カッター',   '→↓', { cost: 2, cutter: true }),
  'PT':   def('PT',   'ポイントカード', '↓', { cost: 2, bonus: 1 }),
  'SELL': def('SELL', 'フリマ',     '→',  { cost: 1, sell: 2 }),
};

/** 矢印のない（行き止まりになる）カードか */
export const isDeadEnd = (k: CardKind) => CARDS[k].moves.length === 0;
/** 2方向以上に伸ばせるカードか */
export const isBranch = (k: CardKind) => CARDS[k].moves.length >= 2;

export type Deck = { kind: CardKind; count: number }[];

/** 市場に並ぶカード（標準） */
export const MARKET_KINDS: CardKind[] = ['R', 'D', 'R+', 'D+', 'RD', 'P', 'RD2', 'BAG'];

/** 市場で売り切れない基本カード（行き詰まり防止．いつでも矢印を買い足せる） */
export const UNLIMITED_KINDS: CardKind[] = ['R', 'D'];

/** 開始時に市場へ並べられる候補（基本カードは別に必ず並ぶ）．前の6種が標準，後ろは試作 */
export const MARKET_CANDIDATES: CardKind[] = ['R+', 'D+', 'RD', 'P', 'RD2', 'BAG', 'X', 'TRK', 'ST', 'LD', 'LR', 'CUT', 'PT', 'SELL'];
/** 試作カード（ボットは学習していないので，ほとんど買わない） */
export const PROTOTYPE_KINDS: CardKind[] = ['X', 'TRK', 'ST', 'LD', 'LR', 'CUT', 'PT', 'SELL'];
/** 候補から選ぶ枚数（種類数） */
export const MARKET_PICK = 6;

/** 開始時に選んだ市場の候補を確かめ，基本カードを加えた市場を返す．不正なら理由を投げる */
export function marketFromPick(pick: string[]): CardKind[] {
  const kinds = [...new Set(pick)];
  if (kinds.some(k => !(MARKET_CANDIDATES as string[]).includes(k))) throw new Error('市場の候補にないカードがあります');
  if (kinds.length !== MARKET_PICK) throw new Error(`市場のカードは${MARKET_PICK}種類選んでください（今 ${kinds.length}種類）`);
  return [...UNLIMITED_KINDS, ...MARKET_CANDIDATES.filter(k => kinds.includes(k))];
}
export const UNLIMITED = 99;

/** 初期デッキ（✕のゴミ袋は1枚だけ．標準の市場には無い．候補として市場に並べることはできる） */
export const STARTING_DECK: Deck = [
  { kind: 'R', count: 3 }, { kind: 'D', count: 2 }, { kind: 'RD', count: 1 }, { kind: 'D+', count: 1 },
  { kind: 'J', count: 2 }, { kind: 'X', count: 1 },
];

/**
 * 検証用に切り替えられるルール
 * 粗大ごみの扱い
 *   double：排除するのに捨欲を2使う
 *   goal：捨欲が無制限のとき（ゴミ捨て場・ゴミ収集車）しか排除できない
 */
export const RULE = {
  bulky: 'double' as 'double' | 'goal',
  /** 手札からも排除できるか（false：場に置いたカードだけ排除できる） */
  handRemove: false,
};

/** そのカードを排除するのに使う捨欲（goal モードの粗大ごみは無制限のときだけ排除できる） */
export function removeCost(kind: CardKind): number {
  return CARDS[kind].bulky && RULE.bulky === 'double' ? 2 : 1;
}

export const HAND_SIZE = 3;
export const MAX_ROUNDS = 60;
