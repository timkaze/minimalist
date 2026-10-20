// 新しいカードの候補を試す：MARKET_ADD=ST npx tsx training/card-lab.ts [世代数 個体数 試合数]
// 候補カード C を市場に加え，「何でも買える」系統と「C を買わない」系統を別々に学習して同じ卓で戦わせる．
//   C あり ≫ C なし：C が強すぎる（コストを上げる）
//   C あり ≒ C なし で，C ありが C を買っている：別の戦略として成り立っている
//   C ありが C を買わない：弱すぎる
// あわせて「何も買わない型」の勝率倍率と，C を買った系統の購入枚数・ゲームの長さも表示する

import { CARDS, CardKind, MARKET_KINDS } from '../src/engine/cards';
import { BotGenome, PRESETS } from '../src/bot/bot';
import { playBotGame } from '../src/bot/runner';
import { GAME_OPTS, PRESET_LIST, evaluateGenome, rngFrom } from './common';
import { evolve } from './evolve';

const GENS = Number(process.argv[2] ?? 12);
const POP = Number(process.argv[3] ?? 16);
const GAMES = Number(process.argv[4] ?? 60);
const cand = (process.env.MARKET_ADD ?? '').split(',').filter(Boolean) as CardKind[];

const lines: { name: string; forbid: CardKind[] }[] = [
  { name: '自由', forbid: [] },
  ...(cand.length ? [{ name: `${cand.map(k => CARDS[k].name).join('・')}なし`, forbid: cand }] : []),
];
// 主流のカード（環境変数 CORE，既定は台車・ハブ）を使わずに，候補カードで別の戦略が組めるか
const core = (process.env.CORE ?? 'R+,RD2').split(',').filter(Boolean) as CardKind[];
if (cand.length && core.length) {
  const coreName = core.map(k => CARDS[k].name).join('・');
  lines.push({ name: `${coreName}なし`, forbid: core }, { name: `${coreName}なし・候補なし`, forbid: [...core, ...cand] });
}

const champs: { name: string; g: BotGenome }[] = [];
for (const line of lines) {
  const { finalists } = evolve({
    gens: GENS, pop: POP, games: GAMES, seeds: PRESET_LIST, opponents: PRESET_LIST, opts: GAME_OPTS, forbid: line.forbid,
  });
  const best = finalists
    .map(g => ({ g, s: evaluateGenome(g, PRESET_LIST, GAMES * 6, 999, [2, 3, 4, 5, 6]) }))
    .sort((a, b) => b.s - a.s)[0];
  champs.push({ name: line.name, g: best.g });
}
champs.push({ name: '買わない', g: PRESETS.nobuy });

// 系統どうし＋プリセットの混合卓
const pool = [...champs, ...PRESET_LIST.map((g, i) => ({ name: `preset${i}`, g }))];
const rand = rngFrom(41);
const win: Record<string, number> = {}, app: Record<string, number> = {};
const bought: Record<string, number> = {}, used: Record<string, number> = {};
let rounds = 0;
const N = 1500;
for (let i = 0; i < N; i++) {
  const n = 2 + (i % 3);
  const seat = Array.from({ length: n }, () => pool[Math.floor(rand() * pool.length)]);
  const s = playBotGame(seat.map(c => c.g), 7000 + i, GAME_OPTS);
  rounds += s.round;
  seat.forEach((c, j) => {
    app[c.name] = (app[c.name] ?? 0) + 1;
    bought[c.name] = (bought[c.name] ?? 0) + s.players[j].bought;
  });
  for (const w of s.winners) win[seat[w].name] = (win[seat[w].name] ?? 0) + n / s.winners.length;
  // 候補カードが市場から減った数＝買われた枚数
  for (const k of cand) used[k] = (used[k] ?? 0) + (Math.max(2, n) - s.market[k]);
}
const r = (k: string) => ((win[k] ?? 0) / app[k]).toFixed(2);
console.log(`候補 ${cand.map(k => `${CARDS[k].name}(${CARDS[k].cost})`).join('・') || 'なし'}  市場 ${MARKET_KINDS.join(',')}  平均${(rounds / N).toFixed(1)}R`);
for (const c of champs) {
  console.log(`  ${c.name.padEnd(10)} 倍率 ${r(c.name)}  購入 ${(bought[c.name] / app[c.name]).toFixed(1)}  買い方 ${c.g.buy.map(b => `${CARDS[b.kind].name}×${b.cap}`).join('・') || 'なし'}`);
}
console.log(`  プリセット ${PRESET_LIST.map((_, i) => r(`preset${i}`)).join(' ')}  候補が買われた枚数/試合 ${cand.map(k => (used[k] / N).toFixed(2)).join(' ')}`);
