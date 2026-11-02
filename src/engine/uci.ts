import { Chess } from 'chess.js';
import { isIllegalPosition, turnOf } from '../lib/chess';
import { parseInfo } from './parse';
import type { Analysis, EngineLine } from './score';

const ENGINE_URL = `${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`;
/** A search taking this long has hung. Deep review searches finish well inside it, even on slow machines. */
const SEARCH_TIMEOUT = 180_000;

export interface SearchOptions {
  depth?: number;
  movetime?: number;
  multipv?: number;
}

/** A Stockfish worker. Searches run one at a time, in the order they were requested. */
export class UciEngine {
  private worker: Worker | null = null;
  private listeners = new Set<(line: string) => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | null = null;
  private generation = 0;
  private failSearch: ((error: Error) => void) | null = null;
  private options = new Map<string, string | number | boolean>();

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const worker = new Worker(ENGINE_URL);
      this.worker = worker;
      worker.onmessage = (event) => {
        const line = typeof event.data === 'string' ? event.data : String(event.data);
        for (const listener of [...this.listeners]) listener(line);
      };
      worker.onerror = (event) => {
        const error = new Error(`The chess engine stopped: ${event.message}`);
        this.discard();
        reject(error);
        this.failSearch?.(error);
      };
      this.waitFor((line) => line === 'uciok')
        .then(() => {
          this.send('setoption name Hash value 32');
          for (const [name, value] of this.options) this.send(`setoption name ${name} value ${value}`);
          return this.isReady();
        })
        .then(() => resolve(), reject);
      this.send('uci');
    });
    return this.ready;
  }

  /**
   * Throws the worker away. After an error it may still answer, but for the wrong position, so it can't be
   * trusted. The next request starts a fresh one with the same settings.
   */
  private discard() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.listeners.clear();
  }

  private send(command: string) {
    this.worker?.postMessage(command);
  }

  private waitFor(predicate: (line: string) => boolean): Promise<string> {
    return new Promise((resolve) => {
      const listener = (line: string) => {
        if (predicate(line)) {
          this.listeners.delete(listener);
          resolve(line);
        }
      };
      this.listeners.add(listener);
    });
  }

  private isReady(): Promise<string> {
    const done = this.waitFor((line) => line === 'readyok');
    this.send('isready');
    return done;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Sets a UCI option once all earlier searches have finished. */
  setOption(name: string, value: string | number | boolean): Promise<void> {
    return this.enqueue(async () => {
      this.options.set(name, value);
      await this.start();
      this.send(`setoption name ${name} value ${value}`);
      await this.isReady();
    });
  }

  newGame(): Promise<void> {
    return this.enqueue(async () => {
      await this.start();
      this.send('ucinewgame');
      await this.isReady();
    });
  }

  /** Stops the running search and drops any searches still in the queue; they resolve with no lines. */
  cancelAll() {
    this.generation++;
    if (this.worker) this.send('stop');
  }

  search(fen: string, options: SearchOptions = {}): Promise<Analysis> {
    const generation = this.generation;
    return this.enqueue(async () => {
      const chess = new Chess(fen);
      if (chess.isCheckmate()) return { fen, depth: 0, lines: [], terminal: 'checkmate' as const };
      if (chess.isStalemate()) return { fen, depth: 0, lines: [], terminal: 'stalemate' as const };
      if (generation !== this.generation) return { fen, depth: 0, lines: [] };
      if (isIllegalPosition(fen)) throw new Error('That position is not legal, so the engine cannot analyse it.');

      await this.start();
      const multipv = options.multipv ?? 1;
      this.send(`setoption name MultiPV value ${multipv}`);
      // chess.js's normalised FEN, so that nothing but a position can reach the engine's command line.
      this.send(`position fen ${chess.fen()}`);

      const lines = new Map<number, EngineLine>();
      let depth = 0;
      const flip = turnOf(fen) === 'b' ? -1 : 1;
      const collect = (line: string) => {
        const parsed = parseInfo(line, flip);
        if (parsed) {
          lines.set(parsed.multipv, parsed.line);
          depth = Math.max(depth, parsed.depth);
        }
        return line.startsWith('bestmove');
      };
      const done = this.waitFor(collect);
      if (options.movetime) this.send(`go movetime ${options.movetime}`);
      else this.send(`go depth ${options.depth ?? 12}`);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          this.failSearch = reject;
          watchdog = setTimeout(() => {
            this.discard();
            reject(new Error('The chess engine stopped responding. Try again.'));
          }, (options.movetime ?? 0) + SEARCH_TIMEOUT);
        }),
      ]).finally(() => {
        clearTimeout(watchdog);
        this.failSearch = null;
        this.listeners.clear();
      });

      const ordered = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line);
      const bestmove = finished.split(' ')[1];
      if (ordered.length === 0 && bestmove && bestmove !== '(none)') {
        ordered.push({ move: bestmove, score: { cp: 0, mate: null }, pv: [bestmove] });
      }
      return { fen, depth, lines: ordered };
    });
  }
}

/** Full-strength engine used for coaching and game review. */
export const analysisEngine = new UciEngine();
/** Separate engine for opponents, because it runs with its strength limited. */
export const opponentEngine = new UciEngine();
