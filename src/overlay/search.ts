// オーバーレイ版の探索ボット：手番の中は探索で読み，手番が終わったときの持ち物を評価関数 V（value.ts）で点数にする
//   引く／止める・向き：袋の中身（種類ごとの枚数．順番は見ない）の確率で平均し，葉の予算に合わせた深さまで読む
//   止まったとき：取得は買える組み合わせ，排除は捨てられる組み合わせを V で比べて一番良いものを選ぶ（固定の優先順は無い）
//   点数：mean = あと何手番かの平均（小さいほど良い）／win = 相手の残り手番の分布も見た勝つ確率
// 仕様：Memories/01_BoardGames/ミニマリスト_オーバーレイ版_ボット強化_仕様.md

import { ALL_PERMS as PERMS, BUYABLE, Dir, FURN_KINDS, OKind, TILES, UNLIMITED_KINDS, isPerm, topAt, DROP_CHIP } from './tiles';
import {
  Env, Furn, MAX_CHIPS, OAction, OPlayer, OState, Placed, Pos, Rules, Tile, X_MAX, X_MIN, canBuyAt, canDraw, canDropAt, canMove, canPlaceFurn, chipNeed,
  dirsOf, discardLimit, GOAL_KINDS, goalReward, effectAt, envOf, exitPos, goalMet, goalNeed, hasGlobal, isDeep, isLastCard, ownedTiles, samePos, yMax, yMin,
} from './engine';
import { BAG_KINDS, BINS, GOAL_BIT, KIDX, MIDX, NFEAT, NK, NM, ValueModel, boardExt, countsOf, featOfPlayer, fillFeat, goalMask, kindWeights, permMaskOf, popcount, stockOf } from './value';

export interface SearchOpts {
  model: ValueModel;
  /** mean：あと何手番かの平均を小さく／win：勝つ確率を大きく */
  objective?: 'mean' | 'win';
  /** 1回の判断で読む葉の数の目安（引くたびに枝の数で割り，足りなくなったところで読みを止める） */
  budget?: number;
  /** 学習データ用：この種類を買うと点数を上乗せ（持っている枚数が cap 未満のあいだ）．いろいろな買い方を経験させる */
  bonus?: Partial<Record<OKind, { v: number; cap: number }>>;
  /** この種類は買わない（制約つきの最善手を探すとき．V には在庫0として渡す） */
  ban?: OKind[];
  /** 学習データ用：取得をでたらめに選ぶ確率 */
  epsBuy?: number;
  /** 学習データ用：目標を1つ達成するごとに点数を上乗せ（V がまだ目標を知らないうちから，目標を取りに行かせる） */
  goalBonus?: number;
  /** 学習データ用：盤に置くお気に入りの置き場所をでたらめに選ぶ確率（START から3歩以内） */
  epsPlace?: number;
  rand?: () => number;
}

interface Node { pos: Pos; hes: number; placed: Placed[]; bag: number[]; bagN: number; disc: number[]; discN: number }
/** 止まったときの選び方．flow・disc は種類ごとの枚数（置いたタイル／捨て山から排除），roomba は種類（-1 = 使わない） */
interface Plan { u: number; buy: OKind[]; flow: number[] | null; roomba: number; disc: number[] | null; place?: Furn[] }
/** 盤の様子（お気に入りの置き場所と棚）の特徴量 */
/** g：達成した目標のビット（この手番の止まり方で達成するぶんを含む） */
interface Ext { key: string; v: number[]; furn: Furn[]; shelves: Pos[]; g: number }
/** 目標が足りないのに持ち物が0枚になる選び方（ルールで許されない）の点数 */
const ILLEGAL = -1e6;
const JUNK_K = KIDX.JUNK;
/**
 * 止まったときの下ごしらえ：pc = 置いたタイルのうち選んで排除できる枚数，discP = 何もしなければ手番のあとに持ち物として残る枚数（袋以外），
 * base = 選ばなくても排除される枚数（盤のルンバ），shelves = 手番のあとの棚の位置，tag = これらを区別する文字列
 */
interface Sit { pc: number[]; discP: number[]; ext: Ext; shelves: Pos[]; base: number; tag: string }

const ZERO: number[] = new Array(NK).fill(0);
const PERM_BIT = Object.fromEntries(PERMS.map((k, i) => [k, 1 << i])) as Record<OKind, number>;
const sum = (a: ArrayLike<number>) => { let n = 0; for (let i = 0; i < a.length; i++) n += a[i]; return n; };
const posKey = (p: Pos) => `${p.x},${p.y}`;

