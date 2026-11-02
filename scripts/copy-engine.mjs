// Copies the single-threaded "lite" Stockfish build into public/ so the browser can load it as a worker.
// The single-threaded build needs no cross-origin isolation headers, so it also runs on plain static hosting.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'stockfish', 'bin');
const target = join(root, 'public', 'engine');

if (existsSync(source)) {
  mkdirSync(target, { recursive: true });
  for (const file of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
    cpSync(join(source, file), join(target, file));
  }
  cpSync(join(root, 'node_modules', 'stockfish', 'Copying.txt'), join(target, 'COPYING.txt'));
}
