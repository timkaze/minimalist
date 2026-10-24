// ボット（test ブランチ：レベル版）．
// 方針はすべて BotGenome のパラメータで決まるので，学習（training/train.ts）で調整できる．
// 山札の中身（順番）は見ない．見るのは自分の手札・手元・場・枚数と，公開情報だけ．

import { CARDS, CardKind, HAND_SIZE, MARKET_KINDS, RESERVE_SIZE, hasDown, hasUp } from '../engine/cards';
import {
  Action, Card, GameState, PlayerState, Pos, Target, openCells, posKey, targetsFor,
} from '../engine/game';
import type { Floor } from '../engine/floors';
import learnedAll from './learned.json';
import presetsJson from './presets.json';

export interface BotGenome {
  /** 取得する優先順（前ほど優先）と，それぞれ何枚まで持つか */
  buy: { kind: CardKind; cap: number }[];
  /** 残したい度合い（小さいほど先に排除する） */
  keep: Partial<Record<CardKind, number>>;
  /** 所持枚数がこれ以下になったら仕上げモード（守っていたカードも消す・もう取得しない） */
  finish: number;
  /** 配置の評価の重み */
  wRemove: number;
  wBuy: number;
  wDraw: number;
}

export const PRESETS: Record<string, BotGenome> = {
  // 何も取得しない（初期デッキだけで勝てるかの確認用．対戦相手には選ばない）
  nobuy: {
    buy: [], keep: { R: 1, U: 2, D: 3, J: 0 }, finish: 3, wRemove: 10, wBuy: 6, wDraw: 4,
  },
  ...(presetsJson as Record<string, BotGenome>),
};

export const BOT_LABELS: Record<string, string> = {
  nobuy: '取得しない型',
  balanced: 'バランス型',
  engine: 'エンジン型（＋で引くカードを集める）',
  branch: '分岐型（仕分け箱・棚・エレベーター）',
  rich: '高級型（レベル3を狙う）',
  light: '身軽型（取得を少なく）',
  learned: '学習済み',
  random: 'ランダム',
};

/** 学習済みの方針．キーは間取りの名前 */
const LEARNED = learnedAll as Record<string, BotGenome>;

export function learnedFor(floor: string): BotGenome | undefined {
  return LEARNED[floor] ?? LEARNED.standard;
}

export function genomeFor(botType: string | undefined, rand: () => number = Math.random, floor = 'standard'): BotGenome {
  if (botType === 'learned') {
    const g = learnedFor(floor);
    if (g) return g;
  }
  if (botType && PRESETS[botType] && botType !== 'nobuy') return PRESETS[botType];
  // 指定なし・'random'・学習データが無い：取得しない型以外のプリセットからランダム
  const keys = Object.keys(PRESETS).filter(k => k !== 'nobuy');
  return PRESETS[keys[Math.floor(rand() * keys.length)]];
}

// ---- 内部ヘルパー ----

type Counts = Partial<Record<CardKind, number>>;

function countKinds(cards: Card[]): Counts {
  const c: Counts = {};
  for (const x of cards) c[x.kind] = (c[x.kind] ?? 0) + 1;
  return c;
}

function protectedKinds(g: BotGenome): Set<CardKind> {
  return new Set(g.buy.filter(b => b.cap > 0).map(b => b.kind));
}

function allCards(p: PlayerState): Card[] {
  return [...p.deck, ...p.discard, ...p.hand, ...p.reserve, ...Object.values(p.board)];
}

function wanted(g: BotGenome, cnt: Counts, market: Record<CardKind, number>): boolean {
  return g.buy.some(({ kind, cap }) => (cnt[kind] ?? 0) < cap && (market[kind] ?? 0) > 0);
}

/** 何手番続けて取得も排除もできていないか（行き詰まりの検出用） */
const stall = new WeakMap<PlayerState, number>();
const STALL_LIMIT = 3;

