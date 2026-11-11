// オーバーレイ版のルール．仕様：Memories/01_BoardGames/ミニマリスト_オーバーレイ版_仕様.md
//   盤：横 x = −3（理性3）〜3（衝動3）．縦は中央 y = 0 から上が物欲，下が捨欲．毎手番 START (0,0) から
//   手番：袋からタイルを引く → 今いるマスに置く → タイルの矢印の向きへ1マス出る，を繰り返し，好きなところで止める
//   止まったマスの「一番上に見えている効果」（タイルがあればタイル，なければ盤の印刷）で取得か排除をする
//   コマは無い．「今いるマス」は最後に置いたタイルの矢印の先（画面ではそのマスを光らせる）

import { DELTA, DIRS, Dir, Fx, GACHA_FX, GACHA_POOL, HES_FX, LIGHT_MAX, LIGHT_PER, MARKET, NO_FX, OKind, LUCKY_FX, TILES, UNLIMITED_KINDS, isPerm, startingBag, tileDirs, weightOf } from './tiles';
import { nextRandom } from '../engine/rng';
import { shuffle } from '../engine/rng';

export const X_MIN = -3, X_MAX = 3;

/** 盤の縦の目盛り：buy[i] は中央から i+1 行上の額，remove[i] は i+1 行下の量（一番下は捨て山からも1枚） */
export interface OBoard { name: string; label: string; buy: number[]; remove: number[] }
export const OBOARDS: Record<string, OBoard> = {
  gentle: { name: 'gentle', label: 'ゆるやか（物欲 2,3,4／捨欲 1,1,2,2）', buy: [2, 3, 4], remove: [1, 1, 2, 2] },
  basic: { name: 'basic', label: '基本（物欲 2,3,4／捨欲 1,2,3,3）', buy: [2, 3, 4], remove: [1, 2, 3, 3] },
  slow: { name: 'slow', label: 'ゆっくり（物欲 1,1,2,2,3,3,4／捨欲 0,1,1,2,3）', buy: [1, 1, 2, 2, 3, 3, 4], remove: [0, 1, 1, 2, 3] },
};
export const yMax = (b: OBoard) => b.buy.length;
export const yMin = (b: OBoard) => -b.remove.length;
export const isDeep = (y: number, b: OBoard) => y === yMin(b);
export const MAX_ROUNDS = 60;
export const UNLIMITED = 99;
/** 中央の行（START 以外）の額 */
export const MID_BUY = 2;

// ---- 開始時に切り替えられるルール ----

export interface Rules {
  /** ためらい：first = 出たらそこで終わり（タイルは効果なし）／second = 2枚目が出たら終わり（タイルは額3） */
  hes: 'first' | 'second';
  /** 初期の袋のためらいの枚数 */
  hesCount: number;
  /** 片付けた跡の壁：排除したマスに跡が残り，入れなくなる */
  traces: boolean;
  board: string;
  /** 盤の印刷の列の増減：v06 = 左上・右下ほど少ない／bonus = 上乗せだけ／none = なし */
  cols: 'v06' | 'bonus' | 'none';
  /** 取得・排除の条件（衝動nで取得／理性nで排除） */
  needs: boolean;
  /** 最後の1枚はどこで止まっても手放せる */
  lastCard: boolean;
  /** 袋が尽きたら捨て山を混ぜて引き続けられる */
  refill: boolean;
  /** 中央の行（START 以外）に額2 */
  midBuy: boolean;
  /** 重さ：heavy = ↑へ行くタイルと初期タイルは捨てにくい／light = v0.1 */
  weights: 'heavy' | 'light';
  /** ガラクタの矢印：right = →だけ／four = 4方向 */
  junk: 'right' | 'four';
  /** 特別なマス：捨欲の領域に点々とある額のマス，福袋，運試し */
  special: boolean;
  /** 決心チップ：1枚も排除できなかった手番の終わりに1枚もらう．1枚で重さ1の肩代わりか，条件1段階の免除 */
  chips: boolean;
}
export const DEFAULT_RULES: Rules = { hes: 'first', hesCount: 2, traces: false, board: 'gentle', cols: 'v06', needs: true, lastCard: true, refill: true, midBuy: true, weights: 'heavy', junk: 'right', special: true, chips: true };

