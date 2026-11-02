import { Chess, type Color, type PieceSymbol } from 'chess.js';
import { scoreOf, winPercentFor, type Analysis } from '../engine/score';
import { COLOR_NAMES, fenFromMoves, isIllegalPosition, other, turnOf, uciToMove } from '../lib/chess';
import { OPENINGS, openingName } from '../lib/openings';

export type Phase = 'opening' | 'middlegame' | 'endgame';
export type Goal = 'win' | 'hold' | 'play';

export interface Scenario {
  phase: Phase;
  title: string;
  brief: string;
  fen: string;
  playerColor: Color;
  goal: Goal;
  /** One move here is much stronger than the rest. */
  critical: boolean;
  maxPlayerMoves: number;
  startWin: number;
}

/** Search interface, so that generators run on the browser engine and on the Node test engine alike. */
export type Search = (fen: string, depth: number, multipv: number) => Promise<Analysis>;

type Random = () => number;

const pick = <T,>(items: T[], random: Random) => items[Math.floor(random() * items.length)];

/** Plays plausible moves: randomly among those the engine rates within `margin` centipawns of its best. */
async function samplePlies(fen: string, plies: number, search: Search, random: Random, margin = 40): Promise<string> {
  let current = fen;
  for (let i = 0; i < plies; i++) {
    const chess = new Chess(current);
    if (chess.isGameOver()) return current;
    const analysis = await search(current, 8, 4);
    const best = analysis.lines[0];
    if (!best) return current;
    const color = chess.turn();
    const near = analysis.lines.filter((line) => {
      if (best.score.mate !== null || line.score.mate !== null) return line === best;
      const gap = ((best.score.cp ?? 0) - (line.score.cp ?? 0)) * (color === 'w' ? 1 : -1);
      return gap <= margin;
    });
    chess.move(uciToMove(pick(near, random).move));
    current = chess.fen();
  }
  return current;
}

export async function generateOpening(search: Search, random: Random = Math.random): Promise<Scenario> {
  const lines = OPENINGS.filter(([line]) => line.split(' ').length >= 2);
  for (let attempt = 0; ; attempt++) {
    const [line] = pick(lines, random);
    const fen = await samplePlies(fenFromMoves(line), Math.floor(random() * 3), search, random);
    const sans = line.split(' ');
    const analysis = await search(fen, 12, 1);
    const color = turnOf(fen);
    const win = winPercentFor(scoreOf(analysis, color), color);
    if (win < 30 && attempt < 12) continue;
    return {
      phase: 'opening',
      title: openingName(sans) ?? 'Opening',
      brief: `You have ${COLOR_NAMES[color]} in the ${openingName(sans) ?? 'opening'}. Develop soundly and keep the balance for six moves.`,
      fen,
      playerColor: color,
      goal: 'play',
      critical: false,
      maxPlayerMoves: 6,
      startWin: win,
    };
  }
}

const gap = (analysis: Analysis, color: Color) => {
  if (analysis.lines.length < 2) return 0;
  return (
    winPercentFor(analysis.lines[0].score, color) - winPercentFor(analysis.lines[1].score, color)
  );
};

export async function generateMiddlegame(search: Search, random: Random = Math.random): Promise<Scenario> {
  const lines = OPENINGS.filter(([line]) => line.split(' ').length >= 2);
  let fallback: Scenario | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const [line] = pick(lines, random);
    const startPly = 16 + Math.floor(random() * 14);
    let current = await samplePlies(fenFromMoves(line), startPly - line.split(' ').length, search, random, 50);
    // Walk on a few moves looking for a moment where one move clearly stands out.
    for (let step = 0; step < 8; step++) {
      const chess = new Chess(current);
      if (chess.isGameOver()) break;
      const color = chess.turn();
      const analysis = await search(current, 13, 2);
      const win = winPercentFor(scoreOf(analysis, color), color);
      if (win >= 25 && win <= 80) {
        const material = current.split(' ')[0].replace(/[^qrbnQRBN]/g, '').length;
        if (material >= 6) {
          const critical = gap(analysis, color) >= 12;
          const scenario: Scenario = {
            phase: 'middlegame',
            title: critical ? 'Critical moment' : 'Middlegame position',
            brief: critical
              ? `You have ${COLOR_NAMES[color]}. One move here is clearly stronger than the others. Find it, then play on.`
              : `You have ${COLOR_NAMES[color]}. No forced win here, so find a good plan and play the next eight moves accurately.`,
            fen: current,
            playerColor: color,
            goal: 'play',
            critical,
            maxPlayerMoves: critical ? 4 : 8,
            startWin: win,
          };
          if (critical) return scenario;
          fallback ??= scenario;
        }
      }
      current = await samplePlies(current, 1, search, random, 50);
    }
    if (fallback && attempt >= 1) return fallback;
  }
  if (fallback) return fallback;
  throw new Error('Could not find a suitable middlegame position. Try again.');
}

