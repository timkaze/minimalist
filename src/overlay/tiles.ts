// オーバーレイ版のタイル．仕様：Memories/01_BoardGames/overlay_version.md／ミニマリスト_オーバーレイ版_仕様.md
//   袋から引いたタイルを「今いるマス」に置き，タイルの矢印の向きへ1マス出る．
//   置いたタイルはそのマスの効果を上書きする（上に見えている数字がそのまま効果．列の増減は足さない）

export type Dir = 'U' | 'D' | 'L' | 'R';
export const DIRS: Dir[] = ['U', 'D', 'L', 'R'];
export const DELTA: Record<Dir, [number, number]> = { U: [0, 1], D: [0, -1], L: [-1, 0], R: [1, 0] };
export const ARROW: Record<Dir, string> = { U: '↑', D: '↓', L: '←', R: '→' };

/** マスの効果：取得の額／排除の量／福袋（福袋から1枚もらう）／運試し（自分の袋に当たりチップを混ぜ，当たりが出るまでに表にした枚数が量になる） */
export interface Fx { kind: 'buy' | 'remove' | 'none' | 'gacha' | 'lucky'; amount: number }
export const GACHA_FX: Fx = { kind: 'gacha', amount: 1 };
export const LUCKY_FX: Fx = { kind: 'lucky', amount: 1 };
export const NO_FX: Fx = { kind: 'none', amount: 0 };
const buy = (amount: number): Fx => ({ kind: 'buy', amount });
const rem = (amount: number): Fx => ({ kind: 'remove', amount });

export type OKind =
  | 'WANT' | 'DOUBT' | 'JUNK' | 'HES'                      // 初期の袋
  | 'DOWN' | 'BR' | 'BREATH' | 'SWING'                     // 額2を残す↓
  | 'UP2' | 'RUSH'                                         // 額3を残す
  | 'CALM' | 'DOWN2' | 'LIGHT' | 'DRAG' | 'MEMO' | 'FREE'  // 量を残す・特殊
  | 'REST' | 'TREAT' | 'CLEAN'                             // 動かない（置いたタイルの上に立つ）
  | 'ROOMBA' | 'BIGDAY' | 'BAG' | 'COMPASS' | 'KODAWARI'   // お気に入り（永続．袋に入らない）
  | 'MOMENTUM' | 'BACK' | 'STACK' | 'SHELF'                 // 試作（EXPERIMENTAL．セットに入れたときだけ市場に並ぶ）
  | 'YUTORI' | 'KOKOROE' | 'KAKEIBO';                       // 試作：理性のお気に入り（理性の列でしか取得できない）

export interface TileDef {
  kind: OKind;
  name: string;
  /** 出られる向き（複数なら選ぶ．空なら動かず，置いたタイルの上に立つ） */
  dirs: Dir[];
  /** タイルを置いたマスの効果（上書き） */
  fx: Fx;
  /** 取得コスト（null は市場に無い） */
  cost: number | null;
  /** 捨てる重さ（v0.1 の値） */
  weight: number;
  /** 捨てる重さ（v0.2 の「重い」ルール：↑へ行くタイルと初期タイルは捨てにくい） */
  heavy?: number;
  /** これを排除したとき，置いたタイルからもう1枚を重さ0で排除できる */
  drag?: boolean;
  /** お気に入り（永続） */
  perm?: boolean;
  /** 取得するには衝動がこの値以上の列で止まる */
  buyNeed?: number;
  /** 取得するには理性がこの値以上の列で止まる（理性のお気に入り） */
  calmNeed?: number;
  /** 排除するには理性がこの値以上の列で止まる */
  dropNeed?: number;
  /** 量を運ぶ：盤にあるあいだ（置いた手番のあいだ），止まったマスの量をこの数だけ増やす（何枚でも重なる．ルール carry） */
  boost?: number;
  /** 矢印の代わりに，1つ前に置いたタイルのマスへ戻る */
  back?: boolean;
  /** 量＝このマスにこの手番に重ねたタイルの枚数（自分を含む） */
  stack?: boolean;
  /** 手番の終わりに盤に残る（持ち物から外れ，そのマスの効果になり続ける）．排除できない */
  stay?: boolean;
  /** 効果の補足（矢印と額・量で書けないもの） */
  note?: string;
}

