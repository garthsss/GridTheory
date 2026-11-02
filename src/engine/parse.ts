import type { EngineLine, Score } from './score';

const INFO = /^info .*?\bdepth (\d+)\b.*?\bscore (cp|mate) (-?\d+)( lowerbound| upperbound)?.*? pv (.+)$/;

/** Parses one UCI "info" line. `flip` is -1 when Black is to move, so scores come out from White's view. */
export function parseInfo(line: string, flip: 1 | -1) {
  const match = INFO.exec(line);
  if (!match || match[4]) return null;
  const multipv = Number(/\bmultipv (\d+)/.exec(line)?.[1] ?? 1);
  const value = Number(match[3]) * flip;
  const score: Score = match[2] === 'cp' ? { cp: value, mate: null } : { cp: null, mate: value };
  const pv = match[5].trim().split(/\s+/);
  return { multipv, depth: Number(match[1]), line: { move: pv[0], score, pv } satisfies EngineLine };
}