/** 1手番のあいだ使い回すもの（持ち物・相手・市場は手番中に変わらない） */
class Turn {
  readonly p: OPlayer; readonly env: Env; readonly rules: Rules;
  readonly chips: number; readonly permMask: number; readonly stock: number[]; readonly gacha: number[]; readonly gachaN: number;
  readonly weights: number[]; readonly owned: number[];
  /** どこでも効くお気に入り（盤に置くルールでは，大掃除の日とルンバはここに入らない） */
  readonly hasRoomba: boolean; readonly hasBigday: boolean;
  /** 理性のお気に入り：ためらいで止まらない／排除の条件を無視／排除できた手番でも決心チップ */
  readonly hasYutori: boolean; readonly noCond: boolean; readonly hasKakeibo: boolean;
  readonly furn0: Furn[]; readonly shelves0: Pos[]; readonly ext0: Ext; readonly roombaPos: Pos | null;
  /** 目標：この試合の目標のビット，手番の初めに達成済みのビット，最後の1枚を排除するのに要る数 */
  readonly goalsOn: number; readonly g0: number; readonly need: number; readonly reward: number[];
  /** u[t] = この手番のあと t 手番で終わるときの点数（t = 0 はこの手番で終わる） */
  readonly u = new Float64Array(BINS + 1);
  private readonly x = new Float64Array(NFEAT);
  private readonly d = new Float64Array(BINS);
  private readonly vCache = new Map<string, number>();
  private readonly stopCache = new Map<string, number>();
  private readonly buyAll = new Map<string, OKind[][]>();
  private readonly buyShort = new Map<string, OKind[][]>();
  private readonly extCache = new Map<string, Ext>();
  private readonly places = new Map<OKind, Pos[]>();
  readonly round: number; readonly seat: number;

  constructor(readonly s: OState, readonly o: SearchOpts) {
    const p = this.p = s.players[s.current];
    this.round = s.round; this.seat = s.current;
    this.env = envOf(s, p); this.rules = s.rules;
    if (s.rules.dropChips && s.rules.chips) this.dropW = BAG_KINDS.map(k => DROP_CHIP[k]);
    this.chips = s.rules.chips ? p.chips ?? 0 : 0;
    this.permMask = permMaskOf(p.perms);
    this.stock = stockOf(s);
    for (const k of o.ban ?? []) this.stock[MIDX[k]] = 0; // 買わないと決めた種類は「市場に無い」ものとして読む
    this.gacha = countsOf(s.gacha.map(kind => ({ kind }))); this.gachaN = s.gacha.length;
    this.weights = kindWeights(s.rules);
    this.owned = countsOf(ownedTiles(p));
    this.hasRoomba = hasGlobal(p.perms, 'ROOMBA', s.rules); this.hasBigday = hasGlobal(p.perms, 'BIGDAY', s.rules);
    this.hasYutori = p.perms.includes('YUTORI'); this.noCond = p.perms.includes('KOKOROE'); this.hasKakeibo = p.perms.includes('KAKEIBO');
    this.furn0 = s.rules.favBoard ? p.furn ?? [] : [];
    this.shelves0 = (p.fixed ?? []).map(f => f.pos);
    this.goalsOn = goalMask(s.goals); this.g0 = goalMask(p.goals) & this.goalsOn; this.need = goalNeed(s.rules);
    this.reward = GOAL_KINDS.map(k => goalReward(k, s.rules));
    this.ext0 = this.ext(this.shelves0, this.furn0);
    this.roombaPos = this.furn0.find(f => f.kind === 'ROOMBA')?.pos ?? null;
    this.setUtility();
  }

  private ext(shelves: Pos[], furn: Furn[], g: number = this.g0): Ext {
    const key = furn.map(f => f.kind + posKey(f.pos)).join(';') + '|' + shelves.map(posKey).join(';') + '|' + g;
    let e = this.extCache.get(key);
    if (!e) this.extCache.set(key, e = { key, v: boardExt(furn, shelves, this.goalsOn & ~g, Math.max(0, this.need - popcount(g))), furn, shelves, g });
    return e;
  }

  private setUtility(): void {
    const { s, o, u } = this;
    if ((o.objective ?? 'mean') === 'mean') { for (let t = 0; t <= BINS; t++) u[t] = -t; return; }
    // 勝つ確率：相手ごとに「このラウンドから数えて何ラウンド目に終わるか」の分布を V から作る（相手どうし・自分とは独立とみなす）
    const me = this.p, mine = me.removed + ownedTiles(me).length;
    for (let t = 0; t <= BINS; t++) u[t] = 1;
    const x = new Float64Array(NFEAT), d = new Float64Array(BINS);
    s.players.forEach((q, j) => {
      if (j === this.seat) return;
      const f = new Float64Array(BINS + 2); // f[r] = 相手がこのラウンド＋r で終わる確率
      if (q.finished) f[0] = 1;
      else {
        o.model.dist(featOfPlayer(s, q, x), d);
        const shift = j < this.seat ? 1 : 0; // 自分より前の席はこのラウンドの手番を終えている
        for (let t = 1; t <= BINS; t++) f[Math.min(BINS + 1, t - 1 + shift)] += d[t - 1];
      }
      // 同じラウンドに終わったら排除した枚数が多いほうの勝ち（最後まで行けば「排除済み＋持ち物」が排除枚数になる）
      const theirs = q.removed + ownedTiles(q).length;
      const tie = mine > theirs ? 1 : mine === theirs ? 0.5 : 0;
      let later = 1;
      for (let t = 0; t <= BINS; t++) { later -= f[t]; u[t] *= Math.max(0, later) + tie * f[t]; }
    });
    for (let t = 0; t <= BINS; t++) u[t] -= 0.002 * t; // 勝つ確率が同じなら早いほうを選ぶ
  }

