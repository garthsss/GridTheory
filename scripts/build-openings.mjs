// Builds src/lib/openings.json from the Lichess opening database (CC0, github.com/lichess-org/chess-openings).
// Usage: node scripts/build-openings.mjs <folder holding a.tsv to e.tsv>
// Openings are keyed by position, not by moves, so that a game reaching one by another move order still finds its name.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const folder = process.argv[2];
if (!folder) throw new Error('Pass the folder holding a.tsv to e.tsv.');

const table = {};
let lines = 0;
let repeats = 0;
for (const file of ['a', 'b', 'c', 'd', 'e']) {
  for (const row of readFileSync(join(folder, `${file}.tsv`), 'utf8').split('\n').slice(1)) {
    if (!row.trim()) continue;
    const [, name, pgn] = row.split('\t');
    const chess = new Chess();
    chess.loadPgn(pgn.trim());
    const position = chess.fen().split(' ').slice(0, 4).join(' ');
    lines++;
    if (table[position] && table[position] !== name) repeats++;
    table[position] = name;
  }
}

writeFileSync(fileURLToPath(new URL('../src/lib/openings.json', import.meta.url)), `${JSON.stringify(table)}\n`);
console.log(`${lines} lines, ${Object.keys(table).length} positions, ${repeats} positions with two names (the later one was kept).`);
