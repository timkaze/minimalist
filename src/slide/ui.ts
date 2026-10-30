// スライド版の試作画面（ローカルでボットと遊ぶ．オンライン対戦はまだない）

import './ui.css';
import { ARROW, DELTA, DIRS, Dir, SCARDS, SKind, canBuyAt, canDropAt, needText } from './cards';
import {
  DEFAULT_BOARD, SBOARDS, SCard, SPlayer, SState, Walk, X_MAX, X_MIN, applySlide, bonus, brake, canAdjust, canPeek, cellPower,
  canFlip, choicesFor, favCost, isLastCard, inBoard, isCatch, isDeep, newSlideGame, overshoot, ownedCards, removeLoad, rowEffect, samePos, stopperCells, yMax, yMin,
} from './engine';
import { SBOT_LABELS, SPRESETS, chooseSlideAction } from './bot';
import { randomSeed } from '../engine/rng';
import { colColor, colInk, needBadges, rowColor } from './colors';

const app = document.getElementById('app')!;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 保存できなくても遊べる */ } },
};

let s: SState | null = null;
let botTypes: string[] = [];
let timer = 0;
const sel = { buy: [] as SKind[], remove: new Set<number>(), rotate: new Set<number>() };

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ---- 開始画面 ----

function setup() {
  clearTimeout(timer);
  s = null;
  const saved = (store.get('slide.bots') ?? 'light,slide').split(',');
  const opts = (v: string) => Object.keys(SPRESETS).map(k => `<option value="${k}" ${k === v ? 'selected' : ''}>${SBOT_LABELS[k]}</option>`).join('');
  app.innerHTML = `
  <main class="setup">
    <h1>ミニマリスト <small>スライド版（試作）</small></h1>
    <p>手札はありません．山札の上をめくるたびに，欲に流されてコマが動きます．好きなところで止めて，
      <b>物欲</b>の行ならカードを取得，<b>捨欲</b>の行なら今日めくったカードを排除．デッキを0枚にするか，
      <b>お気に入りだけ3枚以下</b>にしたら達成です．</p>
    <label>盤 <select id="board">${Object.values(SBOARDS).map(b => `<option value="${b.name}" ${b.name === (store.get('slide.board') ?? DEFAULT_BOARD) ? 'selected' : ''}>${b.label}</option>`).join('')}</select></label>
    <label>あなたの名前 <input id="name" value="${esc(store.get('slide.name') ?? 'あなた')}" maxlength="12"></label>
    <div id="bots">${[0, 1, 2].map(i => `<label>ボット${i + 1}
      <select data-i="${i}"><option value="">なし</option>${opts(saved[i] ?? '')}</select></label>`).join('')}</div>
    <button id="start" class="primary">はじめる</button>
    <details><summary>ルールの要約</summary>${rulesHTML()}</details>
  </main>`;
  app.querySelector<HTMLButtonElement>('#start')!.onclick = () => {
    const name = app.querySelector<HTMLInputElement>('#name')!.value.trim() || 'あなた';
    botTypes = [...app.querySelectorAll<HTMLSelectElement>('#bots select')].map(x => x.value).filter(Boolean);
    if (!botTypes.length) botTypes = ['light'];
    store.set('slide.name', name);
    store.set('slide.bots', botTypes.join(','));
    const board = app.querySelector<HTMLSelectElement>('#board')!.value;
    store.set('slide.board', board);
    s = newSlideGame([{ name }, ...botTypes.map(t => ({ name: SBOT_LABELS[t], isBot: true, botType: t }))], randomSeed(), { board });
    render();
  };
}

function rulesHTML() {
  return `<ul>
    <li>毎手番，コマは中央から．少なくとも1枚めくる．山札が尽きたら捨札を混ぜてめくり続けられる</li>
    <li>縦：中央から上が<b>物欲</b>（その行の額まで取得），下が<b>捨欲</b>（その行の量まで排除．一番下は捨札からも1枚）．額・量は盤の左に書いてある</li>
    <li>横：右ほど<b>衝動</b>．止めると最後に動いた向きへ1/2マス余分に進む（衝動3はぶつかるまで）が，取得の額が+1/+2/+3．
      左ほど<b>理性</b>．排除の量が+1/+2/+3．理性2以上は止めた後に1マス動ける，理性3は次の1枚が見える</li>
    <li>高いもの・派手なもの（滑り台・一生モノ・愛用品・氷の廊下・道連れ袋）は<b>衝動の列でないと取得できない</b>．
      思い入れのあるもの（ガラクタ・思い出の品・愛用品・滑り台）は<b>理性の列でないと排除できない</b></li>
    <li>最後の1枚（持ち物が今日めくった1枚だけ）は，どこで止まっても手放せる</li>
    <li>排除できるのは今日めくったカード（重さの合計が量以下）．排除したマスに<b>積み木</b>（片付けた跡）が残る．
      積み木のマスに入ると，そのカードの動きはそこで終わる（1人4個，古いものから動かす）</li>
    <li>お気に入り（一生モノ・回した愛用品）は排除できない．お気に入りだけ3枚以下になっても達成</li>
    <li>誰かが達成したらそのラウンドの最後まで．排除した枚数が多い人の勝ち</li>
  </ul>`;
}

