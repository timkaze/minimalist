// ミニマリストのルールエンジン．純粋なデータ（JSON化できる状態）と，それを更新する関数だけで構成する．
// ブラウザ（オフライン対戦）・Cloudflare の Durable Object（オンライン対戦）・学習スクリプトで共有する．

import {
  CARDS, CardKind, Deck, HAND_SIZE, MARKET_KINDS, MAX_ROUNDS, RULE, STARTING_DECK, UNLIMITED, UNLIMITED_KINDS, removeCost,
} from './cards';
import { DEFAULT_FLOOR, FLOORS, Floor, FloorSpec, cellState, colValue, floorFromSpec, rowValue } from './floors';
import { shuffle } from './rng';

/** id は全体で通し番号（内部用）．no はプレイヤーごとのカードナンバー（初期デッキを並べた順・買った順に振る） */
export interface Card { id: number; kind: CardKind; no?: number }
export type Pos = [number, number];

export interface PlayerState {
  name: string;
  isBot: boolean;
  /** ボットの種類（bot/presets.ts のキー，または 'learned'） */
  botType?: string;
  deck: Card[];
  discard: Card[];
  hand: Card[];
  /** 場．キーは "行,列" */
  board: Record<string, Card>;
  removed: number;
  bought: number;
  finished: boolean;
  /** 次に振るカードナンバー */
  nextNo?: number;
}

export type Phase = 'play' | 'over';

export interface GameState {
  rows: number;
  cols: number;
  /** 個人ボードの間取り（全員共通） */
  floor: Floor;
  /** 市場に並ぶカードの種類 */
  marketKinds: CardKind[];
  rng: number;
  players: PlayerState[];
  market: Record<CardKind, number>;
  current: number;
  round: number;
  phase: Phase;
  winners: number[];
  log: string[];
  nextCardId: number;
  /** 手番中の巻き戻し用：置く前の手札と場（引く前までしか戻れないので，引いたら空にする） */
  undo?: string[];
}

export type Action =
  | { type: 'place'; cardId: number; pos: Pos }
  /** 直前に置いたカードを手札に戻す（引くカードを置いた後は，それより前に戻れない） */
  | { type: 'undo' }
  | { type: 'endTurn'; remove: number[]; buy: CardKind[] };

export interface PlayerSetup { name: string; isBot?: boolean; botType?: string }

export const posKey = (p: Pos) => `${p[0]},${p[1]}`;
export const parseKey = (k: string): Pos => k.split(',').map(Number) as Pos;

export interface GameOptions {
  /** 間取り（floors.ts のキー） */
  floor?: string;
  /** カスタムの間取り（あれば floor より優先） */
  custom?: FloorSpec;
  /** 実験用：初期デッキ・市場の上書き */
  deck?: Deck;
  market?: CardKind[];
}

export function newGame(setup: PlayerSetup[], seed: number, opts: GameOptions = {}): GameState {
  if (setup.length < 1 || setup.length > 6) throw new Error('人数は1〜6人');
  const floor = opts.custom ? floorFromSpec(opts.custom) : FLOORS[opts.floor ?? DEFAULT_FLOOR] ?? FLOORS[DEFAULT_FLOOR];
  const startingDeck = opts.deck ?? STARTING_DECK;
  const marketKinds = opts.market ?? MARKET_KINDS;
  const state: GameState = {
    rows: floor.rows,
    cols: floor.cols,
    floor,
    marketKinds: [...marketKinds],
    rng: seed,
    players: [],
    market: {} as Record<CardKind, number>,
    current: 0,
    round: 1,
    phase: 'play',
    winners: [],
    log: [],
    nextCardId: 1,
  };
  // 市場：各種類を人数と同じ枚数（1人プレイでも2枚）
  for (const k of marketKinds) state.market[k] = UNLIMITED_KINDS.includes(k) ? UNLIMITED : Math.max(2, setup.length);
  for (const s of setup) {
    const deck: Card[] = [];
    // カードナンバーは混ぜる前に振る（山札の順番はわからない）
    for (const { kind, count } of startingDeck) {
      for (let i = 0; i < count; i++) deck.push({ id: state.nextCardId++, kind, no: deck.length + 1 });
    }
    const nextNo = deck.length + 1;
    shuffle(deck, state);
    state.players.push({
      name: s.name, isBot: !!s.isBot, botType: s.botType,
      deck, discard: [], hand: [], board: {}, removed: 0, bought: 0, finished: false, nextNo,
    });
  }
  drawCards(state, state.players[0], HAND_SIZE);
  state.log.push(`ラウンド1開始．${state.players[0].name}の手番`);
  return state;
}

