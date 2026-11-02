import { useEffect, useState } from 'react';
import { parseGame } from '../lib/chess';
import { loadGame, saveGame } from '../lib/storage';
import { ingestReview } from '../training/activity';
import { analyzeGame } from './analyze';

export interface BatchState {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  failed: number;
}

const IDLE: BatchState = { running: false, done: 0, total: 0, current: null, failed: 0 };
let state = IDLE;
let cancelled = false;
const listeners = new Set<(next: BatchState) => void>();

function publish(next: BatchState) {
  state = next;
  for (const listener of listeners) listener(next);
}

/**
 * Analyses many games one after another. It lives outside any page,
 * so that it keeps going while you browse the rest of the app.
 */
export async function runBatch(ids: string[], depth: number) {
  if (state.running) return;
  cancelled = false;
  publish({ running: true, done: 0, total: ids.length, current: null, failed: 0 });
  let failed = 0;
  for (const [index, id] of ids.entries()) {
    if (cancelled) break;
    const game = loadGame(id);
    if (game && !game.review) {
      publish({ ...state, done: index, current: `${game.white} vs ${game.black}` });
      try {
        const review = await analyzeGame(parseGame(game.pgn), depth, () => undefined, () => cancelled);
        if (review) {
          const reviewed = { ...game, review };
          saveGame(reviewed);
          ingestReview(reviewed);
        }
      } catch {
        failed++;
      }
    }
    publish({ ...state, done: index + 1, failed });
  }
  publish({ ...IDLE, done: state.done, total: state.total, failed });
}

export function cancelBatch() {
  cancelled = true;
}

export function useBatch(): BatchState {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    listeners.add(setCurrent);
    setCurrent(state);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);
  return current;
}
