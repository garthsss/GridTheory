// Builds src/training/puzzles.json from a Lichess puzzle export (CC0, database.lichess.org).
// Usage: node scripts/build-puzzles.mjs <path to lichess_db_puzzle.csv.zst, which may be a partial download>
// A truncated file is fine: the script reads rows until the data runs out.
import { readFileSync, writeFileSync } from 'node:fs';
import { constants as zlibConstants, zstdDecompressSync } from 'node:zlib';
import { Chess } from 'chess.js';

const THEMES = [
  'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'hangingPiece', 'trappedPiece', 'deflection', 'attraction',
  'sacrifice', 'backRankMate', 'mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'smotheredMate', 'kingsideAttack', 'queensideAttack',
  'advancedPawn', 'promotion', 'opening', 'middlegame', 'endgame', 'rookEndgame', 'pawnEndgame', 'queenEndgame', 'bishopEndgame', 'knightEndgame', 'defensiveMove', 'quietMove', 'zugzwang',
];
const BAND = 200;
const PER_BAND = 400;
const LOW = 400;
const HIGH = 2800;

const bands = new Map();
let rows = 0;
function take(line) {
  rows++;
  const [id, fen, moves, rating, deviation, popularity, plays, themes] = line.split(',');
  const r = Number(rating);
  if (!(r >= LOW && r < HIGH) || Number(deviation) > 90 || Number(popularity) < 75 || Number(plays) < 200) return;
  const band = Math.floor(r / BAND) * BAND;
  const list = bands.get(band) ?? [];
  if (list.length >= PER_BAND * 12) return;
  const themeIds = themes.split(' ').map((theme) => THEMES.indexOf(theme)).filter((index) => index >= 0);
  list.push({ id, fen, moves, r, themeIds });
  bands.set(band, list);
}

// The export is a series of independently compressed frames, each preceded by a skippable frame holding its
// size. Decompressing frame by frame lets a partial download work: the cut-off final frame is just ignored.
const SKIPPABLE = 0x184d2a50;
const file = readFileSync(process.argv[2]);
let offset = 0;
let leftover = '';
while (offset + 12 <= file.length && file.readUInt32LE(offset) === SKIPPABLE) {
  const headerSize = file.readUInt32LE(offset + 4);
  const frameSize = file.readUInt32LE(offset + 8);
  const start = offset + 8 + headerSize;
  if (start + frameSize > file.length) break;
  const text = leftover + zstdDecompressSync(file.subarray(start, start + frameSize), {
    params: { [zlibConstants.ZSTD_d_windowLogMax]: 31 },
  }).toString('utf8');
  const lines = text.split('\n');
  leftover = lines.pop();
  for (const line of lines) {
    if (line && !line.startsWith('PuzzleId')) take(line);
  }
  offset = start + frameSize;
}

/** Picks within a band so that rarer themes are represented, not just the commonest. */
function pickBand(list) {
  const seen = new Map();
  const scored = list.map((puzzle) => {
    const rarity = Math.min(...puzzle.themeIds.map((t) => seen.get(t) ?? 0), 9999);
    for (const t of puzzle.themeIds) seen.set(t, (seen.get(t) ?? 0) + 1);
    return { puzzle, rarity };
  });
  scored.sort((a, b) => a.rarity - b.rarity);
  return scored.slice(0, PER_BAND).map((entry) => entry.puzzle);
}

const out = [];
let rejected = 0;
for (const band of [...bands.keys()].sort((a, b) => a - b)) {
  for (const p of pickBand(bands.get(band))) {
    try {
      const chess = new Chess(p.fen);
      for (const uci of p.moves.split(' ')) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      out.push([p.id, p.fen, p.moves, p.r, p.themeIds]);
    } catch {
      rejected++;
    }
  }
}

writeFileSync(new URL('../src/training/puzzles.json', import.meta.url), JSON.stringify({ source: 'Lichess puzzle database, CC0', themes: THEMES, puzzles: out }));
console.log(`rows read ${rows}, kept ${out.length}, rejected ${rejected}`);
console.log([...bands.keys()].sort((a, b) => a - b).map((band) => `${band}:${out.filter((p) => Math.floor(p[3] / BAND) * BAND === band).length}`).join(' '));
