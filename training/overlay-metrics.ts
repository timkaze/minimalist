// オーバーレイ版の指標（改善方針の段階0）：npx tsx training/overlay-metrics.ts [試合数]
//   POOL=aiFree,aiFav,…（混ぜて戦わせるボット．既定は学習AI6体） MIRROR=aiFree（席順を見る同型対戦のボット．既定は POOL の先頭）
//   SET=all  RULES='{"hes":"second"}'  JOBS=14  OUT=結果を残す JSON  LABEL=見出し
// 出すもの：長さ・接戦度・先手勝率（在庫ふつう／無制限）・売り切れ・勝者の買い方の型・タイルごとの採用率．± は標準誤差
// ボットの名前は overlay-arena.ts を参照（search?… で探索ボット）

import { writeFileSync } from 'node:fs';
import { BUYABLE, EXPERIMENTAL, OKind, PERMS, TILES, isPerm } from '../src/overlay/tiles';
import { GRec, Job, PRec, f1, f2, mean, pct, quantile, runJobs, sePct, tileName, winShare } from './overlay-arena';

const GAMES = Number(process.argv[2] ?? 2000);
const POOL = (process.env.POOL ?? 'aiFree,aiFav,aiLight,aiClean,aiSwing,aiRush').split(',').filter(Boolean);
const MIRROR = process.env.MIRROR ?? POOL[0];
const SET = process.env.SET ?? 'all';
const RULES = process.env.RULES ? JSON.parse(process.env.RULES) : {};
const LABEL = process.env.LABEL ?? `POOL=${POOL.join(',')}`;

// ---- 買い方の型 ----
const FAMILY: Record<string, OKind[]> = {
  'お気に入り': PERMS,
  '量のタイル': ['CALM', 'DOWN2', 'REST', 'CLEAN', 'MEMO'],
  '身軽・道連れ': ['LIGHT', 'DRAG'],
  '額・移動': ['BR', 'BREATH', 'SWING', 'FREE', 'TREAT', 'UP2', 'RUSH'],
  '試作のタイル': EXPERIMENTAL,
};
const spendOf = (p: PRec, ks: OKind[]) => ks.reduce((n, k) => n + (p.bought[k] ?? 0) * (TILES[k].cost ?? 0), 0);
/** 系統：片付けたい以外で，いちばんコストをかけた系統（合計3以下は最小限） */
export function familyOf(p: PRec): string {
  const sp = Object.entries(FAMILY).map(([f, ks]) => ({ f, v: spendOf(p, ks) })).sort((a, b) => b.v - a.v);
  return sp.reduce((n, x) => n + x.v, 0) <= 3 ? '最小限' : sp[0].f;
}
/** 型：お気に入りを持っていればその組み合わせ，なければ一番コストをかけたタイル */
export function typeOf(p: PRec): string {
  if (p.perms.length) return '★' + PERMS.filter(k => p.perms.includes(k)).map(tileName).join('＋');
  const ks = BUYABLE.filter(k => !isPerm(k) && k !== 'DOWN' && (p.bought[k] ?? 0) > 0).sort((a, b) => spendOf(p, [b]) - spendOf(p, [a]));
  return ks.length && spendOf(p, ks) > 3 ? tileName(ks[0]) : '最小限';
}

function shares(labels: { l: string; w: number }[]) {
  const m = new Map<string, number>();
  let tot = 0;
  for (const { l, w } of labels) { m.set(l, (m.get(l) ?? 0) + w); tot += w; }
  const rows = [...m.entries()].map(([l, w]) => ({ l, s: w / (tot || 1) })).sort((a, b) => b.s - a.s);
  const eff = Math.exp(-rows.reduce((n, r) => n + (r.s > 0 ? r.s * Math.log(r.s) : 0), 0));
  return { rows, eff, big: rows.filter(r => r.s >= 0.15).length, max: rows[0]?.s ?? 0 };
}

function seatLine(gs: GRec[]) {
  const n = gs[0].n, w = Array(n).fill(0);
  for (const g of gs) for (let i = 0; i < n; i++) w[i] += winShare(g, i);
  return w.map(x => `${f1(100 * x / gs.length)}`).join(' / ') + `（±${f1(sePct(1 / n, gs.length))}）`;
}

