import { ALL_LESSONS } from '../course/content';
import { loadGame, loadProgress, saveGame, type SavedGame } from '../lib/storage';
import { store } from '../lib/store';
import { drillsFromReview, dueDrills, type Drill } from './drills';
import { buildPlan, currentStreak, type PlanItem, type PlanKind, type PlanProgress } from './plan';
import type { PuzzleRating } from './puzzles';
import { eventsFromReview, scoreSkills, weakestSkills, type SkillEvent, type SkillId } from './skills';

const MAX_EVENTS = 4000;

export const localDate = (time = Date.now()) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const dayBefore = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  return localDate(new Date(year, month - 1, day - 1, 12).getTime());
};

export const loadEvents = (): SkillEvent[] => store.get('events', []);

export function logEvents(events: SkillEvent[]) {
  if (events.length) store.set('events', [...loadEvents(), ...events].slice(-MAX_EVENTS));
}

export const loadDrills = () => store.list<Drill>('drill:');
export const saveDrill = (drill: Drill) => store.set(`drill:${drill.id}`, drill);

/**
 * Feeds a reviewed game into drills and the skill map, once only. Does nothing until
 * we know which side the player had, because only their own moves should count.
 */
export function ingestReview(game: SavedGame): SavedGame {
  if (game.ingested || !game.review || !game.playerColor) return game;
  const now = Date.now();
  for (const drill of drillsFromReview(game.id, game.review, game.playerColor, now)) {
    if (!store.get<Drill | null>(`drill:${drill.id}`, null)) saveDrill(drill);
  }
  logEvents(eventsFromReview(game.review, game.playerColor, new Date(game.date).getTime()));
  const next = { ...game, ingested: true };
  saveGame(next);
  return next;
}

/** Records which side the player had in an imported or pasted game, then feeds its review in. */
export function setPlayerColor(id: string, color: 'w' | 'b'): SavedGame | null {
  const game = loadGame(id);
  if (!game) return null;
  const next = { ...game, playerColor: color };
  saveGame(next);
  return ingestReview(next);
}

export const loadPlanProgress = (date = localDate()): PlanProgress => store.get(`plan:${date}`, {});

/** Counts progress towards today's plan. Any training also marks the day as active for the streak. */
export function bumpPlan(kind: PlanKind, amount = 1) {
  const date = localDate();
  const progress = loadPlanProgress(date);
  store.set(`plan:${date}`, { ...progress, [kind]: (progress[kind] ?? 0) + amount });
}

export function trainingStreak(): number {
  const days = new Set(store.keys('plan:').map((key) => key.slice(5)));
  return currentStreak(days, localDate(), dayBefore);
}

export function skillSnapshot() {
  const scores = scoreSkills(loadEvents());
  return { scores, weakest: weakestSkills(scores) as SkillId[] };
}

export function todaysPlan(): { items: PlanItem[]; progress: PlanProgress } {
  const progress = loadProgress();
  const next = ALL_LESSONS.find((lesson) => !progress[lesson.id]);
  const date = localDate();
  const items = buildPlan({
    dueDrills: dueDrills(loadDrills(), Date.now()).length + (loadPlanProgress(date).drills ?? 0),
    weakest: skillSnapshot().weakest,
    nextLesson: next ? { id: next.id, title: next.title } : null,
    date,
  });
  return { items, progress: loadPlanProgress(date) };
}

export const loadPuzzleRating = (): PuzzleRating => store.get('puzzleRating', { value: 1000, games: 0 });

export interface RatingPoint {
  t: number;
  value: number;
}
export const loadPuzzleHistory = (): RatingPoint[] => store.get('puzzleHistory', []);

export function savePuzzleRating(rating: PuzzleRating) {
  store.set('puzzleRating', rating);
  store.set('puzzleHistory', [...loadPuzzleHistory(), { t: Date.now(), value: rating.value }].slice(-500));
}

const SEEN_LIMIT = 3000;
export const loadSeenPuzzles = () => new Set(store.get<string[]>('puzzleSeen', []));
export function markPuzzleSeen(id: string) {
  store.set('puzzleSeen', [...store.get<string[]>('puzzleSeen', []), id].slice(-SEEN_LIMIT));
}

export const loadRushBest = () => store.get('rushBest', 0);
export function saveRushBest(score: number) {
  if (score > loadRushBest()) store.set('rushBest', score);
}
