-- Lets an admin tidy the code list. Only codes that can never work again go: used codes stay, as the record of who joined how,
-- and so do unused ones still in date. The audit log keeps the fact that each one existed.
create function public.admin_clear_old_invites() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  cleared integer;
begin
  perform public.require_admin();
  delete from public.invite_codes
    where claimed_at is null and (revoked_at is not null or expires_at <= now());
  get diagnostics cleared = row_count;
  if cleared > 0 then
    insert into public.audit_log (actor, action, detail) values (auth.uid(), 'invite.cleared', jsonb_build_object('count', cleared));
  end if;
  return cleared;
end;
$$;

revoke all on function public.admin_clear_old_invites() from public, anon, authenticated;
grant execute on function public.admin_clear_old_invites() to authenticated;
