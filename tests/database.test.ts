import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Attacks the real SQL on a real Postgres. The setup copies what matters about Supabase: the same client roles, the
 * same default grants on new tables and functions, a non-superuser owner, and login details read from the same setting.
 */
const SETUP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_owner nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role, supabase_owner;
  grant all on auth.users to supabase_owner;
  grant usage, create on schema public to supabase_owner;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges for role supabase_owner in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges for role supabase_owner in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges for role supabase_owner in schema public grant all on sequences to anon, authenticated, service_role;
`;

let db: PGlite;

type Who = { role: 'anon' | 'authenticated' | 'service_role'; claims?: Record<string, unknown> };
const anon: Who = { role: 'anon' };
const service: Who = { role: 'service_role', claims: { role: 'service_role' } };
const user = (id: string, claims: Record<string, unknown> = {}): Who => ({ role: 'authenticated', claims: { sub: id, role: 'authenticated', aal: 'aal1', ...claims } });

async function as<T = Record<string, unknown>>(who: Who, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(who.claims ?? {})]);
  await db.exec(`set role ${who.role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

const owner = async (sql: string, params: unknown[] = []) => {
  await db.exec('set role supabase_owner');
  try {
    return (await db.query<Record<string, unknown>>(sql, params)).rows;
  } finally {
    await db.exec('reset role');
  }
};

async function addUser(email: string): Promise<string> {
  return (await db.query<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email])).rows[0].id;
}

const refused = (attempt: Promise<unknown>) => expect(attempt).rejects.toThrow();

let adminId: string;
let memberId: string;
let otherId: string;
let outsiderId: string;
let adminWho: Who;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SETUP);
  const folder = 'supabase/migrations';
  await db.exec('set role supabase_owner');
  for (const file of readdirSync(folder).sort()) await db.exec(readFileSync(join(folder, file), 'utf8'));
  await db.exec('reset role');
}, 60_000);

beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate public.invite_codes, public.audit_log, public.redeem_attempts cascade;');
  adminId = await addUser('owner@example.com');
  memberId = await addUser('member@example.com');
  otherId = await addUser('other@example.com');
  outsiderId = await addUser('outsider@example.com');
  await owner('select public.grant_admin($1)', ['owner@example.com']);
  await owner('insert into public.members (user_id) values ($1), ($2)', [memberId, otherId]);
  adminWho = user(adminId, { aal: 'aal2' });
});

const CALLS: [string, string, unknown[]][] = [
  ['admin_create_invite', 'select public.admin_create_invite($1, $2, $3)', ['x', null, 7]],
  ['admin_list_invites', 'select public.admin_list_invites()', []],
  ['admin_revoke_invite', 'select public.admin_revoke_invite($1)', ['00000000-0000-0000-0000-000000000000']],
  ['admin_list_members', 'select public.admin_list_members()', []],
  ['admin_set_member_status', 'select public.admin_set_member_status($1, $2)', ['00000000-0000-0000-0000-000000000000', 'active']],
  ['admin_list_audit', 'select public.admin_list_audit($1)', [10]],
];

describe('admin actions refuse everyone but a real admin', () => {
  it('covers every admin function in the database', async () => {
    const names = (await db.query<{ proname: string }>(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'admin\\_%'`)).rows.map((row) => row.proname);
    expect(names.sort()).toEqual(CALLS.map(([name]) => name).sort());
  });

  const forgeries: [string, () => Who][] = [
    ['an anonymous visitor', () => anon],
    ['a signed-in person with no membership', () => user(outsiderId)],
    ['a normal member', () => user(memberId)],
    ['a normal member with two-factor login', () => user(memberId, { aal: 'aal2' })],
    ['a member claiming admin in user_metadata', () => user(memberId, { aal: 'aal2', user_metadata: { admin: true, role: 'admin', is_admin: true } })],
    ['a member claiming admin in app_metadata', () => user(memberId, { aal: 'aal2', app_metadata: { admin: true, role: 'admin', is_admin: true } })],
    ['a member claiming an admin role', () => user(memberId, { aal: 'aal2', role: 'admin', is_admin: true, admin: true })],
    ['a real admin without two-factor login', () => user(adminId, { aal: 'aal1' })],
    ['a real admin with no login level at all', () => user(adminId, { aal: undefined })],
    ['someone with no user id', () => ({ role: 'authenticated', claims: { aal: 'aal2' } })],
  ];
  for (const [who, make] of forgeries) {
    for (const [name, sql, params] of CALLS) {
      it(`${who} can't use ${name}`, async () => {
        await refused(as(make(), sql, params));
      });
    }
  }

  it('lets a real admin with two-factor login use them', async () => {
    for (const [name, sql, params] of CALLS) {
      if (name === 'admin_revoke_invite' || name === 'admin_set_member_status') continue;
      await expect(as(adminWho, sql, params), name).resolves.toBeDefined();
    }
  });

  it('stops working the moment an admin is removed from the table', async () => {
    await as(adminWho, 'select public.admin_list_members()');
    await owner('delete from public.admins where user_id = $1', [adminId]);
    await refused(as(adminWho, 'select public.admin_list_members()'));
  });

  it('stops working for an admin whose membership is removed', async () => {
    await owner(`update public.members set status = 'removed' where user_id = $1`, [adminId]);
    await refused(as(adminWho, 'select public.admin_list_members()'));
  });
});

