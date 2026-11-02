import { mkdirSync, writeFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { afterAll, it } from 'vitest';
import { BOTS, type Bot } from '../src/engine/bots';
import { fitRatings, type MatchResult } from '../src/engine/elo';
import { chooseMove, chooseStyled } from '../src/engine/localBot';
import { gameEnd, materialBalance, uciToMove } from '../src/lib/chess';
import { NodeEngine } from './engine';

const WORKERS = 9;
const MAX_PLIES = 220;
const OUT = 'calibration';
const ANCHORS = { sf1320: 1320, sf1600: 1600, sf1900: 1900, sf2200: 2200 };

// Varied, sound starting moves, because engines otherwise repeat the same game.
const OPENINGS = [
  'e4 e5', 'e4 c5', 'e4 e6', 'e4 c6', 'e4 d6', 'e4 d5', 'd4 d5', 'd4 Nf6', 'd4 e6', 'c4 e5', 'c4 c5', 'Nf3 d5',
  'e4 e5 Nf3 Nc6', 'e4 c5 Nf3 d6', 'd4 d5 c4 e6', 'd4 Nf6 c4 g6',
];

const engines: NodeEngine[] = [];
afterAll(() => engines.forEach((engine) => engine.quit()));

async function move(bot: Bot, fen: string, engine: NodeEngine): Promise<string> {
  if (bot.engine === 'local') return chooseMove(fen, bot.profile!);
  if (bot.engine === 'styled') {
    await engine.bestLimited(fen, undefined, 1);
    const analysis = await engine.search(fen, bot.style!.searchDepth, bot.style!.candidates);
    return chooseStyled(fen, analysis.lines, bot.style!);
  }
  return engine.bestLimited(fen, bot.stockfish!.elo, bot.stockfish!.movetime);
}

/** Plays one game and returns White's score. Long, lopsided games are adjudicated on material. */
async function play(white: Bot, black: Bot, opening: string, engine: NodeEngine): Promise<number> {
  const chess = new Chess();
  for (const san of opening.split(' ')) chess.move(san);
  let lopsided = 0;
  for (let ply = 0; ply < MAX_PLIES; ply++) {
    const status = gameEnd(chess);
    if (status.over) return status.result === '1-0' ? 1 : status.result === '0-1' ? 0 : 0.5;
    const balance = materialBalance(chess.fen());
    lopsided = Math.abs(balance) >= 10 ? lopsided + 1 : 0;
    if (lopsided >= 24) return balance > 0 ? 1 : 0;
    chess.move(uciToMove(await move(chess.turn() === 'w' ? white : black, chess.fen(), engine)));
  }
  return 0.5;
}

it('measures bot ratings', async () => {
  for (let i = 0; i < WORKERS; i++) {
    const engine = new NodeEngine();
    await engine.init();
    engines.push(engine);
  }
  const results: MatchResult[] = [];
  const pairs: [Bot, Bot, number][] = [];
  BOTS.forEach((bot, i) => {
    // Neighbours and next-neighbours, so that every bot is compared through several routes.
    const strongest = bot.id === 'sf2500' || bot.id === 'sf2800' || bot.id === 'sfmax';
    if (BOTS[i + 1]) pairs.push([bot, BOTS[i + 1], strongest || BOTS[i + 1].id === 'sf2500' ? 16 : 32]);
    if (BOTS[i + 2]) pairs.push([bot, BOTS[i + 2], BOTS[i + 2].id.match(/sf2500|sf2800|sfmax/) ? 8 : 16]);
  });

  const jobs: { a: Bot; b: Bot; opening: string; aIsWhite: boolean; result: MatchResult }[] = [];
  for (const [a, b, games] of pairs) {
    const result: MatchResult = { a: a.id, b: b.id, score: 0, games: 0 };
    results.push(result);
    for (let g = 0; g < games; g++) {
      jobs.push({ a, b, opening: OPENINGS[Math.floor(g / 2) % OPENINGS.length], aIsWhite: g % 2 === 0, result });
    }
  }
  // Weakest bots come first and are cheapest, so useful results exist early if the run is stopped.
  const save = () => {
    mkdirSync(OUT, { recursive: true });
    const played = results.filter((r) => r.games > 0);
    const ids = BOTS.map((bot) => bot.id).filter((id) => played.some((r) => r.a === id || r.b === id));
    writeFileSync(`${OUT}/results.json`, JSON.stringify({ date: new Date().toISOString(), results: played, ratings: fitRatings(ids, played, ANCHORS) }, null, 2));
  };

  let next = 0;
  const t0 = Date.now();
  await Promise.all(
    engines.map(async (engine) => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const white = job.aIsWhite ? job.a : job.b;
        const black = job.aIsWhite ? job.b : job.a;
        const whiteScore = await play(white, black, job.opening, engine);
        job.result.score += job.aIsWhite ? whiteScore : 1 - whiteScore;
        job.result.games++;
        if (next % 20 === 0) {
          save();
          console.log(`${next}/${jobs.length} games started, ${Math.round((Date.now() - t0) / 60000)} min`);
        }
      }
    }),
  );
  save();
  console.log('calibration complete');
});