  /** 手番が終わったときの持ち物の点数．bag が空なら disc を袋とみなす */
  leaf(bag: ArrayLike<number>, disc: ArrayLike<number>, permMask: number, chips: number, removed: number, stock: ArrayLike<number>, ext: Ext, cache = true): number {
    const bn = sum(bag), dn = sum(disc);
    if (bn + dn < 1e-9) return popcount(ext.g) >= this.need ? this.u[0] : ILLEGAL;
    if (bn < 1e-9) { bag = disc; disc = ZERO; }
    let key = '';
    if (cache) {
      for (let i = 0; i < NK; i++) key += String.fromCharCode(48 + bag[i], 48 + disc[i]);
      for (let i = 0; i < NM; i++) key += String.fromCharCode(48 + Math.min(3, stock[i]));
      key += String.fromCharCode(48 + permMask, 48 + chips, 48 + Math.min(removed, 15)) + ext.key;
      const v = this.vCache.get(key);
      if (v !== undefined) return v;
    }
    fillFeat(this.x, bag, disc, permMask, chips, removed, stock, this.gachaN, this.s.players.length, this.weights, ext.v);
    this.o.model.dist(this.x, this.d);
    let v = 0;
    for (let t = 1; t <= BINS; t++) v += this.d[t - 1] * this.u[t];
    if (cache) { if (this.vCache.size > 200000) this.vCache.clear(); this.vCache.set(key, v); } // 袋が大きい局面でメモリが膨らまないように
    return v;
  }

  /** 今見ている止まり方で，ご褒美の上にいてもらえる決心チップ（plan のあいだだけ） */
  private stopChip = 0;
  /** 手放すと決心チップ（ルール dropChips）：種類ごとの強さ．plan のあいだ，止まる前の捨て山（＋置いたタイル）と列を覚えておき，減ったぶんを排除とみなす */
  private dropW: Array<'strong' | 'calm' | undefined> | null = null;
  private dropBase: number[] | null = null;
  private dropX = 0;
  private dropGain(disc: ArrayLike<number>): number {
    const w = this.dropW, b = this.dropBase;
    if (!w || !b) return 0;
    let n = 0;
    for (let k = 0; k < w.length; k++) if (w[k] && b[k] > disc[k] && (w[k] === 'strong' || this.dropX < 0)) n += b[k] - disc[k];
    return n;
  }

  /** 新しく達成した目標（ビット）でもらえる決心チップ */
  private gain(m: number): number {
    let n = 0;
    for (let i = 0; m; i++, m >>= 1) if (m & 1) n += this.reward[i];
    return n;
  }

  /** 排除の有無から決心チップの増減を決めて点数にする */
  private finish(bag: ArrayLike<number>, disc: ArrayLike<number>, permMask: number, spent: number, nRemoved: number, stock: ArrayLike<number>, ext: Ext, cache = true, junk = false, buyCost = 0): number {
    // 目標のうち，選び方で決まるもの（4枚以上排除・合計コスト5以上）．junk は「ガラクタを排除したか」（今の目標には無いが，判定の口は残してある）
    void junk;
    if (this.goalsOn) {
      const dyn = ((nRemoved >= 4 ? GOAL_BIT.DUMP4 : 0) | (buyCost >= 5 ? GOAL_BIT.BIGBUY : 0)) & this.goalsOn & ~ext.g;
      if (dyn) ext = this.ext(ext.shelves, ext.furn, ext.g | dyn);
    }
    let chips = this.chips - spent + this.stopChip + this.dropGain(disc);
    if (this.rules.chips) {
      chips = Math.min(MAX_CHIPS, chips + this.gain(ext.g & ~this.g0)); // 目標を達成したぶん
      if (((this.rules.chipGain === 'idle' && nRemoved === 0) || this.hasKakeibo) && chips < MAX_CHIPS) chips++;
    }
    const v = this.leaf(bag, disc, permMask, chips, this.p.removed + nRemoved, stock, ext, cache);
    return this.o.goalBonus && ext.g !== this.g0 ? v + this.o.goalBonus * popcount(ext.g & ~this.g0) : v;
  }

