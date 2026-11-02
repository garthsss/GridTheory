import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { ChessClock } from '../src/core/clock';
import { GameSession } from '../src/core/session';
import { ALL_LESSONS } from '../src/course/content';
import { ImportError, fetchChessCom, fetchLichess, importGames, toSavedGame } from '../src/import/sources';
import { isIllegalPosition, parseGame } from '../src/lib/chess';
import { MemoryAdapter, SCHEMA_VERSION, Store, migrate } from '../src/lib/store';
import { INTERVALS, drillsFromReview, dueDrills, scheduleDrill, type Drill } from '../src/training/drills';
import { buildPlan, currentStreak, itemDone, planDone } from '../src/training/plan';
import { THEME_FILTERS, decodePuzzles, isCorrectMove, pickPuzzle, updatePuzzleRating } from '../src/training/puzzles';
import puzzleFile from '../src/training/puzzles.json';
import { MIN_EVIDENCE, SKILLS, eventsFromDrill, eventsFromPuzzle, eventsFromReview, scoreSkills, weakestSkills, type SkillEvent } from '../src/training/skills';
import type { ReviewData, ReviewedMove } from '../src/review/analyze';

const DAY = 86_400_000;

describe('storage', () => {
  it('upgrades Phase 2 data without losing anything', () => {
    const games = [
      { id: 'a', pgn: '[Event "GridTheory training: Pawn race"]\n\n1.e4', source: 'bot' },
      { id: 'b', pgn: '[Event "GridTheory game"]\n\n1.d4', source: 'bot' },
    ];
    const out = migrate({
      'gt.games': JSON.stringify(games),
      'gt.settings': '{"apiKey":"k","model":"m"}',
      'gt.rating': '{"value":1200,"games":9}',
      'gt.progress': '{"forks":true}',
      'gt.prefs': '{"theme":"light"}',
      'gt.training': '{}',
    });
    expect(Number(out.schema)).toBe(SCHEMA_VERSION);
    expect(JSON.parse(out.rating).value).toBe(1200);
    expect(out.settings).toBeUndefined();
    expect(JSON.parse(out.progress).forks).toBe(true);
    expect(JSON.parse(out['game:a']).source).toBe('training');
    expect(JSON.parse(out['game:b']).source).toBe('bot');
    expect(Object.keys(out).some((key) => key.startsWith('gt.'))).toBe(false);
  });

  it('survives a damaged game list', () => {
    const out = migrate({ 'gt.games': 'not json', 'gt.rating': '{"value":900,"games":1}' });
    expect(JSON.parse(out.rating).value).toBe(900);
  });

  it('leaves current data unchanged', () => {
    const current = { schema: String(SCHEMA_VERSION), rating: '{"value":1}', 'game:x': '{"pgn":"","source":"bot"}' };
    expect(migrate(current)).toEqual(current);
  });

  it('prefers data already in the store over old leftovers, and writes through', async () => {
    const adapter = new MemoryAdapter();
    adapter.data = { schema: String(SCHEMA_VERSION), rating: '{"value":1500,"games":3}' };
    const store = new Store();
    await store.hydrate(adapter, { 'gt.rating': '{"value":800,"games":0}' });
    expect(store.get('rating', { value: 0 }).value).toBe(1500);
    store.set('profile', { name: 'A' });
    await Promise.resolve();
    expect(JSON.parse(adapter.data.profile).name).toBe('A');
    store.remove('profile');
    await Promise.resolve();
    expect(adapter.data.profile).toBeUndefined();
  });

  it('lists records by prefix, and restores old backups', async () => {
    const store = new Store();
    await store.hydrate(new MemoryAdapter());
    store.set('drill:1', { id: '1' });
    store.set('drill:2', { id: '2' });
    store.set('other', 1);
    expect(store.list('drill:')).toHaveLength(2);
    await store.importAll({ 'gt.rating': '{"value":1700,"games":2}', 'gt.settings': '{"apiKey":"old"}' });
    expect(store.get('rating', { value: 0 }).value).toBe(1700);
    expect(store.get('settings', null)).toBeNull();
  });

  it('deletes an API key left over from the old Claude coach', async () => {
    const adapter = new MemoryAdapter();
    adapter.data = { schema: '2', settings: '{"apiKey":"sk-ant-old"}', rating: '{"value":1500,"games":3}' };
    const store = new Store();
    await store.hydrate(adapter);
    expect(adapter.data.settings).toBeUndefined();
    expect(store.exportAll().settings).toBeUndefined();
    expect(JSON.parse(adapter.data.rating).value).toBe(1500);
  });

  it('warns rather than losing track when a write fails', async () => {
    const adapter = new MemoryAdapter();
    const store = new Store();
    await store.hydrate(adapter);
    adapter.put = async () => {
      throw new Error('Quota exceeded');
    };
    store.set('x', 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.lastError).toContain('Quota');
  });
});

