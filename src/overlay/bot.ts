// オーバーレイ版のボット．引くか止めるかは「止めたときの価値」と「引き続けたときの期待値」（2枚先まで）を比べて決める．
// 型（genome）ごとに取得の優先順が違う

import { Dir, OKind, TILES, isPerm, weightOf } from './tiles';
import {
  Env, OAction, OPlayer, OState, Tile, Walk, applyOverlay, canBuyAt, canDraw, canDropAt, chipNeed, dirsOf, discardLimit, effectAt, envOf, hereFx,
  isDeep, isLastCard, leaveTile, ownedTiles, putTile,
} from './engine';

export interface OGenome {
  /** 取得の優先順と上限枚数（持っている枚数がこれ未満なら買う） */
  buy: { kind: OKind; cap: number }[];
  /** 引き続けたときの期待値に掛ける係数（大きいほど攻める） */
  greed: number;
}

export const OPRESETS: Record<string, OGenome> = {
  light: { greed: 1.0, buy: [{ kind: 'LIGHT', cap: 2 }, { kind: 'DOWN2', cap: 1 }, { kind: 'REST', cap: 1 }, { kind: 'CALM', cap: 1 }, { kind: 'DRAG', cap: 1 }, { kind: 'DOWN', cap: 2 }] },
  rest:  { greed: 1.0, buy: [{ kind: 'CLEAN', cap: 1 }, { kind: 'REST', cap: 2 }, { kind: 'BREATH', cap: 1 }, { kind: 'DOWN', cap: 1 }] },
  fav:   { greed: 1.0, buy: [{ kind: 'BIGDAY', cap: 1 }, { kind: 'BAG', cap: 1 }, { kind: 'ROOMBA', cap: 1 }, { kind: 'KODAWARI', cap: 1 }, { kind: 'COMPASS', cap: 1 }, { kind: 'RUSH', cap: 1 }, { kind: 'REST', cap: 1 }, { kind: 'UP2', cap: 1 }, { kind: 'DOWN', cap: 2 }] },
  swing: { greed: 1.0, buy: [{ kind: 'SWING', cap: 2 }, { kind: 'MEMO', cap: 1 }, { kind: 'DOWN2', cap: 1 }, { kind: 'REST', cap: 1 }, { kind: 'DOWN', cap: 1 }] },
  mixed: { greed: 1.0, buy: [{ kind: 'DOWN2', cap: 1 }, { kind: 'REST', cap: 1 }, { kind: 'CALM', cap: 1 }, { kind: 'BR', cap: 1 }, { kind: 'TREAT', cap: 1 }, { kind: 'DOWN', cap: 2 }] },
  nobuy: { greed: 1.0, buy: [{ kind: 'DOWN', cap: 2 }] },
  // 学習AI（training/overlay-train.ts．軸ごとに買ってよいタイルを絞った共進化学習．固定型に大差で勝つ）．ランダムで登場するのはこの6つ
  aiFree: { greed: 1.40, buy: [{ kind: 'ROOMBA', cap: 1 }, { kind: 'COMPASS', cap: 1 }, { kind: 'BIGDAY', cap: 1 }, { kind: 'RUSH', cap: 2 }, { kind: 'DOWN2', cap: 3 }, { kind: 'BR', cap: 2 }, { kind: 'DRAG', cap: 2 }, { kind: 'BREATH', cap: 2 }, { kind: 'CALM', cap: 1 }, { kind: 'REST', cap: 1 }, { kind: 'BAG', cap: 1 }, { kind: 'KODAWARI', cap: 1 }] },
  aiFav: { greed: 1.42, buy: [{ kind: 'ROOMBA', cap: 1 }, { kind: 'BIGDAY', cap: 1 }, { kind: 'COMPASS', cap: 1 }, { kind: 'DOWN2', cap: 3 }, { kind: 'RUSH', cap: 3 }, { kind: 'BR', cap: 2 }, { kind: 'DOWN', cap: 1 }] },
  aiLight: { greed: 1.19, buy: [{ kind: 'LIGHT', cap: 1 }, { kind: 'DRAG', cap: 3 }, { kind: 'DOWN2', cap: 3 }, { kind: 'CALM', cap: 3 }, { kind: 'BR', cap: 1 }, { kind: 'DOWN', cap: 3 }] },
  aiClean: { greed: 1.51, buy: [{ kind: 'DOWN2', cap: 1 }, { kind: 'CALM', cap: 3 }, { kind: 'DOWN', cap: 3 }, { kind: 'CLEAN', cap: 1 }] },
  aiSwing: { greed: 1.53, buy: [{ kind: 'DOWN2', cap: 3 }, { kind: 'DOWN', cap: 3 }, { kind: 'CLEAN', cap: 1 }] },
  aiRush: { greed: 1.27, buy: [{ kind: 'CALM', cap: 1 }, { kind: 'BR', cap: 1 }, { kind: 'DOWN', cap: 3 }] },
};
export const OBOT_LABELS: Record<string, string> = {
  random: 'ランダム', light: '身軽型', rest: 'ひと休み型', fav: 'お気に入り型', swing: '往復型', mixed: 'バランス型', nobuy: '最小限型',
  aiFree: '万能AI', aiFav: 'お気に入りAI', aiLight: '身軽AI', aiClean: '大掃除AI', aiSwing: '往復AI', aiRush: '速攻AI',
};