  /** 止まったときの下ごしらえ（盤に残る棚・盤のルンバが吸うタイルを先に引いておく） */
  private sit(node: Node): Sit {
    const pc = countsOf(node.placed);
    const discP = node.disc.map((n, i) => n + pc[i]);
    let shelves = this.shelves0, ext = this.ext0, base = 0, tag = '';
    let added: Pos[] | null = null;
    for (const t of node.placed) {
      if (!TILES[t.kind].stay) continue;
      const k = KIDX[t.kind];
      pc[k]--; // 選んで排除はできない
      const taken = added ? [...this.shelves0, ...added] : this.shelves0;
      if ((t.pos.x !== 0 || t.pos.y !== 0) && !(this.p.furn ?? []).some(f => samePos(f.pos, t.pos)) && !taken.some(q => samePos(q, t.pos))) {
        discP[k]--; (added ??= []).push(t.pos); // 盤に残って持ち物から外れる
      }
    }
    if (added) { shelves = [...this.shelves0, ...added]; tag += 's' + added.map(posKey).join(';'); }
    // 使い切り：排除できず，手番の終わりに持ち物から外れる（最後の1枚なら残る）
    let owned = node.bagN + node.discN + node.placed.length;
    for (const t of node.placed) {
      if (!TILES[t.kind].oneShot || owned <= 1) continue;
      const k = KIDX[t.kind];
      pc[k]--; discP[k]--; owned--; tag += 'o';
    }
    let eatenJunk = false;
    if (this.roombaPos) {
      const rp = this.roombaPos;
      const first = node.placed.find(c => samePos(c.pos, rp));
      if (first && !TILES[first.kind].stay) { const k = KIDX[first.kind]; pc[k]--; discP[k]--; base = 1; tag += 'r' + k; eatenJunk = k === JUNK_K; }
    }
    // 目標のうち，止まった場所と置いたタイルで決まるもの
    let g = this.g0;
    if (this.goalsOn & ~this.g0) {
      const info = { pos: node.pos, placed: node.placed, fx: effectAt(this.env, node.placed, node.pos).kind, nRemoved: base, junk: eatenJunk, buyCost: 0 };
      for (const k of this.s.goals!) if (!(g & GOAL_BIT[k]) && goalMet(k, this.s.board, info)) g |= GOAL_BIT[k];
      if (g !== this.g0) tag += 'g' + g;
    }
    if (added || g !== this.g0) ext = this.ext(shelves, this.furn0, g);
    return { pc, discP, ext, shelves, base, tag };
  }

  // ---- 取得 ----

  /** 額 amount・列 lvl（−2〜2．負は理性）で買える組み合わせ（1回に4枚まで．同じ種類は3枚まで） */
  private buyOptions(amount: number, lvl: number): OKind[][] {
    const key = `${amount}:${lvl}`;
    let out = this.buyAll.get(key);
    if (out) return out;
    out = [];
    const ks = BUYABLE.filter(k => this.stock[MIDX[k]] > 0 && !(isPerm(k) && this.s.round < this.rules.favFrom) && (TILES[k].cost ?? 99) <= amount && canBuyAt(k, lvl, this.rules) && !(isPerm(k) && this.p.perms.includes(k)));
    const cur: OKind[] = [];
    const rec = (i: number, left: number) => {
      out!.push([...cur]);
      if (cur.length >= 4) return;
      for (let j = i; j < ks.length; j++) {
        const k = ks[j], c = TILES[k].cost!;
        if (c > left) continue;
        const n = cur.filter(z => z === k).length;
        if (n >= Math.min(isPerm(k) ? 1 : 3, this.stock[MIDX[k]])) continue;
        if (isPerm(k) && this.rules.favCap && this.p.perms.length + cur.filter(isPerm).length >= this.rules.favCap) continue;
        cur.push(k); rec(j, left - c); cur.pop();
      }
    };
    rec(0, amount);
    this.buyAll.set(key, out);
    return out;
  }

  private bonusOf(buy: OKind[]): number {
    const b = this.o.bonus;
    if (!b || !buy.length) return 0;
    let v = 0;
    const got: Partial<Record<OKind, number>> = {};
    for (const k of buy) {
      const e = b[k];
      if (!e) continue;
      const have = (isPerm(k) ? 0 : this.owned[KIDX[k]] + (this.p.used?.filter(z => z === k).length ?? 0)) + (got[k] ?? 0); // 使い切ったぶんも持っていたと数える
      if (have < e.cap) v += e.v;
      got[k] = (got[k] ?? 0) + 1;
    }
    return v;
  }

  /** 盤に置くお気に入り kind の置き場所の候補（V の点数の高い順．今の持ち物で比べる） */
  private placesFor(kind: OKind): Pos[] {
    let out = this.places.get(kind);
    if (out) return out;
    const p = this.p, b = this.s.board;
    const cells: Pos[] = [];
    for (let y = yMax(b); y >= yMin(b); y--) for (let x = X_MIN; x <= X_MAX; x++) if (canPlaceFurn({ x, y }, b, p.furn ?? [], p.fixed ?? [])) cells.push({ x, y });
    cells.sort((a, z) => Math.abs(a.x) + Math.abs(a.y) - Math.abs(z.x) - Math.abs(z.y)); // 点数が同じなら START に近いマス
    const o = this.o;
    if (o.epsPlace && o.rand && o.rand() < o.epsPlace) {
      const near = cells.filter(c => Math.abs(c.x) + Math.abs(c.y) <= 3);
      const pick = near[Math.floor(o.rand() * near.length)];
      out = [pick, ...cells.filter(c => c !== pick)];
    } else {
      let bag = countsOf(p.bag), disc = countsOf(p.placed, countsOf(p.discard));
      if (!p.bag.length) { bag = disc; disc = ZERO; }
      const mask = this.permMask | PERM_BIT[kind];
      out = cells.map(c => ({ c, v: this.leaf(bag, disc, mask, this.chips, p.removed, this.stock, this.ext(this.shelves0, [...this.furn0, { kind, pos: c }])) }))
        .sort((a, z) => z.v - a.v).map(z => z.c);
    }
    this.places.set(kind, out);
    return out;
  }
  /** buy に含まれる盤に置くお気に入りの置き場所（同じマスにならないように上から取る） */
  private placeOf(buy: OKind[]): Furn[] {
    const out: Furn[] = [];
    if (!this.rules.favBoard) return out;
    for (const k of buy) {
      if (!FURN_KINDS.includes(k)) continue;
      const pos = this.placesFor(k).find(c => !out.some(f => samePos(f.pos, c)));
      if (pos) out.push({ kind: k, pos });
    }
    return out;
  }