// ---- ゲーム画面 ----

const me = 0;
const cur = () => s!.players[s!.current];

function rowLabel(y: number) {
  const e = rowEffect(y, s!.board);
  return e.kind === 'buy' ? '物欲' : e.kind === 'remove' ? '捨欲' : 'スタート';
}
function colLabel(x: number) { return x < 0 ? `理性${-x}` : x > 0 ? `衝動${x}` : '中'; }

/** 止めたらどこで止まるか（ブレーキ込み） */
function stopPreview(w: Walk): Walk {
  const v: Walk = { board: w.board, pos: { ...w.pos }, lastDir: w.lastDir, blocks: w.blocks, trail: [] };
  brake(v);
  return v;
}

function boardHTML(p: SPlayer, big: boolean, clickCells: { x: number; y: number }[] = [], preview?: { x: number; y: number }) {
  const w = p.walk;
  const active = s!.players[s!.current] === p;
  let h = `<div class="board ${big ? 'big' : 'mini'}"><div class="corner"></div>`;
  for (let x = X_MIN; x <= X_MAX; x++) h += `<div class="colh" style="--hb:${colColor(x) ?? 'transparent'};color:${colInk(x)}">${big ? colLabel(x) : x}${big && x > 0 ? `<small>額+${bonus(x, 'buy')}・${overshoot(x) === Infinity ? '滑る' : overshoot(x) + '余分'}</small>` : ''}${big && x < 0 ? `<small>量+${bonus(x, 'remove')}${canAdjust(x) ? '・調整' : ''}${canPeek(x) ? '・見る' : ''}</small>` : ''}</div>`;
  const b = s!.board;
  for (let y = yMax(b); y >= yMin(b); y--) {
    const e = rowEffect(y, b);
    h += `<div class="rowh ${e.kind}" style="--hb:${rowColor(e.kind, e.amount)}">${big ? rowLabel(y) : e.kind === 'none' ? 'S' : e.amount}${big && e.kind !== 'none' ? `<small>${e.kind === 'buy' ? '額' : '量'}${e.amount}${isDeep(y, b) ? '＋捨札1' : ''}</small>` : ''}</div>`;
    for (let x = X_MIN; x <= X_MAX; x++) {
      const pos = { x, y };
      const cls = [e.kind, x > 0 ? 'imp' : x < 0 ? 'calm' : ''];
      if (active && w.trail.some(t => samePos(t, pos))) cls.push('trail');
      if (clickCells.some(c => samePos(c, pos))) cls.push('pick');
      if (preview && samePos(preview, pos)) cls.push('preview');
      const block = isCatch(w, pos) ? `<span class="block" title="積み木（入るとそこで止まる）"></span>` : '';
      const pawn = active && samePos(w.pos, pos) ? `<span class="pawn"></span>` : '';
      const start = x === 0 && y === 0 ? `<span class="start">S</span>` : '';
      const pw = cellPower(pos, b);
      const amt = big && pw.kind !== 'none' ? `<span class="amt">${pw.kind === 'buy' ? '額' : '量'}${pw.amount}</span>` : '';
      const tint = `--row:${rowColor(e.kind, e.amount)};--col:${colColor(x) ?? rowColor(e.kind, e.amount)}`;
      h += `<div class="cell ${cls.join(' ')}" style="${tint}" data-x="${x}" data-y="${y}">${start}${amt}${block}${pawn}</div>`;
    }
  }
  return h + `</div>`;
}

function moveText(c: SCard) {
  return c.fav ? 'お気に入り．好きな向きに1' : SCARDS[c.kind].text;
}
function cardHTML(c: SCard | { kind: SKind; fav?: boolean; id?: number }, extra = '', cls = '') {
  const d = SCARDS[c.kind];
  const fav = 'fav' in c && c.fav;
  return `<div class="card ${cls} ${fav ? 'favc' : ''} ${d.cost === null ? 'startc' : ''}" ${'id' in c && c.id ? `data-id="${c.id}"` : ''} ${extra}>
    <div class="ct"><b>${fav ? '★' : ''}${d.name}</b>${d.cost !== null ? `<span class="cost">${d.cost}</span>` : ''}</div>
    <div class="cm">${esc(fav ? 'お気に入り．好きな向きに1' : d.text)}</div>
    ${needText(c.kind) && !fav ? `<div class="need">${needBadges(c.kind)}</div>` : ''}
    <div class="cw">重さ${d.weight}</div></div>`;
}

