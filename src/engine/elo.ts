export interface MatchResult {
  a: string;
  b: string;
  /** Points scored by a. */
  score: number;
  games: number;
}

const expected = (ra: number, rb: number) => 1 / (1 + 10 ** ((rb - ra) / 400));

/**
 * Maximum-likelihood ratings from match results, by gradient ascent on the logistic Elo model.
 * Each pair gets a half-point prior draw so that a 16–0 sweep gives a large finite gap rather than infinity.
 * The scale is then shifted so that the anchors' average fitted rating equals their average nominal rating.
 */
export function fitRatings(players: string[], results: MatchResult[], anchors: Record<string, number>): Record<string, number> {
  const ratings: Record<string, number> = Object.fromEntries(players.map((player) => [player, 0]));
  const smoothed = results.map((r) => ({ ...r, score: r.score + 0.5, games: r.games + 1 }));
  for (let step = 0; step < 40000; step++) {
    const gradient: Record<string, number> = Object.fromEntries(players.map((player) => [player, 0]));
    for (const r of smoothed) {
      const diff = r.score - r.games * expected(ratings[r.a], ratings[r.b]);
      gradient[r.a] += diff;
      gradient[r.b] -= diff;
    }
    let largest = 0;
    for (const player of players) {
      ratings[player] += gradient[player] * 1.5;
      largest = Math.max(largest, Math.abs(gradient[player]));
    }
    if (largest < 1e-4) break;
  }
  const names = Object.keys(anchors);
  const offset = names.reduce((sum, name) => sum + anchors[name] - ratings[name], 0) / names.length;
  for (const player of players) ratings[player] += offset;
  return ratings;
}
