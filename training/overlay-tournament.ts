// 学習済みAI（軸ごと）の総当たり：npx tsx training/overlay-tournament.ts [試合数] [接尾辞 p1|p2]
// 学習済みAIだけの卓での勝率倍率（1.00 = 互角）をカードセット別に出し，固定型との対戦も見る
import { readFileSync } from 'node:fs';
import { marketFromChoice } from '../src/overlay/tiles';
import { OGenome, OPRESETS, playOverlayTurn } from '../src/overlay/bot';
import { newOverlayGame } from '../src/overlay/engine';
import { AXES } from './overlay-train';
import { rngFrom } from './common';

const GAMES = Number(process.argv[2] ?? 1200), SUFFIX = process.argv[3] ?? 'p2';
const AI: Record<string, OGenome> = {};
for (const a of Object.keys(AXES)) AI[a] = JSON.parse(readFileSync(`training/overlay-learned_${a}_${SUFFIX}.json`, 'utf8')).genome;
const FIXED = Object.fromEntries(Object.entries(OPRESETS).filter(([k]) => !k.startsWith('ai')));

function run(pool: Record<string, OGenome>, set: string, games: number, seed: number) {
  const names = Object.keys(pool), rand = rngFrom(seed);
  const win: Record<string, number> = {}, app: Record<string, number> = {};
  let rounds = 0, draws = 0;
  for (let g = 0; g < games; g++) {
    const n = 2 + (g % 3);
    const who = Array.from({ length: n }, () => names[Math.floor(rand() * names.length)]);
    const gs = who.map(w => pool[w]);
    const s = newOverlayGame(who.map((w, i) => ({ name: `${w}${i}`, isBot: true })), seed * 100003 + g * 7919 + 5, { market: marketFromChoice(set, rand) });
    while (s.phase === 'play') playOverlayTurn(s, gs);
    rounds += s.round; if (!s.winners.length) draws++;
    who.forEach(w => { app[w] = (app[w] ?? 0) + 1; });
    for (const i of s.winners) win[who[i]] = (win[who[i]] ?? 0) + n / s.winners.length;
  }
  return { mult: (w: string) => (win[w] ?? 0) / (app[w] || 1), rounds: rounds / games, draws: draws / games };
}
const f2 = (x: number) => x.toFixed(2);
const sets = ['intro', 'light', 'swing', 'all'];
console.log(`## 学習済みAI（${SUFFIX}）だけの卓の勝率倍率（${GAMES}試合/セット）\n| 軸 | ${sets.join(' | ')} | 平均 |\n|---|${sets.map(() => '---|').join('')}---|`);
const R = sets.map((st, i) => run(AI, st, GAMES, 40 + i));
for (const a of Object.keys(AI)) console.log(`| ${AXES[a].label}(${a}) | ${R.map(r => f2(r.mult(a))).join(' | ')} | ${f2(R.reduce((x, r) => x + r.mult(a), 0) / R.length)} |`);
console.log(`平均ラウンド ${R.map(r => f2(r.rounds)).join(' / ')}，引分 ${R.map(r => Math.round(100 * r.draws) + '%').join(' / ')}`);
console.log(`\n## 学習済みAI＋固定6型の卓（all，${GAMES}試合）`);
const M = run({ ...AI, ...Object.fromEntries(Object.entries(FIXED).map(([k, v]) => ['固定:' + k, v])) }, 'all', GAMES, 77);
for (const k of [...Object.keys(AI), ...Object.keys(FIXED).map(k => '固定:' + k)]) console.log(`| ${k} | ${f2(M.mult(k))} |`);
