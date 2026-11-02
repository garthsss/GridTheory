import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { ALL_LESSONS, COURSE } from '../src/course/content';
import type { Step } from '../src/course/types';
import { fenFromMoves, isIllegalPosition } from '../src/lib/chess';
import { OPENINGS } from '../src/lib/openings';
import { recommendations, buildReview } from '../src/review/analyze';

const fenOf = (step: Step, previous: string | null) => {
  if (step.kind === 'game') return null;
  if (step.fen) return step.fen;
  if (step.kind === 'read' && step.moves) return fenFromMoves(step.moves);
  if (step.kind === 'play' && step.from) return fenFromMoves(step.from);
  return previous;
};

describe('course content', () => {
  it('has unique lesson ids', () => {
    const ids = ALL_LESSONS.map((lesson) => lesson.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const level of COURSE) {
    for (const lesson of level.lessons) {
      it(`${level.id}/${lesson.id} has legal positions and moves`, () => {
        let previous: string | null = null;
        for (const step of lesson.steps) {
          const fen = fenOf(step, previous);
          previous = fen;
          if (step.kind === 'game') {
            const chess = new Chess();
            for (const san of step.moves.split(' ')) chess.move(san);
            for (const ply of Object.keys(step.notes)) {
              expect(Number(ply)).toBeLessThanOrEqual(chess.history().length);
            }
            continue;
          }
          expect(fen, `${step.text.slice(0, 40)} needs a position`).toBeTruthy();
          const chess = new Chess(fen!);
          expect(isIllegalPosition(fen!), `${fen} has the side not to move in check`).toBe(false);
          if (step.kind === 'play') {
            for (const san of step.also ?? []) new Chess(fen!).move(san);
            for (const san of step.line) chess.move(san);
          }
        }
      });
    }
  }
});

describe('openings table', () => {
  it('uses only legal lines', () => {
    for (const [line] of OPENINGS) expect(() => fenFromMoves(line)).not.toThrow();
  });
});

describe('recommendations', () => {
  it('links only to lessons that exist', () => {
    const themes = ['hung-piece', 'allowed-mate', 'missed-mate', 'missed-tactic', 'allowed-tactic', 'opening', 'positional'] as const;
    const review = buildReview([], 10, null);
    review.moves = themes.map((theme, i) => ({
      themes: [theme], color: 'w', winBefore: 90, winAfter: 10, phase: 'endgame', accuracy: 10, ply: i, cls: 'blunder',
    })) as unknown as typeof review.moves;
    review.sides.w.phases = { endgame: { accuracy: 10, moves: 8 } };
    const ids = recommendations(review, 'w').flatMap((rec) => rec.lessons);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(ALL_LESSONS.map((lesson) => lesson.id)).toContain(id);
  });
});
