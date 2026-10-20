// 1部屋 = 1つの Durable Object．ゲームの正しい状態はここだけが持ち，各プレイヤーには見てよい情報だけを送る．
// WebSocket Hibernation API を使うので，誰も操作していない間は課金対象の実行時間がほぼ発生しない．

import { DurableObject } from 'cloudflare:workers';
import { GameState, RuleError, applyAction, newGame, viewFor } from '../src/engine/game';
import { randomSeed } from '../src/engine/rng';
import { FLOORS, FloorSpec, floorFromSpec } from '../src/engine/floors';
import { CardKind, marketFromPick } from '../src/engine/cards';
import { BOT_LABELS } from '../src/bot/bot';
import { playBotTurn } from '../src/bot/runner';
import { ClientMsg, MAX_SEATS, RoomInfo, ServerMsg } from '../src/net/protocol';
import type { Env } from './index';

interface Seat { name: string; token?: string; isBot: boolean; botType?: string }
interface RoomData { code: string; hostToken?: string; seats: Seat[]; game: GameState | null; floor?: string; market?: CardKind[]; custom?: FloorSpec }
interface Attachment { token: string }

const BOT_DELAY_MS = 700;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Room extends DurableObject<Env> {
  private data: RoomData | null = null;
  private runningBots = false;

  private async load(): Promise<RoomData> {
    if (!this.data) {
      this.data = (await this.ctx.storage.get<RoomData>('room')) ?? { code: '', seats: [], game: null };
    }
    return this.data;
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put('room', this.data);
  }

  async fetch(request: Request): Promise<Response> {
    const data = await this.load();
    if (!data.code) {
      data.code = new URL(request.url).pathname.split('/')[3].toUpperCase();
      await this.save();
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const data = await this.load();
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, { t: 'error', message: '不正なメッセージ' });
    }
    const token = (ws.deserializeAttachment() as Attachment | null)?.token;
    const seat = token ? data.seats.findIndex(s => s.token === token) : -1;
    const isHost = !!token && token === data.hostToken;

    try {
      switch (msg.t) {
        case 'join': {
          if (!msg.token || msg.token.length > 64) throw new RuleError('不正なトークン');
          ws.serializeAttachment({ token: msg.token } satisfies Attachment);
          const name = (msg.name || 'プレイヤー').slice(0, 16);
          const existing = data.seats.find(s => s.token === msg.token);
          if (existing) {
            existing.name = name;
            if (data.game) {
              const i = data.seats.indexOf(existing);
              data.game.players[i].name = name;
            }
          } else if (!data.game && data.seats.length < MAX_SEATS) {
            data.seats.push({ name, token: msg.token, isBot: false });
          }
          // 以上に当てはまらない人（満席・開始後に来た人）は観戦者
          if (!data.hostToken) data.hostToken = msg.token;
          break;
        }
        case 'addBot': {
          if (!isHost) throw new RuleError('ボットを追加できるのはホストだけです');
          if (data.game) throw new RuleError('ゲーム中は変更できません');
          if (data.seats.length >= MAX_SEATS) throw new RuleError('満席です');
          const botType = BOT_LABELS[msg.botType] ? msg.botType : 'random';
          const n = data.seats.filter(s => s.isBot).length + 1;
          data.seats.push({ name: `ボット${n}（${BOT_LABELS[botType]}）`, isBot: true, botType });
          break;
        }
        case 'removeSeat': {
          if (!isHost) throw new RuleError('席を外せるのはホストだけです');
          if (data.game) throw new RuleError('ゲーム中は変更できません');
          const s = data.seats[msg.seat];
          if (!s || s.token === data.hostToken) throw new RuleError('その席は外せません');
          data.seats.splice(msg.seat, 1);
          break;
        }
        case 'start':
        case 'restart': {
          if (!isHost) throw new RuleError('開始できるのはホストだけです');
          if (msg.t === 'start' && data.game) throw new RuleError('すでに始まっています');
          if (data.seats.length < 2) throw new RuleError('2人以上（ボット含む）必要です');
          if (msg.t === 'start' && msg.floor && FLOORS[msg.floor]) data.floor = msg.floor;
          if (msg.t === 'start') {
            if (msg.custom) {
              try { floorFromSpec(msg.custom); } catch (e) { throw new RuleError((e as Error).message); }
            }
            data.custom = msg.custom;
          }
          if (msg.t === 'start' && msg.market) {
            try { data.market = marketFromPick(msg.market); } catch (e) { throw new RuleError((e as Error).message); }
          }
          data.game = newGame(data.seats.map(s => ({ name: s.name, isBot: s.isBot, botType: s.botType })), randomSeed(), { floor: data.floor, market: data.market, custom: data.custom });
          break;
        }
        case 'action': {
          if (!data.game) throw new RuleError('ゲームが始まっていません');
          if (seat < 0) throw new RuleError('観戦中です');
          applyAction(data.game, seat, msg.action);
          break;
        }
        default:
          throw new RuleError('不明なメッセージ');
      }
    } catch (e) {
      if (e instanceof RuleError) return this.send(ws, { t: 'error', message: e.message });
      throw e;
    }
    await this.save();
    this.broadcast();
    void this.runBots();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code, reason); } catch { /* すでに閉じている */ }
    await this.load();
    this.broadcast(ws);
  }

  /** ボットの手番を少しずつ進めて，そのたびに全員へ送る */
  private async runBots(): Promise<void> {
    if (this.runningBots) return;
    this.runningBots = true;
    try {
      const data = await this.load();
      while (data.game && data.game.phase === 'play' && data.game.players[data.game.current].isBot) {
        await sleep(BOT_DELAY_MS);
        playBotTurn(data.game);
        await this.save();
        this.broadcast();
      }
    } finally {
      this.runningBots = false;
    }
  }

  private connectedTokens(closing?: WebSocket): Set<string> {
    const set = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.token) set.add(a.token);
    }
    return set;
  }

  /** closing：いま切断処理中の接続（接続中として数えない） */
  private broadcast(closing?: WebSocket): void {
    const data = this.data;
    if (!data) return;
    const connected = this.connectedTokens(closing);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      const token = (ws.deserializeAttachment() as Attachment | null)?.token;
      if (!token) continue;
      const you = data.seats.findIndex(s => s.token === token);
      const room: RoomInfo = {
        code: data.code,
        you,
        isHost: token === data.hostToken,
        started: !!data.game,
        seats: data.seats.map(s => ({
          name: s.name, isBot: s.isBot, botType: s.botType,
          connected: s.isBot || (!!s.token && connected.has(s.token)),
        })),
      };
      // 観戦者（you = -1）にはだれの手札も含めない
      const view = data.game ? viewFor(data.game, you) : null;
      this.send(ws, { t: 'room', room, view });
    }
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // 切断済み
    }
  }
}
