import { Chess } from 'chess.js';
import table from './openings.json';

/** Every named position in the Lichess opening database. Rebuild with scripts/build-openings.mjs. */
const NAMED_POSITIONS: Record<string, string> = table;

// Well-known lines that training scenarios start from.
export const OPENINGS: [string, string][] = [
  ['e4', "King's Pawn Opening"],
  ['e4 e5', 'Open Game'],
  ['e4 e5 Nf3', "King's Knight Opening"],
  ['e4 e5 Nf3 Nc6', "King's Knight Opening"],
  ['e4 e5 Nf3 Nc6 Bb5', 'Ruy Lopez'],
  ['e4 e5 Nf3 Nc6 Bb5 a6', 'Ruy Lopez: Morphy Defense'],
  ['e4 e5 Nf3 Nc6 Bb5 Nf6', 'Ruy Lopez: Berlin Defense'],
  ['e4 e5 Nf3 Nc6 Bc4', 'Italian Game'],
  ['e4 e5 Nf3 Nc6 Bc4 Bc5', 'Italian Game: Giuoco Piano'],
  ['e4 e5 Nf3 Nc6 Bc4 Bc5 b4', 'Italian Game: Evans Gambit'],
  ['e4 e5 Nf3 Nc6 Bc4 Nf6', 'Italian Game: Two Knights Defense'],
  ['e4 e5 Nf3 Nc6 d4', 'Scotch Game'],
  ['e4 e5 Nf3 Nc6 Nc3', 'Three Knights Game'],
  ['e4 e5 Nf3 Nc6 Nc3 Nf6', 'Four Knights Game'],
  ['e4 e5 Nf3 Nf6', 'Petrov Defense'],
  ['e4 e5 Nf3 d6', 'Philidor Defense'],
  ['e4 e5 f4', "King's Gambit"],
  ['e4 e5 Nc3', 'Vienna Game'],
  ['e4 e5 Qh5', 'Wayward Queen Attack'],
  ['e4 c5', 'Sicilian Defense'],
  ['e4 c5 Nf3 d6', 'Sicilian Defense: Modern Variations'],
  ['e4 c5 Nf3 Nc6', 'Sicilian Defense: Old Sicilian'],
  ['e4 c5 Nf3 e6', 'Sicilian Defense: French Variation'],
  ['e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', 'Sicilian Defense: Najdorf'],
  ['e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6', 'Sicilian Defense: Dragon'],
  ['e4 c5 c3', 'Sicilian Defense: Alapin'],
  ['e4 e6', 'French Defense'],
  ['e4 e6 d4 d5 Nc3', 'French Defense: Classical Lines'],
  ['e4 e6 d4 d5 e5', 'French Defense: Advance Variation'],
  ['e4 c6', 'Caro-Kann Defense'],
  ['e4 c6 d4 d5 e5', 'Caro-Kann Defense: Advance Variation'],
  ['e4 d5', 'Scandinavian Defense'],
  ['e4 d6', 'Pirc Defense'],
  ['e4 g6', 'Modern Defense'],
  ['e4 Nf6', 'Alekhine Defense'],
  ['d4', "Queen's Pawn Opening"],
  ['d4 d5', 'Closed Game'],
  ['d4 d5 c4', "Queen's Gambit"],
  ['d4 d5 c4 e6', "Queen's Gambit Declined"],
  ['d4 d5 c4 c6', 'Slav Defense'],
  ['d4 d5 c4 dxc4', "Queen's Gambit Accepted"],
  ['d4 d5 Nf3 Nf6 Bf4', 'London System'],
  ['d4 d5 Bf4', 'London System'],
  ['d4 Nf6', 'Indian Defense'],
  ['d4 Nf6 Bf4', 'London System'],
  ['d4 Nf6 c4 g6', "King's Indian Defense"],
  ['d4 Nf6 c4 g6 Nc3 d5', 'Grünfeld Defense'],
  ['d4 Nf6 c4 e6 Nc3 Bb4', 'Nimzo-Indian Defense'],
  ['d4 Nf6 c4 e6 Nf3 b6', "Queen's Indian Defense"],
  ['d4 Nf6 c4 c5', 'Benoni Defense'],
  ['d4 f5', 'Dutch Defense'],
  ['c4', 'English Opening'],
  ['Nf3', 'Réti Opening'],
  ['f4', "Bird's Opening"],
  ['g3', "King's Fianchetto Opening"],
  ['b3', 'Nimzo-Larsen Attack'],
];

/**
 * The opening a game is in, from the positions it has reached, oldest first. Matching positions means a
 * different move order still finds the name, and a game that has left the book keeps the last name it had.
 */
export function openingFromFens(fens: string[]): string | null {
  for (let i = fens.length - 1; i >= 0; i--) {
    const name = NAMED_POSITIONS[fens[i].split(' ').slice(0, 4).join(' ')];
    if (name) return name;
  }
  return null;
}

export function openingName(sanMoves: string[]): string | null {
  const chess = new Chess();
  return openingFromFens(sanMoves.map((san) => {
    chess.move(san);
    return chess.fen();
  }));
}
