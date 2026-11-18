// オーバーレイ版の評価関数 V：「この持ち物で自分の手番を迎えたとき，片付け終わるまでにあと何手番かかるか」の分布
//   入力＝持ち物（袋・捨て山の種類ごとの枚数，お気に入り，決心チップ，排除した枚数）と市場の在庫
//   出力＝あと t 手番（t = 1..BINS）の確率．小さな多層パーセプトロンで，重みは JSON（学習は training/overlay_fit.py）

import { BUYABLE, FURN_KINDS, LIGHT_MAX, LIGHT_PER, OKind, PERMS, TILES, TileRules, weightOf } from './tiles';
import { Furn, OPlayer, OState, Pos } from './engine';

/** 袋に入る種類（お気に入り以外） */
export const BAG_KINDS: OKind[] = (Object.keys(TILES) as OKind[]).filter(k => !TILES[k].perm);
export const NK = BAG_KINDS.length;
export const KIDX = Object.fromEntries((Object.keys(TILES) as OKind[]).map(k => [k, BAG_KINDS.indexOf(k)])) as Record<OKind, number>;
export const NM = BUYABLE.length;
export const MIDX = Object.fromEntries((Object.keys(TILES) as OKind[]).map(k => [k, BUYABLE.indexOf(k)])) as Record<OKind, number>;
/** あと何手番かの上限（これ以上は最後の区間にまとめる） */
export const BINS = 40;
/** 盤の様子の特徴量：盤に置いたお気に入り（種類ごとに 有無・x・y）＋盤に残った棚（START に近い順に3つまで 有無・x・y） */
export const SHELF_SLOTS = 3;
export const NEXT = FURN_KINDS.length * 3 + SHELF_SLOTS * 3;
export const NFEAT = 2 * NK + PERMS.length + 6 + NM + 2 + NEXT;
export const FEAT_VERSION = 2;
/** 特徴量の名前（重みを別の版へ引き継ぐとき，名前で対応づける） */
export const featNames = (): string[] => [
  ...BAG_KINDS.map(k => `bag:${k}`), ...BAG_KINDS.map(k => `disc:${k}`), ...PERMS.map(k => `perm:${k}`),
  'chips', 'removed', 'light', 'own', 'weight', 'bagn', ...BUYABLE.map(k => `stock:${k}`), 'gacha', 'players',
  ...FURN_KINDS.flatMap(k => [`furn:${k}`, `furn:${k}:x`, `furn:${k}:y`]),
  ...Array.from({ length: SHELF_SLOTS }, (_, i) => [`shelf${i}`, `shelf${i}:x`, `shelf${i}:y`]).flat(),
];

/** 盤の様子（お気に入りの置き場所と棚）を特徴量の並びにする */
export function boardExt(furn: Furn[], shelves: Pos[]): number[] {
  const v = new Array(NEXT).fill(0);
  FURN_KINDS.forEach((k, i) => {
    const f = furn.find(x => x.kind === k);
    if (f) { v[i * 3] = 1; v[i * 3 + 1] = f.pos.x / 3; v[i * 3 + 2] = f.pos.y / 4; }
  });
  const d = (p: Pos) => Math.abs(p.x) + Math.abs(p.y);
  [...shelves].sort((a, b) => d(a) - d(b) || a.y - b.y || a.x - b.x).slice(0, SHELF_SLOTS).forEach((p, i) => {
    const o = FURN_KINDS.length * 3 + i * 3;
    v[o] = 1; v[o + 1] = p.x / 3; v[o + 2] = p.y / 4;
  });
  return v;
}
const NO_EXT: number[] = new Array(NEXT).fill(0);
/** 特徴量のうち市場の在庫が始まる位置 */
export const STOCK_OFF = 2 * NK + PERMS.length + 6;

export const permMaskOf = (perms: OKind[]) => PERMS.reduce((m, k, i) => m | (perms.includes(k) ? 1 << i : 0), 0);
export function countsOf(tiles: { kind: OKind }[], out: number[] = new Array(NK).fill(0)): number[] {
  for (const t of tiles) out[KIDX[t.kind]]++;
  return out;
}
/** 市場の在庫（BUYABLE の順．市場に無い種類は 0） */
export const stockOf = (s: OState): number[] => BUYABLE.map(k => s.market[k] ?? 0);

/**
 * 特徴量を x に書く．bag・disc は種類ごとの枚数（運試しの見積もりでは小数になる）．
 * 袋が空のときは，呼ぶ側で捨て山を袋として渡す（次の手番の初めにそうなるので）
 */