  /** buy を買ったあとの点数（捨て山 disc に足す．お気に入りは permMask へ） */
  private buyValue(buy: OKind[], bag: number[], disc: number[], nRemoved: number, st: Sit, junk = false): number {
    if (!buy.length) return this.finish(bag, disc, this.permMask, 0, nRemoved, this.stock, st.ext, true, junk);
    const d = disc.slice(), stk = this.stock.slice();
    let mask = this.permMask;
    for (const k of buy) {
      if (isPerm(k)) mask |= PERM_BIT[k]; else d[KIDX[k]]++;
      if (!UNLIMITED_KINDS.includes(k)) stk[MIDX[k]]--;
    }
    const place = this.placeOf(buy);
    const ext = place.length ? this.ext(st.shelves, [...this.furn0, ...place], st.ext.g) : st.ext;
    return this.finish(bag, d, mask, 0, nRemoved, stk, ext, true, junk, buy.reduce((n, k) => n + (TILES[k].cost ?? 0), 0)) + this.bonusOf(buy);
  }

  /** 探索の葉で試す組み合わせ：今の持ち物で点数の高い順に少数だけ（葉ごとに全部は試さない） */
  private shortBuy(amount: number, lvl: number): OKind[][] {
    const key = `${amount}:${lvl}`;
    let out = this.buyShort.get(key);
    if (out) return out;
    const all = this.buyOptions(amount, lvl);
    if (all.length <= 4) out = all;
    else {
      const p = this.p;
      let bag = countsOf(p.bag), disc = countsOf(p.placed, countsOf(p.discard));
      if (!p.bag.length) { bag = disc; disc = ZERO; }
      const st: Sit = { pc: ZERO, discP: disc, ext: this.ext0, shelves: this.shelves0, base: 0, tag: '' };
      out = all.map(b => ({ b, v: this.buyValue(b, bag, disc, 0, st) })).sort((a, b) => b.v - a.v).slice(0, 3).map(x => x.b);
      if (!out.some(b => !b.length)) out.push([]);
    }
    this.buyShort.set(key, out);
    return out;
  }

  // ---- 止まったとき ----

  /** どこでも効くルンバで1枚（置いたタイルから）を排除する選び方を足して，良いほうを返す */
  private withRoomba(base: Plan, pc: number[], used: number[] | null, f: (r: number) => number): Plan {
    if (!this.hasRoomba) return base;
    let best = base;
    for (let k = 0; k < NK; k++) {
      if (pc[k] - (used ? used[k] : 0) <= 0) continue;
      const u = f(k);
      if (u > best.u) best = { ...base, u, roomba: k };
    }
    return best;
  }

