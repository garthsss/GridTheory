import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { buildMoveReport, detectMotifs, findSacrifice, findThreats, hangingPieces, mateThreat } from '../src/coach/explain';
import { BOTS } from '../src/engine/bots';
import { fitRatings } from '../src/engine/elo';
import { botThinkTime, flagResult, formatClock } from '../src/lib/clock';
import { chooseMove, chooseStyled } from '../src/engine/localBot';
import { classify, moveAccuracy, winPercent, type Analysis } from '../src/engine/score';
import { START_FEN, PgnError, parseGame, pvToSan, splitGames } from '../src/lib/chess';
import { matchPieces } from '../src/components/Board';
import { openingName } from '../src/lib/openings';
import { judgeOutcome, placeEndgame, type Scenario } from '../src/training/scenarios';

const line = (move: string, cp: number | null, mate: number | null = null, pv = [move]) => ({ move, score: { cp, mate }, pv });

describe('parseGame', () => {
  it('reads full PGN with tags, comments, NAGs and variations', () => {
    const game = parseGame(`[White "A"]\n[Black "B"]\n\n1. e4 {best by test} e5 $1 (1... c5 2. Nf3) 2. Nf3! Nc6?! 1-0`);
    expect(game.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(game.headers.White).toBe('A');
    expect(game.result).toBe('1-0');
  });

  it('reads bare moves and zero-style castling', () => {
    const game = parseGame('e4 e5 Nf3 Nc6 Bc4 Bc5 0-0');
    expect(game.moves.at(-1)?.san).toBe('O-O');
  });

  it('names the move number of an illegal move', () => {
    expect(() => parseGame('1.e4 e5 2.Nf9')).toThrow(PgnError);
    expect(() => parseGame('1.e4 e5 2.Nf9')).toThrow(/Move 2 "Nf9"/);
    expect(() => parseGame('1.e4 e5 2.Nf3 Qh1')).toThrow(/Move 2\.\.\. "Qh1"/);
  });

  it('honours a FEN header', () => {
    const game = parseGame('[FEN "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1"]\n\n1.Ra8#');
    expect(game.moves[0].san).toBe('Ra8#');
  });

  it('rejects a FEN header that would crash the engine', () => {
    expect(() => parseGame('[FEN "7k/8/5QK1/8/8/8/8/8 w - - 0 1"]\n\n1.Qf8#')).toThrow(/not a legal position/);
  });

  it('rejects text with no moves', () => {
    expect(() => parseGame('[White "A"]')).toThrow(/No moves/);
  });

  it('splits multi-game files', () => {
    expect(splitGames('[Event "a"]\n\n1.e4 *\n\n[Event "b"]\n\n1.d4 *')).toHaveLength(2);
    expect(splitGames('[White "x"]\n[Event "a"]\n\n1.e4 {[%clk 0:10:00]} *\n\n[White "y"]\n[Event "b"]\n\n1.d4 *')).toHaveLength(2);
    expect(splitGames('[White "x"]\n[Black "y"]\n[Event "z"]\n\n1.e4 e5')).toHaveLength(1);
    expect(splitGames('1.e4 e5 2.Nf3')).toHaveLength(1);
  });
});

describe('notation', () => {
  it('numbers lines from either side', () => {
    expect(pvToSan('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', ['e7e5', 'g1f3'])).toBe('1...e5 2.Nf3');
  });

  it('names openings by longest prefix', () => {
    expect(openingName('e4 e5 Nf3 Nc6 Bb5 a6 Ba4'.split(' '))).toBe('Ruy Lopez: Morphy Defense');
    expect(openingName([])).toBeNull();
  });

  it('names variations, however the position was reached', () => {
    const najdorf = 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3'.split(' ');
    expect(openingName(najdorf)).toContain('Najdorf');
    expect(openingName('Nf3 d5 d4'.split(' '))).toBe(openingName('d4 d5 Nf3'.split(' ')));
    expect(openingName('d4 d5 Nf3'.split(' '))).not.toBeNull();
  });

  it('keeps the last name once a game leaves the book', () => {
    const inBook = 'e4 e5 Nf3 Nc6 Bb5'.split(' ');
    expect(openingName([...inBook, 'Rb8', 'h4', 'h5'])).toBe(openingName(inBook));
  });
});

describe('scores', () => {
  it('maps scores to win chance', () => {
    expect(winPercent({ cp: 0, mate: null })).toBeCloseTo(50);
    expect(winPercent({ cp: 300, mate: null })).toBeGreaterThan(70);
    expect(winPercent({ cp: null, mate: 3 })).toBe(100);
    expect(winPercent({ cp: null, mate: -3 })).toBe(0);
  });

  it('classifies by win chance lost', () => {
    expect(classify(30, true)).toBe('best');
    expect(classify(3, false)).toBe('good');
    expect(classify(7, false)).toBe('inaccuracy');
    expect(classify(12, false)).toBe('mistake');
    expect(classify(40, false)).toBe('blunder');
    expect(moveAccuracy(0)).toBeCloseTo(100, 0);
    expect(moveAccuracy(50)).toBeLessThan(15);
  });
});

describe('motifs', () => {
  it('finds a knight fork', () => {
    expect(detectMotifs('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7')).toContain('fork');
  });
  it('finds an absolute pin', () => {
    expect(detectMotifs('4k3/8/2n5/8/3P4/8/8/4KB2 w - - 0 1', 'f1b5')).toContain('pin');
  });
  it('finds a skewer', () => {
    expect(detectMotifs('4r3/8/8/4k3/8/8/8/R5K1 w - - 0 1', 'a1e1')).toContain('skewer');
  });
  it('finds a discovered attack and double check', () => {
    const motifs = detectMotifs('4k3/8/8/1q6/4N3/8/8/4R1K1 w - - 0 1', 'e4d6');
    expect(motifs).toContain('discovered');
    expect(motifs).toContain('double-check');
  });
  it('finds back-rank mate', () => {
    expect(detectMotifs('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', 'a1a8')).toEqual(expect.arrayContaining(['mate', 'back-rank']));
  });
  it('does not call a quiet move a tactic', () => {
    expect(detectMotifs('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'g1f3')).toEqual([]);
  });
});

describe('threats', () => {
  it('sees hanging pieces', () => {
    expect(hangingPieces('4k3/8/8/3r4/8/2N5/8/4K3 w - - 0 1', 'b').map((p) => p.square)).toEqual(['d5']);
  });
  it('does not call a defended, equally attacked piece hanging', () => {
    expect(hangingPieces('4k3/8/4n3/3r4/8/2R5/8/4K3 w - - 0 1', 'b')).toEqual([]);
  });
  it("sees Scholar's Mate coming", () => {
    expect(mateThreat('r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3')).toBe('Qxf7#');
    expect(findThreats('r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3', 'b')[0].text).toContain('Qxf7#');
  });
});

describe('buildMoveReport', () => {
  const analysis = (fen: string, lines: Analysis['lines']): Analysis => ({ fen, depth: 12, lines });

  it('explains a hung knight', () => {
    const before = '4k3/8/8/8/8/2N5/8/4K3 w - - 0 1';
    const report = buildMoveReport(
      before,
      'c3d5',
      analysis(before, [line('c3b5', 500)]),
      analysis('4k3/8/8/3N4/8/8/8/4K3 b - - 1 1', [line('e8d7', -100)]),
    );
    expect(report.cls).toBe('blunder');
  });

  it('reports allowing mate', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
    const afterFen = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    const report = buildMoveReport(fen, 'g8f6', analysis(fen, [line('g7g6', 0, null, ['g7g6'])]), analysis(afterFen, [line('h5f7', null, 1, ['h5f7'])]));
    expect(report.cls).toBe('blunder');
    expect(report.themes).toContain('allowed-mate');
    expect(report.headline).toContain('Qxf7#');
  });

  it('reports a missed mate', () => {
    const fen = '6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1';
    const afterFen = '6k1/5ppp/8/8/8/R7/8/4K3 b - - 1 1';
    const report = buildMoveReport(fen, 'a1a3', analysis(fen, [line('a1a8', null, 1, ['a1a8'])]), analysis(afterFen, [line('h7h6', 450)]));
    expect(report.themes).toContain('missed-mate');
    expect(report.headline).toContain('Ra8#');
  });

  it('leaves good moves unexplained', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const report = buildMoveReport(fen, 'e2e4', analysis(fen, [line('e2e4', 30)]), analysis('x', [line('e7e5', 30)]));
    expect(report.cls).toBe('best');
    expect(report.headline).toBe('');
  });
});

describe('findSacrifice', () => {
  const fenAfterMoves = (...moves: string[]) => {
    const chess = new Chess();
    for (const move of moves) chess.move(move);
    return chess.fen();
  };

  it('finds a piece given up on the square it moved to', () => {
    const fen = 'r1bq1rk1/ppp2ppp/2n5/8/8/3B4/PPP2PPP/RNBQ1RK1 w - - 0 1';
    expect(findSacrifice(fen, 'd3h7')).toEqual({ piece: 'b', square: 'h7' });
  });

  it('finds a piece left to be taken elsewhere, as in Legal\'s mate', () => {
    const fen = fenAfterMoves('e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6');
    expect(findSacrifice(fen, 'f3e5')).toEqual({ piece: 'q', square: 'd1' });
  });

  it('counts giving a rook for a knight', () => {
    expect(findSacrifice('4k3/6p1/5n2/8/8/8/8/4KR2 w - - 0 1', 'f1f6')).toEqual({ piece: 'r', square: 'f6' });
  });

  it('counts leaving an attacked queen where it is, when it could have moved', () => {
    expect(findSacrifice('r3k2r/8/1q6/2B5/8/8/8/4K3 b kq - 0 1', 'h8h7')).toEqual({ piece: 'q', square: 'b6' });
  });

  it('counts leaving the bigger piece of a fork, because the smaller one was the only forced loss', () => {
    expect(findSacrifice('4k3/8/8/8/8/2n5/8/1Q1RK3 w - - 0 1', 'd1d3')).toEqual({ piece: 'q', square: 'b1' });
  });

  it.each([
    ['an even queen trade', '3qk3/8/8/8/8/8/8/3QK2R w - - 0 1', 'd1d8'],
    ['a pawn', '4k3/8/3p4/8/4P3/8/8/4K3 w - - 0 1', 'e4e5'],
    ['a piece that a fork had already lost', '4k3/8/8/8/8/8/2n5/R3K3 w - - 0 1', 'e1d2'],
    ['a trapped knight grabbing a pawn', 'N2r4/p1p5/3k4/8/8/8/8/4K3 w - - 0 1', 'a8c7'],
    ['a pawn that promotes and is taken', '1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8q'],
  ])('does not count %s', (_name, fen, uci) => {
    expect(findSacrifice(fen, uci)).toBeNull();
  });
});

describe('brilliant moves', () => {
  const fen = 'r1bq1rk1/ppp2ppp/2n5/8/8/3B4/PPP2PPP/RNBQ1RK1 w - - 0 1';
  const grade = (lines: Analysis['lines'], afterCp: number, uci = 'd3h7') => {
    const chess = new Chess(fen);
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    return buildMoveReport(fen, uci, { fen, depth: 18, lines }, { fen: chess.fen(), depth: 18, lines: [line(uci === 'd3h7' ? 'g8h7' : 'h7h6', afterCp)] });
  };

  it('needs the best move, a sound position after it, and alternatives that were not winning', () => {
    const report = grade([line('d3h7', 150), line('c1e3', 30)], 150);
    expect(report.cls).toBe('brilliant');
    expect(report.headline).toContain('bishop on h7');
    expect(report.loss).toBe(0);
  });

  it('allows a near-best sacrifice', () => {
    expect(grade([line('c1e3', 150), line('d3h7', 150)], 150).cls).toBe('brilliant');
  });

  it('allows a saving sacrifice that only reaches equality', () => {
    expect(grade([line('d3h7', 0), line('c1e3', -300)], 0).cls).toBe('brilliant');
  });

  it('is only the best move if another move was already winning', () => {
    expect(grade([line('d3h7', 900), line('c1e3', 800)], 900).cls).toBe('best');
  });

  it('is only the best move if the position is still bad afterwards', () => {
    expect(grade([line('d3h7', -300), line('c1e3', -500)], -300).cls).toBe('best');
  });

  it('is not awarded when the sacrifice loses to a better move', () => {
    expect(grade([line('c1e3', 300), line('d3h7', 0)], 0).cls).not.toBe('brilliant');
  });

  it('waits for a second engine line', () => {
    expect(grade([line('d3h7', 150)], 150).cls).toBe('best');
  });

  it('is not awarded to a best move that gives nothing up', () => {
    expect(grade([line('c1e3', 30), line('d3e2', 20)], 30, 'c1e3').cls).toBe('best');
  });
});

describe('local bots', () => {
  const local = BOTS.filter((bot) => bot.profile);
  it('always return a legal move, even when promoting or mated soon', () => {
    const positions = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      '8/P6k/8/8/8/8/7p/K7 w - - 0 1',
      '7k/5Q2/5K2/8/8/8/8/8 b - - 0 1'.replace('5Q2', '8'),
    ];
    for (const bot of local) {
      for (const fen of positions) {
        const uci = chooseMove(fen, bot.profile!);
        expect(() => new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })).not.toThrow();
      }
    }
  });
  it('take free material once they search', () => {
    const nell = BOTS.find((bot) => bot.id === 'nell')!;
    let taken = 0;
    for (let i = 0; i < 20; i++) if (chooseMove('4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1', nell.profile!) === 'c3d5') taken++;
    expect(taken).toBeGreaterThanOrEqual(14);
  });
  it('style changes the choice between otherwise equal moves', () => {
    const ash = BOTS.find((bot) => bot.id === 'ash')!.style!;
    // A queen check and a quiet pawn push rated the same: the attacker should prefer the check.
    const fen = '4k3/8/8/8/8/8/P7/3QK3 w - - 0 1';
    const lines = [{ move: 'a2a3', score: { cp: 800, mate: null } }, { move: 'd1d8', score: { cp: 800, mate: null } }];
    let checks = 0;
    for (let i = 0; i < 40; i++) if (chooseStyled(fen, lines, ash) === 'd1d8') checks++;
    expect(checks).toBeGreaterThan(25);
  });
  it('are listed in rising rating order', () => {
    const ratings = BOTS.map((bot) => bot.rating);
    expect(ratings).toEqual([...ratings].sort((a, b) => a - b));
  });
});

