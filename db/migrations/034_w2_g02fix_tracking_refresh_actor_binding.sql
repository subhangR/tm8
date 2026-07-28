-- =============================================================================
-- W2.G02-FIX — a tracking.refresh that spans more than one Space must not be
--              refused by its own previous loop iteration.
--
-- WHAT THIS FILE SUPERSEDES (forward-only; the original is left byte-identical
-- because db/migrate.mjs checksums every applied migration and hard-fails on
-- drift — "A migration is immutable once applied. Add a new file"):
--
--   * public.queue_tracking_refresh  supersedes
--     017_w2_entities_commands_tracking.sql:627
--
-- Read that site together with this file: the text still in 017 is the BROKEN
-- version and is no longer live once this migration is applied. This file
-- redefines exactly ONE pre-existing object and creates none.
--
-- THE DEFECT
--
--   public.queue_tracking_refresh fans out over the caller's Space memberships
--   and, inside the loop, ran
--
--       actor := internal.resolve_actor(p_actor_id, row_value.space_id);
--       perform internal.bind_actor(actor);
--
--   internal.bind_actor (007_rpc_catalog.sql:867) is
--
--       select set_config('tm8.actor_id', coalesce(p_actor::text,''), true)
--
--   and that third argument is is_local — the write is TRANSACTION-scoped, so
--   it survives into every later iteration. internal.resolve_actor
--   (002_identity.sql:277) is
--
--       coalesce(requested, internal.actor_id(), internal.current_member_id(space))
--
--   followed by a can_act_as(actor, space) check. So for an ordinary caller,
--   who supplies no p_actor_id and enters with tm8.actor_id unbound:
--
--     iteration 1, Space A — the coalesce falls through to
--       current_member_id(A) and yields A's member id; bind_actor writes it.
--     iteration 2, Space B — the coalesce now SHORT-CIRCUITS on
--       internal.actor_id(), which is A's member id, and never reaches
--       current_member_id(B). A member row belongs to ONE Space, so
--       can_act_as(memberA, B) is false and the function raises 42501, which
--       the facade maps to 403.
--
--   Iteration 1 poisons iteration 2. Every caller who belongs to two or more
--   Spaces is refused, including a Space's own owner, and because the
--   exception aborts the transaction iteration 1's queued row rolls back too.
--   A single-Space caller never sees it.
--
--   This is precisely the hazard the facade documents and avoids per-request at
--   packages/server/src/facade/context.ts:1-25 ("a globally-bound actor from
--   space A, used on a request touching space B, fails can_act_as and raises
--   42501 ... for the space's own owner"). queue_tracking_refresh reintroduced
--   it per-loop-iteration.
--
-- THE FIX, AND WHY IT IS SHAPED THIS WAY
--
--   Restore the ENTRY-STATE tm8.actor_id claim before each resolve, so every
--   iteration resolves from the same starting point the first one did, and
--   restore it once more after the loop so the binding cannot leak past this
--   function into the rest of the transaction.
--
--   Restoring the entry state — rather than clearing the claim, or resolving
--   from current_member_id unconditionally — is what keeps the AUTHORIZATION
--   half intact:
--
--     * Ordinary caller: entry state is unbound, so each iteration reaches
--       current_member_id(space) and gets the correct per-Space member row.
--       This is what current_member_id is for.
--     * Acting-as caller: the facade binds tm8.actor_id AND passes the same id
--       as p_actor_id (context.ts:55-66, refreshTracking). p_actor_id is the
--       first argument of the coalesce, so it still wins in EVERY iteration and
--       is still put through can_act_as for EVERY Space. An actor that is only
--       valid in Space A is therefore still refused the moment the fan-out
--       reaches Space B — which is correct, and is deliberately pinned by a
--       test, because it is the case a careless fix turns into a bypass.
--
--   No authorization check is removed, weakened, or skipped. resolve_actor is
--   still called once per Space, and can_act_as still gates every iteration.
--
--   internal.bind_actor(actor) is KEPT inside the loop. It is not load-bearing
--   for this function's INSERT — public.tracking_refresh_requests
--   (006_execution_side.sql:160) carries no trigger, its defaults are
--   internal.new_id()/'queued'/now(), requested_by is supplied explicitly from
--   internal.current_member_id, and 008_rls_policies.sql:201 is a SELECT-only
--   policy TO tm8_app while this function is SECURITY DEFINER — but it is kept
--   so the per-Space actor is bound around the INSERT for anything added there
--   later. The change is purely additive: two restores, no deletion.
--
-- THE ONE BEHAVIOURAL DELTA, STATED PLAINLY
--
--   internal.ledger_record (012_ledger_reserve_cmid.sql:129) writes
--   command_ledger.actor_id from internal.actor_id(). It is the only reader of
--   the binding downstream of the loop. Because the post-loop restore returns
--   the claim to its entry state, an ordinary caller's tracking.refresh now
--   records actor_id = NULL there instead of the last iteration's per-Space
--   member id. That is the honest value: a fan-out spanning N Spaces has no
--   single actor, and the old value was an artefact of the leak this migration
--   closes. It is safe for replay because 031's header (lines 86-94) states
--   that replay pins identity_id ONLY, never actor_id, and names "a background
--   retry with no tm8.actor_id bound" as a legitimate case that an exact actor
--   comparison would wrongly refuse. An acting-as caller is unaffected: the
--   entry state IS the requested actor, so the restore is a no-op for them.
-- =============================================================================
set role tm8_graph_owner;

create or replace function public.queue_tracking_refresh(
  p_entity_ids uuid[] default '{}'::uuid[], p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; row_value record; requester uuid; actor uuid; request_id uuid; request_ids uuid[] := '{}';
  -- The tm8.actor_id claim exactly as the caller entered with it: '' when
  -- unbound, the requested actor when acting-as. internal.claim_text returns
  -- null for a blank claim, hence the coalesce. tm8.acting_as is a separate
  -- claim this function never writes, so it is preserved on its own.
  entry_actor text := coalesce(internal.claim_text('tm8.actor_id'),'');
  normalized uuid[] := array(select distinct value from unnest(coalesce(p_entity_ids,'{}'::uuid[])) value order by value);
begin
  replay := internal.ledger_replay(p_client_mutation_id,'tracking.refresh'); if replay is not null then return replay; end if;
  if cardinality(normalized)>0 and exists(
    select 1 from unnest(normalized) requested
    left join public.entities e on e.id=requested and e.deleted_at is null and e.kind in ('pull_request','commit')
    where e.id is null or not internal.is_space_member(e.space_id)
  ) then
    raise exception 'tracking entity not found or not readable' using errcode='P0002';
  end if;
  for row_value in
    select memberships.space_id,
      case when cardinality(normalized)=0 then null::uuid[]
           else array_agg(e.id order by e.id) end entity_ids
      from public.members memberships
      left join public.entities e on cardinality(normalized)>0 and e.id=any(normalized)
                                 and e.space_id=memberships.space_id
     where memberships.identity_id=internal.identity_id()
       and (cardinality(normalized)=0 or e.id is not null)
     group by memberships.space_id
     order by memberships.space_id
  loop
    -- THE FIX. Without this, the previous iteration's per-Space member id is
    -- still bound and short-circuits resolve_actor's coalesce below, so this
    -- Space is authorized against the PREVIOUS Space's actor and refused.
    perform set_config('tm8.actor_id',entry_actor,true);
    requester := internal.current_member_id(row_value.space_id);
    actor := internal.resolve_actor(p_actor_id,row_value.space_id); perform internal.bind_actor(actor);
    insert into public.tracking_refresh_requests(space_id,requested_by,entity_ids)
    values(row_value.space_id,requester,row_value.entity_ids) returning id into request_id;
    request_ids := request_ids || request_id;
  end loop;
  -- Leave the transaction's claim as this function found it: a per-Space actor
  -- must not escape a call that deliberately spans Spaces.
  perform set_config('tm8.actor_id',entry_actor,true);
  if cardinality(request_ids)=0 then raise exception 'no readable Space to refresh' using errcode='42501'; end if;
  return internal.ledger_record(p_client_mutation_id,'tracking.refresh',jsonb_build_object(
    'accepted',true,'status','queued','requestIds',request_ids));
end
$$;

comment on function public.queue_tracking_refresh(uuid[],uuid,text) is
  'Queues one provider-refresh request per Space the caller belongs to. '
  'Restores the entry-state tm8.actor_id claim before each iteration resolves '
  'its actor: internal.bind_actor writes the claim transaction-locally, and '
  'internal.resolve_actor''s coalesce would otherwise short-circuit on the '
  'previous Space''s member id and refuse every caller who belongs to two or '
  'more Spaces. Supersedes 017_w2_entities_commands_tracking.sql:627.';

reset role;
