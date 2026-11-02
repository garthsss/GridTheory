import { Chess } from 'chess.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COURSE } from '../src/course/content';
import { fenFromMoves, sanFromUci } from '../src/lib/chess';
import { NodeEngine, winFor } from './engine';

const DEPTH = 18;
/** A taught move may give up this much win chance against the engine's top choice. */
const TOLERANCE = 12;

describe('every exercise holds up against Stockfish', () => {
  const engine = new NodeEngine();
  beforeAll(() => engine.init());
  afterAll(() => engine.quit());

  for (const level of COURSE) {
    for (const lesson of level.lessons) {
      it(lesson.id, async () => {
        const failures: string[] = [];
        for (const [index, step] of lesson.steps.entries()) {
          if (step.kind !== 'play' || step.drill) continue;
          const start = step.fen ?? fenFromMoves(step.from!);
          const check = async (fen: string, san: string, label: string) => {
            const color = new Chess(fen).turn();
            const before = await engine.analyse(fen, DEPTH);
            const chess = new Chess(fen);
            chess.move(san);
            const after = await engine.analyse(chess.fen(), DEPTH);
            const loss = winFor(before.score, color) - winFor(after.score, color);
            if (loss > TOLERANCE) {
              failures.push(
                `step ${index} ${label}: ${san} loses ${loss.toFixed(1)}%. Engine prefers ${sanFromUci(fen, before.best)} [${before.pv.slice(0, 6).join(' ')}], score ${JSON.stringify(before.score)} then ${JSON.stringify(after.score)}. FEN ${fen}`,
              );
            }
          };
          for (const san of step.also ?? []) await check(start, san, 'also');
          const chess = new Chess(start);
          for (const [ply, san] of step.line.entries()) {
            if (ply % 2 === 0) await check(chess.fen(), san, `line[${ply}]`);
            chess.move(san);
          }
        }
        expect(failures, failures.join('\n')).toEqual([]);
      }, 300_000);
    }
  }
});
