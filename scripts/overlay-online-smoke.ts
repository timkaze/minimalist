// オーバーレイ版のオンライン対戦の通し確認：npx tsx scripts/overlay-online-smoke.ts [http://localhost:8799]
// 2人（中身はボットの判断）＋ボット1人で部屋を作り，カードセットを選んで最後まで遊ぶ
import { OPRESETS, chooseOverlayAction } from '../src/overlay/bot';
import type { OServerMsg } from '../src/overlay/protocol';
import type { OState } from '../src/overlay/engine';

const base = (process.argv[2] ?? 'http://localhost:8799').replace(/^http/, 'ws');
const code = 'T' + Math.random().toString(36).slice(2, 7).toUpperCase();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function client(name: string, token: string) {
  const ws = new WebSocket(`${base}/api/overlay/${code}/ws`);
  const c = { ws, last: null as Extract<OServerMsg, { t: 'room' }> | null, errors: [] as string[], deckHidden: true };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, token }));
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data)) as OServerMsg;
    if (m.t === 'error') c.errors.push(m.message); else {
      c.last = m;
      if (m.state && (m.state.rng !== 0 || m.state.players.some(p => p.bag.some(x => x.id !== 0)))) c.deckHidden = false;
    }
  };
  return c;
}

const a = client('A', 'tok-a-' + code);
await sleep(600);
const b = client('B', 'tok-b-' + code);
await sleep(600);
a.ws.send(JSON.stringify({ t: 'addBot', botType: 'rest' }));
await sleep(300);
a.ws.send(JSON.stringify({ t: 'addBot', botType: 'search' })); // 探索ボット（つよいAI）も部屋で動くこと
await sleep(300);
b.ws.send(JSON.stringify({ t: 'start', set: 'intro' })); // ホストでないので拒否される
await sleep(300);
a.ws.send(JSON.stringify({ t: 'start', set: 'intro', rules: { hes: 'second' } }));
await sleep(500);
console.log('席', a.last?.room.seats.map(x => x.name), 'B の拒否', b.errors);
console.log('ルール', a.last!.state!.rules.hes, '市場', Object.keys(a.last!.state!.market).join(','));
let moves = 0;
for (let i = 0; i < 6000; i++) {
  const st: OState | null = a.last?.state ?? null;
  if (!st || st.phase === 'over') break;
  const who = [a, b].find(c => c.last?.room.you === st.current);
  if (who && who.last?.state && who.last.state.current === st.current) {
    // 自分の手番：見えている状態（山札は種類順）でボットの判断を借りる
    const before = JSON.stringify(st.log.length) + st.turn + st.players[st.current].placed.length;
    who.ws.send(JSON.stringify({ t: 'action', action: chooseOverlayAction(st, OPRESETS.light) }));
    moves++;
    for (let k = 0; k < 50; k++) { await sleep(20); const n = a.last!.state!; if (JSON.stringify(n.log.length) + n.turn + n.players[n.current].placed.length !== before || n.phase === 'over') break; }
  } else await sleep(100);
}
const st = a.last!.state!;
console.log('終了', st.phase, 'ラウンド', st.round, '勝者', st.winners.map(i => st.players[i].name), '人の操作', moves);
console.log('山札の順番と乱数は隠れている', a.deckHidden && b.deckHidden, 'エラー', [...a.errors, ...b.errors].filter(x => !x.includes('ホスト')));
a.ws.close(); b.ws.close();
process.exit(0);
