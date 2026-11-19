// オーバーレイ版の対戦の土台：ボットを名前で作る・1試合を記録つきで回す・複数プロセスで並べて回す
//   ボットの名前：OPRESETS のキー（aiFree など）／ search（探索＋評価関数．search?m=重みのパス&obj=mean|win&b=葉の予算&bonus=TREAT:1.5）
//   並列数は環境変数 JOBS（既定：コア数−2，最大14）

import './overlay-variant';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BUYABLE, OKind, PERMS, TILES, isPerm, marketFromChoice } from '../src/overlay/tiles';
import { OPRESETS, chooseOverlayAction } from '../src/overlay/bot';
import { OAction, OState, Rules, applyOverlay, hereFx, newOverlayGame, ownedTiles, topTile } from '../src/overlay/engine';
import { searchAgentFromSpec } from './overlay-search-node';
import { rngFrom } from './common';

export type Agent = (s: OState) => OAction;

export function makeAgent(name: string): Agent {
  if (name.startsWith('search')) return searchAgentFromSpec(name);
  const g = OPRESETS[name];
  if (!g) throw new Error(`ボット ${name} はありません`);
  return s => chooseOverlayAction(s, g);
}

type StopKind = 'buy' | 'remove' | 'none' | 'gacha' | 'lucky';
export interface PRec {
  who: string; left: number; removed: number; finished: boolean; turns: number;
  /** 市場から取得した枚数（福袋は含まない） */
  bought: Partial<Record<OKind, number>>;
  gacha: number; perms: OKind[]; permRound: Partial<Record<OKind, number>>;
  chipsUsed: number; chipsGot: number;
  /** 達成した目標 */
  goals: string[];
}
export interface GRec {
  n: number; set: string; round: number; win: number[]; p: PRec[]; sold: OKind[]; market: OKind[];
  stops: Record<StopKind, number>; turns: number; drawn: number; onTile: number; drewAll: number;
  /** この試合の目標 */
  goals: string[];
}

export interface PlayOpts { set?: string; rules?: Partial<Rules>; stock?: 'normal' | 'plenty'; rand?: () => number; onTurnStart?: (s: OState, seat: number) => void }

/** セットの書き方：セットの id（all・intro…）／all-BIGDAY,ROOMBA（除く．perms でお気に入り全部）／all+BACK,STACK（試作を足す）／all+BACK-BIGDAY／DOWN,BR,…（種類を並べる） */
export function marketOf(set: string, rand?: () => number): OKind[] {
  const m = set.match(/^([a-z]+)((?:[+-][A-Za-z0-9,]+)+)$/);
  if (m) {
    let ks = marketFromChoice(m[1], rand);
    for (const seg of m[2].match(/[+-][A-Za-z0-9,]+/g)!) {
      const list = seg.slice(1).split(',').flatMap(k => (k === 'perms' ? PERMS : [k as OKind]));
      ks = seg[0] === '-' ? ks.filter(k => !list.includes(k)) : [...ks, ...list.filter(k => !ks.includes(k))];
    }
    return BUYABLE.filter(k => ks.includes(k));
  }
  return marketFromChoice(set.includes(',') ? (set.split(',') as OKind[]) : set, rand);
}

/** 1試合を回して記録を返す */
export function playGame(agents: Agent[], who: string[], seed: number, o: PlayOpts = {}): GRec {
  const set = o.set ?? 'all';
  const s = newOverlayGame(who.map((w, i) => ({ name: `${w}${i}`, isBot: true })), seed, { rules: o.rules, market: marketOf(set, o.rand) });
  if (o.stock === 'plenty') for (const k of Object.keys(s.market) as OKind[]) s.market[k] = 99;
  const p: PRec[] = who.map(w => ({ who: w, left: 0, removed: 0, finished: false, turns: 0, bought: {}, gacha: 0, perms: [], permRound: {}, chipsUsed: 0, chipsGot: 0, goals: [] }));
  const g: GRec = { n: who.length, set, round: 0, win: [], p, sold: [], market: Object.keys(s.market) as OKind[], stops: { buy: 0, remove: 0, none: 0, gacha: 0, lucky: 0 }, turns: 0, drawn: 0, onTile: 0, drewAll: 0, goals: [...(s.goals ?? [])] };
  let guard = 0, lastTurn = '';
  while (s.phase === 'play' && guard++ < 200000) {
    const seat = s.current, pl = s.players[seat];
    const key = `${s.round}:${seat}`;
    if (key !== lastTurn) { lastTurn = key; o.onTurnStart?.(s, seat); }
    const a = agents[seat](s);
    if (a.type === 'resolve') {
      const fx = hereFx(s, pl);
      const kind: StopKind = pl.roll != null ? 'lucky' : fx.kind;
      g.turns++; p[seat].turns++; g.drawn += pl.placed.length; g.stops[kind]++;
      if (!pl.bag.length && !pl.discard.length) g.drewAll++;
      if (topTile(pl.placed, pl.pos)) g.onTile++;
      for (const k of a.buy) {
        p[seat].bought[k] = (p[seat].bought[k] ?? 0) + 1;
        if (isPerm(k)) p[seat].permRound[k] = s.round;
      }
      if (kind === 'gacha' && s.gacha.length) p[seat].gacha++;
      const before = pl.chips ?? 0;
      applyOverlay(s, seat, a);
      const d = (pl.chips ?? 0) - before;
      if (d > 0) p[seat].chipsGot += d; else p[seat].chipsUsed -= d;
    } else applyOverlay(s, seat, a);
  }
  if (s.phase === 'play') throw new Error('試合が終わりません');
  g.round = s.round; g.win = s.winners;
  s.players.forEach((q, i) => { p[i].left = ownedTiles(q).length; p[i].removed = q.removed; p[i].finished = q.finished; p[i].perms = [...q.perms]; p[i].goals = [...(q.goals ?? [])]; });
  g.sold = (Object.keys(s.market) as OKind[]).filter(k => s.market[k] === 0);
  return g;
}