describe('board animation identities', () => {
  const place = (fen: string, previous: ReturnType<typeof matchPieces> = []) => matchPieces(previous, fen);
  const at = (pieces: ReturnType<typeof matchPieces>, square: string) => pieces.find((piece) => piece.square === square)!;

  it('keeps the moved piece the same across a simple move', () => {
    const before = place(START_FEN);
    const after = place('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', before);
    expect(at(after, 'e4').id).toBe(at(before, 'e2').id);
    expect(after).toHaveLength(32);
  });
  it('slides both king and rook when castling', () => {
    const before = place('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
    const after = place('4k3/8/8/8/8/8/8/5RK1 b - - 1 1', before);
    expect(at(after, 'g1').id).toBe(at(before, 'e1').id);
    expect(at(after, 'f1').id).toBe(at(before, 'h1').id);
  });
  it('removes a captured piece and keeps the capturer', () => {
    const before = place('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
    const after = place('4k3/8/8/3P4/8/8/8/4K3 b - - 0 1', before);
    expect(at(after, 'd5').id).toBe(at(before, 'e4').id);
    expect(after).toHaveLength(3);
  });
  it('gives a promoted piece a new identity', () => {
    const before = place('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    const after = place('Q3k3/8/8/8/8/8/8/4K3 b - - 0 1', before);
    expect(at(after, 'a8').type).toBe('q');
    expect(at(after, 'a8').id).not.toBe(at(before, 'a7').id);
  });
  it('is stable when rendered twice with the same position', () => {
    const once = place(START_FEN);
    expect(place(START_FEN, once).map((piece) => piece.id)).toEqual(once.map((piece) => piece.id));
  });
});

describe('clocks', () => {
  it('formats time like a chess clock', () => {
    expect(formatClock(600_000)).toBe('10:00');
    expect(formatClock(59_001)).toBe('1:00');
    expect(formatClock(19_950)).toBe('0:19.9');
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(-50)).toBe('0:00.0');
    expect(formatClock(3_700_000)).toBe('1:01:40');
  });
  it('only awards a win on time if the opponent could still mate', () => {
    expect(flagResult('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'b')).toBe('1-0');
    expect(flagResult('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'w')).toBe('1/2-1/2');
    expect(flagResult('4k3/8/8/8/8/8/8/2B1K3 b - - 0 1', 'b')).toBe('1/2-1/2');
    expect(flagResult('4k3/8/8/8/8/8/8/1NB1K3 b - - 0 1', 'b')).toBe('1-0');
    expect(flagResult('4k3/4p3/8/8/8/8/8/4K3 w - - 0 1', 'w')).toBe('0-1');
  });
  it('keeps bots from flagging themselves', () => {
    expect(botThinkTime(1000, 600_000, 0)).toBe(1000);
    expect(botThinkTime(1000, 3000, 0)).toBe(100);
    expect(botThinkTime(1000, 3000, 1)).toBe(900);
    expect(botThinkTime(1000, 100, 0)).toBe(30);
  });
});

describe('rating fit', () => {
  it('recovers a known gap from match scores', () => {
    // A 76% score is about 200 Elo.
    const fitted = fitRatings(['a', 'b'], [{ a: 'a', b: 'b', score: 76, games: 100 }], { b: 1000 });
    expect(fitted.b).toBeCloseTo(1000, 0);
    expect(fitted.a).toBeGreaterThan(1180);
    expect(fitted.a).toBeLessThan(1220);
  });
  it('keeps a clean sweep finite', () => {
    const fitted = fitRatings(['a', 'b'], [{ a: 'a', b: 'b', score: 16, games: 16 }], { b: 1000 });
    expect(Number.isFinite(fitted.a)).toBe(true);
    expect(fitted.a).toBeGreaterThan(1300);
  });
  it('shifts the scale to the mean of several anchors', () => {
    const fitted = fitRatings(['a', 'b', 'c'], [{ a: 'a', b: 'b', score: 8, games: 16 }, { a: 'b', b: 'c', score: 8, games: 16 }], { a: 1000, c: 1200 });
    expect((fitted.a + fitted.c) / 2).toBeCloseTo(1100, 0);
  });
});

describe('training scenarios', () => {
  it('generates only legal endgame placements', () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let legal = 0;
    for (let i = 0; i < 300; i++) {
      const fen = placeEndgame({ name: 'x', mine: ['r', 'p'], theirs: ['r'], moves: 10 }, i % 2 ? 'w' : 'b', random);
      if (fen) {
        const chess = new Chess(fen);
        expect(chess.turn()).toBe(i % 2 ? 'w' : 'b');
        expect(chess.inCheck()).toBe(false);
        legal++;
      }
    }
    expect(legal).toBeGreaterThan(100);
  });

  const scenario = (goal: Scenario['goal'], critical = false): Scenario => ({
    phase: 'endgame', title: '', brief: '', fen: '', playerColor: 'w', goal, critical, maxPlayerMoves: 5, startWin: 50,
  });

  it('judges each goal', () => {
    expect(judgeOutcome(scenario('win'), 100, 90, 0, { result: '1-0', reason: 'checkmate' }, false).success).toBe(true);
    expect(judgeOutcome(scenario('win'), 50, 90, 0, { result: '1/2-1/2', reason: 'stalemate' }, false).success).toBe(false);
    expect(judgeOutcome(scenario('win'), 60, 90, 0, {}, false).success).toBe(false);
    expect(judgeOutcome(scenario('hold'), 50, 60, 0, { result: '1/2-1/2', reason: 'stalemate' }, false).success).toBe(true);
    expect(judgeOutcome(scenario('hold'), 0, 60, 0, { result: '0-1', reason: 'checkmate' }, false).success).toBe(false);
    expect(judgeOutcome(scenario('play'), 50, 85, 0, {}, false).success).toBe(true);
    expect(judgeOutcome(scenario('play'), 50, 85, 1, {}, false).success).toBe(false);
    expect(judgeOutcome(scenario('play', true), 50, 95, 0, {}, false).success).toBe(false);
    expect(judgeOutcome(scenario('play', true), 50, 95, 0, {}, true).success).toBe(true);
  });
});
