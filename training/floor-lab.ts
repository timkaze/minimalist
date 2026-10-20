// 間取りの試作を比べる：npx tsx training/floor-lab.ts [試合数]
// 下の CANDIDATES に間取りを書くと，プリセットと「買わない型」の勝率倍率・ゲームの長さ・購入枚数などを表示する．
// 目安：買わない型 0.8 以下（買う意味がある），プリセットどうし 0.7〜1.3，8〜11 ラウンド

import { FLOORS, parseFloor } from '../src/engine/floors';
import { newGame } from '../src/engine/game';
import { BotGenome, PRESETS } from '../src/bot/bot';
import { playBotTurn } from '../src/bot/runner';
import { rngFrom } from './common';

const GAMES = Number(process.argv[2] ?? 400);

const CANDIDATES: Record<string, string[]> = {
  'ワンルーム': [
    'S . . 4 6',
    '. . . 4 6',
    '. # . 4 6',
    '4 4 4 # 6',
    '6 6 6 6 G',
  ],
  'やさしい部屋': [
    'S . . 4 6',
    '. . . 4 6',
    '. . . 4 6',
    '4 4 4 # 6',
    '6 6 6 6 G',
  ],
  '柱A（3列2行・2列3行・4列3行）': [
    'S . . 4 6',
    '. . # 4 6',
    '. # . # 6',
    '4 . 4 4 #',
    '6 6 6 6 G',
  ],
  '柱B（3列3行・4列2行）': [
    'S . . 4 6',
    '. . . # 6',
    '. . # 4 6',
    '4 # 4 4 #',
    '6 6 6 6 G',
  ],
  '物置A（横長・2列3行）': [
    'S . . 4 6 6',
    '. . . 4 6 6',
    '. # . # 6 6',
    '4 4 4 4 6 G',
  ],
  '物置B（3×3が狭い：3行目は4枚から）': [
    'S . . 4 6',
    '. . . 4 6',
    '4 # 4 4 6',
    '4 4 4 # 6',
    '6 6 6 6 G',
  ],
};

const pool: Record<string, BotGenome> = { ...PRESETS };
const names = Object.keys(pool);
for (const [label, lines] of Object.entries(CANDIDATES)) {
  const key = `lab${Object.keys(FLOORS).length}`;
  FLOORS[key] = parseFloor(key, label, lines);
  const rand = rngFrom(23);
  const win: Record<string, number> = {}, app: Record<string, number> = {};
  let rounds = 0, buys = 0, seats = 0, draws = 0, goal = 0;
  for (let g = 0; g < GAMES; g++) {
    const n = 2 + (g % 3);
    const who = Array.from({ length: n }, () => names[Math.floor(rand() * names.length)]);
    const gs = who.map(w => pool[w]);
    const s = newGame(who.map((w, i) => ({ name: `${w}${i}`, isBot: true })), g * 7919 + 9, { floor: key });
    while (s.phase === 'play') {
      const seat = s.current;
      playBotTurn(s, gs);
      if (s.log.some(l => l.includes('無制限') && l.startsWith(s.players[seat].name))) goal++;
    }
    rounds += s.round;
    s.players.forEach(p => { buys += p.bought; seats++; });
    who.forEach(w => { app[w] = (app[w] ?? 0) + 1; });
    if (!s.winners.length) { draws++; continue; }
    for (const i of s.winners) win[who[i]] = (win[who[i]] ?? 0) + n / s.winners.length;
  }
  const r = (w: string) => ((win[w] ?? 0) / app[w]).toFixed(2);
  console.log(`${label.padEnd(22)} ${(rounds / GAMES).toFixed(1)}R 引分${Math.round(100 * draws / GAMES)}% 購入${(buys / seats).toFixed(1)} 無制限${(goal / seats).toFixed(2)}回/人  `
    + names.map(w => `${w}:${r(w)}`).join(' '));
}