describe('nobody can make themselves an admin', () => {
  it('blocks writing to the admins table directly, for every client role', async () => {
    for (const who of [anon, user(memberId), user(memberId, { aal: 'aal2' }), user(outsiderId), adminWho]) {
      await refused(as(who, 'insert into public.admins (user_id) values ($1)', [memberId]));
      await refused(as(who, 'select * from public.admins'));
      await refused(as(who, 'update public.admins set user_id = $1', [memberId]));
      await refused(as(who, 'delete from public.admins'));
    }
  });

  it('blocks grant_admin from every client role, including an admin', async () => {
    for (const who of [anon, user(memberId), user(outsiderId), adminWho]) {
      await refused(as(who, 'select public.grant_admin($1)', ['member@example.com']));
    }
  });

  it('leaves the member with no admin rights after all of that', async () => {
    const [access] = await as<{ my_access: { admin: boolean } }>(user(memberId, { aal: 'aal2' }), 'select public.my_access()');
    expect(access.my_access.admin).toBe(false);
  });

  it("doesn't let an admin remove another admin from the app", async () => {
    const second = await addUser('second@example.com');
    await owner('select public.grant_admin($1)', ['second@example.com']);
    await refused(as(adminWho, `select public.admin_set_member_status($1, 'removed')`, [second]));
  });
});

describe('private tables are out of reach', () => {
  const TABLES = ['invite_codes', 'members', 'admins', 'audit_log', 'redeem_attempts'];

  it('has row-level security on every table', async () => {
    const open = (await db.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).rows;
    expect(open).toEqual([]);
  });

  for (const table of TABLES) {
    it(`blocks clients from ${table}`, async () => {
      for (const who of [anon, user(memberId), user(outsiderId), adminWho]) {
        await refused(as(who, `select * from public.${table}`));
        await refused(as(who, `delete from public.${table}`));
      }
    });
  }

  it('offers clients exactly the functions they should have', async () => {
    const allowed = async (role: string) =>
      (await db.query<{ name: string }>(`select proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege($1, p.oid, 'execute') order by 1`, [role])).rows.map((row) => row.name);
    expect(await allowed('anon')).toEqual([]);
    expect(await allowed('authenticated')).toEqual([
      'admin_create_invite', 'admin_list_audit', 'admin_list_invites', 'admin_list_members', 'admin_revoke_invite', 'admin_set_member_status',
      'delete_my_account', 'is_admin', 'is_member', 'my_access',
    ]);
  });

  it('keeps the code functions away from clients, so a code can only be used through the server function', async () => {
    for (const who of [anon, user(memberId), user(outsiderId), adminWho]) {
      await refused(as(who, 'select public.claim_invite($1, $2)', ['x', 'a@b.c']));
      await refused(as(who, 'select public.complete_invite($1, $2)', ['00000000-0000-0000-0000-000000000000', outsiderId]));
      await refused(as(who, 'select public.release_invite($1)', ['00000000-0000-0000-0000-000000000000']));
      await refused(as(who, 'select public.allow_redeem_attempt($1)', ['x']));
    }
  });
});

