import { describe, expect, it } from 'vitest';
import { BUYABLE, OKind, marketFromChoice } from '../src/overlay/tiles';
import { OState, Rules, UNLIMITED, applyOverlay, hereFx, newOverlayGame, ownedTiles } from '../src/overlay/engine';
import { OPRESETS, chooseOverlayAction, playOverlayTurn } from '../src/overlay/bot';
import { chooseSearchAction } from '../src/overlay/search';
import { BINS, FEAT_VERSION, NFEAT, ValueJson, ValueModel, featNames } from '../src/overlay/value';

const game = (rules: Partial<Rules> = {}, market?: OKind[]) => newOverlayGame([{ name: 'A' }, { name: 'B' }], 1, { rules, market });
/** 現在の手番の人の袋を，引く順に指定する */
function stack(s: OState, ...kinds: OKind[]) {
  const p = s.players[s.current];
  p.bag = kinds.map(k => ({ id: s.nextId++, kind: k })).reverse();
}
const draw = (s: OState) => applyOverlay(s, s.current, { type: 'draw' });
const stop = (s: OState) => applyOverlay(s, s.current, { type: 'stop' });
const here = (s: OState) => hereFx(s, s.players[s.current]);
/** 相手の手番を何もせずに終える */
function pass(s: OState) {
  stack(s, 'DOWN'); draw(s); stop(s);
  applyOverlay(s, s.current, { type: 'resolve', buy: [], remove: [] });
}

describe('オーバーレイ版の試作タイル', () => {
  it('量を運ぶ（勢い・断捨離・冷静）：盤にあるあいだ，止まったマスの量 +1（重なる）', () => {
    const s = game();
    stack(s, 'MOMENTUM', 'MOMENTUM'); // (0,-1) 量1，(0,-2) は額2 の特別なマス
    draw(s);
    expect(here(s)).toEqual({ kind: 'remove', amount: 2 });
    draw(s);
    expect(here(s)).toEqual({ kind: 'buy', amount: 2 }); // 額には足さない
    const t = game();
    stack(t, 'DOWN2', 'CALM'); // 断捨離で(0,-1)，冷静で(-1,-1)：盤の印刷は量1，運ぶ +1 が2枚
    draw(t); draw(t);
    expect(t.players[0].pos).toEqual({ x: -1, y: -1 });
    expect(here(t)).toEqual({ kind: 'remove', amount: 3 });
  });

  it('ひきかえす：1つ前に置いたタイルのマスへ戻り，そのタイルの効果を使える', () => {
    const s = game();
    stack(s, 'DOWN2', 'BACK'); // 断捨離（↓・量2）を START に置いて下へ → ひきかえすで START の断捨離の上へ
    draw(s); draw(s);
    expect(s.players[0].pos).toEqual({ x: 0, y: 0 });
    expect(here(s)).toEqual({ kind: 'remove', amount: 3 }); // 断捨離の量2 ＋ 断捨離が運ぶ +1
    const t = game();
    stack(t, 'BACK'); // 1枚目なら動かない（自分の額2）
    draw(t);
    expect(t.players[0].pos).toEqual({ x: 0, y: 0 });
    expect(here(t)).toEqual({ kind: 'buy', amount: 2 });
  });

  it('山積み：量＝そのマスにこの手番に重ねた枚数', () => {
    const s = game();
    stack(s, 'REST', 'TREAT', 'STACK'); // 動かないタイルを3枚 START に重ねる
    draw(s); draw(s); draw(s);
    expect(here(s)).toEqual({ kind: 'remove', amount: 3 });
  });

  it('収納棚：置いたマスに残って持ち物から外れ，そのマスがずっと量2になる．START では残らない', () => {
    const s = game();
    const p = s.players[0];
    stack(s, 'DOWN', 'SHELF');
    p.discard = [{ id: s.nextId++, kind: 'JUNK' }];
    const before = ownedTiles(p).length + 0;
    draw(s); draw(s); // (0,-1) に棚
    expect(here(s)).toEqual({ kind: 'remove', amount: 2 });
    stop(s);
    const shelf = p.placed[1].id;
    expect(() => applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [shelf] })).toThrow(); // 排除はできない
    applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [p.placed[0].id] });
    expect(p.fixed!.map(f => f.pos)).toEqual([{ x: 0, y: -1 }]);
    expect(ownedTiles(p).some(t => t.kind === 'SHELF')).toBe(false);
    expect(p.removed).toBe(1); // 棚は排除した枚数に数えない
    expect(before).toBeGreaterThan(0);
    pass(s);
    stack(s, 'DOWN'); draw(s); // 次の手番：(0,-1) は印刷では量1だが，棚があるので量2
    expect(here(s)).toEqual({ kind: 'remove', amount: 2 });
    const t = game();
    stack(t, 'SHELF'); draw(t); stop(t);
    applyOverlay(t, 0, { type: 'resolve', buy: [], remove: [] });
    expect(t.players[0].fixed ?? []).toEqual([]);
    expect(t.players[0].discard.some(c => c.kind === 'SHELF')).toBe(true);
  });
});

