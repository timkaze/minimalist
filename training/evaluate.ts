// 戦略ごとの強さを表示する：npm run evaluate [-- 試合数]（間取りは環境変数 FLOOR）
// 各戦略を1席に置き，残りの席にプリセットをランダムに置いたときの勝率倍率（1.0 = 公平）

import { BotGenome, PRESETS, learnedFor } from '../src/bot/bot';
import { FLOOR, PRESET_LIST, evaluateGenome } from './common';

const games = Number(process.argv[2] ?? 400);
const all: Record<string, BotGenome> = { ...PRESETS };
const learned = learnedFor(FLOOR);
if (learned) all.learned = learned;

console.log(`${FLOOR}  各 ${games} 試合（相手は買わない型以外のプリセットからランダム）`);
for (const n of [2, 3, 4, 5, 6]) {
  const row = Object.entries(all)
    .map(([name, g]) => `${name}:${evaluateGenome(g, PRESET_LIST, games, 12345 + n, [n]).toFixed(2)}`);
  console.log(`${n}人  ${row.join('  ')}`);
}
