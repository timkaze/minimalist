// 初期デッキの案を比べる：DECK="U:1,R:3,D:1,J:1" npx tsx training/deck-lab.ts [世代数 個体数 試合数]
// その初期デッキで「何でも取得できる」系統を学習し，取得しない型・プリセットと同じ卓で戦わせる．
//   自由 ≫ 取得しない：デッキを組む意味がある
// あわせて，ゲームの長さ・引き分け・取得枚数を表示する

import { CARDS, CardKind, Deck } from '../src/engine/cards';
import { FLOORS, floorToSpec } from '../src/engine/floors';
import { BotGenome, PRESETS } from '../src/bot/bot';
import { playBotGame } from '../src/bot/runner';
import { GAME_OPTS, PRESET_LIST, evaluateGenome, rngFrom } from './common';
import { evolve } from './evolve';

const GENS = Number(process.argv[2] ?? 10);
const POP = Number(process.argv[3] ?? 16);
const GAMES = Number(process.argv[4] ?? 50);
const deck: Deck | undefined = process.env.DECK
  ? process.env.DECK.split(',').map(kv => { const [kind, n] = kv.split(':'); return { kind: kind as CardKind, count: Number(n) }; })
  : undefined;
// 間取りも試せる：BUDGETS="1,1,2,2,3,3,4,4"（標準の間取りの支払える額だけ変える）
const budgets = process.env.BUDGETS?.split(',').map(Number);
const custom = budgets ? { ...floorToSpec(FLOORS.standard), budgets } : undefined;
const opts = { ...GAME_OPTS, deck, custom };
const opponents = [...PRESET_LIST, PRESETS.nobuy];

const { finalists } = evolve({ gens: GENS, pop: POP, games: GAMES, seeds: PRESET_LIST, opponents, opts });
const best = finalists
  .map(g => ({ g, s: evaluateGenome(g, opponents, GAMES * 6, 999, [2, 3, 4], opts) }))
  .sort((a, b) => b.s - a.s)[0].g;

const pool: { name: string; g: BotGenome }[] = [
  { name: '自由', g: best }, { name: '自由', g: best }, { name: '取得しない', g: PRESETS.nobuy },
  ...PRESET_LIST.map((g, i) => ({ name: `preset${i}`, g })),
];
const rand = rngFrom(41);
const win: Record<string, number> = {}, app: Record<string, number> = {}, bought: Record<string, number> = {};
let rounds = 0, draws = 0;
const N = 900;
for (let i = 0; i < N; i++) {
  const n = 2 + (i % 3);
  const seat = Array.from({ length: n }, () => pool[Math.floor(rand() * pool.length)]);
  const s = playBotGame(seat.map(c => c.g), 7000 + i, opts);
  rounds += s.round;
  if (!s.winners.length) draws++;
  seat.forEach((c, j) => {
    app[c.name] = (app[c.name] ?? 0) + 1;
    bought[c.name] = (bought[c.name] ?? 0) + s.players[j].bought;
  });
  for (const w of s.winners) win[seat[w].name] = (win[seat[w].name] ?? 0) + n / s.winners.length;
}
const r = (k: string) => ((win[k] ?? 0) / app[k]).toFixed(2);
console.log(`初期デッキ ${process.env.DECK ?? '標準'}${budgets ? `  支払い ${budgets.join(',')}` : ''}  平均${(rounds / N).toFixed(1)}R  引分${Math.round(100 * draws / N)}%`);
console.log(`  自由 ${r('自由')}（取得${(bought['自由'] / app['自由']).toFixed(1)}）  取得しない ${r('取得しない')}  プリセット ${PRESET_LIST.map((_, i) => r(`preset${i}`)).join(' ')}`);
console.log(`  買い方 ${best.buy.map(b => `${CARDS[b.kind].name}×${b.cap}`).join('・') || 'なし'}`);
console.log('JSON ' + JSON.stringify(best));
