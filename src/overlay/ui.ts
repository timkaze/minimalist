// オーバーレイ版の画面：ローカル（ボットと）とオンライン（部屋コードで人と．ボットも入れられる）
//   コマは描かない．「今止めるとどのマスの効果になるか」を盤（光るマス）とパネルに常に出す

import './ui.css';
import { ARROW, Dir, Fx, MARKET, OKind, TILES, TILE_SETS, UNLIMITED_KINDS, dirsText, fxText, marketFromChoice, startingBag, tileDirs, weightOf } from './tiles';
import { OMAX_SEATS, ORoomInfo, OServerMsg } from './protocol';
import {
  DEFAULT_RULES, OAction, OBOARDS, OPlayer, OState, Pos, Rules, Tile, X_MAX, X_MIN, applyOverlay, canBuyAt, canDraw, canDropAt, canMove,
  chipNeed, dirsOf, discardLimit, envOf, favCost, hereFx, isDeep, isLastCard, newOverlayGame, normRules, ownedTiles, printedFx, removeLoad, samePos,
  stackAt, step, tileFx, topTile, yMax, yMin,
} from './engine';
import { OBOT_LABELS, OPRESETS, RANDOM_BOT, chooseOverlayAction, resolveBot } from './bot';
import { randomSeed } from '../engine/rng';

const app = document.getElementById('app')!;
const store = {
  get: (k: string) => { try { return localStorage.getItem(`overlay.${k}`); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`overlay.${k}`, v); } catch { /* 保存できなくても遊べる */ } },
};

let s: OState | null = null;
let me = 0;
let timer = 0;
const sel = { buy: [] as OKind[], remove: new Set<number>(), roomba: null as number | null };
const clearSel = () => { sel.buy = []; sel.remove.clear(); sel.roomba = null; };
let local: { rules: Rules; market: OKind[] } | null = null;
let localBots: string[] = [];
/** ローカル対戦の参加者．ランダムのボットはここでくじを引く（名前は型を明かさない） */
const localSetup = (name: string) => [{ name }, ...localBots.map((t, i) => t === RANDOM_BOT
  ? { name: `ボット${i + 1}（ランダム）`, isBot: true, botType: resolveBot(t) }
  : { name: OBOT_LABELS[t], isBot: true, botType: t })];

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ---- オンライン ----

interface Net { ws: WebSocket | null; code: string; token: string; name: string; room: ORoomInfo | null; closed: boolean }
let net: Net | null = null;
let nameDraft: string | null = null;

function token(): string {
  let t = store.get('token');
  if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('token', t); }
  return t;
}

function goOnline(code: string, name: string) {
  code = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) return alert('部屋コードは英数字4〜8文字です');
  if (name) store.set('name', name);
  clearTimeout(timer);
  s = null;
  net = { ws: null, code, token: token(), name, room: null, closed: false };
  nameDraft = null;
  history.replaceState(null, '', `?room=${code}`);
  connect();
  render();
}

