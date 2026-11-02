import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { CSP_HEADER, CSP_META, SECURITY_HEADERS, headersFile } from '../security-headers';
import { ImportError, fetchChessCom, importGames, toSavedGame } from '../src/import/sources';
import { BackupError, sanitizeBackup } from '../src/lib/backup';
import { PGN_LIMITS, PgnError, isIllegalPosition, parseGame, splitGames } from '../src/lib/chess';
import { SCHEMA_VERSION } from '../src/lib/store';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

/** Fails if parsing hostile input takes long. Before the fix, some of these froze the page for minutes. */
function quickly(run: () => void) {
  const start = performance.now();
  try {
    run();
  } catch {
    // Rejecting the input is fine; only the time matters.
  }
  expect(performance.now() - start).toBeLessThan(1500);
}

describe('hostile PGN input', () => {
  const big = PGN_LIMITS.input - 1000;
  const attacks: Record<string, string> = {
    'blank lines': '\n'.repeat(big),
    spaces: ' '.repeat(big),
    digits: '1'.repeat(big),
    'digits with spaces': '1 '.repeat(big / 2),
    'digits and dots': '1.'.repeat(big / 2),
    'open parens': '('.repeat(big),
    'open braces': '{'.repeat(big),
    'open brackets': '['.repeat(big),
    'tag prefix': '[a "'.repeat(big / 4),
    semicolons: ';\n'.repeat(big / 2),
    'many bad tokens': 'x '.repeat(big / 2),
    'dollar signs': '$'.repeat(big),
  };
  for (const [name, input] of Object.entries(attacks)) {
    it(`parses ${name} quickly`, () => {
      quickly(() => parseGame(input));
      quickly(() => splitGames(input));
    });
  }

  it('rejects input over the limits', () => {
    expect(() => parseGame(' '.repeat(PGN_LIMITS.input + 1))).toThrow(PgnError);
    expect(() => splitGames(' '.repeat(PGN_LIMITS.input + 1))).toThrow(/too large/);
    const manyGames = Array.from({ length: PGN_LIMITS.games + 1 }, () => '[White "a"]\n\n1.e4 *').join('\n\n');
    expect(() => splitGames(manyGames)).toThrow(/limit/);
    expect(() => parseGame(`${'a'.repeat(PGN_LIMITS.token + 1)}`)).toThrow(/not a chess move/);
  });

  it('caps absurdly long games', () => {
    const shuffle = 'Nf3 Nf6 Ng1 Ng8 '.repeat(PGN_LIMITS.plies / 4 + 1);
    expect(() => parseGame(shuffle)).toThrow(/more than/);
  });

  it('still reads ordinary notation in all its forms', () => {
    for (const text of ['1.e4 e5 2.Nf3', '1. e4 e5 2. Nf3', 'e4 e5 Nf3', '1 e4 e5 2 Nf3', '1.e4 $1 e5 $2 2.Nf3!?', '1.e4 {a} e5 (1...c5) ; note\n2.Nf3']) {
      expect(parseGame(text).moves.map((move) => move.san), text).toEqual(['e4', 'e5', 'Nf3']);
    }
    expect(parseGame('[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 7"]\n\n7...Kd7 8.e4').moves).toHaveLength(2);
  });

  it('treats special header names as plain text', () => {
    const game = parseGame('[__proto__ "polluted"]\n[constructor "x"]\n\n1.e4 *');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(game.headers.__proto__).toBe('polluted');
  });

  it('strips control characters and caps header values', () => {
    const game = parseGame(`[White "a\tb"]\n[Black "${'x'.repeat(1000)}"]\n\n1.e4 *`);
    expect(game.headers.White).toBe('a b');
    expect(game.headers.Black).toHaveLength(PGN_LIMITS.headerValue);
  });
});

describe('positions that would make the engine abort', () => {
  const REJECTED_BY_STOCKFISH = [
    'QQQQQQQk/QQQQQQ2/QQQQQ3/8/8/8/8/K7 b - - 0 1',
    '4k3/8/8/8/8/8/4P3/4K3 w - - 99999 1',
    '4k3/8/8/8/8/8/4P3/4K3 w - - 0 99999999',
    'RRRRRRRR/RR6/8/8/8/k7/8/K7 w - - 0 1',
    '4k3/pppppppp/pppppppp/8/8/PPPPPPPP/PPPPPPPP/4K3 w - - 0 1',
    '4k3/8/8/8/P7/8/PPPPPPPP/4K2R w - - 0 1',
    '7k/8/8/2QQQQQ1/QQQQQQQQ/8/8/K1Q5 b - - 0 1',
    '7k/5Q2/5K2/8/8/8/8/8 w - - 0 1'.replace('5Q2', '6Q1'),
  ];
  for (const fen of REJECTED_BY_STOCKFISH) {
    it(`refuses ${fen}`, () => {
      expect(isIllegalPosition(fen)).toBe(true);
      expect(() => parseGame(`[FEN "${fen}"]\n\n1.e4`)).toThrow(PgnError);
    });
  }

  it('still allows real positions, including several queens', () => {
    for (const fen of [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      '8/8/8/8/8/7k/8/QQQQK3 w - - 0 1',
      '4k3/8/8/8/8/8/4P3/4K3 w - - 100 300',
    ]) {
      expect(isIllegalPosition(fen), fen).toBe(false);
    }
  });
});

