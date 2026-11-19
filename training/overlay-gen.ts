// 評価関数 V の学習データを作る（overlay_fit.py から並列に呼ばれる）
//   GEN_GAMES=試合数 GEN_SEED=乱数の種 GEN_OUT=出力（Float32 の行：[あと何手番, 特徴量…]）
//   GEN_MODE=old（既存のボットをくじで）／search（探索＋V．GEN_MODEL=重みのパス）
//   GEN_BUDGET=葉の予算  GEN_RULES=ルール（JSON）  GEN_SET=調べたい市場（overlay-arena.ts の marketOf の書き方）
//   GEN_MIX=1：試合ごとに選択肢のルール（目標・お気に入りの在庫1枚・ためらい3枚・理性のお気に入り）をくじで混ぜる．
//             画面で選べるルールのどれでも動く「共通の V」を作るため（どのルールかは特徴量＝目標・在庫・袋の中身から分かる）
// 各プレイヤーの手番の初めの持ち物と，そこから片付け終わるまでの手番数を記録する．
// だれかが終わって試合が終わったら，残りの人は1人で最後まで続けて手番数を数える．
// search では，席ごとに「この種類を買うと上乗せ」をくじで付けて，いろいろな買い方を経験させる（V が買われないタイルを知らないままにならないように）

import './overlay-variant';
import { writeFileSync } from 'node:fs';
import { ALL_PERMS as PERMS, OKind, isPerm } from '../src/overlay/tiles';
import { marketOf } from './overlay-arena';
import { OPRESETS, chooseOverlayAction } from '../src/overlay/bot';
import { OAction, OState, applyOverlay, newOverlayGame } from '../src/overlay/engine';
import { chooseSearchAction } from '../src/overlay/search';
import { BINS, MIDX, NFEAT, STOCK_OFF, featOfPlayer } from '../src/overlay/value';
import { loadModel } from './overlay-search-node';
import { rngFrom } from './common';

const GAMES = Number(process.env.GEN_GAMES ?? 100), SEED = Number(process.env.GEN_SEED ?? 1);
const MODE = process.env.GEN_MODE ?? 'old', OUT = process.env.GEN_OUT ?? 'gen.bin';
const BUDGET = Number(process.env.GEN_BUDGET ?? 300);
const RULES = process.env.GEN_RULES ? JSON.parse(process.env.GEN_RULES) : {};
const GEN_SET = process.env.GEN_SET ?? '';
const MIX = !!process.env.GEN_MIX;
/** その試合のルール */
function gameRules(): Record<string, unknown> {
  if (!MIX) return RULES;
  const r = rand();
  return { ...RULES, goals: r < 0.4 ? 'off' : r < 0.6 ? 'bonus' : r < 0.8 ? 'need1' : 'need2', favOne: rand() < 0.3, hesCount: rand() < 0.3 ? 3 : 2 };
}
const rand = rngFrom(SEED * 7 + 1);
const pickOf = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
type Agent = (s: OState) => OAction;
const FAMILIES: OKind[][] = [['CALM', 'DOWN2', 'REST', 'CLEAN', 'MEMO'], ['LIGHT', 'DRAG'], ['BR', 'BREATH', 'SWING', 'FREE'], ['TREAT', 'UP2', 'RUSH'], ['ROOMBA', 'BIGDAY'], ['BAG', 'COMPASS', 'KODAWARI']];

