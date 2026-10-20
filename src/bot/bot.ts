// ボット．Python シミュレーター（ミニマリスト_sim.py）の方針を移植したもの．
// 方針はすべて BotGenome のパラメータで決まるので，学習（training/train.ts）で調整できる．
// 山札の中身（順番）は見ない．見るのは自分の手札・場・枚数と，公開情報だけ．

import { CARDS, CardKind, MARKET_KINDS, RULE, isBranch, isDeadEnd, removeCost } from '../engine/cards';
import {
  Action, Card, GameState, PlayerState, computeReach, openCells, posKey, Pos,
} from '../engine/game';
import learnedAll from './learned.json';
import presetsJson from './presets.json';

export interface BotGenome {
  /** 買う優先順（前ほど優先）と，それぞれ何枚まで持つか */
  buy: { kind: CardKind; cap: number }[];
  /** 残したい度合い（小さいほど先に排除する） */
  keep: Partial<Record<CardKind, number>>;
  /** 所持枚数がこれ以下になったら仕上げモード（守っていたカードも消す・もう買わない） */
  finish: number;
  /** 配置の評価の重み */
  wRemove: number;
  wBuy: number;
  wDraw: number;
}

/**
 * プリセットの戦略．進化戦略で「使ってよいカード」を変えて別々に学習し，
 * 互いにほぼ互角（勝率倍率 0.83〜1.25）だった6つの系統（training/archetypes.ts）．
 */
export const PRESETS: Record<string, BotGenome> = {
  // 何も買わない（初期デッキだけで勝てるかの確認用．対戦相手には選ばない）
  nobuy: {
    buy: [], keep: { J: 0, R: 1, D: 3, RD: 4, X: 9 }, finish: 3, wRemove: 10, wBuy: 6, wDraw: 4,
  },
  ...(presetsJson as Record<string, BotGenome>),
};

export const BOT_LABELS: Record<string, string> = {
  nobuy: '買わない型',
  balanced: 'バランス型（台車・仕分け箱・ハブ・通路・紙袋）',
  engine: 'エンジン型（ハブ・台車・通路．紙袋は買わない）',
  passage: '通路型（台車・通路．ハブは買わない）',
  hub: 'ハブ型（台車・ハブ．通路は買わない）',
  bag: '紙袋型（ハブ・通路・仕分け箱・紙袋．台車は買わない）',
  light: '身軽型（通路・紙袋だけ）',
  learned: '学習済み',
  random: 'ランダム',
};

/** 学習済みの方針．キーは間取りの名前 */
const LEARNED = learnedAll as Record<string, BotGenome>;

export function learnedFor(floor: string): BotGenome | undefined {
  return LEARNED[floor] ?? LEARNED.grow;
}

export function genomeFor(botType: string | undefined, rand: () => number = Math.random, floor = 'grow'): BotGenome {
  if (botType === 'learned') {
    const g = learnedFor(floor);
    if (g) return g;
  }
  if (botType && PRESETS[botType] && botType !== 'nobuy') return PRESETS[botType];
  // 指定なし・'random'・学習データが無い：買わない型以外のプリセットからランダム
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
  // 排除すると得をするカード（フリマ・ポイントカード）は守らない
  return new Set(g.buy.filter(b => b.cap > 0 && !CARDS[b.kind].sell && !CARDS[b.kind].bonus).map(b => b.kind));
}

const xCount = (cards: Card[]) => cards.reduce((s, c) => s + CARDS[c.kind].x, 0);
/** 何手番続けて排除できていないか（行き詰まりの検出用） */
const stall = new WeakMap<PlayerState, number>();

/** 矢印のない（行き止まりになる）カードの数 */
const deadEnds = (cards: Card[]) => cards.filter(c => isDeadEnd(c.kind)).length;
/** 分岐（→と↓の両方）のカードの数 */
const branches = (cards: Card[]) => cards.filter(c => isBranch(c.kind)).length;

function wantCost(g: BotGenome, cnt: Counts, market: Record<CardKind, number>): number {
  let best = 0;
  for (const { kind, cap } of g.buy) {
    if ((cnt[kind] ?? 0) < cap && (market[kind] ?? 0) > 0) best = Math.max(best, CARDS[kind].cost);
  }
  return best;
}

function allCards(p: PlayerState): Card[] {
  return [...p.deck, ...p.discard, ...p.hand, ...Object.values(p.board)];
}