/** 外から来たルールを整える（不正な値は既定に） */
export function normRules(r: Partial<Rules> | undefined | null): Rules {
  const d = DEFAULT_RULES, x = r ?? {};
  const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  return {
    hes: x.hes === 'second' ? 'second' : x.hes === 'first' ? 'first' : d.hes,
    hesCount: x.hesCount === 1 || x.hesCount === 2 || x.hesCount === 3 ? x.hesCount : d.hesCount,
    traces: bool(x.traces, d.traces),
    board: typeof x.board === 'string' && OBOARDS[x.board] ? x.board : d.board,
    cols: x.cols === 'bonus' || x.cols === 'none' || x.cols === 'v06' ? x.cols : d.cols,
    needs: bool(x.needs, d.needs),
    lastCard: bool(x.lastCard, d.lastCard),
    refill: bool(x.refill, d.refill),
    midBuy: bool(x.midBuy, d.midBuy),
    weights: x.weights === 'light' || x.weights === 'heavy' ? x.weights : d.weights,
    junk: x.junk === 'four' || x.junk === 'right' ? x.junk : d.junk,
    special: bool(x.special, d.special),
    chips: bool(x.chips, d.chips),
  };
}

// ---- 盤 ----

export interface Pos { x: number; y: number }
export const samePos = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y;
export const inBoard = (p: Pos, b: OBoard) => p.x >= X_MIN && p.x <= X_MAX && p.y >= yMin(b) && p.y <= yMax(b);
/** START とその上下左右には片付けた跡を置かない（道がふさがらないように） */
export const noTraceZone = (p: Pos) => Math.abs(p.x) + Math.abs(p.y) <= 1;

const BUY_PENALTY = [1, 1, 2], REMOVE_PENALTY = [0, 1, 1], REASON_BONUS = [0, 1, 1];
/** 盤の印刷の列の増減 */
export function colMod(x: number, kind: 'buy' | 'remove', cols: Rules['cols']): number {
  if (x === 0 || cols === 'none') return 0;
  const v = kind === 'buy' ? (x > 0 ? x : -BUY_PENALTY[-x - 1]) : (x < 0 ? REASON_BONUS[-x - 1] : -REMOVE_PENALTY[x - 1]);
  return cols === 'bonus' ? Math.max(0, v) : v;
}

/** 特別なマス（基本・ゆるやかの盤）：捨欲の領域の額のマス，福袋，運試し．数字はそのまま（列の増減なし） */
export const SPECIAL_CELLS: { x: number; y: number; fx: Fx }[] = [
  { x: 0, y: -2, fx: { kind: 'buy', amount: 2 } }, { x: -2, y: -1, fx: { kind: 'buy', amount: 2 } },
  { x: -1, y: -3, fx: { kind: 'buy', amount: 2 } }, { x: 1, y: -4, fx: { kind: 'buy', amount: 3 } },
  // 理性1列の福袋は理性2列（同じ行）へ移し，元のマスは額3にした
  { x: -1, y: 1, fx: { kind: 'buy', amount: 3 } },
  { x: -2, y: 1, fx: GACHA_FX }, { x: 2, y: 0, fx: GACHA_FX }, { x: -2, y: 3, fx: GACHA_FX },
  { x: 1, y: -1, fx: LUCKY_FX }, { x: -2, y: -2, fx: LUCKY_FX },
];
export const specialAt = (pos: Pos, b: OBoard, rules: Rules): Fx | undefined =>
  (rules.special && b.buy.length === 3 && b.remove.length === 4 ? SPECIAL_CELLS.find(c => c.x === pos.x && c.y === pos.y)?.fx : undefined);

