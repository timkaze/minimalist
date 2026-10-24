import { describe, expect, it } from 'vitest';
import { MARKET_KINDS, STANDARD_PICK, STARTING_DECK, marketFromPick } from '../src/engine/cards';
import { FLOORS, RECOMMENDED_FLOORS, floorFromSpec, floorToSpec } from '../src/engine/floors';
import {
  Card, GameState, RuleError, applyAction, newGame, openCells, ownedCount, targetsFor, viewFor,
} from '../src/engine/game';
import { PRESETS } from '../src/bot/bot';
import { playBotGame } from '../src/bot/runner';

const DECK = STARTING_DECK.reduce((n, d) => n + d.count, 0);
const twoPlayers = () => newGame([{ name: 'A' }, { name: 'B' }], 42);

function totalCards(s: GameState) {
  return s.players.reduce((n, p) => n + ownedCount(p) + p.removed, 0);
}

/** 手番の人の手札を差し替える（テスト用） */
function setHand(s: GameState, cards: Card[]) {
  const p = s.players[s.current];
  p.discard.push(...p.hand);
  p.hand = cards;
  return p;
}

describe('engine（レベル版）', () => {
  it('配る：初期デッキ（↑1・→3・↓1・粗大ごみ1）から3枚引く．基本カードは売り切れない', () => {
    const s = twoPlayers();
    const p = s.players[0];
    expect(p.hand).toHaveLength(3);
    const all = [...p.deck, ...p.hand];
    expect(all).toHaveLength(DECK);
    expect(all.filter(c => c.kind === 'R')).toHaveLength(3);
    expect(all.filter(c => c.kind === 'J')).toHaveLength(1);
    expect(s.market.U).toBeGreaterThan(50);
    expect(s.market.BAG).toBe(2);
    expect(s.marketKinds).toEqual(MARKET_KINDS);
  });

  it('標準の間取り：レベル 3,2,2,1,0,−1,−2,−2,−3．スタートは枠の外（レベル0の行）で，最初に置けるのはその右だけ', () => {
    const f = FLOORS.standard;
    expect(f.levels).toEqual([3, 2, 2, 1, 0, -1, -2, -2, -3]);
    expect(f.budgets).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(f.startRow).toBe(4);
    expect(openCells({}, f)).toEqual([[4, 0]]);
    // 何も置いていなくても，スタートの→の先（レベル0・支払い1）を行き先にできる
    expect(targetsFor({}, f)).toEqual([{ pos: [4, 0], level: 0, budget: 1 }]);
  });

  it('↑で上の行へ．行き先のレベル以下のカードを，支払える額の範囲で取得する', () => {
    const s = twoPlayers();
    const p = setHand(s, [{ id: 900, kind: 'R' }, { id: 901, kind: 'U' }]);
    applyAction(s, 0, { type: 'place', cardId: 900, pos: [4, 0] });
    applyAction(s, 0, { type: 'place', cardId: 901, pos: [4, 1] });
    const ts = targetsFor(p.board, s.floor).map(t => `${t.pos}:${t.level}:${t.budget}`).sort();
    expect(ts).toEqual(['3,1:1:2', '4,0:0:1', '4,1:0:2']);
    const before = JSON.stringify(s);
    expect(() => applyAction(s, 0, { type: 'endTurn', target: [3, 1], remove: [], buy: ['R+'] })).toThrow(/レベル2/); // レベル2は取れない
    expect(() => applyAction(s, 0, { type: 'endTurn', target: [3, 1], remove: [], buy: ['RD', 'R'] })).toThrow(/支払える額/);
    expect(() => applyAction(s, 0, { type: 'endTurn', target: [4, 1], remove: [], buy: ['RD'] })).toThrow(RuleError); // レベル0では基本カードだけ
    expect(() => applyAction(s, 0, { type: 'endTurn', target: [5, 1], remove: [], buy: ['R'] })).toThrow(/行き先/);
    expect(() => applyAction(s, 0, { type: 'endTurn', remove: [], buy: ['R'] })).toThrow(/行き先を選んで/);
    expect(JSON.stringify(s)).toBe(before);
    applyAction(s, 0, { type: 'endTurn', target: [3, 1], remove: [], buy: ['RD'] });
    expect(p.discard.some(c => c.kind === 'RD')).toBe(true);
    expect(p.bought).toBe(1);
  });

  it('↓で下の行へ．レベル−の行では，その絶対値以下のレベルの場のカードを排除コストの範囲で消す', () => {
    const s = twoPlayers();
    const p = setHand(s, [{ id: 900, kind: 'R' }, { id: 901, kind: 'D' }, { id: 902, kind: 'J' }]);
    applyAction(s, 0, { type: 'place', cardId: 900, pos: [4, 0] });
    applyAction(s, 0, { type: 'place', cardId: 901, pos: [4, 1] });
    applyAction(s, 0, { type: 'place', cardId: 902, pos: [5, 1] }); // 粗大ごみを↓の先に
    // 行き先 (5,1)：レベル−1・支払い2．粗大ごみ（レベル2）はここでは消せない
    expect(() => applyAction(s, 0, { type: 'endTurn', target: [5, 1], remove: [902], buy: [] })).toThrow(/レベル2/);
    expect(() => applyAction(s, 0, { type: 'endTurn', target: [5, 1], remove: [900], buy: ['R'] })).toThrow(RuleError); // 取得はできない
    expect(() => applyAction(s, 0, { type: 'endTurn', target: [4, 1], remove: [900], buy: [] })).toThrow(/レベルが−/);
    p.hand.push({ id: 903, kind: 'R' });
    expect(() => applyAction(s, 0, { type: 'endTurn', target: [5, 1], remove: [903], buy: [] })).toThrow(/場に置いた/);
    p.hand.pop();
    applyAction(s, 0, { type: 'endTurn', target: [5, 1], remove: [900, 901], buy: [] });
    expect(p.removed).toBe(2);
    expect(p.discard.some(c => c.id === 902)).toBe(true);
  });

  it('粗大ごみはレベル−2の行で，排除コスト2を払って消す', () => {
    const s = twoPlayers();
    const p = setHand(s, [{ id: 900, kind: 'D' }, { id: 901, kind: 'D' }, { id: 902, kind: 'R' }, { id: 903, kind: 'J' }]);
    applyAction(s, 0, { type: 'place', cardId: 900, pos: [4, 0] });
    applyAction(s, 0, { type: 'place', cardId: 901, pos: [5, 0] });
    applyAction(s, 0, { type: 'place', cardId: 902, pos: [6, 0] });
    applyAction(s, 0, { type: 'place', cardId: 903, pos: [6, 1] });
    // (6,1)：レベル−2・支払い2．粗大ごみ（2）と↓（1）は同時に消せない
    expect(() => applyAction(s, 0, { type: 'endTurn', target: [6, 1], remove: [903, 900], buy: [] })).toThrow(/支払える額/);
    applyAction(s, 0, { type: 'endTurn', target: [6, 1], remove: [903], buy: [] });
    expect(p.removed).toBe(1);
  });

  it('手元：置かなかったカードを1枚残すと，次の手番にも使える．省略すれば今の手元のまま，null なら残さない', () => {
    const s = newGame([{ name: 'A' }], 7);
    const p = setHand(s, [{ id: 900, kind: 'R' }, { id: 901, kind: 'J' }]);
    expect(() => applyAction(s, 0, { type: 'endTurn', remove: [], buy: [], keep: 999 })).toThrow(RuleError);
    applyAction(s, 0, { type: 'endTurn', remove: [], buy: [], keep: 901 });
    expect(p.reserve.map(c => c.id)).toEqual([901]);
    expect(p.hand).toHaveLength(3);
    // 手元のカードも置ける
    applyAction(s, 0, { type: 'place', cardId: 901, pos: [4, 0] });
    expect(p.reserve).toEqual([]);
    applyAction(s, 0, { type: 'undo' });
    expect(p.reserve.map(c => c.id)).toEqual([901]);
    applyAction(s, 0, { type: 'endTurn', remove: [], buy: [] });
    expect(p.reserve.map(c => c.id)).toEqual([901]);
    applyAction(s, 0, { type: 'endTurn', remove: [], buy: [], keep: null });
    expect(p.reserve).toEqual([]);
    expect(totalCards(s)).toBe(DECK + 2);
  });

  it('戻す：引かないカードは戻せる．引くカードを置いたら，それより前には戻せない', () => {
    const s = twoPlayers();
    const p = setHand(s, [{ id: 970, kind: 'R' }, { id: 971, kind: 'R' }, { id: 972, kind: 'R+' }]);
    p.deck.push({ id: 973, kind: 'D' });
    applyAction(s, 0, { type: 'place', cardId: 970, pos: [4, 0] });
    applyAction(s, 0, { type: 'place', cardId: 971, pos: [4, 1] });
    applyAction(s, 0, { type: 'undo' });
    expect(p.board['4,1']).toBeUndefined();
    applyAction(s, 0, { type: 'place', cardId: 972, pos: [4, 1] }); // 台車：1枚引く
    expect(p.hand.map(c => c.id)).toEqual([971, 973]);
    expect(() => applyAction(s, 0, { type: 'undo' })).toThrow(RuleError);
    expect(() => applyAction(s, 1, { type: 'undo' })).toThrow(RuleError);
    applyAction(s, 0, { type: 'endTurn', remove: [], buy: [] });
    expect(s.undo).toEqual([]);
  });

  it('紙袋は置くと1枚引き，手番の終わりに排除コストを払わずに消える', () => {
    const s = twoPlayers();
    const p = setHand(s, [{ id: 960, kind: 'BAG' }]);
    p.deck.push({ id: 961, kind: 'R' });
    applyAction(s, 0, { type: 'place', cardId: 960, pos: [4, 0] });
    expect(p.hand.map(c => c.id)).toEqual([961]);
    applyAction(s, 0, { type: 'endTurn', remove: [], buy: [] });
    expect(p.removed).toBe(1);
    expect([...p.deck, ...p.discard, ...p.hand].some(c => c.id === 960)).toBe(false);
  });

  it('カードナンバー：初期デッキは1〜，取得したカードは続きの番号．一覧は番号順で手元も含む', () => {
    const s = newGame([{ name: 'A' }, { name: 'B' }], 42);
    const p = s.players[0];
    const nos = [...p.deck, ...p.hand].map(c => c.no!).sort((a, b) => a - b);
    expect(nos).toEqual(Array.from({ length: DECK }, (_, i) => i + 1));
    const keep = p.hand[1].id;
    applyAction(s, 0, { type: 'endTurn', target: [4, 0], remove: [], buy: ['D'], keep });
    expect(p.discard.find(c => c.kind === 'D' && c.no === DECK + 1)).toBeDefined();
    const v = viewFor(s, 0);
    expect(v.players[0].cards!.map(c => c.no)).toEqual(Array.from({ length: DECK + 1 }, (_, i) => i + 1));
    expect(v.players[0].cards!.filter(c => c.where === 'reserve')).toHaveLength(1);
    expect(v.players[1].cards).toBeUndefined();
    expect(v.players[0].reserveCount).toBe(1);
  });

  it('不正なアクションは拒否し，状態を変えない', () => {
    const s = twoPlayers();
    const before = JSON.stringify(s);
    const card = s.players[0].hand[0];
    expect(() => applyAction(s, 1, { type: 'place', cardId: card.id, pos: [4, 0] })).toThrow(RuleError);
    expect(() => applyAction(s, 0, { type: 'place', cardId: card.id, pos: [5, 0] })).toThrow(RuleError);
    expect(() => applyAction(s, 0, { type: 'endTurn', target: [4, 0], remove: [card.id], buy: [] })).toThrow(RuleError);
    expect(() => applyAction(s, 0, { type: 'endTurn', target: [4, 0], remove: [], buy: ['J'] })).toThrow(RuleError);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('柱には置けない．カスタムの間取りは確かめてから使う', () => {
    const spec = { rows: ['. . .', '. # .', '. . .'], levels: [1, 0, -1], budgets: [1, 3, 5] };
    const s = newGame([{ name: 'A' }, { name: 'B' }], 3, { custom: spec });
    expect(s.floor).toMatchObject({ rows: 3, cols: 3, walls: ['1,1'], startRow: 1, levels: [1, 0, -1], budgets: [1, 3, 5] });
    const board = { '1,0': { id: 1, kind: 'R' as const } };
    expect(openCells(board, s.floor)).toEqual([]); // →の先 (1,1) は柱
    for (const bad of [
      { rows: ['.'], levels: [0], budgets: [1] },
      { rows: ['# .', '. .'], levels: [0, -1], budgets: [1, 2] }, // スタートの右が柱
      { rows: ['. .', '. .'], levels: [1, -1], budgets: [1, 2] }, // レベル0の行がない
      { rows: ['. .', '. .'], levels: [0, -4], budgets: [1, 2] },
      { rows: ['. .', '. .'], levels: [0, -1], budgets: [1] },
      { rows: ['. x', '. .'], levels: [0, -1], budgets: [1, 2] },
      'nonsense',
    ]) expect(() => floorFromSpec(bad)).toThrow();
    for (const name of RECOMMENDED_FLOORS) {
      const f = floorFromSpec(floorToSpec(FLOORS[name]));
      expect({ ...f, name: FLOORS[name].name, label: FLOORS[name].label }).toEqual(FLOORS[name]);
    }
  });

  it('市場は候補から8種類選べる（基本カードは必ず並ぶ）', () => {
    expect(() => marketFromPick(['RD', 'RU'])).toThrow();
    expect(() => marketFromPick([...STANDARD_PICK.slice(0, 7), 'J'])).toThrow(); // 粗大ごみは候補ではない
    const m = marketFromPick(['P', 'U+', 'RU2', 'RUD', 'RD', 'RU', 'BAG', 'R+']);
    expect(m).toEqual(['R', 'D', 'U', 'RD', 'RU', 'P', 'BAG', 'R+', 'U+', 'RU2', 'RUD']);
    const s = newGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }], 3, { market: m });
    expect(s.market.RUD).toBe(3);
  });

  it('ボット同士のゲームは必ず終わり，カードの総数が保存される', () => {
    const kinds = Object.keys(PRESETS);
    let finished = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const n = 2 + (seed % 5);
      const gs = Array.from({ length: n }, (_, i) => PRESETS[kinds[(seed + i) % kinds.length]]);
      const s = playBotGame(gs, seed, { floor: RECOMMENDED_FLOORS[seed % RECOMMENDED_FLOORS.length] });
      expect(s.phase).toBe('over');
      const bought = s.players.reduce((a, p) => a + p.bought, 0);
      expect(totalCards(s)).toBe(DECK * n + bought);
      if (s.winners.length) finished++;
    }
    expect(finished).toBeGreaterThan(30); // 規定ラウンド切れ（行き詰まり）はまれ
  });
});
