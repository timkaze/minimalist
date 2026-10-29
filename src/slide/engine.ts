// スライド版のルール．仕様：Memories/01_BoardGames/ミニマリスト_スライド版_仕様.md
//   盤：横 x = −3（理性3）〜3（衝動3），縦 y = 3（物欲3）〜 −4（捨欲3）．毎手番 (0,0) から始める
//   手番：めくる（コマが動く）か止めるかを繰り返し，止まったマスで取得か排除をする
//   積み木（片付けた跡・ストッパー）：そのマスに入ると，そのカードの動きはそこで終わる

import { DELTA, Dir, FAV_MOVE, LIGHT_PER, MEMO_AT, Move, SCARDS, SKind, STARTING, UNLIMITED_KINDS, MARKET } from './cards';
import { shuffle } from '../engine/rng';

export const X_MIN = -3, X_MAX = 3, Y_MIN = -4, Y_MAX = 3;
export const BLOCKS = 4;
export const FINISH_FAVS = 3;
export const MAX_ROUNDS = 60;
export const UNLIMITED = 99;

export interface Pos { x: number; y: number }
export const samePos = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y;
export const inBoard = (p: Pos) => p.x >= X_MIN && p.x <= X_MAX && p.y >= Y_MIN && p.y <= Y_MAX;
const isStart = (p: Pos) => p.x === 0 && p.y === 0;

/** 行の効果：取得の額か排除の量（どちらでもなければ none） */
export function rowEffect(y: number): { kind: 'buy' | 'remove' | 'none'; amount: number } {
  if (y >= 1) return { kind: 'buy', amount: [0, 2, 3, 4][y] };
  if (y <= -1) return { kind: 'remove', amount: Math.min(3, -y) };
  return { kind: 'none', amount: 0 };
}
/** 列の上乗せ（衝動の側だけ） */
export const bonus = (x: number) => Math.max(0, x);
/** 止めたとき余分に進む歩数（衝動3はぶつかるまで） */
export const overshoot = (x: number) => (x >= 3 ? Infinity : Math.max(0, x));
/** 止めたあと1マス動いてよいか（理性2以上） */
export const canAdjust = (x: number) => x <= -2;
/** 次の1枚を見られるか（理性3） */
export const canPeek = (x: number) => x <= -3;

export interface SCard { id: number; kind: SKind; fav: boolean }

/** 手番中の動きの状態（ボットの先読みでも使う） */
export interface Walk { pos: Pos; lastDir: Dir | null; blocks: Pos[]; trail: Pos[] }

/** 盤の外へは出られない（端で止まる） */
export const blocked = (_w: Walk, p: Pos) => !inBoard(p);
/** 積み木のマス：入れるが，入ったらそのカードの動きはそこで終わる（前に片付けた場所に引っかかる） */
export const isCatch = (w: Walk, p: Pos) => w.blocks.some(b => samePos(b, p));

/** dir に n マス（端では止まる．積み木のマスに入ったらそこで止まる） */
export function walk(w: Walk, dir: Dir, n: number): void {
  const [dx, dy] = DELTA[dir];
  w.lastDir = dir;
  for (let i = 0; i < n; i++) {
    const next = { x: w.pos.x + dx, y: w.pos.y + dy };
    if (blocked(w, next)) break;
    w.pos = next;
    w.trail.push(next);
    if (isCatch(w, next)) break;
  }
}

/** カードの動き（選べる向きの一覧．空なら選ぶ必要なし） */
export function moveOf(card: SCard): Move {
  return card.fav ? FAV_MOVE : SCARDS[card.kind].move;
}

export function choicesFor(card: SCard, w: Walk): Dir[] {
  const m = moveOf(card);
  return m.t === 'step' && m.dirs.length > 1 ? m.dirs : [];
}

