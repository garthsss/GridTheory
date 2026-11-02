import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const VALUES: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};
export const COLOR_NAMES: Record<Color, string> = { w: 'White', b: 'Black' };

export interface SimpleMove {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
}

export const other = (color: Color): Color => (color === 'w' ? 'b' : 'w');
export const turnOf = (fen: string): Color => (fen.split(' ')[1] === 'b' ? 'b' : 'w');

export function uciToMove(uci: string): SimpleMove {
  return {
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    promotion: (uci[4] as PieceSymbol) || undefined,
  };
}

export function moveToUci(move: SimpleMove): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

/** Returns the SAN of a UCI move, or the UCI text if the move is not legal in this position. */
export function sanFromUci(fen: string, uci: string): string {
  try {
    return new Chess(fen).move(uciToMove(uci)).san;
  } catch {
    return uci;
  }
}

/** Formats a line of UCI moves as numbered SAN, stopping at the first move that is not legal. */
export function pvToSan(fen: string, pv: string[], maxPlies = 6): string {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const uci of pv.slice(0, maxPlies)) {
    const number = Number(chess.fen().split(' ')[5]);
    const isWhite = chess.turn() === 'w';
    try {
      const move = chess.move(uciToMove(uci));
      out.push(isWhite ? `${number}.${move.san}` : out.length === 0 ? `${number}...${move.san}` : move.san);
    } catch {
      break;
    }
  }
  return out.join(' ');
}

/** Material from White's point of view, in pawns. */
export function materialBalance(fen: string): number {
  let total = 0;
  for (const row of new Chess(fen, { skipValidation: true }).board()) {
    for (const piece of row) {
      if (piece) total += piece.color === 'w' ? VALUES[piece.type] : -VALUES[piece.type];
    }
  }
  return total;
}

export function totalMaterial(fen: string): number {
  let total = 0;
  for (const row of new Chess(fen, { skipValidation: true }).board()) {
    for (const piece of row) if (piece) total += VALUES[piece.type];
  }
  return total;
}

/**
 * True if the position can't arise in a game, or is one Stockfish refuses. chess.js accepts these, but the engine
 * then aborts and answers for the previous position instead, so anything from outside the app must pass this first.
 */
export function isIllegalPosition(fen: string): boolean {
  const parts = fen.split(' ');
  // Far past anything the rules allow, and well inside what the engine accepts.
  if (Number(parts[4]) > 150 || Number(parts[5]) > 10000) return true;
  const chess = new Chess(fen, { skipValidation: true });
  const counts = { w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } };
  for (const piece of chess.board().flat()) if (piece) counts[piece.color][piece.type]++;
  for (const side of ['w', 'b'] as const) {
    const c = counts[side];
    if (c.k !== 1 || c.p > 8) return true;
    // Every piece beyond the starting set must have been a pawn that promoted.
    const promoted = Math.max(0, c.q - 1) + Math.max(0, c.r - 2) + Math.max(0, c.b - 2) + Math.max(0, c.n - 2);
    if (c.p + promoted > 8) return true;
  }
  const waiting = other(chess.turn());
  const king = chess.board().flat().find((piece) => piece?.type === 'k' && piece.color === waiting);
  return king ? chess.isAttacked(king.square, chess.turn()) : true;
}

export type GameEnd =
  | { over: false }
  | { over: true; result: '1-0' | '0-1' | '1/2-1/2'; reason: string };

export function gameEnd(chess: Chess): GameEnd {
  if (chess.isCheckmate()) {
    return { over: true, result: chess.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
  }
  if (chess.isStalemate()) return { over: true, result: '1/2-1/2', reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'insufficient material' };
  if (chess.isThreefoldRepetition()) return { over: true, result: '1/2-1/2', reason: 'threefold repetition' };
  if (chess.isDrawByFiftyMoves()) return { over: true, result: '1/2-1/2', reason: 'the fifty-move rule' };
  return { over: false };
}

export interface ParsedGame {
  headers: Record<string, string>;
  startFen: string;
  moves: { san: string; uci: string; fenBefore: string; fenAfter: string }[];
  result: string;
}

export class PgnError extends Error {}

function stripMovetext(text: string): string {
  const out: string[] = [];
  let braces = 0;
  let parens = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (braces > 0) {
      if (ch === '}') braces--;
    } else if (ch === '{') {
      braces++;
    } else if (ch === ';') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '(') {
      parens++;
    } else if (ch === ')') {
      parens = Math.max(0, parens - 1);
    } else if (parens === 0) {
      out.push(ch);
    }
  }
  return out.join('');
}