/** 「ランダム」：ゲーム開始時に，学習済みのAI（ai〜）の中からくじで決める（学習済みが無ければ最小限型以外から） */
export const RANDOM_BOT = 'random';
export function resolveBot(t: string | undefined, rand: () => number = Math.random): string {
  if (t && t !== RANDOM_BOT && OPRESETS[t]) return t;
  const learned = Object.keys(OPRESETS).filter(k => k.startsWith('ai'));
  const pool = learned.length ? learned : Object.keys(OPRESETS).filter(k => k !== 'nobuy');
  return pool[Math.floor(rand() * pool.length)];
}

/** 先読みの深さ（今の1枚のあとに何枚先まで読むか） */
export let LOOK = 2;
export const setLook = (n: number) => { LOOK = n; };

interface Ctx { s: OState; p: OPlayer; g: OGenome; env: Env }

/** 取得：優先順に，上限まで，予算内で（貪欲） */
export function planBuy(c: Ctx, budget: number, x: number): { buy: OKind[]; value: number } {
  const owned = ownedTiles(c.p);
  const have = (k: OKind) => (isPerm(k) ? +c.p.perms.includes(k) : owned.filter(t => t.kind === k).length);
  const buy: OKind[] = [];
  let value = 0, left = budget;
  c.g.buy.forEach(({ kind, cap }, i) => {
    const cost = TILES[kind].cost ?? 99;
    let n = have(kind);
    let stock = canBuyAt(kind, x, c.s.rules) ? c.s.market[kind] ?? 0 : 0;
    while (n < cap && stock > 0 && cost <= left) {
      buy.push(kind);
      left -= cost; n++; stock--;
      value += 1.5 + (c.g.buy.length - i) * 0.3 + cost * 0.3 + (isPerm(kind) ? 3 : 0);
    }
  });
  return { buy, value };
}

/** 捨てたい順（大きいほど先に捨てる）：初期タイル > 型に無いタイル > 型のタイル */
function trashScore(c: Ctx, t: Tile): number {
  if (TILES[t.kind].cost === null) return 10 + weightOf(t.kind, c.s.rules);
  const i = c.g.buy.findIndex(b => b.kind === t.kind);
  return i < 0 ? 6 : 3 - i * 0.2;
}

/** 排除：置いたタイルから，捨てたい順に，量の範囲で */
export function planRemove(c: Ctx, flow: Tile[], amount: number, deep: boolean, xcol: number): { remove: number[]; value: number } {
  const owned = ownedTiles(c.p);
  const big = c.p.perms.includes('BIGDAY');
  const rules = c.s.rules;
  // 決心チップは，捨てたいタイル（初期タイル・型に無いタイル）にだけ使う
  const chips = rules.chips ? c.p.chips ?? 0 : 0;
  const cand = flow.filter(t => canDropAt(t.kind, xcol, rules) || (chips > 0 && trashScore(c, t) >= 5)).sort((a, b) => trashScore(c, b) - trashScore(c, a));
  const chosen: Tile[] = [];
  for (const t of cand) {
    const need = chipNeed([...chosen, t], [], xcol, amount, rules, big);
    if (need === 0 || (need <= chips && trashScore(c, t) >= 5)) chosen.push(t);
  }
  const dn = discardLimit(c.p, amount, deep);
  const ds0 = c.p.discard.filter(t => canDropAt(t.kind, xcol, rules)).length;
  // 全部片付けられるなら全部（勝ち）．そうでなければ，型のタイルは残りが少なくなるまで取っておく
  const wipe = chosen.length + Math.min(dn, ds0) >= owned.length;
  const keepCore = !wipe && owned.length - chosen.length > 4;
  let picked = chosen.filter(t => !keepCore || trashScore(c, t) >= 5 || chosen.every(y => trashScore(c, y) < 5));
  // 型のタイルしか捨てられないとき：初期タイルが残っているうちは捨てない（↓を捨てると初期タイルを捨てに行けなくなる）
  if (keepCore && picked.length === chosen.length && picked.every(t => trashScore(c, t) < 5)) picked = owned.some(t => TILES[t.kind].cost === null) ? [] : picked.slice(0, 1);
  const remove = picked.map(t => t.id);
  let value = picked.reduce((n, t) => n + 2 + Math.max(0, trashScore(c, t)) * 0.2, 0);
  const ds = c.p.discard.filter(t => canDropAt(t.kind, xcol, rules) && !c.p.rollIds?.includes(t.id)).sort((a, b) => trashScore(c, b) - trashScore(c, a)).slice(0, dn);
  for (const d of ds) { remove.push(d.id); value += 2; }
  if (remove.length >= owned.length) value += 30;
  return { remove, value };
}

