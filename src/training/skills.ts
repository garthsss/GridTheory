import type { Color } from 'chess.js';
import type { ReviewData } from '../review/analyze';

export type SkillId = 'safety' | 'tactics' | 'calculation' | 'mating' | 'opening' | 'middlegame' | 'endgame' | 'conversion';

export const SKILLS: { id: SkillId; label: string; about: string; lessons: string[]; practice: { label: string; href: string } }[] = [
  { id: 'safety', label: 'Board safety', about: 'Not leaving pieces en prise, and spotting threats.', lessons: ['blunder-check', 'hanging-pieces'], practice: { label: 'Hanging-piece puzzles', href: '#/train/puzzles/hanging' } },
  { id: 'tactics', label: 'Tactics', about: 'Finding forks, pins, skewers and other winning shots.', lessons: ['forks', 'pins-skewers', 'discovered'], practice: { label: 'Tactics puzzles', href: '#/train/puzzles/all' } },
  { id: 'calculation', label: 'Calculation', about: 'Seeing long forcing lines through to the end.', lessons: ['calculation', 'calc-drills'], practice: { label: 'Sacrifice puzzles', href: '#/train/puzzles/sacrifice' } },
  { id: 'mating', label: 'Attacking the king', about: 'Spotting mates, and avoiding them.', lessons: ['mate-patterns', 'mating-nets'], practice: { label: 'Checkmate puzzles', href: '#/train/puzzles/mate' } },
  { id: 'opening', label: 'Openings', about: 'Sound development and good first moves.', lessons: ['opening-principles', 'repertoire'], practice: { label: 'Opening scenarios', href: '#/train' } },
  { id: 'middlegame', label: 'Middlegame', about: 'Good plans and accurate play once the pieces are out.', lessons: ['worst-piece', 'pawn-structure'], practice: { label: 'Middlegame scenarios', href: '#/train' } },
  { id: 'endgame', label: 'Endgames', about: 'Accuracy once most of the pieces are gone.', lessons: ['key-squares', 'rook-endings'], practice: { label: 'Endgame scenarios', href: '#/train' } },
  { id: 'conversion', label: 'Converting wins', about: 'Keeping hold of a winning position.', lessons: ['trading', 'two-weaknesses'], practice: { label: 'Endgame puzzles', href: '#/train/puzzles/endgame' } },
];

export interface SkillEvent {
  t: number;
  skill: SkillId;
  /** Performance from 0 to 1. */
  value: number;
  weight: number;
  source: 'game' | 'puzzle' | 'drill' | 'scenario';
}

export interface SkillScore {
  /** 0 to 100, or null until there's enough evidence to say. */
  score: number | null;
  samples: number;
  /** Recent score minus the score before it, or null with too little history. */
  trend: number | null;
}

/** Enough evidence to show a score, measured in total event weight. */
export const MIN_EVIDENCE = 4;
const HALF_LIFE = 25;

function weightedMean(events: SkillEvent[]): number {
  let sum = 0;
  let total = 0;
  events.forEach((event, index) => {
    // Older events count for less: the weight halves every HALF_LIFE events back.
    const age = events.length - 1 - index;
    const weight = event.weight * 0.5 ** (age / HALF_LIFE);
    sum += event.value * weight;
    total += weight;
  });
  return total ? sum / total : 0;
}

export function scoreSkills(events: SkillEvent[]): Record<SkillId, SkillScore> {
  const out = {} as Record<SkillId, SkillScore>;
  for (const { id } of SKILLS) {
    const mine = events.filter((event) => event.skill === id).sort((a, b) => a.t - b.t);
    const evidence = mine.reduce((sum, event) => sum + event.weight, 0);
    if (evidence < MIN_EVIDENCE) {
      out[id] = { score: null, samples: mine.length, trend: null };
      continue;
    }
    const third = Math.floor(mine.length / 3);
    const trend = third >= 3 ? Math.round(100 * (weightedMean(mine.slice(-third)) - weightedMean(mine.slice(0, -third)))) : null;
    out[id] = { score: Math.round(100 * weightedMean(mine)), samples: mine.length, trend };
  }
  return out;
}

