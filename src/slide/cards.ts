// スライド版のカード．仕様：Memories/01_BoardGames/ミニマリスト_スライド版_仕様.md
//   手札はなく，山札の上をめくってコマを動かす．カードの「動き」がそのままデッキの性格になる

export type Dir = 'U' | 'D' | 'L' | 'R';
export const DIRS: Dir[] = ['U', 'D', 'L', 'R'];
export const DELTA: Record<Dir, [number, number]> = { U: [0, 1], D: [0, -1], L: [-1, 0], R: [1, 0] };
export const ARROW: Record<Dir, string> = { U: '↑', D: '↓', L: '←', R: '→' };

export type Move =
  /** dirs のどれか1つを選んで n マス．light なら身軽（排除した枚数÷3 を足す）．stop ならそこで必ず止まる */
  | { t: 'step'; dirs: Dir[]; n: number; light?: boolean; stop?: boolean }
  /** ぶつかるまで滑る */
  | { t: 'slide'; dir: Dir }
  /** 上下左右に積み木を1個置く（動かない） */
  | { t: 'stopper' }
  /** 動かない */
  | { t: 'none' }
  /** 揺り戻し：物欲の行なら↓2，捨欲の行なら↑1，中央の行なら↓1 */
  | { t: 'swing' }
  /** 思い出の品：排除した枚数が MEMO_AT 未満なら↑1，以上なら↓3 */
  | { t: 'memo' };

export type SKind =
  | 'WANT' | 'HES' | 'DOUBT' | 'JUNK'          // 初期カード
  | 'DOWN' | 'DOWN2' | 'BR' | 'BREATH'         // 基本
  | 'LIGHT' | 'DRAG'                           // 身軽
  | 'SLIDE' | 'ICE' | 'STOP'                   // 滑走
  | 'SWING' | 'MEMO' | 'USED' | 'FAV';         // 役割が変わる・お気に入り

export interface SCardDef {
  kind: SKind;
  name: string;
  move: Move;
  /** 取得コスト（null は市場に無い） */
  cost: number | null;
  /** 捨てる重さ */
  weight: number;
  /** これを排除したとき，今日の流れからもう1枚を重さ0で排除できる */
  drag?: boolean;
  /** 物欲の行で止まったとき，回してお気に入りにできる */
  rotatable?: boolean;
  /** 取得したときからお気に入り */
  favorite?: boolean;
  text: string;
}

export const MEMO_AT = 5;
/** 身軽：排除した枚数 LIGHT_PER 枚ごとに歩数 +1 */
export const LIGHT_PER = 3;

const step = (dirs: Dir[], n: number, o: { light?: boolean; stop?: boolean } = {}): Move => ({ t: 'step', dirs, n, ...o });

export const SCARDS: Record<SKind, SCardDef> = {
  WANT:   { kind: 'WANT',   name: '欲しい',     move: step(['U'], 1), cost: null, weight: 1, text: '↑1' },
  HES:    { kind: 'HES',    name: 'ためらい',   move: step(['R'], 1, { stop: true }), cost: null, weight: 1, text: '→1，そこで必ず止まる' },
  DOUBT:  { kind: 'DOUBT',  name: '迷い',       move: step(['L'], 1), cost: null, weight: 1, text: '←1' },
  JUNK:   { kind: 'JUNK',   name: 'ガラクタ',   move: { t: 'none' }, cost: null, weight: 2, text: '動かない．捨てる重さ2' },
  DOWN:   { kind: 'DOWN',   name: '片付けたい', move: step(['D'], 1), cost: 1, weight: 1, text: '↓1' },
  DOWN2:  { kind: 'DOWN2',  name: '断捨離',     move: step(['D'], 2), cost: 2, weight: 1, text: '↓2' },
  BR:     { kind: 'BR',     name: '分かれ道',   move: step(['D', 'R'], 1), cost: 1, weight: 1, text: '↓1か→1' },
  BREATH: { kind: 'BREATH', name: '深呼吸',     move: step(['D', 'L'], 1), cost: 1, weight: 1, text: '↓1か←1' },
  LIGHT:  { kind: 'LIGHT',  name: '軽やか',     move: step(['D'], 1, { light: true }), cost: 2, weight: 1, text: `↓1＋身軽（排除${LIGHT_PER}枚ごとに+1）` },
  DRAG:   { kind: 'DRAG',   name: '道連れ袋',   move: step(['D'], 1), cost: 2, weight: 1, drag: true, text: '↓1．排除したとき今日の流れからもう1枚を重さ0で排除' },
  SLIDE:  { kind: 'SLIDE',  name: '滑り台',     move: { t: 'slide', dir: 'D' }, cost: 3, weight: 1, text: '↓へぶつかるまで滑る' },
  ICE:    { kind: 'ICE',    name: '氷の廊下',   move: { t: 'slide', dir: 'R' }, cost: 2, weight: 1, text: '→へぶつかるまで滑る' },
  STOP:   { kind: 'STOP',   name: 'ストッパー', move: { t: 'stopper' }, cost: 2, weight: 1, text: '上下左右に積み木を1個置く' },
  SWING:  { kind: 'SWING',  name: '揺り戻し',   move: { t: 'swing' }, cost: 2, weight: 1, text: '物欲の行なら↓2，捨欲の行なら↑1，中央なら↓1' },
  MEMO:   { kind: 'MEMO',   name: '思い出の品', move: { t: 'memo' }, cost: 1, weight: 1, text: `排除${MEMO_AT}枚未満なら↑1，以上なら↓3` },
  USED:   { kind: 'USED',   name: '愛用品',     move: step(['D'], 1), cost: 3, weight: 1, rotatable: true, text: '↓1．物欲の行で止まったとき回してお気に入りにできる' },
  FAV:    { kind: 'FAV',    name: '一生モノ',   move: step(['U', 'D', 'L', 'R'], 1), cost: 5, weight: 1, favorite: true, text: 'お気に入り．好きな向きに1' },
};

/** お気に入りの動き（回した愛用品・一生モノ） */
export const FAV_MOVE: Move = step(['U', 'D', 'L', 'R'], 1);

export const STARTING: [SKind, number][] = [['WANT', 2], ['HES', 1], ['DOUBT', 1], ['JUNK', 1]];
export const UNLIMITED_KINDS: SKind[] = ['DOWN'];
export const MARKET: SKind[] = ['DOWN', 'DOWN2', 'BR', 'BREATH', 'LIGHT', 'DRAG', 'SLIDE', 'ICE', 'STOP', 'SWING', 'MEMO', 'USED', 'FAV'];