/** 身軽：排除した枚数 LIGHT_PER 枚ごとに量 +1（最大 LIGHT_MAX） */
export const LIGHT_PER = 3;
export const LIGHT_MAX = 3;
/** ためらい（2枚目で終わりのルール）のタイルの効果 */
export const HES_FX: Fx = buy(3);

const t = (kind: OKind, name: string, dirs: Dir[], fx: Fx, cost: number | null, o: Partial<TileDef> = {}): TileDef =>
  ({ kind, name, dirs, fx, cost, weight: 1, ...o });

export const TILES: Record<OKind, TileDef> = {
  WANT:   t('WANT', '欲しい', ['U'], buy(1), null, { heavy: 2 }),
  DOUBT:  t('DOUBT', '迷い', ['L'], buy(1), null),
  JUNK:   t('JUNK', 'ガラクタ', ['U', 'D', 'L', 'R'], NO_FX, null, { weight: 2, dropNeed: 1, note: '矢印はルールで変わる（→だけ／4方向）' }),
  HES:    t('HES', 'ためらい', ['R', 'L'], NO_FX, null, { heavy: 2, dropNeed: 1, note: 'ルールで変わる：出たらそこで終わり（効果なし）／2枚目が出たら終わり（額3）' }),
  DOWN:   t('DOWN', '片付けたい', ['D'], NO_FX, 1),
  BR:     t('BR', '分かれ道', ['D', 'R'], buy(2), 3),
  BREATH: t('BREATH', '深呼吸', ['D', 'L'], buy(2), 3),
  SWING:  t('SWING', '行ったり来たり', ['U', 'D'], buy(2), 3, { heavy: 2 }),
  UP2:    t('UP2', '欲しい欲しい', ['U'], buy(3), 1, { heavy: 2 }),
  RUSH:   t('RUSH', '衝動買い', ['R'], buy(3), 1),
  // v0.5：矢印のある量のタイルは「量を運ぶ」（盤にあるあいだ，止まったマスの量 +n）．置いたマスに量を残すだけでは，出ていくので使われなかった
  CALM:   t('CALM', '冷静', ['L'], rem(2), 3, { boost: 1 }),
  DOWN2:  t('DOWN2', '断捨離', ['D'], rem(2), 3, { boost: 1 }),
  LIGHT:  t('LIGHT', '軽やか', ['D'], rem(0), 4, { note: `量は排除した枚数÷${LIGHT_PER}（最大${LIGHT_MAX}）` }),
  DRAG:   t('DRAG', '道連れ袋', ['D'], buy(2), 3, { drag: true, buyNeed: 1, note: '排除したとき，置いたタイルからもう1枚を重さ0で排除' }),
  MEMO:   t('MEMO', '思い出の品', ['U'], rem(3), 3, { heavy: 2, dropNeed: 2, boost: 2 }),
  FREE:   t('FREE', '気まま', ['U', 'D', 'L', 'R'], buy(2), 5, { heavy: 2 }),
  REST:   t('REST', 'ひと休み', [], rem(2), 3),
  TREAT:  t('TREAT', 'ご褒美', [], buy(4), 3),
  CLEAN:  t('CLEAN', '大掃除', [], rem(4), 5, { buyNeed: 2 }),
  // v0.5：ルンバ 5→6，大掃除の日 4→6（強いボット同士だと勝者の全員が持っていた）
  ROOMBA:   t('ROOMBA', 'ルンバ', [], NO_FX, 6, { perm: true, weight: 0, buyNeed: 1, note: '手番の終わりに，どこで止まっても置いたタイルから1枚を排除できる（条件・重さなし）' }),
  BIGDAY:   t('BIGDAY', '大掃除の日', [], NO_FX, 6, { perm: true, weight: 0, buyNeed: 2, note: '捨てるマスで止まったら，置いたタイルを何枚でも排除できる（量・重さを無視）' }),
  BAG:      t('BAG', '大容量ゴミ袋', [], NO_FX, 4, { perm: true, weight: 0, buyNeed: 2, note: '捨てるマスで止まったら，捨て山からも量と同じ枚数まで排除できる（重さなし）' }),
  COMPASS:  t('COMPASS', 'コンパス', [], NO_FX, 6, { perm: true, weight: 0, buyNeed: 1, note: '矢印のあるタイルを好きな向きに出られる' }),
  KODAWARI: t('KODAWARI', 'こだわり', [], NO_FX, 4, { perm: true, weight: 0, buyNeed: 1, note: '止まったマスの額・量 +1' }),
  // ---- 試作 ----
  MOMENTUM: t('MOMENTUM', '勢い', ['D'], NO_FX, 3, { boost: 1 }),
  BACK:     t('BACK', 'ひきかえす', [], buy(2), 3, { back: true, note: '1つ前に置いたタイルのマスへ戻る（そのタイルの効果を使える）．1枚目なら動かない' }),
  STACK:    t('STACK', '山積み', [], rem(0), 3, { stack: true, note: '量＝このマスにこの手番に重ねたタイルの枚数（これも数える）' }),
  // 理性のお気に入り：理性の列は額が小さいので安い．効果は「落ち着いて続ける・手放す」寄り
  // ゆとり：最初は「ためらいで止まらない」（コスト3）だったが，98% が買って 5.2 ラウンドで終わるほど強かったので，1枚目だけにした（コスト4では 4% しか買われなかったので 3 に戻した）
  YUTORI:   t('YUTORI', 'ゆとり', [], NO_FX, 3, { perm: true, weight: 0, calmNeed: 1, note: 'その手番の1枚目のためらいでは止まらない（2枚目で止まる）' }),
  // 手放す覚悟：コスト2では買った人の勝率倍率が 0.5 前後と弱かったので 1 にした
  KOKOROE:  t('KOKOROE', '手放す覚悟', [], NO_FX, 1, { perm: true, weight: 0, calmNeed: 2, note: '排除の条件（理性nで排除）を無視できる' }),
  KAKEIBO:  t('KAKEIBO', '家計簿', [], NO_FX, 2, { perm: true, weight: 0, calmNeed: 1, note: '排除できた手番でも，手番の終わりに決心チップを1枚もらう（上限は同じ）' }),
  SHELF:    t('SHELF', '収納棚', [], rem(2), 4, { stay: true, note: '手番の終わりに盤に残り（持ち物から外れる），そのマスがずっと量2になる．START・お気に入りのマス・棚のあるマスでは残らず捨て山へ．排除できない' }),
};