/** 盤に印刷してある効果（列の増減込み） */
export function printedFx(pos: Pos, b: OBoard, rules: Rules): Fx {
  const sp = specialAt(pos, b, rules);
  if (sp) return sp;
  if (pos.y === 0) return pos.x !== 0 && rules.midBuy ? { kind: 'buy', amount: MID_BUY } : NO_FX;
  const kind = pos.y > 0 ? 'buy' : 'remove';
  const base = pos.y > 0 ? b.buy[pos.y - 1] : b.remove[-pos.y - 1];
  return { kind, amount: Math.max(0, base + colMod(pos.x, kind, rules.cols)) };
}

export interface Tile { id: number; kind: OKind }
/** 盤に置いたタイル（置いた順） */
export interface Placed extends Tile { pos: Pos }

/** 手番中の歩み（ボットの先読みでも使う） */
export interface Walk { pos: Pos; placed: Placed[]; hes: number }
/** 歩みに関わる，手番中は変わらないもの */
export interface Env { rules: Rules; board: OBoard; traces: Pos[]; perms: OKind[]; removed: number }

/** タイルを置いたマスの効果 */
export function tileFx(kind: OKind, env: Pick<Env, 'rules' | 'removed'>): Fx {
  if (kind === 'HES') return env.rules.hes === 'second' ? HES_FX : NO_FX;
  if (kind === 'LIGHT') return { kind: 'remove', amount: Math.min(LIGHT_MAX, Math.floor(env.removed / LIGHT_PER)) };
  return TILES[kind].fx;
}

/** そのマスの一番上のタイル */
export const topTile = (placed: Placed[], pos: Pos): Placed | undefined => {
  for (let i = placed.length - 1; i >= 0; i--) if (samePos(placed[i].pos, pos)) return placed[i];
  return undefined;
};
export const stackAt = (placed: Placed[], pos: Pos) => placed.filter(t => samePos(t.pos, pos));

/** そのマスで止まったときの効果：一番上のタイル，なければ盤の印刷．こだわりは +1 */
export function effectAt(env: Env, placed: Placed[], pos: Pos): Fx {
  const top = topTile(placed, pos);
  const fx = top ? tileFx(top.kind, env) : printedFx(pos, env.board, env.rules);
  return (fx.kind === 'buy' || fx.kind === 'remove') && env.perms.includes('KODAWARI') ? { kind: fx.kind, amount: fx.amount + 1 } : fx;
}

/** 出られる向き（コンパスがあれば矢印のあるタイルは好きな向き） */
export function dirsOf(kind: OKind, env: Env): Dir[] {
  const d = tileDirs(kind, env.rules);
  return d.length && env.perms.includes('COMPASS') ? DIRS : d;
}
export const step = (pos: Pos, dir: Dir): Pos => ({ x: pos.x + DELTA[dir][0], y: pos.y + DELTA[dir][1] });
/** その向きへ出られるか（盤の外・片付けた跡の壁へは出られず，置いたタイルの上に残る） */
export const canMove = (env: Env, pos: Pos, dir: Dir) => {
  const n = step(pos, dir);
  return inBoard(n, env.board) && !(env.rules.traces && env.traces.some(t => samePos(t, n)));
};

/** タイルを今いるマスに置く（まだ出ない） */
export function putTile(w: Walk, tile: Tile): void {
  w.placed.push({ id: tile.id, kind: tile.kind, pos: { ...w.pos } });
}
/** 置いたタイルから dir へ出る（null は動かない）．戻り値：そこで必ず止まるか（ためらい） */
export function leaveTile(env: Env, w: Walk, kind: OKind, dir: Dir | null): boolean {
  if (dir && canMove(env, w.pos, dir)) w.pos = step(w.pos, dir);
  if (kind !== 'HES') return false;
  w.hes++;
  return env.rules.hes === 'first' || w.hes >= 2;
}

// ---- ゲームの状態 ----

export type TurnPhase = 'move' | 'branch' | 'resolve';