export function drawCards(state: GameState, p: PlayerState, n: number): number {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (p.deck.length === 0) {
      if (p.discard.length === 0) break;
      p.deck = p.discard;
      p.discard = [];
      shuffle(p.deck, state);
    }
    p.hand.push(p.deck.pop()!);
    drawn++;
  }
  return drawn;
}

/** 自分が持っているカードの総数（山札＋捨札＋手札＋場） */
export function ownedCount(p: PlayerState): number {
  return p.deck.length + p.discard.length + p.hand.length + Object.keys(p.board).length;
}

/** カードを置けるマス（スタートマス(0,0)は→を持つ）．柱と，まだ開いていない段ボールのマスには置けない */
export function openCells(board: Record<string, Card>, floor: Floor, removed: number): Pos[] {
  const { rows, cols } = floor;
  const res = new Map<string, Pos>();
  const sources: { pos: Pos; moves: [number, number][]; cutter: boolean }[] = [{ pos: [0, 0], moves: [[0, 1]], cutter: false }];
  for (const [k, c] of Object.entries(board)) {
    const def = CARDS[c.kind];
    sources.push({ pos: parseKey(k), moves: def.moves, cutter: def.cutter });
  }
  for (const s of sources) {
    const [r, c] = s.pos;
    for (const [dr, dc] of s.moves) {
      const p: Pos = [r + dr, c + dc];
      const k = posKey(p);
      if (p[0] >= rows || p[1] >= cols || k in board) continue;
      const st = cellState(floor, k, removed);
      if (st === 'open' || (st === 'locked' && s.cutter)) res.set(k, p);
    }
  }
  return [...res.values()];
}

export interface Reach { buy: number; remove: number; corner: boolean }

/** 物欲＝右への到達距離，捨欲＝下への到達距離＋✕の数．ゴミ捨て場に置いたら捨欲は無制限 */
export function computeReach(board: Record<string, Card>, floor: Floor): Reach {
  let buy = 0, down = 0, x = 0, portableGoal = false;
  for (const [k, c] of Object.entries(board)) {
    const [r, col] = parseKey(k);
    buy = Math.max(buy, colValue(floor, col));
    down = Math.max(down, rowValue(floor, r));
    x += CARDS[c.kind].x;
    if (CARDS[c.kind].goal) portableGoal = true;
  }
  const corner = floor.goal in board || portableGoal;
  return { buy, remove: corner ? Infinity : down + x, corner };
}

export class RuleError extends Error {}

