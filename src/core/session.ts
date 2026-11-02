import { Chess, type Color, type Move } from 'chess.js';
import { gameEnd, type GameEnd, type SimpleMove } from '../lib/chess';

/**
 * The rules of one game: legal moves, how it ends, and its record. It depends on nothing but the chess library,
 * so that a future server can run this same code to check every move in online play.
 */
export class GameSession {
  private chess: Chess;
  private ended: { result: string; reason: string } | null = null;

  constructor(fen?: string) {
    this.chess = fen ? new Chess(fen) : new Chess();
  }

  fen = () => this.chess.fen();
  turn = (): Color => this.chess.turn();
  /** Throws if the move is illegal, or if the game is already over. */
  move(move: SimpleMove | string): Move {
    if (this.ended) throw new Error('The game is over.');
    return this.chess.move(move);
  }

  undo() {
    this.ended = null;
    return this.chess.undo();
  }

  history(): string[];
  history(options: { verbose: true }): Move[];
  history(options?: { verbose: true }) {
    return options ? this.chess.history(options) : this.chess.history();
  }

  /** How the game stands, by the rules on the board or by an earlier resignation or flag. */
  status(): GameEnd {
    if (this.ended) return { over: true, result: this.ended.result as '1-0' | '0-1' | '1/2-1/2', reason: this.ended.reason };
    return gameEnd(this.chess);
  }

  resign(color: Color) {
    this.ended = { result: color === 'w' ? '0-1' : '1-0', reason: 'resignation' };
  }

  /** Ends the game for an outcome decided off the board, such as running out of time. */
  conclude(result: string, reason: string) {
    this.ended = { result, reason };
  }

  /** The game in PGN, with these headers. */
  pgn(headers: Record<string, string>): string {
    for (const [key, value] of Object.entries(headers)) this.chess.setHeader(key, value);
    return this.chess.pgn();
  }

  /** The moves as one line of notation, for sending to the coach. */
  movetext(): string {
    return this.chess.pgn({ maxWidth: 0 }).split('\n').pop() ?? '';
  }
}