export interface OPlayer {
  name: string;
  isBot: boolean;
  botType?: string;
  bag: Tile[];
  discard: Tile[];
  /** 今日の流れ：この手番に盤へ置いたタイル（置いた順） */
  placed: Placed[];
  /** 今いるマス（止めたらこのマスの効果） */
  pos: Pos;
  /** この手番に出たためらいの枚数 */
  hes: number;
  perms: OKind[];
  /** 片付けた跡（ルールで壁にしたときだけ使う） */
  traces: Pos[];
  removed: number;
  /** 排除したタイル（終了時に見せる．古い保存データには無い） */
  gone?: Tile[];
  bought: number;
  finished: boolean;
  /** 決心チップ */
  chips: number;
  /** 運試しの結果（当たりチップが出るまでに袋から表にした枚数＝量）．運試しのマスで止まったときに決まる */
  roll?: number | null;
  /** 運試しで表にしたタイル（見せるだけ．排除の対象にはならず，捨て山へ送る） */
  rollKinds?: OKind[];
  rollIds?: number[];
}

export interface OState {
  players: OPlayer[];
  market: Partial<Record<OKind, number>>;
  current: number;
  round: number;
  phase: 'play' | 'over';
  turn: TurnPhase;
  winners: number[];
  log: string[];
  rng: number;
  nextId: number;
  board: OBoard;
  rules: Rules;
  /** 福袋の残り（全員で共有） */
  gacha: OKind[];
}

export type OAction =
  | { type: 'draw' }
  | { type: 'stop' }
  | { type: 'branch'; dir: Dir }
  /** roomba：ルンバで排除する1枚 */
  | { type: 'resolve'; buy: OKind[]; remove: number[]; roomba?: number };

export class ORuleError extends Error {}

export function newOverlayGame(
  setup: { name: string; isBot?: boolean; botType?: string }[], seed: number, opts: { market?: OKind[]; rules?: Partial<Rules> } = {},
): OState {
  const rules = normRules(opts.rules);
  const s: OState = {
    players: [], market: {}, current: 0, round: 1, phase: 'play', turn: 'move', winners: [], log: [], rng: seed, nextId: 1,
    board: OBOARDS[rules.board], rules, gacha: GACHA_POOL.flatMap(([k, n]) => Array.from({ length: n }, () => k)),
  };
  for (const k of opts.market ?? MARKET) s.market[k] = UNLIMITED_KINDS.includes(k) ? UNLIMITED : Math.max(2, setup.length);
  for (const p of setup) {
    const bag: Tile[] = [];
    for (const [k, n] of startingBag(rules.hesCount)) for (let i = 0; i < n; i++) bag.push({ id: s.nextId++, kind: k });
    shuffle(bag, s);
    // 初期の袋のためらい1枚は必ず一番下（最後に引かれる位置．引くのは配列の末尾から）に置く
    const hi = bag.findIndex(t => t.kind === 'HES');
    if (hi >= 0) bag.unshift(bag.splice(hi, 1)[0]);
    s.players.push({ name: p.name, isBot: !!p.isBot, botType: p.botType, bag, discard: [], placed: [], pos: { x: 0, y: 0 }, hes: 0, perms: [], traces: [], removed: 0, bought: 0, finished: false, chips: 0 });
  }
  s.log.push('ゲーム開始');
  return s;
}

export const envOf = (s: OState, p: OPlayer): Env => ({ rules: s.rules, board: s.board, traces: p.traces, perms: p.perms, removed: p.removed });
export const ownedTiles = (p: OPlayer): Tile[] => [...p.bag, ...p.discard, ...p.placed];
/** 最後の1枚：持ち物がこの手番に置いた1枚だけ */
export const isLastCard = (p: OPlayer) => !p.bag.length && !p.discard.length && p.placed.length === 1;
export const isDone = (p: OPlayer) => ownedTiles(p).length === 0;
export const favCost = (p: OPlayer) => p.perms.reduce((n, k) => n + (TILES[k].cost ?? 0), 0);
/** まだ引けるか */
export const canDraw = (p: OPlayer, rules: Rules) => p.bag.length > 0 || (rules.refill && p.discard.length > 0);
/** 今止めたときの効果．運試しは，止まって引いたあとは量のマスとして扱う */
export function hereFx(s: OState, p: OPlayer): Fx {
  const fx = effectAt(envOf(s, p), p.placed, p.pos);
  return fx.kind === 'lucky' && p.roll != null ? { kind: 'remove', amount: p.roll } : fx;
}
/**
 * 止まった：運試しのマスなら，自分の袋（まだ引いていないタイル）に当たりチップを混ぜ，当たりが出るまで表にする．
 * 表にした枚数が量になる（袋が多い人ほど大きくなりやすい）．表にしたタイルは排除の対象にならず，捨て山へ送る
 */