function isFinishing(g: BotGenome, p: PlayerState, market: Record<CardKind, number>): boolean {
  const all = allCards(p);
  // 欲しいカードに手が届かないまま止まっていたら，取得をあきらめて仕上げに入る
  return all.length <= g.finish || !wanted(g, countKinds(all), market) || (stall.get(p) ?? 0) >= STALL_LIMIT;
}

/** 取得の計画：優先順に，レベルと支払える額の範囲で */
function planBuy(g: BotGenome, list: { kind: CardKind; cap: number }[], cnt: Counts, market: Record<CardKind, number>, t: Target): CardKind[] {
  const buy: CardKind[] = [];
  const c = { ...cnt }, m = { ...market };
  let budget = t.budget;
  for (;;) {
    const pick = list.find(b => (c[b.kind] ?? 0) < b.cap && CARDS[b.kind].cost <= budget
      && CARDS[b.kind].level <= t.level && (m[b.kind] ?? 0) > 0);
    if (!pick) break;
    buy.push(pick.kind);
    c[pick.kind] = (c[pick.kind] ?? 0) + 1;
    m[pick.kind]--;
    budget -= CARDS[pick.kind].cost;
  }
  return buy;
}

/**
 * 残りのカードを最後の1手番でまとめて消せるかの「借り」（0なら消せる見込み）．
 * →の数だけ右へ，↓の数だけ下へ進んだマスを行き先にしたと考え，
 * コストの合計が支払える額を超えた分と，レベルが足りない分と，↓がないことを数える
 */
export function finishDebt(rest: Card[], floor: Floor): number {
  if (rest.length === 0) return 0;
  const h = hardestNeeds(rest, floor);
  const rights = rest.filter(c => CARDS[c.kind].moves.some(m => m[1] > 0)).length;
  const downs = rest.filter(c => hasDown(c.kind)).length;
  if (downs === 0) return 10 + rest.length;
  const budget = floor.budgets[Math.min(rights, floor.cols - 1)];
  const level = floor.levels[Math.min(floor.startRow + downs, floor.rows - 1)];
  const cost = rest.reduce((n, c) => n + CARDS[c.kind].removeCost, 0);
  const maxLevel = Math.max(...rest.map(c => CARDS[c.kind].level));
  return Math.max(0, cost - budget) + 2 * Math.max(0, maxLevel + Math.min(0, level)) + 3 * h.deficit;
}

/**
 * 一番消しにくいカード（レベル・コストが高い）を1枚だけ消すのに必要な↓（深さ）と→（支払える額）の数と，
 * 手持ちでの不足（↓・→・1手番で置ける枚数）
 */
function hardestNeeds(rest: Card[], floor: Floor) {
  const hardest = [...rest].sort((a, b) => CARDS[b.kind].level - CARDS[a.kind].level || CARDS[b.kind].removeCost - CARDS[a.kind].removeCost)[0];
  const lv = Math.max(1, CARDS[hardest.kind].level);
  const row = floor.levels.findIndex((l, r) => r > floor.startRow && -l >= lv);
  const needDown = row < 0 ? 99 : row - floor.startRow;
  const col = floor.budgets.findIndex(b => b >= CARDS[hardest.kind].removeCost);
  const needRight = col < 0 ? 99 : col;
  // そのカード自身の矢印も並びに使える（↓1枚なら自分の↓の先で自分を消せる）
  const downs = rest.filter(c => hasDown(c.kind)).length;
  const rights = rest.filter(c => CARDS[c.kind].moves.some(m => m[1] > 0)).length;
  const draws = rest.reduce((n, c) => n + CARDS[c.kind].draw, 0);
  // ↓と→の並び＋そのカード自身を，手札＋手元＋引く枚数で置けるか
  const short = Math.max(0, needDown + needRight + 1 - (HAND_SIZE + RESERVE_SIZE + draws));
  return {
    needDown, needRight, downs, rights, short,
    deficit: Math.max(0, needDown - downs) + Math.max(0, needRight - rights) + short,
  };
}

/**
 * 排除の計画：残したい度合いの低い順に，レベルと支払える額の範囲で．
 * 仕上げ以外では，残りを最後にまとめて消しにくくなる排除（借りが増える）はしない．最後の↑も残す
 */
