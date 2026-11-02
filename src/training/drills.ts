import type { Color } from 'chess.js';
import type { ReviewData } from '../review/analyze';

export interface Drill {
  id: string;
  gameId: string;
  fen: string;
  color: Color;
  /** The move played in the game, which the drill asks you to improve on. */
  playedSan: string;
  bestUci: string;
  bestSan: string;
  bestLine: string;
  headline: string;
  themes: string[];
  winBefore: number;
  /** Position in the repetition schedule: higher means a longer gap. */
  box: number;
  dueAt: number;
  attempts: number;
  correct: number;
  retired?: boolean;
}

const DAY = 86_400_000;
/** Days until a drill returns, by box. Getting one right moves it up; a miss sends it back to the start. */
export const INTERVALS = [1, 3, 7, 16, 35];

/** The player's mistakes worth drilling. Skips lost positions, where no move matters much. */
export function drillsFromReview(gameId: string, review: ReviewData, color: Color, now: number): Drill[] {
  return review.moves
    .filter((move) => move.color === color && (move.cls === 'mistake' || move.cls === 'blunder'))
    .filter((move) => move.winBefore >= 25 && move.bestUci && move.bestSan)
    .map((move) => ({
      id: `${gameId}-${move.ply}`,
      gameId,
      fen: move.fenBefore,
      color,
      playedSan: move.san,
      bestUci: move.bestUci!,
      bestSan: move.bestSan!,
      bestLine: move.bestLine,
      headline: move.headline,
      themes: move.themes,
      winBefore: move.winBefore,
      box: 0,
      dueAt: now,
      attempts: 0,
      correct: 0,
    }));
}

/** Applies a result. A drill retires after surviving the longest gap. */
export function scheduleDrill(drill: Drill, correct: boolean, now: number): Drill {
  const attempts = drill.attempts + 1;
  if (!correct) return { ...drill, attempts, box: 0, dueAt: now + INTERVALS[0] * DAY };
  const next = { ...drill, attempts, correct: drill.correct + 1 };
  if (drill.box >= INTERVALS.length - 1) return { ...next, retired: true };
  const box = drill.box + 1;
  return { ...next, box, dueAt: now + INTERVALS[box] * DAY };
}

export function dueDrills(drills: Drill[], now: number): Drill[] {
  return drills.filter((drill) => !drill.retired && drill.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
}

export const daysUntil = (drill: Drill, now: number) => Math.max(1, Math.round((drill.dueAt - now) / DAY));
