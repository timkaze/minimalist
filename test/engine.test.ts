import { describe, expect, it } from 'vitest';
import { CARDS, MARKET_KINDS, STARTING_DECK, marketFromPick } from '../src/engine/cards';
import { FLOORS, RECOMMENDED_FLOORS } from '../src/engine/floors';
import {
  GameState, RuleError, applyAction, computeReach, newGame, openCells, ownedCount,
} from '../src/engine/game';
import { PRESETS } from '../src/bot/bot';
import { playBotGame } from '../src/bot/runner';

const DECK = STARTING_DECK.reduce((n, d) => n + d.count, 0);
const twoPlayers = () => newGame([{ name: 'A' }, { name: 'B' }], 42, { floor: 'basic' });

function totalCards(s: GameState) {
  return s.players.reduce((n, p) => n + ownedCount(p) + p.removed, 0);
}

describe('engine', () => {
  it('配る：初期デッキから3枚引く．✕は1枚だけで，市場には無い', () => {
    const s = twoPlayers();
    const all = [...s.players[0].deck, ...s.players[0].hand];
    expect(s.players[0].hand).toHaveLength(3);
    expect(all).toHaveLength(DECK);
    expect(all.filter(c => c.kind === 'X')).toHaveLength(1);
    expect(s.marketKinds).not.toContain('X');
    expect(s.market['BAG']).toBe(2);
    expect(s.marketKinds).not.toContain('TRK');
    expect(s.market['R']).toBeGreaterThan(50); // 基本カードは売り切れない
  });

  it('既定の間取りはワンルーム', () => {
    expect(newGame([{ name: 'A' }], 1).floor.name).toBe('grow');
  });

  it('手札は排除できない（場に置いたカードだけ）', () => {
    const s = twoPlayers();
    const p = s.players[0];
    const card = p.hand[0];
    applyAction(s, 0, { type: 'place', cardId: card.id, pos: [0, 1] });
    p.hand.push({ id: 950, kind: 'R' });
    expect(() => applyAction(s, 0, { type: 'endTurn', remove: [950], buy: [] })).toThrow(RuleError);
  });

  it('粗大ごみは排除力を2使う', () => {
    const s = newGame([{ name: 'A' }, { name: 'B' }], 5, { floor: 'basic' });
    const p = s.players[0];
    p.hand = [{ id: 900, kind: 'RD' }, { id: 901, kind: 'X' }, { id: 902, kind: 'J' }];
    applyAction(s, 0, { type: 'place', cardId: 900, pos: [0, 1] });
    applyAction(s, 0, { type: 'place', cardId: 901, pos: [0, 2] });
    applyAction(s, 0, { type: 'place', cardId: 902, pos: [1, 1] });
    // 排除力2（下へ1＋✕1）：粗大ごみ（2）と仕分け箱（1）は同時に消せない
    expect(() => applyAction(s, 0, { type: 'endTurn', remove: [902, 900], buy: [] })).toThrow(RuleError);
    applyAction(s, 0, { type: 'endTurn', remove: [902], buy: [] });
    expect(p.removed).toBe(1);
  });

  it('紙袋は置くと1枚引き，手番の終わりに排除力を使わずに消える', () => {
    const s = twoPlayers();
    const p = s.players[0];
    p.hand = [{ id: 960, kind: 'BAG' }];
    p.deck.push({ id: 961, kind: 'R' });
    applyAction(s, 0, { type: 'place', cardId: 960, pos: [0, 1] });
    expect(p.hand.map(c => c.id)).toEqual([961]);
    applyAction(s, 0, { type: 'place', cardId: 961, pos: [0, 2] });
    const before = p.removed;
    applyAction(s, 0, { type: 'endTurn', remove: [], buy: [] });
    expect(p.removed).toBe(before + 1);
    expect([...p.deck, ...p.discard, ...p.hand].some(c => c.id === 960)).toBe(false);
  });

  it('最初に置けるのはスタートの右だけ', () => {
    expect(openCells({}, FLOORS.basic, 0)).toEqual([[0, 1]]);
  });

  it('到達距離：購入力は列，排除力は行＋✕', () => {
    const board = { '0,1': { id: 1, kind: 'D' as const }, '1,1': { id: 2, kind: 'X' as const } };
    expect(computeReach(board, FLOORS.basic)).toMatchObject({ buy: 1, remove: 2, corner: false });
    const corner = { ...board, '3,3': { id: 3, kind: 'R' as const } };
    expect(computeReach(corner, FLOORS.basic).remove).toBe(Infinity);
  });

  it('不正なアクションは拒否し，状態を変えない', () => {
    const s = twoPlayers();
    const before = JSON.stringify(s);
    const card = s.players[0].hand[0];
    expect(() => applyAction(s, 1, { type: 'place', cardId: card.id, pos: [0, 1] })).toThrow(RuleError);
    expect(() => applyAction(s, 0, { type: 'place', cardId: card.id, pos: [1, 1] })).toThrow(RuleError);
    expect(() => applyAction(s, 0, { type: 'endTurn', remove: [card.id], buy: [] })).toThrow(RuleError);
    expect(() => applyAction(s, 0, { type: 'endTurn', remove: [], buy: ['X'] })).toThrow(RuleError);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('置く→排除→購入→次の人へ', () => {
    const s = twoPlayers();
    const p = s.players[0];
    const card = p.hand[0];
    applyAction(s, 0, { type: 'place', cardId: card.id, pos: [0, 1] });
    const def = CARDS[card.kind];
    const second = p.hand[0];
    const pos: [number, number] = def.right ? [0, 2] : [1, 1];
    applyAction(s, 0, { type: 'place', cardId: second.id, pos });
    const reach = computeReach(p.board, FLOORS.basic);
    const remove = reach.remove >= 1 ? [card.id] : [];
    applyAction(s, 0, { type: 'endTurn', remove, buy: [] });
    expect(p.removed).toBe(remove.length);
    expect(s.current).toBe(1);
    expect(s.players[1].hand).toHaveLength(3);
    expect(totalCards(s)).toBe(DECK * 2);
  });

  it('柱と未開放の段ボールには置けず，排除枚数が増えると開く', () => {
    const f = FLOORS.grow;
    const board = { '0,1': { id: 1, kind: 'R' as const }, '0,2': { id: 2, kind: 'R' as const } };
    expect(openCells(board, f, 0).map(p => p.join(','))).not.toContain('0,3');
    expect(openCells(board, f, 4).map(p => p.join(','))).toContain('0,3');
    const wallSide = { '1,1': { id: 3, kind: 'D' as const } };
    expect(openCells(wallSide, f, 99).map(p => p.join(','))).not.toContain('2,1');
  });

  it('おすすめの間取りは，全部開けばゴミ捨て場まで→と↓だけでたどり着ける', () => {
    for (const name of RECOMMENDED_FLOORS) {
      const f = FLOORS[name];
      const ok = new Set(['0,0']);
      for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
        const k = `${r},${c}`;
        if (k === '0,0' || f.walls.includes(k)) continue;
        // 左から（スタートを含む）か，上から（スタートは→しか持たないので除く）
        const fromLeft = ok.has(`${r},${c - 1}`);
        const fromUp = ok.has(`${r - 1},${c}`) && `${r - 1},${c}` !== '0,0';
        if (fromLeft || fromUp) ok.add(k);
      }
      expect(ok.has(f.goal), name).toBe(true);
    }
  });

  it('ボット同士のゲームは必ず終わり，カードの総数が保存される', () => {
    const kinds = Object.keys(PRESETS);
    const floors = Object.keys(FLOORS);
    for (let seed = 1; seed <= 40; seed++) {
      const n = 2 + (seed % 5);
      const gs = Array.from({ length: n }, (_, i) => PRESETS[kinds[(seed + i) % kinds.length]]);
      const s = playBotGame(gs, seed, { floor: floors[seed % floors.length] });
      expect(s.phase).toBe('over');
      const bought = s.players.reduce((a, p) => a + p.bought, 0);
      expect(totalCards(s)).toBe(DECK * n + bought);
      expect(s.winners.length).toBeGreaterThan(0);
      expect(s.players[s.current]).toBeDefined();
    }
  });

  it('市場は候補から6種類選べる（基本カードは必ず並ぶ）', () => {
    expect(() => marketFromPick(['R+', 'D+'])).toThrow();
    expect(() => marketFromPick(['R+', 'D+', 'RD', 'P', 'RD2', 'J'])).toThrow(); // 粗大ごみは候補ではない
    const m = marketFromPick(['ST', 'LD', 'LR', 'CUT', 'PT', 'SELL']);
    expect(m).toEqual(['R', 'D', 'ST', 'LD', 'LR', 'CUT', 'PT', 'SELL']);
    const s = newGame([{ name: 'A' }, { name: 'B' }], 3, { market: m });
    expect(s.marketKinds).toEqual(m);
    expect(s.market.ST).toBe(2);
    expect(newGame([{ name: 'A' }], 3).marketKinds).toEqual(MARKET_KINDS);
  });

  it('試作カード：はしごは2つ下，カッターは段ボールにも置ける，フリマは排除で購入力が増える', () => {
    expect(openCells({ '0,1': { id: 1, kind: 'LD' } }, FLOORS.basic, 0)).toContainEqual([2, 1]);
    expect(openCells({ '0,2': { id: 1, kind: 'CUT' } }, FLOORS.grow, 0)).toContainEqual([0, 3]);
    expect(openCells({ '0,2': { id: 1, kind: 'RD' } }, FLOORS.grow, 0)).not.toContainEqual([0, 3]);
    const s = newGame([{ name: 'A' }, { name: 'B' }], 5, { market: marketFromPick(['R+', 'D+', 'RD', 'P', 'RD2', 'SELL']) });
    const p = s.players[0];
    p.hand = [{ id: 970, kind: 'SELL' }, { id: 971, kind: 'D' }, { id: 972, kind: 'R' }];
    applyAction(s, 0, { type: 'place', cardId: 970, pos: [0, 1] });
    applyAction(s, 0, { type: 'place', cardId: 971, pos: [0, 2] });
    applyAction(s, 0, { type: 'place', cardId: 972, pos: [1, 2] });
    // 購入力2・排除力1．フリマを排除しなければコスト3は買えず，排除すれば購入力4で買える
    expect(() => applyAction(s, 0, { type: 'endTurn', remove: [], buy: ['D+'] })).toThrow(RuleError);
    applyAction(s, 0, { type: 'endTurn', remove: [970], buy: ['D+'] });
    expect(p.discard.some(c => c.kind === 'D+')).toBe(true);
  });
});