function stopHere(s: OState, p: OPlayer): void {
  s.turn = 'resolve';
  if (hereFx(s, p).kind !== 'lucky') return;
  const n = p.bag.length;
  const k = Math.floor(nextRandom(s) * (n + 1)); // 当たりチップの位置は n+1 通りが同じ確率
  p.roll = k;
  const shown = p.bag.splice(n - k).reverse(); // 袋の上から k 枚
  p.rollKinds = shown.map(t => t.kind);
  p.rollIds = shown.map(t => t.id);
  p.discard.push(...shown); // 表にしたタイルは捨て山へ
  s.log.push(`${p.name}：運試し → 袋から${k}枚表にして当たり（量${k}）`);
}

export const canBuyAt = (k: OKind, x: number, rules: Rules) => !rules.needs || (TILES[k].buyNeed ?? 0) <= Math.max(0, x);
export const canDropAt = (k: OKind, x: number, rules: Rules) => !rules.needs || (TILES[k].dropNeed ?? 0) <= Math.max(0, -x);

/** 排除の重さの合計（道連れ袋1枚につき，ほかの1枚の重さを0にできる．重いものから） */
export function removeLoad(tiles: Tile[], rules: Rules): number {
  const drags = tiles.filter(c => TILES[c.kind].drag).length;
  const others = tiles.filter(c => !TILES[c.kind].drag).map(c => weightOf(c.kind, rules)).sort((a, b) => b - a);
  return drags + others.slice(drags).reduce((n, w) => n + w, 0);
}
/** 決心チップの上限 */
export const MAX_CHIPS = 3;
/**
 * その排除に必要な決心チップの枚数：量を超えた重さ（置いたタイルだけ．大掃除の日なら0）＋足りない理性の段数（タイルごと）
 */
export function chipNeed(fromFlow: Tile[], fromDiscard: Tile[], x: number, amount: number, rules: Rules, bigday: boolean): number {
  const over = bigday ? 0 : Math.max(0, removeLoad(fromFlow, rules) - amount);
  const reason = Math.max(0, -x);
  const cond = rules.needs ? [...fromFlow, ...fromDiscard].reduce((n, c) => n + Math.max(0, (TILES[c.kind].dropNeed ?? 0) - reason), 0) : 0;
  return over + cond;
}

/** 捨て山から排除できる枚数（一番下の行で1枚．大容量ゴミ袋なら量の枚数を足す） */
export const discardLimit = (p: OPlayer, amount: number, deep: boolean) => (deep ? 1 : 0) + (p.perms.includes('BAG') ? amount : 0);

export function applyOverlay(s: OState, seat: number, a: OAction): void {
  if (s.phase !== 'play') throw new ORuleError('ゲームは終了しています');
  if (seat !== s.current) throw new ORuleError('あなたの手番ではありません');
  const p = s.players[seat];
  const env = envOf(s, p);
  switch (a.type) {
    case 'draw': {
      if (s.turn !== 'move') throw new ORuleError('今は引けません');
      if (!canDraw(p, s.rules)) throw new ORuleError('袋が空です．止めてください');
      if (!p.bag.length) refill(s, p);
      const tile = p.bag.pop()!;
      putTile(p, tile);
      const dirs = dirsOf(tile.kind, env);
      if (dirs.length > 1) { s.turn = 'branch'; return; }
      if (leaveTile(env, p, tile.kind, dirs[0] ?? null)) stopHere(s, p);
      return;
    }
    case 'branch': {
      if (s.turn !== 'branch') throw new ORuleError('向きを選ぶ場面ではありません');
      const tile = p.placed[p.placed.length - 1];
      if (!dirsOf(tile.kind, env).includes(a.dir)) throw new ORuleError('その向きには出られません');
      s.turn = 'move';
      if (leaveTile(env, p, tile.kind, a.dir)) stopHere(s, p);
      return;
    }
    case 'stop': {
      if (s.turn !== 'move') throw new ORuleError('今は止められません');
      if (!p.placed.length && canDraw(p, s.rules)) throw new ORuleError('少なくとも1枚引いてください');
      stopHere(s, p);
      return;
    }
    case 'resolve': {
      if (s.turn !== 'resolve') throw new ORuleError('まだ止まっていません');
      resolve(s, p, a);
      return;
    }
  }
}