describe('backups', () => {
  const game = (patch = {}) => JSON.stringify({ id: 'g', pgn: '1.e4 e5', date: '2026-01-01', white: 'a', black: 'b', result: '*', playerColor: 'w', ...patch });
  const drill = (patch = {}) => JSON.stringify({ id: 'd', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', color: 'w', bestUci: 'e2e4', dueAt: 1, themes: [], ...patch });

  it('accepts a real backup', () => {
    const { data, dropped } = sanitizeBackup({ schema: '2', rating: '{"value":900,"games":1}', 'game:g': game(), 'drill:d': drill(), 'plan:2026-10-31': '{"puzzles":1}' });
    expect(dropped).toBe(0);
    expect(Object.keys(data)).toHaveLength(5);
  });

  it('never restores an API key, or anything it does not recognise', () => {
    const { data, dropped } = sanitizeBackup({ rating: '{}', settings: '{"apiKey":"sk-ant-evil"}', 'gt.settings': '{"apiKey":"x"}', evil: '1', '__proto__x': '1' });
    expect(Object.keys(data)).toEqual(['rating']);
    expect(dropped).toBe(4);
  });

  it('rejects files that are not backups', () => {
    for (const input of [null, 1, 'text', [], {}, { nonsense: '1' }]) expect(() => sanitizeBackup(input)).toThrow(BackupError);
  });

  it('refuses a backup from a newer version', () => {
    expect(() => sanitizeBackup({ schema: String(SCHEMA_VERSION + 1), rating: '{}' })).toThrow(/newer/);
    expect(() => sanitizeBackup({ schema: 'abc', rating: '{}' })).toThrow(/invalid/);
  });

  it('survives a __proto__ key from parsed JSON', () => {
    const input: unknown = JSON.parse('{"__proto__":"{\\"polluted\\":1}","rating":"{}"}');
    const { data } = sanitizeBackup(input);
    expect(Object.keys(data)).toEqual(['rating']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops bad games and drills, keeping the rest', () => {
    const { data, dropped } = sanitizeBackup({
      rating: '{}',
      'game:ok': game(),
      'game:badjson': '{',
      'game:notobject': '[]',
      'game:nopgn': game({ pgn: 1 }),
      'game:illegal': game({ pgn: '1.e9' }),
      'game:color': game({ playerColor: 'x' }),
      'drill:ok': drill(),
      'drill:badfen': drill({ fen: 'x' }),
      'drill:engine': drill({ fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 99999 1' }),
      'drill:uci': drill({ bestUci: 'position startpos' }),
      'plan:notadate': '{}',
      'game:nonstring': 5,
    });
    expect(Object.keys(data).sort()).toEqual(['drill:ok', 'game:ok', 'rating']);
    expect(dropped).toBe(10);
  });

  it('drops a damaged review but keeps its game, so it can be analysed again', () => {
    const { data } = sanitizeBackup({ 'game:g': game({ ingested: true, review: { moves: [{ fenBefore: 'junk', fenAfter: 'junk' }], sides: {} } }) });
    const restored = JSON.parse(data['game:g']) as Record<string, unknown>;
    expect(restored.pgn).toBe('1.e4 e5');
    expect(restored.review).toBeUndefined();
    expect(restored.ingested).toBeUndefined();
  });
});

describe('game import', () => {
  it('fetches only Chess.com archive addresses, whatever a response claims', async () => {
    const requested: string[] = [];
    const fetcher = async (url: string) => {
      requested.push(url);
      if (url.endsWith('/archives')) {
        return new Response(JSON.stringify({
          archives: [
            'https://api.chess.com/pub/player/someone/games/2026/10',
            'https://evil.example/pub/player/someone/games/2026/10',
            'http://api.chess.com/pub/player/someone/games/2026/09',
            'https://api.chess.com.evil.example/pub/player/someone/games/2026/08',
            'https://api.chess.com/pub/player/someone/games/2026/07?x=../../secret',
          ],
        }));
      }
      return new Response(JSON.stringify({ games: [] }));
    };
    await fetchChessCom('someone', 5, fetcher);
    expect(requested.filter((url) => !url.endsWith('/archives'))).toEqual(['https://api.chess.com/pub/player/someone/games/2026/10']);
  });

  it('sends no cookies or referrer, and encodes usernames', async () => {
    let init: RequestInit | undefined;
    let url = '';
    await importGames('lichess', 'a_b-c', 1, new Set(), async (u, i) => {
      url = u;
      init = i;
      return new Response('');
    });
    expect(init?.credentials).toBe('omit');
    expect(init?.referrerPolicy).toBe('no-referrer');
    expect(url.startsWith('https://lichess.org/api/games/user/a_b-c?')).toBe(true);
  });

  it('refuses usernames that could change the request', async () => {
    const never = async () => {
      throw new Error('should not be called');
    };
    for (const name of ['../../etc', 'a/b', 'a?b=c', 'a#b', 'a b', '%2e%2e', '<x>', 'a'.repeat(60), '']) {
      await expect(importGames('lichess', name, 1, new Set(), never), name).rejects.toThrow(ImportError);
    }
  });

  it('reports a malformed response as an error instead of crashing', async () => {
    await expect(importGames('lichess', 'someone', 1, new Set(), async () => new Response('{not json'))).rejects.toThrow(ImportError);
    await expect(importGames('chesscom', 'someone', 1, new Set(), async () => new Response('[]'))).rejects.toThrow(ImportError);
  });

  it('makes safe ids and survives bad dates', () => {
    const pgn = '[White "a"]\n[Black "b"]\n\n1.e4 *';
    const saved = toSavedGame({ site: 'chesscom', externalId: 'https://x/y/"><img src=x>', pgn, playedAt: NaN }, 'a')!;
    expect(saved.id).toMatch(/^chesscom-[\w-]*$/);
    expect(new Date(saved.date).getFullYear()).toBe(1970);
  });

  it('keeps quotes in names from breaking the saved PGN', () => {
    const pgn = '[White "a"]\n[Black "b"]\n[Event "x"]\n\n1.e4 *';
    const saved = toSavedGame({ site: 'lichess', externalId: 'q', pgn, playedAt: 1 }, 'a')!;
    expect(parseGame(saved.pgn).headers.Event).toBe('x');
  });
});

describe('security headers', () => {
  it('locks the page down', () => {
    expect(CSP_HEADER).toContain("default-src 'none'");
    expect(CSP_HEADER).toContain("frame-ancestors 'none'");
    expect(CSP_HEADER).toContain("object-src 'none'");
    expect(CSP_HEADER).toContain("base-uri 'none'");
    expect(CSP_HEADER).not.toContain("'unsafe-inline'");
    expect(CSP_HEADER).not.toContain("'unsafe-eval'");
    expect(CSP_HEADER).not.toMatch(/\*/);
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toContain('max-age=');
  });

  it('allows only the two outside services the app uses', () => {
    const connect = /connect-src ([^;]+)/.exec(CSP_META)![1].split(' ');
    expect(connect).toEqual(["'self'", 'https://lichess.org', 'https://api.chess.com']);
  });

  it('leaves frame-ancestors out of the meta tag, where browsers ignore it', () => {
    expect(CSP_META).not.toContain('frame-ancestors');
  });

  it('keeps vercel.json and the _headers file in step', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
    const all = Object.fromEntries(vercel.headers[0].headers.map((header) => [header.key, header.value]));
    expect(all).toEqual(SECURITY_HEADERS);
    const file = headersFile();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(file).toContain(`${name}: ${value}`);
    expect(file).toMatch(/\/sw\.js\n\s+Cache-Control: no-cache/);
    expect(file).toMatch(/\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
  });
});

describe('source code stays free of dangerous patterns', () => {
  const files = walk('src').filter((file) => /\.(ts|tsx)$/.test(file));
  const FORBIDDEN: [string, RegExp][] = [
    ['raw HTML in React', /dangerouslySetInnerHTML/],
    ['raw HTML in the DOM', /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/],
    ['code from strings', /\beval\(|new Function\(/],
    ['a hard-coded API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
    ['plain HTTP', /['"`]http:\/\//],
  ];
  for (const [what, pattern] of FORBIDDEN) {
    it(`has no ${what}`, () => {
      expect(files.filter((file) => pattern.test(readFileSync(file, 'utf8')))).toEqual([]);
    });
  }

  it('opens external links without giving them access to the app', () => {
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/<a [^>]*target="_blank"[^>]*>/g)) {
        expect(match[0], file).toContain('rel="noreferrer"');
      }
    }
  });

  it('has no connection to an AI service left in it', () => {
    expect(files.filter((file) => /anthropic|apiKey/i.test(readFileSync(file, 'utf8')))).toEqual([]);
    expect(CSP_HEADER).not.toContain('anthropic');
  });
});

describe('real games still flow through the stricter parser', () => {
  it('accepts every game in the course', async () => {
    const { COURSE } = await import('../src/course/content');
    for (const level of COURSE) {
      for (const lesson of level.lessons) {
        for (const step of lesson.steps) {
          if (step.kind === 'game') {
            const chess = new Chess();
            for (const san of step.moves.split(' ')) chess.move(san);
            expect(parseGame(step.moves).moves).toHaveLength(chess.history().length);
          }
        }
      }
    }
  });
});
