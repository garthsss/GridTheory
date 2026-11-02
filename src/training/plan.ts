import { SKILLS, type SkillId } from './skills';

export type PlanKind = 'drills' | 'puzzles' | 'scenario' | 'lesson';

export interface PlanItem {
  kind: PlanKind;
  title: string;
  detail: string;
  href: string;
  target: number;
}

export interface PlanInput {
  dueDrills: number;
  weakest: SkillId[];
  nextLesson: { id: string; title: string } | null;
  /** Local date as YYYY-MM-DD. Used to vary the scenario phase from day to day. */
  date: string;
}

const PUZZLES_PER_DAY = 5;
const MAX_DRILLS_PER_DAY = 5;

const PUZZLE_FILTER: Partial<Record<SkillId, string>> = {
  safety: 'hanging',
  tactics: 'all',
  calculation: 'sacrifice',
  mating: 'mate',
  endgame: 'endgame',
  conversion: 'endgame',
  opening: 'opening',
  middlegame: 'middlegame',
};

const PHASES: ('opening' | 'middlegame' | 'endgame')[] = ['opening', 'middlegame', 'endgame'];

/** Today's plan: about 15 minutes, with your own mistakes first and practice aimed at your weakest skill. */
export function buildPlan(input: PlanInput): PlanItem[] {
  const items: PlanItem[] = [];
  if (input.dueDrills > 0) {
    const target = Math.min(input.dueDrills, MAX_DRILLS_PER_DAY);
    items.push({
      kind: 'drills',
      title: `Fix ${target} of your mistakes`,
      detail: 'Positions from your own games, spaced so that the lesson sticks.',
      href: '#/train/drills',
      target,
    });
  }

  const focus = input.weakest[0] ? SKILLS.find((skill) => skill.id === input.weakest[0]) : null;
  const filter = (focus && PUZZLE_FILTER[focus.id]) ?? 'all';
  items.push({
    kind: 'puzzles',
    title: `Solve ${PUZZLES_PER_DAY} puzzles`,
    detail: focus ? `Aimed at your weakest area: ${focus.label.toLowerCase()}.` : 'Tactics at your level.',
    href: `#/train/puzzles/${filter}`,
    target: PUZZLES_PER_DAY,
  });

  const weakPhase = input.weakest.find((id): id is 'opening' | 'middlegame' | 'endgame' => id === 'opening' || id === 'middlegame' || id === 'endgame');
  const dayNumber = Number(input.date.replaceAll('-', ''));
  const phase = weakPhase ?? PHASES[dayNumber % PHASES.length];
  items.push({
    kind: 'scenario',
    title: `Play ${phase === 'opening' ? 'an' : 'a'} ${phase} scenario`,
    detail: weakPhase ? 'This is one of your weaker phases.' : 'A fresh position, graded move by move.',
    href: `#/train/scenarios/${phase}`,
    target: 1,
  });

  if (input.nextLesson) {
    items.push({
      kind: 'lesson',
      title: input.nextLesson.title,
      detail: 'Your next lesson in the course.',
      href: `#/learn/${input.nextLesson.id}`,
      target: 1,
    });
  }
  return items;
}

export type PlanProgress = Partial<Record<PlanKind, number>>;

export const itemDone = (item: PlanItem, progress: PlanProgress) => (progress[item.kind] ?? 0) >= item.target;
export const planDone = (items: PlanItem[], progress: PlanProgress) => items.every((item) => itemDone(item, progress));

/** Consecutive days with training, counting back from today. Today not being finished yet doesn't break it. */
export function currentStreak(activeDays: Set<string>, today: string, previous: (date: string) => string): number {
  let streak = 0;
  let cursor = activeDays.has(today) ? today : previous(today);
  while (activeDays.has(cursor)) {
    streak++;
    cursor = previous(cursor);
  }
  return streak;
}
