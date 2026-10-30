// スライド版の印刷データ（すべてA4）．カード・盤の数値はゲーム本体（cards.ts・engine.ts）から作るので，ルールを変えても印刷物とずれない
//   URL で指定できる：print.html?players=4&board=basic|slow|both&rules=1

import './print.css';
import { ARROW, LIGHT_PER, MARKET, MEMO_AT, SCARDS, SKind, STARTING, UNLIMITED_KINDS } from './cards';
import {
  BLOCKS, FINISH_FAVS, SBOARDS, SBoard, X_MAX, X_MIN, bonus, canAdjust, canPeek, isDeep, overshoot, rowEffect, yMax, yMin,
} from './engine';
import { INK, colColor, colInk, needBadges, rowColor } from './colors';

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const opt = {
  players: Math.min(6, Math.max(2, Number(params.get('players') ?? 4))),
  board: params.get('board') ?? 'basic',
  rules: params.get('rules') !== '0',
};
const PLAYER_COLORS = ['#d9534f', '#3b7dd8', '#3a9b5c', '#e0a020', '#8e5cc4', '#555555'];

// ---- カード ----

/** 動きの大きな表示 */
function glyph(k: SKind): string {
  const m = SCARDS[k].move;
  switch (m.t) {
    case 'step': return m.dirs.length === 4 ? '↑↓←→ 1' : m.dirs.map(d => `${ARROW[d]}${m.n}`).join(' / ') + (m.light ? '<small>＋身軽</small>' : '') + (m.stop ? '<small>で止まる</small>' : '');
    case 'slide': return `${ARROW[m.dir]}<small>ぶつかるまで滑る</small>`;
    case 'stopper': return '■<small>積み木を置く</small>';
    case 'none': return '—';
    case 'swing': return '↓2 / ↑1';
    case 'memo': return `↑1 → ↓3`;
    case 'path': return m.dirs.map(d => ARROW[d]).join('');
  }
}

function cardHTML(k: SKind, tag: string): string {
  const d = SCARDS[k];
  const start = d.cost === null;
  return `<div class="pcard ${start ? 'start' : ''} ${d.favorite ? 'fav' : ''}">
    ${d.rotatable ? `<div class="flip">★回すとお気に入り：好きな向きに1・排除できない</div>` : ''}
    <div class="ph"><b>${d.favorite ? '★' : ''}${d.name}</b>${start ? '<span class="tag">初期</span>' : `<span class="cost">${d.cost}</span>`}</div>
    <div class="pg">${glyph(k)}</div>
    <div class="pt">${d.text}</div>
    <div class="pn">${needBadges(k)}</div>
    <div class="pf"><span>${tag}</span><span class="w" style="color:${INK.drop}">重さ${d.weight}</span></div>
  </div>`;
}

function cardPages(): string {
  const n = opt.players;
  const list: [SKind, string][] = [];
  for (let p = 0; p < n; p++) for (const [k, c] of STARTING) for (let i = 0; i < c; i++) list.push([k, `初期デッキ`]);
  for (const k of MARKET) {
    const count = UNLIMITED_KINDS.includes(k) ? Math.max(8, 3 * n) : Math.max(2, n);
    for (let i = 0; i < count; i++) list.push([k, UNLIMITED_KINDS.includes(k) ? '市場（基本）' : '市場']);
  }
  const per = 18;
  const pages: string[] = [];
  for (let i = 0; i < list.length; i += per) {
    pages.push(`<section class="page"><h2>カード ${i / per + 1}/${Math.ceil(list.length / per)}<small>（${n}人用．63×44mm．線で切る）</small></h2>
      <div class="cards">${list.slice(i, i + per).map(([k, t]) => cardHTML(k, t)).join('')}</div></section>`);
  }
  return pages.join('');
}

// ---- 盤 ----

function colHead(x: number): string {
  const name = x < 0 ? `理性${-x}` : x > 0 ? `衝動${x}` : '中';
  const fx: string[] = [];
  if (x > 0) fx.push(`額+${bonus(x, 'buy')}`, overshoot(x) === Infinity ? '止めると滑る' : `止めると${overshoot(x)}マス余分`);
  if (x < 0) fx.push(`量+${bonus(x, 'remove')}`);
  if (canAdjust(x)) fx.push('止めた後1マス動ける');
  if (canPeek(x)) fx.push('次の1枚を見られる');
  return `<div class="bch" style="background:${colColor(x) ?? '#fff'};color:${colInk(x)}"><b>${name}</b><small>${fx.join('<br>')}</small></div>`;
}

