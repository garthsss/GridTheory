import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { isIllegalPosition } from '../src/lib/chess';

/** Runs one position in a fresh Stockfish process, because a rejected position ends the process. */
function askStockfish(fen: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [join(process.cwd(), 'node_modules/stockfish/bin/stockfish-19-lite-single.js')]);
    let out = '';
    let done = false;
    const finish = (result: string) => {
      if (!done) {
        done = true;
        proc.kill();
        resolve(result);
      }
    };
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (/CRITICAL ERROR/.test(out)) finish(`rejected: ${/Reason: (.*)/.exec(out)?.[1]}`);
      else if (/bestmove/.test(out)) finish('ok');
    });
    proc.on('exit', () => finish('exited'));
    setTimeout(() => finish('hung'), 15000);
    proc.stdin.write(`uci\nisready\nposition fen ${fen}\ngo depth 3\n`);
  });
}

/** Odd positions that chess.js accepts, including random piece placements. */
function candidates(): string[] {
  const fixed = [
    '4k3/8/3N1N2/8/8/8/4R3/4K3 b - - 0 1',
    '4k3/3P1P2/8/8/8/8/8/4K3 b - - 0 1',
    '4k3/8/8/8/8/8/8/4K3 w KQkq - 0 1',
    '8/4k3/8/8/8/4K3/8/8 w KQkq - 0 1',
    '4k3/8/8/8/8/8/8/4K3 b - e3 0 1',
    '4k3/8/8/8/8/8/4P3/4K3 w - - 150 10000',
    '8/8/8/8/8/7k/8/QQQQK3 w - - 0 1',
    'QQQQQQQk/QQQQQQ2/QQQQQ3/8/8/8/8/K7 b - - 0 1',
    '4k3/8/8/8/8/8/4P3/4K3 w - - 99999 1',
    '4k3/8/8/8/8/8/4P3/4K3 w - - 0 99999999',
    '4k3/pppppppp/pppppppp/8/8/PPPPPPPP/PPPPPPPP/4K3 w - - 0 1',
  ];
  let seed = 2024;
  const random = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
  const random_fens: string[] = [];
  const PIECES = 'PNBRQpnbrq';
  for (let i = 0; i < 150; i++) {
    const board: string[] = new Array(64).fill('');
    board[random(64)] = 'K';
    let black = random(64);
    while (board[black]) black = random(64);
    board[black] = 'k';
    for (let extra = random(30); extra > 0; extra--) {
      const square = random(64);
      if (!board[square]) board[square] = PIECES[random(PIECES.length)];
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
      rows.push(text + (empty || ''));
    }
    random_fens.push(`${rows.join('/')} ${random(2) ? 'w' : 'b'} - - 0 1`);
  }
  return [...fixed, ...random_fens];
}

describe('the position check protects the engine', () => {
  it('never lets through a position Stockfish would reject', async () => {
    let passed = 0;
    let blocked = 0;
    const failures: string[] = [];
    for (const fen of candidates()) {
      try {
        new Chess(fen);
      } catch {
        continue;
      }
      if (isIllegalPosition(fen)) {
        blocked++;
        continue;
      }
      passed++;
      const answer = await askStockfish(fen);
      if (answer !== 'ok') failures.push(`${fen}: ${answer}`);
    }
    console.log(`${passed} positions passed the check and all went to Stockfish; ${blocked} blocked`);
    expect(passed).toBeGreaterThan(10);
    expect(blocked).toBeGreaterThan(3);
    expect(failures).toEqual([]);
  });
});