/** The lowest-scoring skills with enough evidence, weakest first. */
export function weakestSkills(scores: Record<SkillId, SkillScore>, count = 2): SkillId[] {
  return SKILLS.map((skill) => skill.id)
    .filter((id) => scores[id].score !== null)
    .sort((a, b) => (scores[a].score ?? 0) - (scores[b].score ?? 0))
    .slice(0, count);
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/** Turns one reviewed game into evidence for the skill map. */
export function eventsFromReview(review: ReviewData, color: Color, t: number): SkillEvent[] {
  const mine = review.moves.filter((move) => move.color === color);
  if (mine.length === 0) return [];
  const out: SkillEvent[] = [];
  const add = (skill: SkillId, value: number, weight: number) => out.push({ t, skill, value, weight, source: 'game' });
  const per10 = 10 / mine.length;
  const count = (...themes: string[]) => mine.filter((move) => move.themes.some((theme) => themes.includes(theme))).length;

  // One error per ten moves is a poor showing, so a rate of two or more scores zero.
  add('safety', Math.max(0, 1 - (count('hung-piece', 'allowed-tactic') * per10) / 2), 2);
  add('tactics', Math.max(0, 1 - (count('missed-tactic') * per10) / 2), 1);

  const mateErrors = count('missed-mate', 'allowed-mate');
  const matesFound = mine.filter((move) => (move.cls === 'best' || move.cls === 'brilliant') && move.scoreAfter.mate !== null && (color === 'w') === move.scoreAfter.mate > 0).length;
  if (mateErrors || matesFound) add('mating', matesFound / (matesFound + mateErrors), 1);

  for (const phase of ['opening', 'middlegame', 'endgame'] as const) {
    const moves = mine.filter((move) => move.phase === phase);
    if (moves.length >= 4) add(phase, mean(moves.map((move) => move.accuracy)) / 100, Math.min(3, moves.length / 5));
  }
  const winning = mine.filter((move) => move.winBefore >= 75);
  if (winning.length >= 3) add('conversion', mean(winning.map((move) => move.accuracy)) / 100, Math.min(2, winning.length / 5));
  return out;
}

export const PUZZLE_PAR = 0.7;
const MATE_THEMES = ['mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'backRankMate', 'smotheredMate'];
const ENDGAME_THEMES = ['endgame', 'rookEndgame', 'pawnEndgame', 'queenEndgame', 'bishopEndgame', 'knightEndgame'];

/**
 * Evidence from a puzzle. It compares the result with what was expected at that difficulty, because the
 * trainer adapts to you: raw success rate would sit near 50% for every player. Par is 0.7, about a typical
 * game accuracy, so that skills practised mostly through puzzles aren't made to look weak next to the others.
 */
export function eventsFromPuzzle(themes: string[], solverMoves: number, solved: boolean, expected: number, t: number): SkillEvent[] {
  const value = PUZZLE_PAR + 0.3 * ((solved ? 1 : 0) - expected);
  const skills = new Set<SkillId>();
  if (themes.some((theme) => MATE_THEMES.includes(theme))) skills.add('mating');
  else skills.add('tactics');
  if (themes.includes('hangingPiece')) skills.add('safety');
  if (themes.some((theme) => ENDGAME_THEMES.includes(theme))) skills.add('endgame');
  if (themes.includes('opening')) skills.add('opening');
  if (themes.includes('middlegame')) skills.add('middlegame');
  if (solverMoves >= 3) skills.add('calculation');
  return [...skills].map((skill) => ({ t, skill, value, weight: 0.5, source: 'puzzle' as const }));
}

/** Evidence from a drill, which tests whether you've fixed a real mistake from your games. */
export function eventsFromDrill(themes: string[], correct: boolean, t: number): SkillEvent[] {
  const skills = new Set<SkillId>();
  for (const theme of themes) {
    if (theme === 'hung-piece' || theme === 'allowed-tactic') skills.add('safety');
    if (theme === 'missed-tactic') skills.add('tactics');
    if (theme === 'missed-mate' || theme === 'allowed-mate') skills.add('mating');
    if (theme === 'opening') skills.add('opening');
    if (theme === 'positional') skills.add('middlegame');
  }
  return [...skills].map((skill) => ({ t, skill, value: correct ? 1 : 0, weight: 1, source: 'drill' as const }));
}

export function eventsFromScenario(phase: 'opening' | 'middlegame' | 'endgame', accuracy: number, t: number): SkillEvent[] {
  return [{ t, skill: phase, value: accuracy / 100, weight: 1.5, source: 'scenario' }];
}
