import type { MoveReport } from './explain';

export interface Coach {
  id: string;
  name: string;
  title: string;
  blurb: string;
  /** Coach's default strictness for stepping in before a move is played. */
  defaultStop: StopLevel;
  greeting: string;
  praise: string[];
  stop: string;
  warnInaccuracy: string;
}

export type StopLevel = 'off' | 'blunder' | 'mistake';

export const COACHES: Coach[] = [
  {
    id: 'maren',
    name: 'Maren',
    title: 'The Patient Teacher',
    blurb: 'Explains the why in plain language. Steps in on mistakes as well as blunders. Best under about 1200.',
    defaultStop: 'mistake',
    greeting: "Hi, I'm Maren. I'll watch each move and speak up if something's about to go wrong. Take your time.",
    praise: ['Nice, that fits the position well.', 'Good move. You saw what mattered.', 'Exactly right.', 'Well played. That is what I would have chosen.'],
    stop: "Let's pause before this one.",
    warnInaccuracy: 'That works, but there was something a little better.',
  },
  {
    id: 'viktor',
    name: 'Viktor',
    title: 'The Tactician',
    blurb: 'Terse and concrete: lines, not lectures. Steps in on blunders only. Suits club players.',
    defaultStop: 'blunder',
    greeting: 'Viktor. Calculate. I interrupt only when you are about to throw the game.',
    praise: ['Correct.', 'Yes.', 'Good calculation.', 'Precise.'],
    stop: 'Stop. Calculate again.',
    warnInaccuracy: 'Imprecise.',
  },
  {
    id: 'sage',
    name: 'Sage',
    title: 'The Strategist',
    blurb: 'Talks plans, pawn structure and piece quality. Steps in on blunders only. Suits improving players.',
    defaultStop: 'blunder',
    greeting: "I'm Sage. Ask me about the plan whenever you're unsure. Good moves come from understanding the position.",
    praise: ['That improves your position.', 'A purposeful move.', 'Sound, and it keeps your options open.', 'Good. Your pieces are working together.'],
    stop: 'Before you commit, look at the whole board again.',
    warnInaccuracy: 'Playable, but it drifts from the best plan.',
  },
];

export const coachById = (id: string) => COACHES.find((coach) => coach.id === id) ?? null;

/** Whether the coach should interrupt before this move is played. */
export function shouldStop(report: MoveReport, level: StopLevel): boolean {
  if (level === 'off') return false;
  if (report.cls === 'blunder') return true;
  return level === 'mistake' && report.cls === 'mistake';
}

export function commentaryFor(coach: Coach, report: MoveReport, ply: number): string | null {
  if (report.cls === 'brilliant') return `${report.headline} ${report.detail}`;
  if (report.cls === 'best' && ply % 3 === 0) return coach.praise[ply % coach.praise.length];
  if (report.cls === 'inaccuracy') return `${coach.warnInaccuracy} ${report.bestSan} was stronger.`;
  if (report.cls === 'mistake' || report.cls === 'blunder') return `${report.headline} ${report.detail}`;
  return null;
}
