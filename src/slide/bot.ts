// スライド版のボット．めくるか止めるかは「止めたときの価値」と「めくり続けたときの期待値」（2手先まで）を比べて決める．
// 型（genome）ごとに取得の優先順・お気に入りの扱いが違う．型が勝ち筋（身軽・滑走・お気に入り・揺り戻し）に対応する

import { DELTA, DIRS, Dir, SCARDS, SKind } from './cards';
import {
  SAction, SCard, SPlayer, SState, Walk, applyMove, applySlide, brake, blocked, canAdjust, canPeek, cellPower, choicesFor,
  moveOf, ownedCards, removeLoad, stopperCells,
} from './engine';

export interface SGenome {
  /** 取得の優先順と上限枚数（持っている枚数がこれ未満なら買う） */
  buy: { kind: SKind; cap: number }[];
  /** 愛用品を回してお気に入りにするか */
  favorite: boolean;
  /** めくり続けたときの期待値に掛ける係数（大きいほど攻める） */
  greed: number;
}

export const SPRESETS: Record<string, SGenome> = {
  light:  { favorite: false, greed: 1.0, buy: [{ kind: 'LIGHT', cap: 3 }, { kind: 'DRAG', cap: 2 }, { kind: 'DOWN2', cap: 1 }, { kind: 'DOWN', cap: 1 }] },
  slide:  { favorite: false, greed: 1.0, buy: [{ kind: 'SLIDE', cap: 2 }, { kind: 'ICE', cap: 1 }, { kind: 'STOP', cap: 1 }, { kind: 'DOWN2', cap: 1 }, { kind: 'DOWN', cap: 1 }] },
  fav:    { favorite: true,  greed: 1.0, buy: [{ kind: 'FAV', cap: 2 }, { kind: 'USED', cap: 2 }, { kind: 'DOWN2', cap: 2 }, { kind: 'DRAG', cap: 1 }, { kind: 'DOWN', cap: 1 }] },
  swing:  { favorite: false, greed: 1.0, buy: [{ kind: 'SWING', cap: 3 }, { kind: 'MEMO', cap: 2 }, { kind: 'DOWN2', cap: 1 }, { kind: 'DOWN', cap: 1 }] },
  mixed:  { favorite: false, greed: 1.0, buy: [{ kind: 'DOWN2', cap: 2 }, { kind: 'BR', cap: 1 }, { kind: 'LIGHT', cap: 1 }, { kind: 'SWING', cap: 1 }, { kind: 'DRAG', cap: 1 }] },
  nobuy:  { favorite: false, greed: 1.0, buy: [{ kind: 'DOWN', cap: 2 }] },
};
export const SBOT_LABELS: Record<string, string> = {
  light: '身軽型', slide: '滑走型', fav: 'お気に入り型', swing: '揺り戻し型', mixed: 'バランス型', nobuy: '最小限型',
};

// ---- 価値の見積もり ----

interface Ctx { s: SState; p: SPlayer; g: SGenome }

/** 取得：優先順に，上限まで，予算内で（貪欲）．価値は優先度の重み */
export function planBuy(c: Ctx, budget: number): { buy: SKind[]; value: number } {
  const owned = ownedCards(c.p);
  const have = (k: SKind) => owned.filter(x => x.kind === k).length;
  const buy: SKind[] = [];
  let value = 0, left = budget;
  c.g.buy.forEach(({ kind, cap }, i) => {
    const cost = SCARDS[kind].cost ?? 99;
    let n = have(kind);
    let stock = c.s.market[kind] ?? 0;
    while (n < cap && stock > 0 && cost <= left) {
      buy.push(kind);
      left -= cost; n++; stock--;
      value += 1.5 + (c.g.buy.length - i) * 0.3 + cost * 0.3;
    }
  });
  return { buy, value };
}

/** 捨てたい順（大きいほど先に捨てる）：初期カード > 上限を超えた・型に無いカード > 型のカード */
function trashScore(c: Ctx, card: SCard): number {
  if (card.fav) return -99;
  if (SCARDS[card.kind].cost === null) return 10 + SCARDS[card.kind].weight;
  const i = c.g.buy.findIndex(b => b.kind === card.kind);
  return i < 0 ? 6 : 3 - i * 0.2;
}