describe('理性のお気に入り（試作）とお気に入りの在庫', () => {
  it('理性の列でしか取得できない', () => {
    const s = game({}, marketFromChoice('calm'));
    stack(s, 'RUSH', 'UP2', 'UP2'); // (1,2)：額 3+1 = 4，衝動1
    for (let i = 0; i < 3; i++) draw(s);
    expect(here(s)).toEqual({ kind: 'buy', amount: 4 });
    stop(s);
    expect(() => applyOverlay(s, 0, { type: 'resolve', buy: ['KAKEIBO'], remove: [] })).toThrow(/理性1以上/);
    const t = game({}, marketFromChoice('calm'));
    stack(t, 'DOUBT', 'TREAT'); // 理性1の列でご褒美（額4）を置いてその上で止まる
    draw(t); draw(t); stop(t);
    applyOverlay(t, 0, { type: 'resolve', buy: ['KAKEIBO'], remove: [] });
    expect(t.players[0].perms).toEqual(['KAKEIBO']);
    expect(marketFromChoice('calm')).not.toContain('YUTORI'); // ゆとりは強すぎたのでセットから外してある
  });

  it('ゆとり：その手番の1枚目のためらいでは止まらない（2枚目で止まる）', () => {
    const s = game();
    s.players[0].perms.push('YUTORI');
    stack(s, 'HES', 'DOWN', 'HES');
    draw(s);
    applyOverlay(s, 0, { type: 'branch', dir: 'L' });
    expect(s.turn).toBe('move'); // 止まらず，続けて引ける
    draw(s);
    expect(s.players[0].pos).toEqual({ x: -1, y: -1 });
    draw(s);
    applyOverlay(s, 0, { type: 'branch', dir: 'L' });
    expect(s.turn).toBe('resolve'); // 2枚目で止まる
  });

  it('手放す覚悟：排除の条件（理性）を無視できる', () => {
    for (const has of [false, true]) {
      const s = game({ chips: false });
      const p = s.players[0];
      if (has) p.perms.push('KOKOROE');
      p.discard = [{ id: s.nextId++, kind: 'WANT' }];
      stack(s, 'JUNK', 'DOWN', 'DOWN', 'DOWN'); // (1,0)→(1,-1) 運試し→(1,-2)→(1,-3)：衝動1の量2
      for (let i = 0; i < 4; i++) draw(s);
      expect(here(s)).toEqual({ kind: 'remove', amount: 2 });
      stop(s);
      const junk = p.placed[0].id; // ガラクタ：重さ2・理性1で排除
      if (has) { applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [junk] }); expect(p.removed).toBe(1); }
      else expect(() => applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [junk] })).toThrow();
    }
  });

  it('家計簿：排除できた手番でも決心チップを1枚もらう', () => {
    const s = game();
    const p = s.players[0];
    p.perms.push('KAKEIBO');
    p.discard = [{ id: s.nextId++, kind: 'WANT' }];
    stack(s, 'DOWN');
    draw(s); stop(s);
    applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [p.placed[0].id] });
    expect(p.removed).toBe(1);
    expect(p.chips).toBe(1);
  });

  it('お気に入りの在庫を各1枚にできる（取り合い）', () => {
    const s = newOverlayGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }], 1, { rules: { favOne: true } });
    expect(s.market.BIGDAY).toBe(1);
    expect(s.market.DOWN2).toBe(3);
    expect(newOverlayGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }], 1).market.BIGDAY).toBe(3);
  });
});