function isFinishing(g: BotGenome, p: PlayerState, market: Record<CardKind, number>): boolean {
  const all = allCards(p);
  return all.length <= g.finish || wantCost(g, countKinds(all), market) === 0;
}

// ---- 配置の計画 ----

function evaluate(
  g: BotGenome, state: GameState, p: PlayerState,
  placed: Record<string, Card>, hand: Card[], pend: number, finishing: boolean,
): number {
  const field = Object.values(placed);
  if (field.length === 0) return 0;
  const reach = computeReach(placed, state.floor);
  // 自分で消えるカードは捨欲を使わない
  const free = field.filter(c => CARDS[c.kind].selfRemove).length;
  const targets = (RULE.handRemove ? [...field, ...hand] : field).filter(c => !CARDS[c.kind].selfRemove);
  const left = RULE.handRemove ? 0 : hand.length; // 排除できずに残るカード
  const need = targets.reduce((n, c) => n + (reach.corner ? 1 : removeCost(c.kind)), 0);
  if (p.deck.length === 0 && p.discard.length === 0 && left === 0 && pend === 0 && (reach.corner || reach.remove >= need)) {
    return 1e6; // この手番で勝てる
  }
  const prot = protectedKinds(g);
  // 捨欲で消せる枚数（安いものから．goal モードの粗大ごみは無制限のときだけ）
  const costs = targets
    .filter(c => (finishing || !prot.has(c.kind)) && (reach.corner || RULE.bulky !== 'goal' || !CARDS[c.kind].bulky))
    .map(c => (reach.corner ? 1 : removeCost(c.kind)))
    .sort((a, b) => a - b);
  let rem = free, used = 0;
  for (const c of costs) { if (used + c > reach.remove) break; used += c; rem++; }
  const sell = field.reduce((n, c) => n + CARDS[c.kind].sell, 0);
  const want = wantCost(g, countKinds([...p.deck, ...p.discard, ...targets]), state.market);
  const buy = reach.buy + sell;
  return g.wRemove * rem + g.wBuy * Math.min(buy, want) + 0.1 * buy + g.wDraw * pend;
}

/** 手札だけを見て次の一手を決める（＋で引くカードは未知として扱う）．置かないなら null */
function planPlacement(g: BotGenome, state: GameState, p: PlayerState): { card: Card; pos: Pos } | null {
  const finishing = isFinishing(g, p, state.market);
  const memo = new Map<string, number>();
  const placed: Record<string, Card> = { ...p.board };

  const dfs = (hand: Card[], pend: number): { v: number; move: { card: Card; pos: Pos } | null } => {
    const key = Object.entries(placed).map(([k, c]) => k + c.kind).sort().join('|')
      + '#' + hand.map(c => c.kind).sort().join(',') + '#' + pend;
    let best = { v: evaluate(g, state, p, placed, hand, pend, finishing), move: null as { card: Card; pos: Pos } | null };
    if (memo.has(key)) return { v: memo.get(key)!, move: null };
    const seen = new Set<CardKind>();
    const opens = openCells(placed, state.floor, p.removed);
    for (const card of hand) {
      if (seen.has(card.kind)) continue;
      seen.add(card.kind);
      for (const pos of opens) {
        const k = posKey(pos);
        placed[k] = card;
        const rest = hand.filter(c => c !== card);
        const r = dfs(rest, pend + CARDS[card.kind].draw);
        delete placed[k];
        if (r.v > best.v + 1e-9) best = { v: r.v, move: { card, pos } };
      }
    }
    memo.set(key, best.v);
    return best;
  };
  return dfs([...p.hand], 0).move;
}

// ---- 手番終了（排除と購入） ----

