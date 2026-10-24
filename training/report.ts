// 間取りごとのまとめ：npx tsx training/report.ts [試合数]
// おすすめの間取りそれぞれで，プリセット（＋学習済み・取得しない型）を混ぜた2〜4人卓を回し，
// ゲームの長さ・引き分け・1人あたりの取得枚数・1手番あたりのドロー・行き先の内訳・レベル3が取得されたゲームの割合・
// 各戦略の勝率倍率（1.00 = 公平）を表にする

import { CARDS, CardKind } from '../src/engine/cards';
import { FLOORS, RECOMMENDED_FLOORS } from '../src/engine/floors';
import { newGame } from '../src/engine/game';
import { BotGenome, PRESETS, learnedFor } from '../src/bot/bot';
import { playBotTurn } from '../src/bot/runner';
import { rngFrom } from './common';

const GAMES = Number(process.argv[2] ?? 600);
const avg = (a: number[] = []) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-');

const header = ['間取り', '平均ラウンド', '引分', '取得/人', 'ドロー/手番', '行き先（取得/排除/なし）', 'レベル3が出たゲーム', '勝率倍率'];
console.log(`| ${header.join(' | ')} |`);
console.log(`|${header.map(() => '---').join('|')}|`);
for (const floor of RECOMMENDED_FLOORS) {
  const pool: Record<string, BotGenome> = Object.fromEntries(Object.entries(PRESETS).filter(([k]) => k !== 'nobuy'));
  const learned = learnedFor(floor);
  if (learned) pool.learned = learned;
  pool.nobuy = PRESETS.nobuy;
  const names = Object.keys(pool);
  const rand = rngFrom(17);
  const win: Record<string, number> = {}, app: Record<string, number> = {};
  const rounds: number[] = [], buys: number[] = [];
  const act = { buy: 0, drop: 0, none: 0 };
  let draws = 0, lv3 = 0, drawn = 0, turns = 0;
  for (let g = 0; g < GAMES; g++) {
    const n = 2 + (g % 3);
    const who = Array.from({ length: n }, () => names[Math.floor(rand() * names.length)]);
    const gs = who.map(w => pool[w]);
    const s = newGame(who.map((w, i) => ({ name: `${w}${i}`, isBot: true })), g * 7919 + 3, { floor });
    while (s.phase === 'play') {
      playBotTurn(s, gs);
      turns++;
    }
    rounds.push(s.round);
    for (const l of s.log) {
      const m = l.match(/を置いて(\d+)枚引いた/);
      if (m) drawn += Number(m[1]);
      else if (l.includes(' / 取得 ')) act.buy++;
      else if (l.includes('枚排除')) act.drop++;
      else if (l.includes('取得・排除なし') || l.includes('行き先')) act.none++;
    }
    s.players.forEach(p => buys.push(p.bought));
    if ((Object.keys(s.market) as CardKind[]).some(k => CARDS[k].level === 3 && s.market[k] < Math.max(2, n))) lv3++;
    who.forEach(w => { app[w] = (app[w] ?? 0) + 1; });
    if (!s.winners.length) { draws++; continue; }
    for (const i of s.winners) win[who[i]] = (win[who[i]] ?? 0) + n / s.winners.length;
  }
  const ratios = names.map(w => `${w} ${((win[w] ?? 0) / app[w]).toFixed(2)}`).join(' / ');
  const total = act.buy + act.drop + act.none;
  const pct = (x: number) => Math.round(100 * x / total);
  console.log(`| ${FLOORS[floor].label} | ${avg(rounds)} | ${Math.round(100 * draws / GAMES)}% | ${avg(buys)} | ${(drawn / turns).toFixed(2)} | `
    + `${pct(act.buy)}% / ${pct(act.drop)}% / ${pct(act.none)}% | ${Math.round(100 * lv3 / GAMES)}% | ${ratios} |`);
}
console.log(`\n（各間取り ${GAMES} 試合，2〜4人）`);