function boardPage(b: SBoard): string {
  const rows = yMax(b) - yMin(b) + 1;
  const cell = Math.min(23, Math.floor((262 - 22) / rows));
  let g = `<div class="pboard" style="grid-template-columns: 22mm repeat(7, ${cell}mm); grid-template-rows: 22mm repeat(${rows}, ${cell}mm)"><div></div>`;
  for (let x = X_MIN; x <= X_MAX; x++) g += colHead(x);
  for (let y = yMax(b); y >= yMin(b); y--) {
    const e = rowEffect(y, b);
    const label = e.kind === 'buy' ? `<b style="color:${INK.buy}">物欲</b><span>額${e.amount}</span>`
      : e.kind === 'remove' ? `<b style="color:${INK.drop}">捨欲</b><span>量${e.amount}</span>${isDeep(y, b) ? '<small>＋捨札から1枚</small>' : ''}`
        : '<b>スタート</b>';
    g += `<div class="brh" style="background:${rowColor(e.kind, e.amount)}">${label}</div>`;
    for (let x = X_MIN; x <= X_MAX; x++) {
      const rc = rowColor(e.kind, e.amount), cc = colColor(x) ?? rc;
      const start = x === 0 && y === 0;
      g += `<div class="bc" style="background:linear-gradient(to top, ${cc} 0 30%, ${rc} 30%)">${start ? '<span class="st">START</span>' : ''}${e.kind !== 'none' ? `<span class="amt">${e.kind === 'buy' ? '額' : '量'}${e.amount + bonus(x, e.kind)}</span>` : ''}</div>`;
    }
  }
  g += `</div>`;
  return `<section class="page"><h2>個人ボード：${b.label}</h2>${g}
    <p class="note">マスの右下の数字＝そのマスで止まったときの額・量（列の上乗せ込み）．上の色＝物欲（青）・捨欲（赤），下の帯＝理性（緑）・衝動（オレンジ），どちらも濃いほど強い．
    コマは毎手番 START から．積み木（片付けた跡）は1人${BLOCKS}個まで．</p></section>`;
}

// ---- コマと積み木 ----

function tokenPage(): string {
  let h = '';
  for (let p = 0; p < opt.players; p++) {
    const c = PLAYER_COLORS[p];
    h += `<div class="tokrow"><span class="tl">プレイヤー${p + 1}</span><span class="pawn" style="background:${c}"></span>`;
    for (let i = 0; i < BLOCKS + 1; i++) h += `<span class="blk" style="background:${c}"></span>`;
    h += `</div>`;
  }
  return `<section class="page"><h2>コマと積み木<small>（切って使う．厚紙に貼るか，手持ちのコマ・おはじきで代用してよい）</small></h2>${h}
    <p class="note">丸＝コマ（1人1個），四角＝積み木（1人${BLOCKS}個＋予備1）．</p></section>`;
}

// ---- ルール ----

