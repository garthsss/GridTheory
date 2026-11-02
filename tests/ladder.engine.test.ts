import { Chess } from 'chess.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOTS, type Bot } from '../src/engine/bots';
import { chooseMove, chooseStyled } from '../src/engine/localBot';
import { gameEnd, uciToMove } from '../src/lib/chess';
import { generateScenario, type Phase } from '../src/training/scenarios';
import { NodeEngine } from './engine';

const GAMES = 16;
const MAX_PLIES = 240;

describe('bot ladder', () => {
  const engine = new NodeEngine();
  beforeAll(() => engine.init());
  afterAll(() => engine.quit());

  async function move(bot: Bot, fen: string): Promise<string> {
    if (bot.engine === 'local') return chooseMove(fen, bot.profile!);
    if (bot.engine === 'styled') {
      await engine.bestLimited(fen, undefined, 1);
      const analysis = await engine.search(fen, bot.style!.searchDepth, bot.style!.candidates);
      return chooseStyled(fen, analysis.lines, bot.style!);
    }
    // The same thinking time as in the app, because weakened Stockfish plays much worse with less.
    return engine.bestLimited(fen, bot.stockfish!.elo, bot.stockfish!.movetime);
  }

  async function play(white: Bot, black: Bot): Promise<number> {
    const chess = new Chess();
    for (let ply = 0; ply < MAX_PLIES; ply++) {
      const status = gameEnd(chess);
      if (status.over) return status.result === '1-0' ? 1 : status.result === '0-1' ? 0 : 0.5;
      chess.move(uciToMove(await move(chess.turn() === 'w' ? white : black, chess.fen())));
    }
    return 0.5;
  }

  it('reports each rung against the next, and stronger bots outscore weaker ones', async () => {
    const report: string[] = [];
    const ladder = BOTS.filter((bot) => ['pip', 'gus', 'nell', 'ash', 'petra', 'sf1320', 'sf1600'].includes(bot.id));
    const failures: string[] = [];
    for (let i = 0; i < ladder.length - 1; i++) {
      const weak = ladder[i];
      const strong = ladder[i + 1];
      let score = 0;
      for (let game = 0; game < GAMES; game++) {
        score += game % 2 === 0 ? await play(strong, weak) : 1 - (await play(weak, strong));
      }
      report.push(`${strong.name} ${score}/${GAMES} against ${weak.name}`);
      // Allow some noise: the stronger bot must simply not lose the match.
      if (score < GAMES / 2) failures.push(report.at(-1)!);
    }
    console.log(report.join('\n'));
    expect(failures).toEqual([]);
  });

  it('generates usable scenarios in every phase', async () => {
    let seed = 12345;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const search = (fen: string, depth: number, multipv: number) => engine.search(fen, depth, multipv);
    await engine.bestLimited('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', undefined, 1);
    const report: string[] = [];
    for (const phase of ['opening', 'middlegame', 'endgame'] as Phase[]) {
      for (let i = 0; i < 12; i++) {
        const scenario = await generateScenario(phase, search, random);
        const chess = new Chess(scenario.fen);
        expect(chess.isGameOver()).toBe(false);
        expect(chess.turn()).toBe(scenario.playerColor);
        expect(scenario.startWin).toBeGreaterThanOrEqual(25);
        report.push(`${phase}: ${scenario.title} [${scenario.goal}${scenario.critical ? ', critical' : ''}] ${Math.round(scenario.startWin)}% ${scenario.fen}`);
      }
    }
    console.log(report.join('\n'));
  });
});