describe('目標', () => {
  it('3枚めくられ，止まり方が条件を満たすと達成して決心チップをもらう', () => {
    const s = game({ goals: 'bonus' });
    expect(s.goals!.length).toBe(3);
    expect(game().goals).toBeUndefined();
    s.goals = ['WALK7', 'CALM3', 'TOP'];
    const p = s.players[0];
    stack(s, 'DOUBT', 'DOUBT', 'DOUBT'); // 理性3の列へ
    for (let i = 0; i < 3; i++) draw(s);
    stop(s);
    applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [] });
    expect(p.goals).toEqual(['CALM3']);
    expect(p.chips).toBe(2); // 目標 +1，排除できなかった手番 +1
    expect(s.log[s.log.length - 1]).toContain('理性の果て');
  });

  it('chipGain=goal：排除できなかった手番ではもらわず，目標の達成でだけもらう', () => {
    const s = game({ goals: 'bonus', chipGain: 'goal' });
    s.goals = ['CALM3', 'TOP', 'BIGBUY'];
    const p = s.players[0];
    stack(s, 'DOUBT'); draw(s); stop(s);
    applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [] });
    expect(p.chips).toBe(0);
    pass(s);
    stack(s, 'DOUBT', 'DOUBT', 'DOUBT');
    for (let i = 0; i < 3; i++) draw(s);
    stop(s);
    applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [] });
    expect(p.chips).toBe(1);
  });

  it('goalChips=tiered：難しい目標ほど多くもらえる（理性の果て＝2枚）', () => {
    const s = game({ goals: 'bonus', chipGain: 'goal', goalChips: 'tiered' });
    s.goals = ['CALM3', 'TOP', 'BIGBUY'];
    const p = s.players[0];
    stack(s, 'DOUBT', 'DOUBT', 'DOUBT');
    for (let i = 0; i < 3; i++) draw(s);
    stop(s);
    applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [] });
    expect(p.chips).toBe(2);
    expect(s.log[s.log.length - 1]).toContain('決心チップ+2');
  });

  it('chipStart：はじめの決心チップ（全員1枚／手番順に0・1・2…枚）', () => {
    const n = (rules: Partial<Rules>, k: number) => newOverlayGame(Array.from({ length: k }, (_, i) => ({ name: `P${i}` })), 1, { rules }).players.map(p => p.chips);
    expect(n({}, 3)).toEqual([0, 0, 0]);
    expect(n({ chipStart: 'one' }, 3)).toEqual([1, 1, 1]);
    expect(n({ chipStart: 'seat' }, 4)).toEqual([0, 1, 2, 3]);
    expect(n({ chipStart: 'seat', chips: false }, 2)).toEqual([0, 0]);
  });

  it('need1：目標を1つ達成するまで，最後の1枚は排除できない', () => {
    const s = game({ goals: 'need1' });
    s.goals = ['TOP', 'IMP3', 'BIGBUY'];
    const p = s.players[0];
    stack(s, 'DOWN'); p.discard = [];
    draw(s); stop(s);
    expect(() => applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [p.placed[0].id] })).toThrow(/目標をあと1つ/);
    const t = game({ goals: 'need1' });
    t.goals = ['DUMP4', 'IMP3', 'BIGBUY'];
    const q = t.players[0];
    stack(t, 'DOWN2', 'DOWN', 'DOWN', 'DOWN'); q.discard = []; // (0,-4)：量2＋運ぶ1 = 3，重さ4には決心チップ1枚．4枚まとめて排除＝目標達成と同時に終われる
    q.chips = 1;
    for (let i = 0; i < 4; i++) draw(t);
    stop(t);
    applyOverlay(t, 0, { type: 'resolve', buy: [], remove: q.placed.map(c => c.id) });
    expect(q.goals).toEqual(['DUMP4']);
    expect(q.finished).toBe(true);
  });

  it('探索ボットは目標を達成してから終わる（need2）．以前のボットも止まらない', () => {
    let a = 5;
    const r = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 - 0.5; };
    const layer = (i: number, o: number) => ({ in: i, out: o, w: Array.from({ length: i * o }, () => r() * 0.4), b: Array.from({ length: o }, r) });
    const model = new ValueModel({ version: FEAT_VERSION, feat: NFEAT, bins: BINS, names: featNames(), layers: [layer(NFEAT, 12), layer(12, BINS)] });
    const o = { model, objective: 'mean' as const, budget: 60 };
    const s = newOverlayGame([{ name: 'A' }, { name: 'B' }], 4, { rules: { goals: 'need2' } });
    let guard = 0;
    while (s.phase === 'play' && guard++ < 60000) applyOverlay(s, s.current, s.current === 0 ? chooseSearchAction(s, o) : chooseOverlayAction(s, OPRESETS.aiFree));
    expect(s.phase).toBe('over');
    for (const i of s.winners) expect(s.players[i].goals!.length).toBeGreaterThanOrEqual(2);
    expect(featNames().length).toBe(NFEAT);
  }, 120000);
});