/** 積み木を置ける場所（コマの上下左右．盤の中・スタート以外・積み木のないマス） */
export function stopperCells(w: Walk): Pos[] {
  return (['U', 'D', 'L', 'R'] as Dir[]).map(d => ({ x: w.pos.x + DELTA[d][0], y: w.pos.y + DELTA[d][1] }))
    .filter(p => inBoard(p) && !isStart(p) && !w.blocks.some(b => samePos(b, p)));
}

export function addBlock(blocks: Pos[], p: Pos): void {
  blocks.push(p);
  while (blocks.length > BLOCKS) blocks.shift();
}

/**
 * カードの動きを適用する．dir は選べるときの向き，cell はストッパーの場所．
 * 戻り値：そこで必ず止まるか
 */
export function applyMove(card: SCard, w: Walk, removed: number, dir?: Dir, cell?: Pos): boolean {
  const m = moveOf(card);
  switch (m.t) {
    case 'step': {
      const d = m.dirs.length > 1 ? dir ?? m.dirs[0] : m.dirs[0];
      walk(w, d, m.n + (m.light ? Math.floor(removed / LIGHT_PER) : 0));
      return !!m.stop;
    }
    case 'slide': walk(w, m.dir, Infinity); return false;
    case 'stopper': if (cell) addBlock(w.blocks, cell); return false;
    case 'none': return false;
    case 'swing':
      if (w.pos.y >= 1) walk(w, 'D', 2);
      else if (w.pos.y <= -1) walk(w, 'U', 1);
      else walk(w, 'D', 1);
      return false;
    case 'memo':
      if (removed < MEMO_AT) walk(w, 'U', 1); else walk(w, 'D', 3);
      return false;
  }
}

/** 止めたときのブレーキ（衝動の列では最後に動いた向きへ余分に進む．積み木の上ならそこで止まれる） */
export function brake(w: Walk): void {
  if (isCatch(w, w.pos)) return;
  const n = overshoot(w.pos.x);
  if (n > 0 && w.lastDir) walk(w, w.lastDir, n);
}

// ---- ゲームの状態 ----

export type TurnPhase = 'move' | 'branch' | 'stopper' | 'adjust' | 'resolve';

export interface SPlayer {
  name: string;
  isBot: boolean;
  botType?: string;
  deck: SCard[];
  discard: SCard[];
  /** 今日の流れ（この手番にめくったカード） */
  flow: SCard[];
  walk: Walk;
  removed: number;
  bought: number;
  finished: boolean;
}

export interface SState {
  players: SPlayer[];
  market: Partial<Record<SKind, number>>;
  current: number;
  round: number;
  phase: 'play' | 'over';
  turn: TurnPhase;
  winners: number[];
  log: string[];
  rng: number;
  nextId: number;
}

export type SAction =
  | { type: 'flip' }
  | { type: 'stop' }
  | { type: 'branch'; dir: Dir }
  | { type: 'stopper'; cell: Pos | null }
  | { type: 'adjust'; dir: Dir | null }
  | { type: 'resolve'; buy: SKind[]; remove: number[]; rotate: number[] };

export class SRuleError extends Error {}

const newWalk = (blocks: Pos[]): Walk => ({ pos: { x: 0, y: 0 }, lastDir: null, blocks, trail: [{ x: 0, y: 0 }] });

export function newSlideGame(setup: { name: string; isBot?: boolean; botType?: string }[], seed: number, market: SKind[] = MARKET): SState {
  const s: SState = {
    players: [], market: {}, current: 0, round: 1, phase: 'play', turn: 'move', winners: [], log: [], rng: seed, nextId: 1,
  };
  for (const k of market) s.market[k] = UNLIMITED_KINDS.includes(k) ? UNLIMITED : Math.max(2, setup.length);
  for (const p of setup) {
    const deck: SCard[] = [];
    for (const [k, n] of STARTING) for (let i = 0; i < n; i++) deck.push({ id: s.nextId++, kind: k, fav: false });
    shuffle(deck, s);
    s.players.push({ name: p.name, isBot: !!p.isBot, botType: p.botType, deck, discard: [], flow: [], walk: newWalk([]), removed: 0, bought: 0, finished: false });
  }
  s.log.push('ゲーム開始');
  return s;
}

