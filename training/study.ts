// ルール案の検証：npx tsx training/study.ts <初期デッキ> [間取り] [世代数 個体数 試合数]
//   初期デッキの書き方：'R×3 D×3 RD×1 J×2 X×1'
// 1. プリセット（買わない型を含む）の勝率倍率 → 「買わない型」が低いほど，買う意味がある
// 2. 進化戦略で学習したボットが何を買うか・プリセットにどれだけ勝つか → 突出して勝つなら支配的な戦略がある
// 3. ゲームの長さ，段ボールが開く時期，紙袋が買われる割合
// 結果は1行の JSON でも出す（複数の案をまとめて比べるため）

import { CARDS, CardKind, Deck, RULE } from '../src/engine/cards';
import { FLOORS } from '../src/engine/floors';
import { GameOptions, newGame } from '../src/engine/game';
import { BotGenome, PRESETS } from '../src/bot/bot';
import { playBotTurn } from '../src/bot/runner';
import { PRESET_LIST, evaluateGenome, rngFrom } from './common';
import { evolve } from './evolve';

const deckSpec = process.argv[2] ?? 'R×3 D×3 RD×1 J×2 X×1';
const floor = process.argv[3] ?? 'grow';
const GENS = Number(process.argv[4] ?? 15);
const POP = Number(process.argv[5] ?? 20);
const GAMES = Number(process.argv[6] ?? 60);

// 粗大ごみの扱い（環境変数 BULKY=double|goal）
if (process.env.BULKY === 'goal' || process.env.BULKY === 'double') RULE.bulky = process.env.BULKY;

const deck: Deck = deckSpec.split(' ').map(t => {
  const [kind, n] = t.split('×');
  return { kind: kind as CardKind, count: Number(n) };
});
const opts: GameOptions = { deck, floor };
const size = deck.reduce((n, d) => n + d.count, 0);
const showBuy = (g: BotGenome) => g.buy.map(b => `${CARDS[b.kind].name}×${b.cap}`).join('・') || 'なし';

// 1. プリセットの勝率倍率
const presetRatio = Object.fromEntries(Object.entries(PRESETS).map(([name, g]) =>
  [name, evaluateGenome(g, PRESET_LIST, 400, 4242, [2, 3, 4], opts)]));

// 2. 学習
const { finalists } = evolve({ gens: GENS, pop: POP, games: GAMES, seeds: PRESET_LIST, opponents: PRESET_LIST, opts });
const ranked = finalists
  .map(g => ({ g, score: evaluateGenome(g, PRESET_LIST, GAMES * 8, 999, [2, 3, 4, 5, 6], opts) }))
  .sort((a, b) => b.score - a.score);
const champ = ranked[0];

// 3. 学習ボット＋プリセットの卓でゲームの様子を見る
const rand = rngFrom(5);
const thresholds = [...new Set(Object.values(FLOORS[floor].locks))].sort((a, b) => a - b);
const unlock: Record<number, number[]> = {};
let rounds = 0, bagGames = 0, buys = 0, seats = 0, draws = 0;
const N = 300;
for (let i = 0; i < N; i++) {
  const n = 2 + (i % 3);
  const gs = Array.from({ length: n }, (_, j) => (j === 0 ? champ.g : PRESET_LIST[Math.floor(rand() * PRESET_LIST.length)]));
  const s = newGame(gs.map((_, j) => ({ name: `P${j}`, isBot: true })), i + 1, opts);
  const seen = new Set<string>();
  while (s.phase === 'play') {
    const seat = s.current;
    playBotTurn(s, gs);
    for (const t of thresholds) {
      if (s.players[seat].removed >= t && !seen.has(`${t}-${seat}`)) {
        seen.add(`${t}-${seat}`);
        (unlock[t] ??= []).push(s.round);
      }
    }
  }
  rounds += s.round;
  if (s.winners.length === 0) draws++;
  if (s.market.BAG < Math.max(2, n)) bagGames++;
  s.players.forEach(p => { buys += p.bought; seats++; });
}
// 強い学習ボットに対して「何も買わない」はどれだけ戦えるか（低いほど，買う＝デッキ構築が大事）
const nobuyVsChamp = evaluateGenome(PRESETS.nobuy, [champ.g], 400, 777, [2, 3, 4], opts);
// 学習ボットの1手番あたりのドロー枚数・1ゲームあたりの購入枚数（学習ボットどうしの卓）
let drawn = 0, turns = 0, champBuys = 0;
for (let i = 0; i < 200; i++) {
  const n = 2 + (i % 3);
  const s = newGame(Array.from({ length: n }, (_, j) => ({ name: `L${j}`, isBot: true })), 3000 + i, opts);
  while (s.phase === 'play') { playBotTurn(s, Array(n).fill(champ.g)); turns++; }
  for (const l of s.log) { const m = l.match(/を置いて(\d+)枚引いた/); if (m) drawn += Number(m[1]); }
  champBuys += s.players.reduce((a, p) => a + p.bought, 0) / n;
}
const avg = (a: number[] = []) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
const result = {
  deck: deckSpec, size, floor, bulky: RULE.bulky,
  presets: Object.fromEntries(Object.entries(presetRatio).map(([k, v]) => [k, +v.toFixed(2)])),
  learnedScore: +champ.score.toFixed(2), learnedBuy: showBuy(champ.g),
  secondBuy: ranked[1] ? `${showBuy(ranked[1].g)}(${ranked[1].score.toFixed(2)})` : null,
  rounds: +(rounds / N).toFixed(1), drawPct: Math.round(100 * draws / N), buysPerPlayer: +(buys / seats).toFixed(1),
  bagGamePct: Math.round(100 * bagGames / N),
  unlock: Object.fromEntries(thresholds.map(t => [t, avg(unlock[t])])),
  nobuyVsChamp: +nobuyVsChamp.toFixed(2), drawsPerTurn: +(drawn / turns).toFixed(2), champBuysPerGame: +(champBuys / 200).toFixed(1),
  learned: champ.g,
};
console.log(`== ${deckSpec}（${size}枚）・${FLOORS[floor].label}・粗大ごみ=${RULE.bulky}`);
console.log(`   プリセット  ${Object.entries(result.presets).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`   学習ボット ${result.learnedScore}  買い方：${result.learnedBuy}   2位：${result.secondBuy}`);
console.log(`   平均 ${result.rounds} ラウンド  引分 ${result.drawPct}%  1人あたり購入 ${result.buysPerPlayer} 枚  紙袋が買われたゲーム ${result.bagGamePct}%`);
console.log(`   学習ボットどうし：1人あたり購入 ${result.champBuysPerGame} 枚，1手番あたりドロー ${result.drawsPerTurn} 枚／学習ボット相手の「買わない型」${result.nobuyVsChamp}`);
console.log(`   段ボールが開く平均ラウンド ${thresholds.map(t => `${t}枚:${result.unlock[t]}`).join('  ')}`);
console.log('JSON ' + JSON.stringify(result));