// ---- 仕事（複数プロセスに分ける単位） ----

export interface Job {
  games: number; seed: number;
  /** pool：席ごとに pool からくじ／fixed：fixed の並びを1試合ごとに1席ずつずらす */
  mode: 'pool' | 'fixed';
  pool?: string[]; counts?: number[]; fixed?: string[];
  set?: string; rules?: Partial<Rules>; stock?: 'normal' | 'plenty';
}

export function runJob(job: Job): GRec[] {
  const rand = rngFrom(job.seed * 31 + 7);
  const cache = new Map<string, Agent>();
  const agent = (n: string) => { let a = cache.get(n); if (!a) cache.set(n, a = makeAgent(n)); return a; };
  const out: GRec[] = [];
  for (let g = 0; g < job.games; g++) {
    let who: string[];
    if (job.mode === 'fixed') { const f = job.fixed!; who = f.map((_, i) => f[(i + g) % f.length]); }
    else { const n = (job.counts ?? [2, 3, 4])[g % (job.counts ?? [2, 3, 4]).length]; who = Array.from({ length: n }, () => job.pool![Math.floor(rand() * job.pool!.length)]); }
    out.push(playGame(who.map(agent), who, job.seed * 1000003 + g * 7919 + 5, { set: job.set, rules: job.rules, stock: job.stock, rand }));
  }
  return out;
}

export const JOBS = Number(process.env.JOBS ?? Math.max(1, Math.min(14, cpus().length - 2)));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

/** スクリプトを別プロセスで動かし，標準出力を返す */
export function runProcess(script: string, env: Record<string, string>, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(TSX, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks: Buffer[] = [];
    c.stdout.on('data', d => chunks.push(d));
    c.on('error', reject);
    c.on('close', code => (code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`${script} が失敗（${code}）`))));
  });
}

/** 上限つきで並べて実行する */
export async function pooled<T>(tasks: (() => Promise<T>)[], limit = JOBS): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  }));
  return out;
}

const WORKER = fileURLToPath(new URL('./overlay-arena-worker.ts', import.meta.url));
/** 仕事を parts 個に割って並列に回し，記録をまとめて返す（仕事ごと） */
export async function runJobs(jobs: Job[], parts = JOBS): Promise<GRec[][]> {
  const tasks: { j: number; job: Job }[] = [];
  jobs.forEach((job, j) => {
    const k = Math.max(1, Math.min(parts, Math.ceil(job.games / 20)));
    for (let i = 0; i < k; i++) {
      const games = Math.floor(job.games / k) + (i < job.games % k ? 1 : 0);
      if (games) tasks.push({ j, job: { ...job, games, seed: job.seed * 131 + i + 1 } });
    }
  });
  const res = await pooled(tasks.map(t => async () => JSON.parse(await runProcess(WORKER, { OV_JOB: JSON.stringify(t.job) })) as GRec[]));
  const out: GRec[][] = jobs.map(() => []);
  tasks.forEach((t, i) => out[t.j].push(...res[i]));
  return out;
}

// ---- 集計の小物 ----

export const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
export const quantile = (a: number[], q: number) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(q * b.length))] : 0; };
/** 割合の標準誤差（%） */
export const sePct = (p: number, n: number) => 100 * Math.sqrt(Math.max(1e-9, p * (1 - p)) / Math.max(1, n));
export const f1 = (x: number) => x.toFixed(1), f2 = (x: number) => x.toFixed(2);
export const pct = (a: number, b: number) => `${Math.round(100 * a / (b || 1))}%`;
export const tileName = (k: OKind) => TILES[k].name;

/** 勝ち数（共同勝利は等分）：席 i の取り分 */
export const winShare = (g: GRec, i: number) => (g.win.includes(i) ? 1 / g.win.length : 0);