export const ownedCards = (p: SPlayer) => [...p.deck, ...p.discard, ...p.flow];
/** 達成：カードが0枚，またはお気に入りだけで FINISH_FAVS 枚以下 */
export const isDone = (p: SPlayer) => { const o = ownedCards(p); return o.length <= FINISH_FAVS && o.every(c => c.fav) || o.length === 0; };
export const favCost = (p: SPlayer) => ownedCards(p).filter(c => c.fav).reduce((n, c) => n + (SCARDS[c.kind].cost ?? 0), 0);

/** 止まったマスの効果の額・量（上乗せ込み） */
export function cellPower(pos: Pos): { kind: 'buy' | 'remove' | 'none'; amount: number } {
  const e = rowEffect(pos.y);
  return e.kind === 'none' ? e : { kind: e.kind, amount: e.amount + bonus(pos.x) };
}

/** 排除の重さの合計（道連れ袋1枚につき，ほかの1枚の重さを0にできる．重いものから） */
export function removeLoad(cards: SCard[]): number {
  const drags = cards.filter(c => SCARDS[c.kind].drag).length;
  const others = cards.filter(c => !SCARDS[c.kind].drag).map(c => SCARDS[c.kind].weight).sort((a, b) => b - a);
  return drags + others.slice(drags).reduce((n, w) => n + w, 0);
}

export function applySlide(s: SState, seat: number, a: SAction): void {
  if (s.phase !== 'play') throw new SRuleError('ゲームは終了しています');
  if (seat !== s.current) throw new SRuleError('あなたの手番ではありません');
  const p = s.players[seat];
  const w = p.walk;
  const card = p.flow[p.flow.length - 1];
  switch (a.type) {
    case 'flip': {
      if (s.turn !== 'move') throw new SRuleError('今はめくれません');
      const c = p.deck.pop();
      if (!c) throw new SRuleError('山札がありません．止めてください');
      p.flow.push(c);
      const m = moveOf(c);
      if (choicesFor(c, w).length) { s.turn = 'branch'; return; }
      if (m.t === 'stopper') { s.turn = stopperCells(w).length ? 'stopper' : 'move'; return; }
      if (applyMove(c, w, p.removed)) stop(s, p);
      return;
    }
    case 'branch': {
      if (s.turn !== 'branch') throw new SRuleError('向きを選ぶ場面ではありません');
      if (!choicesFor(card, w).includes(a.dir)) throw new SRuleError('その向きには進めません');
      s.turn = 'move';
      if (applyMove(card, w, p.removed, a.dir)) stop(s, p);
      return;
    }
    case 'stopper': {
      if (s.turn !== 'stopper') throw new SRuleError('積み木を置く場面ではありません');
      if (a.cell && !stopperCells(w).some(c => samePos(c, a.cell!))) throw new SRuleError('そこには置けません');
      if (a.cell) applyMove(card, w, p.removed, undefined, a.cell);
      s.turn = 'move';
      return;
    }
    case 'stop': {
      if (s.turn !== 'move') throw new SRuleError('今は止められません');
      if (!p.flow.length && p.deck.length) throw new SRuleError('少なくとも1枚めくってください');
      stop(s, p);
      return;
    }
    case 'adjust': {
      if (s.turn !== 'adjust') throw new SRuleError('1マス動く場面ではありません');
      if (a.dir) {
        const [dx, dy] = DELTA[a.dir];
        const next = { x: w.pos.x + dx, y: w.pos.y + dy };
        if (blocked(w, next)) throw new SRuleError('そこへは動けません');
        w.pos = next;
        w.trail.push(next);
      }
      s.turn = 'resolve';
      return;
    }
    case 'resolve': {
      if (s.turn !== 'resolve') throw new SRuleError('まだ止まっていません');
      resolve(s, p, a);
      return;
    }
  }
}

