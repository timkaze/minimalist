import './style.css';
import {
  CARDS, CardKind, MARKET_CANDIDATES, MARKET_KINDS, MARKET_PICK, PROTOTYPE_KINDS, RULE, STARTING_DECK, UNLIMITED, marketFromPick, removeCost,
} from '../engine/cards';
import { Card, CardPlace, GameView, OwnedCard, PlayerSetup, computeReach, openCells, posKey } from '../engine/game';
import {
  CUSTOM_LIMITS, DEFAULT_FLOOR, FLOORS, FloorSpec, RECOMMENDED_FLOORS, cellState, colValue, floorFromSpec, floorToSpec, rowValue,
} from '../engine/floors';
import { BOT_LABELS } from '../bot/bot';
import { MAX_SEATS } from '../net/protocol';
import { cardHelp, cardSVG } from './cardsvg';
import { Controller, LocalController, OnlineController } from './controllers';

const app = document.getElementById('app')!;
const BOT_TYPES = ['random', 'balanced', 'engine', 'passage', 'hub', 'bag', 'light', 'learned'];

// ---- ローカル保存（名前とトークン）．使えない環境でも動くようにする ----
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても続行 */ } },
};
function token(): string {
  let t = store.get('minimalist.token');
  if (!t) { t = crypto.randomUUID(); store.set('minimalist.token', t); }
  return t;
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// ---- 画面の状態 ----
let ctrl: Controller | null = null;
let toast = '';
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const ui = {
  turnKey: '',
  selected: null as number | null, // 選んだ手札のID
  mode: 'place' as 'place' | 'finish',
  remove: new Set<number>(),
  cart: [] as CardKind[],
  /** 持っているカードの一覧を開いているか（手番をまたいで保つ） */
  showCards: false,
};

function resetTurnUI() {
  ui.selected = null; ui.mode = 'place'; ui.remove.clear(); ui.cart = [];
}

function showToast(msg: string) {
  toast = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast = ''; render(); }, 3500);
  render();
}

function startController(c: Controller) {
  ctrl?.close();
  ctrl = c;
  resetTurnUI();
  c.onChange(render);
  c.onError(showToast);
  render();
}