function planEndTurn(g: BotGenome, state: GameState, p: PlayerState): Action {
  const reach = computeReach(p.board, state.floor);
  let field = (RULE.handRemove ? [...Object.values(p.board), ...p.hand] : Object.values(p.board))
    .filter(c => !CARDS[c.kind].selfRemove); // 自分で消えるカードは数えない
  const need = field.reduce((n, c) => n + (reach.corner ? 1 : removeCost(c.kind)), 0);
  const clearAll = p.deck.length === 0 && p.discard.length === 0 && (RULE.handRemove || p.hand.length === 0)
    && (reach.corner || reach.remove >= need);
  const finishing = isFinishing(g, p, state.market) || clearAll;
  const prot = protectedKinds(g);
  const order = [...field].sort((a, b) => (g.keep[a.kind] ?? 5) - (g.keep[b.kind] ?? 5));
  const remove: number[] = [];
  let points = reach.remove;
  for (const c of order) {
    const cost = reach.corner ? 1 : removeCost(c.kind);
    if (cost > points) continue;
    if (CARDS[c.kind].bulky && !reach.corner && RULE.bulky === 'goal') continue; // 無制限のときだけ
    if (!clearAll) {
      if (!finishing && prot.has(c.kind)) continue;
      // 手札を排除できないルールでは，行き止まりのカードを置く場所（分岐）を残す
      if (!RULE.handRemove && isBranch(c.kind)) {
        const owned = [...p.deck, ...p.discard, ...p.hand, ...field];
        if (deadEnds(owned) >= branches(owned)) continue;
      }
      if (CARDS[c.kind].x > 0) {
        // 最後の✕は全部消せるとき以外は残す
        const xs = xCount([...p.deck, ...p.discard, ...field]);
        if (xs - CARDS[c.kind].x < 1) continue;
      }
    }
    remove.push(c.id);
    points -= cost;
    field = field.filter(f => f !== c);
  }
  const buy: CardKind[] = [];
  const handLeft = RULE.handRemove ? [] : p.hand; // 手札は排除できずに捨札へ
  if (p.deck.length === 0 && p.discard.length === 0 && field.length === 0 && handLeft.length === 0) {
    return { type: 'endTurn', remove, buy }; // 勝利目前なら買わない
  }
  const rest = [...p.deck, ...p.discard, ...field, ...handLeft];
  const cnt = countKinds(rest);
  let list = g.buy;
  if (rest.length <= g.finish || wantCost(g, cnt, state.market) === 0) list = [];
  // 粗大ごみが残っているのに消す手段が足りないなら補う
  if (rest.some(c => CARDS[c.kind].bulky) && !rest.some(c => CARDS[c.kind].goal)) {
    const draws = rest.reduce((n, c) => n + CARDS[c.kind].draw, 0);
    const downs = rest.filter(c => CARDS[c.kind].moves.some(m => m[0] > 0)).length;
    const arrows = rest.filter(c => !isDeadEnd(c.kind)).length;
    list = [
      // goal モード：ゴミ収集車か，ゴミ捨て場まで伸ばすための＋が要る
      ...(RULE.bulky === 'goal' ? [{ kind: 'TRK' as CardKind, cap: 1 }] : []),
      ...(RULE.bulky === 'goal' && draws < 3 ? [{ kind: 'D+' as CardKind, cap: 2 }, { kind: 'R+' as CardKind, cap: 2 }] : []),
      ...list,
      // 矢印のないカード（粗大ごみ・ゴミ袋など）を全部置くには分岐が要る（手札は排除できないため）
      ...(!RULE.handRemove && deadEnds(rest) > branches(rest) + 1
        ? [{ kind: 'RD' as CardKind, cap: deadEnds(rest) - 1 }, { kind: 'RD2' as CardKind, cap: 1 }] : []),
      // 矢印のカード（特に↓）が足りなければ基本カードを買い足す（行き詰まり防止）
      ...(downs < 1 ? [{ kind: 'D' as CardKind, cap: 1 }] : []),
      ...(arrows < (RULE.bulky === 'goal' ? 4 : 2) ? [{ kind: 'R' as CardKind, cap: 2 }, { kind: 'D' as CardKind, cap: 2 }] : []),
    ];
  }
  // 行き詰まり対策：2手番続けて何も排除できていなければ，↓と分岐を買い足す
  const turns = remove.length > 0 ? 0 : (stall.get(p) ?? 0) + 1;
  stall.set(p, turns);
  if (turns >= 2) {
    list = [{ kind: 'D', cap: (cnt.D ?? 0) + 1 }, { kind: 'RD', cap: (cnt.RD ?? 0) + 1 }, ...list];
  }
  const market = { ...state.market };
  // フリマなど，排除すると物欲が増えるカード
  const sold = Object.values(p.board).filter(c => remove.includes(c.id)).reduce((n, c) => n + CARDS[c.kind].sell, 0);
  let budget = reach.buy + sold;
  for (;;) {
    const pick = list.find(b => (cnt[b.kind] ?? 0) < b.cap && CARDS[b.kind].cost <= budget && (market[b.kind] ?? 0) > 0);
    if (!pick) break;
    buy.push(pick.kind);
    cnt[pick.kind] = (cnt[pick.kind] ?? 0) + 1;
    market[pick.kind]--;
    budget -= CARDS[pick.kind].cost;
  }
  return { type: 'endTurn', remove, buy };
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
