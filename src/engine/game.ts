// ミニマリストのルールエンジン（test ブランチ：レベル版）．純粋なデータ（JSON化できる状態）と，それを更新する関数だけで構成する．
// ブラウザ（オフライン対戦）・Cloudflare の Durable Object（オンライン対戦）・学習スクリプトで共有する．
//
// 手番：手札（3枚）と手元のカードを，矢印の先のマスに置いていく → 置いたカードの矢印の先から「行き先」を1つ選ぶ
//   行き先のレベルが0以上：そのレベル以下のカードを，列の値（支払える額）の範囲で取得する（レベル0なら基本カードだけ）
//   行き先のレベルが−：その絶対値以下のレベルの場のカードを，列の値の範囲で排除する（排除コストを払う）
//   最後に，置かなかったカードのうち1枚を手元に残せる．残りは捨札へ

import {
  CARDS, CardKind, Deck, HAND_SIZE, MARKET_KINDS, MAX_ROUNDS, RESERVE_SIZE, STARTING_DECK, UNLIMITED, UNLIMITED_KINDS,
} from './cards';
import { DEFAULT_FLOOR, FLOORS, Floor, FloorSpec, floorFromSpec, isWall } from './floors';
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
  /** 手元（次の手番以降に使うために残したカード） */
  reserve: Card[];
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
  /** 手番中の巻き戻し用：置く前の手札・手元・場（引いたら空にする） */
  undo?: string[];
}

export type Action =
  | { type: 'place'; cardId: number; pos: Pos }
  /** 直前に置いたカードを戻す（引くカードを置いた後は，それより前に戻れない） */
  | { type: 'undo' }
  | {
    type: 'endTurn';
    /** 行き先（取得・排除をするとき必要） */
    target?: Pos;
    remove: number[];
    buy: CardKind[];
    /** 手元に残すカード（置かなかったカードの id）．省略：今の手元をそのまま残す．null：何も残さない */
    keep?: number | null;
  };

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
      deck, discard: [], hand: [], reserve: [], board: {}, removed: 0, bought: 0, finished: false, nextNo,
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

/** 自分が持っているカードの総数（山札＋捨札＋手札＋手元＋場） */
export function ownedCount(p: PlayerState): number {
  return p.deck.length + p.discard.length + p.hand.length + p.reserve.length + Object.keys(p.board).length;
}

const inside = (floor: Floor, [r, c]: Pos) => r >= 0 && c >= 0 && r < floor.rows && c < floor.cols && !isWall(floor, `${r},${c}`);

/** スタート（枠外）と置いたカードの矢印の先のマス（枠の中・柱でない．カードが置かれていてもよい） */
function arrowTips(board: Record<string, Card>, floor: Floor): Pos[] {
  const res = new Map<string, Pos>();
  const start: Pos = [floor.startRow, 0];
  if (inside(floor, start)) res.set(posKey(start), start);
  for (const [k, c] of Object.entries(board)) {
    const [r, col] = parseKey(k);
    for (const [dr, dc] of CARDS[c.kind].moves) {
      const p: Pos = [r + dr, col + dc];
      if (inside(floor, p)) res.set(posKey(p), p);
    }
  }
  return [...res.values()];
}

/** カードを置けるマス：スタート（枠外）の→の先と，置いたカードの矢印の先のうち，空いているマス */
export function openCells(board: Record<string, Card>, floor: Floor): Pos[] {
  return arrowTips(board, floor).filter(p => !(posKey(p) in board));
}

export interface Target { pos: Pos; level: number; budget: number }