function stop(s: SState, p: SPlayer): void {
  brake(p.walk);
  s.turn = canAdjust(p.walk.pos.x) ? 'adjust' : 'resolve';
}

function resolve(s: SState, p: SPlayer, a: { buy: SKind[]; remove: number[]; rotate: number[] }): void {
  const pos = p.walk.pos;
  const power = cellPower(pos);
  if (power.kind !== 'buy' && (a.buy.length || a.rotate.length)) throw new SRuleError('物欲の行でしか取得できません');
  if (power.kind !== 'remove' && a.remove.length) throw new SRuleError('捨欲の行でしか排除できません');
  // 取得
  let total = 0;
  const need: Partial<Record<SKind, number>> = {};
  for (const k of a.buy) {
    const cost = SCARDS[k].cost;
    if (cost === null || s.market[k] === undefined) throw new SRuleError('市場にないカードです');
    total += cost;
    need[k] = (need[k] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(need)) if ((s.market[k as SKind] ?? 0) < n!) throw new SRuleError(`${SCARDS[k as SKind].name}は売り切れです`);
  if (total > power.amount && power.kind === 'buy') throw new SRuleError(`物欲${power.amount}を超えています`);
  for (const id of a.rotate) {
    const c = p.flow.find(x => x.id === id);
    if (!c || !SCARDS[c.kind].rotatable || c.fav) throw new SRuleError('回せるのは今日の流れの愛用品だけです');
  }
  // 排除：今日の流れから．捨欲3なら捨札から1枚（重さ0）
  const ids = [...new Set(a.remove)];
  const fromFlow = ids.map(id => p.flow.find(c => c.id === id)).filter(Boolean) as SCard[];
  const fromDiscard = ids.map(id => p.discard.find(c => c.id === id)).filter(Boolean) as SCard[];
  if (fromFlow.length + fromDiscard.length !== ids.length) throw new SRuleError('今日の流れのカードしか排除できません');
  if (fromDiscard.length > (pos.y <= -4 ? 1 : 0)) throw new SRuleError('捨札から排除できるのは捨欲3で1枚だけです');
  if ([...fromFlow, ...fromDiscard].some(c => c.fav)) throw new SRuleError('お気に入りは排除できません');
  if (power.kind === 'remove' && removeLoad(fromFlow) > power.amount) throw new SRuleError(`捨欲${power.amount}を超えています`);

  for (const id of a.rotate) p.flow.find(x => x.id === id)!.fav = true;
  for (const k of a.buy) {
    if (!UNLIMITED_KINDS.includes(k)) s.market[k]!--;
    p.discard.push({ id: s.nextId++, kind: k, fav: !!SCARDS[k].favorite });
    p.bought++;
  }
  const gone = new Set(ids);
  p.flow = p.flow.filter(c => !gone.has(c.id));
  p.discard = p.discard.filter(c => !gone.has(c.id));
  p.removed += ids.length;
  if (ids.length) addBlock(p.walk.blocks, { ...pos });

  const where = `(${pos.x},${pos.y})`;
  const parts = [`${p.name}：${where}で止まった`];
  if (power.kind !== 'none') parts.push(`${power.kind === 'buy' ? '物欲' : '捨欲'}${power.amount}`);
  if (ids.length) parts.push(`${ids.length}枚排除`);
  if (a.buy.length) parts.push(`取得 ${a.buy.map(k => SCARDS[k].name).join('・')}`);
  if (a.rotate.length) parts.push(`お気に入り ${a.rotate.length}枚`);
  s.log.push(parts.join(' / '));
  endTurn(s, p);
}

function endTurn(s: SState, p: SPlayer): void {
  p.discard.push(...p.flow);
  p.flow = [];
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
  startTurn(s);
}

function startTurn(s: SState): void {
  const p = s.players[s.current];
  p.walk = newWalk(p.walk.blocks);
  s.turn = 'move';
  if (p.deck.length === 0) {
    p.deck = p.discard;
    p.discard = [];
    shuffle(p.deck, s);
  }
}