function planRemove(
  g: BotGenome, field: Card[], owned: Card[], t: Target, floor: Floor, finishing: boolean, clearAll: boolean,
): Card[] {
  const prot = protectedKinds(g);
  let rest = [...owned];
  const order = field.filter(c => !CARDS[c.kind].selfRemove && CARDS[c.kind].level <= -t.level)
    .sort((a, b) => (g.keep[a.kind] ?? 5) - (g.keep[b.kind] ?? 5) || CARDS[b.kind].removeCost - CARDS[a.kind].removeCost);
  const res: Card[] = [];
  let budget = t.budget;
  for (const c of order) {
    const cost = CARDS[c.kind].removeCost;
    if (cost > budget) continue;
    const after = rest.filter(x => x !== c);
    if (!clearAll) {
      if (!finishing && prot.has(c.kind)) continue;
      if (hasUp(c.kind) && !finishing && !after.some(x => hasUp(x.kind))) continue; // 最後の↑を消すと，もう上の行で取得できない
      if (finishDebt(after, floor) > finishDebt(rest, floor)) continue;
    }
    res.push(c);
    budget -= cost;
    rest = after;
  }
  return res;
}

/**
 * 取得の候補（方針の優先順に，行き詰まり対策を足す）．
 * 一番消しにくいカード（レベル・コストが高い）を消すのに，↓（深さ）と→（支払える額）が足りなければ基本カードを足す
 */
function buyList(g: BotGenome, rest: Card[], floor: Floor, finishing: boolean): { kind: CardKind; cap: number }[] {
  const cnt = countKinds(rest);
  const ups = rest.filter(c => hasUp(c.kind)).length;
  const extra: { kind: CardKind; cap: number }[] = [];
  if (rest.length) {
    // その並びを1手番で置くのに，手札＋手元＋引く枚数が足りなければ，＋で引けるカードを優先する
    const h = hardestNeeds(rest, floor);
    const add = (kinds: CardKind[]) => kinds.forEach(k => extra.push({ kind: k, cap: (cnt[k] ?? 0) + 1 }));
    if (h.downs < h.needDown && h.needDown < 99) add(h.short ? ['D+', 'D'] : ['D']);
    else if (h.rights < h.needRight && h.needRight < 99) add(h.short ? ['R+', 'R'] : ['R']);
    else if (h.short) add(['BAG', 'R+', 'D+', 'P']);
  }
  // ＋で引けるカードはレベル1以上の行でしか取得できないので，↑がなければ先に↑を取る
  const needDraw = extra.some(e => CARDS[e.kind].draw > 0);
  if ((!finishing || needDraw) && ups < 1) extra.unshift({ kind: 'U', cap: (cnt.U ?? 0) + 1 });
  return [...extra, ...(finishing ? [] : g.buy)];
}

interface Choice { target?: Target; remove: Card[]; buy: CardKind[]; v: number }

/** 場の状態から，行き先と取得・排除の一番よい組み合わせを選ぶ */
function bestChoice(
  g: BotGenome, state: GameState, p: PlayerState, placed: Record<string, Card>, unplaced: Card[], pend: number,
): Choice {
  const field = Object.values(placed);
  const owned = allCards(p);
  const finishing = isFinishing(g, p, state.market);
  const auto = field.filter(c => CARDS[c.kind].selfRemove).length;
  const removable = field.filter(c => !CARDS[c.kind].selfRemove);
  // この手番で全部消せるか（山札・捨札・手札・手元が空で，場のカードを全部消せる）
  const lastTurn = p.deck.length === 0 && p.discard.length === 0 && unplaced.length === 0 && pend === 0;
  const rest = [...p.deck, ...p.discard, ...unplaced, ...removable];
  let best: Choice = { remove: [], buy: [], v: g.wRemove * auto };
  for (const t of targetsFor(placed, state.floor)) {
    if (t.level < 0) {
      const all = lastTurn ? planRemove(g, removable, owned, t, state.floor, true, true) : [];
      if (lastTurn && all.length === removable.length) return { target: t, remove: all, buy: [], v: 1e6 };
      const rem = planRemove(g, removable, owned, t, state.floor, finishing, false);
      // 粗大ごみのような高いレベルのカードほど，消せる機会が少ないので価値を高く
      const v = g.wRemove * (auto + rem.reduce((n, c) => n + 1 + 0.5 * CARDS[c.kind].level, 0));
      if (v > best.v) best = { target: t, remove: rem, buy: [], v };
    } else if (!finishing || finishDebt(rest, state.floor) > 0) {
      // 仕上げ中は，行き詰まり対策の基本カードだけ
      const buy = planBuy(g, buyList(g, rest, state.floor, finishing), countKinds(rest), state.market, t);
      const v = g.wRemove * auto + g.wBuy * buy.reduce((n, k) => n + CARDS[k].cost, 0) + 0.1 * t.budget;
      if (v > best.v) best = { target: t, remove: [], buy, v };
    }
  }
  return best;
}

