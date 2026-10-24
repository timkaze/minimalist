import './style.css';
import {
  CARDS, CardKind, HAND_SIZE, MARKET_CANDIDATES, MARKET_PICK, PROTOTYPE_KINDS, RESERVE_SIZE, STANDARD_PICK, STARTING_DECK,
  UNLIMITED, marketFromPick,
} from '../engine/cards';
import { Card, CardPlace, GameView, OwnedCard, PlayerSetup, Target, openCells, posKey, targetsFor } from '../engine/game';
import {
  CUSTOM_LIMITS, DEFAULT_FLOOR, FLOORS, FloorSpec, LEVEL_RANGE, RECOMMENDED_FLOORS, floorFromSpec, floorToSpec, isWall,
} from '../engine/floors';
import { BOT_LABELS } from '../bot/bot';
import { MAX_SEATS } from '../net/protocol';
import { cardHelp, cardSVG } from './cardsvg';
import { Controller, LocalController, OnlineController } from './controllers';

const app = document.getElementById('app')!;
const BOT_TYPES = ['random', 'balanced', 'engine', 'branch', 'rich', 'light', 'learned'];

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
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

// ---- 画面の状態 ----
let ctrl: Controller | null = null;
let toast = '';
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const ui = {
  turnKey: '',
  selected: null as number | null, // 選んだ手札・手元のカードのID
  mode: 'place' as 'place' | 'finish',
  /** 選んだ行き先（"行,列"） */
  target: null as string | null,
  remove: new Set<number>(),
  cart: [] as CardKind[],
  /** 手元に残すカード．undefined：今の手元のまま，null：残さない */
  keep: undefined as number | null | undefined,
  /** 持っているカードの一覧を開いているか（手番をまたいで保つ） */
  showCards: false,
};

