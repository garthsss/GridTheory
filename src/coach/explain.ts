import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import {
  COLOR_NAMES,
  PIECE_NAMES,
  VALUES,
  materialBalance,
  other,
  pvToSan,
  sanFromUci,
  turnOf,
  uciToMove,
} from '../lib/chess';
import { classify, formatScore, scoreOf, winPercentFor, type Analysis, type MoveClass, type Score } from '../engine/score';

export type Motif =
  | 'mate'
  | 'check'
  | 'double-check'
  | 'discovered'
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'free-capture'
  | 'back-rank';

export const MOTIF_NAMES: Record<Motif, string> = {
  mate: 'checkmate',
  check: 'check',
  'double-check': 'double check',
  discovered: 'discovered attack',
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  'free-capture': 'free capture',
  'back-rank': 'back-rank mate',
};

const RAYS: Record<string, [number, number][]> = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};

const sq = (file: number, rank: number) => `${'abcdefgh'[file]}${rank + 1}` as Square;

/** Tactical patterns created by playing a move. Purely geometric, so it needs no engine. */
export function detectMotifs(fen: string, uci: string): Motif[] {
  const chess = new Chess(fen);
  const mover = chess.turn();
  const enemy = other(mover);
  const beforeAttackers = new Map<Square, Square[]>();
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece?.color === enemy) beforeAttackers.set(piece.square, chess.attackers(piece.square, mover));
    }
  }
  let move;
  try {
    move = chess.move(uciToMove(uci));
  } catch {
    return [];
  }
  const motifs = new Set<Motif>();

  const kingSquare = chess.board().flat().find((p) => p?.type === 'k' && p.color === enemy)?.square;
  if (chess.isCheckmate()) {
    motifs.add('mate');
    const backRank = enemy === 'w' ? '1' : '8';
    if (kingSquare?.[1] === backRank && (move.piece === 'r' || move.piece === 'q') && move.to[1] === backRank) {
      motifs.add('back-rank');
    }
  } else if (chess.inCheck()) {
    motifs.add('check');
  }
  if (kingSquare && chess.attackers(kingSquare, mover).length >= 2) motifs.add('double-check');

  if (move.captured && chess.attackers(move.to, enemy).length === 0) motifs.add('free-capture');

  const movedValue = VALUES[move.promotion ?? move.piece];
  const moverSafe =
    chess.attackers(move.to, enemy).length === 0 || chess.attackers(move.to, mover).length > 0;

  // Fork: the moved piece attacks two targets that are either worth more than it or undefended.
  const targets = chess
    .board()
    .flat()
    .filter((piece) => piece?.color === enemy && piece.type !== 'p')
    .filter((piece) => chess.attackers(piece!.square, mover).includes(move.to))
    .filter(
      (piece) =>
        piece!.type === 'k' ||
        VALUES[piece!.type] > movedValue ||
        chess.attackers(piece!.square, enemy).length === 0,
    );
  if (targets.length >= 2 && moverSafe) motifs.add('fork');

  // Pin or skewer: a sliding piece looks through one enemy piece at another.
  const rays = RAYS[move.promotion ?? move.piece];
  if (rays && moverSafe) {
    const fromFile = move.to.charCodeAt(0) - 97;
    const fromRank = Number(move.to[1]) - 1;
    for (const [df, dr] of rays) {
      const hits: { type: PieceSymbol; color: Color }[] = [];
      for (let f = fromFile + df, r = fromRank + dr; f >= 0 && f < 8 && r >= 0 && r < 8; f += df, r += dr) {
        const piece = chess.get(sq(f, r));
        if (piece) {
          hits.push(piece);
          if (hits.length === 2) break;
        }
      }
      if (hits.length === 2 && hits[0].color === enemy && hits[1].color === enemy) {
        const first = hits[0].type === 'k' ? 100 : VALUES[hits[0].type];
        const second = hits[1].type === 'k' ? 100 : VALUES[hits[1].type];
        if (second > first && second > VALUES.p && first <= movedValue) motifs.add('pin');
        if (first > second && hits[1].type !== 'p') motifs.add('skewer');
      }
    }
  }

  // Discovered attack: moving away uncovers a different piece's attack on something valuable.
  for (const [square, attackers] of beforeAttackers) {
    const piece = chess.get(square);
    if (!piece || piece.color !== enemy) continue;
    const fresh = chess
      .attackers(square, mover)
      .filter((attacker) => attacker !== move.to && !attackers.includes(attacker));
    const valuable = piece.type === 'k' || VALUES[piece.type] >= VALUES.r;
    if (fresh.length > 0 && valuable) motifs.add('discovered');
  }
  return [...motifs];
}

