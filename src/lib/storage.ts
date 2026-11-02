import type { ReviewData } from '../review/analyze';
import { sanitizeBackup } from './backup';
import { store } from './store';

export type GameSource = 'bot' | 'training' | 'import' | 'lichess' | 'chesscom';

export interface SavedGame {
  id: string;
  date: string;
  pgn: string;
  white: string;
  black: string;
  result: string;
  source: GameSource;
  playerColor: 'w' | 'b' | null;
  /** The player who owns this record. Local for now; it becomes an account id if the app goes online. */
  playerId?: string;
  /** The game's id on the site it came from, used to avoid importing it twice. */
  externalId?: string;
  review?: ReviewData;
  /** Set once this game's review has fed drills and the skill map, so that it only counts once. */
  ingested?: boolean;
}

export interface Profile {
  id: string;
  name: string;
  createdAt: string;
  lichess?: string;
  chesscom?: string;
}

export const newId = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export function loadProfile(): Profile {
  const existing = store.get<Profile | null>('profile', null);
  if (existing) return existing;
  const created: Profile = { id: newId(), name: 'You', createdAt: new Date().toISOString() };
  store.set('profile', created);
  return created;
}

export function saveProfile(patch: Partial<Profile>) {
  store.set('profile', { ...loadProfile(), ...patch });
}

export const loadProgress = (): Record<string, boolean> => store.get('progress', {});
export function markLessonDone(id: string) {
  store.set('progress', { ...loadProgress(), [id]: true });
}

export interface Rating {
  value: number;
  games: number;
}
export const loadRating = (): Rating => store.get('rating', { value: 800, games: 0 });

export interface RatingPoint {
  t: number;
  value: number;
}
export const loadRatingHistory = (): RatingPoint[] => store.get('ratingHistory', []);

/** Standard Elo update against a bot's listed rating. K is higher for the first games. */
export function updateRating(opponent: number, score: number): Rating {
  const current = loadRating();
  const expected = 1 / (1 + 10 ** ((opponent - current.value) / 400));
  const k = current.games < 20 ? 40 : 20;
  const next = { value: Math.max(100, Math.round(current.value + k * (score - expected))), games: current.games + 1 };
  store.set('rating', next);
  store.set('ratingHistory', [...loadRatingHistory(), { t: Date.now(), value: next.value }].slice(-500));
  return next;
}

/** All saved games, newest first. */
export function loadGames(): SavedGame[] {
  return store.list<SavedGame>('game:').sort((a, b) => b.date.localeCompare(a.date));
}

export const loadGame = (id: string) => store.get<SavedGame | null>(`game:${id}`, null);

export function saveGame(game: SavedGame) {
  store.set(`game:${game.id}`, { playerId: loadProfile().id, ...game });
}

export function deleteGame(id: string) {
  store.remove(`game:${id}`);
}

export interface PhaseStats {
  attempts: number;
  passed: number;
  accuracySum: number;
  streak?: number;
  best?: number;
}
export type TrainingStats = Partial<Record<'opening' | 'middlegame' | 'endgame', PhaseStats>>;

export const loadTrainingStats = (): TrainingStats => store.get('training', {});
export const saveTrainingStats = (stats: TrainingStats) => store.set('training', stats);

export const loadLastGameConfig = <T,>(): Partial<T> => store.get('lastGame', {});
export const saveLastGameConfig = (config: unknown) => store.set('lastGame', config);

/** Everything saved, for download as a backup. */
export function exportBackup() {
  return store.exportAll();
}

/** Restores a backup after validating it. Returns how many unusable entries were skipped. */
export async function restoreBackup(input: unknown): Promise<number> {
  const { data, dropped } = sanitizeBackup(input);
  await store.importAll(data);
  return dropped;
}

/** Clears games, ratings and progress, keeping preferences. */
export function resetProgress() {
  for (const key of store.keys()) {
    if (!['prefs', 'schema', 'profile'].includes(key)) store.remove(key);
  }
}