function render() {
  if (!s) return setup();
  const p = cur();
  const mine = s.current === me && s.phase === 'play';
  const human = s.players[me];
  let clickCells: { x: number; y: number }[] = [];
  let preview: { x: number; y: number } | undefined;
  if (mine && s.turn === 'stopper') clickCells = stopperCells(p.walk);
  if (mine && s.turn === 'move' && p.flow.length) preview = stopPreview(p.walk).pos;
  if (mine && s.turn === 'adjust') clickCells = DIRS.map(d => ({ x: p.walk.pos.x + DELTA[d][0], y: p.walk.pos.y + DELTA[d][1] })).filter(q => inBoard(q, s!.board));

  const others = s.players.map((q, i) => ({ q, i })).filter(x => x.i !== me);
  app.innerHTML = `
  <header><b>ミニマリスト スライド版</b> <span>ラウンド ${s.round}</span>
    <span class="turnof">${s.phase === 'over' ? 'ゲーム終了' : `${esc(p.name)}の手番`}</span>
    <button id="quit">やめる</button></header>
  <main class="game">
    <section class="left">
      ${boardHTML(s.current === me || s.phase === 'over' ? human : p, true, clickCells, preview)}
      <div class="who">${s.current === me || s.phase === 'over' ? '' : `${esc(p.name)}の盤（あなたの盤は下の一覧）`}</div>
    </section>
    <section class="right">
      <div class="panel">${controlsHTML()}</div>
      <h3>今日の流れ <small>${esc(p.name)}</small></h3>
      <div class="flow">${p.flow.map(c => cardHTML(c)).join('') || '<span class="muted">まだめくっていません</span>'}</div>
      <h3>プレイヤー</h3>
      <table class="players"><tr><th></th><th>山札</th><th>捨札</th><th>持ち物</th><th>排除</th><th>取得</th><th>★</th></tr>
      ${s.players.map((q, i) => `<tr class="${i === s!.current ? 'now' : ''}"><td>${esc(q.name)}${q.finished ? ' ✓' : ''}${s!.winners.includes(i) ? ' 🏆' : ''}</td>
        <td>${q.deck.length}</td><td>${q.discard.length}</td><td>${ownedCards(q).length}</td><td>${q.removed}</td><td>${q.bought}</td><td>${ownedCards(q).filter(c => c.fav).length}</td></tr>`).join('')}</table>
      <div class="minis">${others.map(({ q }) => `<div><small>${esc(q.name)}</small>${boardHTML(q, false)}</div>`).join('')}
        ${s.current !== me && s.phase !== 'over' ? `<div><small>あなた</small>${boardHTML(human, false)}</div>` : ''}</div>
      <h3>あなたのカード <small>（種類順．山札の順番はわからない）</small></h3>
      <div class="owned">${ownedList(human)}</div>
      <h3>市場</h3>
      <div class="market">${marketHTML(false)}</div>
      <h3>記録</h3>
      <ol class="log">${s.log.slice(-14).reverse().map(l => `<li>${esc(l)}</li>`).join('')}</ol>
    </section>
  </main>`;
  app.querySelector<HTMLButtonElement>('#quit')!.onclick = () => { if (s?.phase === 'over' || confirm('ゲームをやめますか？')) setup(); };
  bindControls(clickCells);
  if (s.phase === 'play' && cur().isBot) {
    clearTimeout(timer);
    timer = window.setTimeout(botStep, s.turn === 'resolve' ? 700 : 380);
  }
}

function ownedList(p: SPlayer) {
  const counts = new Map<string, { c: SCard; n: number }>();
  for (const c of ownedCards(p)) {
    const k = `${c.kind}${c.fav ? '*' : ''}`;
    const e = counts.get(k);
    if (e) e.n++; else counts.set(k, { c, n: 1 });
  }
  return [...counts.values()].sort((a, b) => a.c.kind.localeCompare(b.c.kind))
    .map(({ c, n }) => `<span class="chip ${c.fav ? 'favc' : ''}" title="${esc(moveText(c))}">${c.fav ? '★' : ''}${SCARDS[c.kind].name}×${n}</span>`).join('');
}