function makeAgent(market: OKind[], rules: Record<string, unknown>): { act: Agent; ban: OKind[] } {
  if (MODE === 'old') { const g = OPRESETS[pickOf(Object.keys(OPRESETS))]; return { act: s => chooseOverlayAction(s, g), ban: [] }; }
  const model = loadModel(process.env.GEN_MODEL);
  const bonus: Partial<Record<OKind, { v: number; cap: number }>> = {};
  if (rand() < 0.6) {
    const ks = market.filter(k => k !== 'DOWN');
    const n = rand() < 0.5 ? 1 : 2;
    for (let i = 0; i < n; i++) { const k = pickOf(ks); bonus[k] = { v: 0.5 + 2.5 * rand(), cap: isPerm(k) || rand() < 0.6 ? 1 : 2 }; }
  }
  // 4回に1回は「買わない種類」を決める（お気に入り全部／系統1つ／でたらめに数種類）．制約つきの買い方でも V が当たるように
  let ban: OKind[] = [];
  if (rand() < 0.25) {
    const r = rand();
    ban = r < 0.4 ? [...PERMS] : r < 0.7 ? pickOf(FAMILIES) : market.filter(k => k !== 'DOWN' && rand() < 0.3);
    for (const k of ban) delete bonus[k];
  }
  // 目標のあるルール：6割の席は「目標を達成すると上乗せ」を付けて，目標を取りに行く動きを経験させる
  const goalBonus = rules.goals && rules.goals !== 'off' && rand() < 0.6 ? 0.5 + 2.5 * rand() : 0;
  const o = { model, objective: 'mean' as const, budget: BUDGET, bonus, ban, goalBonus, epsBuy: 0.03, epsPlace: 0.5, rand };
  return { act: s => chooseSearchAction(s, o), ban };
}

const CAP = 30;
const rows: number[][] = [];
let stuck = 0, tracksN = 0;
/** 1人ぶんの記録：手番の初めの特徴量 */
interface Track { feats: Float64Array[]; done: boolean }

function playOut(s: OState, agents: { act: Agent; ban: OKind[] }[], tracks: Track[], seats: number[]) {
  let last = '', guard = 0;
  // CAP ラウンドを過ぎても終わらない人は「終わらない」（あと BINS 手番以上）として打ち切る
  while (s.phase === 'play' && s.round <= CAP && guard++ < 200000) {
    const key = `${s.round}:${s.current}`;
    const me = seats[s.current];
    if (key !== last) {
      last = key;
      const f = featOfPlayer(s, s.players[s.current]);
      for (const k of agents[me].ban) f[STOCK_OFF + MIDX[k]] = 0; // 買わない種類は在庫0として記録する（探索のときと同じ見え方）
      tracks[me].feats.push(f);
    }
    applyOverlay(s, s.current, agents[me].act(s));
  }
}

for (let g = 0; g < GAMES; g++) {
  const n = [1, 2, 2, 3, 3, 4][g % 6];
  // GEN_SET（調べたい市場）があれば7割はそれ．残りはいろいろなセット（V がセットの違いを知っているように）
  const set = GEN_SET && rand() < 0.7 ? GEN_SET : MIX && rand() < 0.4 ? 'calm' : rand() < 0.6 ? 'all' : pickOf(['intro', 'light', 'swing', 'random', 'random']);
  const rules = gameRules();
  const market = marketOf(set, rand);
  const s = newOverlayGame(Array.from({ length: n }, (_, i) => ({ name: `P${i}`, isBot: true })), (SEED * 1000003 + g * 7919 + 5) | 0, { rules, market });
  const agents = s.players.map(() => makeAgent(market, rules));
  const tracks: Track[] = s.players.map(() => ({ feats: [], done: false }));
  playOut(s, agents, tracks, s.players.map((_, i) => i));
  s.players.forEach((p, i) => { tracks[i].done = p.finished; });
  // 終わっていない人は1人で続ける
  s.players.forEach((p, i) => {
    if (p.finished) return;
    const t: OState = structuredClone(s);
    t.players = [t.players[i]]; t.current = 0; t.phase = 'play'; t.turn = 'move'; t.winners = []; t.log = [];
    if (t.round >= CAP) return;
    t.round++;
    playOut(t, agents, tracks, [i]);
    tracks[i].done = t.players[0].finished;
  });
  for (const tr of tracks) {
    const total = tr.feats.length;
    tracksN++; if (!tr.done) stuck++;
    tr.feats.forEach((f, j) => rows.push([tr.done ? Math.min(BINS, total - j) : BINS, ...f]));
  }
}

const buf = new Float32Array(rows.length * (NFEAT + 1));
rows.forEach((r, i) => buf.set(r, i * (NFEAT + 1)));
writeFileSync(OUT, Buffer.from(buf.buffer));
console.log(JSON.stringify({ rows: rows.length, games: GAMES, tracks: tracksN, stuck }));
