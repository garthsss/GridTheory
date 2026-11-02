import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { decideAccess, passwordProblem, OFFLINE_DAYS, type AccessFacts } from '../src/backend/access';
import { mergeRecord } from '../src/backend/merge';
import { SyncEngine, SyncedAdapter, type RemoteRecords, type RemoteRow } from '../src/backend/sync';
import { MemoryAdapter, Store } from '../src/lib/store';
import { CSP_HEADER, cspMeta } from '../security-headers';
import { corsHeaders, redeem, type RedeemDeps } from '../supabase/functions/redeem-invite/logic';

describe('what screen a person sees', () => {
  const NOW = 1_800_000_000_000;
  const session = { userId: 'u1', email: 'a@b.c' };
  const fresh = { userId: 'u1', email: 'a@b.c', checkedAt: NOW - 86_400_000 };
  const member = { member: true, admin: false, twoFactor: false };
  const facts = (patch: Partial<AccessFacts>): AccessFacts => ({ enabled: true, linkType: null, session: null, server: null, cached: null, online: true, now: NOW, ...patch });

  it('stays local-only with no backend configured', () => {
    expect(decideAccess(facts({ enabled: false })).state).toBe('local');
  });

  it('shows the gate when signed out, even with a remembered account, when online', () => {
    expect(decideAccess(facts({})).state).toBe('signedOut');
    expect(decideAccess(facts({ cached: fresh })).state).toBe('signedOut');
  });

  it('lets a confirmed member in', () => {
    expect(decideAccess(facts({ session, server: member }))).toMatchObject({ state: 'ready', admin: false, offline: false });
  });

  it('turns away someone signed in without a membership', () => {
    expect(decideAccess(facts({ session, server: { member: false, admin: false, twoFactor: false } })).state).toBe('removed');
    expect(decideAccess(facts({ session, server: { member: false, admin: false, twoFactor: false }, cached: fresh })).state).toBe('removed');
  });

  it('keeps the offline app for a recently confirmed member, with no admin rights', () => {
    expect(decideAccess(facts({ session, cached: fresh }))).toMatchObject({ state: 'ready', offline: true, admin: false, twoFactor: false });
    expect(decideAccess(facts({ online: false, cached: fresh }))).toMatchObject({ state: 'ready', offline: true, admin: false });
  });

  it("doesn't trust a stale or different remembered account", () => {
    const stale = { ...fresh, checkedAt: NOW - (OFFLINE_DAYS + 1) * 86_400_000 };
    expect(decideAccess(facts({ session, cached: stale })).state).toBe('offline');
    expect(decideAccess(facts({ online: false, cached: stale })).state).toBe('signedOut');
    expect(decideAccess(facts({ session, cached: { ...fresh, userId: 'someone-else' } })).state).toBe('offline');
  });

  it('asks for a password after an invite or reset link, only with a real session', () => {
    expect(decideAccess(facts({ session, server: member, linkType: 'invite' })).state).toBe('setPassword');
    expect(decideAccess(facts({ session, server: member, linkType: 'recovery' })).state).toBe('setPassword');
    expect(decideAccess(facts({ linkType: 'invite' })).state).toBe('signedOut');
  });

  it('checks passwords', () => {
    expect(passwordProblem('short', 'short')).toContain('10');
    expect(passwordProblem('long enough password', 'different password')).toContain('match');
    expect(passwordProblem('long enough password', 'long enough password')).toBeNull();
  });
});

