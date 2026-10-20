// ブラウザ ⇔ サーバー（Durable Object）のメッセージ

import type { CardKind } from '../engine/cards';
import type { Action, GameView } from '../engine/game';
import type { FloorSpec } from '../engine/floors';

export interface SeatInfo { name: string; isBot: boolean; botType?: string; connected: boolean }

export interface RoomInfo {
  code: string;
  seats: SeatInfo[];
  /** 自分の席（観戦者は -1） */
  you: number;
  isHost: boolean;
  started: boolean;
}

export type ClientMsg =
  | { t: 'join'; name: string; token: string }
  | { t: 'addBot'; botType: string }
  | { t: 'removeSeat'; seat: number }
  | { t: 'start'; floor?: string; /** 市場に並べる候補（MARKET_PICK 種類） */ market?: CardKind[]; /** カスタムの間取り */ custom?: FloorSpec }
  | { t: 'restart' }
  | { t: 'action'; action: Action };

export type ServerMsg =
  | { t: 'room'; room: RoomInfo; view: GameView | null }
  | { t: 'error'; message: string };

export const MAX_SEATS = 6;
export const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;
