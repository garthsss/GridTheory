import { Chess } from 'chess.js';
import { isIllegalPosition, parseGame } from './chess';
import { SCHEMA_VERSION } from './store';

export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

export class BackupError extends Error {}

const SINGLE_KEYS = new Set([
  'schema', 'prefs', 'progress', 'rating', 'ratingHistory', 'training', 'lastGame', 'profile', 'events',
  'puzzleRating', 'puzzleHistory', 'puzzleSeen', 'rushBest',
]);
const LEGACY_KEYS = new Set(['gt.games', 'gt.prefs', 'gt.progress', 'gt.rating', 'gt.training', 'gt.lastGame']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function validFen(fen: unknown): boolean {
  if (typeof fen !== 'string' || fen.length > 120) return false;
  try {
    new Chess(fen);
    return !isIllegalPosition(fen);
  } catch {
    return false;
  }
}

function cleanGame(raw: string): string | null {
  const game: unknown = JSON.parse(raw);
  if (!isObject(game)) return null;
  for (const field of ['id', 'pgn', 'date', 'white', 'black', 'result']) {
    if (typeof game[field] !== 'string') return null;
  }
  if (game.playerColor !== 'w' && game.playerColor !== 'b' && game.playerColor !== null && game.playerColor !== undefined) return null;
  parseGame(game.pgn as string);
  // A review only ever holds derived data, so a damaged one can simply be dropped and redone.
  const review = game.review;
  if (review !== undefined) {
    const moves = isObject(review) ? review.moves : null;
    const sound = Array.isArray(moves) && isObject((review as Record<string, unknown>).sides) && moves.every((move) => isObject(move) && validFen(move.fenBefore) && validFen(move.fenAfter));
    if (!sound) {
      delete game.review;
      delete game.ingested;
    }
  }
  return JSON.stringify(game);
}

function cleanDrill(raw: string): string | null {
  const drill: unknown = JSON.parse(raw);
  if (!isObject(drill) || !validFen(drill.fen)) return null;
  if (drill.color !== 'w' && drill.color !== 'b') return null;
  if (typeof drill.bestUci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(drill.bestUci)) return null;
  if (typeof drill.dueAt !== 'number' || !Array.isArray(drill.themes)) return null;
  return raw;
}

/**
 * Backups are files that could come from anywhere, so nothing is restored unchecked. Only known keys of the right
 * form are kept, and every game and drill is validated.
 */
export function sanitizeBackup(input: unknown): { data: Record<string, string>; dropped: number } {
  if (!isObject(input)) throw new BackupError('That file is not a GridTheory backup.');
  const data: Record<string, string> = {};
  let dropped = 0;
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (typeof value !== 'string') {
      dropped++;
      continue;
    }
    try {
      if (key === 'schema') {
        const version = Number(value);
        if (!Number.isInteger(version) || version < 0) throw new BackupError('That backup has an invalid version.');
        if (version > SCHEMA_VERSION) throw new BackupError('That backup is from a newer version of GridTheory. Update the app first.');
        data[key] = value;
      } else if (key.startsWith('game:')) {
        const cleaned = cleanGame(value);
        if (cleaned) data[key] = cleaned;
        else dropped++;
      } else if (key.startsWith('drill:')) {
        const cleaned = cleanDrill(value);
        if (cleaned) data[key] = cleaned;
        else dropped++;
      } else if (key.startsWith('plan:') && /^plan:\d{4}-\d{2}-\d{2}$/.test(key)) {
        if (isObject(JSON.parse(value))) data[key] = value;
        else dropped++;
      } else if (SINGLE_KEYS.has(key) || LEGACY_KEYS.has(key)) {
        JSON.parse(value);
        data[key] = value;
      } else {
        dropped++;
      }
    } catch (error) {
      if (error instanceof BackupError) throw error;
      dropped++;
    }
  }
  if (Object.keys(data).length === 0) throw new BackupError('That file is not a GridTheory backup.');
  return { data, dropped };
}