/** 排除：今日の流れから，捨てたい順に，量の範囲で．終盤は型のカードも捨てる */
export function planRemove(c: Ctx, flow: SCard[], amount: number, deep: boolean): { remove: number[]; value: number } {
  const owned = ownedCards(c.p).filter(x => !x.fav);
  const cand = flow.filter(x => !x.fav).sort((a, b) => trashScore(c, b) - trashScore(c, a));
  const chosen: SCard[] = [];
  for (const x of cand) {
    if (removeLoad([...chosen, x]) <= amount) chosen.push(x);
  }
  // 型のカードは，残りが少ない（仕上げ）か，ほかに何も捨てられないときだけ捨てる
  const keepCore = owned.length - chosen.length > 4;
  let picked = chosen.filter(x => !keepCore || trashScore(c, x) >= 5 || chosen.every(y => trashScore(c, y) < 5));
  if (keepCore && picked.length === chosen.length && picked.every(x => trashScore(c, x) < 5)) picked = picked.slice(0, 1);
  const remove = picked.map(x => x.id);
  let value = picked.reduce((n, x) => n + 2 + Math.max(0, trashScore(c, x)) * 0.2, 0);
  if (deep) {
    const d = c.p.discard.filter(x => !x.fav).sort((a, b) => trashScore(c, b) - trashScore(c, a))[0];
    if (d) { remove.push(d.id); value += 2; }
  }
  return { remove, value };
}

/** 愛用品を回すか */
function planRotate(c: Ctx, flow: SCard[]): number[] {
  if (!c.g.favorite) return [];
  const favs = ownedCards(c.p).filter(x => x.fav).length;
  return flow.filter(x => SCARDS[x.kind].rotatable && !x.fav).slice(0, Math.max(0, 3 - favs)).map(x => x.id);
}

/** 止まった位置での価値（止めた後の1マス調整は最善を選ぶ） */
function valueAt(c: Ctx, w: Walk, flow: SCard[]): number {
  const opts = [w.pos];
  if (canAdjust(w.pos.x)) for (const d of DIRS) {
    const [dx, dy] = DELTA[d];
    const q = { x: w.pos.x + dx, y: w.pos.y + dy };
    if (!blocked(w, q)) opts.push(q);
  }
  let best = 0;
  for (const pos of opts) {
    const pw = cellPower(pos);
    let v = 0;
    if (pw.kind === 'buy') v = planBuy(c, pw.amount).value + planRotate(c, flow).length * 3;
    if (pw.kind === 'remove') v = planRemove(c, flow, pw.amount, pos.y <= -4).value;
    best = Math.max(best, v);
  }
  return best;
}

const cloneWalk = (w: Walk): Walk => ({ pos: { ...w.pos }, lastDir: w.lastDir, blocks: w.blocks.map(b => ({ ...b })), trail: [] });

function stopValue(c: Ctx, w: Walk, flow: SCard[]): number {
  const v = cloneWalk(w);
  brake(v);
  return valueAt(c, v, flow);
}

/** カードをめくった後の最善の選択（向き・積み木）と，その後の価値 */
function afterCard(c: Ctx, w: Walk, flow: SCard[], card: SCard, deck: SCard[], depth: number): { value: number; dir?: Dir; cell?: { x: number; y: number } | null } {
  const m = moveOf(card);
  const nflow = [...flow, card];
  const evalW = (v: Walk, forced: boolean) => forced ? stopValue(c, v, nflow) : Math.max(stopValue(c, v, nflow), depth > 0 ? contValue(c, v, nflow, deck, depth - 1) : 0);
  const dirs = choicesFor(card, w);
  if (dirs.length) {
    let best = { value: -1, dir: dirs[0] as Dir | undefined };
    for (const d of dirs) {
      const v = cloneWalk(w);
      const forced = applyMove(card, v, c.p.removed, d);
      const val = evalW(v, forced);
      if (val > best.value) best = { value: val, dir: d };
    }
    return best;
  }
  if (m.t === 'stopper') {
    const cells = stopperCells(w);
    let best: { value: number; cell: { x: number; y: number } | null } = { value: evalW(cloneWalk(w), false), cell: null };
    for (const cell of cells) {
      const v = cloneWalk(w);
      applyMove(card, v, c.p.removed, undefined, cell);
      const val = evalW(v, false) + 0.05; // 同じなら置いておく
      if (val > best.value) best = { value: val, cell };
    }
    return best;
  }
  const v = cloneWalk(w);
  const forced = applyMove(card, v, c.p.removed);
  return { value: evalW(v, forced) };
}