function resetTurnUI() {
  ui.selected = null; ui.mode = 'place'; ui.target = null; ui.remove.clear(); ui.cart = []; ui.keep = undefined;
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
    <h1>ミニマリスト <small class="badge">レベル版（試験中）</small></h1>
    <p class="sub">物欲と捨てたい気持ちのあいだで，最後に全部手放すゲーム</p>
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

// ---- カスタムの間取り（テストプレイ用：大きさ・柱・行のレベル・列の支払える額を自由に決める） ----

const CUSTOM = 'custom';
type Tool = 'open' | 'wall';
const editor = { spec: loadCustom(), tool: 'wall' as Tool };

function loadCustom(): FloorSpec {
  try {
    const v = JSON.parse(store.get('minimalist.custom') ?? 'null') as FloorSpec;
    if (v) { floorFromSpec(v); return v; }
  } catch { /* 保存がない・壊れている・前の版の形式 */ }
  return floorToSpec(FLOORS[DEFAULT_FLOOR]);
}

const specGrid = (sp: FloorSpec) => sp.rows.map(r => r.trim().split(/\s+/));

function customEditorHTML(): string {
  const sp = editor.spec;
  const grid = specGrid(sp);
  const rows = grid.length, cols = grid[0].length;
  let err = '';
  try { floorFromSpec(sp); } catch (e) { err = (e as Error).message; }
  const { minSize, maxRows, maxCols, maxBudget } = CUSTOM_LIMITS;
  const startRow = sp.levels.indexOf(0);
  const tool = (t: Tool, label: string) =>
    `<label class="tool"><input type="radio" name="ctool" value="${t}" ${editor.tool === t ? 'checked' : ''}>${label}</label>`;
  let cells = `<span class="ce-corner">レベル↓<br>支払い→</span><span></span>`;
  cells += sp.budgets.map((x, c) => `<input class="ce-scale" type="number" min="0" max="${maxBudget}" value="${x}" data-budget="${c}" title="${c + 1}列目を行き先にしたときに支払える額">`).join('');
  grid.forEach((row, r) => {
    cells += `<input class="ce-scale lvl ${levelClass(sp.levels[r])}" type="number" min="${-LEVEL_RANGE}" max="${LEVEL_RANGE}" value="${sp.levels[r]}" data-level="${r}" title="${r + 1}行目のレベル">`;
    cells += r === startRow ? '<span class="ce-start">START→</span>' : '<span></span>';
    row.forEach((tok, c) => {
      cells += `<button type="button" class="ce-cell ${tok === '#' ? 'wall' : 'open'} ${levelClass(sp.levels[r])}" data-ce="${r},${c}"></button>`;
    });
  });
  return `
    <p class="hint">マスを押すと，下で選んだものに変わります．左の数字は行のレベル（−${LEVEL_RANGE}〜${LEVEL_RANGE}．＋は取得，−は排除），上の数字はその列を行き先にしたときに支払える額です．スタートはレベル0の最初の行の左に置かれます．</p>
    <div class="join">
      <label>行 <input type="number" id="ceRows" min="${minSize}" max="${maxRows}" value="${rows}"></label>
      <label>列 <input type="number" id="ceCols" min="${minSize}" max="${maxCols}" value="${cols}"></label>
    </div>
    <div class="join tools">${tool('open', '置ける')}${tool('wall', '柱')}</div>
    <div class="ce-grid" style="--cols:${cols}">${cells}</div>
    <div class="join">
      <select id="ceBase">${RECOMMENDED_FLOORS.map(n => `<option value="${n}">${FLOORS[n].label}</option>`).join('')}</select>
      <button type="button" id="ceLoad">をもとにする</button>
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
    const write = (g: string[][], levels = editor.spec.levels, budgets = editor.spec.budgets) =>
      update({ rows: g.map(r => r.join(' ')), levels, budgets });
    box.querySelectorAll<HTMLInputElement>('input[name=ctool]').forEach(el => {
      el.onchange = () => { editor.tool = el.value as Tool; };
    });
    box.querySelectorAll<HTMLElement>('[data-ce]').forEach(el => {
      el.onclick = () => {
        const [r, c] = el.dataset.ce!.split(',').map(Number);
        const g = grid.map(row => [...row]);
        g[r][c] = editor.tool === 'open' ? '.' : '#';
        write(g);
      };
    });
    const resize = (nr: number, nc: number) => {
      const { minSize, maxRows, maxCols } = CUSTOM_LIMITS;
      nr = Math.max(minSize, Math.min(maxRows, Math.round(nr) || rows));
      nc = Math.max(minSize, Math.min(maxCols, Math.round(nc) || cols));
      const g = Array.from({ length: nr }, (_, r) => Array.from({ length: nc }, (_, c) => grid[r]?.[c] ?? '.'));
      // 増えた行はレベル0，増えた列は前の列の額＋1
      const levels = Array.from({ length: nr }, (_, r) => editor.spec.levels[r] ?? 0);
      const budgets = Array.from({ length: nc }, (_, c) => editor.spec.budgets[c] ?? Math.min(CUSTOM_LIMITS.maxBudget, c + 1));
      write(g, levels, budgets);
    };
    box.querySelector<HTMLInputElement>('#ceRows')!.onchange = e => resize(Number((e.target as HTMLInputElement).value), cols);
    box.querySelector<HTMLInputElement>('#ceCols')!.onchange = e => resize(rows, Number((e.target as HTMLInputElement).value));
    const clamp = (x: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(x)) || 0));
    box.querySelectorAll<HTMLInputElement>('[data-level]').forEach(el => {
      el.onchange = () => {
        const levels = [...editor.spec.levels];
        levels[Number(el.dataset.level)] = clamp(el.value, -LEVEL_RANGE, LEVEL_RANGE);
        write(grid, levels);
      };
    });
    box.querySelectorAll<HTMLInputElement>('[data-budget]').forEach(el => {
      el.onchange = () => {
        const budgets = [...editor.spec.budgets];
        budgets[Number(el.dataset.budget)] = clamp(el.value, 0, CUSTOM_LIMITS.maxBudget);
        write(grid, undefined, budgets);
      };
    });
    box.querySelector<HTMLButtonElement>('#ceLoad')!.onclick = () =>
      update(floorToSpec(FLOORS[box.querySelector<HTMLSelectElement>('#ceBase')!.value]));
  };
  sel.addEventListener('change', () => { store.set('minimalist.floor', sel.value); draw(); });
  draw();
  return () => (sel.value === CUSTOM ? editor.spec : undefined);
}

// ---- 市場のカードを選ぶ（テストプレイ用．候補から MARKET_PICK 種類） ----

function savedPick(): CardKind[] {
  try {
    // 選びかけ（種類数が合わない）でも，ロビーの再描画で消えないように覚えておく
    const v = JSON.parse(store.get('minimalist.market2') ?? 'null');
    if (Array.isArray(v) && v.every(k => MARKET_CANDIDATES.includes(k))) return v;
  } catch { /* 保存がない・古い */ }
  return [...STANDARD_PICK];
}

function marketPicker(id: string): string {
  const picked = new Set(savedPick());
  return `
  <details class="field market-pick" id="${id}">
    <summary>市場のカード（${MARKET_PICK}種類）：<span data-pick-summary></span></summary>
    <p class="hint">基本カード（→・↓・↑）はいつも並びます．＊は標準に入っていないカード（ボットはあまり学習していません）．</p>
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
    store.set('minimalist.market2', JSON.stringify(p));
  };
  boxes.forEach(b => { b.onchange = sync; });
  root.querySelector<HTMLButtonElement>('[data-pick="standard"]')!.onclick = () => {
    boxes.forEach(b => { b.checked = STANDARD_PICK.includes(b.value as CardKind); });
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
    <li>山札から${HAND_SIZE}枚引く．前の手番に<b>手元</b>に残したカード（${RESERVE_SIZE}枚まで）も使える</li>
    <li>スタート（枠の外）の→から，矢印の先の空いたマスにカードを置いていく．＋のカードは置いたときに＋の数だけ引く</li>
    <li>置いたカード（とスタート）の矢印の先から<b>行き先</b>を1つ選ぶ．行き先の行の<b>レベル</b>と，列の<b>支払える額</b>で，次のどちらかをする
      <ul>
        <li>レベル0以上（物欲）：そのレベル以下のカードを，取得コストの合計が支払える額以下になるように市場から<b>取得</b>（捨札へ）．レベル0では基本カード（→↓↑）だけ</li>
        <li>レベル−（捨てたい気持ち）：場に置いたカードのうち，レベルがその絶対値以下のものを，排除コストの合計が支払える額以下になるように<b>排除</b></li>
      </ul></li>
    <li>置かなかったカードから1枚を手元に残せる．残りと場のカードは捨札へ</li>
  </ol>
  <p>初期デッキ：${STARTING_DECK.map(d => `${CARDS[d.kind].name}×${d.count}`).join('，')}．カードの左上がレベル，右上の丸が取得コスト，右下が排除コスト．</p>
  <p>手番の終わりに自分のカードが0枚になれば達成．そのラウンドの最後まで続け，達成者が複数なら排除した枚数が多い人の勝ち（同じなら共同勝利）．</p>
  <ul class="cardlist">${[...new Set([...STARTING_DECK.map(d => d.kind), ...MARKET_CANDIDATES])].map(k => `<li>${cardHelp(k)}</li>`).join('')}</ul>`;
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

const levelClass = (lv: number) => (lv > 0 ? 'row-buy' : lv < 0 ? 'row-drop' : 'row-zero');

function boardHTML(v: GameView, board: Record<string, Card>, opts: { mine: boolean; small?: boolean }): string {
  const myTurn = opts.mine && v.current === v.you && v.phase === 'play';
  const f = v.floor;
  const opens = myTurn && ui.mode === 'place' && ui.selected !== null
    ? new Set(openCells(board, f).map(posKey)) : new Set<string>();
  const targets = myTurn && ui.mode === 'finish' ? new Set(targetsFor(board, f).map(t => posKey(t.pos))) : new Set<string>();
  const chosen = myTurn ? ui.target : null;
  const chosenLevel = chosen ? f.levels[Number(chosen.split(',')[0])] : 0;
  let cells = opts.small ? '' : `<span class="b-corner">レベル＼支払い</span>`
    + f.budgets.map(b => `<span class="b-budget">${b}</span>`).join('');
  for (let r = 0; r < f.rows; r++) {
    const lv = f.levels[r];
    cells += `<span class="b-level ${levelClass(lv)}">${opts.small ? signed(lv) : `Lv${signed(lv)}`}</span>`;
    cells += r === f.startRow ? `<span class="b-start">${opts.small ? '→' : 'START →'}</span>` : '<span></span>';
    for (let c = 0; c < f.cols; c++) {
      const key = `${r},${c}`;
      const card = board[key];
      const cls = ['cell', levelClass(lv)];
      let inner = '';
      let attrs = '';
      if (isWall(f, key)) cls.push('wall');
      if (card) {
        inner = cardSVG(card.kind, { showName: !opts.small });
        // 紙袋など自分で消えるカードは，手番の終わりに必ず排除される（選ばなくてよい）
        if ((ui.remove.has(card.id) || CARDS[card.kind].selfRemove) && opts.mine) cls.push('marked');
        attrs += ` title="${esc(cardHelp(card.kind))}"`;
        // 行き先を決めた後，その行がレベル−なら，場のカードを押して排除を選ぶ
        if (myTurn && ui.mode === 'finish' && chosen && chosenLevel < 0 && !CARDS[card.kind].selfRemove) {
          cls.push('clickable'); attrs += ` data-toggle="${card.id}"`;
        }
      } else if (opens.has(key)) {
        cls.push('open'); attrs = `data-cell="${key}"`;
      }
      if (targets.has(key)) {
        cls.push('target');
        if (!chosen) { cls.push('clickable'); attrs += ` data-target="${key}"`; }
      }
      if (chosen === key) cls.push('chosen');
      cells += `<div class="${cls.join(' ')}" ${attrs}>${inner}</div>`;
    }
  }
  return `<div class="board2 ${opts.small ? 'small' : ''}" style="--rows:${f.rows};--cols:${f.cols}">${cells}</div>`;
}

const PLACE_LABEL: Record<CardPlace, string> = { hand: '手札', reserve: '手元', board: '場', deck: '山札', discard: '捨札' };

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
  const cur = v.players[v.current];
  const target: Target | undefined = me && ui.target
    ? targetsFor(me.board, v.floor).find(t => posKey(t.pos) === ui.target) : undefined;
  const cartCost = ui.cart.reduce((s, k) => s + CARDS[k].cost, 0);
  const boardCards = me ? Object.values(me.board) : [];
  const removeCost = boardCards.filter(x => ui.remove.has(x.id)).reduce((n, x) => n + CARDS[x.kind].removeCost, 0);
  const buying = myTurn && ui.mode === 'finish' && !!target && target.level >= 0;

  // 市場：レベルごとに並べる
  const levels = [...new Set(v.marketKinds.map(k => CARDS[k].level))].sort((a, b) => a - b);
  const market = levels.map(lv => `
    <div class="mrow"><span class="mlevel lv${lv}">Lv${lv}</span>${v.marketKinds.filter(k => CARDS[k].level === lv).map(k => {
      const left = v.market[k] - ui.cart.filter(x => x === k).length;
      const canBuy = buying && lv <= target!.level && left > 0 && cartCost + CARDS[k].cost <= target!.budget;
      return `<button class="mcard ${canBuy ? 'clickable' : ''}" ${canBuy ? `data-buy="${k}"` : 'disabled'} title="${esc(cardHelp(k))}">
        ${cardSVG(k)}<span class="stock">${v.market[k] >= UNLIMITED ? '売り切れなし' : `残り${v.market[k]}`}</span></button>`;
    }).join('')}</div>`).join('');

  // 手札と手元
  const keepId = ui.keep === undefined ? (me?.reserve?.[0]?.id ?? null) : ui.keep;
  const cardButton = (card: Card, where: 'hand' | 'reserve') => {
    const cls = ['hcard', where];
    let attrs = `title="${esc(cardHelp(card.kind))}"`;
    if (myTurn && ui.mode === 'place') { cls.push('clickable'); attrs += ` data-select="${card.id}"`; }
    if (myTurn && ui.mode === 'finish') { cls.push('clickable'); attrs += ` data-keep="${card.id}"`; }
    if (ui.selected === card.id) cls.push('selected');
    if (myTurn && ui.mode === 'finish' && keepId === card.id) cls.push('kept');
    return `<button class="${cls.join(' ')}" ${attrs}>${cardSVG(card.kind)}${where === 'reserve' ? '<span class="tag">手元</span>' : ''}</button>`;
  };
  const handHTML = [...(me?.reserve ?? []).map(x => cardButton(x, 'reserve')), ...(me?.hand ?? []).map(x => cardButton(x, 'hand'))].join('')
    || '<span class="muted">（手札なし）</span>';

  let controls = '';
  if (myTurn && ui.mode === 'place') {
    controls = `<p class="instr">${ui.selected === null ? '手札（または手元）のカードを選んで，光っているマスに置きます' : '置くマスを選んでください'}</p>
      <button id="undo" ${v.undoCount > 0 ? '' : 'disabled'} title="引くカードを置いた後は，それより前に戻せません">↶ 戻す${v.undoCount > 0 ? `（${v.undoCount}）` : ''}</button>
      <button class="primary" id="toFinish">配置を終える</button>`;
  } else if (myTurn && ui.mode === 'finish') {
    const head = !target
      ? '<p class="instr">枠で囲まれたマス（矢印の先）から<b>行き先</b>を1つ選びます．何もしないならそのまま手番を終えられます</p>'
      : target.level >= 0
        ? `<p class="instr">行き先：レベル${signed(target.level)}・支払い${target.budget}．レベル${target.level}以下のカードを市場から<b>取得</b>できます（使用 ${cartCost}/${target.budget}）</p>`
        : `<p class="instr">行き先：レベル${target.level}・支払い${target.budget}．場のカードのうちレベル${-target.level}以下のものを押して<b>排除</b>します（使用 ${removeCost}/${target.budget}）</p>`;
    controls = `${head}
      ${target && target.level >= 0 ? `<div class="cart">取得：${ui.cart.length ? ui.cart.map((k, i) => `<button class="chip" data-uncart="${i}">${CARDS[k].name} ✕</button>`).join('') : 'なし'}</div>` : ''}
      <p class="hint">置かなかったカードを押すと，次の手番以降のために<b>手元</b>に残せます（${RESERVE_SIZE}枚まで．もう一度押すと取り消し）</p>
      ${target ? '<button id="retarget">行き先を選び直す</button>' : ''}
      <button id="toPlace">配置に戻る</button> <button class="primary" id="endTurn">手番を終える</button>`;
  } else if (v.phase === 'play') {
    controls = `<p class="instr">${esc(cur.name)}の手番です…</p>`;
  }

  const stats = me ? `
    <div class="stats">
      <span>残り所持 <b>${me.owned}</b></span>
      <span>山札 ${me.deckCount} / 捨札 ${me.discardCount} / 手元 ${me.reserveCount}</span>
      <span>排除済み ${me.removed}</span>
      <span>取得 ${me.bought}</span>
    </div>
    ${ownedCardsHTML(me.cards ?? [])}` : '';

  const others = v.players.map((p, i) => i === v.you ? '' : `
    <div class="opp ${i === v.current && v.phase === 'play' ? 'active' : ''}">
      <div class="opp-head">${p.finished ? '★ ' : ''}${esc(p.name)}</div>
      <div class="opp-stats">残り${p.owned}枚・排除${p.removed}・取得${p.bought}・手札${p.handCount}・手元${p.reserveCount}</div>
      ${boardHTML(v, p.board, { mine: false, small: true })}
    </div>`).join('');

  const over = v.phase === 'over' ? `
    <div class="overlay"><div class="dialog">
      <h2>${v.winners.length === 0 ? '引き分け' : v.winners.map(i => esc(v.players[i].name)).join('・') + (v.winners.length > 1 ? 'の共同勝利' : 'の勝利')}</h2>
      <ul>${v.players.map(p => `<li>${p.finished ? '★' : ''}${esc(p.name)}：残り${p.owned}枚，排除${p.removed}枚，取得${p.bought}枚</li>`).join('')}</ul>
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
    <section class="market2">${market}</section>
    <section class="me">
      <div>${me ? boardHTML(v, me.board, { mine: true }) : '<p>観戦中</p>'}</div>
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
  app.querySelectorAll<HTMLElement>('[data-target]').forEach(el => {
    el.onclick = () => { ui.target = el.dataset.target!; ui.remove.clear(); ui.cart = []; render(); };
  });
  app.querySelectorAll<HTMLElement>('[data-toggle]').forEach(el => {
    el.onclick = () => {
      const id = Number(el.dataset.toggle);
      const card = boardCards.find(x => x.id === id)!;
      if (ui.remove.has(id)) ui.remove.delete(id);
      else if (CARDS[card.kind].level > -target!.level) return showToast(`${CARDS[card.kind].name}はレベル${CARDS[card.kind].level}なので，この行では排除できません`);
      else if (removeCost + CARDS[card.kind].removeCost <= target!.budget) ui.remove.add(id);
      else return showToast(`支払える額が足りません（あと${target!.budget - removeCost}）`);
      render();
    };
  });
  app.querySelectorAll<HTMLElement>('[data-keep]').forEach(el => {
    el.onclick = () => { const id = Number(el.dataset.keep); ui.keep = keepId === id ? null : id; render(); };
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
  app.querySelector<HTMLButtonElement>('#retarget')?.addEventListener('click', () => {
    ui.target = null; ui.remove.clear(); ui.cart = []; render();
  });
  app.querySelector<HTMLButtonElement>('#toPlace')?.addEventListener('click', () => {
    ui.mode = 'place'; ui.target = null; ui.remove.clear(); ui.cart = []; ui.keep = undefined; render();
  });
  app.querySelector<HTMLButtonElement>('#endTurn')?.addEventListener('click', () => {
    c.act({
      type: 'endTurn',
      target: ui.target ? ui.target.split(',').map(Number) as [number, number] : undefined,
      remove: [...ui.remove], buy: [...ui.cart], keep: keepId,
    });
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
