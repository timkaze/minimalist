// 強い戦略が1つだけか，いくつかの系統があるかを調べる：npx tsx training/archetypes.ts [世代数 個体数 試合数]
// 「何でも買える」「ハブなし」「台車なし」「通路なし」「紙袋なし」「台車・ハブなし」で別々に学習し，
// それぞれの最強個体どうし（＋プリセット）を同じ卓で戦わせる．
// 全部が1.0前後なら，系統の違う戦略が並び立っている（＝支配的な戦略がない）

import { writeFileSync } from 'node:fs';
import { CARDS, CardKind } from '../src/engine/cards';
import { BotGenome } from '../src/bot/bot';
import { playBotGame } from '../src/bot/runner';
import { GAME_OPTS, PRESET_LIST, evaluateGenome, rngFrom } from './common';
import { evolve } from './evolve';

const GENS = Number(process.argv[2] ?? 15);
const POP = Number(process.argv[3] ?? 20);
const GAMES = Number(process.argv[4] ?? 60);
const OUT = process.argv[5];

// 環境変数 LINES="自由:;台車なし:R+;台車・ハブなし:R+,RD2" で系統を変えられる
const LINES: { name: string; forbid: CardKind[] }[] = process.env.LINES
  ? process.env.LINES.split(';').map(l => {
    const [name, f = ''] = l.split(':');
    return { name, forbid: f.split(',').filter(Boolean) as CardKind[] };
  })
  : [
    { name: '自由', forbid: [] },
    { name: 'ハブなし', forbid: ['RD2'] },
    { name: '台車なし', forbid: ['R+'] },
    { name: '通路なし', forbid: ['D+'] },
    { name: '紙袋なし', forbid: ['BAG'] },
    { name: '台車・ハブなし', forbid: ['R+', 'RD2'] },
  ];

const champs: { name: string; g: BotGenome }[] = [];
for (const line of LINES) {
  const { finalists } = evolve({
    gens: GENS, pop: POP, games: GAMES, seeds: PRESET_LIST, opponents: PRESET_LIST, opts: GAME_OPTS, forbid: line.forbid,
  });
  const best = finalists
    .map(g => ({ g, s: evaluateGenome(g, PRESET_LIST, GAMES * 8, 999, [2, 3, 4, 5, 6]) }))
    .sort((a, b) => b.s - a.s)[0];
  champs.push({ name: line.name, g: best.g });
  console.log(`${line.name}：プリセットに ${best.s.toFixed(2)}  買い方 ${best.g.buy.map(b => `${CARDS[b.kind].name}×${b.cap}`).join('・') || 'なし'}`);
}

// 系統どうしの総当たり（各卓に系統をランダムに座らせる）
const rand = rngFrom(31);
const win: Record<string, number> = {}, app: Record<string, number> = {};
for (let i = 0; i < 1500; i++) {
  const n = 2 + (i % 3);
  const seat = Array.from({ length: n }, () => champs[Math.floor(rand() * champs.length)]);
  const s = playBotGame(seat.map(c => c.g), 5000 + i, GAME_OPTS);
  seat.forEach(c => { app[c.name] = (app[c.name] ?? 0) + 1; });
  for (const w of s.winners) win[seat[w].name] = (win[seat[w].name] ?? 0) + n / s.winners.length;
}
console.log('系統どうしの勝率倍率  ' + champs.map(c => `${c.name}:${((win[c.name] ?? 0) / app[c.name]).toFixed(2)}`).join('  '));
if (OUT) writeFileSync(OUT, JSON.stringify(Object.fromEntries(champs.map(c => [c.name, c.g])), null, 1));
