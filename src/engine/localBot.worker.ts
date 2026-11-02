import { chooseMove, type LocalProfile } from './localBot';

self.onmessage = (event: MessageEvent<{ id: number; fen: string; profile: LocalProfile }>) => {
  const { id, fen, profile } = event.data;
  self.postMessage({ id, move: chooseMove(fen, profile) });
};
