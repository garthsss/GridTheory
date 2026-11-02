import type { Color } from 'chess.js';
import { buildMoveReport, findSacrifice, type MoveReport, type Theme } from '../coach/explain';
import { analysisEngine } from '../engine/uci';
import { moveAccuracy, type Analysis, type MoveClass } from '../engine/score';
import { totalMaterial, type ParsedGame } from '../lib/chess';
import { openingFromFens } from '../lib/openings';

export type Phase = 'opening' | 'middlegame' | 'endgame';

export interface ReviewedMove extends MoveReport {
  ply: number;
  phase: Phase;
  accuracy: number;
}

export interface SideSummary {
  accuracy: number;
  counts: Record<MoveClass, number>;
  phases: Partial<Record<Phase, { accuracy: number; moves: number }>>;
}

export interface Recommendation {
  title: string;
  why: string;
  lessons: string[];
}

export interface ReviewData {
  depth: number;
  opening: string | null;
  moves: ReviewedMove[];
  sides: Record<Color, SideSummary>;
}

const errors = (n: number) => (n === 1 ? 'One error' : `${n} errors`);

const THEME_ADVICE: Record<Theme, { title: string; why: (n: number) => string; lessons: string[] }> = {
  'hung-piece': {
    title: 'Stop leaving pieces undefended',
    why: (n) => `${errors(n)} gave away material to a simple capture. A short safety check before each move prevents most of these.`,
    lessons: ['blunder-check', 'hanging-pieces', 'counting'],
  },
  'allowed-mate': {
    title: 'Watch your king',
    why: (n) => `${errors(n)} allowed a forced mate. Look at your opponent's checks first.`,
    lessons: ['mate-patterns', 'scholars-mate'],
  },
  'missed-mate': {
    title: 'Finish the game when you can',
    why: (n) => `You missed a forced mate ${n} time${n === 1 ? '' : 's'}. Mating patterns become quick to spot with practice.`,
    lessons: ['mate-patterns', 'mating-nets', 'calc-drills'],
  },
  'missed-tactic': {
    title: 'Scan for tactics on your turn',
    why: (n) => `You passed up ${n} chance${n === 1 ? '' : 's'} to win material. Check every capture and check before a quiet move.`,
    lessons: ['forks', 'pins-skewers', 'discovered', 'overloading', 'calculation'],
  },
  'allowed-tactic': {
    title: "Check your opponent's forcing replies",
    why: (n) => `${errors(n)} allowed a tactic that won material. Before you move, ask what the move stops defending.`,
    lessons: ['blunder-check', 'forks', 'pins-skewers', 'zwischenzug'],
  },
  opening: {
    title: 'Tidy up your opening',
    why: (n) => `${errors(n)} came from early moves that ignored development.`,
    lessons: ['opening-principles', 'tempo', 'repertoire'],
  },
  positional: {
    title: 'Build a plan in quiet positions',
    why: (n) => `${errors(n)} had no immediate tactic, but drifted positionally. Work on piece quality and pawn structure.`,
    lessons: ['worst-piece', 'pawn-structure', 'weak-squares'],
  },
};

export function phaseOf(fen: string, ply: number): Phase {
  const material = totalMaterial(fen);
  if (material <= 30) return 'endgame';
  if (ply <= 20 && material >= 60) return 'opening';
  return 'middlegame';
}

