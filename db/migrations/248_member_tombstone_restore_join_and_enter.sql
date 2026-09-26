-- =============================================================================
-- 248 — restore 232's member tombstone in the two functions 233 wrote against
-- pre-232 membership semantics (forward fix for #848; main 5132851d red).
--
-- 233 (W3-server) re-created public.join_public_space from 031's body, which
-- silently reverted 232 (G6): a REMOVED member walked back in through the
-- public door, and a member who LEFT was reported as already joined (no
-- reactivation). 233 also added public.enter_space, whose membership check
-- read public.members without 232's `status = 'active'`, so a member who left
-- or was removed could mint a session pinned to that space.
--
--   join_public_space  232's body (232:485) EXACTLY, plus 233's one intended
--                      change: a pinned caller may only join the space it is
--                      pinned to (42501 otherwise).
--   enter_space        233's body (233:114) EXACTLY, plus `m.status = 'active'`
--                      in the membership check. Grants re-stated as 233 did.
--
-- No row changes. Nothing else in 233 reads memberships (is_node_admin,
-- require_node_admin, issue_auth_session, consume_stream_attach, spaces_select
-- via member_space_ids(), which 232 already made active-only).
-- =============================================================================

set role tm8_graph_owner;

-- 232's join_public_space + 233's pin check.
create or replace function public.join_public_space(p_space_id uuid, p_client_mutation_id text default null::text)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  target public.spaces;
  member_id uuid;
  member_status text;
  existed boolean;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.redeem');
  if replay is not null then
    -- THE SECURITY BOUNDARY. internal.ledger_replay takes
    -- pg_advisory_xact_lock on the cmid and only then selects, so this call
    -- runs with that lock HELD and the recorded row guaranteed visible. The
    -- identical call before ledger_replay is a fast path, NOT the boundary:
    -- it runs unlocked and reads "not found" against a victim's still
    -- uncommitted row. See the TOCTOU note in 232's header (and 031's).
    perform internal.require_replay_principal(p_client_mutation_id);
    -- Also closes the shared-operation-string crossing: a redeem_invite cmid
    -- carries the invite's Space, which will not match the Space addressed here
    -- unless it is genuinely the same Space.
    perform internal.require_replay_subject(
      replay ->> 'spaceId', p_space_id::text, 'space');
    return replay;
  end if;
  identity := internal.require_identity();
  if nullif(current_setting('tm8.session_space_id', true), '')::uuid is distinct from p_space_id
     and nullif(current_setting('tm8.session_space_id', true), '') is not null then
    raise exception 'a space-pinned session cannot join another space' using errcode = '42501';
  end if;
  select * into target from public.spaces where id = p_space_id;
  if target.id is null then
    raise exception 'space not found' using errcode = 'P0002';
  end if;
  select entity_id, status into member_id, member_status from public.members
   where space_id = p_space_id and identity_id = identity;
  existed := member_id is not null and member_status = 'active';
  if not existed then
    if target.visibility <> 'public' then
      raise exception 'space is not public' using errcode = '42501';
    end if;
    -- 232: a member an admin REMOVED does not walk back in through the public
    -- door. An invite is the way back; leaving on your own is not a ban.
    if member_status = 'removed' then
      raise exception 'you were removed from this space: ask an admin for an invite'
        using errcode = '42501';
    end if;
    member_id := internal.attach_member(p_space_id, identity, 'member');
  end if;
  result := jsonb_build_object('spaceId', p_space_id, 'memberId', member_id, 'joined', not existed,
                               'patches', jsonb_build_array(internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.redeem', result);
end
$$;

-- 233's enter_space + 232's `status = 'active'`.
create or replace function public.enter_space(
  p_space_id uuid,
  p_parent_session_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  caller text;
  acct public.accounts;
  parent public.auth_sessions;
  new_kind text := 'browser';
  new_expiry timestamptz := p_expires_at;
  s public.auth_sessions;
begin
  caller := internal.require_identity();
  if nullif(current_setting('tm8.session_space_id', true), '') is not null then
    raise exception 'a space-pinned session cannot enter a space; use the gate session'
      using errcode = '42501';
  end if;
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli') then
    raise exception 'only a human session can enter a space' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'invalid space session credential' using errcode = '22023';
  end if;

  select a.* into acct
    from public.accounts a
   where a.identity_id = caller and a.status = 'active'
   order by a.is_owner desc, a.created_at
   limit 1;
  if acct.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;

  if p_parent_session_id is not null then
    select s0.* into parent
      from public.auth_sessions s0
     where s0.id = p_parent_session_id
       and s0.revoked_at is null
       and s0.expires_at > now()
       and s0.space_id is null
       and s0.kind in ('browser', 'cli');
    if parent.id is null then
      raise exception 'gate session not found' using errcode = '42501';
    end if;
    select a.* into acct from public.accounts a
     where a.id = parent.account_id and a.identity_id = caller and a.status = 'active';
    if acct.id is null then
      raise exception 'gate session not found' using errcode = '42501';
    end if;
    new_kind := parent.kind;
    new_expiry := least(p_expires_at, parent.expires_at);
  end if;

  -- Membership of the target, read directly (the caller is unpinned, so this
  -- is exactly `is_space_member`). Not-a-member and no-such-space answer the
  -- same so the call is not a space-existence oracle.
  if not exists (
    select 1 from public.members m
     where m.space_id = p_space_id and m.identity_id = caller
       and m.status = 'active'
  ) then
    raise exception 'not a member of that space' using errcode = '42501';
  end if;

  insert into public.auth_sessions(account_id, kind, token_hash, label, expires_at, space_id)
  values (acct.id, new_kind, p_token_hash, p_label, new_expiry, p_space_id)
  returning * into s;
  return to_jsonb(s) - 'token_hash';
end
$$;

revoke all on function public.enter_space(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.enter_space(uuid, uuid, text, timestamptz, text) to tm8_app;

-- VERIFY: both bodies carry 232's tombstone predicates and 233's pin check.
do $verify$
declare
  j text := (select prosrc from pg_proc where oid = 'public.join_public_space(uuid, text)'::regprocedure);
  e text := (select prosrc from pg_proc where oid = 'public.enter_space(uuid, uuid, text, timestamptz, text)'::regprocedure);
begin
  if j not like '%member_status = ''removed''%'
     or j not like '%member_id is not null and member_status = ''active''%'
     or j not like '%a space-pinned session cannot join another space%' then
    raise exception 'VERIFY 248: join_public_space lacks the 232 tombstone or the 233 pin check';
  end if;
  if e not like '%m.status = ''active''%' then
    raise exception 'VERIFY 248: enter_space admits an ended membership';
  end if;
end
$verify$;

reset role;
