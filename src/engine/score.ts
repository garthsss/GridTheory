import type { Color } from 'chess.js';

/** An engine score from White's point of view. Exactly one of cp and mate is set. */
export interface Score {
  cp: number | null;
  mate: number | null;
}

export interface EngineLine {
  move: string;
  score: Score;
  pv: string[];
}

export interface Analysis {
  fen: string;
  depth: number;
  lines: EngineLine[];
  /** Set when the position is already over, so there is nothing for the engine to search. */
  terminal?: 'checkmate' | 'stalemate';
}

/** Win chance for White, 0–100. Uses Lichess's published logistic fit of centipawns to results. */
export function winPercent(score: Score): number {
  if (score.mate !== null) return score.mate > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * (score.cp ?? 0))) - 1);
}

export const winPercentFor = (score: Score, color: Color) =>
  color === 'w' ? winPercent(score) : 100 - winPercent(score);

export function formatScore(score: Score): string {
  if (score.mate !== null) return `${score.mate > 0 ? '+' : '-'}M${Math.abs(score.mate)}`;
  const pawns = (score.cp ?? 0) / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

/** The evaluation of a position, handling finished games. */
export function scoreOf(analysis: Analysis, sideToMove: Color): Score {
  if (analysis.terminal === 'checkmate') return { cp: null, mate: sideToMove === 'w' ? -1 : 1 };
  if (analysis.terminal === 'stalemate') return { cp: 0, mate: null };
  return analysis.lines[0]?.score ?? { cp: 0, mate: null };
}

export type MoveClass = 'brilliant' | 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

/**
 * Grades a move by how much win chance it gave up, using Lichess's thresholds
 * (5 / 10 / 15 percentage points).
 */
export function classify(winLoss: number, wasBest: boolean): MoveClass {
  if (wasBest || winLoss < 1) return 'best';
  if (winLoss < 5) return 'good';
  if (winLoss < 10) return 'inaccuracy';
  if (winLoss < 15) return 'mistake';
  return 'blunder';
}

/** Per-move accuracy from win-chance loss, using Lichess's published curve. */
export function moveAccuracy(winLoss: number): number {
  const value = 103.1668 * Math.exp(-0.04354 * Math.max(0, winLoss)) - 3.1669;
  return Math.max(0, Math.min(100, value));
}