function resolve(s: OState, p: OPlayer, a: { buy: OKind[]; remove: number[]; roomba?: number }): void {
  const pos = p.pos;
  const power = hereFx(s, p);
  const removedBefore = p.removed;
  if (power.kind !== 'buy' && a.buy.length) throw new ORuleError('額のマスでしか取得できません');
  let total = 0;
  const need: Partial<Record<OKind, number>> = {};
  for (const k of a.buy) {
    const cost = TILES[k]?.cost;
    if (cost == null || s.market[k] === undefined) throw new ORuleError('市場にないタイルです');
    if (isPerm(k) && (p.perms.includes(k) || a.buy.filter(x => x === k).length > 1)) throw new ORuleError('同じお気に入りは1枚まで');
    if (!canBuyAt(k, pos.x, s.rules)) throw new ORuleError(`${TILES[k].name}は衝動${TILES[k].buyNeed}以上の列でないと取得できません`);
    total += cost;
    need[k] = (need[k] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(need)) if ((s.market[k as OKind] ?? 0) < n!) throw new ORuleError(`${TILES[k as OKind].name}は売り切れです`);
  if (power.kind === 'buy' && total > power.amount) throw new ORuleError(`額${power.amount}を超えています`);

  const ids = [...new Set(a.remove)];
  const fromFlow = ids.map(id => p.placed.find(c => c.id === id)).filter(Boolean) as Tile[];
  const fromDiscard = ids.map(id => p.discard.find(c => c.id === id)).filter(Boolean) as Tile[];
  if (fromFlow.length + fromDiscard.length !== ids.length) throw new ORuleError('この手番に置いたタイルしか排除できません');
  if (fromDiscard.some(c => p.rollIds?.includes(c.id))) throw new ORuleError('運試しで表にしたタイルは排除できません');
  const deep = isDeep(pos.y, s.board);
  if (fromDiscard.length > (power.kind === 'remove' ? discardLimit(p, power.amount, deep) : 0)) throw new ORuleError('捨て山から排除できる枚数を超えています');
  let spend = 0;
  const last = s.rules.lastCard && isLastCard(p) && fromFlow.length === 1 && !fromDiscard.length;
  if (!last) {
    if (power.kind !== 'remove' && ids.length) throw new ORuleError('量のマスでしか排除できません');
    const have = s.rules.chips ? p.chips ?? 0 : 0;
    spend = chipNeed(fromFlow, fromDiscard, pos.x, power.amount, s.rules, p.perms.includes('BIGDAY'));
    if (spend > have) {
      const hard = [...fromFlow, ...fromDiscard].find(c => !canDropAt(c.kind, pos.x, s.rules));
      if (hard && !have) throw new ORuleError(`${TILES[hard.kind].name}は理性${TILES[hard.kind].dropNeed}以上の列でないと排除できません`);
      throw new ORuleError(have ? `決心チップが足りません（必要 ${spend}・所持 ${have}）` : `量${power.amount}を超えています`);
    }
  }
  if (a.roomba !== undefined && a.roomba !== null) {
    if (!p.perms.includes('ROOMBA')) throw new ORuleError('ルンバを持っていません');
    if (!p.placed.some(c => c.id === a.roomba) || ids.includes(a.roomba)) throw new ORuleError('ルンバで排除できるのは置いたタイルの1枚です');
  }

  for (const k of a.buy) {
    if (!UNLIMITED_KINDS.includes(k)) s.market[k]!--;
    if (isPerm(k)) p.perms.push(k);
    else p.discard.push({ id: s.nextId++, kind: k });
    p.bought++;
  }
  const gone = new Set(a.roomba != null ? [...ids, a.roomba] : ids);
  (p.gone ??= []).push(...[...p.placed, ...p.discard].filter(c => gone.has(c.id)).map(c => ({ id: c.id, kind: c.kind })));
  p.placed = p.placed.filter(c => !gone.has(c.id));
  p.discard = p.discard.filter(c => !gone.has(c.id));
  p.removed += gone.size;
  if (spend) p.chips -= spend;
  if (s.rules.traces && ids.length && !noTraceZone(pos) && !p.traces.some(t => samePos(t, pos))) p.traces.push({ ...pos });
  // 福袋：共有の福袋から無作為に1枚もらう（捨て山へ）
  let lucky = '';
  if (power.kind === 'gacha') {
    if (s.gacha.length) {
      const k = s.gacha.splice(Math.floor(nextRandom(s) * s.gacha.length), 1)[0];
      p.discard.push({ id: s.nextId++, kind: k });
      p.bought++;
      lucky = `福袋から「${TILES[k].name}」`;
    } else lucky = '福袋は空だった';
  }

  const parts = [`${p.name}：(${pos.x},${pos.y})で止まった`];
  if (power.kind === 'buy' || power.kind === 'remove') parts.push(`${power.kind === 'buy' ? '額' : '量'}${power.amount}`);
  if (lucky) parts.push(lucky);
  if (spend) parts.push(`決心チップ${spend}枚使用`);
  if (ids.length) parts.push(`${ids.length}枚排除`);
  if (a.buy.length) parts.push(`取得 ${a.buy.map(k => TILES[k].name).join('・')}`);
  if (a.roomba != null) parts.push('ルンバで1枚排除');
  s.log.push(parts.join(' / '));
  // 決心チップ：この手番に1枚も排除できなかったらもらう
  if (s.rules.chips && p.removed === removedBefore && ownedTiles(p).length && (p.chips ?? 0) < MAX_CHIPS) {
    p.chips = (p.chips ?? 0) + 1;
    s.log[s.log.length - 1] += ' / 決心チップ+1';
  }
  endTurn(s, p);
}

function endTurn(s: OState, p: OPlayer): void {
  // 盤のタイルを全部はがして捨て山へ
  p.discard.push(...p.placed.map(c => ({ id: c.id, kind: c.kind })));
  p.placed = [];
  p.pos = { x: 0, y: 0 };
  p.hes = 0;
  p.roll = null;
  p.rollKinds = [];
  p.rollIds = [];
  if (isDone(p) && !p.finished) {
    p.finished = true;
    s.log.push(`★ ${p.name}が片付けを終えた！`);
  }
  if (s.current + 1 >= s.players.length) {
    const done = s.players.map((q, i) => ({ q, i })).filter(x => x.q.finished);
    if (done.length) {
      const best = Math.max(...done.map(x => x.q.removed));
      let win = done.filter(x => x.q.removed === best);
      const fc = Math.max(...win.map(x => favCost(x.q)));
      win = win.filter(x => favCost(x.q) === fc);
      s.winners = win.map(x => x.i);
      s.phase = 'over';
      s.log.push(`ゲーム終了：${s.winners.map(i => s.players[i].name).join('・')}の${s.winners.length > 1 ? '共同勝利' : '勝利'}`);
      return;
    }
    if (s.round >= MAX_ROUNDS) {
      s.phase = 'over';
      s.log.push('ゲーム終了：規定ラウンドに達したため引き分け');
      return;
    }
    s.round++;
    s.current = 0;
  } else s.current++;
  s.turn = 'move';
  const q = s.players[s.current];
  if (!q.bag.length) refill(s, q);
}

/** 捨て山を袋へ戻して混ぜる */
function refill(s: OState, p: OPlayer): void {
  p.bag = p.discard;
  p.discard = [];
  shuffle(p.bag, s);
}