function soldLine(gs: GRec[]) {
  const c: Record<string, number> = {};
  for (const g of gs) for (const k of g.sold) c[k] = (c[k] ?? 0) + 1;
  const top = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${tileName(k as OKind)} ${pct(v, gs.length)}`).join('・');
  return `${f2(mean(gs.map(g => g.sold.length)))}種類/試合（${top || 'なし'}）`;
}

export interface Summary { label: string; games: number; rounds: number; draws: number; close: number; seat2: number; seat2plenty: number; bigTypes: number; maxType: number; effTypes: number; dead: string[]; favWin: number }

async function main() {
  const base = { set: SET, rules: RULES };
  const M = Math.max(200, Math.round(GAMES / 2));
  const jobs: Job[] = [
    { ...base, games: GAMES, seed: 11, mode: 'pool', pool: POOL, counts: [2, 3, 4] },
    { ...base, games: M, seed: 21, mode: 'fixed', fixed: [MIRROR, MIRROR] },
    { ...base, games: M, seed: 22, mode: 'fixed', fixed: [MIRROR, MIRROR], stock: 'plenty' },
    { ...base, games: M, seed: 23, mode: 'fixed', fixed: [MIRROR, MIRROR, MIRROR, MIRROR] },
    { ...base, games: M, seed: 24, mode: 'fixed', fixed: [MIRROR, MIRROR, MIRROR, MIRROR], stock: 'plenty' },
  ];
  const t0 = Date.now();
  const [pool, m2, m2p, m4, m4p] = await runJobs(jobs);
  const L: string[] = [];
  const say = (s = '') => { L.push(s); console.log(s); };

  say(`## 指標：${LABEL}（セット ${SET}，ルール ${JSON.stringify(RULES)}）`);
  say(`混ぜた卓 ${pool.length}試合（2〜4人），同型対戦 各${M}試合．計算 ${Math.round((Date.now() - t0) / 1000)}秒`);

  // 長さ・接戦度
  const rounds = pool.map(g => g.round), draws = pool.filter(g => !g.win.length).length;
  const multi = pool.filter(g => g.p.filter(p => p.finished).length > 1).length, shared = pool.filter(g => g.win.length > 1).length;
  const second = pool.filter(g => g.win.length).map(g => Math.min(...g.p.filter((_, i) => !g.win.includes(i)).map(p => p.left), 99)).filter(x => x < 99);
  const close = second.filter(x => x <= 2).length / (second.length || 1);
  const loserLeft = mean(pool.flatMap(g => g.p.filter((_, i) => !g.win.includes(i)).map(p => p.left)));
  const turns = pool.reduce((n, g) => n + g.turns, 0);
  const stop = (k: keyof GRec['stops']) => pct(pool.reduce((n, g) => n + g.stops[k], 0), turns);
  say('\n### 長さと接戦度（混ぜた卓）');
  say(`- 平均 ${f1(mean(rounds))} ラウンド（10%点 ${quantile(rounds, 0.1)}・90%点 ${quantile(rounds, 0.9)}），引分 ${pct(draws, pool.length)}`);
  say(`- 2位が残り2枚以内 ${f1(100 * close)}%（±${f1(sePct(close, second.length))}），敗者の残り 平均 ${f1(loserLeft)}枚，同じラウンドに複数達成 ${pct(multi, pool.length)}，共同勝利 ${pct(shared, pool.length)}`);
  say(`- 1手番に引いた枚数 ${f2(pool.reduce((n, g) => n + g.drawn, 0) / turns)}，全部引いた手番 ${pct(pool.reduce((n, g) => n + g.drewAll, 0), turns)}，タイルの上で止まった ${pct(pool.reduce((n, g) => n + g.onTile, 0), turns)}`);
  say(`- 止まったマス：取得 ${stop('buy')}・排除 ${stop('remove')}・なし ${stop('none')}・福袋 ${stop('gacha')}・運試し ${stop('lucky')}`);
  const pl = pool.flatMap(g => g.p);
  say(`- 決心チップ：もらった ${f2(mean(pl.map(p => p.chipsGot)))}枚/人・使った ${f2(mean(pl.map(p => p.chipsUsed)))}枚/人`);

  // ボットごとの強さ
  if (POOL.length > 1) {
    say('\n### ボットごとの勝率倍率（1.00 = 互角）');
    say('| ボット | 勝率倍率 | 取得/試合 | 出場 |\n|---|---|---|---|');
    for (const w of POOL) {
      let win = 0, app = 0, buys = 0;
      for (const g of pool) g.p.forEach((p, i) => { if (p.who !== w) return; app++; win += winShare(g, i) * g.n; buys += Object.values(p.bought).reduce((a, b) => a + (b ?? 0), 0); });
      say(`| ${w} | ${f2(win / (app || 1))} | ${f1(buys / (app || 1))} | ${app} |`);
    }
  }

  // 席順
  const seat2 = m2.reduce((n, g) => n + winShare(g, 0), 0) / m2.length, seat2p = m2p.reduce((n, g) => n + winShare(g, 0), 0) / m2p.length;
  say(`\n### 席順（${MIRROR} の同型対戦．席ごとの勝率%）`);
  say('| 卓 | 在庫ふつう | 在庫無制限 |\n|---|---|---|');
  say(`| 2人 | ${seatLine(m2)} | ${seatLine(m2p)} |`);
  say(`| 4人 | ${seatLine(m4)} | ${seatLine(m4p)} |`);
  say(`- 売り切れ：2人 ${soldLine(m2)}／4人 ${soldLine(m4)}`);

  // 勝者の買い方
  const winners = pool.flatMap(g => g.win.map(i => ({ p: g.p[i], w: 1 / g.win.length })));
  const fam = shares(winners.map(x => ({ l: familyOf(x.p), w: x.w }))), typ = shares(winners.map(x => ({ l: typeOf(x.p), w: x.w })));
  const favWin = winners.reduce((n, x) => n + (x.p.perms.length ? x.w : 0), 0) / (winners.reduce((n, x) => n + x.w, 0) || 1);
  say('\n### 勝者の買い方');
  say(`- 系統：${fam.rows.map(r => `${r.l} ${Math.round(100 * r.s)}%`).join('・')}`);
  say(`- 型（上位）：${typ.rows.slice(0, 8).map(r => `${r.l} ${Math.round(100 * r.s)}%`).join('・')}`);
  say(`- 勝ちの15%以上を占める型 ${typ.big}個，最大の型 ${Math.round(100 * typ.max)}%，型の実効数 ${f1(typ.eff)}，お気に入りを持つ勝者 ${Math.round(100 * favWin)}%`);
  say(`- 勝者の取得枚数 平均 ${f1(mean(winners.map(x => Object.values(x.p.bought).reduce((a, b) => a + (b ?? 0), 0))))}，敗者 ${f1(mean(pool.flatMap(g => g.p.filter((_, i) => !g.win.includes(i))).map(p => Object.values(p.bought).reduce((a, b) => a + (b ?? 0), 0))))}`);

  // タイルごと
  say('\n### タイルごと（そのタイルが市場にある試合）');
  say('| タイル | コスト | 買った人 | 勝者で買った人 | 平均枚数 | 買った人の勝率倍率 | 初取得ラウンド |\n|---|---|---|---|---|---|---|');
  const dead: string[] = [];
  for (const k of BUYABLE) {
    let app = 0, own = 0, cnt = 0, win = 0, wown = 0, wtot = 0, pr = 0, prn = 0;
    for (const g of pool) {
      if (!g.market.includes(k)) continue;
      g.p.forEach((p, i) => {
        const has = (p.bought[k] ?? 0) > 0, ws = winShare(g, i);
        app++; wtot += ws;
        if (has) { own++; cnt += p.bought[k]!; win += ws * g.n; wown += ws; }
        if (p.permRound[k]) { pr += p.permRound[k]!; prn++; }
      });
    }
    if (!app) continue;
    if (wown / (wtot || 1) < 0.05) dead.push(tileName(k));
    say(`| ${isPerm(k) ? '★' : ''}${tileName(k)} | ${TILES[k].cost} | ${pct(own, app)} | ${pct(wown, wtot)} | ${f2(cnt / app)} | ${own >= 30 ? f2(win / own) : '—'} | ${prn ? f1(pr / prn) : ''} |`);
  }
  say(`- 勝者の採用が5%未満のタイル（${dead.length}種）：${dead.join('・') || 'なし'}`);

  const sum: Summary = { label: LABEL, games: pool.length, rounds: mean(rounds), draws: draws / pool.length, close, seat2, seat2plenty: seat2p, bigTypes: typ.big, maxType: typ.max, effTypes: typ.eff, dead, favWin };
  say('\n### 目標との差');
  say('| 指標 | 目標 | 今 |\n|---|---|---|');
  say(`| 勝ちの15%以上を占める型 | 4つ以上 | ${typ.big} |`);
  say(`| 最大の型 | 40%以下 | ${Math.round(100 * typ.max)}% |`);
  say(`| 勝者の採用5%未満のタイル | 2種以下 | ${dead.length} |`);
  say(`| 2人戦の先手勝率 | 50±3% | ${f1(100 * seat2)}%（±${f1(sePct(0.5, m2.length))}） |`);
  say(`| 2位が残り2枚以内 | 60%以上 | ${f1(100 * close)}% |`);
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ summary: sum, text: L.join('\n') }, null, 1));
}

if (process.argv[1]?.endsWith('overlay-metrics.ts')) main();