/** Pieces of a colour that can be taken profitably right now. */
export function hangingPieces(fen: string, color: Color): { square: Square; type: PieceSymbol }[] {
  const chess = new Chess(fen, { skipValidation: true });
  const enemy = other(color);
  const out: { square: Square; type: PieceSymbol }[] = [];
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== color || piece.type === 'k' || piece.type === 'p') continue;
      const attackers = chess.attackers(piece.square, enemy);
      if (attackers.length === 0) continue;
      const defended = chess.attackers(piece.square, color).length > 0;
      const cheapest = Math.min(...attackers.map((a) => VALUES[chess.get(a)!.type] || 100));
      if (!defended || cheapest < VALUES[piece.type]) out.push({ square: piece.square, type: piece.type });
    }
  }
  return out;
}

/** A mate the opponent would have next move if it were their turn. */
export function mateThreat(fen: string): string | null {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  let chess: Chess;
  try {
    chess = new Chess(parts.join(' '));
  } catch {
    return null;
  }
  if (new Chess(fen).inCheck()) return null;
  for (const move of chess.moves()) {
    if (move.endsWith('#')) return move;
  }
  return null;
}

export type Theme =
  | 'hung-piece'
  | 'allowed-mate'
  | 'missed-mate'
  | 'missed-tactic'
  | 'allowed-tactic'
  | 'opening'
  | 'positional';

export interface MoveReport {
  san: string;
  uci: string;
  color: Color;
  fenBefore: string;
  fenAfter: string;
  winBefore: number;
  winAfter: number;
  loss: number;
  cls: MoveClass;
  bestUci: string | null;
  bestSan: string | null;
  bestLine: string;
  bestMotifs: Motif[];
  replyUci: string | null;
  replySan: string | null;
  replyLine: string;
  scoreAfter: Score;
  themes: Theme[];
  /** One sentence naming what went wrong. Empty for good moves. */
  headline: string;
  /** Further detail: the concrete line and what to look for next time. */
  detail: string;
}

/** Material change for `color` over a line of moves, in pawns. */
function lineGain(fen: string, pv: string[], color: Color, plies = 6): number {
  const chess = new Chess(fen);
  const start = materialBalance(fen);
  // End after a capture sequence settles: stop at an even number of plies from the mover's perspective.
  let lastFen = fen;
  for (const uci of pv.slice(0, plies)) {
    try {
      chess.move(uciToMove(uci));
      lastFen = chess.fen();
    } catch {
      break;
    }
  }
  const delta = materialBalance(lastFen) - start;
  return color === 'w' ? delta : -delta;
}

function pieceNameAt(fen: string, square: Square): string | null {
  const piece = new Chess(fen, { skipValidation: true }).get(square);
  return piece ? PIECE_NAMES[piece.type] : null;
}

function openingNote(fenBefore: string, uci: string): string | null {
  const moveNumber = Number(fenBefore.split(' ')[5]);
  if (moveNumber > 10) return null;
  const chess = new Chess(fenBefore);
  const color = chess.turn();
  const { from } = uciToMove(uci);
  const piece = chess.get(from);
  if (!piece) return null;
  const home = color === 'w' ? '1' : '8';
  const undeveloped = chess
    .board()
    .flat()
    .filter((p) => p?.color === color && (p.type === 'n' || p.type === 'b') && p.square[1] === home).length;
  if (piece.type === 'q' && moveNumber <= 6 && undeveloped >= 2) {
    return 'Bringing the queen out early lets your opponent develop with tempo by attacking it.';
  }
  if ((piece.type === 'n' || piece.type === 'b') && from[1] !== home && undeveloped >= 2) {
    return `You moved a piece that was already developed while ${undeveloped} minor pieces are still at home.`;
  }
  if (piece.type === 'p' && 'abgh'.includes(from[0]) && undeveloped >= 2) {
    return 'Flank pawn moves rarely help this early. Centre pawns and developing moves do more.';
  }
  if (piece.type === 'r' && undeveloped >= 1) {
    return 'Rooks need open lines, and those usually come after your minor pieces are out and you have castled.';
  }
  return null;
}