describe('access codes', () => {
  async function create(label = 'x', email: string | null = null, days = 7): Promise<{ id: string; code: string; expiresAt: string }> {
    const [row] = await as<{ admin_create_invite: { id: string; code: string; expiresAt: string } }>(adminWho, 'select public.admin_create_invite($1, $2, $3)', [label, email, days]);
    return row.admin_create_invite;
  }
  const claim = async (code: string, email = 'new@example.com') =>
    (await as<{ claim_invite: string | null }>(service, 'select public.claim_invite($1, $2)', [code, email]))[0].claim_invite;

  it('makes long, random codes and stores only a hash', async () => {
    const codes = await Promise.all(Array.from({ length: 30 }, () => create()));
    for (const { code } of codes) expect(code).toMatch(/^GT-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(new Set(codes.map(({ code }) => code)).size).toBe(30);
    const stored = JSON.stringify(await owner('select * from public.invite_codes'));
    for (const { code } of codes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(code.replaceAll('-', ''));
    }
  });

  it('keeps the code out of the audit log and the admin list', async () => {
    const { code } = await create();
    expect(JSON.stringify(await owner('select * from public.audit_log'))).not.toContain(code);
    expect(JSON.stringify(await as(adminWho, 'select public.admin_list_invites()'))).not.toContain(code);
  });

  it('works once, and only once', async () => {
    const { code, id } = await create();
    expect(await claim(code)).toBe(id);
    expect(await claim(code)).toBeNull();
    expect(await claim(code, 'someone-else@example.com')).toBeNull();
  });

  it('lets exactly one of many simultaneous attempts win', async () => {
    const { code, id } = await create();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => db.query<{ claim_invite: string | null }>('select public.claim_invite($1, $2)', [code, `p${i}@example.com`])));
    expect(results.map((result) => result.rows[0].claim_invite).filter((value) => value === id)).toHaveLength(1);
  });

  it('forgives capitals and missing dashes when typed', async () => {
    const { code, id } = await create();
    expect(await claim(` ${code.toLowerCase().replaceAll('-', ' ')} `)).toBe(id);
  });

  it('rejects wrong, revoked and expired codes', async () => {
    expect(await claim('GT-AAAA-AAAA-AAAA-AAAA')).toBeNull();
    expect(await claim('')).toBeNull();
    const revoked = await create();
    await as(adminWho, 'select public.admin_revoke_invite($1)', [revoked.id]);
    expect(await claim(revoked.code)).toBeNull();
    const expired = await create();
    await owner(`update public.invite_codes set expires_at = now() - interval '1 second' where id = $1`, [expired.id]);
    expect(await claim(expired.code)).toBeNull();
  });

  it("keeps an email-locked code to that person", async () => {
    const { code, id } = await create('x', 'Friend@Example.com');
    expect(await claim(code, 'stranger@example.com')).toBeNull();
    expect(await claim(code, 'FRIEND@example.com')).toBe(id);
  });

  it('can be released if account creation fails, but not once an account exists', async () => {
    const { code, id } = await create();
    await claim(code);
    await as(service, 'select public.release_invite($1)', [id]);
    expect(await claim(code)).toBe(id);
    await as(service, 'select public.complete_invite($1, $2)', [id, outsiderId]);
    await as(service, 'select public.release_invite($1)', [id]);
    expect(await claim(code)).toBeNull();
  });

  it('makes a member only from a claimed code', async () => {
    const { code, id } = await create();
    await refused(as(service, 'select public.complete_invite($1, $2)', [id, outsiderId]));
    await claim(code);
    await as(service, 'select public.complete_invite($1, $2)', [id, outsiderId]);
    const [access] = await as<{ my_access: { member: boolean } }>(user(outsiderId), 'select public.my_access()');
    expect(access.my_access.member).toBe(true);
    await refused(as(service, 'select public.complete_invite($1, $2)', [id, memberId]));
  });

  it("can't be revoked once used", async () => {
    const { code, id } = await create();
    await claim(code);
    await refused(as(adminWho, 'select public.admin_revoke_invite($1)', [id]));
  });

  it('rejects silly settings', async () => {
    await refused(create('x', null, 0));
    await refused(create('x', null, 366));
    await refused(create('x', 'not-an-email', 7));
  });

  it('limits guesses from one address, and overall', async () => {
    const attempt = async (ip: string) => (await as<{ allow_redeem_attempt: boolean }>(service, 'select public.allow_redeem_attempt($1)', [ip]))[0].allow_redeem_attempt;
    for (let i = 0; i < 10; i++) expect(await attempt('a')).toBe(true);
    expect(await attempt('a')).toBe(false);
    expect(await attempt('b')).toBe(true);
    await owner(`insert into public.redeem_attempts (ip_hash) select 'flood' from generate_series(1, 300)`);
    expect(await attempt('c')).toBe(false);
  });
});

