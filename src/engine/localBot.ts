import { Chess, type Move, type PieceSymbol, type Square } from 'chess.js';
import { VALUES, moveToUci, type SimpleMove } from '../lib/chess';

/** A personality for the home-grown engine that plays below Stockfish's lowest strength setting. */
export interface LocalProfile {
  /** Half-moves searched. 0 picks uniformly at random. */
  depth: number;
  /** Random centipawns added to each root move, so the bot varies and misjudges. */
  noise: number;
  /** Chance per move of ignoring the search and playing a random move. */
  blunderRate: number;
  material: number;
  position: number;
  kingAttack: number;
  structure: number;
  /** Whether to resolve captures at the end of the search. Without it the bot walks into recaptures. */
  quiescence: boolean;
}

const CP: Record<PieceSymbol, number> = {
  p: VALUES.p * 100,
  n: VALUES.n * 100 + 20,
  b: VALUES.b * 100 + 30,
  r: VALUES.r * 100,
  q: VALUES.q * 100,
  k: 0,
};

// Piece-square tables from White's side, rank 8 first.
const CENTER = [
  -30, -20, -10, -10, -10, -10, -20, -30,
  -20, -5, 0, 0, 0, 0, -5, -20,
  -10, 0, 10, 12, 12, 10, 0, -10,
  -10, 5, 12, 20, 20, 12, 5, -10,
  -10, 0, 12, 20, 20, 12, 0, -10,
  -10, 5, 10, 12, 12, 10, 5, -10,
  -20, -5, 0, 5, 5, 0, -5, -20,
  -30, -20, -10, -10, -10, -10, -20, -30,
];
const PAWN = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];
const ROOK = [
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, 10, 10, 10, 10, 5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  0, 0, 0, 5, 5, 0, 0, 0,
];
const KING_SAFE = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20,
];
const TABLES: Record<PieceSymbol, number[]> = {
  p: PAWN,
  n: CENTER,
  b: CENTER,
  r: ROOK,
  q: CENTER.map((value) => Math.round(value / 3)),
  k: KING_SAFE,
};

/** Static evaluation in centipawns from the side to move's point of view. */
export function evaluate(chess: Chess, profile: LocalProfile): number {
  const board = chess.board();
  let score = 0;
  let whiteKing = { row: 7, col: 4 };
  let blackKing = { row: 0, col: 4 };
  const pawnsOnFile = { w: new Array(8).fill(0) as number[], b: new Array(8).fill(0) as number[] };

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (!piece) continue;
      if (piece.type === 'k') {
        if (piece.color === 'w') whiteKing = { row, col };
        else blackKing = { row, col };
      }
      if (piece.type === 'p') pawnsOnFile[piece.color][col]++;
    }
  }

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (!piece) continue;
      const sign = piece.color === 'w' ? 1 : -1;
      const index = piece.color === 'w' ? row * 8 + col : (7 - row) * 8 + col;
      let value = CP[piece.type] * profile.material + TABLES[piece.type][index] * profile.position;
      if (profile.kingAttack && piece.type !== 'k' && piece.type !== 'p') {
        const king = piece.color === 'w' ? blackKing : whiteKing;
        const distance = Math.max(Math.abs(king.row - row), Math.abs(king.col - col));
        value += (7 - distance) * 4 * profile.kingAttack * (piece.type === 'q' ? 2 : 1);
      }
      score += sign * value;
    }
  }

  if (profile.structure) {
    for (const color of ['w', 'b'] as const) {
      const sign = color === 'w' ? 1 : -1;
      const files = pawnsOnFile[color];
      for (let col = 0; col < 8; col++) {
        if (files[col] > 1) score -= sign * 15 * (files[col] - 1) * profile.structure;
        if (files[col] > 0 && !files[col - 1] && !files[col + 1]) score -= sign * 12 * profile.structure;
      }
    }
  }
  return chess.turn() === 'w' ? score : -score;
}

const MATE = 1_000_000;

function ordered(moves: Move[]): Move[] {
  const rank = (move: Move) =>
    (move.captured ? 10 * CP[move.captured] - CP[move.piece] + 1000 : 0) + (move.promotion ? 900 : 0);
  return moves.sort((a, b) => rank(b) - rank(a));
}