/** What a capture nets once both sides have traded on that square for as long as it pays. */
function exchangeValue(fen: string, capture: { from: Square; to: Square; promotion?: PieceSymbol }): number {
  const chess = new Chess(fen);
  const played = chess.move(capture);
  const gain = VALUES[played.captured ?? 'p'];
  const replies = chess.moves({ verbose: true }).filter((reply) => reply.to === played.to && reply.captured);
  if (replies.length === 0) return gain;
  const cheapest = replies.reduce((a, b) => (VALUES[b.piece] < VALUES[a.piece] ? b : a));
  return gain - Math.max(0, exchangeValue(chess.fen(), cheapest));
}

/** The side to move's most profitable capture of a piece. `discount` lowers what a given capture is worth. */
function bestPieceCapture(fen: string, discount: (to: Square) => number = () => 0): { piece: PieceSymbol; square: Square; value: number } | null {
  let best: { piece: PieceSymbol; square: Square; value: number } | null = null;
  for (const capture of new Chess(fen).moves({ verbose: true })) {
    if (!capture.captured || capture.captured === 'p' || capture.captured === 'k') continue;
    const value = exchangeValue(fen, capture) - discount(capture.to);
    if (value > (best?.value ?? 0)) best = { piece: capture.captured, square: capture.to, value };
  }
  return best;
}

/** The material a move loses overall to the best capture in reply, and the piece that capture takes. */
function materialGivenUp(fen: string, candidate: { from: Square; to: Square; promotion?: PieceSymbol }) {
  const chess = new Chess(fen);
  const move = chess.move(candidate);
  // A promoted piece only ever cost a pawn.
  const taken = bestPieceCapture(chess.fen(), (to) => (move.promotion && to === move.to ? VALUES[move.promotion] - VALUES.p : 0));
  return { taken, net: (taken?.value ?? 0) - (move.captured ? VALUES[move.captured] : 0) };
}

/**
 * The piece a move gives up, if any: at least two points of material more than the safest move would have lost.
 * So ignoring an attack on your queen counts, but escaping a fork or grabbing a pawn with a trapped piece doesn't.
 */
export function findSacrifice(fenBefore: string, uci: string): { piece: PieceSymbol; square: Square } | null {
  const { taken, net } = materialGivenUp(fenBefore, uciToMove(uci));
  if (!taken || net < 2) return null;
  const moves = new Chess(fenBefore).moves({ verbose: true });
  const unavoidable = Math.max(0, Math.min(...moves.map((move) => materialGivenUp(fenBefore, move).net)));
  return net - unavoidable >= 2 ? { piece: taken.piece, square: taken.square } : null;
}

// A move can't be brilliant if it leaves you worse, or if another move was winning anyway (about +5 or better).
const BRILLIANT_MIN_WIN_AFTER = 45;
const ALREADY_WINNING = 86;