function marketHTML(buying: boolean, x = 0) {
  return Object.entries(s!.market).map(([k, n]) => {
    const kind = k as SKind;
    const chosen = sel.buy.filter(x => x === kind).length;
    const left = (n ?? 0) - chosen;
    return `<div class="mk">${cardHTML({ kind }, buying ? `data-buy="${kind}"` : '')}
      <div class="stock">${n! >= 99 ? '∞' : `残り${n}`}${buying ? ` <button data-add="${kind}" ${left <= 0 || !canBuyAt(kind, x) ? 'disabled' : ''}>＋</button><button data-sub="${kind}" ${chosen ? '' : 'disabled'}>−</button> ${chosen ? `<b>×${chosen}</b>` : ''}` : ''}</div></div>`;
  }).join('');
}

function controlsHTML(): string {
  const st = s!;
  if (st.phase === 'over') {
    return `<p class="big">${st.winners.length ? `${st.winners.map(i => esc(st.players[i].name)).join('・')}の${st.winners.length > 1 ? '共同勝利' : '勝利'}！` : '引き分け'}</p>
      <p>${st.players.map(q => `${esc(q.name)}：排除${q.removed}枚・お気に入り${favCost(q)}`).join('<br>')}</p>
      <button id="again" class="primary">もう一度</button>`;
  }
  const p = cur();
  if (st.current !== me) return `<p>${esc(p.name)}が考えています…</p>`;
  const w = p.walk;
  const here = cellPower(w.pos, st.board);
  switch (st.turn) {
    case 'move': {
      const pv = stopPreview(w);
      const pw = cellPower(pv.pos, st.board);
      const peek = canPeek(w.pos.x) && p.deck.length ? `<p>理性3：次の1枚は <b>${SCARDS[p.deck[p.deck.length - 1].kind].name}</b></p>` : '';
      const where = !p.flow.length ? '少なくとも1枚めくってください'
        : `止めると (${pv.pos.x},${pv.pos.y}) ${pw.kind === 'buy' ? `物欲${pw.amount}で取得` : pw.kind === 'remove' ? `捨欲${pw.amount}で排除` : 'で何もしない'}${samePos(pv.pos, w.pos) ? '' : '（勢いで進む）'}`;
      return `${peek}<p>${where}</p>
        <button id="flip" class="primary" ${canFlip(p) ? '' : 'disabled'}>めくる（山札${p.deck.length}${p.deck.length ? '' : '→捨札を混ぜる'}）</button>
        <button id="stop" ${!p.flow.length && canFlip(p) ? 'disabled' : ''}>止める</button>`;
    }
    case 'branch': {
      const card = p.flow[p.flow.length - 1];
      return `<p>${SCARDS[card.kind].name}：どちらへ進みますか</p>${choicesFor(card, w).map(d => `<button data-dir="${d}" class="primary">${ARROW[d]}</button>`).join(' ')}`;
    }
    case 'stopper':
      return `<p>ストッパー：積み木を置くマスを盤で選んでください（光っているマス）</p><button id="noblock">置かない</button>`;
    case 'adjust':
      return `<p>理性の列で止まりました．1マスだけ動けます（光っているマス）．今の場所：${here.kind === 'buy' ? `物欲${here.amount}` : here.kind === 'remove' ? `捨欲${here.amount}` : '効果なし'}</p>
        <button id="noadjust" class="primary">ここでよい</button>`;
    case 'resolve': {
      if (isLastCard(p)) {
        return `<p>最後の1枚です．どこで止まっても手放せます</p>${cardHTML(p.flow[0])}
          <button id="lastdrop" class="primary">手放す</button> <button id="resolve">手放さない</button>`;
      }
      if (here.kind === 'buy') {
        const total = sel.buy.reduce((n, k) => n + (SCARDS[k].cost ?? 0), 0);
        const rot = p.flow.filter(c => SCARDS[c.kind].rotatable && !c.fav);
        return `<p>物欲 <b>${here.amount}</b>：取得するカードを選んでください（使用 ${total}/${here.amount}）</p>
          <div class="market buying">${marketHTML(true, w.pos.x)}</div>
          ${rot.length ? `<p>愛用品を回してお気に入りにする：${rot.map(c => `<label><input type="checkbox" data-rot="${c.id}" ${sel.rotate.has(c.id) ? 'checked' : ''}>愛用品</label>`).join(' ')}</p>` : ''}
          <button id="resolve" class="primary" ${total > here.amount ? 'disabled' : ''}>決定</button>`;
      }
      if (here.kind === 'remove') {
        const flowSel = p.flow.filter(c => sel.remove.has(c.id));
        const load = removeLoad(flowSel);
        const deep = isDeep(w.pos.y, st.board);
        const discSel = p.discard.filter(c => sel.remove.has(c.id));
        return `<p>捨欲 <b>${here.amount}</b>：今日の流れから排除するカードを選んでください（重さ ${load}/${here.amount}）</p>
          <div class="flow pickable">${p.flow.map(c => canDropAt(c.kind, w.pos.x) && !c.fav ? cardHTML(c, `data-rm="${c.id}"`, sel.remove.has(c.id) ? 'on' : '') : cardHTML(c, '', 'no')).join('')}</div>
          ${deep ? `<p>捨欲3：捨札からも1枚（重さ0）</p><div class="flow pickable">${p.discard.filter(c => !c.fav && canDropAt(c.kind, w.pos.x)).map(c => cardHTML(c, `data-rm="${c.id}"`, sel.remove.has(c.id) ? 'on' : '')).join('') || '<span class="muted">捨札はありません</span>'}</div>` : ''}
          <button id="resolve" class="primary" ${load > here.amount || discSel.length > 1 ? 'disabled' : ''}>決定</button>`;
      }
      return `<p>効果のないマスで止まりました</p><button id="resolve" class="primary">手番を終える</button>`;
    }
  }
}

