-- =============================================================================
-- 270 (assigned by the credentials coordinator, which holds the sequence; it
-- follows 269_entity_action_facts, #935) — space_credential_usage: an
-- ownerless credential's usage is the admins' (fix reported by task 01a0e24d;
-- doc 01a0e257 "Finding").
--
-- A ONE-WORD CHANGE TO A SINGLE EXPRESSION IN 255. 255's usage door writes
--   if not (owner_account_id = current_account_id() or (... and admin))
-- On an ownerless row (space-owned, or a legacy unchosen row) the first term is
-- NULL. For a non-admin member the whole test is then `not NULL`, which is not
-- true, so the raise is skipped and ANY member reads the usage (session ids,
-- launcher account ids). The fix wraps that term in coalesce(..., false). The
-- body below is 255's EXACTLY apart from that.
--
-- It is deliberately NOT a reuse of can_manage_space_credential. That would
-- also drop a space admin's usage read on a PUBLIC OWNED credential, a second
-- tightening nobody asked for. The test pins both directions.
--
-- THE CLASS WAS CHECKED. 255 compares owner_account_id to the caller in three
-- places:
--   1. can_manage_space_credential: inside `case when owner_account_id is not
--      null then ...`, never NULL. Safe.
--   2. set_space_credential_default: in the `else` branch of
--      `if owner_account_id is null`, so never NULL. Safe.
--   3. space_credential_usage: the slip, fixed here.
-- No later migration redefines any of the three. A future sweep need not
-- re-audit them.
--
-- THIS TIGHTENS: a non-admin member (the creator included) loses the usage read
-- on an ownerless credential that the leaky text granted. Owners and admins
-- keep every read they had.
-- =============================================================================

create or replace function public.space_credential_usage(p_credential_id uuid, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; rows jsonb;
begin
  perform internal.require_human_auth_kind();
  select * into stored from public.space_credentials where id = p_credential_id;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if not (coalesce(stored.owner_account_id = internal.current_account_id(), false)
          or ((stored.visibility = 'public' or stored.owner_account_id is null)
              and internal.is_space_admin(stored.space_id))) then
    raise exception 'only the credential''s owner can see its usage' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(u.row order by u.recorded_at desc, u.work_session_id), '[]'::jsonb) into rows
    from (
      select ssc.recorded_at, ssc.work_session_id,
             jsonb_build_object(
               'workSessionId', ssc.work_session_id, 'provider', ssc.provider,
               'source', ssc.source, 'credentialId', ssc.space_credential_id,
               'ownerAccountId', ssc.owner_account_id,
               'launcherAccountId', ssc.launcher_account_id,
               'agentSessionId', ssc.agent_session_id, 'status', ws.status,
               'recordedAt', ssc.recorded_at, 'updatedAt', ssc.updated_at) as row
        from public.session_space_credentials ssc
        join public.work_sessions ws on ws.entity_id = ssc.work_session_id
       where ssc.space_credential_id = stored.id
       order by ssc.recorded_at desc, ssc.work_session_id
       limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) u;
  return jsonb_build_object('credentialId', stored.id, 'sessions', rows);
end
$$;
