import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMoveReport, findSacrifice } from '../src/coach/explain';
import { parseGame } from '../src/lib/chess';
import { NodeEngine } from './engine';

const DEPTH = 20;

const GAMES = {
  opera: '1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7 8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7 14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0',
  immortal: '1.e4 e5 2.f4 exf4 3.Bc4 Qh4+ 4.Kf1 b5 5.Bxb5 Nf6 6.Nf3 Qh6 7.d3 Nh5 8.Nh4 Qg5 9.Nf5 c6 10.g4 Nf6 11.Rg1 cxb5 12.h4 Qg6 13.h5 Qg5 14.Qf3 Ng8 15.Bxf4 Qf6 16.Nc3 Bc5 17.Nd5 Qxb2 18.Bd6 Bxg1 19.e5 Qxa1+ 20.Ke2 Na6 21.Nxg7+ Kd8 22.Qf6+ Nxf6 23.Be7# 1-0',
  century: '1.Nf3 Nf6 2.c4 g6 3.Nc3 Bg7 4.d4 O-O 5.Bf4 d5 6.Qb3 dxc4 7.Qxc4 c6 8.e4 Nbd7 9.Rd1 Nb6 10.Qc5 Bg4 11.Bg5 Na4 12.Qa3 Nxc3 13.bxc3 Nxe4 14.Bxe7 Qb6 15.Bc4 Nxc3 16.Bc5 Rfe8+ 17.Kf1 Be6 18.Bxb6 Bxc4+ 19.Kg1 Ne2+ 20.Kf1 Nxd4+ 21.Kg1 Ne2+ 22.Kf1 Nc3+ 23.Kg1 axb6 24.Qb4 Ra4 25.Qxb6 Nxd1 0-1',
  quiet: '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 6.Re1 b5 7.Bb3 d6 8.c3 O-O 9.h3 Nb8 10.d4 Nbd7 *',
  unsound: '1.e4 e5 2.Qh5 Nc6 3.Qxf7+ Kxf7 4.Nf3 Nf6 *',
};

describe('brilliant moves against Stockfish', () => {
  const engine = new NodeEngine();
  beforeAll(() => engine.init());
  afterAll(() => engine.quit());

  /** The moves judged brilliant in a game, following the app's rule of searching only sacrifices this deeply. */
  async function brilliancies(pgn: string): Promise<string[]> {
    const found: string[] = [];
    for (const move of parseGame(pgn).moves) {
      if (!findSacrifice(move.fenBefore, move.uci)) continue;
      const before = await engine.search(move.fenBefore, DEPTH, 2);
      const after = await engine.search(move.fenAfter, DEPTH, 2);
      const report = buildMoveReport(move.fenBefore, move.uci, before, after);
      if (report.cls === 'brilliant') found.push(move.san);
    }
    return found;
  }

  it("finds Morphy's queen sacrifice", async () => {
    expect(await brilliancies(GAMES.opera)).toContain('Qb8+');
  }, 300_000);

  it("finds Fischer's sacrifices, including leaving the queen en prise", async () => {
    const found = await brilliancies(GAMES.century);
    expect(found).toContain('Na4');
    expect(found).toContain('Be6');
  }, 300_000);

  it('does not reward a final flourish when another move also forced mate', async () => {
    expect(await brilliancies(GAMES.immortal)).not.toContain('Qf6+');
  }, 300_000);

  it('finds nothing in quiet opening theory', async () => {
    expect(await brilliancies(GAMES.quiet)).toEqual([]);
  }, 300_000);

  it('does not reward an unsound sacrifice', async () => {
    expect(await brilliancies(GAMES.unsound)).toEqual([]);
  }, 300_000);
});
