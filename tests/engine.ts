import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { isIllegalPosition, turnOf } from '../src/lib/chess';
import { winPercentFor, type Analysis, type EngineLine, type Score } from '../src/engine/score';
import { parseInfo } from '../src/engine/parse';

/** Stockfish in a Node subprocess, for the slow verification suites. */
export class NodeEngine {
  private proc = spawn(process.execPath, [join(process.cwd(), 'node_modules/stockfish/bin/stockfish-19-lite-single.js')]);
  private buffer = '';
  private waiter: ((line: string) => void) | null = null;

  constructor() {
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        this.waiter?.(line);
      }
    });
  }

  private until(command: string, done: (line: string) => boolean, onLine?: (line: string) => void): Promise<string> {
    return new Promise((resolve) => {
      this.waiter = (line) => {
        onLine?.(line);
        if (done(line)) resolve(line);
      };
      this.proc.stdin.write(`${command}\n`);
    });
  }

  async init() {
    await this.until('uci', (line) => line === 'uciok');
    await this.until('isready', (line) => line === 'readyok');
  }

  send(command: string) {
    this.proc.stdin.write(`${command}\n`);
  }

  /** Best move and score from White's point of view. */
  async analyse(fen: string, depth: number): Promise<{ score: Score; best: string; pv: string[] }> {
    const chess = new Chess(fen);
    if (chess.isCheckmate()) return { score: { cp: null, mate: chess.turn() === 'w' ? -1 : 1 }, best: '', pv: [] };
    if (chess.isDraw()) return { score: { cp: 0, mate: null }, best: '', pv: [] };
    this.send(`position fen ${fen}`);
    const flip = turnOf(fen) === 'w' ? 1 : -1;
    let score: Score = { cp: 0, mate: null };
    let pv: string[] = [];
    const search = this.until(`go depth ${depth} movetime 4000`, (line) => line.startsWith('bestmove'), (line) => {
      const match = / score (cp|mate) (-?\d+)(?! (?:lower|upper)bound).* pv (.+)$/.exec(line);
      if (!match) return;
      const value = Number(match[2]) * flip;
      score = match[1] === 'cp' ? { cp: value, mate: null } : { cp: null, mate: value };
      pv = match[3].split(' ');
    });
    let timer: NodeJS.Timeout | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Engine gave no answer for ${fen}`)), 30_000);
    });
    const final = await Promise.race([search, watchdog]).finally(() => clearTimeout(timer));
    return { score, best: final.split(' ')[1], pv };
  }

  /** Multi-line search in the app's Analysis shape, for scenario generators and styled bots. */
  async search(fen: string, depth: number, multipv: number): Promise<Analysis> {
    const chess = new Chess(fen);
    if (chess.isCheckmate()) return { fen, depth: 0, lines: [], terminal: 'checkmate' };
    if (chess.isStalemate()) return { fen, depth: 0, lines: [], terminal: 'stalemate' };
    this.send(`setoption name MultiPV value ${multipv}`);
    this.send(`position fen ${fen}`);
    const flip = turnOf(fen) === 'w' ? 1 : -1;
    const lines = new Map<number, EngineLine>();
    let reached = 0;
    if (isIllegalPosition(fen)) throw new Error(`Illegal position reached the engine: ${fen}`);
    await this.until(`go depth ${depth}`, (line) => line.startsWith('bestmove'), (line) => {
      const parsed = parseInfo(line, flip);
      if (parsed) {
        lines.set(parsed.multipv, parsed.line);
        reached = Math.max(reached, parsed.depth);
      }
    });
    this.send('setoption name MultiPV value 1');
    return { fen, depth: reached, lines: [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line) };
  }

  /** Limits or unlimits strength, then searches by time, the way the app's Stockfish bots do. */
  async bestLimited(fen: string, elo: number | undefined, movetime: number): Promise<string> {
    this.send(`setoption name UCI_LimitStrength value ${elo !== undefined}`);
    if (elo !== undefined) this.send(`setoption name UCI_Elo value ${elo}`);
    this.send(`position fen ${fen}`);
    const final = await this.until(`go movetime ${movetime}`, (line) => line.startsWith('bestmove'));
    return final.split(' ')[1];
  }

  quit() {
    this.proc.stdin.write('quit\n');
    this.proc.kill();
  }
}

export const winFor = winPercentFor;
