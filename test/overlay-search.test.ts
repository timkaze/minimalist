import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { marketFromChoice } from '../src/overlay/tiles';
import { OState, applyOverlay, newOverlayGame } from '../src/overlay/engine';
import { SearchOpts, chooseSearchAction } from '../src/overlay/search';
import { SEARCH_BOT, botChoices, resolveBot } from '../src/overlay/bot';
import { botAction } from '../src/overlay/bots';
import { BINS, NFEAT, FEAT_VERSION, ValueJson, ValueModel, featOfPlayer } from '../src/overlay/value';

/** でたらめな重みの V（合法手・再現性の確認用） */
function randomModel(seed: number): ValueModel {
  let a = seed;
  const r = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 - 0.5; };
  const layer = (i: number, o: number) => ({ in: i, out: o, w: Array.from({ length: i * o }, () => r() * 0.4), b: Array.from({ length: o }, r) });
  const json: ValueJson = { version: FEAT_VERSION, feat: NFEAT, bins: BINS, layers: [layer(NFEAT, 12), layer(12, BINS)] };
  return new ValueModel(json);
}

function play(n: number, seed: number, set: string, opts: SearchOpts[]): OState {
  const s = newOverlayGame(Array.from({ length: n }, (_, i) => ({ name: `P${i}`, isBot: true })), seed, { market: marketFromChoice(set, () => 0.3) });
  let guard = 0;
  while (s.phase === 'play' && guard++ < 50000) applyOverlay(s, s.current, chooseSearchAction(s, opts[s.current % opts.length])); // 不正な手なら applyOverlay が例外を出す
  return s;
}

describe('オーバーレイ版の探索ボット', () => {
  it('評価関数は確率の分布を返す', () => {
    const m = randomModel(1), out = new Float64Array(BINS);
    const s = newOverlayGame([{ name: 'A' }, { name: 'B' }], 1);
    m.dist(featOfPlayer(s, s.players[0]), out);
    expect([...out].reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
  });

  it('合法な手だけを返し，最後まで対戦できる（点数の付け方・人数・セットを変えて）', () => {
    const model = randomModel(7);
    for (const [i, set] of ['all', 'intro', 'light', 'swing'].entries()) {
      const s = play(2 + (i % 3), 100 + i, set, [{ model, objective: 'mean', budget: 60 }, { model, objective: 'win', budget: 60 }]);
      expect(s.phase).toBe('over');
    }
  }, 60000);

  it('同じ種からは同じ試合になる', () => {
    const model = randomModel(3);
    const a = play(2, 42, 'all', [{ model, budget: 60 }]), b = play(2, 42, 'all', [{ model, budget: 60 }]);
    expect(a.log).toEqual(b.log);
  }, 60000);

  it('買わないと決めた種類は取得しない', () => {
    const model = randomModel(5);
    const s = play(2, 9, 'all', [{ model, budget: 60, ban: ['ROOMBA', 'BIGDAY', 'BAG', 'COMPASS', 'KODAWARI', 'DOWN2'] }]);
    expect(s.players.every(p => p.perms.length === 0)).toBe(true);
    expect(s.log.some(l => /取得 .*断捨離/.test(l))).toBe(false);
  });

  it('ボットの種類「つよいAI」は探索ボットへ回り，以前のAIと混ぜて最後まで対戦できる', () => {
    expect(resolveBot(SEARCH_BOT)).toBe(SEARCH_BOT);
    expect(botChoices()[0]).toBe(SEARCH_BOT);
    const types = [SEARCH_BOT, 'aiFree', SEARCH_BOT];
    const s = newOverlayGame(types.map((t, i) => ({ name: `P${i}`, isBot: true, botType: t })), 3);
    let guard = 0;
    while (s.phase === 'play' && guard++ < 50000) applyOverlay(s, s.current, botAction(s, s.players[s.current].botType, 100));
    expect(s.phase).toBe('over');
  }, 60000);

  it('学習済みの V（value.json）があれば読み込めて，対戦できる', () => {
    const path = new URL('../src/overlay/value.json', import.meta.url);
    if (!existsSync(path)) return;
    const model = new ValueModel(JSON.parse(readFileSync(path, 'utf8')));
    expect(play(2, 5, 'all', [{ model, objective: 'win', budget: 100 }]).phase).toBe('over');
  });
});