describe('chess core has no UI dependencies', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  const core = [...walk('src/core'), 'src/lib/chess.ts', 'src/lib/openings.ts', 'src/engine/score.ts', 'src/engine/elo.ts', 'src/coach/explain.ts', 'src/training/drills.ts', 'src/training/plan.ts', 'src/training/skills.ts'];
  for (const file of core) {
    it(file, () => {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/from 'react/);
      expect(text).not.toMatch(/\b(window|document|localStorage|indexedDB)\./);
    });
  }
});

describe('GameSession', () => {
  it('rejects illegal moves and moves after the game ends', () => {
    const game = new GameSession();
    expect(() => game.move('e5')).toThrow();
    game.move('e4');
    game.resign('b');
    expect(game.status()).toMatchObject({ over: true, result: '1-0', reason: 'resignation' });
    expect(() => game.move('e5')).toThrow(/over/);
  });
  it('detects mate by the rules, and takes moves back', () => {
    const game = new GameSession();
    for (const san of ['f3', 'e5', 'g4', 'Qh4#']) game.move(san);
    expect(game.status()).toMatchObject({ over: true, result: '0-1', reason: 'checkmate' });
    game.undo();
    expect(game.status().over).toBe(false);
  });
  it('writes PGN with headers', () => {
    const game = new GameSession();
    game.move('e4');
    expect(game.pgn({ White: 'Me', Result: '*' })).toContain('[White "Me"]');
    expect(game.movetext()).toContain('1. e4');
  });
});

describe('ChessClock', () => {
  it('counts only the active side, and adds increment', () => {
    const clock = new ChessClock(60_000, 2_000);
    clock.start('w', 0);
    expect(clock.read(10_000).w).toBe(50_000);
    expect(clock.read(10_000).b).toBe(60_000);
    clock.addIncrement('w');
    clock.start('b', 10_000);
    expect(clock.read(15_000)).toMatchObject({ w: 52_000, b: 55_000, flagged: null });
  });
  it('stops counting while paused', () => {
    const clock = new ChessClock(60_000, 0);
    clock.start('w', 0);
    clock.pause(5_000);
    expect(clock.read(50_000).w).toBe(55_000);
  });
  it('flags at zero', () => {
    const clock = new ChessClock(1_000, 0);
    clock.start('b', 0);
    expect(clock.read(2_000)).toMatchObject({ b: 0, flagged: 'b' });
  });
});

const LICHESS_PGN = '[Event "Rated blitz game"]\n[White "Me_Player"]\n[Black "Other"]\n[Result "1-0"]\n[WhiteElo "1500"]\n[TimeControl "300+0"]\n\n1. e4 { [%clk 0:05:00] } e5 { [%clk 0:05:00] } 2. Nf3 Nc6 1-0\n';

const respond = (body: string, status = 200) => new Response(body, { status });