function rulesPages(): string {
  const cardRows = (Object.keys(SCARDS) as SKind[]).map(k => {
    const d = SCARDS[k];
    return `<tr><td>${d.favorite ? '★' : ''}${d.name}</td><td>${d.text}</td><td>${d.cost ?? '初期'}</td><td>${d.weight}</td><td>${needBadges(k)}</td></tr>`;
  }).join('');
  return `<section class="page rules">
    <h1>ミニマリスト <small>スライド版（試作 v0.3）</small></h1>
    <p class="lead">手札はありません．山札の上をめくるたびに，欲に流されてコマが動きます．好きなところで止めて，
      <b style="color:${INK.buy}">物欲</b>の行ならカードを取得，<b style="color:${INK.drop}">捨欲</b>の行なら今日めくったカードを排除．
      デッキを0枚にするか，お気に入りだけ${FINISH_FAVS}枚以下にしたら達成です．</p>
    <h3>内容物（このデータで印刷するもの）</h3>
    <ul><li>個人ボード（人数分），コマ1個・積み木${BLOCKS}個（1人分）</li>
      <li>初期デッキ 1人5枚（欲しい2・ためらい1・迷い1・ガラクタ1）</li>
      <li>市場：片付けたい（売り切れない．多めに），ほかは各種類 人数と同じ枚数（最低2枚）</li></ul>
    <h3>準備</h3>
    <ol><li>各自，個人ボードを置き，初期デッキ5枚を混ぜて山札にする．コマを START に置く</li>
      <li>市場のカードを種類ごとに表向きに並べる．最初の人を決める</li></ol>
    <h3>手番</h3>
    <ol><li>コマを START に置く．山札が空なら捨札を混ぜて山札にする</li>
      <li><b>めくる</b>か<b>止める</b>を繰り返す（<b>少なくとも1枚はめくる</b>）
        <ul><li>めくる：山札の上を1枚めくって「今日の流れ」（ボードの横に1列）に並べ，カードのとおりにコマを動かす．分かれ道は向きを選ぶ．
          山札が尽きたら捨札を混ぜて続けてよい</li>
          <li>ボードの端では止まる．<b>積み木のマスに入ると，そのカードの動きはそこで終わる</b>（次のカードで出られる）</li></ul></li>
      <li><b>止める</b>：<span style="background:${colColor(2)}">衝動</span>の列では，最後に動いた向きへ1・2マス余分に進んでから止まる（衝動3は端か積み木まで滑る）．
        <span style="background:${colColor(-2)}">理性</span>2以上の列では，止めた後に1マス動いてよい．理性3では次の1枚を見てから止めるか決められる</li>
      <li>止まったマスの効果（マスの右下の数字）
        <ul><li><b style="color:${INK.buy}">物欲</b>：その額までコストを払って市場からカードを取得し，捨札へ．今日の流れの愛用品を回して（上下逆さ）お気に入りにしてもよい</li>
          <li><b style="color:${INK.drop}">捨欲</b>：その量まで，<b>今日の流れ</b>のカードを重さを払って排除（箱へ）．一番下の行なら捨札からも1枚．
            排除したら，止まったマスに積み木を1個置く（${BLOCKS}個を超えたら一番古いものを動かす）</li></ul></li>
      <li>今日の流れのカードを捨札へ</li></ol>
    <h3>条件のあるカード（色の濃さ＝必要な段階）</h3>
    <ul><li><span class="badge" style="background:${colColor(2)};color:${INK.imp};border-color:${INK.imp}">衝動nで取得</span>：衝動n以上の列で止まらないと取得できない（高いもの・派手なものは衝動買い）</li>
      <li><span class="badge" style="background:${colColor(-2)};color:${INK.calm};border-color:${INK.calm}">理性nで排除</span>：理性n以上の列で止まらないと排除できない（思い入れのあるものは冷静に）</li>
      <li>お気に入り（★一生モノ・回した愛用品）は排除できない．動きは「好きな向きに1」</li>
      <li><b>最後の1枚</b>：持ち物が今日めくった1枚だけなら，どこで止まってもその1枚を手放せる</li></ul>
    <h3>終わり</h3>
    <p>手番の終わりに持ち物が0枚，またはお気に入りだけで${FINISH_FAVS}枚以下なら達成．誰かが達成したらそのラウンドの最後の人まで．
      達成者のうち排除した枚数が多い人の勝ち（同じならお気に入りのコスト合計が高い人，それも同じなら共同勝利）．</p>
  </section>
  <section class="page rules">
    <h2>カード一覧</h2>
    <p class="note">身軽：排除した枚数${LIGHT_PER}枚ごとに歩数+1．思い出の品は排除した枚数が${MEMO_AT}枚になると動きが変わる．</p>
    <table class="clist"><tr><th>カード</th><th>動き・効果</th><th>取得</th><th>重さ</th><th>条件</th></tr>${cardRows}</table>
  </section>`;
}

function render() {
  const boards = opt.board === 'both' ? [SBOARDS.basic, SBOARDS.slow] : [SBOARDS[opt.board] ?? SBOARDS.basic];
  const boardPages = boards.flatMap(b => Array.from({ length: opt.players }, () => boardPage(b))).join('');
  app.innerHTML = `<div class="controls">
      <label>人数 <select id="players">${[2, 3, 4, 5, 6].map(n => `<option ${n === opt.players ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>盤 <select id="board">${[['basic', '基本'], ['slow', 'ゆっくり'], ['both', '両方']].map(([v, l]) => `<option value="${v}" ${v === opt.board ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label><input type="checkbox" id="rules" ${opt.rules ? 'checked' : ''}>ルール・カード一覧</label>
      <button onclick="window.print()">印刷（A4・余白なし・背景を印刷）</button>
      <span class="note">印刷の設定で「背景のグラフィック」をオンにしてください</span>
    </div>
    ${opt.rules ? rulesPages() : ''}${boardPages}${cardPages()}${tokenPage()}`;
  for (const id of ['players', 'board', 'rules']) {
    app.querySelector<HTMLInputElement>(`#${id}`)!.onchange = () => {
      const q = new URLSearchParams({
        players: app.querySelector<HTMLSelectElement>('#players')!.value,
        board: app.querySelector<HTMLSelectElement>('#board')!.value,
        rules: app.querySelector<HTMLInputElement>('#rules')!.checked ? '1' : '0',
      });
      location.search = q.toString();
    };
  }
}

render();
