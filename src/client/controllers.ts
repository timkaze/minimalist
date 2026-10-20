// 画面からゲームを操作する窓口．オフライン（ブラウザ内でボットと対戦）とオンライン（サーバー経由）で同じ形にする

import { Action, GameState, GameView, PlayerSetup, RuleError, applyAction, newGame, viewFor } from '../engine/game';
import { randomSeed } from '../engine/rng';
import type { CardKind } from '../engine/cards';
import type { FloorSpec } from '../engine/floors';
import { playBotTurn } from '../bot/runner';
import { ClientMsg, RoomInfo, ServerMsg } from '../net/protocol';

export interface Controller {
  view: GameView | null;
  room: RoomInfo | null;
  act(a: Action): void;
  send?(m: ClientMsg): void;
  onChange(fn: () => void): void;
  onError(fn: (msg: string) => void): void;
  restart(): void;
  close(): void;
}

const BOT_DELAY_MS = 600;

export class LocalController implements Controller {
  view: GameView | null = null;
  room: RoomInfo | null = null;
  private state: GameState;
  private listeners: (() => void)[] = [];
  private errorListeners: ((m: string) => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private setup: PlayerSetup[], private floor?: string, private market?: CardKind[], private custom?: FloorSpec) {
    this.state = newGame(setup, randomSeed(), { floor, market, custom });
    this.refresh();
  }

  act(a: Action): void {
    try {
      applyAction(this.state, 0, a);
    } catch (e) {
      if (e instanceof RuleError) return this.errorListeners.forEach(f => f(e.message));
      throw e;
    }
    this.refresh();
  }

  restart(): void {
    if (this.timer) clearTimeout(this.timer);
    this.state = newGame(this.setup, randomSeed(), { floor: this.floor, market: this.market, custom: this.custom });
    this.refresh();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  onChange(fn: () => void): void { this.listeners.push(fn); }
  onError(fn: (m: string) => void): void { this.errorListeners.push(fn); }

  private refresh(): void {
    this.view = viewFor(this.state, 0);
    this.listeners.forEach(f => f());
    this.scheduleBots();
  }

  private scheduleBots(): void {
    if (this.timer || this.state.phase !== 'play' || !this.state.players[this.state.current].isBot) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      playBotTurn(this.state);
      this.refresh();
    }, BOT_DELAY_MS);
  }
}

export class OnlineController implements Controller {
  view: GameView | null = null;
  room: RoomInfo | null = null;
  private ws: WebSocket | null = null;
  private listeners: (() => void)[] = [];
  private errorListeners: ((m: string) => void)[] = [];
  private closed = false;
  private retry = 0;

  constructor(private code: string, private name: string, private token: string) {
    this.connect();
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/room/${this.code}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.send({ t: 'join', name: this.name, token: this.token });
    };
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data) as ServerMsg;
      if (msg.t === 'error') return this.errorListeners.forEach(f => f(msg.message));
      this.room = msg.room;
      this.view = msg.view;
      this.listeners.forEach(f => f());
    };
    ws.onclose = () => {
      if (this.closed) return;
      // 自動で再接続（同じトークンなので同じ席に戻れる）
      this.errorListeners.forEach(f => f('接続が切れました．再接続しています…'));
      setTimeout(() => this.connect(), Math.min(10000, 1000 * 2 ** this.retry++));
    };
  }

  send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  act(a: Action): void { this.send({ t: 'action', action: a }); }
  restart(): void { this.send({ t: 'restart' }); }
  close(): void { this.closed = true; this.ws?.close(); }
  onChange(fn: () => void): void { this.listeners.push(fn); }
  onError(fn: (m: string) => void): void { this.errorListeners.push(fn); }
}
