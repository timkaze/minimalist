// 探索ボットの「狙い撃ち」と，タイルの強さの洗い出し：npx tsx training/overlay-probe.ts [試合数/条件]
//   MODEL=重みのパス（既定 src/overlay/value.json） OBJ=mean|win  ONLY=TREAT,REST（種類を絞る） BONUS=2
// 探索ボット（基準）に対して，条件を1つだけ変えた探索ボットを2人戦で当てる：
//   ・無理に買う：その種類を買うと点数を上乗せ（1枚目だけ）．基準に勝ち越すなら V がそのタイルを過小評価している＝ボットがまだ弱い
//   ・買わない：その種類を買わない．勝率が 50% から大きく下がるほど，そのタイルは勝つのに欠かせない
// 「無理に買う」がどれも 55% を超えないことを，バランスの結論を出す前の条件にする（改善方針の段階2）

import { MARKET, OKind, PERMS } from '../src/overlay/tiles';
import { Job, f1, runJobs, sePct, tileName, winShare } from './overlay-arena';
import { DEFAULT_MODEL } from './overlay-search-node';

const GAMES = Number(process.argv[2] ?? 400);
const MODEL = process.env.MODEL ?? DEFAULT_MODEL, OBJ = process.env.OBJ ?? 'mean', BONUS = process.env.BONUS ?? '2';
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const base = `search?m=${MODEL}&obj=${OBJ}`;
// PROBE_GROUPS=1：まとめて買わない条件だけ回す（短い）
const kinds = process.env.PROBE_GROUPS ? [] : MARKET.filter(k => k !== 'DOWN' && (!ONLY.length || ONLY.includes(k)));
const GROUPS: Record<string, OKind[]> = ONLY.length ? {} : {
  'お気に入り全部': PERMS, 'ルンバ・大掃除の日': ['ROOMBA', 'BIGDAY'], '量のタイル全部': ['CALM', 'DOWN2', 'REST', 'CLEAN', 'MEMO'],
  '身軽・道連れ': ['LIGHT', 'DRAG'], '向きを選べるタイル': ['BR', 'BREATH', 'SWING', 'FREE'], '額のタイル': ['TREAT', 'UP2', 'RUSH'],
};

async function main() {
  const probes: { label: string; kind: 'force' | 'ban'; spec: string }[] = [];
  for (const k of kinds) {
    probes.push({ label: tileName(k), kind: 'force', spec: `${base}&bonus=${k}:${BONUS}:1` });
    probes.push({ label: tileName(k), kind: 'ban', spec: `${base}&ban=${k}` });
  }
  for (const [g, ks] of Object.entries(GROUPS)) probes.push({ label: g, kind: 'ban', spec: `${base}&ban=${ks.join(',')}` });
  const jobs: Job[] = probes.map((p, i) => ({ games: GAMES, seed: 500 + i, mode: 'fixed', fixed: [p.spec, base], set: process.env.SET ?? 'all', rules: process.env.RULES ? JSON.parse(process.env.RULES) : {} }));
  const t0 = Date.now();
  const res = await runJobs(jobs);
  const rate = (i: number) => res[i].reduce((n, g) => n + g.p.reduce((m, p, s) => m + (p.who === probes[i].spec ? winShare(g, s) : 0), 0), 0) / res[i].length;
  const bought = (i: number, k: OKind) => { const ps = res[i].flatMap(g => g.p.filter(p => p.who === probes[i].spec)); return ps.filter(p => (p.bought[k] ?? 0) > 0).length / ps.length; };
  console.log(`## 狙い撃ちとタイルの強さ（基準：${OBJ}，各${GAMES}試合の2人戦，±${f1(sePct(0.5, GAMES))}，${Math.round((Date.now() - t0) / 1000)}秒）`);
  if (kinds.length) console.log('| タイル | 無理に買う側の勝率 | そのとき買った割合 | 基準が買う割合 | 買わない側の勝率 |\n|---|---|---|---|---|');
  let worst = 0;
  kinds.forEach((k, j) => {
    const fi = j * 2, bi = j * 2 + 1, f = rate(fi);
    worst = Math.max(worst, f);
    const baseBuy = (() => { const ps = res[fi].flatMap(g => g.p.filter(p => p.who === base)); return ps.filter(p => (p.bought[k] ?? 0) > 0).length / ps.length; })();
    console.log(`| ${tileName(k)} | ${f1(100 * f)}%${f > 0.55 ? ' ⚠' : ''} | ${Math.round(100 * bought(fi, k))}% | ${Math.round(100 * baseBuy)}% | ${f1(100 * rate(bi))}% |`);
  });
  if (Object.keys(GROUPS).length) {
    console.log('\n| まとめて買わない | 買わない側の勝率 |\n|---|---|');
    probes.forEach((p, i) => { if (i >= kinds.length * 2) console.log(`| ${p.label} | ${f1(100 * rate(i))}% |`); });
  }
  if (kinds.length) console.log(`\n無理に買う側の最高勝率 ${f1(100 * worst)}%（55% を超えるものがあれば，V の学習がまだ足りない）`);
}
main();
