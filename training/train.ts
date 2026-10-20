// ボットの学習（進化戦略）：npm run train [-- 世代数 個体数 1個体あたりの試合数]
//
// 1. プリセットの方針を出発点に，パラメータを少しずつ変えた個体を作る
// 2. 各個体をプリセットや過去の強い個体と対戦させ，勝率倍率で順位をつける
// 3. 上位を残し，それらを混ぜたり変化させたりして次の世代を作る
// 4. 最後に，新しい乱数で多めに対戦させて確かめ，今の learned.json より強ければ上書きする

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import learnedAll from '../src/bot/learned.json';
import { BotGenome } from '../src/bot/bot';
import { GAME_OPTS, LEARNED_KEY, PRESET_LIST, VEC_LEN, evaluateGenome } from './common';
import { evolve } from './evolve';

const learnedMap = learnedAll as Record<string, BotGenome>;
const existing = learnedMap[LEARNED_KEY];

const GENS = Number(process.argv[2] ?? 30);
const POP = Number(process.argv[3] ?? 24);
const GAMES = Number(process.argv[4] ?? 80);

console.log(`学習開始：${GENS}世代 × ${POP}個体 × ${GAMES}試合（パラメータ${VEC_LEN}個，${LEARNED_KEY}）`);
const { finalists } = evolve({
  gens: GENS, pop: POP, games: GAMES,
  seeds: [...PRESET_LIST, ...(existing ? [existing] : [])],
  opponents: PRESET_LIST, opts: GAME_OPTS, log: console.log,
});

// 最終確認：新しい乱数・多めの試合数で，候補（各世代の上位）と現在の学習済みを比べる
const CHECK = GAMES * 10;
const currentScore = existing ? evaluateGenome(existing, PRESET_LIST, CHECK, 999, [2, 3, 4, 5, 6]) : -1;
let champion: { g: BotGenome | undefined; score: number } = { g: existing, score: currentScore };
for (const g of finalists) {
  const score = evaluateGenome(g, PRESET_LIST, CHECK, 999, [2, 3, 4, 5, 6]);
  if (score > champion.score) champion = { g, score };
}
console.log(`\n確認（${CHECK}試合，2〜6人）：今の学習済み ${existing ? currentScore.toFixed(2) : 'なし'} → 最良 ${champion.score.toFixed(2)}`);
if (champion.g && champion.g !== existing) {
  // 保存直前に読み直して合わせる（別の間取りの学習が並行して保存していても消さない）
  const path = fileURLToPath(new URL('../src/bot/learned.json', import.meta.url));
  const latest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, BotGenome>;
  latest[LEARNED_KEY] = champion.g;
  writeFileSync(path, JSON.stringify(latest, null, 1) + '\n');
  console.log(`src/bot/learned.json の「${LEARNED_KEY}」を更新しました`);
} else {
  console.log('今の学習済みより強い個体は見つからなかったので，更新しません');
}
console.log(JSON.stringify(champion.g));