function summarizeSide(moves: ReviewedMove[]): SideSummary {
  const counts: Record<MoveClass, number> = { brilliant: 0, best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  const grouped: Partial<Record<Phase, number[]>> = {};
  for (const move of moves) {
    counts[move.cls]++;
    (grouped[move.phase] ??= []).push(move.accuracy);
  }
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const phases: SideSummary['phases'] = {};
  for (const [phase, values] of Object.entries(grouped) as [Phase, number[]][]) {
    phases[phase] = { accuracy: mean(values), moves: values.length };
  }
  return { accuracy: mean(moves.map((m) => m.accuracy)), counts, phases };
}

export function buildReview(reports: MoveReport[], depth: number, opening: string | null): ReviewData {
  const moves: ReviewedMove[] = reports.map((report, index) => ({
    ...report,
    ply: index + 1,
    phase: phaseOf(report.fenBefore, index + 1),
    accuracy: moveAccuracy(report.loss),
  }));
  return {
    depth,
    opening,
    moves,
    sides: {
      w: summarizeSide(moves.filter((m) => m.color === 'w')),
      b: summarizeSide(moves.filter((m) => m.color === 'b')),
    },
  };
}

/** Ranks what a player should work on, from the errors in this game. */
export function recommendations(review: ReviewData, color: Color): Recommendation[] {
  const counts = new Map<Theme, number>();
  for (const move of review.moves) {
    if (move.color !== color) continue;
    for (const theme of move.themes) counts.set(theme, (counts.get(theme) ?? 0) + 1);
  }
  const out: Recommendation[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([theme, count]) => {
      const advice = THEME_ADVICE[theme];
      return { title: advice.title, why: advice.why(count), lessons: advice.lessons };
    });

  const phases = review.sides[color].phases;
  const weakest = (Object.entries(phases) as [Phase, { accuracy: number; moves: number }][])
    .filter(([, stats]) => stats.moves >= 4)
    .sort((a, b) => a[1].accuracy - b[1].accuracy)[0];
  if (weakest?.[0] === 'endgame' && weakest[1].accuracy < 80) {
    out.push({
      title: 'Strengthen your endgames',
      why: `Your endgame accuracy was ${Math.round(weakest[1].accuracy)}%, your lowest of the game.`,
      lessons: ['key-squares', 'rook-endings', 'breakthrough'],
    });
  }

  const conversions = review.moves.filter((m) => m.color === color && m.winBefore >= 80 && m.winAfter < 60);
  if (conversions.length > 0) {
    out.push({
      title: 'Convert winning positions',
      why: `You let a winning position slip ${conversions.length} time${conversions.length === 1 ? '' : 's'}. When ahead, trade pieces and remove your opponent's counterplay first.`,
      lessons: ['trading', 'two-weaknesses', 'prophylaxis'],
    });
  }
  return out;
}

/** Runs the engine over every position in a game. `onProgress` receives the fraction complete. */
export async function analyzeGame(
  game: ParsedGame,
  depth: number,
  onProgress: (fraction: number) => void,
  isCancelled: () => boolean,
): Promise<ReviewData | null> {
  const fens = [game.moves[0].fenBefore, ...game.moves.map((move) => move.fenAfter)];
  const analyses: Analysis[] = [];
  for (let i = 0; i < fens.length; i++) {
    if (isCancelled()) return null;
    let analysis = await analysisEngine.search(fens[i], { depth, multipv: 1 });
    // Another page may have cancelled the engine's queue mid-game, which leaves an empty answer. Ask again.
    if (analysis.lines.length === 0 && !analysis.terminal) analysis = await analysisEngine.search(fens[i], { depth, multipv: 1 });
    analyses.push(analysis);
    onProgress(((i + 1) / fens.length) * 0.8);
  }
  if (isCancelled()) return null;
  const build = () => game.moves.map((move, i) => buildMoveReport(move.fenBefore, move.uci, analyses[i], analyses[i + 1]));

  // Shallow searches can miss a sacrifice's point, so confirm each flagged move and each sacrifice at a greater depth.
  // The second line is what lets a sacrifice be judged brilliant.
  const flagged = build().flatMap((report, i) => (report.cls === 'mistake' || report.cls === 'blunder' || findSacrifice(report.fenBefore, report.uci) ? [i] : []));
  const deeper = depth + 6;
  const refreshed = new Set<number>();
  for (const [done, i] of flagged.entries()) {
    for (const index of [i, i + 1]) {
      if (isCancelled()) return null;
      if (!refreshed.has(index)) {
        analyses[index] = await analysisEngine.search(fens[index], { depth: deeper, multipv: 2 });
        refreshed.add(index);
      }
    }
    onProgress(0.8 + ((done + 1) / flagged.length) * 0.2);
  }
  return buildReview(build(), depth, openingFromFens(game.moves.map((move) => move.fenAfter)));
}
