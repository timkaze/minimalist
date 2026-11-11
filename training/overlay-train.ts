// オーバーレイ版ボットの学習（進化戦略）：npx tsx training/overlay-train.ts [世代数] [個体数] [試合数]
// 環境変数：AXIS=軸の名前（free/fav/light/clean/swing/rush）  SEED=1  OUT=training/overlay-learned_free_1.json
//          EXTRA=学習済みjson,...（相手に加える＝共進化）
// 遺伝子 = 市場の各タイルの優先度と上限枚数＋greed．「軸」は買ってよいタイルの範囲（買い方の系統）で，軸ごとに性格の違うAIができる．
// 適応度 = 固定の型と学習済みの型を相手にした2〜4人卓での勝率倍率．市場は入門・身軽・往復・すべてを混ぜて，どのセットでも強くする．

import { readFileSync, writeFileSync } from 'node:fs';
import { MARKET, OKind, PERMS, isPerm, marketFromChoice } from '../src/overlay/tiles';
import { OGenome, OPRESETS, playOverlayTurn } from '../src/overlay/bot';
import { newOverlayGame } from '../src/overlay/engine';
import { rngFrom } from './common';

/** 軸＝買ってよいタイル．ここに無いタイルは買わない（片付けたいは全軸で買える） */
export const AXES: Record<string, { label: string; allow: OKind[] }> = {
  free:  { label: '万能', allow: [...MARKET] },
  fav:   { label: 'お気に入り重視', allow: ['DOWN', 'RUSH', 'UP2', 'BR', 'REST', 'CALM', 'DOWN2', ...PERMS] },
  light: { label: '身軽・道連れ', allow: ['DOWN', 'BR', 'BREATH', 'RUSH', 'CALM', 'DOWN2', 'LIGHT', 'DRAG', 'REST', 'TREAT'] },
  clean: { label: '大掃除', allow: ['DOWN', 'BR', 'BREATH', 'UP2', 'RUSH', 'REST', 'TREAT', 'CLEAN', 'DOWN2', 'CALM', 'BIGDAY', 'BAG'] },
  swing: { label: '往復', allow: ['DOWN', 'SWING', 'FREE', 'MEMO', 'UP2', 'RUSH', 'DOWN2', 'TREAT', 'CLEAN', 'COMPASS'] },
  rush:  { label: '速攻（安いタイルだけ）', allow: ['DOWN', 'BR', 'BREATH', 'UP2', 'RUSH', 'CALM', 'REST', 'TREAT'] },
};
const TRAIN_SETS = ['intro', 'light', 'swing', 'all'];

const GENS = Number(process.argv[2] ?? 15), POP = Number(process.argv[3] ?? 16), GAMES = Number(process.argv[4] ?? 80);
const AXIS = process.env.AXIS ?? 'free';
const SEED = Number(process.env.SEED ?? 1);
const OUT = process.env.OUT ?? `training/overlay-learned_${AXIS}_${SEED}.json`;
const ALLOW = AXES[AXIS].allow;
const KINDS = MARKET.filter(k => ALLOW.includes(k));
const loadGenome = (f: string) => JSON.parse(readFileSync(f, 'utf8')).genome as OGenome;
const OPP: OGenome[] = [...Object.values(OPRESETS), ...(process.env.EXTRA ?? '').split(',').filter(Boolean).map(loadGenome)];

// ベクトル：[優先度, 上限] × タイル数 + greed
export const VEC = KINDS.length * 2 + 1;
export function decode(v: number[]): OGenome {
  const ks = KINDS.map((k, i) => ({ kind: k, pr: v[i * 2], cap: Math.max(0, Math.min(isPerm(k) ? 1 : 3, Math.round(v[i * 2 + 1]))) })).filter(x => x.cap >= 1);
  ks.sort((a, b) => b.pr - a.pr);
  return { greed: Math.max(0.5, Math.min(1.6, v[VEC - 1])), buy: ks.map(x => ({ kind: x.kind, cap: x.cap })) };
}
export function encode(g: OGenome): number[] {
  const v: number[] = [];
  for (const k of KINDS) {
    const i = g.buy.findIndex(b => b.kind === k);
    v.push(i >= 0 ? 10 - i : 0, i >= 0 ? g.buy[i].cap : 0);
  }
  v.push(g.greed);
  return v;
}

/** genome 1人 + 相手の型で卓を作り，genome の勝率倍率を返す */
export function evalGenome(g: OGenome, games: number, seed: number, opp: OGenome[] = OPP): number {
  const rand = rngFrom(seed);
  let win = 0, app = 0;
  for (let i = 0; i < games; i++) {
    const n = 2 + (i % 3);
    const gs = [g, ...Array.from({ length: n - 1 }, () => opp[Math.floor(rand() * opp.length)])];
    const seat = i % n; [gs[0], gs[seat]] = [gs[seat], gs[0]];
    const set = TRAIN_SETS[i % TRAIN_SETS.length];
    const s = newOverlayGame(gs.map((_, j) => ({ name: `P${j}`, isBot: true })), seed * 1000 + i * 7919 + 3, { market: marketFromChoice(set, rand) });
    while (s.phase === 'play') playOverlayTurn(s, gs);
    app++;
    if (s.winners.includes(seat)) win += n / s.winners.length;
  }
  return win / app;
}

if (process.argv[1]?.endsWith('overlay-train.ts')) {
  const rand = rngFrom(SEED);
  const gauss = () => { let a = 0; for (let i = 0; i < 6; i++) a += rand(); return a - 3; };
  const seeds = OPP.map(encode);
  let pop = Array.from({ length: POP }, (_, i) => seeds[i % seeds.length].map((x, j) => x + (i >= seeds.length ? gauss() * (j === VEC - 1 ? 0.15 : 1.2) : 0)));
  let best = { v: pop[0], f: -1 };
  for (let gen = 0; gen < GENS; gen++) {
    const scored = pop.map(v => ({ v, f: evalGenome(decode(v), GAMES, SEED * 100 + gen) })).sort((a, b) => b.f - a.f);
    if (scored[0].f > best.f || gen === 0) best = scored[0];
    console.log(`gen ${gen + 1}: best ${scored[0].f.toFixed(2)} avg ${(scored.reduce((a, b) => a + b.f, 0) / scored.length).toFixed(2)}`);
    const elite = scored.slice(0, Math.max(3, POP >> 2)).map(x => x.v);
    pop = [...elite, ...Array.from({ length: POP - elite.length }, () => {
      const p = elite[Math.floor(rand() * elite.length)];
      return p.map((x, j) => x + gauss() * (j === VEC - 1 ? 0.1 : 0.8));
    })];
  }
  // 最終：新しい乱数で多めに再評価
  const finalists = [best.v, ...pop.slice(0, 3)].map(v => ({ v, f: evalGenome(decode(v), 400, 9999) })).sort((a, b) => b.f - a.f);
  const g = decode(finalists[0].v);
  console.log(`最終（400試合，新乱数）勝率倍率 ${finalists[0].f.toFixed(2)}`);
  console.log(g.buy.map(b => `${b.kind}×${b.cap}`).join(' '), `greed ${g.greed.toFixed(2)}`);
  writeFileSync(OUT, JSON.stringify({ axis: AXIS, fitness: finalists[0].f, genome: g }, null, 1));
  console.log('保存', OUT);
}