  private removePlan(node: Node, st: Sit, bag: ArrayLike<number>, discP: number[], q: number, deep: boolean, discOk: number[], cache: boolean): Plan {
    const x = node.pos.x, rules = this.rules, pc = st.pc;
    const nc = this.noCond || node.placed.some(c => TILES[c.kind].freeDrop); // 軽やかが盤にあれば条件なし
    const kinds: number[] = [];
    for (let k = 0; k < NK; k++) if (pc[k] > 0) kinds.push(k);
    // 置いたタイルの部分集合を全部（種類ごとの枚数）
    const tops: Plan[] = [];
    const flow = new Array(NK).fill(0), tiles: Tile[] = [];
    // 組み合わせが多すぎるとき（大掃除の日でたくさん置いた，など）は，良くなるあいだ1枚ずつ足す
    let combos = 1;
    for (const k of kinds) combos *= pc[k] + 1;
    const greedy = combos > 2048;
    if (greedy) {
      const cur = new Array(NK).fill(0), ts: Tile[] = [];
      const d = discP.slice();
      let u = this.finish(bag, d, this.permMask, 0, st.base, this.stock, st.ext, cache);
      for (;;) {
        let bk = -1, bu = u;
        for (const k of kinds) {
          if (cur[k] >= pc[k]) continue;
          ts.push({ id: 0, kind: BAG_KINDS[k] });
          const need = chipNeed(ts, [], x, q, rules, this.hasBigday, nc);
          if (need <= this.chips) {
            d[k]--; const v = this.finish(bag, d, this.permMask, need, st.base + ts.length, this.stock, st.ext, cache, cur[JUNK_K] > 0 || k === JUNK_K); d[k]++;
            if (v > bu) { bu = v; bk = k; }
          }
          ts.pop();
        }
        if (bk < 0) break;
        cur[bk]++; d[bk]--; ts.push({ id: 0, kind: BAG_KINDS[bk] }); u = bu;
      }
      tops.push({ u, buy: [], flow: cur, roomba: -1, disc: null });
    }
    const rec = (i: number) => {
      if (i === kinds.length) {
        const need = chipNeed(tiles, [], x, q, rules, this.hasBigday, nc);
        if (need > this.chips) return;
        const d = discP.slice();
        for (const k of kinds) d[k] -= flow[k];
        const u = this.finish(bag, d, this.permMask, need, st.base + tiles.length, this.stock, st.ext, cache, flow[JUNK_K] > 0);
        if (tops.length < 2 || u > tops[tops.length - 1].u) {
          tops.push({ u, buy: [], flow: flow.slice(), roomba: -1, disc: null });
          tops.sort((a, b) => b.u - a.u);
          if (tops.length > 2) tops.pop();
        }
        return;
      }
      const k = kinds[i];
      rec(i + 1);
      for (let n = 1; n <= pc[k]; n++) { flow[k]++; tiles.push({ id: 0, kind: BAG_KINDS[k] }); rec(i + 1); }
      for (let n = 1; n <= pc[k]; n++) { flow[k]--; tiles.pop(); }
    };
    if (!greedy) rec(0);
    // 上位について，ルンバ・捨て山からの排除（良くなるあいだ1枚ずつ）を足す
    const limit = discardLimit(this.p, q, deep);
    let best: Plan | null = null;
    for (const t of tops) {
      const fl = t.flow!, nFlow = sum(fl);
      const need = chipNeed(BAG_KINDS.flatMap((k, i) => Array.from({ length: fl[i] }, () => ({ id: 0, kind: k }))), [], x, q, rules, this.hasBigday, nc);
      const d = discP.slice();
      for (let k = 0; k < NK; k++) d[k] -= fl[k];
      let plan = this.withRoomba(t, pc, fl, r => { d[r]--; const u = this.finish(bag, d, this.permMask, need, st.base + nFlow + 1, this.stock, st.ext, cache, fl[JUNK_K] > 0 || r === JUNK_K); d[r]++; return u; });
      let n = st.base + nFlow + (plan.roomba >= 0 ? 1 : 0);
      if (plan.roomba >= 0) d[plan.roomba]--;
      const left = discOk.slice(), dz = new Array(NK).fill(0);
      for (let i = 0; i < limit; i++) {
        let bk = -1, bu = plan.u;
        for (let k = 0; k < NK; k++) {
          if (left[k] < 1 || !canDropAt(BAG_KINDS[k], x, rules, nc)) continue;
          d[k]--; const u = this.finish(bag, d, this.permMask, need, n + 1, this.stock, st.ext, cache, fl[JUNK_K] > 0 || plan.roomba === JUNK_K || dz[JUNK_K] > 0 || k === JUNK_K); d[k]++;
          if (u > bu) { bu = u; bk = k; }
        }
        if (bk < 0) break;
        d[bk]--; left[bk]--; dz[bk]++; n++;
        plan = { ...plan, u: bu, disc: dz.slice() };
      }
      if (!best || plan.u > best.u) best = plan;
    }
    return best ?? { u: -Infinity, buy: [], flow: null, roomba: -1, disc: null };
  }

  /** 今のマスで止まったときの一番良い選び方．exact：実際に止まったあと（取得は全部の組み合わせを試す．運試しは引いた結果を使う） */
  plan(node: Node, exact: boolean, st: Sit = this.sit(node)): Plan {
    const saved = this.stopChip, savedBase = this.dropBase, savedX = this.dropX;
    const top = this.rules.chips ? topAt(node.placed, node.pos) : undefined;
    this.stopChip = top ? TILES[top.kind].stopChip ?? 0 : 0;
    if (this.dropW) { this.dropBase = st.discP.slice(); this.dropX = node.pos.x; }
    try { return this.planAt(node, exact, st); } finally { this.stopChip = saved; this.dropBase = savedBase; this.dropX = savedX; }
  }