// ---- 配置の計画 ----

/** 手札と手元を見て次の一手を決める（＋で引くカードは未知として扱う）．置かないなら null */
function planPlacement(g: BotGenome, state: GameState, p: PlayerState): { card: Card; pos: Pos } | null {
  const memo = new Map<string, number>();
  const placed: Record<string, Card> = { ...p.board };

  const dfs = (hand: Card[], pend: number): { v: number; move: { card: Card; pos: Pos } | null } => {
    const key = Object.entries(placed).map(([k, c]) => k + c.kind).sort().join('|')
      + '#' + hand.map(c => c.kind).sort().join(',') + '#' + pend;
    if (memo.has(key)) return { v: memo.get(key)!, move: null };
    let best = { v: bestChoice(g, state, p, placed, hand, pend).v + g.wDraw * pend, move: null as { card: Card; pos: Pos } | null };
    const seen = new Set<CardKind>();
    const opens = openCells(placed, state.floor);
    for (const card of hand) {
      if (seen.has(card.kind)) continue;
      seen.add(card.kind);
      for (const pos of opens) {
        const k = posKey(pos);
        placed[k] = card;
        const r = dfs(hand.filter(c => c !== card), pend + CARDS[card.kind].draw);
        delete placed[k];
        if (r.v > best.v + 1e-9) best = { v: r.v, move: { card, pos } };
      }
    }
    memo.set(key, best.v);
    return best;
  };
  return dfs([...p.hand, ...p.reserve], 0).move;
}

// ---- 手番終了 ----

function planEndTurn(g: BotGenome, state: GameState, p: PlayerState): Action {
  const unplaced = [...p.reserve, ...p.hand];
  const c = bestChoice(g, state, p, p.board, unplaced, 0);
  const progress = c.remove.length > 0 || c.buy.length > 0 || Object.values(p.board).some(x => CARDS[x.kind].selfRemove);
  stall.set(p, progress ? 0 : (stall.get(p) ?? 0) + 1);
  // 手元に残す：粗大ごみ（消せる手番まで場に出さない）＞ ＋で引くカード ＞ ↓のカード
  const score = (x: Card) => (CARDS[x.kind].bulky ? 3 : CARDS[x.kind].draw > 0 ? 2 : hasDown(x.kind) ? 1 : 0);
  const keep = [...unplaced].sort((a, b) => score(b) - score(a))[0];
  return {
    type: 'endTurn',
    target: c.target?.pos,
    remove: c.remove.map(x => x.id),
    buy: c.buy,
    keep: keep && score(keep) > 0 ? keep.id : null,
  };
}

/** ボットの次のアクション．手番が終わるまで繰り返し呼ぶ */
export function botAction(state: GameState, seat: number, g: BotGenome): Action {
  const p = state.players[seat];
  const mv = planPlacement(g, state, p);
  if (mv) return { type: 'place', cardId: mv.card.id, pos: mv.pos };
  return planEndTurn(g, state, p);
}

export function isMarketKind(k: string): k is CardKind {
  return (MARKET_KINDS as string[]).includes(k);
}
