// 学習・評価で共有する部分：ゲノムのベクトル化と，対戦による評価

import { CardKind, MARKET_KINDS } from '../src/engine/cards';
import { DEFAULT_FLOOR } from '../src/engine/floors';
import { GameOptions } from '../src/engine/game';
import { BotGenome, PRESETS } from '../src/bot/bot';
import { playBotGame } from '../src/bot/runner';

// ---- ゲノム <-> 数値ベクトル ----
// 市場の各種類について [優先度, 上限枚数, 残したい度]，初期カード2種の残したい度，
// 仕上げ閾値，評価の重み3つ

// 実験用：市場の種類を変える（環境変数 MARKET_DROP="TRK"，MARKET_ADD="ST,CUT"）
for (const k of (process.env.MARKET_DROP ?? '').split(',').filter(Boolean)) {
  const i = MARKET_KINDS.indexOf(k as CardKind);
  if (i >= 0) MARKET_KINDS.splice(i, 1);
}
for (const k of (process.env.MARKET_ADD ?? '').split(',').filter(Boolean)) {
  if (!MARKET_KINDS.includes(k as CardKind)) MARKET_KINDS.push(k as CardKind);
}

export const VEC_LEN = MARKET_KINDS.length * 3 + 2 + 4;

export function encode(g: BotGenome): number[] {
  const v: number[] = [];
  for (const k of MARKET_KINDS) {
    const i = g.buy.findIndex(b => b.kind === k);
    v.push(i >= 0 ? 10 - i : 0); // 優先度
    v.push(i >= 0 ? g.buy[i].cap : 0); // 上限
    v.push(g.keep[k] ?? 5);
  }
  v.push(g.keep.R ?? 1, g.keep.D ?? 3);
  v.push(g.finish, g.wRemove, g.wBuy, g.wDraw);
  return v;
}

export function decode(v: number[]): BotGenome {
  const buy: { kind: CardKind; cap: number; pr: number }[] = [];
  const keep: Partial<Record<CardKind, number>> = {};
  MARKET_KINDS.forEach((k, j) => {
    const pr = v[j * 3], cap = Math.max(0, Math.min(3, Math.round(v[j * 3 + 1])));
    keep[k] = round2(v[j * 3 + 2]);
    if (cap > 0) buy.push({ kind: k, cap, pr });
  });
  buy.sort((a, b) => b.pr - a.pr);
  const o = MARKET_KINDS.length * 3;
  keep.R = round2(v[o]);
  keep.D = round2(v[o + 1]);
  return {
    buy: buy.map(({ kind, cap }) => ({ kind, cap })),
    keep,
    finish: Math.max(0, Math.min(8, Math.round(v[o + 2]))),
    wRemove: round2(Math.max(0, v[o + 3])),
    wBuy: round2(Math.max(0, v[o + 4])),
    wDraw: round2(Math.max(0, v[o + 5])),
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** 突然変異の大きさ（パラメータごとの目安の幅） */
export function scales(): number[] {
  const s: number[] = [];
  for (let i = 0; i < MARKET_KINDS.length; i++) s.push(3, 0.8, 2);
  s.push(2, 2, 1, 2, 2, 2);
  return s;
}

// ---- 対戦による評価 ----

/** 決定的な乱数（評価の再現性のため） */
export function rngFrom(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 実験用：カードのコストを一時的に変える（環境変数 CARD_COST="R+=3,D+=2"）
import { CARDS } from '../src/engine/cards';
for (const kv of (process.env.CARD_COST ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  if (k in CARDS) CARDS[k as CardKind].cost = Number(v);
}

/** 学習・評価に使う間取り（環境変数 FLOOR で指定．省略時は既定の間取り） */
export const FLOOR = process.env.FLOOR || DEFAULT_FLOOR;
export const GAME_OPTS: GameOptions = { floor: FLOOR };
export const LEARNED_KEY = FLOOR;

/** 対戦相手にするプリセット（「買わない型」は除く） */
export const PRESET_TABLE = Object.fromEntries(Object.entries(PRESETS).filter(([k]) => k !== 'nobuy'));
export const PRESET_LIST = Object.values(PRESET_TABLE);

/**
 * 候補を1席に置き，残りの席に相手（プリセットなど）をランダムに置いて games 戦する．
 * 戻り値は勝率倍率（1.0 = 人数割りの公平な勝率．共同勝利は等分）
 */
export function evaluateGenome(
  cand: BotGenome, opponents: BotGenome[], games: number, seed: number,
  playerCounts = [2, 3, 4], opts: GameOptions = GAME_OPTS,
): number {
  const rand = rngFrom(seed);
  let score = 0;
  for (let g = 0; g < games; g++) {
    const n = playerCounts[g % playerCounts.length];
    const seat = Math.floor(rand() * n);
    const gs: BotGenome[] = [];
    for (let i = 0; i < n; i++) gs.push(i === seat ? cand : opponents[Math.floor(rand() * opponents.length)]);
    const s = playBotGame(gs, (seed * 7919 + g * 104729) | 0, opts);
    if (s.winners.includes(seat)) score += n / s.winners.length;
  }
  return score / games;
}
