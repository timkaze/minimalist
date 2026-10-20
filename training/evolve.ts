// 進化戦略の本体（train.ts と explore.ts で共有）

import { BotGenome } from '../src/bot/bot';
import { CardKind } from '../src/engine/cards';
import { GameOptions } from '../src/engine/game';
import { decode, encode, evaluateGenome, rngFrom, scales } from './common';

export interface EvolveOptions {
  gens: number;
  pop: number;
  games: number;
  /** 出発点（プリセットや今の学習済み） */
  seeds: BotGenome[];
  /** 対戦相手の基本（プリセット） */
  opponents: BotGenome[];
  opts: GameOptions;
  seed?: number;
  /** 買ってはいけないカード（別の戦略の系統を調べるため） */
  forbid?: CardKind[];
  log?: (line: string) => void;
}

export function evolve(o: EvolveOptions): { finalists: BotGenome[] } {
  const ELITE = Math.max(2, Math.round(o.pop / 4));
  const SIGMA = 0.35;
  const rand = rngFrom(o.seed ?? 20261020);
  const dec = (v: number[]): BotGenome => {
    const g = decode(v);
    return o.forbid ? { ...g, buy: g.buy.filter(b => !o.forbid!.includes(b.kind)) } : g;
  };
  const gauss = () => {
    const u = Math.max(rand(), 1e-12), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const S = scales();
  const mutate = (v: number[], sigma: number) => v.map((x, i) => x + gauss() * S[i] * sigma);
  const crossover = (a: number[], b: number[]) => a.map((x, i) => (rand() < 0.5 ? x : b[i]));

  const seeds = o.seeds.map(encode);
  let pop: number[][] = [...seeds];
  while (pop.length < o.pop) pop.push(mutate(seeds[pop.length % seeds.length], SIGMA * 2));
  const hallOfFame: BotGenome[] = [];
  let best = { v: seeds[0], score: -1 };

  for (let gen = 1; gen <= o.gens; gen++) {
    const opponents = [...o.opponents, ...hallOfFame];
    // 同じ世代では全個体に同じ乱数（同じ配り）を使い，公平に比べる
    const scored = pop
      .map(v => ({ v, score: evaluateGenome(dec(v), opponents, o.games, gen, [2, 3, 4], o.opts) }))
      .sort((a, b) => b.score - a.score);
    if (scored[0].score > best.score) best = scored[0];
    hallOfFame.push(dec(scored[0].v));
    if (hallOfFame.length > 4) hallOfFame.shift();
    const mean = scored.reduce((s, x) => s + x.score, 0) / scored.length;
    o.log?.(`世代${String(gen).padStart(3)}  最良 ${scored[0].score.toFixed(2)}  平均 ${mean.toFixed(2)}  `
      + `買う: ${dec(scored[0].v).buy.map(b => `${b.kind}×${b.cap}`).join(' ') || 'なし'}`);
    const elites = scored.slice(0, ELITE).map(x => x.v);
    const sigma = SIGMA * (1 - 0.6 * gen / o.gens); // 後半ほど細かく探す
    pop = [...elites];
    while (pop.length < o.pop) {
      const a = elites[Math.floor(rand() * elites.length)];
      const b = elites[Math.floor(rand() * elites.length)];
      pop.push(mutate(crossover(a, b), sigma));
    }
  }
  return { finalists: [dec(best.v), ...hallOfFame] };
}