function connect() {
  const n = net;
  if (!n) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/overlay/${n.code}/ws`);
  n.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: n.name, token: n.token }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data) as OServerMsg;
    if (m.t === 'error') { alert(m.message); return; }
    const prevKey = s ? `${s.current}-${s.round}-${s.turn}` : '';
    n.room = m.room;
    s = m.state;
    me = m.room.you;
    if (!s || `${s.current}-${s.round}-${s.turn}` !== prevKey) clearSel();
    render();
  };
  ws.onclose = () => { if (net === n && !n.closed) setTimeout(connect, 1500); };
}

function send(msg: object) {
  if (net?.ws?.readyState === WebSocket.OPEN) net.ws.send(JSON.stringify(msg));
  else alert('接続中です．少し待ってからもう一度');
}

function leaveOnline() {
  if (net) { net.closed = true; net.ws?.close(); }
  net = null;
  history.replaceState(null, '', location.pathname);
}

// ---- タイルの見た目 ----

/** 今のルール（ゲーム中はその卓のルール，開始画面では選んでいるルール） */
const R = (): Rules => s?.rules ?? readRulesDraft();

/**
 * タイル1枚．辺の近くに出られる向きの矢印，中央にタイルの効果．
 * 四隅：左上＝コスト（盤の上では置いた順），右上＝取得の条件（衝n），左下＝捨てる重さ，右下＝排除の条件（理n）
 */
function tileHTML(kind: OKind, o: { fx?: Fx; cls?: string; attr?: string; seq?: number; stack?: number; count?: number; cost?: boolean } = {}): string {
  const d = TILES[kind];
  const rules = R();
  const dirs = tileDirs(kind, rules);
  const fx = o.fx ?? (s ? tileFx(kind, { rules: s.rules, removed: me >= 0 ? s.players[me].removed : 0 }) : kind === 'HES' && rules.hes === 'second' ? { kind: 'buy' as const, amount: 3 } : d.fx);
  const center = d.perm ? '<span class="fx">★</span>'
    : fx.kind === 'none' ? '<span class="fx none">–</span>'
    : `<span class="fx"><small>${fx.kind === 'buy' ? '額' : '量'}</small>${kind === 'LIGHT' && !s ? '?' : fx.amount}</span>`;
  const tl = o.seq ? `<span class="seq">${o.seq}</span>` : o.cost && d.cost !== null ? `<span class="c-cost" title="取得コスト">${d.cost}</span>` : '';
  const tr = (o.stack ?? 0) > 1 ? `<span class="stk">${o.stack}枚</span>` : (o.count ?? 0) > 1 ? `<span class="cnt">×${o.count}</span>`
    : o.cost && rules.needs && d.buyNeed ? `<span class="c-imp" title="衝動${d.buyNeed}以上の列で取得">衝${d.buyNeed}</span>` : '';
  const bl = d.perm ? '' : `<span class="c-w" title="捨てる重さ">重${weightOf(kind, rules)}</span>`;
  const br = rules.needs && d.dropNeed ? `<span class="c-calm" title="理性${d.dropNeed}以上の列で排除">理${d.dropNeed}</span>` : '';
  return `<div class="tile k-${d.perm ? 'perm' : fx.kind} ${dirs.length || d.perm ? '' : 'stay'} ${o.cls ?? ''}" ${o.attr ?? ''} title="${esc(tileTitle(kind))}">
    ${dirs.map(x => `<i class="ar ${x}"></i>`).join('')}${center}<span class="nm">${d.name}</span>${tl}${tr}${bl}${br}</div>`;
}

function tileTitle(kind: OKind): string {
  const d = TILES[kind];
  const rules = R();
  if (d.perm) return `★${d.name}：${d.note}`;
  return `${d.name}：${dirsText(tileDirs(kind, rules))}／置いたマスは${fxText(d.fx)}${d.note ? `（${d.note}）` : ''}／重さ${weightOf(kind, rules)}`;
}

/** 効果つきの説明カード（市場・開始画面） */
function infoHTML(kind: OKind, extra = '', count = 0): string {
  const d = TILES[kind];
  const rules = R();
  const badges = [
    d.cost !== null ? `<span class="badge bc">コスト${d.cost}</span>` : '<span class="badge">初期</span>',
    !d.perm ? `<span class="badge w">重さ${weightOf(kind, rules)}</span>` : '',
    rules.needs && d.buyNeed ? `<span class="badge imp">衝動${d.buyNeed}で取得</span>` : '',
    rules.needs && d.dropNeed ? `<span class="badge calm">理性${d.dropNeed}で排除</span>` : '',
  ].join('');
  const text = d.perm ? d.note : `${dirsText(tileDirs(kind, rules))}${d.note && kind !== 'JUNK' ? `．${d.note}` : ''}`;
  return `<div class="info ${d.perm ? 'perm' : ''}">${tileHTML(kind, { count, cost: true })}
    <div class="it"><div class="in"><b>${d.perm ? '★' : ''}${d.name}</b></div>
      <div class="id">${esc(text ?? '')}</div><div class="ib">${badges}</div>${extra}</div></div>`;
}

/** タイルを種類ごとにまとめた小さな一覧（袋・捨て山） */
function chipsHTML(tiles: Tile[]): string {
  const counts = new Map<OKind, number>();
  for (const t of tiles) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);
  const order = Object.keys(TILES) as OKind[];
  return [...counts.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([k, n]) => tileHTML(k, { count: n, cls: 'chip' })).join('') || '<span class="muted">なし</span>';
}

// ---- ルールとセットの選択（ローカル・オンライン共通） ----

const RULE_OPTS: { key: keyof Rules; label: string; choices: [string, string][] }[] = [
  { key: 'hes', label: 'ためらい', choices: [['first', '出たらそこで終わり（タイルは効果なし）'], ['second', '2枚目が出たら終わり（タイルは額3）']] },
  { key: 'hesCount', label: '初期の袋のためらい', choices: [['1', '1枚'], ['2', '2枚'], ['3', '3枚']] },
  { key: 'midBuy', label: '中央の行（START の左右）', choices: [['true', '額2（ためらいの最低保証）'], ['false', '効果なし']] },
  { key: 'weights', label: '捨てる重さ', choices: [['heavy', '重い（欲しい2・↑へ行くタイル2・ガラクタ2）'], ['light', '軽い（ガラクタ2，ほかは1）']] },
  { key: 'chips', label: '決心チップ', choices: [['true', 'あり（排除できなかった手番に1枚．重さ1か条件1段階に使える）'], ['false', 'なし']] },
  { key: 'junk', label: 'ガラクタの矢印', choices: [['right', '→だけ'], ['four', '4方向']] },
  { key: 'special', label: '特別なマス', choices: [['true', 'あり（捨欲の中の額マス・福袋・運試し）'], ['false', 'なし']] },
  { key: 'traces', label: '片付けた跡の壁', choices: [['false', 'なし'], ['true', 'あり（排除したマスに入れなくなる）']] },
  { key: 'board', label: '盤', choices: Object.values(OBOARDS).map(b => [b.name, b.label] as [string, string]) },
  { key: 'cols', label: '列の増減（盤の印刷）', choices: [['v06', '衝動は額＋・量−，理性は量＋・額−'], ['bonus', '上乗せだけ（衝動は額＋，理性は量＋）'], ['none', 'なし']] },
  { key: 'needs', label: '取得・排除の条件', choices: [['true', 'あり（衝動nで取得／理性nで排除）'], ['false', 'なし']] },
  { key: 'lastCard', label: '最後の1枚', choices: [['true', 'どこで止まっても手放せる'], ['false', '量のマスでしか手放せない']] },
  { key: 'refill', label: '袋が尽きたら', choices: [['true', '捨て山を戻して引き続けられる'], ['false', '止めるしかない']] },
];

function savedRules(): Rules {
  try { return normRules(JSON.parse(store.get('rules2') ?? '{}')); } catch { return { ...DEFAULT_RULES }; }
}
/** 開始画面で今選んでいるルール（画面に無ければ保存してあるもの） */
function readRulesDraft(): Rules {
  const raw: Record<string, unknown> = {};
  let found = false;
  app.querySelectorAll<HTMLSelectElement>('select[data-rule]').forEach(x => {
    found = true;
    raw[x.dataset.rule!] = x.value === 'true' ? true : x.value === 'false' ? false : /^\d+$/.test(x.value) ? +x.value : x.value;
  });
  return found ? normRules(raw as Partial<Rules>) : savedRules();
}

function optionsHTML(): string {
  const r = savedRules();
  const set = store.get('set') ?? 'all';
  const custom = new Set((store.get('tiles') ?? MARKET.join(',')).split(','));
  return `<div class="opts">
    ${RULE_OPTS.map(o => `<label><span>${o.label}${String(r[o.key]) !== String(DEFAULT_RULES[o.key]) ? ' <em>変更中</em>' : ''}</span>
      <select data-rule="${o.key}">${o.choices.map(([v, l]) => `<option value="${v}" ${String(r[o.key]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`).join('')}
    <label><span>市場のタイル</span><select id="set">${TILE_SETS.map(c => `<option value="${c.id}" ${c.id === set ? 'selected' : ''}>${c.label}</option>`).join('')}
      <option value="custom" ${set === 'custom' ? 'selected' : ''}>自分で選ぶ</option></select></label>
    </div>
    <p><button id="resetRules">ルールを既定に戻す</button></p>
    <div id="setInfo" class="setinfo"></div>
    <div id="custom" class="grid" ${set === 'custom' ? '' : 'hidden'}>${MARKET.map(k => `<label class="ck"><input type="checkbox" value="${k}" ${custom.has(k) || UNLIMITED_KINDS.includes(k) ? 'checked' : ''} ${UNLIMITED_KINDS.includes(k) ? 'disabled' : ''}>${infoHTML(k)}</label>`).join('')}</div>
    <details class="fold" id="startbag"><summary>初期の袋（全員同じ）</summary><div class="grid" id="startbagBody"></div></details>`;
}

function bindOptions() {
  const setSel = app.querySelector<HTMLSelectElement>('#set');
  if (!setSel) return;
  const info = () => {
    const v = setSel.value;
    app.querySelector<HTMLElement>('#custom')!.hidden = v !== 'custom';
    const cs = TILE_SETS.find(c => c.id === v);
    const shown = v === 'random' ? MARKET : cs?.tiles ?? [];
    app.querySelector<HTMLElement>('#setInfo')!.innerHTML = v === 'custom' ? 'チェックしたタイルが市場に並びます．片付けたいは必ず入ります．ほかに4種類以上'
      : `${cs?.note ?? ''}${v === 'random' ? '（候補）' : ''}<div class="grid">${shown.map(k => infoHTML(k)).join('')}</div>`;
    app.querySelector<HTMLElement>('#startbagBody')!.innerHTML = startingBag(readRulesDraft().hesCount).map(([k, n]) => infoHTML(k, '', n)).join('');
  };
  setSel.onchange = () => { store.set('set', setSel.value); info(); };
  app.querySelectorAll<HTMLSelectElement>('select[data-rule]').forEach(x => x.onchange = () => { store.set('rules2', JSON.stringify(readRulesDraft())); info(); });
  app.querySelectorAll<HTMLInputElement>('#custom input').forEach(x => x.onchange = () =>
    store.set('tiles', [...app.querySelectorAll<HTMLInputElement>('#custom input:checked')].map(y => y.value).join(',')));
  app.querySelector<HTMLButtonElement>('#resetRules')!.onclick = () => { store.set('rules2', JSON.stringify(DEFAULT_RULES)); render(); };
  info();
}

function readOptions(): { rules: Rules; set: string; tiles?: OKind[]; market: OKind[] } | null {
  const rules = readRulesDraft();
  const set = app.querySelector<HTMLSelectElement>('#set')!.value;
  const tiles = [...app.querySelectorAll<HTMLInputElement>('#custom input:checked')].map(x => x.value as OKind);
  let market: OKind[];
  try { market = marketFromChoice(set === 'custom' ? tiles : set); } catch (e) { alert((e as Error).message); return null; }
  store.set('rules2', JSON.stringify(rules));
  store.set('set', set);
  if (set === 'custom') store.set('tiles', tiles.join(','));
  return { rules, set, tiles: set === 'custom' ? tiles : undefined, market };
}

function rulesHTML() {
  return `<ul class="rules">
    <li><b>コマはありません．</b>手番は START から．袋からタイルを1枚引き，<b>今いるマスに置いて</b>，タイルの矢印の向きへ1マス出ます（少なくとも1枚引く）</li>
    <li>置いたタイルは，そのマスの効果を<b>上書き</b>します．同じマスに重ねたら一番上のタイルが有効．タイルの数字はそのまま（列の増減は足さない）</li>
    <li>好きなところで止めます．止まったマスの<b>一番上に見えている効果</b>（タイルがあればタイル，なければ盤の印刷）を使います：<b class="cb">額</b>はその額まで市場から取得，<b class="cr">量</b>はその量（重さの合計）まで，この手番に置いたタイルを排除</li>
    <li>盤の端へは出られず，置いたタイルの上に残ります．矢印が複数あるタイルは向きを選びます．矢印のないタイルは置いたタイルの上で止まります</li>
    <li>引くほど通ったマスが塗り替わります．良いマスに立っているうちに止めるか，もう1枚引くか</li>
    <li>手番の終わりに盤のタイルを全部はがして捨て山へ．袋が空になったら捨て山を袋に戻します</li>
    <li>特別なマス：捨欲の領域にも<b class="cb">額</b>のマスが点々とある（量のタイルで塗り替えられる）．<b>福袋</b>は共有の福袋からくじで1枚もらう．<b>運試し</b>は，自分の袋（まだ引いていないタイル）に当たりチップを混ぜ，当たりが出るまでタイルを表にする．表にした枚数がそのまま量になる（そのあとは量のマスと同じ）．表にしたタイルは排除の対象にならず，捨て山へ送る</li>
    <li>タイルの四隅：左上＝コスト，右上＝取得の条件（衝n＝衝動n以上の列），左下＝捨てる重さ，右下＝排除の条件（理n＝理性n以上の列）</li>
    <li><b>決心チップ</b>（◆）：1枚も排除できなかった手番の終わりに1枚もらう（3枚まで）．量のマスで排除するとき，1枚で「重さ1の肩代わり」か「理性の条件1段階の免除」に使える．足りない分だけ自動で使う</li>
    <li>高いものは<b>衝動の列でないと取得できない</b>，思い入れのあるものは<b>理性の列でないと排除できない</b>（タイルの説明に書いてあります）</li>
    <li>★お気に入りは取得したら自分の前に置き，効果がずっと続きます（袋に入らない．各1枚）</li>
    <li>タイルが0枚になったら達成．そのラウンドの最後まで遊び，排除した枚数が多い人の勝ち（同じならお気に入りのコストの合計）</li>
  </ul>`;
}

// ---- 待合室 ----

function lobby() {
  const room = net!.room;
  if (!room) { app.innerHTML = `<main class="setup"><p>部屋 ${esc(net!.code)} に接続しています…</p><button id="back">戻る</button></main>`; bindBack(); return; }
  const link = `${location.origin}${location.pathname}?room=${room.code}`;
  const opts = [RANDOM_BOT, ...Object.keys(OPRESETS)].map(k => `<option value="${k}">${OBOT_LABELS[k]}</option>`).join('');
  const prev = document.activeElement as HTMLInputElement | null;
  const caret = prev?.id === 'myname' ? prev.selectionStart : null;
  const named = !!store.get('name');
  app.innerHTML = `
  <main class="setup">
    <h1 class="logo">部屋 <span>${esc(room.code)}</span></h1>
    <p>この URL を送ると一緒に遊べます<br><input class="link" readonly value="${esc(link)}"> <button id="copy">コピー</button></p>
    ${room.you >= 0 ? `<section class="box ${named ? '' : 'attn'}"><div class="myname"><label>あなたの名前 <input id="myname" maxlength="12" value="${esc(nameDraft ?? (named ? room.seats[room.you].name : ''))}" placeholder="名前を入力"></label>
      <button id="rename" class="primary">${named ? '変更' : '決定'}</button>${named ? '' : '<span class="hint">名前を決めてください</span>'}</div></section>` : ''}
    <h3>参加者（${room.seats.length}/${OMAX_SEATS}）</h3>
    <ul class="seats">${room.seats.map((x, i) => `<li class="${i === room.you ? 'you' : ''}"><span class="dot p${i}"></span>${esc(x.name)}${i === room.you ? '（あなた）' : ''}${x.isBot || x.connected ? '' : ' <span class="muted">（切断中）</span>'}
      ${room.isHost && i !== room.you ? `<button data-remove="${i}">外す</button>` : ''}</li>`).join('')}</ul>
    ${room.you < 0 ? '<p class="muted">満席か，すでに始まっているため観戦になります</p>' : ''}
    ${room.isHost ? `
      <p><select id="botType">${opts}</select> <button id="addBot" ${room.seats.length >= OMAX_SEATS ? 'disabled' : ''}>ボットを追加</button></p>
      <section class="box"><h3>ルール</h3>${optionsHTML()}</section>
      <button id="start" class="primary big" ${room.seats.length < 2 ? 'disabled' : ''}>ゲーム開始</button>
      ${room.seats.length < 2 ? '<p class="muted">2人以上（ボットを含む）で始められます</p>' : ''}`
    : `<p class="muted">ホストが開始するのを待っています…（ルールと市場のタイルはホストが選びます）</p>
       <details class="fold" open><summary>タイルの効果</summary><div class="grid">${[...startingBag(2).map(x => x[0]), ...MARKET].map(k => infoHTML(k)).join('')}</div></details>`}
    <p><button id="back">部屋を出る</button></p>
    <details class="fold"><summary>ルールの要約</summary>${rulesHTML()}</details>
  </main>`;
  bindOptions();
  bindBack();
  const nameIn = app.querySelector<HTMLInputElement>('#myname');
  if (nameIn) {
    if (caret !== null) { nameIn.focus(); nameIn.setSelectionRange(caret, caret); }
    nameIn.oninput = () => { nameDraft = nameIn.value; };
    const rename = () => {
      const name = nameIn.value.trim();
      if (!name) return nameIn.focus();
      store.set('name', name);
      net!.name = name;
      nameDraft = null;
      send({ t: 'rename', name });
    };
    nameIn.onkeydown = e => { if (e.key === 'Enter') rename(); };
    app.querySelector<HTMLButtonElement>('#rename')!.onclick = rename;
  }
  app.querySelector<HTMLButtonElement>('#copy')?.addEventListener('click', () => navigator.clipboard?.writeText(link));
  app.querySelector<HTMLButtonElement>('#addBot')?.addEventListener('click', () => send({ t: 'addBot', botType: app.querySelector<HTMLSelectElement>('#botType')!.value }));
  app.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(b => b.onclick = () => send({ t: 'removeSeat', seat: +b.dataset.remove! }));
  app.querySelector<HTMLButtonElement>('#start')?.addEventListener('click', () => {
    const o = readOptions();
    if (o) send({ t: 'start', rules: o.rules, set: o.set, tiles: o.tiles });
  });
}

function bindBack() {
  app.querySelector<HTMLButtonElement>('#back')?.addEventListener('click', () => { leaveOnline(); render(); });
}

// ---- 開始画面 ----

function setup() {
  clearTimeout(timer);
  me = 0;
  document.title = 'ミニマリスト オーバーレイ版';
  const saved = (store.get('bots.v2') ?? `${RANDOM_BOT},${RANDOM_BOT}`).split(',');
  const opts = (v: string) => [RANDOM_BOT, ...Object.keys(OPRESETS)].map(k => `<option value="${k}" ${k === v ? 'selected' : ''}>${OBOT_LABELS[k]}</option>`).join('');
  app.innerHTML = `
  <main class="setup">
    <h1 class="logo">ミニマリスト <span>オーバーレイ版</span></h1>
    <p class="lead">袋から引いたタイルを盤に重ねて，今日の流れを描く．通った道は塗り替わる．
      良いマスに立っているうちに止めて，<b class="cb">額</b>のマスなら取得，<b class="cr">量</b>のマスなら置いたタイルを排除．タイルを0枚にしたら達成．</p>
    <section class="box"><label>あなたの名前 <input id="name" value="${esc(store.get('name') ?? '')}" maxlength="12" placeholder="名前を入力"></label></section>
    <section class="box">
      <h3>人と遊ぶ（オンライン）</h3>
      <p class="muted">部屋を作って URL を送るか，教えてもらった部屋コードで入ります．名前は部屋に入ってからも変えられます．ルールは部屋を作った人が選びます</p>
      <button id="create" class="primary">部屋を作る</button>
      <span class="join"><input id="code" maxlength="8" placeholder="部屋コード" value="${esc(new URLSearchParams(location.search).get('room') ?? '')}"> <button id="join">入る</button></span>
    </section>
    <section class="box">
      <h3>ボットと遊ぶ（この端末だけ）</h3>
      <div id="bots">${[0, 1, 2].map(i => `<label>ボット${i + 1}
        <select data-i="${i}"><option value="">なし</option>${opts(saved[i] ?? '')}</select></label>`).join('')}</div>
      <h3>ルール</h3>
      ${optionsHTML()}
      <button id="start" class="primary big">はじめる</button>
    </section>
    <details class="fold"><summary>ルールの要約</summary>${rulesHTML()}</details>
  </main>`;
  bindOptions();
  const rawName = () => app.querySelector<HTMLInputElement>('#name')!.value.trim();
  app.querySelector<HTMLButtonElement>('#create')!.onclick = () => {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    goOnline(Array.from({ length: 5 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''), rawName());
  };
  app.querySelector<HTMLButtonElement>('#join')!.onclick = () => goOnline(app.querySelector<HTMLInputElement>('#code')!.value, rawName());
  app.querySelector<HTMLButtonElement>('#start')!.onclick = () => {
    const name = rawName() || 'あなた';
    let botTypes = [...app.querySelectorAll<HTMLSelectElement>('#bots select')].map(x => x.value).filter(Boolean);
    if (!botTypes.length) botTypes = [RANDOM_BOT];
    const o = readOptions();
    if (!o) return;
    store.set('name', name);
    store.set('bots.v2', botTypes.join(','));
    local = { rules: o.rules, market: o.market };
    localBots = botTypes;
    s = newOverlayGame(localSetup(name), randomSeed(), local);
    clearSel();
    render();
  };
}

// ---- ゲーム画面 ----

const cur = () => s!.players[s!.current];
const colLabel = (x: number) => (x < 0 ? `理性${-x}` : x > 0 ? `衝動${x}` : '中');
const rowLabel = (y: number) => (y > 0 ? `物欲${y}` : y < 0 ? `捨欲${-y}` : '中央');
const fxWord = (fx: Fx) => (fx.kind === 'buy' ? `額${fx.amount}で取得` : fx.kind === 'remove' ? `量${fx.amount}で排除` : fx.kind === 'gacha' ? '福袋を引く' : fx.kind === 'lucky' ? '運試し（袋から表にした枚数が量）' : '効果なし');

let lastTopId = 0;

function boardHTML(p: OPlayer, mine: boolean): string {
  const st = s!, b = st.board;
  const active = st.phase === 'play';
  const picks: { pos: Pos; dir: Dir }[] = [];
  if (mine && st.turn === 'branch') {
    const env = envOf(st, p), last = p.placed[p.placed.length - 1];
    for (const d of dirsOf(last.kind, env)) if (canMove(env, p.pos, d)) picks.push({ pos: step(p.pos, d), dir: d });
  }
  const newest = p.placed[p.placed.length - 1];
  const isNew = !!newest && newest.id !== lastTopId;
  lastTopId = newest?.id ?? 0;
  let h = `<div class="board ${mine ? 'mine' : ''}" style="--rows:${yMax(b) - yMin(b) + 1}"><div class="corner"></div>`;
  for (let x = X_MIN; x <= X_MAX; x++) h += `<div class="colh ${x < 0 ? 'calm' : x > 0 ? 'imp' : ''}" style="--a:${Math.abs(x) / 3}">${colLabel(x)}</div>`;
  for (let y = yMax(b); y >= yMin(b); y--) {
    h += `<div class="rowh ${y > 0 ? 'buy' : y < 0 ? 'remove' : ''}" ${isDeep(y, b) ? 'title="一番下の行：捨て山からも1枚排除できる"' : ''}>${y === 0 ? '' : y > 0 ? '物欲' : '捨欲'}</div>`;
    for (let x = X_MIN; x <= X_MAX; x++) {
      const pos = { x, y };
      const pf = printedFx(pos, b, st.rules);
      const stack = stackAt(p.placed, pos);
      const top = stack[stack.length - 1];
      const here = active && samePos(p.pos, pos);
      const pick = picks.find(c => samePos(c.pos, pos));
      const wall = st.rules.traces && p.traces.some(t => samePos(t, pos));
      const cls = ['cell', pf.kind, here ? 'here' : '', pick ? 'pick' : '', x === 0 && y === 0 ? 'start' : ''].join(' ');
      const printed = x === 0 && y === 0 ? '<span class="pf st">START</span>'
        : pf.kind === 'none' ? '' : pf.kind === 'gacha' ? '<span class="pf sp" title="福袋：共有の福袋から1枚もらう">福<small>福袋</small></span>'
        : pf.kind === 'lucky' ? '<span class="pf sp" title="運試し：自分の袋に当たりチップを混ぜ，当たりが出るまでに表にした枚数が量になる">運<small>運試し</small></span>'
        : `<span class="pf"><small>${pf.kind === 'buy' ? '額' : '量'}</small>${pf.amount}</span>`;
      const tile = top ? tileHTML(top.kind, { fx: tileFx(top.kind, envOf(st, p)), seq: p.placed.indexOf(top) + 1, stack: stack.length, cls: `${stack.length > 1 ? 'stacked' : ''} ${isNew && top === newest ? 'new' : ''}` }) : '';
      h += `<div class="${cls}" style="--a:${Math.min(1, 0.16 + pf.amount * 0.12)}" ${pick ? `data-dir="${pick.dir}"` : ''}>${printed}${wall ? '<span class="wall" title="片付けた跡（入れない）">跡</span>' : ''}${tile}
        ${here ? `<span class="herebadge">${st.turn === 'branch' ? '出る向きを選ぶ' : 'いまここ'}</span>` : ''}${pick ? `<span class="pickar">${ARROW[pick.dir]}</span>` : ''}</div>`;
    }
  }
  return h + '</div>';
}

/** 「今止めるとどのマスの効果か」をいつも出す */
function hereHTML(p: OPlayer): string {
  const st = s!;
  const fx = hereFx(st, p);
  const top = topTile(p.placed, p.pos);
  const src = top ? `置いたタイル「${TILES[top.kind].name}」` : p.pos.x === 0 && p.pos.y === 0 ? 'START' : '盤の印刷';
  return `<div class="herebox ${fx.kind}"><span class="hl">${st.turn === 'resolve' ? '止まったマス' : 'いま止めると'}</span>
    <span class="hv">${fxWord(fx)}</span><span class="hs">${colLabel(p.pos.x)}・${rowLabel(p.pos.y)}／${src}</span></div>`;
}

/** left：取得フェイズで残っている額（これより高いタイルは暗くする） */
function marketHTML(buying: boolean, x = 0, left = Infinity): string {
  const st = s!;
  return Object.entries(st.market).map(([k, n]) => {
    const kind = k as OKind;
    const chosen = sel.buy.filter(y => y === kind).length;
    const stock = (n ?? 0) - chosen;
    // 取得できない：列の条件に合わない／お気に入りを持っている／残りの額で足りない
    const ok = canBuyAt(kind, x, st.rules) && !(TILES[kind].perm && (cur().perms.includes(kind) || chosen > 0)) && (TILES[kind].cost ?? 0) <= left;
    const ctl = buying ? `<span class="pm"><button data-sub="${kind}" ${chosen ? '' : 'disabled'}>−</button><b>${chosen}</b><button data-add="${kind}" ${stock <= 0 || !ok ? 'disabled' : ''}>＋</button></span>` : '';
    return `<div class="mk ${chosen ? 'on' : ''} ${(n ?? 0) <= 0 ? 'out' : ''} ${buying && !ok && !chosen ? 'no' : ''}">${infoHTML(kind, `<div class="stock">${n! >= 99 ? '∞' : `残り${n}`}${ctl}</div>`)}</div>`;
  }).join('');
}

/** 向きの選択：十字キーの並び（↑は上，←は左，→は右，↓は下）．「タイルを引く」と違う見た目・位置にし，表示直後の誤クリックを防ぐ */
function dpadHTML(dirs: Dir[], sub: (d: Dir) => string): string {
  const rows = (['U', 'LR', 'D'] as const).map(r => dirs.filter(d => r.includes(d))).filter(r => r.length);
  const col: Record<Dir, number> = { U: 2, D: 2, L: 1, R: 3 };
  return `<div class="dpad">${rows.map((r, i) => r.map(d => `<button data-dir="${d}" class="dirbtn" style="grid-row:${i + 1};grid-column:${col[d]}"><b>${ARROW[d]}</b><small>${esc(sub(d))}</small></button>`).join('')).join('')}</div>`;
}

function turnBanner(): string {
  const st = s!;
  if (st.phase === 'over') return `<div class="banner over">ゲーム終了</div>`;
  const p = cur();
  if (st.current === me) return `<div class="banner mine"><span class="tri">▶</span> あなたの番です <small class="lap">${st.round}周目</small><small>${st.turn === 'resolve' ? '止まったマスの効果を使う' : st.turn === 'branch' ? '出る向きを選ぶ' : 'タイルを引くか，止める'}</small></div>`;
  return `<div class="banner"><span class="dot p${st.current}"></span>${esc(p.name)}の番 <small class="lap">${st.round}周目</small><small>${me >= 0 ? `あなたの番まであと${(me - st.current + st.players.length) % st.players.length}人` : '観戦中'}</small></div>`;
}

function render() {
  if (!s) notifyTurn(false);
  if (net && !s) return lobby();
  if (!s) return setup();
  const st = s;
  const p = cur();
  const mine = st.current === me && st.phase === 'play';
  const human = me >= 0 ? st.players[me] : null;
  notifyTurn(mine);
  app.innerHTML = `
  <header><b class="logo sm">ミニマリスト <span>オーバーレイ版</span></b> <span class="round" title="全員が1回ずつ手番をすると1周">${st.round}周目</span>
    ${net ? `<span class="muted">部屋 ${esc(net.code)}</span>` : ''}
    <button id="sound" title="自分の番の合図音">${soundOn() ? '🔔 音あり' : '🔕 音なし'}</button>
    <button id="quit">${net ? '部屋を出る' : 'やめる'}</button></header>
  ${turnBanner()}
  ${st.log.length > 1 ? `<div class="lastlog">直前：${esc(st.log[st.log.length - 1])}</div>` : ''}
  <div class="seatsbar">${st.players.map((q, i) => `<div class="seat ${i === st.current && st.phase === 'play' ? 'now' : ''} ${i === me ? 'you' : ''}">
      <span class="dot p${i}"></span><b>${esc(q.name)}</b>${i === me ? '<em>あなた</em>' : ''}${q.finished ? ' ✓' : ''}${st.winners.includes(i) ? ' 🏆' : ''}
      <small class="tn">${st.phase === 'over' ? `${st.round}回手番` : i === st.current ? `${st.round}回目の手番中` : `手番${st.round - 1 + (i < st.current ? 1 : 0)}回済`}</small>
      <small>持ち物${ownedTiles(q).length}・排除${q.removed}${st.rules.chips ? `・決心<span class="cg">${'◆'.repeat(q.chips ?? 0) || '0'}</span>` : ''}${q.perms.length ? `・★${q.perms.map(k => TILES[k].name).join('・')}` : ''}</small></div>`).join('')}</div>
  <main class="game ${mine ? 'myturn' : ''}">
    <section class="left">
      <div class="who"><span class="dot p${st.current}"></span>${st.phase === 'over' ? '最後の盤' : mine ? 'あなたの盤' : `${esc(p.name)}の盤`}　<span class="bagline">袋 <b>${p.bag.length}</b>　捨て山 <b>${p.discard.length}</b>　置いた <b>${p.placed.length}</b></span></div>
      ${boardHTML(p, mine)}
      ${st.phase === 'play' ? hereHTML(p) : ''}
    </section>
    <section class="right">
      <div class="panel ${mine ? 'mine' : ''}">${controlsHTML()}</div>
      ${human ? `<h3>あなたの袋 <small>${human.bag.length}枚（引く順番はわからない）</small></h3><div class="chips">${chipsHTML(human.bag)}</div>
        <h3>あなたの捨て山 <small>${human.discard.length}枚</small></h3><div class="chips">${chipsHTML(human.discard)}</div>
        ${human.perms.length ? `<h3>あなたのお気に入り</h3><div class="grid">${human.perms.map(k => infoHTML(k)).join('')}</div>` : ''}` : ''}
      ${!mine && st.phase === 'play' ? `<h3>${esc(p.name)}の袋 <small>${p.bag.length}枚</small></h3><div class="chips">${chipsHTML(p.bag)}</div>` : ''}
      <h3>市場</h3>
      <div class="market">${marketHTML(false)}</div>
      <h3>記録</h3>
      <ol class="log">${st.log.slice(-14).reverse().map(l => `<li>${esc(l)}</li>`).join('')}</ol>
      <details class="fold"><summary>ルールの要約と，この卓の設定</summary>
        <p class="muted">${RULE_OPTS.map(o => `${o.label}：${o.choices.find(c => c[0] === String(st.rules[o.key]))?.[1] ?? ''}`).join('<br>')}</p>${rulesHTML()}</details>
    </section>
  </main>`;
  app.querySelector<HTMLButtonElement>('#quit')!.onclick = () => { if (s?.phase === 'over' || confirm(net ? '部屋を出ますか？（あとで同じ URL から戻れます）' : 'ゲームをやめますか？')) { leaveOnline(); s = null; render(); } };
  app.querySelector<HTMLButtonElement>('#sound')!.onclick = () => { store.set('sound', soundOn() ? 'off' : 'on'); render(); };
  bindControls();
  if (!net && st.phase === 'play' && cur().isBot) {
    clearTimeout(timer);
    timer = window.setTimeout(botStep, st.turn === 'resolve' ? 900 : 550);
  }
}

function controlsHTML(): string {
  const st = s!;
  if (st.phase === 'over') {
    const host = !net || net.room?.isHost;
    return `<p class="big">${st.winners.length ? `${st.winners.map(i => esc(st.players[i].name)).join('・')}の${st.winners.length > 1 ? '共同勝利' : '勝利'}！` : '引き分け'}</p>
      <div class="finalall">${st.players.map((q, i) => `<div class="fin ${st.winners.includes(i) ? 'win' : ''}">
        <div class="fh"><span class="dot p${i}"></span><b>${esc(q.name)}</b>${st.winners.includes(i) ? ' 🏆' : ''}　排除${q.removed}枚・お気に入り${favCost(q)}</div>
        <div class="fl"><span class="muted">残り${ownedTiles(q).length}枚</span><div class="chips">${chipsHTML(ownedTiles(q))}</div></div>
        <div class="fl"><span class="muted">排除${(q.gone ?? []).length}枚</span><div class="chips">${chipsHTML(q.gone ?? [])}</div></div>
        ${q.perms.length ? `<div class="fl"><span class="muted">お気に入り</span><div class="chips">${q.perms.map(k => tileHTML(k, { cls: 'chip' })).join('')}</div></div>` : ''}</div>`).join('')}</div>
      ${host ? `<button id="again" class="primary">もう一度（同じルール）</button> <button id="tolobby">ルールを変える</button>` : '<p class="muted">ホストが再戦を選べます</p>'}`;
  }
  const p = cur();
  if (st.current !== me) return `<p class="wait">${esc(p.name)}が${st.turn === 'resolve' ? '止まりました' : '引いています'}…</p>`;
  const here = hereFx(st, p);
  const env = envOf(st, p);
  switch (st.turn) {
    case 'move': {
      const can = canDraw(p, st.rules);
      const must = !p.placed.length && can;
      return `<p>${must ? '少なくとも1枚引きます' : `引くと今いるマスにタイルを置いて出ます．止めると<b>${fxWord(here)}</b>`}</p>
        <div class="btns"><button id="draw" class="primary big" ${can ? '' : 'disabled'}>タイルを引く<small>袋 ${p.bag.length}${p.bag.length ? '' : can ? '（捨て山を戻す）' : ''}</small></button></div>
        <div class="stopzone"><span class="muted">引かずに手番を切り上げる場合：</span><button id="stop" class="big stopbtn" ${must ? 'disabled' : ''}>ここで止める<small>${fxWord(here)}</small></button></div>`;
    }
    case 'branch': {
      const tile = p.placed[p.placed.length - 1];
      return `<p><b>${TILES[tile.kind].name}</b>を置きました．どちらへ出ますか（盤の光っているマスでも選べます）</p>
        ${dpadHTML(dirsOf(tile.kind, env), d => canMove(env, p.pos, d) ? fxWord(hereFxAt(p, step(p.pos, d))) : '出られない（ここに残る）')}`;
    }
    case 'resolve': {
      if (st.rules.lastCard && isLastCard(p)) {
        return `<p>最後の1枚です．どこで止まっても手放せます</p><div class="chips">${tileHTML(p.placed[0].kind)}</div>
          <div class="btns"><button id="lastdrop" class="primary big">手放す</button> <button id="resolve">手放さない</button></div>`;
      }
      const rb = p.perms.includes('ROOMBA') && p.placed.length
        ? `<p>★ルンバ：置いたタイルから1枚排除できる（条件・重さなし）</p><div class="chips pickable">${p.placed.filter(c => !sel.remove.has(c.id)).map(c => tileHTML(c.kind, { attr: `data-rb="${c.id}"`, cls: sel.roomba === c.id ? 'on' : '' })).join('')}</div>` : '';
      if (here.kind === 'buy') {
        const total = sel.buy.reduce((n, k) => n + (TILES[k].cost ?? 0), 0);
        return `<p><b class="cb">額 ${here.amount}</b>：取得するタイルを選んでください　<span class="meter ${total > here.amount ? 'over' : ''}">使用 ${total} / ${here.amount}</span></p>
          <div class="market buying">${marketHTML(true, p.pos.x, here.amount - total)}</div>${rb}
          <button id="resolve" class="primary big" ${total > here.amount ? 'disabled' : ''}>${sel.buy.length ? '取得して手番を終える' : '何も取らずに手番を終える'}</button>`;
      }
      if (here.kind === 'remove') {
        const flowSel = p.placed.filter(c => sel.remove.has(c.id));
        const big = p.perms.includes('BIGDAY');
        const load = big ? 0 : removeLoad(flowSel, st.rules);
        const dn = discardLimit(p, here.amount, isDeep(p.pos.y, st.board));
        const discSel = p.discard.filter(c => sel.remove.has(c.id));
        const have = st.rules.chips ? p.chips ?? 0 : 0;
        const need = chipNeed(flowSel, discSel, p.pos.x, here.amount, st.rules, big);
        const chipLine = st.rules.chips ? `<p class="chipline">決心チップ <b>${'◆'.repeat(have) || 'なし'}</b>${have ? `　1枚で「重さ1の肩代わり」か「理性の条件1段階の免除」．<span class="meter ${need > have ? 'over' : ''}">使用 ${need} / ${have}</span>` : '（1枚も排除できなかった手番の終わりに1枚もらえます）'}</p>` : '';
        const pick = (c: Tile) => (canDropAt(c.kind, p.pos.x, st.rules) || have > 0) && sel.roomba !== c.id
          ? tileHTML(c.kind, { attr: `data-rm="${c.id}"`, cls: sel.remove.has(c.id) ? 'on' : '' }) : tileHTML(c.kind, { cls: 'no' });
        return `${p.roll != null ? `<p><b class="cg">運試し</b>：袋に当たりチップを混ぜて，当たりが出るまでに <b>${p.roll}</b> 枚を表にした → <b class="cr">量 ${p.roll}</b></p><div class="chips rolled">${(p.rollKinds ?? []).map(k => tileHTML(k, { cls: 'chip' })).join('')}<span class="hit">当たり</span></div><p class="muted">表にしたタイルは排除の対象になりません（捨て山へ送りました）</p>` : ''}<p><b class="cr">量 ${here.amount}</b>：この手番に置いたタイルから排除するものを選んでください　<span class="meter ${load > here.amount ? 'over' : ''}">${big ? '★大掃除の日：何枚でも' : `重さ ${load} / ${here.amount}`}</span></p>
          ${chipLine}<div class="chips pickable">${p.placed.map(pick).join('')}</div>
          ${dn ? `<p>捨て山からも${dn}枚まで（重さなし）　<span class="meter ${discSel.length > dn ? 'over' : ''}">${discSel.length} / ${dn}</span></p><div class="chips pickable">${p.discard.filter(c => !p.rollIds?.includes(c.id)).map(pick).join('') || '<span class="muted">捨て山は空です</span>'}</div>` : ''}${rb}
          <button id="resolve" class="primary big" ${need > have || discSel.length > dn ? 'disabled' : ''}>${sel.remove.size ? `${sel.remove.size}枚排除${need ? `（決心チップ${need}枚）` : ''}して手番を終える` : '何も捨てずに手番を終える'}</button>`;
      }
      if (here.kind === 'gacha') {
        return `<p><b class="cg">福袋</b>：みんなで共有の福袋から，くじで1枚もらいます（捨て山へ）．残り ${st.gacha.length} 枚</p>
          <div class="chips">${chipsHTML(st.gacha.map(k => ({ id: 0, kind: k })))}</div>${rb}
          <button id="resolve" class="primary big" >${st.gacha.length ? '福袋を引いて手番を終える' : '手番を終える（福袋は空）'}</button>`;
      }
      return `<p>効果のないマスで止まりました</p>${rb}<button id="resolve" class="primary big">手番を終える</button>`;
    }
  }
}

/** まだ置いていない先のマスの効果（向きを選ぶときの目安） */
function hereFxAt(p: OPlayer, pos: Pos): Fx {
  return hereFx(s!, { ...p, pos });
}

function act(a: OAction) {
  if (net) {
    send({ t: 'action', action: a });
    if (a.type === 'resolve') clearSel();
    return;
  }
  try {
    applyOverlay(s!, me, a);
    if (a.type === 'resolve') clearSel();
  } catch (e) { alert((e as Error).message); }
  render();
}

function bindControls() {
  const q = <T extends HTMLElement>(x: string) => app.querySelector<T>(x);
  q('#again')?.addEventListener('click', () => {
    if (net) return send({ t: 'restart' });
    s = newOverlayGame(localSetup(s!.players[0].name), randomSeed(), local ?? {});
    clearSel();
    render();
  });
  q('#tolobby')?.addEventListener('click', () => {
    if (net) return send({ t: 'toLobby' });
    s = null;
    render();
  });
  q('#draw')?.addEventListener('click', () => act({ type: 'draw' }));
  q('#stop')?.addEventListener('click', () => act({ type: 'stop' }));
  app.querySelectorAll<HTMLElement>('[data-dir]').forEach(b => b.onclick = () => act({ type: 'branch', dir: b.dataset.dir as Dir }));
  app.querySelectorAll<HTMLButtonElement>('[data-add]').forEach(b => b.onclick = () => { sel.buy.push(b.dataset.add as OKind); render(); });
  app.querySelectorAll<HTMLButtonElement>('[data-sub]').forEach(b => b.onclick = () => {
    const i = sel.buy.lastIndexOf(b.dataset.sub as OKind);
    if (i >= 0) sel.buy.splice(i, 1);
    render();
  });
  app.querySelectorAll<HTMLElement>('[data-rb]').forEach(el => el.onclick = () => {
    const id = +el.dataset.rb!;
    sel.roomba = sel.roomba === id ? null : id;
    render();
  });
  app.querySelectorAll<HTMLElement>('[data-rm]').forEach(el => el.onclick = () => {
    const id = +el.dataset.rm!;
    if (sel.remove.has(id)) sel.remove.delete(id); else sel.remove.add(id);
    render();
  });
  q('#lastdrop')?.addEventListener('click', () => act({ type: 'resolve', buy: [], remove: [cur().placed[0].id] }));
  q('#resolve')?.addEventListener('click', () => act({ type: 'resolve', buy: [...sel.buy], remove: [...sel.remove], ...(sel.roomba !== null ? { roomba: sel.roomba } : {}) }));
}

function botStep() {
  if (!s || s.phase !== 'play' || !cur().isBot) return;
  applyOverlay(s, s.current, chooseOverlayAction(s, OPRESETS[cur().botType ?? 'light'] ?? OPRESETS.light));
  render();
}

// ---- 自分の番の合図（画面の帯・タブの題名・大きな表示・音・振動） ----

const soundOn = () => store.get('sound') !== 'off';
let wasMine = false;
let actx: AudioContext | null = null;

function notifyTurn(mine: boolean) {
  document.title = mine ? '▶ あなたの番です — ミニマリスト' : s?.phase === 'over' ? 'ゲーム終了 — ミニマリスト' : 'ミニマリスト オーバーレイ版';
  document.body.classList.toggle('myturn', mine);
  if (mine && !wasMine) {
    const el = document.createElement('div');
    el.className = 'splash';
    el.textContent = 'あなたの番';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
    try { navigator.vibrate?.(120); } catch { /* 対応していない端末 */ }
    if (soundOn()) {
      try {
        actx ??= new AudioContext();
        const t0 = actx.currentTime;
        [660, 880].forEach((f, i) => {
          const o = actx!.createOscillator(), g = actx!.createGain();
          o.frequency.value = f; o.type = 'sine';
          g.gain.setValueAtTime(0.0001, t0 + i * 0.13);
          g.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.13 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.13 + 0.22);
          o.connect(g).connect(actx!.destination);
          o.start(t0 + i * 0.13); o.stop(t0 + i * 0.13 + 0.25);
        });
      } catch { /* 音が出せなくても遊べる */ }
    }
  }
  wasMine = mine;
}

// ?room=XXXX で開かれたら，そのまま部屋に入る（名前は待合室で決める）
const initialRoom = new URLSearchParams(location.search).get('room');
if (initialRoom) goOnline(initialRoom, store.get('name') ?? '');
else render();