describe('synced records', () => {
  const put = (who: Who, owner_id: string, key = 'game:1', value = '{}') =>
    as(who, 'insert into public.user_records (user_id, key, value) values ($1, $2, $3) returning *', [owner_id, key, value]);

  it('lets a member keep their own records', async () => {
    await put(user(memberId), memberId);
    await expect(as(user(memberId), 'select key from public.user_records')).resolves.toEqual([{ key: 'game:1' }]);
  });

  it('never shows or changes another member\'s records', async () => {
    await put(user(otherId), otherId, 'game:secret', '"private"');
    await expect(as(user(memberId), 'select * from public.user_records')).resolves.toEqual([]);
    await refused(put(user(memberId), otherId));
    await expect(as(user(memberId), `update public.user_records set value = 'hacked' returning key`)).resolves.toEqual([]);
    await expect(as(user(memberId), 'delete from public.user_records returning key')).resolves.toEqual([]);
    expect(await owner('select value from public.user_records where user_id = $1', [otherId])).toEqual([{ value: '"private"' }]);
  });

  it("doesn't let a record be handed to someone else", async () => {
    await put(user(memberId), memberId);
    await as(user(memberId), 'update public.user_records set user_id = $1', [otherId]);
    expect(await owner('select user_id from public.user_records')).toEqual([{ user_id: memberId }]);
  });

  it('blocks people without an active membership', async () => {
    await refused(put(anon, memberId));
    await refused(put(user(outsiderId), outsiderId));
    await put(user(memberId), memberId);
    await as(adminWho, `select public.admin_set_member_status($1, 'removed')`, [memberId]);
    await expect(as(user(memberId), 'select * from public.user_records')).resolves.toEqual([]);
    await refused(put(user(memberId), memberId, 'game:2'));
    await as(adminWho, `select public.admin_set_member_status($1, 'active')`, [memberId]);
    await expect(as(user(memberId), 'select key from public.user_records')).resolves.toEqual([{ key: 'game:1' }]);
  });

  it('sets the time itself', async () => {
    const [row] = await as<{ updated_at: Date }>(user(memberId), `insert into public.user_records (user_id, key, value, updated_at) values ($1, 'a', '1', '2000-01-01') returning updated_at`, [memberId]);
    expect(new Date(row.updated_at).getFullYear()).toBeGreaterThan(2000);
  });

  it('rejects bad keys and oversized values', async () => {
    await refused(put(user(memberId), memberId, '../etc'));
    await refused(put(user(memberId), memberId, ''));
    await refused(put(user(memberId), memberId, 'a'.repeat(201)));
    await refused(put(user(memberId), memberId, 'big', 'x'.repeat(2_097_153)));
  });

  it('enforces a storage limit per account, and frees space on delete', async () => {
    const chunk = 'x'.repeat(2_000_000);
    for (let i = 0; i < 26; i++) await put(user(memberId), memberId, `k${i}`, chunk);
    await refused(put(user(memberId), memberId, 'k26', chunk));
    await as(user(memberId), `delete from public.user_records where key = 'k0'`);
    await put(user(memberId), memberId, 'k26', chunk);
    const [row] = await owner('select used_records from public.members where user_id = $1', [memberId]);
    expect(row.used_records).toBe(26);
  }, 60_000);
});

describe('deleting an account', () => {
  it('removes everything belonging to that person, and nobody else', async () => {
    await as(user(memberId), `insert into public.user_records (user_id, key, value) values ($1, 'a', '1')`, [memberId]);
    await as(user(otherId), `insert into public.user_records (user_id, key, value) values ($1, 'a', '1')`, [otherId]);
    await as(user(memberId), 'select public.delete_my_account()');
    expect(await db.query('select 1 from auth.users where id = $1', [memberId]).then((r) => r.rows)).toEqual([]);
    expect(await owner('select user_id from public.user_records')).toEqual([{ user_id: otherId }]);
    expect(await owner('select 1 from public.members where user_id = $1', [memberId])).toEqual([]);
    expect(JSON.stringify(await owner('select * from public.audit_log'))).not.toContain('member@example.com');
  });

  it('only ever deletes the caller', async () => {
    await refused(as(anon, 'select public.delete_my_account()'));
    await refused(as({ role: 'authenticated', claims: {} }, 'select public.delete_my_account()'));
    await as(user(memberId, { sub: memberId, target: otherId }), 'select public.delete_my_account()');
    expect((await db.query('select 1 from auth.users where id = $1', [otherId])).rows).toHaveLength(1);
  });

  it('refuses for admins, so the site always has an owner', async () => {
    await refused(as(adminWho, 'select public.delete_my_account()'));
  });

  it('keeps a used code marked as used after its owner leaves', async () => {
    const [row] = await as<{ admin_create_invite: { id: string; code: string } }>(adminWho, 'select public.admin_create_invite()');
    const { id, code } = row.admin_create_invite;
    await as(service, 'select public.claim_invite($1, $2)', [code, 'x@example.com']);
    await as(service, 'select public.complete_invite($1, $2)', [id, outsiderId]);
    await as(user(outsiderId), 'select public.delete_my_account()');
    const [again] = await as<{ claim_invite: string | null }>(service, 'select public.claim_invite($1, $2)', [code, 'y@example.com']);
    expect(again.claim_invite).toBeNull();
  });
});