interface EndgameTemplate {
  name: string;
  /** Pieces besides the kings. The player gets `mine`, the opponent gets `theirs`. */
  mine: PieceSymbol[];
  theirs: PieceSymbol[];
  moves: number;
}

const ENDGAMES: EndgameTemplate[] = [
  { name: 'Queen against a lone king', mine: ['q'], theirs: [], moves: 15 },
  { name: 'Rook against a lone king', mine: ['r'], theirs: [], moves: 20 },
  { name: 'King and pawn', mine: ['p'], theirs: [], moves: 15 },
  { name: 'Defending against a pawn', mine: [], theirs: ['p'], moves: 15 },
  { name: 'Pawn race', mine: ['p'], theirs: ['p'], moves: 15 },
  { name: 'Two pawns against one', mine: ['p', 'p'], theirs: ['p'], moves: 20 },
  { name: 'Rook and pawn against rook', mine: ['r', 'p'], theirs: ['r'], moves: 25 },
  { name: 'Defending rook against rook and pawn', mine: ['r'], theirs: ['r', 'p'], moves: 25 },
  { name: 'Bishop and pawn against bishop', mine: ['b', 'p'], theirs: ['b'], moves: 20 },
  { name: 'Knight and pawn against knight', mine: ['n', 'p'], theirs: ['n'], moves: 20 },
  { name: 'Rook against pawn', mine: ['r'], theirs: ['p'], moves: 15 },
  { name: 'Queen against rook', mine: ['q'], theirs: ['r'], moves: 25 },
];

/** Places pieces at random. Returns a FEN, or null if this attempt is illegal or trivially over. */
export function placeEndgame(template: EndgameTemplate, playerColor: Color, random: Random): string | null {
  const taken = new Set<number>();
  const board: (string | null)[] = new Array(64).fill(null);
  const place = (symbol: string, allowed: (index: number) => boolean) => {
    for (let tries = 0; tries < 50; tries++) {
      const index = Math.floor(random() * 64);
      if (!taken.has(index) && allowed(index)) {
        taken.add(index);
        board[index] = symbol;
        return index;
      }
    }
    return -1;
  };
  const letter = (type: string, color: Color) => (color === 'w' ? type.toUpperCase() : type);
  const opponent = other(playerColor);

  const k1 = place(letter('k', playerColor), () => true);
  const k2 = place(letter('k', opponent), (i) => Math.max(Math.abs((i % 8) - (k1 % 8)), Math.abs((i >> 3) - (k1 >> 3))) > 1);
  if (k1 < 0 || k2 < 0) return null;

  // Index 0 is a8. Pawns stay off the first and last ranks, and do not start right next to promotion.
  const pawnAllowed = (color: Color) => (i: number) => {
    const rank = 8 - (i >> 3);
    return color === 'w' ? rank >= 2 && rank <= 6 : rank >= 3 && rank <= 7;
  };
  for (const [pieces, color] of [[template.mine, playerColor], [template.theirs, opponent]] as const) {
    for (const type of pieces) {
      const index = place(letter(type, color), type === 'p' ? pawnAllowed(color) : () => true);
      if (index < 0) return null;
    }
  }

  const rows: string[] = [];
  for (let row = 0; row < 8; row++) {
    let text = '';
    let empty = 0;
    for (let col = 0; col < 8; col++) {
      const piece = board[row * 8 + col];
      if (piece) {
        if (empty) text += empty;
        empty = 0;
        text += piece;
      } else {
        empty++;
      }
    }
    if (empty) text += empty;
    rows.push(text);
  }
  const fen = `${rows.join('/')} ${playerColor} - - 0 1`;
  try {
    const chess = new Chess(fen);
    if (chess.isGameOver() || chess.inCheck() || isIllegalPosition(fen)) return null;
    return fen;
  } catch {
    return null;
  }
}