function quiesce(chess: Chess, alpha: number, beta: number, profile: LocalProfile, ply: number): number {
  const stand = evaluate(chess, profile);
  if (stand >= beta || ply >= 6) return stand;
  alpha = Math.max(alpha, stand);
  const captures = ordered(chess.moves({ verbose: true }).filter((move) => move.captured));
  for (const move of captures) {
    chess.move(move);
    const score = -quiesce(chess, -beta, -alpha, profile, ply + 1);
    chess.undo();
    if (score >= beta) return score;
    alpha = Math.max(alpha, score);
  }
  return alpha;
}

function search(chess: Chess, depth: number, alpha: number, beta: number, profile: LocalProfile, ply: number): number {
  if (depth === 0) {
    return profile.quiescence ? quiesce(chess, alpha, beta, profile, 0) : evaluate(chess, profile);
  }
  const moves = ordered(chess.moves({ verbose: true }));
  if (moves.length === 0) return chess.inCheck() ? -MATE + ply : 0;
  let best = -Infinity;
  for (const move of moves) {
    chess.move(move);
    const score = -search(chess, depth - 1, -beta, -alpha, profile, ply + 1);
    chess.undo();
    best = Math.max(best, score);
    alpha = Math.max(alpha, score);
    if (alpha >= beta) break;
  }
  return best;
}

export interface StyleProfile extends LocalProfile {
  /** Bonus in centipawns for giving check. */
  checkBonus: number;
  /** Bonus in centipawns for a capture. */
  captureBonus: number;
}

/**
 * Chooses among shallow engine lines by playing style, so that a bot plays sound chess with a personality.
 * JavaScript search alone is too slow for these strengths, so Stockfish supplies the candidates.
 */
export function chooseStyled(
  fen: string,
  lines: { move: string; score: { cp: number | null; mate: number | null } }[],
  style: StyleProfile,
  random: () => number = Math.random,
): string {
  if (lines.length === 0) throw new Error('No candidate moves');
  if (random() < style.blunderRate) return lines[Math.floor(random() * lines.length)].move;
  const chess = new Chess(fen);
  const white = chess.turn() === 'w';
  const baseStyle = evaluate(chess, { ...style, material: 0 });
  let best = lines[0].move;
  let bestValue = -Infinity;
  for (const line of lines) {
    const raw = line.score.mate !== null ? (line.score.mate > 0 ? 20000 : -20000) : (line.score.cp ?? 0);
    const engineValue = white ? raw : -raw;
    const move = chess.move({ from: line.move.slice(0, 2), to: line.move.slice(2, 4), promotion: line.move[4] });
    // After the move the side to move has flipped, so the static score is negated back to the mover.
    let value = engineValue + (-evaluate(chess, { ...style, material: 0 }) - baseStyle);
    if (chess.inCheck()) value += style.checkBonus;
    if (move.captured) value += style.captureBonus;
    chess.undo();
    value += (random() - 0.5) * 2 * style.noise;
    if (value > bestValue) {
      bestValue = value;
      best = line.move;
    }
  }
  return best;
}

/** Picks a move. The random source is a parameter so that tests can be repeatable. */
export function chooseMove(fen: string, profile: LocalProfile, random: () => number = Math.random): string {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) throw new Error('No legal moves');

  const toUci = (move: Move) =>
    moveToUci({ from: move.from as Square, to: move.to as Square, promotion: move.promotion } as SimpleMove);

  if (profile.depth === 0 || random() < profile.blunderRate) {
    return toUci(moves[Math.floor(random() * moves.length)]);
  }

  let bestScore = -Infinity;
  let bestMove = moves[0];
  for (const move of ordered(moves)) {
    chess.move(move);
    // Every searching bot takes a mate in one, or games against weak bots would never finish.
    if (chess.isCheckmate()) return toUci(move);
    const score = -search(chess, profile.depth - 1, -Infinity, Infinity, profile, 1);
    chess.undo();
    const noisy = score + (random() - 0.5) * 2 * profile.noise;
    if (noisy > bestScore) {
      bestScore = noisy;
      bestMove = move;
    }
  }
  return toUci(bestMove);
}
