// オーバーレイ版の部屋．1部屋 = 1つの Durable Object．ゲームの正しい状態はここだけが持つ．
// 各プレイヤーには山札の順番と乱数の種を隠した状態を送る（山札の中身は自分で数えられるので種類順で送る）

import { DurableObject } from 'cloudflare:workers';
import { randomSeed } from '../src/engine/rng';
import { marketFromChoice } from '../src/overlay/tiles';
import { ORuleError as SRuleError, OState as SState, Rules, applyOverlay, newOverlayGame, normRules } from '../src/overlay/engine';
import { OBOT_LABELS as SBOT_LABELS, OPRESETS as SPRESETS, RANDOM_BOT, chooseOverlayAction, resolveBot } from '../src/overlay/bot';
import { OClientMsg as SClientMsg, OMAX_SEATS as SMAX_SEATS, ORoomInfo as SRoomInfo, OServerMsg as SServerMsg } from '../src/overlay/protocol';
import type { OKind as SKind } from '../src/overlay/tiles';
import type { Env } from './index';

interface Seat { name: string; token?: string; isBot: boolean; botType?: string }
interface RoomData { code: string; hostToken?: string; seats: Seat[]; game: SState | null; rules?: Rules; set?: string; tiles?: SKind[] }
interface Attachment { token: string }

const BOT_DELAY_MS = 450;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 見せてよい状態：山札は種類順（順番を隠す），乱数の種は0 */
export function publicState(s: SState): SState {
  const v: SState = structuredClone(s);
  v.rng = 0;
  for (const p of v.players) p.bag = p.bag.map(c => ({ ...c, id: 0 })).sort((a, b) => a.kind.localeCompare(b.kind));
  return v;
}

export class OverlayRoom extends DurableObject<Env> {
  private data: RoomData | null = null;
  private runningBots = false;

  private async load(): Promise<RoomData> {
    if (!this.data) this.data = (await this.ctx.storage.get<RoomData>('room')) ?? { code: '', seats: [], game: null };
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
    let msg: SClientMsg;
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
          if (!msg.token || msg.token.length > 64) throw new SRuleError('不正なトークン');
          ws.serializeAttachment({ token: msg.token } satisfies Attachment);
          const existing = data.seats.find(s => s.token === msg.token);
          const name = uniqueName(data.seats, msg.name, existing);
          if (existing) {
            existing.name = name;
            if (data.game) data.game.players[data.seats.indexOf(existing)].name = name;
          } else if (!data.game && data.seats.length < SMAX_SEATS) {
            data.seats.push({ name, token: msg.token, isBot: false });
          }
          // 満席・開始後に来た人は観戦者
          if (!data.hostToken) data.hostToken = msg.token;
          break;
        }
        case 'rename': {
          if (seat < 0) throw new SRuleError('席がないので名前は変えられません');
          const name = uniqueName(data.seats, msg.name, data.seats[seat]);
          data.seats[seat].name = name;
          if (data.game) data.game.players[seat].name = name;
          break;
        }
        case 'addBot': {
          if (!isHost) throw new SRuleError('ボットを追加できるのはホストだけです');
          if (data.game) throw new SRuleError('ゲーム中は変更できません');
          if (data.seats.length >= SMAX_SEATS) throw new SRuleError('満席です');
          const botType = msg.botType === RANDOM_BOT || SPRESETS[msg.botType] ? msg.botType : RANDOM_BOT;
          data.seats.push({ name: `ボット（${SBOT_LABELS[botType]}）`, isBot: true, botType });
          break;
        }
        case 'removeSeat': {
          if (!isHost) throw new SRuleError('席を外せるのはホストだけです');
          if (data.game) throw new SRuleError('ゲーム中は変更できません');
          const s = data.seats[msg.seat];
          if (!s || s.token === data.hostToken) throw new SRuleError('その席は外せません');
          data.seats.splice(msg.seat, 1);
          break;
        }
        case 'start':
        case 'restart': {
          if (!isHost) throw new SRuleError('開始できるのはホストだけです');
          if (msg.t === 'start' && data.game) throw new SRuleError('すでに始まっています');
          if (data.seats.length < 2) throw new SRuleError('2人以上（ボット含む）必要です');
          if (msg.t === 'start') {
            data.rules = normRules(msg.rules);
            data.set = msg.set ?? 'all';
            data.tiles = msg.set === 'custom' ? msg.tiles ?? [] : undefined;
          }
          let market: SKind[];
          try { market = marketFromChoice(data.set === 'custom' ? data.tiles ?? [] : data.set ?? 'all'); } catch (e) { throw new SRuleError((e as Error).message); }
          data.game = newOverlayGame(data.seats.map(s => ({ name: s.name, isBot: s.isBot, botType: s.isBot ? resolveBot(s.botType) : undefined })), randomSeed(), { rules: data.rules, market });
          break;
        }
        case 'toLobby': {
          if (!isHost) throw new SRuleError('待合室へ戻せるのはホストだけです');
          if (data.game && data.game.phase !== 'over') throw new SRuleError('ゲーム中は戻れません');
          data.game = null;
          break;
        }
        case 'action': {
          if (!data.game) throw new SRuleError('ゲームが始まっていません');
          if (seat < 0) throw new SRuleError('観戦中です');
          applyOverlay(data.game, seat, msg.action);
          break;
        }
        default:
          throw new SRuleError('不明なメッセージ');
      }
    } catch (e) {
      if (e instanceof SRuleError) return this.send(ws, { t: 'error', message: e.message });
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

  /** ボットの手番を1動作ずつ進め，そのたびに全員へ送る（めくるたびにコマが動くのが見える） */
  private async runBots(): Promise<void> {
    if (this.runningBots) return;
    this.runningBots = true;
    try {
      const data = await this.load();
      let guard = 0;
      while (data.game && data.game.phase === 'play' && data.game.players[data.game.current].isBot && guard++ < 2000) {
        await sleep(BOT_DELAY_MS);
        const g = data.game;
        const p = g.players[g.current];
        applyOverlay(g, g.current, chooseOverlayAction(g, SPRESETS[p.botType ?? 'light'] ?? SPRESETS.light));
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

  private broadcast(closing?: WebSocket): void {
    const data = this.data;
    if (!data) return;
    const connected = this.connectedTokens(closing);
    const state = data.game ? publicState(data.game) : null;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      const token = (ws.deserializeAttachment() as Attachment | null)?.token;
      if (!token) continue;
      const room: SRoomInfo = {
        code: data.code,
        you: data.seats.findIndex(s => s.token === token),
        isHost: token === data.hostToken,
        started: !!data.game,
        seats: data.seats.map(s => ({ name: s.name, isBot: s.isBot, botType: s.botType, connected: s.isBot || (!!s.token && connected.has(s.token)) })),
      };
      this.send(ws, { t: 'room', room, state });
    }
  }

  private send(ws: WebSocket, msg: SServerMsg): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* 切断済み */ }
  }
}

/** 名前を整える：空なら「プレイヤーn」，ほかの席と同じなら番号をつける */
function uniqueName(seats: Seat[], raw: unknown, self?: Seat): string {
  const base = (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim().slice(0, 12);
  const taken = new Set(seats.filter(s => s !== self).map(s => s.name));
  const custom = base && base !== 'プレイヤー';
  if (custom && !taken.has(base)) return base;
  const stem = custom ? base : 'プレイヤー';
  for (let i = custom ? 2 : 1; ; i++) if (!taken.has(`${stem}${i}`)) return `${stem}${i}`;
}
