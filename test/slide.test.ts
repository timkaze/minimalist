import { describe, expect, it } from 'vitest';
import { SCARDS } from '../src/slide/cards';
import {
  SState, Walk, applySlide, brake, cellPower, isDone, newSlideGame, ownedCards, removeLoad, walk,
} from '../src/slide/engine';
import { SPRESETS, playSlideTurn } from '../src/slide/bot';

const w0 = (blocks: { x: number; y: number }[] = []): Walk => ({ pos: { x: 0, y: 0 }, lastDir: null, blocks, trail: [] });
const card = (kind: keyof typeof SCARDS, id = 900, fav = false) => ({ id, kind, fav });

/** 現在の手番の人の山札の上を，指定のカードにする */
function stack(s: SState, ...kinds: (keyof typeof SCARDS)[]) {
  const p = s.players[s.current];
  p.deck = kinds.map((k, i) => card(k, 500 + i)).reverse();
}

describe('スライド版', () => {
  it('初期デッキは弱い5枚で↓がない', () => {
    const s = newSlideGame([{ name: 'A' }, { name: 'B' }], 1);
    const kinds = s.players[0].deck.map(c => c.kind).sort();
    expect(kinds).toEqual(['DOUBT', 'HES', 'JUNK', 'WANT', 'WANT']);
    expect(kinds.some(k => SCARDS[k].move.t === 'step' && (SCARDS[k].move as { dirs: string[] }).dirs.includes('D'))).toBe(false);
  });

  it('毎手番，少なくとも1枚めくる', () => {
    const s = newSlideGame([{ name: 'A' }, { name: 'B' }], 1);
    expect(() => applySlide(s, 0, { type: 'stop' })).toThrow();
    applySlide(s, 0, { type: 'flip' });
  });

  it('端では止まり，積み木のマスに入るとそこで止まる', () => {
    const w = w0();
    walk(w, 'D', Infinity);
    expect(w.pos).toEqual({ x: 0, y: -4 });
    const v = w0([{ x: 0, y: -2 }]);
    walk(v, 'D', Infinity);
    expect(v.pos).toEqual({ x: 0, y: -2 });
    walk(v, 'D', 1); // 次のカードでは積み木から出られる
    expect(v.pos).toEqual({ x: 0, y: -3 });
  });

  it('衝動の列で止めると余分に進み，理性の列ではぴったり止まる', () => {
    const w = w0();
    walk(w, 'R', 2);
    walk(w, 'D', 1);
    brake(w);
    expect(w.pos).toEqual({ x: 2, y: -3 });
    const v = w0();
    walk(v, 'L', 2);
    walk(v, 'D', 1);
    brake(v);
    expect(v.pos).toEqual({ x: -2, y: -1 });
  });

  it('行の効果：物欲は浅く，捨欲は下ほど多く，衝動の列で上乗せ', () => {
    expect(cellPower({ x: 0, y: 1 })).toEqual({ kind: 'buy', amount: 2 });
    expect(cellPower({ x: 2, y: 3 })).toEqual({ kind: 'buy', amount: 6 });
    expect(cellPower({ x: 0, y: 0 }).kind).toBe('none');
    expect(cellPower({ x: 0, y: -1 })).toEqual({ kind: 'remove', amount: 1 });
    expect(cellPower({ x: 1, y: -4 })).toEqual({ kind: 'remove', amount: 4 });
  });

  it('道連れ袋は，もう1枚を重さ0にする', () => {
    expect(removeLoad([card('DRAG', 1), card('JUNK', 2)])).toBe(1);
    expect(removeLoad([card('DOWN', 1), card('JUNK', 2)])).toBe(3);
  });

  it('取得は物欲の行で，排除は今日の流れから，排除したマスに積み木が残る', () => {
    const s = newSlideGame([{ name: 'A' }, { name: 'B' }], 2);
    stack(s, 'WANT', 'WANT');
    applySlide(s, 0, { type: 'flip' });
    applySlide(s, 0, { type: 'stop' });
    expect(() => applySlide(s, 0, { type: 'resolve', buy: ['SLIDE'], remove: [], rotate: [] })).toThrow(); // 物欲2で3は買えない
    applySlide(s, 0, { type: 'resolve', buy: ['DOWN2'], remove: [], rotate: [] });
    expect(s.players[0].discard.some(c => c.kind === 'DOWN2')).toBe(true);

    applySlide(s, 1, { type: 'flip' }); applySlide(s, 1, { type: 'stop' });
    if (s.turn === 'adjust') applySlide(s, 1, { type: 'adjust', dir: null });
    applySlide(s, 1, { type: 'resolve', buy: [], remove: [], rotate: [] });

    stack(s, 'SLIDE', 'JUNK');
    applySlide(s, 0, { type: 'flip' });
    applySlide(s, 0, { type: 'flip' });
    applySlide(s, 0, { type: 'stop' });
    const p = s.players[0];
    expect(p.walk.pos).toEqual({ x: 0, y: -4 });
    const junk = p.flow.find(c => c.kind === 'JUNK')!;
    const fromDiscard = p.discard.find(c => !c.fav)!;
    expect(() => applySlide(s, 0, { type: 'resolve', buy: [], remove: [junk.id, fromDiscard.id, p.discard[1].id], rotate: [] })).toThrow();
    applySlide(s, 0, { type: 'resolve', buy: [], remove: [junk.id, fromDiscard.id], rotate: [] });
    expect(p.removed).toBe(2);
    expect(p.walk.blocks).toEqual([{ x: 0, y: -4 }]);
  });

  it('お気に入りだけ3枚以下になったら達成．お気に入りは排除できない', () => {
    const s = newSlideGame([{ name: 'A' }], 3);
    const p = s.players[0];
    p.deck = [card('FAV', 1, true), card('USED', 2, true)];
    p.discard = [];
    expect(isDone(p)).toBe(true);
    p.deck.push(card('DOWN', 3));
    expect(isDone(p)).toBe(false);
  });

  it('ボット同士のゲームは終わり，カードの総数が保存される', () => {
    const kinds = Object.keys(SPRESETS);
    let finished = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const n = 2 + (seed % 3);
      const gs = Array.from({ length: n }, (_, i) => SPRESETS[kinds[(seed + i) % kinds.length]]);
      const s = newSlideGame(gs.map((_, i) => ({ name: `P${i}`, isBot: true })), seed);
      while (s.phase === 'play') playSlideTurn(s, gs);
      for (const p of s.players) expect(ownedCards(p).length + p.removed).toBe(5 + p.bought);
      if (s.winners.length) finished++;
    }
    expect(finished).toBeGreaterThan(34);
  });
});
