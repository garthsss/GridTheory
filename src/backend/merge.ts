// Decides what to keep when the same record changed on two devices before they could sync. Progress should never be lost,
// so lists are combined and counters keep the furthest value. Pure, so that it can be tested and reused on a server.

type Json = Record<string, unknown>;

const parse = <T,>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const uniqueBy = <T,>(items: T[], id: (item: T) => unknown) => [...new Map(items.map((item) => [id(item), item])).values()];

function mergeTimed(local: { t: number }[], remote: { t: number }[], limit: number) {
  return uniqueBy([...remote, ...local], (point) => point.t).sort((a, b) => a.t - b.t).slice(-limit);
}

/** Returns the text to keep. Both sides exist: a deletion is handled by the sync engine. */
export function mergeRecord(key: string, local: string, remote: string): string {
  if (local === remote) return local;
  const a = parse<unknown>(local);
  const b = parse<unknown>(remote);
  // A damaged copy should never replace a good one.
  if (a === null) return remote;
  if (b === null) return local;

  const merged = mergeParsed(key, a, b);
  return merged === a ? local : merged === b ? remote : JSON.stringify(merged);
}

function mergeParsed(key: string, local: unknown, remote: unknown): unknown {
  const l = local as Json;
  const r = remote as Json;
  if (key === 'progress') return { ...r, ...l };
  if (key === 'events') return uniqueBy([...(remote as unknown[]), ...(local as unknown[])], (event) => JSON.stringify(event)).sort((x, y) => ((x as { t?: number }).t ?? 0) - ((y as { t?: number }).t ?? 0)).slice(-4000);
  if (key === 'ratingHistory' || key === 'puzzleHistory') return mergeTimed(local as { t: number }[], remote as { t: number }[], 500);
  if (key === 'puzzleSeen') return [...new Set([...(remote as string[]), ...(local as string[])])].slice(-3000);
  if (key === 'rushBest') return Number(remote) > Number(local) ? remote : local;
  if (key === 'rating' || key === 'puzzleRating') return Number(l.games ?? 0) >= Number(r.games ?? 0) ? local : remote;
  if (key === 'training') {
    const out: Json = { ...r };
    for (const [phase, stats] of Object.entries(l)) {
      const other = r[phase] as { attempts?: number } | undefined;
      if (!other || Number((stats as { attempts?: number }).attempts ?? 0) >= Number(other.attempts ?? 0)) out[phase] = stats;
    }
    return out;
  }
  if (key.startsWith('plan:')) {
    const out: Json = { ...r };
    for (const [kind, amount] of Object.entries(l)) out[kind] = Math.max(Number(amount), Number(r[kind] ?? 0));
    return out;
  }
  // A review is expensive to redo, so a copy with one wins, and one already fed into drills wins over that.
  if (key.startsWith('game:')) {
    const score = (game: Json) => (game.ingested ? 2 : game.review ? 1 : 0);
    return score(r) > score(l) ? remote : local;
  }
  // The copy scheduled further ahead has had more practice.
  if (key.startsWith('drill:')) return Number(r.dueAt ?? 0) > Number(l.dueAt ?? 0) ? remote : local;
  // The first device's profile keeps its id, so games stay linked to one player.
  if (key === 'profile') return String(r.createdAt ?? '') < String(l.createdAt ?? '') ? remote : local;
  return local;
}