/** 行き先に選べるマス（スタートと置いたカードの矢印の先）と，そのレベル・支払える額 */
export function targetsFor(board: Record<string, Card>, floor: Floor): Target[] {
  return arrowTips(board, floor).map(pos => ({ pos, level: floor.levels[pos[0]], budget: floor.budgets[pos[1]] }));
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
    const { hand, reserve, board } = JSON.parse(snap) as { hand: Card[]; reserve: Card[]; board: Record<string, Card> };
    p.hand = hand;
    p.reserve = reserve;
    p.board = board;
    return;
  }
  if (action.type === 'place') {
    const from = p.hand.some(c => c.id === action.cardId) ? p.hand : p.reserve.some(c => c.id === action.cardId) ? p.reserve : null;
    if (!from) throw new RuleError('そのカードは手札にも手元にもありません');
    const key = posKey(action.pos);
    if (!openCells(p.board, state.floor).some(o => posKey(o) === key)) throw new RuleError('そのマスには置けません');
    const idx = from.findIndex(c => c.id === action.cardId);
    const def = CARDS[from[idx].kind];
    // 引くカードは山札（非公開）に触れるので，置いたらそこより前には戻れない
    if (def.draw > 0) state.undo = [];
    else (state.undo ??= []).push(JSON.stringify({ hand: p.hand, reserve: p.reserve, board: p.board }));
    const [card] = from.splice(idx, 1);
    p.board[key] = card;
    if (def.draw > 0) {
      const n = drawCards(state, p, def.draw);
      state.log.push(`${p.name}：${def.name}を置いて${n}枚引いた`);
    }
    return;
  }

  // ---- 手番終了：行き先で取得か排除 → 手元に残す → 片付け ----
  const boardCards = Object.values(p.board);
  const auto = boardCards.filter(c => CARDS[c.kind].selfRemove);
  const removeIds = [...new Set(action.remove)].filter(id => !auto.some(c => c.id === id));
  let target: Target | undefined;
  if (removeIds.length || action.buy.length) {
    if (!action.target) throw new RuleError('行き先を選んでください');
    target = targetsFor(p.board, state.floor).find(t => posKey(t.pos) === posKey(action.target!));
    if (!target) throw new RuleError('そのマスは行き先に選べません（スタートか置いたカードの矢印の先だけ）');
  }
  const removeCards = removeIds.map(id => {
    const c = boardCards.find(b => b.id === id);
    if (!c) throw new RuleError('場に置いたカードしか排除できません');
    return c;
  });
  if (removeCards.length) {
    if (target!.level >= 0) throw new RuleError('排除できるのは，レベルが−の行を行き先にしたときだけです');
    const too = removeCards.find(c => CARDS[c.kind].level > -target!.level);
    if (too) throw new RuleError(`${CARDS[too.kind].name}（レベル${CARDS[too.kind].level}）は，レベル−${CARDS[too.kind].level}以下の行でしか排除できません`);
    const cost = removeCards.reduce((n, c) => n + CARDS[c.kind].removeCost, 0);
    if (cost > target!.budget) throw new RuleError(`排除コストの合計${cost}が，支払える額${target!.budget}を超えています`);
  }
  if (action.buy.length) {
    if (target!.level < 0) throw new RuleError('取得できるのは，レベルが0以上の行を行き先にしたときだけです');
    const need: Partial<Record<CardKind, number>> = {};
    let total = 0;
    for (const k of action.buy) {
      if (!state.marketKinds.includes(k)) throw new RuleError('市場にないカードです');
      if (CARDS[k].level > target!.level) throw new RuleError(`${CARDS[k].name}（レベル${CARDS[k].level}）は，レベル${CARDS[k].level}以上の行でしか取得できません`);
      need[k] = (need[k] ?? 0) + 1;
      total += CARDS[k].cost;
    }
    for (const [k, n] of Object.entries(need)) {
      if (state.market[k as CardKind] < n!) throw new RuleError(`${CARDS[k as CardKind].name}は売り切れです`);
    }
    if (total > target!.budget) throw new RuleError(`コストの合計${total}が，支払える額${target!.budget}を超えています`);
  }
  // 手元に残すカード
  const unplaced = [...p.reserve, ...p.hand];
  let keep: Card[];
  if (action.keep === undefined) keep = p.reserve.slice(0, RESERVE_SIZE);
  else if (action.keep === null) keep = [];
  else {
    const c = unplaced.find(x => x.id === action.keep);
    if (!c) throw new RuleError('手元に残せるのは，置かなかったカードだけです');
    keep = [c];
  }

  const removeSet = new Set([...removeCards, ...auto].map(c => c.id));
  p.removed += removeSet.size;
  for (const k of action.buy) {
    if (!UNLIMITED_KINDS.includes(k)) state.market[k]--;
    p.nextNo ??= state.nextCardId; // 番号を持たない古い状態では id を番号の代わりにしている
    p.discard.push({ id: state.nextCardId++, kind: k, no: p.nextNo++ });
    p.bought++;
  }
  p.discard.push(...boardCards.filter(c => !removeSet.has(c.id)), ...unplaced.filter(c => !keep.includes(c)));
  p.reserve = keep;
  p.board = {};
  p.hand = [];
  state.undo = [];
  const parts = [`${p.name}：`];
  if (target) parts.push(`行き先 レベル${target.level > 0 ? '+' : ''}${target.level}・支払い${target.budget}`);
  if (removeSet.size) parts.push(`${removeSet.size}枚排除`);
  if (action.buy.length) parts.push(`取得 ${action.buy.map(k => CARDS[k].name).join('・')}`);
  if (!target && !removeSet.size) parts.push('取得・排除なし');
  state.log.push(parts.join(' / ').replace('： / ', '：'));
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
      // 同じラウンドに複数が達成したら，排除した枚数が多い人の勝ち．同じなら共同勝利
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

export type CardPlace = 'hand' | 'reserve' | 'board' | 'deck' | 'discard';
export interface OwnedCard { no: number; kind: CardKind; where: CardPlace }

export interface PlayerView {
  name: string;
  isBot: boolean;
  botType?: string;
  board: Record<string, Card>;
  handCount: number;
  reserveCount: number;
  deckCount: number;
  discardCount: number;
  removed: number;
  bought: number;
  owned: number;
  finished: boolean;
  /** 本人だけに見える */
  hand?: Card[];
  reserve?: Card[];
  /** 本人だけに見える：持っているカードの内訳 */
  composition?: Partial<Record<CardKind, number>>;
  /** 本人だけに見える：持っているカード（カードナンバー順．山札の順番はわからない） */
  cards?: OwnedCard[];
}

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
        handCount: p.hand.length, reserveCount: p.reserve.length, deckCount: p.deck.length, discardCount: p.discard.length,
        removed: p.removed, bought: p.bought, owned: ownedCount(p), finished: p.finished,
      };
      if (i === you) {
        v.hand = [...p.hand];
        v.reserve = [...p.reserve];
        const where: [Card[], CardPlace][] = [
          [p.hand, 'hand'], [p.reserve, 'reserve'], [Object.values(p.board), 'board'], [p.deck, 'deck'], [p.discard, 'discard'],
        ];
        const comp: Partial<Record<CardKind, number>> = {};
        for (const [cs] of where) for (const c of cs) comp[c.kind] = (comp[c.kind] ?? 0) + 1;
        v.composition = comp;
        v.cards = where.flatMap(([cs, w]) => cs.map(c => ({ no: c.no ?? c.id, kind: c.kind, where: w })))
          .sort((a, b) => a.no - b.no);
      }
      return v;
    }),
  };
}