/** Turns two engine analyses into a graded explanation of one move. */
export function buildMoveReport(fenBefore: string, uci: string, before: Analysis, after: Analysis): MoveReport {
  const color = turnOf(fenBefore);
  const opponent = other(color);
  const chess = new Chess(fenBefore);
  const move = chess.move(uciToMove(uci));
  const fenAfter = chess.fen();

  const scoreBefore = scoreOf(before, color);
  const scoreAfter = scoreOf(after, opponent);
  const best = before.lines[0] ?? null;
  const wasBest = best?.move === uci;
  const winBefore = winPercentFor(scoreBefore, color);
  const winAfter = winPercentFor(scoreAfter, color);
  const loss = wasBest ? 0 : Math.max(0, winBefore - winAfter);
  const cls = classify(loss, wasBest);

  const reply = after.lines[0] ?? null;
  const replySan = reply ? sanFromUci(fenAfter, reply.move) : null;
  const report: MoveReport = {
    san: move.san,
    uci,
    color,
    fenBefore,
    fenAfter,
    winBefore,
    winAfter,
    loss,
    cls,
    bestUci: best?.move ?? null,
    bestSan: best ? sanFromUci(fenBefore, best.move) : null,
    bestLine: best ? pvToSan(fenBefore, best.pv) : '',
    bestMotifs: best ? detectMotifs(fenBefore, best.move) : [],
    replyUci: reply?.move ?? null,
    replySan,
    replyLine: reply ? pvToSan(fenAfter, reply.pv) : '',
    scoreAfter,
    themes: [],
    headline: '',
    detail: '',
  };
  // Needs a second engine line, because a sacrifice is only special if the alternatives weren't winning too.
  const alternative = before.lines.find((line) => line.move !== uci);
  if (cls === 'best' && alternative && winAfter >= BRILLIANT_MIN_WIN_AFTER && winPercentFor(alternative.score, color) < ALREADY_WINNING) {
    const sacrifice = findSacrifice(fenBefore, uci);
    if (sacrifice) {
      report.cls = 'brilliant';
      report.headline = `${move.san} sacrifices your ${PIECE_NAMES[sacrifice.piece]} on ${sacrifice.square}, and it works.`;
      report.detail = `The engine's main line is ${report.replyLine}. The best alternative was ${sanFromUci(fenBefore, alternative.move)} (${formatScore(alternative.score)}).`;
      return report;
    }
  }
  if (cls === 'best' || cls === 'good') return report;

  const themes: Theme[] = [];
  const parts: string[] = [];
  const opp = COLOR_NAMES[opponent];

  const mateFor = (score: Score, side: Color) =>
    score.mate !== null && (side === 'w' ? score.mate > 0 : score.mate < 0) ? Math.abs(score.mate) : null;
  const allowedMate = mateFor(scoreAfter, opponent);
  const hadMate = mateFor(scoreBefore, color);
  const stillMate = mateFor(scoreAfter, color);
  // Check just the capture and its answer too: later trades in a long line can hide a piece that was simply lost.
  const replyGain = reply ? Math.max(lineGain(fenAfter, reply.pv, opponent), lineGain(fenAfter, reply.pv, opponent, 2)) : 0;
  const bestGain = best ? lineGain(fenBefore, best.pv, color) : 0;

  if (allowedMate !== null) {
    themes.push('allowed-mate');
    report.headline =
      allowedMate === 1
        ? `${move.san} allows mate on the next move: ${replySan}.`
        : `${move.san} lets ${opp} force mate in ${allowedMate}, starting with ${replySan}.`;
    parts.push(`The line is ${report.replyLine}.`);
    parts.push('Before each move, check what your opponent can do with checks and captures in reply.');
  } else if (hadMate !== null && stillMate === null) {
    themes.push('missed-mate');
    report.headline = `You had a forced mate in ${hadMate}, starting with ${report.bestSan}.`;
    parts.push(`The line is ${report.bestLine}.`);
  } else if (replyGain >= 2 && reply) {
    const capture = new Chess(fenAfter).move(uciToMove(reply.move));
    const motifs = detectMotifs(fenAfter, reply.move);
    if (capture.captured) {
      themes.push('hung-piece');
      const name = PIECE_NAMES[capture.captured];
      const isMoved = capture.to === move.to;
      report.headline = isMoved
        ? `${move.san} puts your ${PIECE_NAMES[move.piece]} where ${opp} can win it with ${replySan}.`
        : `${move.san} leaves your ${name} on ${capture.to} undefended against ${replySan}.`;
    } else {
      themes.push('allowed-tactic');
      const motif = motifs.find((m) => m !== 'check');
      report.headline = motif
        ? `${move.san} allows ${replySan}, a ${MOTIF_NAMES[motif]} that wins material.`
        : `${move.san} allows ${replySan}, which wins material.`;
    }
    parts.push(`The line is ${report.replyLine}.`);
    parts.push('Ask "what does their last move attack, and what did my move stop defending?" before you commit.');
  } else if (bestGain >= 2 && report.bestSan) {
    themes.push('missed-tactic');
    const motif = report.bestMotifs.find((m) => m !== 'check');
    report.headline = motif
      ? `You missed ${report.bestSan}, a ${MOTIF_NAMES[motif]} that wins material.`
      : `You missed ${report.bestSan}, which wins material.`;
    parts.push(`The line is ${report.bestLine}.`);
    parts.push('Look through every check and capture available to you before settling on a quiet move.');
  } else {
    const note = openingNote(fenBefore, uci);
    themes.push(note ? 'opening' : 'positional');
    report.headline = `${move.san} gives up about ${Math.round(loss)}% of your win chances. ${report.bestSan} was stronger.`;
    if (note) parts.push(note);
    parts.push(`The engine's line is ${report.bestLine} (${formatScore(best!.score)}).`);
  }

  report.themes = themes;
  report.detail = parts.join(' ');
  return report;
}