function act(a: Parameters<typeof applySlide>[2]) {
  try {
    applySlide(s!, me, a);
    if (a.type === 'resolve' || s!.turn === 'resolve') { sel.buy = []; sel.remove.clear(); sel.rotate.clear(); }
  } catch (e) { alert((e as Error).message); }
  render();
}

function bindControls(clickCells: { x: number; y: number }[]) {
  const q = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel);
  q('#again')?.addEventListener('click', () => {
    s = newSlideGame(s!.players.map(p => ({ name: p.name, isBot: p.isBot, botType: p.botType })), randomSeed(), { board: s!.board.name });
    render();
  });
  q('#flip')?.addEventListener('click', () => act({ type: 'flip' }));
  q('#stop')?.addEventListener('click', () => act({ type: 'stop' }));
  q('#noblock')?.addEventListener('click', () => act({ type: 'stopper', cell: null }));
  q('#noadjust')?.addEventListener('click', () => act({ type: 'adjust', dir: null }));
  app.querySelectorAll<HTMLButtonElement>('[data-dir]').forEach(b => b.onclick = () => act({ type: 'branch', dir: b.dataset.dir as Dir }));
  app.querySelectorAll<HTMLElement>('.board.big .cell.pick').forEach(el => el.onclick = () => {
    const pos = { x: +el.dataset.x!, y: +el.dataset.y! };
    if (!clickCells.some(c => samePos(c, pos))) return;
    if (s!.turn === 'stopper') act({ type: 'stopper', cell: pos });
    else if (s!.turn === 'adjust') {
      const w = cur().walk;
      const d = DIRS.find(d => w.pos.x + DELTA[d][0] === pos.x && w.pos.y + DELTA[d][1] === pos.y)!;
      act({ type: 'adjust', dir: d });
    }
  });
  app.querySelectorAll<HTMLButtonElement>('[data-add]').forEach(b => b.onclick = () => { sel.buy.push(b.dataset.add as SKind); render(); });
  app.querySelectorAll<HTMLButtonElement>('[data-sub]').forEach(b => b.onclick = () => {
    const i = sel.buy.lastIndexOf(b.dataset.sub as SKind);
    if (i >= 0) sel.buy.splice(i, 1);
    render();
  });
  app.querySelectorAll<HTMLInputElement>('[data-rot]').forEach(b => b.onchange = () => {
    const id = +b.dataset.rot!;
    if (b.checked) sel.rotate.add(id); else sel.rotate.delete(id);
  });
  app.querySelectorAll<HTMLElement>('[data-rm]').forEach(el => el.onclick = () => {
    const id = +el.dataset.rm!;
    if (sel.remove.has(id)) sel.remove.delete(id); else sel.remove.add(id);
    render();
  });
  q('#lastdrop')?.addEventListener('click', () => act({ type: 'resolve', buy: [], remove: [cur().flow[0].id], rotate: [] }));
  q('#resolve')?.addEventListener('click', () => act({ type: 'resolve', buy: [...sel.buy], remove: [...sel.remove], rotate: [...sel.rotate] }));
}

function botStep() {
  if (!s || s.phase !== 'play' || !cur().isBot) return;
  const p = cur();
  const g = SPRESETS[p.botType ?? 'light'] ?? SPRESETS.light;
  applySlide(s, s.current, chooseSlideAction(s, g));
  render();
}

setup();
