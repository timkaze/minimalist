// オンライン対戦の動作確認：npx tsx scripts/online-smoke.ts [URL]
// 2人の人間（自動操作）＋ボット1体で部屋を作り，数ラウンド進めて，再接続も確かめる

import { computeReach, openCells } from '../src/engine/game';
import { removeCost } from '../src/engine/cards';
import type { ServerMsg, ClientMsg } from '../src/net/protocol';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/^http/, 'ws');
const CODE = 'T' + Math.random().toString(36).slice(2, 7).toUpperCase();

class Client {
  ws!: WebSocket;
  last: Extract<ServerMsg, { t: 'room' }> | null = null;
  errors: string[] = [];
  constructor(public name: string, public token: string) {}
  connect(): Promise<void> {
    return new Promise(res => {
      this.ws = new WebSocket(`${BASE}/api/room/${CODE}/ws`);
      this.ws.onopen = () => { this.send({ t: 'join', name: this.name, token: this.token }); res(); };
      this.ws.onmessage = ev => {
        const m = JSON.parse(String(ev.data)) as ServerMsg;
        if (m.t === 'error') this.errors.push(m.message); else this.last = m;
      };
    });
  }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  /** 自分の手番なら，置けるだけ置いて排除できるだけ排除して終える */
  playIfMyTurn(): boolean {
    const v = this.last?.view;
    if (!v || v.phase !== 'play' || v.current !== v.you) return false;
    const me = v.players[v.you];
    const open = openCells(me.board, v.floor, me.removed);
    if (me.hand!.length && open.length) {
      this.send({ t: 'action', action: { type: 'place', cardId: me.hand![0].id, pos: open[0] } });
    } else {
      const reach = computeReach(me.board, v.floor);
      // 排除力の範囲で選ぶ（粗大ごみは2つ分）
      let points = reach.corner ? 99 : reach.remove;
      const ids: number[] = [];
      for (const c of Object.values(me.board)) { // 場のカードだけ排除できる
        const cost = reach.corner ? 1 : removeCost(c.kind);
        if (cost <= points) { ids.push(c.id); points -= cost; }
      }
      this.send({ t: 'action', action: { type: 'endTurn', remove: ids, buy: [] } });
    }
    return true;
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const assert = (c: unknown, m: string) => { if (!c) { console.error('NG:', m); process.exit(1); } console.log('OK:', m); };

const a = new Client('Alice', 'tok-a-' + CODE);
const b = new Client('Bob', 'tok-b-' + CODE);
await a.connect(); await sleep(200);
await b.connect(); await sleep(300);
assert(a.last?.room.isHost && !b.last?.room.isHost, 'Aliceがホスト');
assert(a.last?.room.seats.length === 2, '2人が着席');
b.send({ t: 'addBot', botType: 'learned' }); await sleep(200);
assert(b.errors.length === 1, 'ホスト以外はボットを追加できない');
a.send({ t: 'addBot', botType: 'learned' }); await sleep(300);
a.send({ t: 'start', floor: 'grow', market: ['R+', 'D+', 'RD', 'P', 'RD2'] }); await sleep(300);
assert(a.errors.length === 1 && !a.last?.view, '市場のカードが6種類でなければ開始できない');
const pick = ['R+', 'D+', 'RD', 'BAG', 'ST', 'CUT'] as const;
a.send({ t: 'start', floor: 'grow', market: [...pick] }); await sleep(300);
assert(a.last?.view && b.last?.view && a.last.view.floor.name === 'grow', 'ゲーム開始（間取り：ワンルーム）');
assert(b.last!.view!.marketKinds.join() === ['R', 'D', ...pick].join(), '選んだ市場で始まる（基本カード＋6種類）');
assert(a.last!.view!.players[1].hand === undefined && b.last!.view!.players[1].hand !== undefined, '他人の手札は見えない');

let actions = 0;
for (let i = 0; i < 400 && (a.last!.view!.round < 4); i++) {
  if (a.playIfMyTurn() || b.playIfMyTurn()) actions++;
  await sleep(60);
}
assert(a.last!.view!.round >= 4, `4ラウンドまで進んだ（操作${actions}回）`);
assert(a.last!.view!.log.some(l => l.includes('ボット')), 'ボットも手番をこなした');

// 再接続：Bobが切断して同じトークンで戻ると同じ席
const seatBefore = b.last!.room.you;
b.ws.close(); await sleep(300);
assert(a.last!.room.seats[seatBefore].connected === false, '切断が表示される');
const b2 = new Client('Bob', b.token);
await b2.connect(); await sleep(400);
assert(b2.last?.room.you === seatBefore && b2.last.view?.players[seatBefore].hand, '再接続で同じ席・手札に戻れる');

// 観戦者
const c = new Client('Carol', 'tok-c-' + CODE);
await c.connect(); await sleep(300);
assert(c.last?.room.you === -1 && c.last.view && c.last.view.players.every(p => p.hand === undefined), '開始後に来た人は観戦（手札は見えない）');

console.log('すべてOK  部屋', CODE);
process.exit(0);