// ---- ホーム ----
function renderHome() {
  const name = store.get('minimalist.name') ?? '';
  const roomParam = new URLSearchParams(location.search).get('room') ?? '';
  const botRows = [1, 2, 3, 4, 5].map(i => `
    <label class="bot-row" data-bot-row="${i}">ボット${i}
      <select data-bot-type="${i}">${BOT_TYPES.map(t => `<option value="${t}">${BOT_LABELS[t]}</option>`).join('')}</select>
    </label>`).join('');
  app.innerHTML = `
  <main class="home">
    <h1>ミニマリスト</h1>
    <p class="sub">デッキを作って，最後にデッキを消すゲーム</p>
    <label class="field">あなたの名前 <input id="name" maxlength="16" value="${esc(name)}" placeholder="プレイヤー"></label>
    <section class="panel">
      <h2>ボットと遊ぶ（この端末だけ）</h2>
      <label class="field">ボットの人数
        <select id="botCount">${[1, 2, 3, 4, 5].map(n => `<option ${n === 1 ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </label>
      <div id="botRows">${botRows}</div>
      <label class="field">間取り ${floorSelect('floorLocal')}</label>
      ${marketPicker('marketLocal')}
      <button class="primary" id="playLocal">はじめる</button>
    </section>
    <section class="panel">
      <h2>友だちと遊ぶ（オンライン）</h2>
      <button class="primary" id="createRoom">部屋を作る</button>
      <div class="join">
        <input id="roomCode" maxlength="8" placeholder="部屋コード" value="${esc(roomParam)}">
        <button id="joinRoom">入る</button>
      </div>
      <p class="hint">部屋を作ったら，表示されるリンクを友だちに送ってください．空いた席はボットで埋められます．</p>
    </section>
    <details class="panel rules"><summary>ルール（要約）</summary>${rulesHTML()}</details>
  </main>`;
  const botCount = app.querySelector<HTMLSelectElement>('#botCount')!;
  const syncRows = () => app.querySelectorAll<HTMLElement>('[data-bot-row]').forEach(el => {
    el.hidden = Number(el.dataset.botRow) > Number(botCount.value);
  });
  botCount.onchange = syncRows;
  syncRows();
  const pickLocal = wireMarketPicker('marketLocal', '#playLocal');
  const customLocal = wireFloorPicker('floorLocal', '#playLocal');
  const getName = () => {
    const v = app.querySelector<HTMLInputElement>('#name')!.value.trim() || 'プレイヤー';
    store.set('minimalist.name', v);
    return v;
  };
  app.querySelector<HTMLButtonElement>('#playLocal')!.onclick = () => {
    store.set('minimalist.floor', app.querySelector<HTMLSelectElement>('#floorLocal')!.value);
    const n = Number(botCount.value);
    const setup: PlayerSetup[] = [{ name: getName() }];
    for (let i = 1; i <= n; i++) {
      const t = app.querySelector<HTMLSelectElement>(`[data-bot-type="${i}"]`)!.value;
      setup.push({ name: `ボット${i}（${BOT_LABELS[t]}）`, isBot: true, botType: t });
    }
    const floor = app.querySelector<HTMLSelectElement>('#floorLocal')!.value;
    startController(new LocalController(setup, floor === CUSTOM ? undefined : floor, marketFromPick(pickLocal()), customLocal()));
  };
  const goOnline = (code: string) => {
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) return showToast('部屋コードは4文字以上です');
    history.replaceState(null, '', `?room=${code}`);
    startController(new OnlineController(code, getName(), token()));
  };
  app.querySelector<HTMLButtonElement>('#createRoom')!.onclick = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    goOnline(Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''));
  };
  app.querySelector<HTMLButtonElement>('#joinRoom')!.onclick = () =>
    goOnline(app.querySelector<HTMLInputElement>('#roomCode')!.value);
}

/** 開始ボタン：人数不足（blocked）・市場の種類数・カスタム間取りのどれかに問題があれば押せない */
function syncStartButton(btn: HTMLButtonElement) {
  btn.disabled = btn.dataset.blocked === '1' || btn.dataset.marketBad === '1' || btn.dataset.customBad === '1';
}

function floorSelect(id: string): string {
  const saved = store.get('minimalist.floor');
  return `<select id="${id}">${RECOMMENDED_FLOORS.map(name => FLOORS[name]).map(f =>
    `<option value="${f.name}" ${f.name === saved ? 'selected' : ''}>${f.label}</option>`).join('')}
    <option value="${CUSTOM}" ${saved === CUSTOM ? 'selected' : ''}>カスタム（自分で作る）</option></select>
    <div class="custom-map" id="${id}Custom" hidden></div>`;
}

// ---- カスタムの間取り（テストプレイ用：大きさ・柱・段ボール・ゴミ捨て場・目盛りを自由に決める） ----

const CUSTOM = 'custom';
type Tool = 'open' | 'wall' | 'lock' | 'goal';
const editor = { spec: loadCustom(), tool: 'wall' as Tool, lock: 4 };

function loadCustom(): FloorSpec {
  try {
    const v = JSON.parse(store.get('minimalist.custom') ?? 'null') as FloorSpec;
    if (v) { floorFromSpec(v); return v; }
  } catch { /* 保存がない・壊れている */ }
  return floorToSpec(FLOORS[DEFAULT_FLOOR]);
}

const specGrid = (sp: FloorSpec) => sp.rows.map(r => r.trim().split(/\s+/));
const scaleOf = (v: number[] | undefined, n: number) => Array.from({ length: n }, (_, i) => v?.[i] ?? Math.min(i, CUSTOM_LIMITS.maxValue));

function customEditorHTML(): string {
  const sp = editor.spec;
  const grid = specGrid(sp);
  const rows = grid.length, cols = grid[0].length;
  const rv = scaleOf(sp.rowValues, rows), cv = scaleOf(sp.colValues, cols);
  let err = '';
  try { floorFromSpec(sp); } catch (e) { err = (e as Error).message; }
  const { minSize, maxSize, maxValue, maxLock } = CUSTOM_LIMITS;
  const tool = (t: Tool, label: string) =>
    `<label class="tool"><input type="radio" name="ctool" value="${t}" ${editor.tool === t ? 'checked' : ''}>${label}</label>`;
  let cells = `<span class="ce-corner">物欲→<br>捨欲↓</span>`;
  cells += cv.map((x, c) => `<input class="ce-scale" type="number" min="0" max="${maxValue}" value="${x}" data-col-value="${c}" title="${c}列目まで届いたときの物欲">`).join('');
  grid.forEach((row, r) => {
    cells += `<input class="ce-scale" type="number" min="0" max="${maxValue}" value="${rv[r]}" data-row-value="${r}" title="${r}行目まで届いたときの捨欲">`;
    row.forEach((tok, c) => {
      const cls = tok === 'S' ? 'start' : tok === '#' ? 'wall' : tok.startsWith('G') ? 'goal' : tok === '.' ? 'open' : 'locked';
      const label = tok === 'S' ? 'START' : tok === '#' ? '' : tok.startsWith('G') ? 'ゴミ捨て場' : tok === '.' ? '' : `📦${tok}`;
      cells += `<button type="button" class="ce-cell ${cls}" ${tok === 'S' ? 'disabled' : `data-ce="${r},${c}"`}>${label}</button>`;
    });
  });
  return `
    <p class="hint">マスを押すと，下で選んだものに変わります．目盛りは，そこまで届いたときの物欲（上）・捨欲（左）の値です．</p>
    <div class="join">
      <label>行 <input type="number" id="ceRows" min="${minSize}" max="${maxSize}" value="${rows}"></label>
      <label>列 <input type="number" id="ceCols" min="${minSize}" max="${maxSize}" value="${cols}"></label>
    </div>
    <div class="join tools">
      ${tool('open', '置ける')}${tool('wall', '柱')}
      ${tool('lock', '段ボール')}<input type="number" id="ceLock" min="1" max="${maxLock}" value="${editor.lock}" title="この枚数を排除すると置けるようになる">枚
      ${tool('goal', 'ゴミ捨て場')}
    </div>
    <div class="ce-grid" style="--cols:${cols}">${cells}</div>
    <div class="join">
      <select id="ceBase">${RECOMMENDED_FLOORS.map(n => `<option value="${n}">${FLOORS[n].label}</option>`).join('')}</select>
      <button type="button" id="ceLoad">をもとにする</button>
      <button type="button" id="ceResetScale">目盛りを番号に戻す</button>
    </div>
    ${err ? `<p class="ce-error">${esc(err)}</p>` : ''}`;
}

/** 間取りの選択欄とカスタム編集欄を動かし，カスタムが選ばれていればその中身を返す関数を返す */
function wireFloorPicker(id: string, startSel: string): () => FloorSpec | undefined {
  const sel = app.querySelector<HTMLSelectElement>(`#${id}`)!;
  const box = app.querySelector<HTMLElement>(`#${id}Custom`)!;
  const draw = () => {
    const on = sel.value === CUSTOM;
    box.hidden = !on;
    let bad = false;
    if (on) {
      box.innerHTML = customEditorHTML();
      try { floorFromSpec(editor.spec); } catch { bad = true; }
      bindEditor();
    }
    const btn = app.querySelector<HTMLButtonElement>(startSel);
    if (btn) { btn.dataset.customBad = bad ? '1' : ''; syncStartButton(btn); }
  };
  const update = (sp: FloorSpec) => {
    editor.spec = sp;
    store.set('minimalist.custom', JSON.stringify(sp));
    draw();
  };
  const bindEditor = () => {
    const grid = specGrid(editor.spec);
    const rows = grid.length, cols = grid[0].length;
    const write = (g: string[][], rv = editor.spec.rowValues, cv = editor.spec.colValues) =>
      update({ rows: g.map(r => r.join(' ')), rowValues: scaleOf(rv, g.length), colValues: scaleOf(cv, g[0].length) });
    box.querySelectorAll<HTMLInputElement>('input[name=ctool]').forEach(el => {
      el.onchange = () => { editor.tool = el.value as Tool; };
    });
    box.querySelector<HTMLInputElement>('#ceLock')!.onchange = e => {
      const n = Math.round(Number((e.target as HTMLInputElement).value));
      editor.lock = Math.max(1, Math.min(CUSTOM_LIMITS.maxLock, n || 1));
      editor.tool = 'lock';
      draw();
    };
    box.querySelectorAll<HTMLElement>('[data-ce]').forEach(el => {
      el.onclick = () => {
        const [r, c] = el.dataset.ce!.split(',').map(Number);
        const g = grid.map(row => [...row]);
        if (editor.tool === 'goal') {
          // ゴミ捨て場は1つだけ：前の場所は置けるマスに戻す．同じマスなら取り消す
          const was = g[r][c].startsWith('G');
          g.forEach(row => row.forEach((t, j) => { if (t.startsWith('G')) row[j] = '.'; }));
          if (!was) g[r][c] = 'G';
        } else {
          g[r][c] = editor.tool === 'open' ? '.' : editor.tool === 'wall' ? '#' : String(editor.lock);
        }
        write(g);
      };
    });
    const resize = (nr: number, nc: number) => {
      const { minSize, maxSize } = CUSTOM_LIMITS;
      nr = Math.max(minSize, Math.min(maxSize, Math.round(nr) || rows));
      nc = Math.max(minSize, Math.min(maxSize, Math.round(nc) || cols));
      const g = Array.from({ length: nr }, (_, r) => Array.from({ length: nc }, (_, c) => grid[r]?.[c] ?? '.'));
      g[0][0] = 'S';
      write(g);
    };
    box.querySelector<HTMLInputElement>('#ceRows')!.onchange = e => resize(Number((e.target as HTMLInputElement).value), cols);
    box.querySelector<HTMLInputElement>('#ceCols')!.onchange = e => resize(rows, Number((e.target as HTMLInputElement).value));
    const clampValue = (x: string) => Math.max(0, Math.min(CUSTOM_LIMITS.maxValue, Math.round(Number(x)) || 0));
    box.querySelectorAll<HTMLInputElement>('[data-row-value]').forEach(el => {
      el.onchange = () => {
        const rv = scaleOf(editor.spec.rowValues, rows);
        rv[Number(el.dataset.rowValue)] = clampValue(el.value);
        write(grid, rv);
      };
    });
    box.querySelectorAll<HTMLInputElement>('[data-col-value]').forEach(el => {
      el.onchange = () => {
        const cv = scaleOf(editor.spec.colValues, cols);
        cv[Number(el.dataset.colValue)] = clampValue(el.value);
        write(grid, undefined, cv);
      };
    });
    box.querySelector<HTMLButtonElement>('#ceLoad')!.onclick = () =>
      update(floorToSpec(FLOORS[box.querySelector<HTMLSelectElement>('#ceBase')!.value]));
    box.querySelector<HTMLButtonElement>('#ceResetScale')!.onclick = () =>
      update({ rows: editor.spec.rows, rowValues: scaleOf(undefined, rows), colValues: scaleOf(undefined, cols) });
  };
  sel.addEventListener('change', () => { store.set('minimalist.floor', sel.value); draw(); });
  draw();
  return () => (sel.value === CUSTOM ? editor.spec : undefined);
}

// ---- 市場のカードを選ぶ（テストプレイ用．候補から MARKET_PICK 種類） ----

function savedPick(): CardKind[] {
  try {
    // 選びかけ（種類数が合わない）でも，ロビーの再描画で消えないように覚えておく
    const v = JSON.parse(store.get('minimalist.market') ?? 'null');
    if (Array.isArray(v) && v.every(k => MARKET_CANDIDATES.includes(k))) return v;
  } catch { /* 保存がない・古い */ }
  return MARKET_KINDS.filter(k => MARKET_CANDIDATES.includes(k));
}

function marketPicker(id: string): string {
  const picked = new Set(savedPick());
  return `
  <details class="field market-pick" id="${id}">
    <summary>市場のカード（${MARKET_PICK}種類）：<span data-pick-summary></span></summary>
    <p class="hint">基本カード（→・↓）はいつも並びます．＊は試作カード（ボットは学習していないので，ほとんど買いません）．</p>
    <div class="pick-list">${MARKET_CANDIDATES.map(k => `
      <label class="pick" title="${esc(cardHelp(k))}">
        <input type="checkbox" value="${k}" ${picked.has(k) ? 'checked' : ''}>
        <span class="pick-card">${cardSVG(k)}</span>
        <span>${PROTOTYPE_KINDS.includes(k) ? '＊' : ''}${esc(cardHelp(k))}</span>
      </label>`).join('')}
    </div>
    <div class="join">
      <button type="button" data-pick="standard">標準に戻す</button>
      <button type="button" data-pick="random">ランダム</button>
    </div>
  </details>`;
}

/** 選択欄を動かし，選んだ候補を返す関数を返す．ちょうど MARKET_PICK 種類でなければ開始ボタンを押せない */
function wireMarketPicker(id: string, startSel: string): () => CardKind[] {
  const root = app.querySelector<HTMLElement>(`#${id}`)!;
  const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const pick = () => boxes.filter(b => b.checked).map(b => b.value as CardKind);
  const sync = () => {
    const p = pick();
    const n = p.length;
    root.querySelector('[data-pick-summary]')!.textContent = n === MARKET_PICK ? p.map(k => CARDS[k].name).join('・')
      : n < MARKET_PICK ? `あと${MARKET_PICK - n}種類選んでください` : `${n - MARKET_PICK}種類多すぎます`;
    const btn = app.querySelector<HTMLButtonElement>(startSel);
    if (btn) { btn.dataset.marketBad = n !== MARKET_PICK ? '1' : ''; syncStartButton(btn); }
    store.set('minimalist.market', JSON.stringify(p));
  };
  boxes.forEach(b => { b.onchange = sync; });
  root.querySelector<HTMLButtonElement>('[data-pick="standard"]')!.onclick = () => {
    boxes.forEach(b => { b.checked = MARKET_KINDS.includes(b.value as CardKind); });
    sync();
  };
  root.querySelector<HTMLButtonElement>('[data-pick="random"]')!.onclick = () => {
    const order = boxes.map(b => ({ b, r: Math.random() })).sort((x, y) => x.r - y.r);
    order.forEach(({ b }, i) => { b.checked = i < MARKET_PICK; });
    sync();
  };
  sync();
  return pick;
}

function rulesHTML(): string {
  return `
  <ol>
    <li>山札から3枚引く</li>
    <li>スタートマスの→から，矢印の先のマスに手札を置いていく．＋のカードは置いたときに＋の数だけ引く</li>
    <li>届いた一番右の列の目盛り＝<b>物欲</b>（買いたい気持ち），一番下の行の目盛り＋✕の数＝<b>捨欲</b>（捨てたい気持ち）．ゴミ捨て場に置いたら捨欲は無制限</li>
    <li>場に置いたカードから，捨欲の範囲で<b>排除</b>する（粗大ごみは捨欲2）</li>
    <li>コストの合計が物欲以下になるよう，市場から<b>購入</b>（捨札へ）</li>
    <li>残りは捨札へ</li>
  </ol>
  <p>📦の数字のマスは，排除した枚数の合計がその数になると置けるようになる（片付けると部屋が広がる）．斜線のマスは柱で置けない．</p>
  <p>初期デッキ：${STARTING_DECK.map(d => `${CARDS[d.kind].name}×${d.count}`).join('，')}（✕のゴミ袋はこの1枚だけ．市場には無い）</p>
  <p>手番の終わりに自分のカードが0枚になれば達成．そのラウンドの最後まで続け，達成者が複数なら排除した枚数が多い人の勝ち（同じなら共同勝利）．</p>
  <ul class="cardlist">${MARKET_KINDS.map(k => `<li>${cardHelp(k)}</li>`).join('')}</ul>`;
}

// ---- ロビー（オンライン，開始前） ----
function renderLobby(c: Controller) {
  const room = c.room;
  if (!room) {
    app.innerHTML = `<main class="home"><p>接続しています…</p><button id="home">ホームへ</button></main>`;
    app.querySelector<HTMLButtonElement>('#home')!.onclick = goHome;
    return;
  }
  const link = `${location.origin}${location.pathname}?room=${room.code}`;
  app.innerHTML = `
  <main class="home">
    <h1>部屋 ${room.code}</h1>
    <section class="panel">
      <p>このリンクを送ってください：</p>
      <div class="join"><input readonly value="${esc(link)}" id="link"><button id="copy">コピー</button></div>
    </section>
    <section class="panel">
      <h2>参加者（${room.seats.length}/${MAX_SEATS}）</h2>
      <ul class="seats">${room.seats.map((s, i) => `
        <li>${esc(s.name)}${i === room.you ? '（あなた）' : ''}${s.isBot ? '' : s.connected ? '' : ' <span class="muted">（切断中）</span>'}
          ${room.isHost && i !== room.you ? `<button class="small" data-remove="${i}">外す</button>` : ''}</li>`).join('')}
      </ul>
      ${room.isHost ? `
        <div class="join">
          <select id="botType">${BOT_TYPES.map(t => `<option value="${t}">${BOT_LABELS[t]}</option>`).join('')}</select>
          <button id="addBot" ${room.seats.length >= MAX_SEATS ? 'disabled' : ''}>ボットを追加</button>
        </div>
        <label class="field">間取り ${floorSelect('floorOnline')}</label>
        ${marketPicker('marketOnline')}
        <button class="primary" id="start" ${room.seats.length < 2 ? 'disabled data-blocked="1"' : ''}>ゲーム開始</button>`
      : `<p class="hint">ホストが開始するのを待っています…</p>`}
      ${room.you < 0 ? '<p class="hint">満席のため観戦になります</p>' : ''}
    </section>
    <button id="home">ホームへ</button>
  </main>`;
  app.querySelector<HTMLButtonElement>('#copy')!.onclick = () => {
    navigator.clipboard?.writeText(link).then(() => showToast('コピーしました'), () => showToast('コピーできませんでした'));
  };
  app.querySelector<HTMLButtonElement>('#home')!.onclick = goHome;
  if (room.isHost) {
    app.querySelector<HTMLButtonElement>('#addBot')!.onclick = () =>
      c.send!({ t: 'addBot', botType: app.querySelector<HTMLSelectElement>('#botType')!.value });
    const pickOnline = wireMarketPicker('marketOnline', '#start');
    const customOnline = wireFloorPicker('floorOnline', '#start');
    app.querySelector<HTMLButtonElement>('#start')!.onclick = () => {
      const floor = app.querySelector<HTMLSelectElement>('#floorOnline')!.value;
      store.set('minimalist.floor', floor);
      c.send!({ t: 'start', floor: floor === CUSTOM ? undefined : floor, market: pickOnline(), custom: customOnline() });
    };
    app.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(b => {
      b.onclick = () => c.send!({ t: 'removeSeat', seat: Number(b.dataset.remove) });
    });
  }
}

function goHome() {
  ctrl?.close();
  ctrl = null;
  history.replaceState(null, '', location.pathname);
  render();
}

// ---- ゲーム画面 ----
function boardHTML(v: GameView, board: Record<string, Card>, removed: number, opts: { mine: boolean; small?: boolean }): string {
  const myTurn = opts.mine && v.current === v.you && v.phase === 'play';
  const opens = myTurn && ui.mode === 'place' && ui.selected !== null
    ? new Set(openCells(board, v.floor, removed).map(posKey)) : new Set<string>();
  let cells = '';
  for (let r = 0; r < v.rows; r++) {
    for (let c = 0; c < v.cols; c++) {
      const key = `${r},${c}`;
      const card = board[key];
      const cls = ['cell'];
      if (r === 0 && c === 0) cls.push('start');
      const isGoal = key === v.floor.goal;
      const st = cellState(v.floor, key, removed);
      if (isGoal) cls.push('corner');
      if (!card && st !== 'open') cls.push(st);
      let inner = '';
      let attrs = '';
      if (r === 0 && c === 0) inner = `<span class="start-label">START →</span>`;
      else if (card) {
        inner = cardSVG(card.kind, { showName: !opts.small });
        // 紙袋など自分で消えるカードは，手番の終わりに必ず排除される（選ばなくてよい）
        if ((ui.remove.has(card.id) || CARDS[card.kind].selfRemove) && opts.mine) cls.push('marked');
        if (myTurn && ui.mode === 'finish' && !CARDS[card.kind].selfRemove) { cls.push('clickable'); attrs = `data-toggle="${card.id}"`; }
        attrs += ` title="${esc(cardHelp(card.kind))}"`;
      } else if (opens.has(key)) {
        cls.push('open'); attrs = `data-cell="${key}"`;
      } else if (st === 'wall') {
        inner = '';
      } else if (st === 'locked') {
        const need = v.floor.locks[key];
        inner = opts.small ? `<span class="lock-label">${need}</span>`
          : `<span class="lock-label">📦${need}<br><small>あと${need - removed}枚</small></span>`;
        attrs = `title="排除した枚数が${need}枚になると置けるようになる"`;
      } else if (isGoal && !opts.small) {
        inner = `<span class="corner-label">ゴミ捨て場<br>捨欲 無制限</span>`;
      }
      cells += `<div class="${cls.join(' ')}" ${attrs}>${inner}</div>`;
    }
  }
  // 目盛り：上が物欲（列），左が捨欲（行）
  const scaleTop = opts.small ? '' : `<div class="scale-top" title="物欲の目盛り（届いた一番右の列）">${Array.from({ length: v.cols }, (_, i) => `<span>${colValue(v.floor, i)}</span>`).join('')}</div>`;
  const scaleLeft = opts.small ? '' : `<div class="scale-left" title="捨欲の目盛り（届いた一番下の行）">${Array.from({ length: v.rows }, (_, i) => `<span>${rowValue(v.floor, i)}</span>`).join('')}</div>`;
  const scaleCorner = opts.small ? '' : '<div class="scale-corner">物欲→<br>捨欲↓</div>';
  return `<div class="board-wrap ${opts.small ? 'small' : ''}" style="--rows:${v.rows};--cols:${v.cols}">${scaleCorner}${scaleTop}${scaleLeft}
    <div class="board">${cells}</div></div>`;
}

const PLACE_LABEL: Record<CardPlace, string> = { hand: '手札', board: '場', deck: '山札', discard: '捨札' };

/** 持っているカードをカードナンバー順に並べる（山札の順番はわからない） */
function ownedCardsHTML(cards: OwnedCard[]): string {
  return `<details class="owned" id="owned" ${ui.showCards ? 'open' : ''}>
    <summary>持っているカード（${cards.length}枚）</summary>
    <div class="owned-list">${cards.map(c => `
      <div class="ocard where-${c.where}" title="${esc(cardHelp(c.kind))}">
        <span class="ono">No.${c.no}</span>${cardSVG(c.kind, { showName: true })}<span class="owhere">${PLACE_LABEL[c.where]}</span>
      </div>`).join('')}</div>
  </details>`;
}

function renderGame(c: Controller, v: GameView) {
  const turnKey = `${v.round}-${v.current}-${v.phase}`;
  if (turnKey !== ui.turnKey) { ui.turnKey = turnKey; resetTurnUI(); }
  const me = v.you >= 0 ? v.players[v.you] : null;
  const myTurn = !!me && v.current === v.you && v.phase === 'play';
  const reach = me ? computeReach(me.board, v.floor) : { buy: 0, remove: 0, corner: false };
  const cartCost = ui.cart.reduce((s, k) => s + CARDS[k].cost, 0);
  // フリマ（試作）：排除に選んだカードの分だけ物欲が増える
  const sold = me ? Object.values(me.board).filter(c => ui.remove.has(c.id)).reduce((n, c) => n + CARDS[c.kind].sell, 0) : 0;
  const buyPower = reach.buy + sold;
  const cur = v.players[v.current];

  const market = v.marketKinds.map(k => {
    const left = v.market[k] - ui.cart.filter(x => x === k).length;
    const canBuy = myTurn && ui.mode === 'finish' && left > 0 && cartCost + CARDS[k].cost <= buyPower;
    return `<button class="mcard ${canBuy ? 'clickable' : ''}" ${canBuy ? `data-buy="${k}"` : 'disabled'} title="${esc(cardHelp(k))}">
      ${cardSVG(k)}<span class="stock">${v.market[k] >= UNLIMITED ? '売り切れなし' : `残り${v.market[k]}`}</span></button>`;
  }).join('');

  const hand = me?.hand ?? [];
  const handHTML = hand.map(card => {
    const cls = ['hcard'];
    let attrs = `title="${esc(cardHelp(card.kind))}"`;
    if (myTurn && ui.mode === 'place') { cls.push('clickable'); attrs += ` data-select="${card.id}"`; }
    if (myTurn && ui.mode === 'finish' && RULE.handRemove) { cls.push('clickable'); attrs += ` data-toggle="${card.id}"`; }
    if (ui.selected === card.id) cls.push('selected');
    if (ui.remove.has(card.id)) cls.push('marked');
    return `<button class="${cls.join(' ')}" ${attrs}>${cardSVG(card.kind)}</button>`;
  }).join('') || '<span class="muted">（手札なし）</span>';

  let controls = '';
  if (myTurn && ui.mode === 'place') {
    controls = `<p class="instr">${ui.selected === null ? '手札を選んで，光っているマスに置きます' : '置くマスを選んでください'}</p>
      <button id="undo" ${v.undoCount > 0 ? '' : 'disabled'} title="引くカードを置いた後は，それより前に戻せません">↶ 戻す${v.undoCount > 0 ? `（${v.undoCount}）` : ''}</button>
      <button class="primary" id="toFinish">配置を終える</button>`;
  } else if (myTurn && ui.mode === 'finish') {
    controls = `<p class="instr">排除するカード（場${RULE.handRemove ? '・手札' : ''}）と，買うカード（市場）を選んで手番を終えます．手札に残ったカードは捨札へ</p>
      <div class="cart">購入：${ui.cart.length ? ui.cart.map((k, i) => `<button class="chip" data-uncart="${i}">${CARDS[k].name} ✕</button>`).join('') : 'なし'}</div>

      <button id="toPlace">配置に戻る</button> <button class="primary" id="endTurn">手番を終える</button>`;
  } else if (v.phase === 'play') {
    controls = `<p class="instr">${esc(cur.name)}の手番です…</p>`;
  }

  const stats = me ? `
    <div class="stats">
      <span>物欲 <b>${buyPower}</b>${myTurn && ui.mode === 'finish' ? `（使用 ${cartCost}）` : ''}</span>
      <span>捨欲 <b>${reach.corner ? '無制限' : reach.remove}</b>${myTurn && ui.mode === 'finish' ? `（選択 ${ui.remove.size}枚）` : ''}</span>
      <span>残り所持 <b>${me.owned}</b></span>
      <span>山札 ${me.deckCount} / 捨札 ${me.discardCount}</span>
      <span>排除済み ${me.removed}</span>
    </div>
    <div class="comp">内訳：${Object.entries(me.composition ?? {}).map(([k, n]) => `${CARDS[k as CardKind].name}×${n}`).join('　') || 'なし'}</div>
    ${ownedCardsHTML(me.cards ?? [])}` : '';

  const others = v.players.map((p, i) => i === v.you ? '' : `
    <div class="opp ${i === v.current && v.phase === 'play' ? 'active' : ''}">
      <div class="opp-head">${p.finished ? '★ ' : ''}${esc(p.name)}</div>
      <div class="opp-stats">残り${p.owned}枚・排除${p.removed}・購入${p.bought}・手札${p.handCount}</div>
      ${boardHTML(v, p.board, p.removed, { mine: false, small: true })}
    </div>`).join('');

  const over = v.phase === 'over' ? `
    <div class="overlay"><div class="dialog">
      <h2>${v.winners.length === 0 ? '引き分け' : v.winners.map(i => esc(v.players[i].name)).join('・') + (v.winners.length > 1 ? 'の共同勝利' : 'の勝利')}</h2>
      <ul>${v.players.map(p => `<li>${p.finished ? '★' : ''}${esc(p.name)}：残り${p.owned}枚，排除${p.removed}枚，購入${p.bought}枚</li>`).join('')}</ul>
      ${c.room && !c.room.isHost ? '<p class="hint">ホストが再戦を選べます</p>' : '<button class="primary" id="again">もう一度</button>'}
      <button id="home2">ホームへ</button>
    </div></div>` : '';

  app.innerHTML = `
  <main class="game">
    <header>
      <span>ラウンド ${v.round}</span>
      <span>手番：<b>${esc(cur.name)}</b></span>
      ${c.room ? `<span>部屋 ${c.room.code}</span>` : ''}
      <button class="small" id="home">ホームへ</button>
    </header>
    <section class="market">${market}</section>
    <section class="me">
      <div>${me ? boardHTML(v, me.board, me.removed, { mine: true }) : '<p>観戦中</p>'}</div>
      <div class="side">
        ${stats}
        <div class="hand">${handHTML}</div>
        ${controls}
      </div>
    </section>
    <section class="others">${others}</section>
    <section class="log"><h3>ログ</h3><ol reversed>${[...v.log].reverse().slice(0, 14).map(l => `<li>${esc(l)}</li>`).join('')}</ol></section>
    ${over}
  </main>`;

  // ---- イベント ----
  app.querySelector<HTMLButtonElement>('#home')!.onclick = goHome;
  app.querySelector<HTMLButtonElement>('#home2')?.addEventListener('click', goHome);
  app.querySelector<HTMLButtonElement>('#again')?.addEventListener('click', () => c.restart());
  app.querySelectorAll<HTMLElement>('[data-select]').forEach(el => {
    el.onclick = () => { const id = Number(el.dataset.select); ui.selected = ui.selected === id ? null : id; render(); };
  });
  app.querySelectorAll<HTMLElement>('[data-cell]').forEach(el => {
    el.onclick = () => {
      if (ui.selected === null) return;
      const [r, col] = el.dataset.cell!.split(',').map(Number);
      const id = ui.selected;
      ui.selected = null;
      c.act({ type: 'place', cardId: id, pos: [r, col] });
    };
  });
  app.querySelectorAll<HTMLElement>('[data-toggle]').forEach(el => {
    el.onclick = () => {
      const id = Number(el.dataset.toggle);
      const all = [...Object.values(me!.board), ...(me!.hand ?? [])];
      const costOf = (cid: number) => (reach.corner ? 0 : removeCost(all.find(x => x.id === cid)!.kind));
      const used = [...ui.remove].reduce((n, cid) => n + costOf(cid), 0);
      if (ui.remove.has(id)) ui.remove.delete(id);
      else if (used + costOf(id) <= reach.remove) ui.remove.add(id);
      else return showToast(`捨欲が足りません（あと${reach.remove - used}．粗大ごみは2つ分）`);
      render();
    };
  });
  app.querySelectorAll<HTMLElement>('[data-buy]').forEach(el => {
    el.onclick = () => { ui.cart.push(el.dataset.buy as CardKind); render(); };
  });
  app.querySelectorAll<HTMLElement>('[data-uncart]').forEach(el => {
    el.onclick = () => { ui.cart.splice(Number(el.dataset.uncart), 1); render(); };
  });
  app.querySelector<HTMLDetailsElement>('#owned')?.addEventListener('toggle', e => {
    ui.showCards = (e.target as HTMLDetailsElement).open;
  });
  app.querySelector<HTMLButtonElement>('#undo')?.addEventListener('click', () => { ui.selected = null; c.act({ type: 'undo' }); });
  app.querySelector<HTMLButtonElement>('#toFinish')?.addEventListener('click', () => { ui.mode = 'finish'; ui.selected = null; render(); });
  app.querySelector<HTMLButtonElement>('#toPlace')?.addEventListener('click', () => {
    ui.mode = 'place'; ui.remove.clear(); ui.cart = []; render();
  });
  app.querySelector<HTMLButtonElement>('#endTurn')?.addEventListener('click', () => {
    c.act({ type: 'endTurn', remove: [...ui.remove], buy: [...ui.cart] });
  });
}

function render() {
  if (!ctrl) {
    renderHome();
  } else if (ctrl.view) {
    renderGame(ctrl, ctrl.view);
  } else {
    renderLobby(ctrl);
  }
  if (toast) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = toast;
    app.appendChild(t);
  }
}

// ?room=XXXX で開かれたら，名前があればそのまま部屋に入る
const initialRoom = new URLSearchParams(location.search).get('room');
if (initialRoom && store.get('minimalist.name')) {
  startController(new OnlineController(initialRoom.toUpperCase(), store.get('minimalist.name')!, token()));
} else {
  render();
}