export interface Threat {
  text: string;
  squares: Square[];
}

/** What the opponent is threatening right now, for the coach's "any threats?" check. */
export function findThreats(fen: string, color: Color): Threat[] {
  const threats: Threat[] = [];
  const mate = mateThreat(fen);
  if (mate) threats.push({ text: `${COLOR_NAMES[other(color)]} threatens mate with ${mate}.`, squares: [] });
  for (const piece of hangingPieces(fen, color)) {
    threats.push({
      text: `Your ${PIECE_NAMES[piece.type]} on ${piece.square} can be won.`,
      squares: [piece.square],
    });
  }
  return threats;
}

/** A plain-language read of the position. Uses material and development, plus the engine's top line. */
export function positionSummary(fen: string, color: Color, analysis?: Analysis): string {
  const chess = new Chess(fen);
  const parts: string[] = [];
  const balance = materialBalance(fen) * (color === 'w' ? 1 : -1);
  if (balance >= 1) parts.push(`You are ahead by ${balance} point${balance === 1 ? '' : 's'} of material, so trades favour you.`);
  else if (balance <= -1) parts.push(`You are behind by ${-balance} point${balance === -1 ? '' : 's'} of material, so keep pieces on and look for activity.`);
  else parts.push('Material is level.');

  const home = color === 'w' ? '1' : '8';
  const pieces = chess.board().flat().filter((p) => p?.color === color);
  const undeveloped = pieces.filter((p) => (p!.type === 'n' || p!.type === 'b') && p!.square[1] === home).length;
  const king = pieces.find((p) => p!.type === 'k');
  const moveNumber = Number(fen.split(' ')[5]);
  if (undeveloped > 0 && moveNumber <= 15) {
    parts.push(`${undeveloped} of your minor pieces ${undeveloped === 1 ? 'is' : 'are'} still at home, so development comes first.`);
  }
  if (king && (king.square === 'e1' || king.square === 'e8') && moveNumber >= 6) {
    parts.push('Your king is still in the centre. Castling soon is usually wise.');
  }
  const best = analysis?.lines[0];
  if (best) parts.push(`The engine's main idea here runs ${pvToSan(fen, best.pv, 5)}.`);
  return parts.join(' ');
}

/** Three levels of hint: an idea, then the piece, then the move. */
export function hintFor(fen: string, analysis: Analysis, level: 1 | 2 | 3): { text: string; square?: Square; uci?: string } {
  const best = analysis.lines[0];
  if (!best) return { text: 'There is nothing to play in this position.' };
  const { from } = uciToMove(best.move);
  const motifs = detectMotifs(fen, best.move);
  const name = pieceNameAt(fen, from) ?? 'piece';
  if (level === 1) {
    const color = turnOf(fen);
    const gain = lineGain(fen, best.pv, color);
    if (best.score.mate !== null && (color === 'w' ? best.score.mate > 0 : best.score.mate < 0)) {
      return { text: `There is a forced mate in ${Math.abs(best.score.mate)}. Start with checks.` };
    }
    const motif = motifs.find((m) => m !== 'check');
    if (motif) return { text: `Look for a ${MOTIF_NAMES[motif]}.` };
    if (gain >= 2) return { text: 'There is a way to win material here. Examine every capture and check.' };
    if (motifs.includes('check')) return { text: 'A check is worth examining here.' };
    return { text: 'No immediate tactic here. Which of your pieces is doing the least? Improve it.' };
  }
  if (level === 2) return { text: `Try moving your ${name} on ${from}.`, square: from };
  return { text: `The engine's move is ${sanFromUci(fen, best.move)}.`, square: from, uci: best.move };
}