describe('using an access code', () => {
  const CODE = 'GT-ABCD-EFGH-JKLM-NPQR';
  let log: string[];
  let deps: RedeemDeps;

  beforeEach(() => {
    log = [];
    deps = {
      allowAttempt: async () => true,
      claim: async (code, email) => {
        log.push(`claim ${code} ${email}`);
        return 'invite-1';
      },
      release: async (invite) => void log.push(`release ${invite}`),
      createAccount: async (email) => {
        log.push(`create ${email}`);
        return 'user-1';
      },
      removeAccount: async (user) => void log.push(`remove ${user}`),
      complete: async (invite, user) => void log.push(`complete ${invite} ${user}`),
    };
  });

  it('claims first, then creates the account, then makes them a member', async () => {
    expect(await redeem({ code: CODE.toLowerCase(), email: ' Friend@Example.com ' }, 'ip', deps)).toEqual({ status: 200, body: { ok: true } });
    expect(log).toEqual(['claim GTABCDEFGHJKLMNPQR friend@example.com', 'create friend@example.com', 'complete invite-1 user-1']);
  });

  it('never creates an account from a bad code, and gives the same answer for every failure', async () => {
    const bad = await redeem({ code: CODE, email: 'a@b.co' }, 'ip', { ...deps, claim: async () => null });
    expect(log).toEqual([]);
    for (const input of [null, 'x', {}, { code: CODE }, { email: 'a@b.co' }, { code: 1, email: 2 }, { code: 'short', email: 'a@b.co' }, { code: CODE, email: 'nope' }, { code: 'x'.repeat(100), email: 'a@b.co' }, { code: CODE, email: `${'a'.repeat(300)}@b.co` }]) {
      expect(await redeem(input, 'ip', deps), JSON.stringify(input)).toEqual(bad);
    }
    expect(log).toEqual([]);
  });

  it('gives back the code, with the same answer, if the email already has an account', async () => {
    const result = await redeem({ code: CODE, email: 'a@b.co' }, 'ip', { ...deps, createAccount: async () => null });
    expect(result.status).toBe(400);
    expect(log).toContain('release invite-1');
  });

  it('undoes everything if the membership fails, leaving no account without one', async () => {
    const result = await redeem({ code: CODE, email: 'a@b.co' }, 'ip', { ...deps, complete: async () => { throw new Error('db down'); } });
    expect(result.status).toBe(500);
    expect(log).toContain('remove user-1');
    expect(log).toContain('release invite-1');
  });

  it('checks the rate limit before anything else', async () => {
    expect(await redeem({ code: CODE, email: 'a@b.co' }, 'ip', { ...deps, allowAttempt: async () => false })).toEqual({ status: 429, body: { ok: false, error: 'rate_limited' } });
    expect(log).toEqual([]);
  });

  it('only allows the site itself to call it from a browser', () => {
    expect(corsHeaders('https://grid.example', 'https://grid.example/')['Access-Control-Allow-Origin']).toBe('https://grid.example');
    expect(corsHeaders('https://evil.example', 'https://grid.example')['Access-Control-Allow-Origin']).toBeUndefined();
    expect(corsHeaders(null, 'https://grid.example')['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('merging changes from two devices', () => {
  const merge = (key: string, a: unknown, b: unknown) => JSON.parse(mergeRecord(key, JSON.stringify(a), JSON.stringify(b)));

  it('combines progress and keeps every lesson done on either device', () => {
    expect(merge('progress', { a: true }, { b: true })).toEqual({ a: true, b: true });
  });

  it('combines histories in order, without repeats', () => {
    expect(merge('ratingHistory', [{ t: 1, value: 1 }, { t: 3, value: 3 }], [{ t: 2, value: 2 }, { t: 3, value: 3 }]).map((p: { t: number }) => p.t)).toEqual([1, 2, 3]);
    expect(merge('events', [{ t: 2, skill: 'a' }], [{ t: 1, skill: 'b' }, { t: 2, skill: 'a' }])).toEqual([{ t: 1, skill: 'b' }, { t: 2, skill: 'a' }]);
    expect(merge('puzzleSeen', ['a', 'b'], ['b', 'c']).sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps the furthest counter', () => {
    expect(merge('rating', { value: 900, games: 3 }, { value: 1000, games: 8 }).value).toBe(1000);
    expect(merge('puzzleRating', { value: 900, games: 9 }, { value: 1000, games: 8 }).value).toBe(900);
    expect(merge('rushBest', 5, 9)).toBe(9);
    expect(merge('plan:2026-11-02', { puzzles: 3, drills: 1 }, { puzzles: 1, lesson: 1 })).toEqual({ puzzles: 3, drills: 1, lesson: 1 });
    expect(merge('training', { opening: { attempts: 5 } }, { opening: { attempts: 9 }, endgame: { attempts: 1 } })).toEqual({ opening: { attempts: 9 }, endgame: { attempts: 1 } });
  });

  it('keeps the copy of a game with its review, and the most practised drill', () => {
    expect(merge('game:1', { id: 1 }, { id: 1, review: {} })).toEqual({ id: 1, review: {} });
    expect(merge('game:1', { id: 1, review: {}, ingested: true }, { id: 1, review: {} }).ingested).toBe(true);
    expect(merge('drill:1', { dueAt: 5 }, { dueAt: 9 }).dueAt).toBe(9);
  });

  it('keeps the oldest profile id, and this device\'s choice for preferences', () => {
    expect(merge('profile', { id: 'new', createdAt: '2026-02' }, { id: 'old', createdAt: '2026-01' }).id).toBe('old');
    expect(merge('prefs', { theme: 'dark' }, { theme: 'light' }).theme).toBe('dark');
  });

  it('never lets a damaged copy replace a good one', () => {
    expect(mergeRecord('progress', '{broken', '{"a":true}')).toBe('{"a":true}');
    expect(mergeRecord('progress', '{"a":true}', '{broken')).toBe('{"a":true}');
  });
});

describe('sync', () => {
  class FakeServer implements RemoteRecords {
    rows = new Map<string, RemoteRow>();
    clock = 1000;
    failUpload: unknown = null;
    uploads = 0;
    async changesSince(since: string | null, offset: number, limit: number) {
      return [...this.rows.values()].filter((row) => !since || row.updated_at > since).sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(offset, offset + limit);
    }
    async upload(rows: { key: string; value: string; deleted: boolean }[]) {
      if (this.failUpload) throw this.failUpload;
      this.uploads++;
      for (const row of rows) this.rows.set(row.key, { ...row, updated_at: new Date(1_800_000_000_000 + this.clock++ * 60_000).toISOString() });
    }
  }

  async function device(server: FakeServer, seed: Record<string, string> = {}) {
    const local = new MemoryAdapter();
    local.data = { ...seed };
    const adapter = new SyncedAdapter(local);
    const store = new Store();
    await store.hydrate(adapter);
    return { store, adapter, local, engine: new SyncEngine(adapter, server, store) };
  }

  it('uploads a change, and never the app data version', async () => {
    const server = new FakeServer();
    const a = await device(server);
    a.store.set('rating', { value: 900, games: 1 });
    await Promise.resolve();
    await a.engine.sync();
    expect(server.rows.get('rating')?.value).toBe('{"value":900,"games":1}');
    expect(server.rows.has('schema')).toBe(false);
    expect(a.adapter.dirty.size).toBe(0);
  });

  it('brings progress to a second device', async () => {
    const server = new FakeServer();
    const a = await device(server);
    a.store.set('game:1', { id: '1' });
    await Promise.resolve();
    await a.engine.sync();
    const b = await device(server);
    await b.engine.sync();
    expect(b.store.get('game:1', null)).toEqual({ id: '1' });
    expect(b.adapter.dirty.has('game:1')).toBe(false);
    expect(b.local.data['game:1']).toBe('{"id":"1"}');
  });

  it('merges the same record changed on two devices, and shares the result', async () => {
    const server = new FakeServer();
    const a = await device(server);
    const b = await device(server);
    a.store.set('progress', { forks: true });
    b.store.set('progress', { pins: true });
    await Promise.resolve();
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    expect(a.store.get('progress', {})).toEqual({ forks: true, pins: true });
    expect(b.store.get('progress', {})).toEqual({ forks: true, pins: true });
  });

  it('carries a deletion to other devices', async () => {
    const server = new FakeServer();
    const a = await device(server);
    a.store.set('game:1', { id: '1' });
    await Promise.resolve();
    await a.engine.sync();
    const b = await device(server);
    await b.engine.sync();
    a.store.remove('game:1');
    await Promise.resolve();
    await a.engine.sync();
    await b.engine.sync();
    expect(b.store.get('game:1', null)).toBeNull();
    expect(b.local.data['game:1']).toBeUndefined();
  });

  it('keeps changes through being offline and a reload, then uploads them', async () => {
    const server = new FakeServer();
    server.failUpload = new TypeError('Failed to fetch');
    const a = await device(server);
    a.store.set('rushBest', 7);
    await Promise.resolve();
    await a.engine.sync();
    expect(a.engine.status).toBe('offline');

    const reloaded = await device(server, a.local.data);
    expect(reloaded.adapter.dirty.has('rushBest')).toBe(true);
    expect(reloaded.store.exportAll()['__sync.dirty.rushBest']).toBeUndefined();
    server.failUpload = null;
    await reloaded.engine.sync();
    expect(server.rows.get('rushBest')?.value).toBe('7');
    expect(reloaded.adapter.dirty.size).toBe(0);
  });

  it('keeps sync details out of backups', async () => {
    const server = new FakeServer();
    const a = await device(server);
    a.store.set('rating', { value: 1, games: 1 });
    await Promise.resolve();
    await a.engine.sync();
    const b = await device(server, a.local.data);
    expect(Object.keys(b.store.exportAll()).filter((key) => key.startsWith('__sync'))).toEqual([]);
  });

  it('reports being refused, or a full account, without losing the change', async () => {
    const server = new FakeServer();
    const a = await device(server);
    a.store.set('rushBest', 7);
    await Promise.resolve();
    server.failUpload = { code: '42501' };
    await a.engine.sync();
    expect(a.engine.status).toBe('denied');
    server.failUpload = { code: '54000' };
    await a.engine.sync();
    expect(a.engine.status).toBe('full');
    expect(a.adapter.dirty.has('rushBest')).toBe(true);
  });

  it('splits large uploads', async () => {
    const server = new FakeServer();
    const a = await device(server);
    for (let i = 0; i < 450; i++) a.store.set(`game:${i}`, { id: i });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await a.engine.sync();
    expect(server.rows.size).toBe(450);
    expect(server.uploads).toBe(3);
  });

  it('reads every page of changes', async () => {
    const server = new FakeServer();
    for (let i = 0; i < 1200; i++) server.rows.set(`drill:${i}`, { key: `drill:${i}`, value: '{}', deleted: false, updated_at: new Date(1_800_000_000_000 + i * 60_000).toISOString() });
    const a = await device(server);
    await a.engine.sync();
    expect(a.store.keys('drill:')).toHaveLength(1200);
  });
});

describe('secrets and policy for the backend', () => {
  it('narrows the network policy to exactly one project', () => {
    expect(cspMeta('https://abc.supabase.co/')).toContain("connect-src 'self' https://lichess.org https://api.chess.com https://abc.supabase.co;");
    expect(cspMeta('https://abc.supabase.co')).not.toContain('*');
    expect(cspMeta()).not.toContain('supabase');
    expect(CSP_HEADER).toContain('https://*.supabase.co');
  });

  it('never uses the service role key in the browser app', () => {
    const client = readFileSync('src/backend/client.ts', 'utf8');
    expect(client).not.toMatch(/createClient\([^)]*SERVICE/i);
    expect(readFileSync('src/backend/account.ts', 'utf8')).not.toMatch(/service_role|auth\.admin/i);
    expect(readFileSync('src/pages/AdminPage.tsx', 'utf8')).not.toMatch(/service_role|auth\.admin/i);
  });
});