export async function generateEndgame(search: Search, random: Random = Math.random): Promise<Scenario> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const template = pick(ENDGAMES, random);
    const playerColor: Color = random() < 0.5 ? 'w' : 'b';
    const fen = placeEndgame(template, playerColor, random);
    if (!fen) continue;
    const analysis = await search(fen, 14, 1);
    const best = analysis.lines[0];
    if (!best) continue;
    const win = winPercentFor(best.score, playerColor);
    // Skip quick mates and positions decided by a piece left en prise: they teach nothing.
    const quickMate = best.score.mate !== null && Math.abs(best.score.mate) <= 3;
    const firstMove = new Chess(fen).move(uciToMove(best.move));
    const freePiece = firstMove.captured !== undefined && firstMove.captured !== 'p';
    if (quickMate || freePiece) continue;

    const winning = win >= 80;
    const holdable = win >= 35 && win <= 65;
    if (!winning && !holdable) continue;
    return {
      phase: 'endgame',
      title: template.name,
      brief: winning
        ? `You have ${COLOR_NAMES[playerColor]}, and this should be winning. Convert it against full-strength Stockfish.`
        : `You have ${COLOR_NAMES[playerColor]}. The engine judges this about level. Don't lose it against full-strength Stockfish, and win if it errs.`,
      fen,
      playerColor,
      goal: winning ? 'win' : 'hold',
      critical: false,
      maxPlayerMoves: template.moves,
      startWin: win,
    };
  }
  throw new Error('Could not find a suitable endgame position. Try again.');
}

export function generateScenario(phase: Phase, search: Search, random: Random = Math.random): Promise<Scenario> {
  if (phase === 'opening') return generateOpening(search, random);
  if (phase === 'middlegame') return generateMiddlegame(search, random);
  return generateEndgame(search, random);
}

export interface Outcome {
  success: boolean;
  summary: string;
}

/** Decides how a scenario went from its goal, the final position, and the player's first-try accuracy. */
export function judgeOutcome(
  scenario: Scenario,
  finalWin: number,
  accuracy: number,
  blunders: number,
  over: { result?: string; reason?: string },
  criticalSolved: boolean,
): Outcome {
  const mine = scenario.playerColor === 'w' ? '1-0' : '0-1';
  const theirs = scenario.playerColor === 'w' ? '0-1' : '1-0';
  if (scenario.goal === 'win') {
    if (over.result === mine) return { success: true, summary: `Converted by ${over.reason}.` };
    if (over.result) return { success: false, summary: `The win got away: ${over.result === theirs ? 'you lost' : `drawn by ${over.reason}`}.` };
    return finalWin >= 85
      ? { success: true, summary: 'Still clearly winning when the moves ran out. Well converted.' }
      : { success: false, summary: `Your win chance fell to ${Math.round(finalWin)}% by the end.` };
  }
  if (scenario.goal === 'hold') {
    if (over.result === mine) return { success: true, summary: `You even won it, by ${over.reason}.` };
    if (over.result === theirs) return { success: false, summary: `You lost by ${over.reason}.` };
    if (over.result) return { success: true, summary: `Held: drawn by ${over.reason}.` };
    return finalWin >= 35
      ? { success: true, summary: 'Position held to the end.' }
      : { success: false, summary: `Your win chance fell to ${Math.round(finalWin)}% by the end.` };
  }
  if (scenario.critical && !criticalSolved) {
    return { success: false, summary: `You missed the key move on your first try. Accuracy ${Math.round(accuracy)}%.` };
  }
  if (over.result === theirs) return { success: false, summary: `You lost by ${over.reason}.` };
  const passed = accuracy >= 70 && blunders === 0;
  return {
    success: passed,
    summary: passed
      ? `Accuracy ${Math.round(accuracy)}% with no blunders.`
      : `Accuracy ${Math.round(accuracy)}%${blunders ? ` with ${blunders} blunder${blunders === 1 ? '' : 's'}` : ''}. The target is 70% with no blunders.`,
  };
}
