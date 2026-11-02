-- GridTheory's accounts, access codes, admin rights and synced data.
--
-- The browser is never trusted. Everything here is enforced by the database, whatever a client sends:
--   * A signed-in user with no active membership can read and write nothing.
--   * Admin rights live in public.admins, which no client role can touch. They are granted only by running
--     public.grant_admin in the Supabase SQL editor. Nothing a user can edit, such as user_metadata, is ever read.
--   * Every admin action re-checks the caller inside the database, and also requires two-factor login (aal2).
--   * Access codes are stored only as hashes, and each can be claimed once.

-- ---------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------

create table public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  label text not null default '' check (char_length(label) <= 100),
  locked_email text check (locked_email is null or locked_email = lower(locked_email)),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  claimed_at timestamptz,
  claimed_by uuid references auth.users (id) on delete set null
);

create table public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'removed')),
  invite_id uuid references public.invite_codes (id) on delete set null,
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  used_bytes bigint not null default 0,
  used_records integer not null default 0
);

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  granted_at timestamptz not null default now()
);

create table public.user_records (
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 200 and key ~ '^[A-Za-z][A-Za-z0-9_:.-]*$'),
  value text not null check (octet_length(value) <= 2097152),
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index user_records_changes on public.user_records (user_id, updated_at);

-- Actors are stored as ids, not emails, so deleting an account leaves no personal details in the log.
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  target text,
  detail jsonb not null default '{}'
);

create table public.redeem_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  at timestamptz not null default now()
);
create index redeem_attempts_recent on public.redeem_attempts (ip_hash, at);

-- Supabase grants new tables to its client roles by default, so that is undone first. Row-level security is then
-- on everywhere, and only user_records is ever opened up. The rest have no policies, so clients can't reach them at all.
revoke all on public.invite_codes, public.members, public.admins, public.user_records, public.audit_log, public.redeem_attempts
  from public, anon, authenticated;
alter table public.invite_codes enable row level security;
alter table public.members enable row level security;
alter table public.admins enable row level security;
alter table public.user_records enable row level security;
alter table public.audit_log enable row level security;
alter table public.redeem_attempts enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- Who is the caller?
-- ---------------------------------------------------------------------------------------------------------------

create function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where user_id = auth.uid() and status = 'active');
$$;

-- Requires two-factor login. Reads only the admins table and the verified login level, never anything user-editable.
create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.admins a
    join public.members m on m.user_id = a.user_id and m.status = 'active'
    where a.user_id = auth.uid()
  ) and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- What the app needs to draw itself, for the caller only. It unlocks nothing: the app's screens are for convenience,
-- and every action below checks again.
create function public.my_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'member', public.is_member(),
    'admin', exists (
      select 1 from public.admins a
      join public.members m on m.user_id = a.user_id and m.status = 'active'
      where a.user_id = auth.uid()
    ),
    'twoFactor', coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
  );
$$;

create function public.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Synced data
-- ---------------------------------------------------------------------------------------------------------------

create policy "members read their own records" on public.user_records for select to authenticated
  using (user_id = auth.uid() and public.is_member());
create policy "members add their own records" on public.user_records for insert to authenticated
  with check (user_id = auth.uid() and public.is_member());
create policy "members change their own records" on public.user_records for update to authenticated
  using (user_id = auth.uid() and public.is_member())
  with check (user_id = auth.uid() and public.is_member());
create policy "members delete their own records" on public.user_records for delete to authenticated
  using (user_id = auth.uid() and public.is_member());
grant select, insert, update, delete on public.user_records to authenticated;

-- The server sets the time, so a client can't fake it, and keeps a running total, so one account can't fill the database.
create function public.user_records_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  max_bytes constant bigint := 52428800;
  max_records constant integer := 20000;
  bytes_change bigint;
  records_change integer;
  next_bytes bigint;
  next_records integer;