export function fillFeat(
  x: Float64Array, bag: ArrayLike<number>, disc: ArrayLike<number>, permMask: number, chips: number, removed: number,
  stock: ArrayLike<number>, gachaN: number, nPlayers: number, weights: ArrayLike<number>, ext: ArrayLike<number> = NO_EXT,
): void {
  let o = 0, own = 0, w = 0, bn = 0;
  for (let i = 0; i < NK; i++) { x[o++] = bag[i]; bn += bag[i]; own += bag[i]; w += bag[i] * weights[i]; }
  for (let i = 0; i < NK; i++) { x[o++] = disc[i]; own += disc[i]; w += disc[i] * weights[i]; }
  for (let i = 0; i < PERMS.length; i++) x[o++] = (permMask >> i) & 1;
  x[o++] = chips / 3;
  x[o++] = Math.min(removed, 15) / 15;
  x[o++] = Math.min(LIGHT_MAX, Math.floor(removed / LIGHT_PER)) / LIGHT_MAX;
  x[o++] = own / 10;
  x[o++] = w / 10;
  x[o++] = bn / 10;
  for (let i = 0; i < NM; i++) x[o++] = Math.min(3, stock[i]) / 3;
  x[o++] = gachaN / 20;
  x[o++] = nPlayers / 4;
  for (let i = 0; i < NEXT; i++) x[o++] = ext[i];
}

export const kindWeights = (r: TileRules): number[] => BAG_KINDS.map(k => weightOf(k, r));

/** 手番の初めの持ち物の特徴量（自分の番が来たときの状態．置いたタイルは無い前提） */
export function featOfPlayer(s: OState, p: OPlayer, x: Float64Array = new Float64Array(NFEAT)): Float64Array {
  let bag = countsOf(p.bag), disc = countsOf(p.discard);
  countsOf(p.placed, disc);
  if (!p.bag.length) { bag = disc; disc = new Array(NK).fill(0); }
  fillFeat(x, bag, disc, permMaskOf(p.perms), s.rules.chips ? p.chips ?? 0 : 0, p.removed, stockOf(s), s.gacha.length, s.players.length, kindWeights(s.rules),
    boardExt(s.rules.favBoard ? p.furn ?? [] : [], (p.fixed ?? []).map(f => f.pos)));
  return x;
}

export interface ValueJson {
  version: number; feat: number; bins: number;
  /** 特徴量の名前（featNames() と同じ並びのはず） */
  names?: string[];
  /** 各層：w は out×in（行ごと），b は out */
  layers: { in: number; out: number; w: number[]; b: number[] }[];
  /** 学習したときのルール（違うルールの卓では使わない） */
  rules?: unknown;
  note?: string;
}

export class ValueModel {
  private readonly ws: Float64Array[] = [];
  private readonly bs: Float64Array[] = [];
  private readonly hs: Float64Array[] = [];
  private readonly dims: number[] = [];
  /** 1層目は列ごとに持つ（入力はほとんど 0 なので，0 でない入力だけ足す） */
  private readonly w0: Float64Array;
  readonly bins: number;
  constructor(readonly json: ValueJson) {
    const names = featNames();
    if (json.feat !== NFEAT || (json.names && json.names.some((n, i) => n !== names[i]))) throw new Error(`評価関数の形式が違います（feat ${json.feat}／${NFEAT}）．タイルを足したら学習し直すか，overlay_fit.py の --init で引き継ぐ`);
    this.bins = json.bins;
    for (const l of json.layers) {
      this.ws.push(Float64Array.from(l.w)); this.bs.push(Float64Array.from(l.b)); this.hs.push(new Float64Array(l.out)); this.dims.push(l.out);
    }
    const l0 = json.layers[0];
    this.w0 = new Float64Array(l0.in * l0.out);
    for (let o = 0; o < l0.out; o++) for (let i = 0; i < l0.in; i++) this.w0[i * l0.out + o] = l0.w[o * l0.in + i];
  }
  /** out[t-1] = あと t 手番の確率（t = 1..bins） */
  dist(x: Float64Array, out: Float64Array): void {
    const L = this.ws.length;
    let h = this.hs[0];
    const n0 = this.dims[0], b0 = this.bs[0];
    for (let o = 0; o < n0; o++) h[o] = b0[o];
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (v === 0) continue;
      const off = i * n0;
      for (let o = 0; o < n0; o++) h[o] += this.w0[off + o] * v;
    }
    for (let l = 1; l < L; l++) {
      const prev = h, pn = this.dims[l - 1], n = this.dims[l], w = this.ws[l], b = this.bs[l];
      for (let i = 0; i < pn; i++) if (prev[i] < 0) prev[i] = 0;
      h = this.hs[l];
      for (let o = 0; o < n; o++) {
        let a = b[o];
        const off = o * pn;
        for (let i = 0; i < pn; i++) a += w[off + i] * prev[i];
        h[o] = a;
      }
    }
    if (L === 1) { /* 1層だけ（線形）のときはそのまま */ }
    let mx = -Infinity;
    for (let t = 0; t < this.bins; t++) if (h[t] > mx) mx = h[t];
    let z = 0;
    for (let t = 0; t < this.bins; t++) { out[t] = Math.exp(h[t] - mx); z += out[t]; }
    for (let t = 0; t < this.bins; t++) out[t] /= z;
  }
  /** あと何手番かの平均 */
  mean(x: Float64Array, tmp: Float64Array = new Float64Array(this.bins)): number {
    this.dist(x, tmp);
    let m = 0;
    for (let t = 0; t < this.bins; t++) m += (t + 1) * tmp[t];
    return m;
  }
}
