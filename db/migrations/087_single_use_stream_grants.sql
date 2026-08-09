-- 087 — public WebSocket PTY grants are real, short-lived, and single-use.
--
-- BEFORE THIS MIGRATION, execution.streams.attach wrote a stream_grants row
-- with token_hash = null and the WebSocket upgrade called grant_stream_attach
-- again. The row was therefore an audit-shaped by-product, not a credential:
-- there was nothing to expire, consume, race, or replay-protect. Browser code
-- compensated by putting its long-lived auth session in the WebSocket URL.
--
-- AFTER THIS MIGRATION:
--   * grant_stream_attach requires a SHA-256 token hash and clamps the grant to
--     at most 60 seconds;
--   * consume_stream_attach matches exact session + mode + hash and, when an
--     authenticated cookie identity is present, exact identity as well;
--   * one UPDATE atomically marks the row revoked. Concurrent/replayed uses all
--     receive the same 42501 refusal and cannot distinguish expired, replayed,
--     wrong-session, wrong-mode, wrong-identity, or random credentials;
--   * only the random bearer leaves the server, exactly once. The database has
--     its hash and never the bearer value.

create unique index if not exists stream_grants_token_hash_live_idx
  on public.stream_grants(token_hash)
  where revoked_at is null and token_hash is not null;

create or replace function public.grant_stream_attach(
  p_session_id uuid, p_mode text default 'view', p_token_hash text default null,
  p_ttl interval default interval '30 seconds', p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  session public.work_sessions;
  identity text;
  grant_row public.stream_grants;
  effective_ttl interval;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid stream grant credential' using errcode = '22023';
  end if;

  effective_ttl := least(
    greatest(coalesce(p_ttl, interval '30 seconds'), interval '1 second'),
    interval '60 seconds'
  );

  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.streams.attach');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{grant,work_session_id}', p_session_id::text, 'work session');
    perform internal.require_replay_subject(
      replay #>> '{grant,mode}', coalesce(p_mode, 'view'), 'stream mode');
    return replay;
  end if;

  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  identity := internal.identity_id();
  select * into session from public.work_sessions where entity_id = p_session_id;

  if p_mode not in ('view','drive') then
    raise exception 'invalid stream mode' using errcode = '22023';
  end if;
  if session.share_mode = 'none'
     and e.created_by is distinct from internal.current_member_id(e.space_id)
     and not internal.can_act_as(e.created_by, e.space_id) then
    raise exception 'this session is not shared' using errcode = '42501';
  end if;
  if p_mode = 'drive' and not internal.can_act_as(e.created_by, e.space_id) then
    raise exception 'drive access is limited to the spawning owner in v1' using errcode = '42501';
  end if;

  insert into public.stream_grants(
    work_session_id, subject_identity, mode, granted_by, token_hash, expires_at
  ) values (
    p_session_id, identity, p_mode, e.created_by, p_token_hash, now() + effective_ttl
  )
  on conflict (work_session_id, subject_identity, mode) where revoked_at is null
  do update set
    token_hash = excluded.token_hash,
    expires_at = excluded.expires_at
  returning * into grant_row;

  return internal.ledger_record(
    p_client_mutation_id,
    'execution.streams.attach',
    jsonb_build_object('grant', to_jsonb(grant_row) - 'token_hash', 'patches', '[]'::jsonb)
  );
end
$$;

create or replace function public.consume_stream_attach(
  p_session_id uuid,
  p_mode text,
  p_token_hash text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  claim_identity text := nullif(current_setting('tm8.identity_id', true), '');
  consumed public.stream_grants;
begin
  -- All credential failures deliberately converge on the same branch. In
  -- particular, do not report whether a session, mode, hash, identity, expiry,
  -- or already-consumed row was the part that failed to match.
  if p_mode not in ('view','drive')
     or p_token_hash is null
     or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'stream attach refused' using errcode = '42501';
  end if;

  update public.stream_grants
     set revoked_at = now()
   where work_session_id = p_session_id
     and mode = p_mode
     and token_hash = p_token_hash
     and revoked_at is null
     and expires_at > now()
     and (claim_identity is null or subject_identity = claim_identity)
  returning * into consumed;

  if consumed.id is null then
    raise exception 'stream attach refused' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'subjectIdentity', consumed.subject_identity,
    'mode', consumed.mode,
    'grantId', consumed.id
  );
end
$$;

revoke all on function public.consume_stream_attach(uuid, text, text) from public;
grant execute on function public.consume_stream_attach(uuid, text, text) to tm8_app;

comment on function public.consume_stream_attach(uuid, text, text) is
  'Atomically consumes one short-lived hash-only PTY grant. Invalid, expired, '
  'replayed, cross-session, wrong-mode and wrong-identity credentials all fail '
  'with the same refusal.';