begin
  if tg_op = 'INSERT' then
    new.updated_at := now();
    bytes_change := octet_length(new.value);
    records_change := 1;
  elsif tg_op = 'UPDATE' then
    new.updated_at := now();
    new.user_id := old.user_id;
    bytes_change := octet_length(new.value) - octet_length(old.value);
    records_change := 0;
  else
    bytes_change := -octet_length(old.value);
    records_change := -1;
  end if;

  update public.members
    set used_bytes = greatest(0, used_bytes + bytes_change), used_records = greatest(0, used_records + records_change)
    where user_id = coalesce(new.user_id, old.user_id)
    returning used_bytes, used_records into next_bytes, next_records;

  if tg_op <> 'DELETE' and (bytes_change > 0 or records_change > 0)
    and (next_bytes > max_bytes or next_records > max_records) then
    raise exception 'Storage limit reached' using errcode = '54000';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger user_records_guard before insert or update or delete on public.user_records
  for each row execute function public.user_records_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Access codes
-- ---------------------------------------------------------------------------------------------------------------

create function public.hash_invite_code(p_code text) returns text
language sql immutable set search_path = '' as $$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(upper(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g')), 'UTF8')), 'hex');
$$;

-- Limits guesses per address, and overall. Codes are 80 random bits, so this is a backstop rather than the protection.
create function public.allow_redeem_attempt(p_ip_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  from_address integer;
  from_anyone integer;
begin
  delete from public.redeem_attempts where at < now() - interval '1 day';
  select count(*) into from_address from public.redeem_attempts where ip_hash = p_ip_hash and at > now() - interval '1 hour';
  select count(*) into from_anyone from public.redeem_attempts where at > now() - interval '1 hour';
  if from_address >= 10 or from_anyone >= 300 then
    return false;
  end if;
  insert into public.redeem_attempts (ip_hash) values (p_ip_hash);
  return true;
end;
$$;

-- Atomic: of any number of simultaneous attempts, the update can succeed for only one.
create function public.claim_invite(p_code text, p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  claimed uuid;
begin
  update public.invite_codes
    set claimed_at = now()
    where code_hash = public.hash_invite_code(p_code)
      and claimed_at is null
      and revoked_at is null
      and expires_at > now()
      and (locked_email is null or locked_email = lower(p_email))
    returning id into claimed;
  insert into public.audit_log (action, target) values (case when claimed is null then 'invite.rejected' else 'invite.claimed' end, claimed::text);
  return claimed;
end;
$$;

-- For when the account could not be created, so that a real person's code isn't wasted.
create function public.release_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.invite_codes set claimed_at = null where id = p_invite and claimed_by is null;
  insert into public.audit_log (action, target) values ('invite.released', p_invite::text);
end;
$$;

create function public.complete_invite(p_invite uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.invite_codes set claimed_by = p_user where id = p_invite and claimed_at is not null and claimed_by is null;
  if not found then
    raise exception 'That access code was not claimed';
  end if;
  insert into public.members (user_id, invite_id) values (p_user, p_invite);
  insert into public.audit_log (actor, action, target) values (p_user, 'member.joined', p_invite::text);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Admin actions. Each one starts with require_admin(), which checks the caller in the database.
-- ---------------------------------------------------------------------------------------------------------------

-- Returns the code once. Only its hash is kept, so it can't be shown again, even to an admin.
create function public.admin_create_invite(p_label text default '', p_email text default null, p_days integer default 14) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  random_bytes bytea;
  letters text := '';
  code text;
  created uuid;
  expires timestamptz;
begin
  perform public.require_admin();
  if p_days is null or p_days < 1 or p_days > 365 then
    raise exception 'Expiry must be between 1 and 365 days';
  end if;
  if p_email is not null and p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That email address is not valid';
  end if;
  -- 16 letters from a 32-letter alphabet is 80 random bits. Bytes 6 and 8 of a UUID are partly fixed, so they're skipped.
  random_bytes := substr(uuid_send(gen_random_uuid()), 1, 6) || substr(uuid_send(gen_random_uuid()), 10, 7)
    || substr(uuid_send(gen_random_uuid()), 10, 3);
  for i in 0..15 loop
    letters := letters || substr(alphabet, (get_byte(random_bytes, i) % 32) + 1, 1);
  end loop;
  code := 'GT-' || substr(letters, 1, 4) || '-' || substr(letters, 5, 4) || '-' || substr(letters, 9, 4) || '-' || substr(letters, 13, 4);
  expires := now() + make_interval(days => p_days);
  insert into public.invite_codes (code_hash, label, locked_email, created_by, expires_at)
    values (public.hash_invite_code(code), left(coalesce(p_label, ''), 100), lower(nullif(trim(p_email), '')), auth.uid(), expires)
    returning id into created;
  insert into public.audit_log (actor, action, target) values (auth.uid(), 'invite.created', created::text);
  return jsonb_build_object('id', created, 'code', code, 'expiresAt', expires);
end;
$$;

create function public.admin_list_invites() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', i.id, 'label', i.label, 'lockedEmail', i.locked_email, 'createdAt', i.created_at, 'expiresAt', i.expires_at,
      'revokedAt', i.revoked_at, 'claimedAt', i.claimed_at, 'claimedBy', u.email
    ) order by i.created_at desc)
    from public.invite_codes i left join auth.users u on u.id = i.claimed_by
  ), '[]'::jsonb);
end;
$$;

create function public.admin_revoke_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.invite_codes set revoked_at = now() where id = p_invite and claimed_at is null and revoked_at is null;
  if not found then
    raise exception 'That code has already been used or revoked';
  end if;
  insert into public.audit_log (actor, action, target) values (auth.uid(), 'invite.revoked', p_invite::text);
end;
$$;

create function public.admin_list_members() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'userId', m.user_id, 'email', u.email, 'status', m.status, 'joinedAt', m.joined_at, 'removedAt', m.removed_at,
      'usedBytes', m.used_bytes, 'admin', exists (select 1 from public.admins a where a.user_id = m.user_id)
    ) order by m.joined_at desc)
    from public.members m join auth.users u on u.id = m.user_id
  ), '[]'::jsonb);
