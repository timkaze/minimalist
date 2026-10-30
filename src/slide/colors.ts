// スライド版の色．画面（ui.ts）と印刷（print.ts）で同じものを使う
//   物欲＝青，捨欲＝赤（縦の軸），理性＝緑，衝動＝オレンジ（横の軸）．段階が上がるほど濃くなる

import { SCARDS, SKind } from './cards';

/** 物欲：額 0〜4 の濃さ（額が大きいほど濃い） */
const BUY = ['#eef4fb', '#dce8f7', '#c3d8f1', '#a6c4ea', '#86aee0'];
/** 捨欲：量 0〜3 */
const DROP = ['#fbf2f0', '#f6dcd7', '#efc0b8', '#e6a094'];
/** 理性：1〜3 */
const CALM = ['#ffffff', '#d8eedd', '#afd9ba', '#7cc092'];
/** 衝動：1〜3 */
const IMP = ['#ffffff', '#fbe5c2', '#f5c780', '#eca43e'];

export const INK = { buy: '#2f5f9e', drop: '#b5483b', calm: '#2f7a4a', imp: '#a3600a' };

const at = (a: string[], i: number) => a[Math.max(0, Math.min(a.length - 1, i))];

/** 行の色（中央の行は白） */
export function rowColor(kind: 'buy' | 'remove' | 'none', amount: number): string {
  return kind === 'buy' ? at(BUY, amount) : kind === 'remove' ? at(DROP, amount) : '#ffffff';
}
/** 列の色（中央の列は null） */
export function colColor(x: number): string | null {
  return x < 0 ? at(CALM, -x) : x > 0 ? at(IMP, x) : null;
}
export const colInk = (x: number) => (x < 0 ? INK.calm : x > 0 ? INK.imp : '#555');
export const calmColor = (n: number) => at(CALM, n);
export const impColor = (n: number) => at(IMP, n);

/** カードの条件のバッジ（衝動 n で取得／理性 n で排除）．色の濃さで段階がわかる */
export function needBadges(k: SKind): string {
  const d = SCARDS[k];
  const out: string[] = [];
  if (d.buyNeed) out.push(`<span class="badge" style="background:${impColor(d.buyNeed)};color:${INK.imp};border-color:${INK.imp}">衝動${d.buyNeed}で取得</span>`);
  if (d.dropNeed) out.push(`<span class="badge" style="background:${calmColor(d.dropNeed)};color:${INK.calm};border-color:${INK.calm}">理性${d.dropNeed}で排除</span>`);
  return out.join('');
}
