import { Chess } from 'chess.js';
import { uciToMove } from '../lib/chess';

export interface Puzzle {
  id: string;
  /** The position before the opponent's setup move. */
  fen: string;
  /** Solution in UCI. The first move is the opponent's, and then the solver's and replies alternate. */
  moves: string[];
  rating: number;
  themes: string[];
}

interface PuzzleFile {
  themes: string[];
  puzzles: [string, string, string, number, number[]][];
}

let loaded: Promise<Puzzle[]> | null = null;

/** Loads the puzzle set on first use, so that it doesn't slow down the app's startup. */
export function loadPuzzles(): Promise<Puzzle[]> {
  loaded ??= import('./puzzles.json')
    .then((module) => decodePuzzles(module.default as unknown as PuzzleFile))
    .catch((error: unknown) => {
      // Usually a new version replacing old files mid-session, so the next try or a reload can still succeed.
      loaded = null;
      throw error;
    });
  return loaded;
}

export function decodePuzzles(file: PuzzleFile): Puzzle[] {
  return file.puzzles.map(([id, fen, moves, rating, themes]) => ({
    id,
    fen,
    moves: moves.split(' '),
    rating,
    themes: themes.map((index) => file.themes[index]),
  }));
}

export const THEME_FILTERS: { id: string; label: string; themes: string[] }[] = [
  { id: 'all', label: 'Everything', themes: [] },
  { id: 'mate', label: 'Checkmates', themes: ['mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'backRankMate', 'smotheredMate'] },
  { id: 'fork', label: 'Forks', themes: ['fork'] },
  { id: 'pin', label: 'Pins', themes: ['pin'] },
  { id: 'skewer', label: 'Skewers', themes: ['skewer'] },
  { id: 'discovered', label: 'Discovered attacks', themes: ['discoveredAttack', 'doubleCheck'] },
  { id: 'hanging', label: 'Hanging pieces', themes: ['hangingPiece', 'trappedPiece'] },
  { id: 'deflection', label: 'Deflection and decoy', themes: ['deflection', 'attraction'] },
  { id: 'sacrifice', label: 'Sacrifices', themes: ['sacrifice'] },
  { id: 'quiet', label: 'Quiet moves and defence', themes: ['quietMove', 'defensiveMove', 'zugzwang'] },
  { id: 'opening', label: 'Opening', themes: ['opening'] },
  { id: 'middlegame', label: 'Middlegame', themes: ['middlegame'] },
  { id: 'endgame', label: 'Endgames', themes: ['endgame', 'rookEndgame', 'pawnEndgame', 'queenEndgame', 'bishopEndgame', 'knightEndgame'] },
];

/** A puzzle near the target rating, avoiding ones seen recently. Widens the search if none is close. */
export function pickPuzzle(
  puzzles: Puzzle[],
  target: number,
  seen: Set<string>,
  themes: string[] = [],
  random: () => number = Math.random,
): Puzzle | null {
  const themed = themes.length ? puzzles.filter((puzzle) => puzzle.themes.some((theme) => themes.includes(theme))) : puzzles;
  for (const spread of [75, 150, 300, 600, 3000]) {
    const near = themed.filter((puzzle) => Math.abs(puzzle.rating - target) <= spread && !seen.has(puzzle.id));
    if (near.length) return near[Math.floor(random() * near.length)];
  }
  return themed.length ? themed[Math.floor(random() * themed.length)] : null;
}

/** Whether a move solves this step: the listed move, or any move that mates at once. */
export function isCorrectMove(fen: string, expected: string, played: string): boolean {
  if (played === expected) return true;
  try {
    const chess = new Chess(fen);
    chess.move(uciToMove(played));
    return chess.isCheckmate();
  } catch {
    return false;
  }
}

export interface PuzzleRating {
  value: number;
  games: number;
}

export function expectedScore(rating: number, puzzleRating: number): number {
  return 1 / (1 + 10 ** ((puzzleRating - rating) / 400));
}

/** Elo update for a puzzle attempt. Moves faster at first, while your level is still unknown. */
export function updatePuzzleRating(current: PuzzleRating, puzzleRating: number, solved: boolean): PuzzleRating {
  const k = current.games < 30 ? 40 : 16;
  const value = Math.round(current.value + k * ((solved ? 1 : 0) - expectedScore(current.value, puzzleRating)));
  return { value: Math.max(100, value), games: current.games + 1 };
}