end;
$$;

-- Admins can't be removed from here, so a stolen admin session can't lock the owner out.
create function public.admin_set_member_status(p_user uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if p_status not in ('active', 'removed') then
    raise exception 'Unknown status';
  end if;
  if exists (select 1 from public.admins where user_id = p_user) then
    raise exception 'Admins can only be changed in the database';
  end if;
  update public.members
    set status = p_status, removed_at = case when p_status = 'removed' then now() end
    where user_id = p_user;
  if not found then
    raise exception 'That member does not exist';
  end if;
  insert into public.audit_log (actor, action, target) values (auth.uid(), 'member.' || p_status, p_user::text);
end;
$$;

create function public.admin_list_audit(p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return coalesce((
    select jsonb_agg(row_to_json(entries)::jsonb)
    from (
      select id, at, actor, action, target from public.audit_log order by id desc limit least(greatest(p_limit, 1), 500)
    ) entries
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Account deletion, for the person themselves
-- ---------------------------------------------------------------------------------------------------------------

-- Every record cascades from auth.users. Admins are refused, so the site can't be left with no one in charge by accident.
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if exists (select 1 from public.admins where user_id = me) then
    raise exception 'Admin accounts can only be deleted in the database';
  end if;
  insert into public.audit_log (actor, action) values (me, 'member.deleted');
  delete from auth.users where id = me;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Owner setup. Only runnable from the SQL editor. There is deliberately no way to reach this from the app.
-- ---------------------------------------------------------------------------------------------------------------

create function public.grant_admin(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  target uuid;
begin
  select id into target from auth.users where lower(email) = lower(p_email);
  if target is null then
    raise exception 'No account has that email. Create it under Authentication first.';
  end if;
  insert into public.members (user_id) values (target) on conflict (user_id) do update set status = 'active', removed_at = null;
  insert into public.admins (user_id) values (target) on conflict do nothing;
  insert into public.audit_log (action, target) values ('admin.granted', target::text);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Who can call what. Functions are public by default, so that is removed from all of them first.
-- ---------------------------------------------------------------------------------------------------------------

revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function public.is_member(), public.is_admin(), public.my_access(), public.delete_my_account() to authenticated;
grant execute on function
  public.admin_create_invite(text, text, integer),
  public.admin_list_invites(),
  public.admin_revoke_invite(uuid),
  public.admin_list_members(),
  public.admin_set_member_status(uuid, text),
  public.admin_list_audit(integer)
  to authenticated;

-- Only the redeem-invite server function uses these.
grant execute on function
  public.allow_redeem_attempt(text),
  public.claim_invite(text, text),
  public.release_invite(uuid),
  public.complete_invite(uuid, uuid)
  to service_role;