  private planAt(node: Node, exact: boolean, st: Sit): Plan {
    const { p, rules } = this;
    if (rules.lastCard && node.bagN === 0 && node.discN === 0 && node.placed.length === 1 && popcount(st.ext.g) >= this.need) {
      const fl = new Array(NK).fill(0); fl[KIDX[node.placed[0].kind]] = 1;
      return { u: this.u[0], buy: [], flow: fl, roomba: -1, disc: null };
    }
    const fx = exact && p.roll != null ? { kind: 'remove' as const, amount: p.roll } : effectAt(this.env, node.placed, node.pos);
    const { pc, discP } = st;
    const x = node.pos.x;
    const idle = (): Plan => {
      const base: Plan = { u: this.finish(node.bag, discP, this.permMask, 0, st.base, this.stock, st.ext), buy: [], flow: null, roomba: -1, disc: null };
      return this.withRoomba(base, pc, null, r => { discP[r]--; const u = this.finish(node.bag, discP, this.permMask, 0, st.base + 1, this.stock, st.ext, true, r === JUNK_K); discP[r]++; return u; });
    };
    switch (fx.kind) {
      case 'buy': {
        const lvl = Math.max(-2, Math.min(2, x)); // 取得の条件は衝動2・理性2まで
        const opts = exact ? this.buyOptions(fx.amount, lvl) : this.shortBuy(fx.amount, lvl);
        if (exact && this.o.epsBuy && this.o.rand && this.o.rand() < this.o.epsBuy) {
          const b = opts[Math.floor(this.o.rand() * opts.length)];
          return { u: this.buyValue(b, node.bag, discP, st.base, st), buy: b, flow: null, roomba: -1, disc: null, place: this.placeOf(b) };
        }
        let best: Plan | null = null;
        for (const b of opts) {
          const base: Plan = { u: this.buyValue(b, node.bag, discP, st.base, st), buy: b, flow: null, roomba: -1, disc: null };
          const pl = this.withRoomba(base, pc, null, r => { discP[r]--; const u = this.buyValue(b, node.bag, discP, st.base + 1, st, r === JUNK_K); discP[r]++; return u; });
          if (!best || pl.u > best.u) best = pl;
        }
        if (exact) best!.place = this.placeOf(best!.buy);
        return best!;
      }
      case 'remove': {
        const rolled = exact && p.roll != null;
        const ok = rolled ? countsOf(p.discard.filter(t => !p.rollIds?.includes(t.id))) : node.disc;
        return this.removePlan(node, st, node.bag, discP, fx.amount, isDeep(node.pos.y, this.s.board), ok, true);
      }
      case 'gacha': {
        if (!this.gachaN) return idle();
        const val = (nRem: number, d0: number[]) => {
          let v = 0;
          for (let k = 0; k < NK; k++) {
            if (!this.gacha[k]) continue;
            d0[k]++; v += this.gacha[k] * this.finish(node.bag, d0, this.permMask, 0, nRem, this.stock, st.ext); d0[k]--;
          }
          return v / this.gachaN;
        };
        const base: Plan = { u: val(st.base, discP), buy: [], flow: null, roomba: -1, disc: null };
        return this.withRoomba(base, pc, null, r => { discP[r]--; const u = val(st.base + 1, discP); discP[r]++; return u; });
      }
      case 'lucky': {
        // 当たりの位置は 0〜袋の残り枚数が同じ確率．表にしたタイルは捨て山へ（排除できない）．中身は袋の構成比で均す
        const n = node.bagN;
        let v = 0;
        for (let k = 0; k <= n; k++) {
          const r = n ? k / n : 0;
          const bag = node.bag.map(c => c * (1 - r)), d = discP.map((c, i) => c + node.bag[i] * r);
          v += this.removePlan(node, st, bag, d, k, false, node.disc, k === 0 || k === n).u;
        }
        return { u: v / (n + 1), buy: [], flow: null, roomba: -1, disc: null };
      }
      default: return idle();
    }
  }

  /** 取得の候補を V の点数の高い順に並べる（額のマスで止まっているとき．検証用） */
  rankBuys(node: Node): { buy: OKind[]; u: number }[] {
    const fx = effectAt(this.env, node.placed, node.pos);
    if (fx.kind !== 'buy') return [];
    const st = this.sit(node);
    return this.buyOptions(fx.amount, Math.max(-2, Math.min(2, node.pos.x))).map(b => ({ buy: b, u: this.buyValue(b, node.bag, st.discP, st.base, st) })).sort((a, b) => b.u - a.u);
  }

  stopValue(node: Node): number {
    const fx = effectAt(this.env, node.placed, node.pos);
    const pc = countsOf(node.placed);
    const st = this.sit(node);
    let key = `${fx.kind[0]}${fx.amount}:${node.pos.x < -2 ? -2 : node.pos.x > 2 ? 2 : node.pos.x}:${isDeep(node.pos.y, this.s.board) ? 1 : 0}:${node.discN}:${st.tag}:`;
    for (let i = 0; i < NK; i++) key += String.fromCharCode(48 + pc[i], 48 + node.bag[i]);
    let v = this.stopCache.get(key);
    if (v === undefined) { v = this.plan(node, false, st).u; if (this.stopCache.size > 100000) this.stopCache.clear(); this.stopCache.set(key, v); }
    return v;
  }

  // ---- 引く／止める ----

  /** 次に引くタイルの入った袋（空なら捨て山を戻す） */
  private drawable(node: Node): { bag: number[]; bagN: number; disc: number[]; discN: number } | null {
    if (node.bagN > 0) return node;
    if (!this.rules.refill || node.discN === 0) return null;
    return { bag: node.disc, bagN: node.discN, disc: ZERO, discN: 0 };
  }
  private forced(kind: OKind, hes: number) { return kind === 'HES' && (hes + 1 >= 2 || (this.rules.hes === 'first' && !this.hasYutori)); }

  /** 次の1枚で分かれる枝の数（種類×向き．必ず止まるタイルは先を読まないので軽く数える） */
  private branching(src: { bag: number[] }, hes: number): number {
    let b = 0;
    for (let k = 0; k < NK; k++) {
      if (!src.bag[k]) continue;
      const kind = BAG_KINDS[k];
      b += this.forced(kind, hes) ? 0.3 : Math.max(1, dirsOf(kind, this.env).length);
    }
    return Math.max(1, b);
  }

  /** タイル kind を今いるマスに置いて dir へ出たあとの価値．budget：その先で読んでよい葉の数 */
  after(node: Node, src: { bag: number[]; bagN: number; disc: number[]; discN: number }, k: number, dir: Dir | null, budget: number): number {
    const kind = BAG_KINDS[k];
    const bag = src.bag.slice(); bag[k]--;
    const placed = [...node.placed, { id: 0, kind, pos: node.pos }];
    const child: Node = { pos: exitPos(this.env, placed, node.pos, kind, dir), hes: node.hes + (kind === 'HES' ? 1 : 0), placed, bag, bagN: src.bagN - 1, disc: src.disc, discN: src.discN };
    return this.forced(kind, node.hes) ? this.stopValue(child) : this.value(child, budget);
  }