/** Hard limits on pasted or uploaded games, so that a huge or hostile file can't freeze the page. */
export const PGN_LIMITS = {
  /** Characters in one paste or file. */
  input: 5_000_000,
  games: 500,
  /** Half-moves in one game. The longest tournament game ever played had under 550. */
  plies: 1500,
  token: 64,
  headerValue: 300,
  headers: 64,
};

const TAG_LINE = /^\[(\w{1,40})\s+"([^"]*)"\]$/;

/**
 * Parses a single game. Accepts full PGN and bare movetext such as "1.e4 e5 2.Nf3" or "e4 e5 Nf3".
 * Hand-rolled rather than chess.js's loadPgn so a typo can be reported with its move number.
 * It works line by line and token by token, because regexes run across untrusted text can take forever.
 */
export function parseGame(input: string): ParsedGame {
  if (input.length > PGN_LIMITS.input) throw new PgnError('That game is too large to read.');
  // No prototype, so that a tag named __proto__ is just a tag.
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  const body: string[] = [];
  let tagCount = 0;
  for (const raw of input.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const tag = line.startsWith('[') && line.endsWith(']') ? TAG_LINE.exec(line) : null;
    if (tag && tagCount < PGN_LIMITS.headers) {
      // eslint-disable-next-line no-control-regex
      headers[tag[1]] = tag[2].replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, PGN_LIMITS.headerValue);
      tagCount++;
    } else if (!tag) {
      body.push(raw);
    }
  }

  const tokens = stripMovetext(body.join('\n')).split(/\s+/).filter(Boolean);
  let result = headers.Result ?? '*';
  const startFen = headers.FEN ?? START_FEN;
  let chess: Chess;
  try {
    chess = new Chess(startFen);
  } catch {
    throw new PgnError(`The FEN header is not a valid position: ${startFen.slice(0, 100)}`);
  }
  if (isIllegalPosition(startFen)) {
    throw new PgnError(`The FEN header is not a legal position: ${startFen.slice(0, 100)}`);
  }

  const moves: ParsedGame['moves'] = [];
  for (const rawToken of tokens) {
    if (rawToken.length > PGN_LIMITS.token) throw new PgnError(`"${rawToken.slice(0, 20)}…" is not a chess move.`);
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(rawToken)) {
      result = rawToken;
      continue;
    }
    // Move numbers may be attached ("12.Nf3") or separate ("12. Nf3", "12 Nf3"), and NAGs like $1 are just notes.
    const token = rawToken.replace(/^\d*\.+/, '');
    if (!token || /^\d+$/.test(token) || /^\$\d+$/.test(token)) continue;
    if (moves.length >= PGN_LIMITS.plies) throw new PgnError(`That game has more than ${PGN_LIMITS.plies} moves.`);
    const san = token.replace(/[!?]+$/, '').replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O');
    const fenBefore = chess.fen();
    const moveNumber = fenBefore.split(' ')[5];
    const side = chess.turn() === 'w' ? '' : '...';
    try {
      const move = chess.move(san);
      moves.push({ san: move.san, uci: moveToUci(move as SimpleMove), fenBefore, fenAfter: chess.fen() });
    } catch {
      throw new PgnError(`Move ${moveNumber}${side} "${token}" is not legal in this position.`);
    }
  }
  if (moves.length === 0) throw new PgnError('No moves found. Paste a PGN or a move list like "1.e4 e5 2.Nf3 Nc6".');
  return { headers, startFen, moves, result };
}

/** Splits a multi-game PGN file into one string per game. */
export function splitGames(input: string): string[] {
  if (input.length > PGN_LIMITS.input) throw new PgnError('That file is too large. The limit is 5 MB at a time.');
  const games: string[] = [];
  let current: string[] = [];
  let seenMoves = false;
  for (const line of input.replace(/\r/g, '').split('\n')) {
    const trimmed = line.trim();
    const isTag = trimmed.startsWith('[') && trimmed.endsWith(']') && TAG_LINE.test(trimmed);
    // A tag after movetext starts the next game, whichever tag happens to come first.
    if (isTag && seenMoves) {
      games.push(current.join('\n'));
      current = [];
      seenMoves = false;
    }
    if (!isTag && trimmed) seenMoves = true;
    current.push(line);
  }
  games.push(current.join('\n'));
  const out = games.map((game) => game.trim()).filter(Boolean);
  if (out.length > PGN_LIMITS.games) throw new PgnError(`That file has ${out.length} games. The limit is ${PGN_LIMITS.games} at a time.`);
  return out;
}

/** Replays a space-separated list of SAN moves and returns the resulting FEN. */
export function fenFromMoves(moves: string, startFen = START_FEN): string {
  const chess = new Chess(startFen);
  for (const san of moves.split(/\s+/).filter(Boolean)) chess.move(san);
  return chess.fen();
}

export const stripSuffix = (san: string) => san.replace(/[+#!?]+$/, '');