/** アクションを検証して適用する．不正なら RuleError を投げ，状態は変更しない */
export function applyAction(state: GameState, seat: number, action: Action): void {
  if (state.phase !== 'play') throw new RuleError('ゲームは終了しています');
  if (seat !== state.current) throw new RuleError('あなたの手番ではありません');
  const p = state.players[seat];
  if (action.type === 'undo') {
    const snap = state.undo?.pop();
    if (!snap) throw new RuleError('これ以上戻せません（カードを引いた後は戻せません）');
    const { hand, board } = JSON.parse(snap) as { hand: Card[]; board: Record<string, Card> };
    p.hand = hand;
    p.board = board;
    return;
  }
  if (action.type === 'place') {
    const idx = p.hand.findIndex(c => c.id === action.cardId);
    if (idx < 0) throw new RuleError('そのカードは手札にありません');
    const key = posKey(action.pos);
    if (!openCells(p.board, state.floor, p.removed).some(o => posKey(o) === key)) {
      throw new RuleError('そのマスには置けません');
    }
    const def = CARDS[p.hand[idx].kind];
    // 引くカードは山札（非公開）に触れるので，置いたらそこより前には戻れない
    if (def.draw > 0) state.undo = [];
    else (state.undo ??= []).push(JSON.stringify({ hand: p.hand, board: p.board }));
    const [card] = p.hand.splice(idx, 1);
    p.board[key] = card;
    if (def.draw > 0) {
      const n = drawCards(state, p, def.draw);
      state.log.push(`${p.name}：${def.name}を置いて${n}枚引いた`);
    }
    return;
  }
  // 手番終了：排除→購入→片付け
  const reach = computeReach(p.board, state.floor);
  const removable = new Map<number, 'board' | 'hand'>();
  for (const c of Object.values(p.board)) removable.set(c.id, 'board');
  if (RULE.handRemove) for (const c of p.hand) removable.set(c.id, 'hand');
  // 自分で消えるカード（紙袋など）は捨欲を使わずに排除する
  const auto = Object.values(p.board).filter(c => CARDS[c.kind].selfRemove).map(c => c.id);
  const removeIds = [...new Set(action.remove)].filter(id => !auto.includes(id));
  if (removeIds.some(id => !removable.has(id))) throw new RuleError(RULE.handRemove ? '場と手札のカードしか排除できません' : '場に置いたカードしか排除できません');
  const removeKinds = removeIds.map(id => [...Object.values(p.board), ...p.hand].find(c => c.id === id)!.kind);
  const points = removeKinds.reduce((n, k) => n + removeCost(k), 0);
  if (points > reach.remove) {
    throw new RuleError(`捨欲${reach.remove}を超えています${RULE.bulky === 'double' ? '（粗大ごみは2つ分）' : ''}`);
  }
  if (!reach.corner && RULE.bulky === 'goal' && removeKinds.some(k => CARDS[k].bulky)) {
    throw new RuleError('粗大ごみは，ゴミ捨て場に置いたときしか排除できません');
  }
  const need: Partial<Record<CardKind, number>> = {};
  let total = 0;
  for (const k of action.buy) {
    if (!state.marketKinds.includes(k)) throw new RuleError('市場にないカードです');
    need[k] = (need[k] ?? 0) + 1;
    total += CARDS[k].cost;
  }
  for (const [k, n] of Object.entries(need)) {
    if (state.market[k as CardKind] < n!) throw new RuleError(`${CARDS[k as CardKind].name}は売り切れです`);
  }
  const sold = removeKinds.reduce((n, k) => n + CARDS[k].sell, 0);
  if (total > reach.buy + sold) throw new RuleError(`物欲${reach.buy + sold}を超えています`);

  const removeSet = new Set([...removeIds, ...auto]);
  const allRemoved = [...removeSet].map(id => Object.values(p.board).find(c => c.id === id) ?? p.hand.find(c => c.id === id)!);
  const rest = [...Object.values(p.board), ...p.hand].filter(c => !removeSet.has(c.id));
  p.removed += allRemoved.reduce((n, c) => n + 1 + CARDS[c.kind].bonus, 0);
  for (const k of action.buy) {
    if (!UNLIMITED_KINDS.includes(k)) state.market[k]--;
    p.nextNo ??= state.nextCardId; // 番号を持たない古い状態では id を番号の代わりにしている
    p.discard.push({ id: state.nextCardId++, kind: k, no: p.nextNo++ });
    p.bought++;
  }
  p.discard.push(...rest);
  p.board = {};
  p.hand = [];
  state.undo = [];
  const parts = [`${p.name}：物欲${reach.buy}・捨欲${reach.corner ? '無制限' : reach.remove}`];
  if (removeSet.size) parts.push(`${removeSet.size}枚排除`);
  if (action.buy.length) parts.push(`購入 ${action.buy.map(k => CARDS[k].name).join('・')}`);
  state.log.push(parts.join(' / '));
  if (ownedCount(p) === 0 && !p.finished) {
    p.finished = true;
    state.log.push(`★ ${p.name}がすべてのカードを排除した！`);
  }
  advance(state);
}

