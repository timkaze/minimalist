// ボットだけで手番を進めるためのヘルパー（学習・テスト・サーバーで共有）

import { GameOptions, GameState, PlayerSetup, applyAction, newGame } from '../engine/game';
import { BotGenome, botAction, genomeFor } from './bot';

/** 現在の手番がボットなら，その手番を最後まで進める．進めたら true */
export function playBotTurn(state: GameState, genomes?: BotGenome[]): boolean {
  if (state.phase !== 'play') return false;
  const seat = state.current;
  const p = state.players[seat];
  if (!p.isBot) return false;
  const g = genomes?.[seat] ?? genomeFor(p.botType, Math.random, state.floor.name);
  for (let guard = 0; guard < 50; guard++) {
    const a = botAction(state, seat, g);
    applyAction(state, seat, a);
    if (a.type === 'endTurn') return true;
  }
  throw new Error('bot loop');
}

/** ボットだけで1ゲームを最後まで行う */
export function playBotGame(genomes: BotGenome[], seed: number, opts: GameOptions = {}): GameState {
  const setup: PlayerSetup[] = genomes.map((_, i) => ({ name: `P${i + 1}`, isBot: true }));
  const state = newGame(setup, seed, opts);
  while (state.phase === 'play') playBotTurn(state, genomes);
  return state;
}