function planRoomba(c: Ctx, flow: Tile[], removed: number[]): number | undefined {
  if (!c.p.perms.includes('ROOMBA')) return undefined;
  const left = flow.filter(t => !removed.includes(t.id)).sort((a, b) => trashScore(c, b) - trashScore(c, a))[0];
  if (!left) return undefined;
  const fewLeft = ownedTiles(c.p).length - removed.length <= 5;
  return trashScore(c, left) >= 5 || fewLeft ? left.id : undefined;
}

/** 今止めたときの価値 */
function stopValue(c: Ctx, w: Walk): number {
  const pw = effectAt(c.env, w.placed, w.pos);
  const rb = c.p.perms.includes('ROOMBA') && w.placed.length ? 2 : 0;
  if (pw.kind === 'buy') return planBuy(c, pw.amount, w.pos.x).value + rb;
  if (pw.kind === 'remove') return planRemove(c, w.placed, pw.amount, isDeep(w.pos.y, c.s.board), w.pos.x).value + (w.placed.length > 1 ? rb : 0);
  // 福袋：何が出るかわからないが1枚もらえる．運試し：量は 0〜袋の残り枚数（平均はその半分）
  if (pw.kind === 'gacha') return (c.s.gacha.length ? 2.2 : 0) + rb;
  if (pw.kind === 'lucky') {
    const left = Math.max(0, c.p.bag.length - (w.placed.length - c.p.placed.length));
    return planRemove(c, w.placed, Math.floor(left / 2), false, w.pos.x).value * 0.9 + (w.placed.length > 1 ? rb : 0);
  }
  return rb;
}

const cloneWalk = (w: Walk): Walk => ({ pos: { ...w.pos }, placed: [...w.placed], hes: w.hes });

/** タイルを引いた後の最善の向きと，その後の価値 */
function afterTile(c: Ctx, w: Walk, tile: Tile, rest: Tile[], depth: number, placedAlready = false): { value: number; dir: Dir | null } {
  const dirs: (Dir | null)[] = dirsOf(tile.kind, c.env);
  let best: { value: number; dir: Dir | null } = { value: -1, dir: dirs[0] ?? null };
  for (const d of dirs.length ? dirs : [null]) {
    const v = cloneWalk(w);
    if (!placedAlready) putTile(v, tile);
    const forced = leaveTile(c.env, v, tile.kind, d);
    const stay = stopValue(c, v);
    const val = forced ? stay : Math.max(stay, depth > 0 ? contValue(c, v, rest, depth - 1) : 0);
    if (val > best.value) best = { value: val, dir: d };
  }
  return best;
}

/** 引き続けたときの期待値（袋の中身は自分で数えられるので，種類ごとの確率で平均する） */
function contValue(c: Ctx, w: Walk, bag: Tile[], depth: number): number {
  if (!bag.length) return 0;
  const groups = new Map<OKind, { tile: Tile; n: number }>();
  for (const t of bag) {
    const g = groups.get(t.kind);
    if (g) g.n++; else groups.set(t.kind, { tile: t, n: 1 });
  }
  let sum = 0;
  for (const { tile, n } of groups.values()) sum += n * afterTile(c, w, tile, bag.filter(t => t !== tile), depth).value;
  return (sum / bag.length) * c.g.greed - 0.15;
}

/** 次に引く候補（袋が空なら捨て山を戻したもの） */
const nextBag = (p: OPlayer, s: OState) => (p.bag.length ? p.bag : s.rules.refill ? p.discard : []);

export function chooseOverlayAction(s: OState, g: OGenome): OAction {
  const p = s.players[s.current];
  const c: Ctx = { s, p, g, env: envOf(s, p) };
  switch (s.turn) {
    case 'branch': {
      const tile = p.placed[p.placed.length - 1];
      const r = afterTile(c, p, tile, nextBag(p, s), LOOK, true);
      return { type: 'branch', dir: r.dir ?? dirsOf(tile.kind, c.env)[0] };
    }
    case 'resolve': {
      if (s.rules.lastCard && isLastCard(p)) return { type: 'resolve', buy: [], remove: [p.placed[0].id] };
      const pw = hereFx(s, p);
      const remove = pw.kind === 'remove' ? planRemove(c, p.placed, pw.amount, isDeep(p.pos.y, s.board), p.pos.x).remove : [];
      const buy = pw.kind === 'buy' ? planBuy(c, pw.amount, p.pos.x).buy : [];
      return { type: 'resolve', buy, remove, roomba: planRoomba(c, p.placed, remove) };
    }
    case 'move': {
      if (!canDraw(p, s.rules) || (s.rules.lastCard && isLastCard(p))) return { type: 'stop' };
      if (!p.placed.length) return { type: 'draw' };
      return contValue(c, p, nextBag(p, s), LOOK) > stopValue(c, p) ? { type: 'draw' } : { type: 'stop' };
    }
  }
}

/** 手番を最後まで進める */
export function playOverlayTurn(s: OState, genomes: OGenome[]): void {
  const seat = s.current, round = s.round;
  let guard = 0;
  while (s.phase === 'play' && s.current === seat && s.round === round && guard++ < 300) {
    applyOverlay(s, seat, chooseOverlayAction(s, genomes[seat]));
  }
}
