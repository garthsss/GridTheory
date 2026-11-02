import { analysisEngine } from '../engine/uci';
import type { Analysis } from '../engine/score';
import { buildMoveReport, findSacrifice, type MoveReport } from './explain';

/**
 * Builds a report, and re-searches deeper before calling anything a mistake or blunder. Shallow searches
 * can miss a sacrifice's point, and wrongly scolding a strong move is worse than a slower answer.
 * Sacrifices get the same deeper search, with a second line to judge whether the move is brilliant.
 */
export async function verifiedReport(
  fenBefore: string,
  fenAfter: string,
  uci: string,
  before: Analysis,
  after: Analysis,
  depth: number,
): Promise<MoveReport> {
  const report = buildMoveReport(fenBefore, uci, before, after);
  if (report.cls !== 'mistake' && report.cls !== 'blunder' && !findSacrifice(fenBefore, uci)) return report;
  const deeper = Math.max(depth + 6, 18);
  const [deepBefore, deepAfter] = await Promise.all([
    analysisEngine.search(fenBefore, { depth: deeper, multipv: 2 }),
    analysisEngine.search(fenAfter, { depth: deeper, multipv: 2 }),
  ]);
  return buildMoveReport(fenBefore, uci, deepBefore, deepAfter);
}