describe('最後の1枚', () => {
  it('既定：最後の1枚も量のマスでしか排除できない（ルールで「どこでも手放せる」に戻せる）', () => {
    const s = game();
    const p = s.players[0];
    stack(s, 'WANT'); p.discard = []; // 欲しい（↑）だけ：物欲のマスへ出てしまう
    draw(s); stop(s);
    expect(here(s).kind).toBe('buy');
    expect(() => applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [p.placed[0].id] })).toThrow();
    const t = game();
    const q = t.players[0];
    stack(t, 'DOWN'); q.discard = []; // 片付けたい（↓）だけ：(0,-1) の量1で排除できる
    draw(t); stop(t);
    applyOverlay(t, 0, { type: 'resolve', buy: [], remove: [q.placed[0].id] });
    expect(q.finished).toBe(true);
    const u = game({ lastCard: true });
    const r = u.players[0];
    stack(u, 'WANT'); r.discard = [];
    draw(u); stop(u);
    applyOverlay(u, 0, { type: 'resolve', buy: [], remove: [r.placed[0].id] });
    expect(r.finished).toBe(true);
  });
});

describe('盤に置くお気に入り（favBoard）', () => {
  it('大掃除の日：置いたマスで止まると何枚でも排除できる．ほかのマスでは効かない', () => {
    const s = game({ favBoard: true });
    const p = s.players[0];
    p.perms.push('BIGDAY'); p.furn = [{ kind: 'BIGDAY', pos: { x: -1, y: 0 } }];
    p.discard = [{ id: s.nextId++, kind: 'JUNK' }];
    stack(s, 'DOUBT'); // ← で (-1,0) へ
    draw(s);
    expect(here(s)).toEqual({ kind: 'remove', amount: UNLIMITED });
    stop(s);
    applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [p.placed[0].id] });
    expect(p.removed).toBe(1);
    pass(s);
    stack(s, 'WANT', 'WANT', 'DOWN', 'DOWN', 'DOWN'); // 上へ2つ，下へ3つ → (0,-1) 量1：重さ2の「欲しい」2枚は捨てられない
    for (let i = 0; i < 5; i++) draw(s);
    expect(here(s)).toEqual({ kind: 'remove', amount: 1 });
    stop(s);
    expect(() => applyOverlay(s, 0, { type: 'resolve', buy: [], remove: p.placed.filter(c => c.kind === 'WANT').map(c => c.id) })).toThrow();
  });

  it('取得したら盤に置く（場所は選べる．START や置いてあるマスは不可）', () => {
    const s = game({ favBoard: true });
    const p = s.players[0];
    stack(s, 'RUSH', 'RUSH', 'UP2', 'UP2', 'UP2'); // (2,3)：額 4+2 = 6，衝動2
    for (let i = 0; i < 5; i++) draw(s);
    expect(here(s)).toEqual({ kind: 'buy', amount: 6 });
    stop(s);
    expect(() => applyOverlay(s, 0, { type: 'resolve', buy: ['BIGDAY'], remove: [], place: [{ kind: 'BIGDAY', pos: { x: 0, y: 0 } }] })).toThrow();
    applyOverlay(s, 0, { type: 'resolve', buy: ['BIGDAY'], remove: [], place: [{ kind: 'BIGDAY', pos: { x: 0, y: -1 } }] });
    expect(p.furn).toEqual([{ kind: 'BIGDAY', pos: { x: 0, y: -1 } }]);
    expect(p.perms).toContain('BIGDAY');
  });

  it('ルンバ：そのマスに最初に置いたタイルを吸い込む（1手番に1枚）', () => {
    const s = game({ favBoard: true });
    const p = s.players[0];
    p.perms.push('ROOMBA'); p.furn = [{ kind: 'ROOMBA', pos: { x: 1, y: 0 } }];
    p.discard = [];
    stack(s, 'RUSH', 'JUNK', 'RUSH'); // START→(1,0)→(2,0)→(3,0)：ルンバのマスにはガラクタを置く
    draw(s); draw(s); draw(s);
    stop(s);
    applyOverlay(s, 0, { type: 'resolve', buy: [], remove: [] });
    expect(p.removed).toBe(1);
    expect(ownedTiles(p).some(t => t.kind === 'JUNK')).toBe(false);
    expect(ownedTiles(p).filter(t => t.kind === 'RUSH').length).toBe(2);
    expect(p.chips).toBe(0); // 排除できた手番なので決心チップはもらえない
  });

  it('既存のボットと探索ボットが，試作タイル＋盤に置くお気に入りの卓を最後まで遊べる', () => {
    let a = 11;
    const r = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 - 0.5; };
    const layer = (i: number, o: number) => ({ in: i, out: o, w: Array.from({ length: i * o }, () => r() * 0.4), b: Array.from({ length: o }, r) });
    const json: ValueJson = { version: FEAT_VERSION, feat: NFEAT, bins: BINS, names: featNames(), layers: [layer(NFEAT, 12), layer(12, BINS)] };
    const model = new ValueModel(json);
    const market = marketFromChoice([...BUYABLE]);
    for (let seed = 1; seed <= 2; seed++) {
      const s = newOverlayGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }], seed, { rules: { favBoard: true }, market });
      const gs = [OPRESETS.aiFree, OPRESETS.fav, OPRESETS.aiLight];
      while (s.phase === 'play') playOverlayTurn(s, gs);
      expect(s.phase).toBe('over');
      const t = newOverlayGame([{ name: 'A' }, { name: 'B' }], seed, { rules: { favBoard: true }, market });
      let guard = 0;
      let rnd = seed;
      const rand = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return rnd / 4294967296; };
      while (t.phase === 'play' && guard++ < 50000) applyOverlay(t, t.current, chooseSearchAction(t, optsFor(model, rand)));
      expect(t.phase).toBe('over');
    }
  }, 120000);
});

const optsCache = new Map<ValueModel, ReturnType<typeof mk>>();
const mk = (model: ValueModel, rand: () => number) => ({ model, objective: 'win' as const, budget: 60, epsPlace: 0.5, epsBuy: 0.2, rand });
function optsFor(model: ValueModel, rand: () => number) {
  let o = optsCache.get(model);
  if (!o) optsCache.set(model, o = mk(model, rand));
  return o;
}