export const PERMS: OKind[] = ['ROOMBA', 'BIGDAY', 'BAG', 'COMPASS', 'KODAWARI'];
export const isPerm = (k: OKind) => !!TILES[k].perm;
export const UNLIMITED_KINDS: OKind[] = ['DOWN'];
export const MARKET: OKind[] = ['DOWN', 'BR', 'BREATH', 'SWING', 'UP2', 'RUSH', 'CALM', 'DOWN2', 'LIGHT', 'DRAG', 'MEMO', 'FREE', 'REST', 'TREAT', 'CLEAN', ...PERMS];
/** 試作のタイル（「すべて」のセットには入らない．自分で選ぶ・検証のときだけ並ぶ） */
/** 試作：理性のお気に入り */
export const CALM_PERMS: OKind[] = ['YUTORI', 'KOKOROE', 'KAKEIBO'];
/** お気に入りの全部（試作を含む） */
export const ALL_PERMS: OKind[] = [...PERMS, ...CALM_PERMS];
export const EXPERIMENTAL: OKind[] = ['MOMENTUM', 'BACK', 'STACK', 'SHELF', ...CALM_PERMS];
/** 市場に並びうる種類の全部（並び順もこの順） */
export const BUYABLE: OKind[] = [...MARKET, ...EXPERIMENTAL];
/** 盤に置くお気に入り（ルール favBoard のとき，取得したら自分の盤の1マスに置く） */
export const FURN_KINDS: OKind[] = ['BIGDAY', 'ROOMBA'];

/** 初期の袋（ためらいの枚数はルールで変わる．big：多め＝欲しい3・迷い2・ガラクタ2） */
export const startingBag = (hesCount: number, big = false): [OKind, number][] => [['WANT', big ? 3 : 2], ['DOUBT', big ? 2 : 1], ['JUNK', big ? 2 : 1], ['HES', hesCount]];

export const fxText = (fx: Fx) => (fx.kind === 'buy' ? `額${fx.amount}` : fx.kind === 'remove' ? `量${fx.amount}` : fx.kind === 'gacha' ? '福袋' : fx.kind === 'lucky' ? '運試し' : '効果なし');

