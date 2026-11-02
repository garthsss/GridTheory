import { Chess, type Color } from 'chess.js';

/**
 * A chess clock as pure state: the caller supplies the time, so tests need no timers, and a future server
 * can run the same logic as the authority on who ran out of time.
 */
export class ChessClock {
  remaining: Record<Color, number>;
  active: Color | null = null;
  private since = 0;

  constructor(startMs: number, private incrementMs: number) {
    this.remaining = { w: startMs, b: startMs };
  }

  private settle(now: number) {
    if (this.active) {
      this.remaining[this.active] = Math.max(0, this.remaining[this.active] - (now - this.since));
      this.since = now;
    }
  }

  start(side: Color, now: number) {
    this.settle(now);
    this.active = side;
    this.since = now;
  }

  pause(now: number) {
    this.settle(now);
    this.active = null;
  }

  /** Adds the increment for a side that has just moved. */
  addIncrement(side: Color) {
    this.remaining[side] += this.incrementMs;
  }

  /** Time on both clocks right now, and which side has run out, if any. */
  read(now: number): { w: number; b: number; flagged: Color | null } {
    this.settle(now);
    const flagged = this.active && this.remaining[this.active] <= 0 ? this.active : null;
    return { w: this.remaining.w, b: this.remaining.b, flagged };
  }

  restore(state: { w: number; b: number }) {
    this.remaining = { w: state.w, b: state.b };
  }
}

/**
 * The result when a side runs out of time. It's only a loss if the opponent could still mate:
 * a lone king, or a king and one minor piece, draws.
 */
export function flagResult(fen: string, flagged: Color): '1-0' | '0-1' | '1/2-1/2' {
  const winner: Color = flagged === 'w' ? 'b' : 'w';
  const pieces = new Chess(fen, { skipValidation: true })
    .board()
    .flat()
    .filter((piece) => piece?.color === winner && piece.type !== 'k');
  const insufficient = pieces.length === 0 || (pieces.length === 1 && (pieces[0]!.type === 'n' || pieces[0]!.type === 'b'));
  if (insufficient) return '1/2-1/2';
  return winner === 'w' ? '1-0' : '0-1';
}

/** How long a bot may think when clocks are on: its normal time, or a safe share of what it has left. */
export function botThinkTime(normal: number, remaining: number, increment: number): number {
  const budget = remaining / 30 + increment * 800;
  return Math.max(30, Math.min(normal, Math.floor(budget)));
}