describe('importing games', () => {
  it('reads Lichess responses, skipping variants', async () => {
    const lines = [
      JSON.stringify({ id: 'abc', variant: 'standard', createdAt: 1700000000000, pgn: LICHESS_PGN }),
      JSON.stringify({ id: 'var', variant: 'chess960', createdAt: 1700000000000, pgn: LICHESS_PGN }),
    ].join('\n');
    let seen = '';
    const games = await fetchLichess('Me_Player', 10, async (url) => {
      seen = String(url);
      return respond(lines);
    });
    expect(games.map((game) => game.externalId)).toEqual(['abc']);
    expect(seen).toContain('/api/games/user/Me_Player');
    expect(seen).toContain('max=10');
  });

  it('reads Chess.com monthly archives, newest first, up to the limit', async () => {
    const months: Record<string, unknown> = {
      '/2026/09': { games: [{ url: 'https://chess.com/game/live/1', pgn: LICHESS_PGN, rules: 'chess', end_time: 1 }] },
      '/2026/10': {
        games: [
          { url: 'https://chess.com/game/live/2', pgn: LICHESS_PGN, rules: 'chess', end_time: 2 },
          { url: 'https://chess.com/game/live/3', pgn: LICHESS_PGN, rules: 'chess960', end_time: 3 },
          { url: 'https://chess.com/game/live/4', pgn: LICHESS_PGN, rules: 'chess', end_time: 4 },
        ],
      },
    };
    const fetcher = async (url: string) => {
      if (url.endsWith('/archives')) return respond(JSON.stringify({ archives: ['https://api.chess.com/pub/player/someone/games/2026/09', 'https://api.chess.com/pub/player/someone/games/2026/10'] }));
      return respond(JSON.stringify(months[url.slice(url.lastIndexOf('/2026'))]));
    };
    const two = await fetchChessCom('Someone', 2, fetcher);
    expect(two.map((game) => game.externalId.at(-1))).toEqual(['4', '2']);
    const all = await fetchChessCom('Someone', 10, fetcher);
    expect(all.map((game) => game.externalId.at(-1))).toEqual(['4', '2', '1']);
  });

  it('works out your colour, drops clock comments, and stays parseable', () => {
    const saved = toSavedGame({ site: 'lichess', externalId: 'abc', pgn: LICHESS_PGN, playedAt: 1700000000000 }, 'me_player')!;
    expect(saved.playerColor).toBe('w');
    expect(saved.pgn).not.toContain('%clk');
    expect(saved.pgn).toContain('[WhiteElo "1500"]');
    expect(saved.id).toBe('lichess-abc');
    expect(parseGame(saved.pgn).moves.map((move) => move.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('handles games starting from a position with Black to move', () => {
    const pgn = '[White "A"]\n[Black "me"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 7"]\n\n7... Kd7 8. e4 *';
    const saved = toSavedGame({ site: 'lichess', externalId: 'x', pgn, playedAt: 1 }, 'me')!;
    expect(saved.pgn).toContain('7...Kd7 8.e4');
    expect(parseGame(saved.pgn).moves).toHaveLength(2);
  });

  it('skips duplicates and counts unreadable games', async () => {
    const lines = [
      JSON.stringify({ id: 'old', variant: 'standard', createdAt: 1, pgn: LICHESS_PGN }),
      JSON.stringify({ id: 'new', variant: 'standard', createdAt: 2, pgn: LICHESS_PGN }),
      JSON.stringify({ id: 'bad', variant: 'standard', createdAt: 3, pgn: '1. e9 *' }),
    ].join('\n');
    const result = await importGames('lichess', 'Me_Player', 10, new Set(['old']), async () => respond(lines));
    expect(result.added.map((game) => game.externalId)).toEqual(['new']);
    expect(result.skipped).toBe(1);
    expect(result.unreadable).toBe(1);
  });

  it('gives clear errors', async () => {
    await expect(importGames('lichess', 'nobody', 5, new Set(), async () => respond('', 404))).rejects.toThrow(/no player called/);
    await expect(importGames('lichess', 'x_y', 5, new Set(), async () => respond('', 429))).rejects.toThrow(/limiting/);
    await expect(importGames('chesscom', 'x_y', 5, new Set(), async () => { throw new TypeError('network'); })).rejects.toThrow(ImportError);
    await expect(importGames('lichess', 'bad name!/', 5, new Set(), async () => respond(''))).rejects.toThrow(/valid username/);
  });
});

const move = (patch: Partial<ReviewedMove>): ReviewedMove =>
  ({ color: 'w', cls: 'best', winBefore: 60, winAfter: 60, loss: 0, themes: [], phase: 'middlegame', accuracy: 100, scoreAfter: { cp: 0, mate: null }, ply: 1, fenBefore: 'f', san: 'e4', bestUci: 'e2e4', bestSan: 'e4', bestLine: '', headline: '', ...patch }) as ReviewedMove;

const review = (moves: ReviewedMove[]) => ({ moves, depth: 10, opening: null, sides: {} }) as unknown as ReviewData;

describe('drills', () => {
  it('takes only your own mistakes, and skips positions already lost', () => {
    const drills = drillsFromReview('g', review([
      move({ ply: 1, cls: 'blunder', san: 'Qh5' }),
      move({ ply: 2, color: 'b', cls: 'blunder' }),
      move({ ply: 3, cls: 'mistake' }),
      move({ ply: 5, cls: 'inaccuracy' }),
      move({ ply: 7, cls: 'blunder', winBefore: 10 }),
      move({ ply: 9, cls: 'best' }),
    ]), 'w', 1000);
    expect(drills.map((drill) => drill.id)).toEqual(['g-1', 'g-3']);
    expect(drills[0]).toMatchObject({ playedSan: 'Qh5', box: 0, dueAt: 1000 });
  });

  const fresh: Drill = { id: 'd', gameId: 'g', fen: 'f', color: 'w', playedSan: 'a', bestUci: 'b', bestSan: 'b', bestLine: '', headline: '', themes: [], winBefore: 50, box: 0, dueAt: 0, attempts: 0, correct: 0 };

  it('spaces out correct answers, and resets on a miss', () => {
    const once = scheduleDrill(fresh, true, 0);
    expect(once).toMatchObject({ box: 1, dueAt: INTERVALS[1] * DAY, correct: 1 });
    const twice = scheduleDrill(once, true, 0);
    expect(twice.dueAt).toBe(INTERVALS[2] * DAY);
    const missed = scheduleDrill(twice, false, 0);
    expect(missed).toMatchObject({ box: 0, dueAt: INTERVALS[0] * DAY, attempts: 3, correct: 2 });
  });

  it('retires a drill after the longest gap', () => {
    let drill = fresh;
    for (let i = 0; i < INTERVALS.length; i++) drill = scheduleDrill(drill, true, 0);
    expect(drill.retired).toBe(true);
    expect(dueDrills([drill], Infinity)).toEqual([]);
  });

  it('lists only what is due, oldest first', () => {
    const due = dueDrills([{ ...fresh, id: 'later', dueAt: 500 }, { ...fresh, id: 'b', dueAt: 50 }, { ...fresh, id: 'a', dueAt: 10 }], 100);
    expect(due.map((drill) => drill.id)).toEqual(['a', 'b']);
  });
});

describe('puzzle set', () => {
  const puzzles = decodePuzzles(puzzleFile as never);

  it('has thousands of unique puzzles across the rating range', () => {
    expect(puzzles.length).toBeGreaterThan(4000);
    expect(new Set(puzzles.map((puzzle) => puzzle.id)).size).toBe(puzzles.length);
    expect(Math.min(...puzzles.map((puzzle) => puzzle.rating))).toBeLessThan(500);
    expect(Math.max(...puzzles.map((puzzle) => puzzle.rating))).toBeGreaterThan(2500);
  });

  it('contains only legal positions and solutions', () => {
    for (const puzzle of puzzles) {
      expect(isIllegalPosition(puzzle.fen), puzzle.id).toBe(false);
      const chess = new Chess(puzzle.fen);
      for (const uci of puzzle.moves) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      // Lichess puzzles end on the solver's move, so there are always an even number of plies.
      expect(puzzle.moves.length % 2, puzzle.id).toBe(0);
    }
  }, 60_000);

  it('has puzzles for every theme filter', () => {
    for (const filter of THEME_FILTERS) {
      const count = filter.themes.length ? puzzles.filter((p) => p.themes.some((t) => filter.themes.includes(t))).length : puzzles.length;
      expect(count, filter.id).toBeGreaterThan(100);
    }
  });

  it('picks near the target, respects themes, and avoids repeats', () => {
    const fixed = () => 0.5;
    const picked = pickPuzzle(puzzles, 1500, new Set(), [], fixed)!;
    expect(Math.abs(picked.rating - 1500)).toBeLessThanOrEqual(75);
    const fork = pickPuzzle(puzzles, 1500, new Set(), ['fork'], fixed)!;
    expect(fork.themes).toContain('fork');
    expect(pickPuzzle(puzzles, 1500, new Set([picked.id]), [], fixed)!.id).not.toBe(picked.id);
    expect(pickPuzzle(puzzles, 1500, new Set(puzzles.map((p) => p.id)), [], fixed)).not.toBeNull();
  });

  it('accepts the listed move, or any other mate', () => {
    expect(isCorrectMove('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', 'a1a8', 'a1a8')).toBe(true);
    // Two different mates in one position: both Ra8 and Rb8 are mate here.
    expect(isCorrectMove('6k1/5ppp/8/8/8/8/1R6/R3K3 w - - 0 1', 'a1a8', 'b2b8')).toBe(true);
    expect(isCorrectMove('6k1/5ppp/8/8/8/8/1R6/R3K3 w - - 0 1', 'a1a8', 'b2b7')).toBe(false);
  });

  it('rates easy wins and hard losses gently', () => {
    const base = { value: 1500, games: 100 };
    expect(updatePuzzleRating(base, 800, true).value).toBe(1500);
    expect(updatePuzzleRating(base, 2400, false).value).toBe(1500);
    expect(updatePuzzleRating(base, 1500, true).value).toBe(1508);
    expect(updatePuzzleRating(base, 1500, false).value).toBe(1492);
  });
});

describe('skill map', () => {
  const event = (skill: SkillEvent['skill'], value: number, t = 1, weight = 1): SkillEvent => ({ t, skill, value, weight, source: 'game' });

  it('stays silent without enough evidence', () => {
    const scores = scoreSkills([event('tactics', 1)]);
    expect(scores.tactics).toMatchObject({ score: null, samples: 1 });
    expect(MIN_EVIDENCE).toBeGreaterThan(1);
  });

  it('weights recent results more', () => {
    const improving = Array.from({ length: 40 }, (_, i) => event('tactics', i < 20 ? 0 : 1, i));
    const scores = scoreSkills(improving);
    expect(scores.tactics.score!).toBeGreaterThan(50);
    expect(scores.tactics.trend!).toBeGreaterThan(0);
  });

  it('ranks weakest first, ignoring skills without data', () => {
    const scores = scoreSkills([
      ...Array.from({ length: 5 }, () => event('endgame', 0.2)),
      ...Array.from({ length: 5 }, () => event('tactics', 0.9)),
    ]);
    expect(weakestSkills(scores)).toEqual(['endgame', 'tactics']);
  });

  it('only counts your own moves from a game', () => {
    const moves = [
      ...Array.from({ length: 10 }, (_, i) => move({ ply: i, phase: 'opening', accuracy: 80 })),
      ...Array.from({ length: 10 }, (_, i) => move({ ply: i, color: 'b', phase: 'opening', accuracy: 10, themes: ['hung-piece'] })),
    ];
    const events = eventsFromReview(review(moves), 'w', 5);
    expect(events.find((e) => e.skill === 'opening')!.value).toBeCloseTo(0.8);
    expect(events.find((e) => e.skill === 'safety')!.value).toBe(1);
  });

  it('marks down hanging pieces', () => {
    const moves = Array.from({ length: 10 }, (_, i) => move({ ply: i, themes: i === 0 ? ['hung-piece'] : [] }));
    expect(eventsFromReview(review(moves), 'w', 5).find((e) => e.skill === 'safety')!.value).toBeCloseTo(0.5);
  });

  it('judges puzzles against what was expected', () => {
    const easyWin = eventsFromPuzzle(['fork'], 1, true, 0.9, 1)[0].value;
    const hardWin = eventsFromPuzzle(['fork'], 1, true, 0.2, 1)[0].value;
    const easyMiss = eventsFromPuzzle(['fork'], 1, false, 0.9, 1)[0].value;
    expect(hardWin).toBeGreaterThan(easyWin);
    expect(easyMiss).toBeLessThan(0.5);
    // Results average out to par at any difficulty, so puzzles don't skew the skill comparison.
    for (const expected of [0.2, 0.5, 0.9]) {
      const win = eventsFromPuzzle(['fork'], 1, true, expected, 1)[0].value;
      const miss = eventsFromPuzzle(['fork'], 1, false, expected, 1)[0].value;
      expect(expected * win + (1 - expected) * miss).toBeCloseTo(0.7);
    }
    const skills = eventsFromPuzzle(['mateIn2', 'endgame'], 3, true, 0.5, 1).map((e) => e.skill);
    expect(skills).toEqual(expect.arrayContaining(['mating', 'endgame', 'calculation']));
    expect(skills).not.toContain('tactics');
  });

  it('maps drill themes to skills', () => {
    expect(eventsFromDrill(['hung-piece'], true, 1)[0]).toMatchObject({ skill: 'safety', value: 1 });
    expect(eventsFromDrill(['missed-mate'], false, 1)[0]).toMatchObject({ skill: 'mating', value: 0 });
  });

  it('points every skill at real lessons', () => {
    const ids = ALL_LESSONS.map((lesson) => lesson.id);
    for (const skill of SKILLS) for (const lesson of skill.lessons) expect(ids).toContain(lesson);
  });
});

describe('daily plan', () => {
  const input = { dueDrills: 3, weakest: [], nextLesson: { id: 'forks', title: 'Forks' }, date: '2026-10-31' };

  it('puts your own mistakes first', () => {
    const plan = buildPlan(input);
    expect(plan.map((item) => item.kind)).toEqual(['drills', 'puzzles', 'scenario', 'lesson']);
    expect(plan[0].target).toBe(3);
  });
  it('caps drills, and leaves them out when none are due', () => {
    expect(buildPlan({ ...input, dueDrills: 40 })[0].target).toBe(5);
    expect(buildPlan({ ...input, dueDrills: 0 })[0].kind).toBe('puzzles');
  });
  it('aims practice at the weakest skills', () => {
    const plan = buildPlan({ ...input, weakest: ['mating', 'endgame'] });
    expect(plan.find((item) => item.kind === 'puzzles')!.href).toContain('/mate');
    expect(plan.find((item) => item.kind === 'scenario')!.href).toContain('/endgame');
  });
  it('tracks completion', () => {
    const plan = buildPlan({ ...input, dueDrills: 0, nextLesson: null });
    expect(itemDone(plan[0], { puzzles: 4 })).toBe(false);
    expect(itemDone(plan[0], { puzzles: 5 })).toBe(true);
    expect(planDone(plan, { puzzles: 5, scenario: 1 })).toBe(true);
    expect(planDone(plan, { puzzles: 5 })).toBe(false);
  });
  it('counts streaks, without breaking one before today is done', () => {
    const previous = (date: string) => `d${Number(date.slice(1)) - 1}`;
    expect(currentStreak(new Set(['d10', 'd9', 'd8']), 'd10', previous)).toBe(3);
    expect(currentStreak(new Set(['d9', 'd8']), 'd10', previous)).toBe(2);
    expect(currentStreak(new Set(['d8']), 'd10', previous)).toBe(0);
  });
});
