// 間取りごとにボットを学習させてから比べる：CAND=0 npx tsx training/floor-train.ts [世代数 個体数 試合数]
// floor-lab.ts はプリセット（ワンルームで学習した買い方）で比べるが，間取りが大きく違うと買い方も変わるので，
// その間取りで「何でも買える」系統と「引くカードを買わない」系統を学習させて戦わせる．
//   自由 ≫ 引かない：デッキを組まないと勝てない（構築の要求値が高い）
// あわせて，ゲームの長さ・購入枚数・何も買わない型の勝率倍率を表示する

import { CARDS, CardKind } from '../src/engine/cards';
import { FLOORS, parseFloor } from '../src/engine/floors';
import { BotGenome, PRESETS } from '../src/bot/bot';
import { playBotGame } from '../src/bot/runner';
import { PRESET_LIST, evaluateGenome, rngFrom } from './common';
import { evolve } from './evolve';

const GENS = Number(process.argv[2] ?? 10);
const POP = Number(process.argv[3] ?? 14);
const GAMES = Number(process.argv[4] ?? 50);

// rows：間取り，rowValues：捨欲の目盛り（省略時は行番号）
export const CANDIDATES: Record<string, { rows: string[]; rowValues?: number[] }> = {
  'ワンルーム': { rows: [
    'S . . 4 6',
    '. . . 4 6',
    '. # . 4 6',
    '4 4 4 # 6',
    '6 6 6 6 G',
  ] },
  '廊下のある部屋': { rows: [
    'S . . . 4 6',
    '# . . . 4 6',
    '# # # . 4 6',
    '# # # # 6 6',
    '# # # # 6 G',
  ] },
  '目盛りA（捨欲 0,0,1,1,2,3,4）': { rows: [
    'S . . 4 6',
    '. . . 4 6',
    '. # . 4 6',
    '. . . 4 6',
    '. . . # 6',
    '4 4 4 4 6',
    '6 6 6 6 G',
  ], rowValues: [0, 0, 1, 1, 2, 3, 4] },
  '目盛りB（捨欲 0,1,1,2,3,4）': { rows: [
    'S . . 4 6',
    '. . . 4 6',
    '. # . 4 6',
    '. . . # 6',
    '4 4 4 4 6',
    '6 6 6 6 G',
  ], rowValues: [0, 1, 1, 2, 3, 4] },
};

const DRAW_KINDS = (Object.keys(CARDS) as CardKind[]).filter(k => CARDS[k].draw > 0);
const label = Object.keys(CANDIDATES)[Number(process.env.CAND ?? 0)];
const key = 'lab';
FLOORS[key] = parseFloor(key, label, CANDIDATES[label].rows, { rowValues: CANDIDATES[label].rowValues });
const opts = { floor: key };

const lines: { name: string; forbid: CardKind[] }[] = [
  { name: '自由', forbid: [] },
  { name: '引かない', forbid: DRAW_KINDS },
];
// MARKET_ADD で市場に加えたカード（例：X）を買わない系統も比べる
const added = (process.env.MARKET_ADD ?? '').split(',').filter(Boolean) as CardKind[];
if (added.length) lines.push({ name: `${added.map(k => CARDS[k].name).join('・')}なし`, forbid: added });
const champs: { name: string; g: BotGenome }[] = [];
for (const line of lines) {
  const { finalists } = evolve({
    gens: GENS, pop: POP, games: GAMES, seeds: PRESET_LIST, opponents: PRESET_LIST, opts, forbid: line.forbid,
  });
  const best = finalists
    .map(g => ({ g, s: evaluateGenome(g, PRESET_LIST, GAMES * 6, 999, [2, 3, 4], opts) }))
    .sort((a, b) => b.s - a.s)[0];
  champs.push({ name: line.name, g: best.g });
}
champs.push({ name: '買わない', g: PRESETS.nobuy });

// 学習した系統どうし（＋プリセット）の混合卓
const pool = [...champs, ...champs, ...PRESET_LIST.map((g, i) => ({ name: `preset${i}`, g }))];
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
console.log(`${label}  平均${(rounds / N).toFixed(1)}R  引分${Math.round(100 * draws / N)}%`);
for (const c of champs) {
  console.log(`  ${c.name.padEnd(6)} 倍率 ${r(c.name)}  購入 ${(bought[c.name] / app[c.name]).toFixed(1)}  買い方 ${c.g.buy.map(b => `${CARDS[b.kind].name}×${b.cap}`).join('・') || 'なし'}`);
}
console.log(`  プリセット ${PRESET_LIST.map((_, i) => r(`preset${i}`)).join(' ')}`);
console.log('JSON ' + JSON.stringify(Object.fromEntries(champs.map(c => [c.name, c.g]))));
