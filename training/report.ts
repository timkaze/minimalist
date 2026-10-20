// 間取りごとのまとめ：npx tsx training/report.ts [試合数]
// おすすめの間取りそれぞれで，プリセット（＋学習済み）を混ぜた2〜4人卓を回し，
// ゲームの長さ・引き分け・1人あたりの購入枚数・紙袋が買われたゲームの割合・段ボールが開く時期・
// 各戦略の勝率倍率（1.00 = 公平）を表にする

import { CARDS } from '../src/engine/cards';
import { FLOORS, RECOMMENDED_FLOORS } from '../src/engine/floors';
import { newGame } from '../src/engine/game';
import { BotGenome, PRESETS, learnedFor } from '../src/bot/bot';
import { playBotTurn } from '../src/bot/runner';
import { rngFrom } from './common';

const GAMES = Number(process.argv[2] ?? 600);
const avg = (a: number[] = []) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-');

const header = ['間取り', '平均ラウンド', '引分', '購入/人', 'ドロー/手番', '紙袋が出たゲーム', '段ボールが開く平均ラウンド', '勝率倍率'];
console.log(`| ${header.join(' | ')} |`);
console.log(`|${header.map(() => '---').join('|')}|`);
for (const floor of RECOMMENDED_FLOORS) {
  const pool: Record<string, BotGenome> = Object.fromEntries(Object.entries(PRESETS).filter(([k]) => k !== 'nobuy'));
  const learned = learnedFor(floor);
  if (learned) pool.learned = learned;
  pool.nobuy = PRESETS.nobuy;
  const names = Object.keys(pool);
  const thresholds = [...new Set(Object.values(FLOORS[floor].locks))].sort((a, b) => a - b);
  const rand = rngFrom(17);
  const win: Record<string, number> = {}, app: Record<string, number> = {};
  const rounds: number[] = [], buys: number[] = [];
  const unlock: Record<number, number[]> = {};
  let draws = 0, bag = 0, drawn = 0, turns = 0;
  for (let g = 0; g < GAMES; g++) {
    const n = 2 + (g % 3);
    const who = Array.from({ length: n }, () => names[Math.floor(rand() * names.length)]);
    const gs = who.map(w => pool[w]);
    const s = newGame(who.map((w, i) => ({ name: `${w}${i}`, isBot: true })), g * 7919 + 3, { floor });
    const seen = new Set<string>();
    while (s.phase === 'play') {
      const seat = s.current;
      playBotTurn(s, gs);
      turns++;
      for (const t of thresholds) {
        if (s.players[seat].removed >= t && !seen.has(`${t}-${seat}`)) {
          seen.add(`${t}-${seat}`);
          (unlock[t] ??= []).push(s.round);
        }
      }
    }
    rounds.push(s.round);
    for (const l of s.log) { const m = l.match(/を置いて(\d+)枚引いた/); if (m) drawn += Number(m[1]); }
    s.players.forEach(p => buys.push(p.bought));
    if (s.market.BAG < Math.max(2, n)) bag++;
    who.forEach(w => { app[w] = (app[w] ?? 0) + 1; });
    if (!s.winners.length) { draws++; continue; }
    for (const i of s.winners) win[who[i]] = (win[who[i]] ?? 0) + n / s.winners.length;
  }
  const ratios = names.map(w => `${w} ${((win[w] ?? 0) / app[w]).toFixed(2)}`).join(' / ');
  console.log(`| ${FLOORS[floor].label} | ${avg(rounds)} | ${Math.round(100 * draws / GAMES)}% | ${avg(buys)} | ${(drawn / turns).toFixed(2)} | `
    + `${Math.round(100 * bag / GAMES)}% | ${thresholds.map(t => `${t}枚:${avg(unlock[t])}`).join(' ')} | ${ratios} |`);
}
console.log(`\n（各間取り ${GAMES} 試合，2〜4人．${CARDS.BAG.name}のコスト ${CARDS.BAG.cost}）`);
