// スライド版のまとめ：npx tsx training/slide-report.ts [試合数]
// 型（勝ち筋）を混ぜた2〜4人卓を回し，ゲームの長さ・引き分け・取得枚数・勝率倍率（1.00 = 公平）・
// 止まった行と列（序盤と終盤）・達成の仕方（0枚／お気に入り）を表にする

import { SKind } from '../src/slide/cards';
import { SPRESETS, SBOT_LABELS, playSlideTurn } from '../src/slide/bot';
import { SState, newSlideGame, ownedCards } from '../src/slide/engine';
import { rngFrom } from './common';

const GAMES = Number(process.argv[2] ?? 600);
const ONLY = (process.env.TYPES ?? '').split(',').filter(Boolean);

export function runReport(games: number, label = '') {
  const names = ONLY.length ? ONLY : Object.keys(SPRESETS);
  const rand = rngFrom(11);
  const win: Record<string, number> = {}, app: Record<string, number> = {};
  const rounds: number[] = [], buys: Record<string, number[]> = {};
  const finishBy = { zero: 0, fav: 0 };
  let draws = 0;
  // 止まった行・列：前半（ラウンド1〜4）と後半（5〜）
  const rowHist = { early: new Map<number, number>(), late: new Map<number, number>() };
  const colHist = { early: new Map<number, number>(), late: new Map<number, number>() };
  const bought: Record<string, number> = {};
  for (let g = 0; g < games; g++) {
    const n = 2 + (g % 3);
    const who = Array.from({ length: n }, () => names[Math.floor(rand() * names.length)]);
    const gs = who.map(w => SPRESETS[w]);
    const s: SState = newSlideGame(who.map((w, i) => ({ name: `${w}${i}`, isBot: true })), g * 7919 + 5);
    while (s.phase === 'play') {
      const before = s.log.length;
      const round = s.round;
      playSlideTurn(s, gs);
      for (const l of s.log.slice(before)) {
        const m = l.match(/\((-?\d+),(-?\d+)\)で止まった/);
        if (!m) continue;
        const h = round <= 4 ? 'early' : 'late';
        rowHist[h].set(+m[2], (rowHist[h].get(+m[2]) ?? 0) + 1);
        colHist[h].set(+m[1], (colHist[h].get(+m[1]) ?? 0) + 1);
        const b = l.match(/取得 (.+?)( \/|$)/);
        if (b) for (const nm of b[1].split('・')) bought[nm] = (bought[nm] ?? 0) + 1;
      }
    }
    rounds.push(s.round);
    s.players.forEach((p, i) => { (buys[who[i]] ??= []).push(p.bought); });
    who.forEach(w => { app[w] = (app[w] ?? 0) + 1; });
    if (!s.winners.length) { draws++; continue; }
    for (const i of s.winners) {
      win[who[i]] = (win[who[i]] ?? 0) + n / s.winners.length;
      if (ownedCards(s.players[i]).length) finishBy.fav++; else finishBy.zero++;
    }
  }
  const avg = (a: number[] = []) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const pctMap = (m: Map<number, number>, keys: number[]) => {
    const t = [...m.values()].reduce((a, b) => a + b, 0) || 1;
    return keys.map(k => `${k}:${Math.round(100 * (m.get(k) ?? 0) / t)}`).join(' ');
  };
  console.log(`\n## ${label || 'スライド版'}（${games}試合，2〜4人）`);
  console.log(`平均ラウンド ${avg(rounds).toFixed(1)}，引分 ${Math.round(100 * draws / games)}%，達成の仕方 0枚 ${finishBy.zero} / お気に入り ${finishBy.fav}`);
  console.log('| 型 | 勝率倍率 | 取得/人 |');
  console.log('|---|---|---|');
  for (const w of names) console.log(`| ${SBOT_LABELS[w] ?? w} | ${((win[w] ?? 0) / (app[w] || 1)).toFixed(2)} | ${avg(buys[w]).toFixed(1)} |`);
  const rows = [3, 2, 1, 0, -1, -2, -3, -4], cols = [-3, -2, -1, 0, 1, 2, 3];
  console.log(`止まった行(%) 前半 ${pctMap(rowHist.early, rows)}`);
  console.log(`止まった行(%) 後半 ${pctMap(rowHist.late, rows)}`);
  console.log(`止まった列(%) 前半 ${pctMap(colHist.early, cols)}`);
  console.log(`止まった列(%) 後半 ${pctMap(colHist.late, cols)}`);
  console.log(`取得されたカード ${Object.entries(bought).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}${v}`).join(' ')}`);
}

if (process.argv[1]?.endsWith('slide-report.ts')) runReport(GAMES);
export type { SKind };