  /** 止めるか引くかの良いほう．予算が枝の数に足りなければ，ここで止めるものとして数える */
  value(node: Node, budget: number): number {
    const sv = this.stopValue(node);
    const src = this.drawable(node);
    if (!src || budget < this.branching(src, node.hes)) return sv;
    return Math.max(sv, this.drawValue(node, budget));
  }

  /** もう1枚引いたときの期待値（引けなければ −∞）．予算は枝に等分する */
  drawValue(node: Node, budget: number): number {
    const src = this.drawable(node);
    if (!src) return -Infinity;
    const child = budget / this.branching(src, node.hes);
    let total = 0;
    for (let k = 0; k < NK; k++) {
      if (!src.bag[k]) continue;
      const dirs = dirsOf(BAG_KINDS[k], this.env);
      let best = -Infinity;
      if (!dirs.length) best = this.after(node, src, k, null, child);
      else {
        let stayed = false;
        for (const d of dirs) {
          if (!canMove(this.env, node.pos, d)) { if (stayed) continue; stayed = true; }
          const v = this.after(node, src, k, d, child);
          if (v > best) best = v;
        }
      }
      total += src.bag[k] * best;
    }
    return total / src.bagN;
  }

  get budget() { return this.o.budget ?? 800; }

  root(): Node {
    const p = this.p;
    return { pos: p.pos, hes: p.hes, placed: p.placed, bag: countsOf(p.bag), bagN: p.bag.length, disc: countsOf(p.discard), discN: p.discard.length };
  }
}

const turns = new WeakMap<OState, Turn>();
function turnOf(s: OState, o: SearchOpts): Turn {
  let t = turns.get(s);
  if (!t || t.round !== s.round || t.seat !== s.current || t.o !== o || t.p !== s.players[s.current]) turns.set(s, t = new Turn(s, o));
  return t;
}

/** 種類ごとの枚数を，実際のタイルの id にする */
function pick(from: Tile[], counts: number[] | null, skip: Set<number>): number[] {
  const out: number[] = [];
  if (!counts) return out;
  const need = counts.slice();
  for (const t of from) {
    const k = KIDX[t.kind];
    if (need[k] > 0 && !skip.has(t.id)) { need[k]--; out.push(t.id); skip.add(t.id); }
  }
  return out;
}

export function chooseSearchAction(s: OState, o: SearchOpts): OAction {
  const p = s.players[s.current];
  const t = turnOf(s, o);
  switch (s.turn) {
    case 'resolve': {
      if (s.rules.lastCard && isLastCard(p) && t.need <= popcount(t.g0)) return { type: 'resolve', buy: [], remove: [p.placed[0].id] };
      const pl = t.plan(t.root(), true);
      const used = new Set<number>(p.rollIds ?? []);
      // 盤のルンバが吸うタイル（そのマスに最初に置いたもの）は，選んで排除する対象から外しておく
      if (t.roombaPos) { const rp = t.roombaPos; const first = p.placed.find(c => samePos(c.pos, rp)); if (first && !TILES[first.kind].stay) used.add(first.id); }
      const remove = [...pick(p.placed, pl.flow, used), ...pick(p.discard, pl.disc, used)];
      const roomba = pl.roomba >= 0 ? p.placed.find(c => KIDX[c.kind] === pl.roomba && !used.has(c.id))?.id : undefined;
      return { type: 'resolve', buy: pl.buy, remove, roomba, ...(pl.place?.length ? { place: pl.place } : {}) };
    }
    case 'branch': {
      const node = t.root();
      const tile = p.placed[p.placed.length - 1];
      // 置いたタイルはもう盤にある．向きごとに出たあとの価値を比べる
      const before: Node = { ...node, placed: p.placed.slice(0, -1), hes: p.hes };
      const src = { bag: node.bag.slice(), bagN: node.bagN + 1, disc: node.disc, discN: node.discN };
      src.bag[KIDX[tile.kind]]++;
      const budget = t.budget / Math.max(1, dirsOf(tile.kind, t.env).length);
      let best: Dir = dirsOf(tile.kind, t.env)[0], bv = -Infinity;
      for (const d of dirsOf(tile.kind, t.env)) {
        const v = t.after(before, src, KIDX[tile.kind], d, budget);
        if (v > bv) { bv = v; best = d; }
      }
      return { type: 'branch', dir: best };
    }
    case 'move': {
      if (!canDraw(p, s.rules) || (s.rules.lastCard && isLastCard(p))) return { type: 'stop' };
      if (!p.placed.length) return { type: 'draw' };
      const node = t.root();
      return t.drawValue(node, t.budget) > t.stopValue(node) + 1e-9 ? { type: 'draw' } : { type: 'stop' };
    }
  }
}

/** 止まったあと（resolve）の取得の候補と V の点数（高い順）．額のマスでなければ空 */
export function rankBuys(s: OState, o: SearchOpts): { buy: OKind[]; u: number }[] {
  const t = turnOf(s, o);
  return s.turn === 'resolve' ? t.rankBuys(t.root()) : [];
}