/** めくり続けたときの期待値（山札の中身は自分で数えられるので，種類ごとの確率で平均する） */
function contValue(c: Ctx, w: Walk, flow: SCard[], deck: SCard[], depth: number): number {
  if (!deck.length) return 0;
  const groups = new Map<string, { card: SCard; n: number }>();
  for (const x of deck) {
    const key = `${x.kind}${x.fav ? '*' : ''}`;
    const g = groups.get(key);
    if (g) g.n++; else groups.set(key, { card: x, n: 1 });
  }
  let sum = 0;
  for (const { card, n } of groups.values()) {
    const rest = deck.filter(x => x !== card);
    sum += n * afterCard(c, w, flow, card, rest, depth).value;
  }
  return (sum / deck.length) * c.g.greed - 0.15;
}

/** 今の場面での行動を1つ選ぶ */
export function chooseSlideAction(s: SState, g: SGenome): SAction {
  const p = s.players[s.current];
  const c: Ctx = { s, p, g };
  const w = p.walk;
  const card = p.flow[p.flow.length - 1];
  switch (s.turn) {
    case 'branch': return { type: 'branch', dir: afterCard(c, w, p.flow.slice(0, -1), card, p.deck, 1).dir ?? choicesFor(card, w)[0] };
    case 'stopper': {
      const r = afterCard(c, w, p.flow.slice(0, -1), card, p.deck, 1);
      return { type: 'stopper', cell: r.cell ?? null };
    }
    case 'adjust': {
      let best: { v: number; dir: Dir | null } = { v: valueAt(c, { ...w, pos: w.pos }, p.flow) - 0.01, dir: null };
      for (const d of DIRS) {
        const [dx, dy] = DELTA[d];
        const q = { x: w.pos.x + dx, y: w.pos.y + dy };
        if (blocked(w, q)) continue;
        const pw = cellPower(q);
        const v = pw.kind === 'buy' ? planBuy(c, pw.amount).value : pw.kind === 'remove' ? planRemove(c, p.flow, pw.amount, q.y <= -4).value : 0;
        if (v > best.v) best = { v, dir: d };
      }
      return { type: 'adjust', dir: best.dir };
    }
    case 'resolve': {
      const pw = cellPower(w.pos);
      if (pw.kind === 'buy') return { type: 'resolve', buy: planBuy(c, pw.amount).buy, remove: [], rotate: planRotate(c, p.flow) };
      if (pw.kind === 'remove') return { type: 'resolve', buy: [], remove: planRemove(c, p.flow, pw.amount, w.pos.y <= -4).remove, rotate: [] };
      return { type: 'resolve', buy: [], remove: [], rotate: [] };
    }
    case 'move': {
      if (!p.deck.length) return { type: 'stop' };
      if (!p.flow.length) return { type: 'flip' }; // 毎手番，少なくとも1枚めくる
      const stopV = stopValue(c, w, p.flow);
      // 理性3では次の1枚が見える
      const contV = canPeek(w.pos.x)
        ? afterCard(c, w, p.flow, p.deck[p.deck.length - 1], p.deck.slice(0, -1), 1).value
        : contValue(c, w, p.flow, p.deck, 1);
      return contV > stopV ? { type: 'flip' } : { type: 'stop' };
    }
  }
}

/** 手番を最後まで進める */
export function playSlideTurn(s: SState, genomes: SGenome[]): void {
  const seat = s.current, round = s.round;
  let guard = 0;
  while (s.phase === 'play' && s.current === seat && s.round === round && guard++ < 200) {
    applySlide(s, seat, chooseSlideAction(s, genomes[seat]));
  }
}