function advance(state: GameState): void {
  if (state.current + 1 >= state.players.length) {
    // ラウンド終了：達成者がいれば決着（current は最後に手番だった人のまま）
    const done = state.players.map((p, i) => ({ p, i })).filter(x => x.p.finished);
    if (done.length > 0) {
      const best = Math.max(...done.map(x => x.p.removed));
      state.winners = done.filter(x => x.p.removed === best).map(x => x.i);
      state.phase = 'over';
      const names = state.winners.map(i => state.players[i].name).join('・');
      state.log.push(state.winners.length > 1 ? `ゲーム終了：${names}の共同勝利` : `ゲーム終了：${names}の勝利`);
      return;
    }
    if (state.round >= MAX_ROUNDS) {
      state.phase = 'over';
      state.log.push('ゲーム終了：規定ラウンドに達したため引き分け');
      return;
    }
    state.round++;
    state.current = 0;
    state.log.push(`ラウンド${state.round}開始`);
  } else {
    state.current++;
  }
  const next = state.players[state.current];
  drawCards(state, next, HAND_SIZE);
}

// ---- 公開情報（各プレイヤーに送る表示用データ） ----

export interface PlayerView {
  name: string;
  isBot: boolean;
  botType?: string;
  board: Record<string, Card>;
  handCount: number;
  deckCount: number;
  discardCount: number;
  removed: number;
  bought: number;
  owned: number;
  finished: boolean;
  /** 本人だけに見える */
  hand?: Card[];
  /** 本人だけに見える：持っているカードの内訳 */
  composition?: Partial<Record<CardKind, number>>;
  /** 本人だけに見える：持っているカード（カードナンバー順．山札の順番はわからない） */
  cards?: OwnedCard[];
}

export type CardPlace = 'hand' | 'board' | 'deck' | 'discard';
export interface OwnedCard { no: number; kind: CardKind; where: CardPlace }

export interface GameView {
  rows: number;
  cols: number;
  floor: Floor;
  marketKinds: CardKind[];
  players: PlayerView[];
  market: Record<CardKind, number>;
  current: number;
  round: number;
  phase: Phase;
  winners: number[];
  log: string[];
  you: number;
  /** 手番の人が戻せる手数 */
  undoCount: number;
}

export function viewFor(state: GameState, you: number): GameView {
  return {
    rows: state.rows,
    cols: state.cols,
    floor: state.floor,
    marketKinds: [...state.marketKinds],
    market: { ...state.market },
    current: state.current,
    round: state.round,
    phase: state.phase,
    winners: [...state.winners],
    log: state.log.slice(-60),
    you,
    undoCount: state.undo?.length ?? 0,
    players: state.players.map((p, i) => {
      const v: PlayerView = {
        name: p.name, isBot: p.isBot, botType: p.botType,
        board: { ...p.board },
        handCount: p.hand.length, deckCount: p.deck.length, discardCount: p.discard.length,
        removed: p.removed, bought: p.bought, owned: ownedCount(p), finished: p.finished,
      };
      if (i === you) {
        v.hand = [...p.hand];
        const comp: Partial<Record<CardKind, number>> = {};
        for (const c of [...p.deck, ...p.discard, ...p.hand, ...Object.values(p.board)]) {
          comp[c.kind] = (comp[c.kind] ?? 0) + 1;
        }
        v.composition = comp;
        const where: [Card[], CardPlace][] = [[p.hand, 'hand'], [Object.values(p.board), 'board'], [p.deck, 'deck'], [p.discard, 'discard']];
        v.cards = where.flatMap(([cs, w]) => cs.map(c => ({ no: c.no ?? c.id, kind: c.kind, where: w })))
          .sort((a, b) => a.no - b.no);
      }
      return v;
    }),
  };
}
