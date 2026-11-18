// V の買い方をロールアウトと照合する（改善方針の段階2・ボット強化仕様の3）：npx tsx training/overlay-rollout.ts [局面の数] [ロールアウトの回数]
//   MODEL=重みのパス（既定 src/overlay/value.json）  TOP=比べる候補の数（既定4）
// 自己対戦の「額のマスで止まった」局面を集め，V の点数が高い候補それぞれについて，買ったあとを同じボットで最後まで1人で遊ばせる．
// 終わるまでの手番数の平均が一番小さい候補を「ロールアウトの答え」として，V の答えと比べる．
//   ・一致率：V の1位がロールアウトの1位と同じ局面の割合
//   ・損：V の1位のかわりにロールアウトの1位を選んでいたら何手番早かったか（半分のロールアウトで選び，残り半分で測る＝選んだせいの見かけの得を除く）
//   ・食い違いの中身：ロールアウトは買う／V は買わない（またはその逆）が多い種類＝V が見誤っているタイル

import { OKind } from '../src/overlay/tiles';
import { OState, applyOverlay, hereFx, newOverlayGame } from '../src/overlay/engine';
import { shuffle } from '../src/engine/rng';
import { SearchOpts, chooseSearchAction, rankBuys } from '../src/overlay/search';
import { JOBS, f1, f2, mean, pooled, runProcess, tileName } from './overlay-arena';
import { DEFAULT_MODEL, loadModel } from './overlay-search-node';
import { rngFrom } from './common';
import { fileURLToPath } from 'node:url';

const STATES = Number(process.argv[2] ?? 280), ROLLS = Number(process.argv[3] ?? 24), TOP = Number(process.env.TOP ?? 4);
const MODEL = process.env.MODEL ?? DEFAULT_MODEL;
interface Rec { round: number; opts: { buy: OKind[]; u: number; turns: number[] }[] }

/** 買ったあとを1人で最後まで遊んで，かかった手番数を返す */
function rollout(s0: OState, seat: number, buy: OKind[], seed: number, o: SearchOpts): number {
  const t: OState = structuredClone(s0);
  applyOverlay(t, seat, { type: 'resolve', buy, remove: [] });
  const p = t.players[seat];
  t.players = [p]; t.current = 0; t.phase = 'play'; t.turn = 'move'; t.winners = []; t.log = []; t.round = 1; t.rng = seed;
  shuffle(p.bag, t); // 袋の順番は本人にはわからないので，毎回混ぜ直す
  let turns = 0, guard = 0;
  while (t.phase === 'play' && turns < 45 && guard++ < 100000) {
    const a = chooseSearchAction(t, o);
    if (a.type === 'resolve') turns++;
    applyOverlay(t, 0, a);
  }
  return p.finished ? turns : 45;
}

function worker() {
  const n = Number(process.env.OV_ROLL_N), seed = Number(process.env.OV_ROLL_SEED);
  const rand = rngFrom(seed);
  const o: SearchOpts = { model: loadModel(MODEL), objective: 'mean', budget: 300 };
  const out: Rec[] = [];
  for (let g = 0; out.length < n; g++) {
    const s = newOverlayGame([{ name: 'A', isBot: true }, { name: 'B', isBot: true }], seed * 100003 + g * 7919);
    let guard = 0;
    while (s.phase === 'play' && guard++ < 100000 && out.length < n) {
      const seat = s.current;
      if (s.turn === 'resolve' && hereFx(s, s.players[seat]).kind === 'buy' && rand() < 0.12) {
        const opts = rankBuys(s, o).slice(0, TOP);
        if (opts.length >= 2) {
          const seeds = Array.from({ length: ROLLS }, () => Math.floor(rand() * 2 ** 31));
          out.push({ round: s.round, opts: opts.map(x => ({ ...x, turns: seeds.map(sd => rollout(s, seat, x.buy, sd, o)) })) });
        }
      }
      applyOverlay(s, seat, chooseSearchAction(s, o));
    }
  }
  process.stdout.write(JSON.stringify(out));
}

async function main() {
  const t0 = Date.now();
  const per = Math.ceil(STATES / JOBS);
  const self = fileURLToPath(import.meta.url);
  const parts = await pooled(Array.from({ length: JOBS }, (_, i) => () => runProcess(self, { OV_ROLL_N: String(per), OV_ROLL_SEED: String(900 + i), MODEL }, [String(STATES), String(ROLLS)])));
  const recs = parts.flatMap(x => JSON.parse(x) as Rec[]);
  const half = ROLLS >> 1;
  let agree = 0, loss = 0, gapV = 0;
  const prefer: Record<string, { ro: number; v: number }> = {};
  for (const r of recs) {
    const full = r.opts.map(x => mean(x.turns)), a = r.opts.map(x => mean(x.turns.slice(0, half))), b = r.opts.map(x => mean(x.turns.slice(half)));
    const best = full.indexOf(Math.min(...full)), bestA = a.indexOf(Math.min(...a));
    if (best === 0) agree++;
    loss += b[0] - b[bestA];
    gapV += r.opts[0].u - r.opts[1].u;
    if (best !== 0 && full[0] - full[best] > 0.4) {
      const vb = r.opts[0].buy, rb = r.opts[best].buy;
      for (const k of new Set([...vb, ...rb])) {
        const d = rb.filter(x => x === k).length - vb.filter(x => x === k).length;
        if (!d) continue;
        (prefer[k] ??= { ro: 0, v: 0 })[d > 0 ? 'ro' : 'v']++;
      }
    }
  }
  console.log(`## V とロールアウトの照合（${recs.length}局面，候補${TOP}つ×${ROLLS}回，${Math.round((Date.now() - t0) / 1000)}秒）`);
  console.log(`- V の1位がロールアウトでも1位：${f1(100 * agree / recs.length)}%（候補${TOP}つなので，でたらめなら約${Math.round(100 / TOP)}%）`);
  console.log(`- V の1位を選んだせいの損：平均 ${f2(loss / recs.length)} 手番/回（0 に近いほど，V の買い方はロールアウトで直せない）`);
  console.log(`- V の1位と2位の点数の差：平均 ${f2(gapV / recs.length)} 手番`);
  const rows = Object.entries(prefer).sort((x, y) => (y[1].ro + y[1].v) - (x[1].ro + x[1].v)).slice(0, 12);
  console.log('- 食い違い（0.4手番以上の差）の中身：| タイル | ロールアウトは買う・V は買わない | V は買う・ロールアウトは買わない |');
  for (const [k, v] of rows) console.log(`  | ${tileName(k as OKind)} | ${v.ro} | ${v.v} |`);
}

if (process.env.OV_ROLL_N) worker(); else main();
