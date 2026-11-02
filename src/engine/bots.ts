import { chooseStyled, type LocalProfile, type StyleProfile } from './localBot';
import { opponentEngine } from './uci';

export interface Bot {
  id: string;
  name: string;
  /**
   * Measured in a 440-game tournament between the bots at these exact settings (`npm run calibrate`), anchored to
   * Stockfish's own Elo settings. See calibration/results.json. Pip is floored at 100, and Unleashed is a lower bound.
   */
  rating: number;
  rank: string;
  blurb: string;
  engine: 'local' | 'styled' | 'stockfish';
  profile?: LocalProfile;
  style?: StyleProfile & { searchDepth: number; candidates: number };
  stockfish?: { elo?: number; movetime: number };
}

const base = { material: 1, position: 0, kingAttack: 0, structure: 0, quiescence: false };

export const BOTS: Bot[] = [
  {
    id: 'pip',
    name: 'Pip',
    rating: 100,
    rank: 'Novice',
    blurb: 'Plays completely random legal moves. Good for trying the rules out.',
    engine: 'local',
    profile: { ...base, depth: 0, noise: 0, blunderRate: 1 },
  },
  {
    id: 'gus',
    name: 'Greedy Gus',
    rating: 400,
    rank: 'Novice',
    blurb: 'Grabs whatever is on offer and never looks at what happens next.',
    engine: 'local',
    profile: { ...base, depth: 1, noise: 40, blunderRate: 0.05 },
  },
  {
    id: 'nell',
    name: 'Nell',
    rating: 950,
    rank: 'Beginner',
    blurb: 'Sees your reply, but still drops pieces now and then.',
    engine: 'local',
    profile: { ...base, position: 0.5, depth: 2, noise: 60, blunderRate: 0.1 },
  },
  {
    id: 'ash',
    name: 'Ash the Attacker',
    rating: 1150,
    rank: 'Intermediate',
    blurb: 'Throws every piece at your king. Punishes passivity, overlooks counterplay.',
    engine: 'styled',
    style: { ...base, position: 0.2, kingAttack: 4, depth: 0, noise: 190, blunderRate: 0.24, checkBonus: 90, captureBonus: 40, searchDepth: 1, candidates: 14 },
  },
  {
    id: 'petra',
    name: 'Positional Petra',
    rating: 1300,
    rank: 'Intermediate',
    blurb: 'Solid pawns, good squares, patient play. Loses mostly to sharp tactics.',
    engine: 'styled',
    style: { ...base, position: 1, structure: 2.5, depth: 0, noise: 140, blunderRate: 0.17, checkBonus: 0, captureBonus: 0, searchDepth: 1, candidates: 12 },
  },
  {
    id: 'sf1320',
    name: 'Stockfish Level 1',
    rating: 1450,
    rank: 'Club',
    blurb: 'Plays sensibly, with lapses you can punish. Stockfish at its weakest setting.',
    engine: 'stockfish',
    stockfish: { elo: 1320, movetime: 400 },
  },
  {
    id: 'sf1600',
    name: 'Stockfish Level 2',
    rating: 1750,
    rank: 'Club',
    blurb: 'A strong club player. Rarely hangs anything.',
    engine: 'stockfish',
    stockfish: { elo: 1600, movetime: 500 },
  },
  {
    id: 'sf1900',
    name: 'Stockfish Level 3',
    rating: 1850,
    rank: 'Expert',
    blurb: 'Tournament strength. Converts small advantages.',
    engine: 'stockfish',
    stockfish: { elo: 1900, movetime: 600 },
  },
  {
    id: 'sf2200',
    name: 'Stockfish Level 4',
    rating: 1950,
    rank: 'Expert',
    blurb: 'Tough in every phase, and rarely makes a tactical error.',
    engine: 'stockfish',
    stockfish: { elo: 2200, movetime: 800 },
  },
  {
    id: 'sf2500',
    name: 'Stockfish Level 5',
    rating: 2150,
    rank: 'Master',
    blurb: 'Strong master play. You will need a real plan.',
    engine: 'stockfish',
    stockfish: { elo: 2500, movetime: 1000 },
  },
  {
    id: 'sf2800',
    name: 'Stockfish Level 6',
    rating: 2450,
    rank: 'Grandmaster',
    blurb: 'Grandmaster-level play.',
    engine: 'stockfish',
    stockfish: { elo: 2800, movetime: 1500 },
  },
  {
    id: 'sfmax',
    name: 'Stockfish Unleashed',
    rating: 3000,
    rank: 'Engine',
    blurb: 'No limits, with 2.5 seconds a move. Stronger than any human.',
    engine: 'stockfish',
    stockfish: { movetime: 2500 },
  },
];

/** The rating as shown to players. The strongest bot only has a lower bound, because it never lost. */
export const ratingLabel = (bot: Bot) => (bot.id === 'sfmax' ? `${bot.rating}+` : String(bot.rating));

export const botById = (id: string) => BOTS.find((bot) => bot.id === id) ?? BOTS[0];

let worker: Worker | null = null;
let nextId = 1;

function askLocalBot(fen: string, profile: LocalProfile): Promise<string> {
  worker ??= new Worker(new URL('./localBot.worker.ts', import.meta.url), { type: 'module' });
  const id = nextId++;
  const current = worker;
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<{ id: number; move: string }>) => {
      if (event.data.id !== id) return;
      cleanup();
      resolve(event.data.move);
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      // A failed worker is replaced, so that one bad move request can't stop every later one.
      current.terminate();
      if (worker === current) worker = null;
      reject(new Error(event.message));
    };
    const cleanup = () => {
      current.removeEventListener('message', onMessage);
      current.removeEventListener('error', onError);
    };
    current.addEventListener('message', onMessage);
    current.addEventListener('error', onError);
    current.postMessage({ id, fen, profile });
  });
}

/** Applies a bot's strength settings. Call once when a game starts. */
export async function prepareBot(bot: Bot) {
  if (bot.engine === 'local') return;
  await opponentEngine.newGame();
  const elo = bot.stockfish?.elo;
  await opponentEngine.setOption('UCI_LimitStrength', elo !== undefined);
  if (elo !== undefined) await opponentEngine.setOption('UCI_Elo', elo);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks a bot for its move in UCI form. Instant replies feel jarring, so untimed games take a brief moment.
 * `limitMs` caps the thinking time when clocks are running.
 */
export async function botMove(bot: Bot, fen: string, limitMs?: number): Promise<string> {
  const pause = wait(limitMs === undefined ? 200 : 0);
  let move: string | undefined;
  if (bot.engine === 'local' && bot.profile) {
    move = await askLocalBot(fen, bot.profile);
  } else if (bot.engine === 'styled' && bot.style) {
    const analysis = await opponentEngine.search(fen, { depth: bot.style.searchDepth, multipv: bot.style.candidates });
    move = chooseStyled(fen, analysis.lines, bot.style);
  } else {
    const normal = bot.stockfish?.movetime ?? 500;
    const analysis = await opponentEngine.search(fen, { movetime: limitMs === undefined ? normal : Math.min(normal, limitMs) });
    move = analysis.lines[0]?.move;
  }
  await pause;
  if (!move) throw new Error(`${bot.name} did not return a move.`);
  return move;
}
