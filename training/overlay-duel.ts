// ボットどうしの対戦：npx tsx training/overlay-duel.ts A B [試合数]   （ボットの名前は overlay-arena.ts を参照）
//   2人戦（席を1試合ごとに入れ替え）での A の勝率と，N=4 を付ければ「A 1人＋B 3人」の勝率倍率も出す．SOLO=1 で1人回しの手番数も出す
import { Job, f1, f2, mean, runJobs, sePct, winShare } from './overlay-arena';

const [A, B] = [process.argv[2], process.argv[3]];
const GAMES = Number(process.argv[4] ?? 600);
const base = { set: process.env.SET ?? 'all', rules: process.env.RULES ? JSON.parse(process.env.RULES) : {} };

async function main() {
  const jobs: Job[] = [{ ...base, games: GAMES, seed: 301, mode: 'fixed', fixed: [A, B] }];
  if (process.env.N === '4') jobs.push({ ...base, games: GAMES, seed: 302, mode: 'fixed', fixed: [A, B, B, B] });
  if (process.env.SOLO) jobs.push({ ...base, games: Math.round(GAMES / 2), seed: 303, mode: 'fixed', fixed: [A] }, { ...base, games: Math.round(GAMES / 2), seed: 304, mode: 'fixed', fixed: [B] });
  const t0 = Date.now();
  const res = await runJobs(jobs);
  const share = (gs: typeof res[0]) => gs.reduce((n, g) => n + g.p.reduce((m, p, i) => m + (p.who === A ? winShare(g, i) : 0), 0), 0) / gs.length;
  const d = res[0], w = share(d);
  console.log(`${A} 対 ${B}（2人戦 ${d.length}試合）：${A} の勝率 ${f1(100 * w)}%（±${f1(sePct(w, d.length))}），平均 ${f1(mean(d.map(g => g.round)))} ラウンド，${Math.round((Date.now() - t0) / 1000)}秒`);
  let i = 1;
  if (process.env.N === '4') { const r = res[i++]; console.log(`${A} 1人＋${B} 3人（${r.length}試合）：${A} の勝率倍率 ${f2(share(r) * 4)}`); }
  if (process.env.SOLO) { const a = res[i++], b = res[i++]; console.log(`1人回しの平均ラウンド：${A} ${f2(mean(a.map(g => g.round)))}／${B} ${f2(mean(b.map(g => g.round)))}`); }
}
main();
