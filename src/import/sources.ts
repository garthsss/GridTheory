import { parseGame } from '../lib/chess';
import type { GameSource, SavedGame } from '../lib/storage';

export type Site = 'lichess' | 'chesscom';

export const SITE_NAMES: Record<Site, string> = { lichess: 'Lichess', chesscom: 'Chess.com' };

export interface RawGame {
  site: Site;
  externalId: string;
  pgn: string;
  playedAt: number;
}

export class ImportError extends Error {}

const USERNAME = /^[A-Za-z0-9_-]{2,50}$/;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Sends nothing beyond the request itself: no cookies, and no record of which site asked. */
const PRIVATE: RequestInit = { credentials: 'omit', referrerPolicy: 'no-referrer' };
const MAX_RESPONSE_CHARS = 50_000_000;
const MAX_MONTHS = 60;
const CHESSCOM_ARCHIVE = /^https:\/\/api\.chess\.com\/pub\/player\/[a-z0-9_-]+\/games\/\d{4}\/\d{2}$/;

async function readText(response: Response, site: Site): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new ImportError(`${SITE_NAMES[site]} sent more data than expected.`);
  return text;
}

function checkResponse(response: Response, username: string, site: Site) {
  if (response.status === 404) throw new ImportError(`${SITE_NAMES[site]} has no player called "${username}".`);
  if (response.status === 429) throw new ImportError(`${SITE_NAMES[site]} is limiting requests. Wait a minute and try again.`);
  if (!response.ok) throw new ImportError(`${SITE_NAMES[site]} returned an error (${response.status}). Try again later.`);
}

/** Recent standard-chess games from Lichess's public API. */
export async function fetchLichess(username: string, max: number, fetcher: Fetcher = fetch): Promise<RawGame[]> {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${max}&pgnInJson=true&clocks=false&evals=false&opening=false&perfType=ultraBullet,bullet,blitz,rapid,classical,correspondence`;
  const response = await fetcher(url, { ...PRIVATE, headers: { Accept: 'application/x-ndjson' } });
  checkResponse(response, username, 'lichess');
  const text = await readText(response, 'lichess');
  const games: RawGame[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const game = JSON.parse(line) as { id: string; pgn?: string; createdAt: number; variant: string };
    if (game.variant === 'standard' && game.pgn) {
      games.push({ site: 'lichess', externalId: game.id, pgn: game.pgn, playedAt: game.createdAt });
    }
  }
  return games;
}

/** Recent standard-chess games from Chess.com's public API, which is organised by month. */
export async function fetchChessCom(username: string, max: number, fetcher: Fetcher = fetch): Promise<RawGame[]> {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`;
  const archivesResponse = await fetcher(base, PRIVATE);
  checkResponse(archivesResponse, username, 'chesscom');
  const { archives } = JSON.parse(await readText(archivesResponse, 'chesscom')) as { archives: string[] };
  // These addresses come from the response, so each is checked before it's fetched.
  const trusted = archives.filter((archive) => CHESSCOM_ARCHIVE.test(archive));
  const games: RawGame[] = [];
  for (const archive of trusted.reverse().slice(0, MAX_MONTHS)) {
    if (games.length >= max) break;
    const monthResponse = await fetcher(archive, PRIVATE);
    checkResponse(monthResponse, username, 'chesscom');
    const month = JSON.parse(await readText(monthResponse, 'chesscom')) as { games: { url: string; pgn?: string; rules: string; end_time: number }[] };
    for (const game of [...month.games].reverse()) {
      if (games.length >= max) break;
      if (game.rules === 'chess' && game.pgn) {
        games.push({ site: 'chesscom', externalId: game.url, pgn: game.pgn, playedAt: game.end_time * 1000 });
      }
    }
  }
  return games;
}

const KEPT_HEADERS = ['Event', 'Date', 'White', 'Black', 'Result', 'WhiteElo', 'BlackElo', 'TimeControl', 'ECO', 'FEN'];

/**
 * Converts a downloaded game to a saved one, dropping clock comments to save space.
 * Returns null for a game with no moves, or one that can't be read.
 */
export function toSavedGame(raw: RawGame, username: string): SavedGame | null {
  let parsed;
  try {
    parsed = parseGame(raw.pgn);
  } catch {
    return null;
  }
  if (parsed.moves.length === 0) return null;
  const white = parsed.headers.White ?? 'White';
  const black = parsed.headers.Black ?? 'Black';
  const me = username.toLowerCase();
  const playerColor = white.toLowerCase() === me ? 'w' : black.toLowerCase() === me ? 'b' : null;
  const headers = KEPT_HEADERS.filter((key) => parsed.headers[key]).map((key) => `[${key} "${parsed.headers[key].replace(/"/g, "'")}"]`);
  const moves = parsed.moves
    .map((move, index) => {
      const ply = index + (parsed.startFen.split(' ')[1] === 'b' ? 1 : 0);
      const number = Number(parsed.startFen.split(' ')[5]) + Math.floor(ply / 2);
      return ply % 2 === 0 ? `${number}.${move.san}` : index === 0 ? `${number}...${move.san}` : move.san;
    })
    .join(' ');
  const source: GameSource = raw.site;
  return {
    id: `${raw.site}-${(raw.externalId.split('/').pop() ?? '').replace(/[^\w-]/g, '').slice(0, 64)}`,
    date: new Date(Number.isFinite(raw.playedAt) && Math.abs(raw.playedAt) < 8.64e15 ? raw.playedAt : 0).toISOString(),
    pgn: `${headers.join('\n')}\n\n${moves} ${parsed.result}`,
    white,
    black,
    result: parsed.result,
    source,
    playerColor,
    externalId: raw.externalId,
  };
}

export interface ImportResult {
  added: SavedGame[];
  skipped: number;
  unreadable: number;
}

/** Fetches a player's recent games and drops any already imported. */
export async function importGames(
  site: Site,
  username: string,
  max: number,
  existingIds: Set<string>,
  fetcher: Fetcher = fetch,
): Promise<ImportResult> {
  const name = username.trim();
  if (!USERNAME.test(name)) throw new ImportError('That doesn\'t look like a valid username.');
  let raw: RawGame[];
  try {
    raw = site === 'lichess' ? await fetchLichess(name, max, fetcher) : await fetchChessCom(name, max, fetcher);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError(`Couldn't reach ${SITE_NAMES[site]}. Check your connection and try again.`);
  }
  const result: ImportResult = { added: [], skipped: 0, unreadable: 0 };
  for (const game of raw) {
    if (existingIds.has(game.externalId)) {
      result.skipped++;
      continue;
    }
    const saved = toSavedGame(game, name);
    if (saved) result.added.push(saved);
    else result.unreadable++;
  }
  return result;
}