/** ルールで変わる部分：重さ（重い／v0.1）とガラクタの矢印（→だけ／4方向） */
export interface TileRules { weights: 'heavy' | 'light'; junk: 'right' | 'four' }
export const weightOf = (k: OKind, r: TileRules) => (r.weights === 'heavy' ? TILES[k].heavy ?? TILES[k].weight : TILES[k].weight);
export const tileDirs = (k: OKind, r: TileRules): Dir[] => (k === 'JUNK' && r.junk === 'right' ? ['R'] : TILES[k].dirs);

/** 福袋の中身（全員で共有．強いタイルから弱いタイルまで．引いたら戻さない） */
export const GACHA_POOL: [OKind, number][] = [
  ['FREE', 2], ['TREAT', 2], ['REST', 2], ['DOWN2', 2], ['CALM', 2], ['BREATH', 1], ['BR', 1],
  ['DOWN', 3], ['UP2', 2], ['RUSH', 1], ['WANT', 2], ['JUNK', 1],
];
/** 「量を運ぶ」の説明文 */
export const carryText = (n: number) => `盤にあるあいだ，止まったマスの量 +${n}（運ぶ）`;
export const dirsText = (dirs: Dir[]) => (dirs.length ? dirs.map(d => ARROW[d]).join('か') : '動かない');

// ---- 市場に並べるタイルのセット（開始時に選ぶ）．片付けたいは必ず入る ----

export interface TileSet { id: string; label: string; note: string; tiles: OKind[] }
export const TILE_SETS: TileSet[] = [
  { id: 'intro', label: '入門', note: '額を残す↓と，その場で止まるタイル．お気に入りは大掃除の日・こだわり',
    tiles: ['DOWN', 'BR', 'BREATH', 'UP2', 'RUSH', 'CALM', 'DOWN2', 'REST', 'TREAT', 'BIGDAY', 'KODAWARI'] },
  { id: 'light', label: '身軽と道連れ', note: '排除するほど量が増える．お気に入りはルンバ・大容量ゴミ袋',
    tiles: ['DOWN', 'BR', 'BREATH', 'UP2', 'RUSH', 'CALM', 'LIGHT', 'DRAG', 'REST', 'ROOMBA', 'BAG'] },
  { id: 'swing', label: '行ったり来たり', note: '同じ道を往復して重ねる．お気に入りはコンパス・大掃除の日',
    tiles: ['DOWN', 'SWING', 'FREE', 'MEMO', 'UP2', 'RUSH', 'DOWN2', 'TREAT', 'CLEAN', 'COMPASS', 'BIGDAY'] },
  { id: 'all', label: 'すべて', note: `全${MARKET.length}種類`, tiles: [...MARKET] },
  // ゆとりはセットに入れていない：ためらいを無視する効果は，弱めても持った人の勝率倍率が 2.2〜2.4 になった（作り直しが要る）
  { id: 'calm', label: 'すべて＋理性のお気に入り（試作）', note: '理性の列でしか取得できないお気に入り2種（家計簿・手放す覚悟）を足す', tiles: [...MARKET, 'KAKEIBO', 'KOKOROE'] },
  { id: 'random', label: 'ランダム', note: '片付けたい＋ふつうのタイル7種＋お気に入り2種をくじで', tiles: [] },
];

const orderMarket = (ks: OKind[]) => BUYABLE.filter(k => ks.includes(k));

/** 選んだセット（id）またはタイルの一覧から市場を作る */
export function marketFromChoice(choice: string | OKind[], rand: () => number = Math.random): OKind[] {
  if (typeof choice === 'string') {
    if (choice === 'random') {
      const pick = (xs: OKind[], n: number) => { const a = [...xs]; const out: OKind[] = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rand() * a.length), 1)[0]); return out; };
      const normal = MARKET.filter(k => !isPerm(k) && !UNLIMITED_KINDS.includes(k));
      return orderMarket(['DOWN', ...pick(normal, 7), ...pick(PERMS, 2)]);
    }
    const set = TILE_SETS.find(x => x.id === choice);
    if (!set) throw new Error('そのセットはありません');
    return orderMarket(set.tiles);
  }
  const ks = [...new Set(choice)].filter(k => BUYABLE.includes(k));
  if (ks.length !== new Set(choice).size) throw new Error('市場にないタイルが含まれています');
  if (!ks.includes('DOWN')) ks.unshift('DOWN');
  if (ks.length < 5) throw new Error('片付けたいのほかに4種類以上選んでください');
  return orderMarket(ks);
}
