-- =============================================================================
-- public.set_pull_state — ABSENT MEANS LEAVE ALONE, and a deliberate clear.
--
-- NO MIGRATION NUMBER APPEARS IN THIS FILE, by name or in its text. The
-- coordinator assigns it at landing.
--
-- CONTENTS
--   1. public.set_pull_state   wholesale-props-overwrite repair + clear flag
--
-- This is the same defect class as the `set_work_state` note wipe repaired in
-- the absent-means-merge batch, in a second RPC that batch did not reach. Its
-- own text stated the class in fully general terms — "any field the caller did
-- not mention is written as null over the stored value" — and repaired three
-- functions; this one sits in an earlier migration the author did not revisit.
--
-- =============================================================================
-- WHAT IS WRONG
-- =============================================================================
-- The live definition (superseding the 007-era one; identical argument types, so
-- `create or replace` genuinely replaced rather than creating an overload —
-- verified as ONE overload, pronargs 5, from pg_proc on an applied chain) ends:
--
--     on conflict(src_id,dst_id,type) do update set props=excluded.props, ...
--
-- `excluded.props` is rebuilt from the arguments. SIX keys are written:
-- localId, pinnedVersion, pulledAt, projection, projectionHash,
-- sourceActivityAt. FIVE of those six are recomputed from REQUIRED inputs on
-- every call — the pinned version, now(), and the projection lookup. `localId`
-- is the ONLY key a caller can decline to mention, so it is the only key the
-- wholesale overwrite can destroy. That is exactly the shape the note wipe had.
--
-- =============================================================================
-- ⚠ AND WHAT IS *NOT* WRONG — THE DATA LOSS IS NOT REACHABLE TODAY
-- =============================================================================
-- A data-loss finding was filed against this function and then WITHDRAWN on its
-- own duo's disproof. Driven against a real Server on the landed chain:
--
--     pull 1  --local-id MY-LOCAL-CHECKOUT   exit 0, stored
--     pull 2  omit --local-id                exit 2, 400 invalid_input
--     pull 3  --local-id none                exit 2, 400 invalid_input
--     raw HTTP, both forms                   same 400
--     props.pulledAt BYTE-IDENTICAL across all attempts
--
-- `pulledAt` is in the same props object, so ANY landed write moves it. It did
-- not move: the transaction never committed. THERE IS NO DATA LOSS.
--
-- The refusal is a TRIGGER, not the handler and not the DTO. The edge-props
-- validator raises `edge % property % has the wrong type` (SQLSTATE 22023 →
-- 400) when a prop key is PRESENT and its type does not match the registered
-- `edge_types.props_schema`. `jsonb_build_object('localId', p_local_id)` with a
-- NULL emits THE KEY PRESENT WITH JSON NULL — key exists, type wrong, raise.
--
-- The per-edge-type nullability table decides which way this defect expresses:
--     working_on  'note'    → ['string','null']   NULL ADMITTED  → overwrite LANDS → silent destroy
--     pulled      'localId' → 'string'            NULL REFUSED   → overwrite ABORTS → loud 400
-- ONE defect, two symptoms, decided entirely by that declaration.
--
-- ⚠ SO THE STRICTNESS IS THE ONLY THING CURRENTLY PROTECTING THE DATA, AND THE
-- OBVIOUS "FIX" ELSEWHERE WOULD SPRING A TRAP: relaxing `pulled.localId` to
-- ['string','null'] would match the contract (localId is
-- `.nullable().optional()`), match the `note` line two rows above it, look like
-- alignment — AND CONVERT THE LOUD 400 INTO THE NOTE WIPE, RE-CREATED. The
-- refusal and the data loss are the same mechanism seen from two sides.
--
-- =============================================================================
-- ⚠⚠ WHY THIS MIGRATION CHANGES NO SCHEMA AND NO TRIGGER — READ BEFORE "TIDYING"
-- =============================================================================
-- The validator fires only when `new.props ? property.key` — WHEN THE KEY IS
-- PRESENT. So "this pull has no local id" is representable WITHOUT a JSON null:
-- OMIT THE KEY. Every case below then satisfies the EXISTING 'string' schema.
--
--     absent + a stored value   → key set to the STORED string   → PRESERVED
--     absent + no stored value  → key OMITTED                    → accepted
--     explicit clear            → key REMOVED                    → CLEARED
--     a value                   → key set to that value          → REPLACED
--
-- THEREFORE: no `edge_types` update, no props_schema relaxation, no widening of
-- validation for any type, and the trap above is NEVER APPROACHED. `pulled` and
-- `tracks` keep `'localId' → 'string'` exactly as registered.
-- The API surface is unchanged by choosing absence over null: the read path
-- already publishes a missing key as null (`(props.localId as string | null |
-- undefined) ?? null`), so a cleared local id reads as null either way.
--
-- ⚠ AND THIS ALSO REPAIRS A CASE NOBODY FILED: a FIRST pull that never supplied
-- a local id emitted `localId: null` and was refused too, so `--local-id` was
-- effectively MANDATORY despite being optional in the contract. That is the
-- same trigger, on the insert path, and omitting the key fixes it.
--
-- =============================================================================
-- WHY DROPPED AND RECREATED, AND WHY THE GRANT IS NOT HOUSEKEEPING
-- =============================================================================
-- Adding p_clear_local_id changes the signature, and `create or replace` with a
-- new argument list creates an OVERLOAD rather than replacing. Both would then
-- exist; the five-argument call the server issues today would keep resolving to
-- the DESTRUCTIVE body, and the repair would be silently inert. The old
-- signature is therefore dropped explicitly.
--
-- ⚠ DROPPING DISCARDS THE ACL, AND THIS FUNCTION'S ACL DOES NOT COME FROM ITS
-- OWN MIGRATION. It was never named in a grant statement: it inherited EXECUTE
-- from a BLANKET `grant execute on all functions in schema public to tm8_app`
-- issued at the RLS-policies migration, which ran ONCE, long before this file.
-- A function created here is NOT covered by it. Without the explicit grant
-- below, `tm8_app` loses EXECUTE and EVERY `entities.commands.pull` fails with
-- permission denied — a total outage of the operation this migration repairs.
-- The grant is restored to exactly that shape: EXECUTE to tm8_app, PUBLIC none.
--
-- =============================================================================
-- DELIBERATELY NOT CHANGED
-- =============================================================================
--   * `pulled` / `tracks` props_schema — see above. Not widened.
--   * `tracks.localId` is the same 'string' shape, and nothing writes a
--     nullable local id to a `tracks` edge, so there is nothing to repair
--     there. Widening it would be validation loosened for a capability nobody
--     has asked for.
--   * `pulledAt` still moves on every transition. "When did the CURRENT pull
--     happen" is a defensible reading and changing it is scope this file was
--     not given.
--   * `props.workStatus` is read by the DTO and written by NO function in the
--     chain, so it is always null. Recorded, not fixed: there is nothing to
--     preserve, and inventing a writer is not this file's business.
-- =============================================================================

set role tm8_graph_owner;

drop function if exists public.set_pull_state(uuid, integer, text, uuid, text);

create or replace function public.set_pull_state(
  p_entity_id uuid, p_pinned_version integer, p_local_id text default null,
  p_actor_id uuid default null, p_client_mutation_id text default null,
  p_clear_local_id boolean default false
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; edge_id uuid; projection jsonb; source_changed_at timestamptz;
begin
  replay := internal.ledger_replay(p_client_mutation_id,'entities.commands.pull'); if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id); perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id,e.space_id); perform internal.bind_actor(actor);
  if p_pinned_version<1 or p_pinned_version>e.version then
    raise exception 'pinned version % is not a version of this entity',p_pinned_version using errcode='22023';
  end if;
  select snapshot,changed_at into projection,source_changed_at from public.entity_versions
   where entity_id=p_entity_id and version=p_pinned_version;
  if projection is null and p_pinned_version=e.version then
    projection := internal.entity_snapshot(p_entity_id); source_changed_at := e.updated_at;
  end if;
  if projection is null then raise exception 'pinned version is no longer retained' using errcode='P0002'; end if;

  -- The five recomputed keys are built unconditionally. `localId` is appended
  -- ONLY when it has a value, so an absent local id is a MISSING KEY rather
  -- than a JSON null the registered 'string' schema would refuse.
  insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
  values(e.space_id,actor,p_entity_id,'pulled',
    jsonb_build_object(
      'pinnedVersion',p_pinned_version,'pulledAt',now(),
      'projection',projection,'projectionHash',md5(projection::text),
      'sourceActivityAt',source_changed_at)
    || case
         when p_clear_local_id or p_local_id is null then '{}'::jsonb
         else jsonb_build_object('localId',p_local_id)
       end,
    actor)
  on conflict(src_id,dst_id,type) do update
    -- THE MERGE. `excluded.props` is stripped of localId and the key is then
    -- re-added from the three-way decision: an explicit clear wins; otherwise
    -- an absent argument falls back to the STORED value; otherwise the supplied
    -- value replaces it. `public.edges.props` is the PRE-UPDATE row.
    set props = (excluded.props - 'localId')
                || case
                     when p_clear_local_id then '{}'::jsonb
                     when coalesce(p_local_id, public.edges.props ->> 'localId') is null then '{}'::jsonb
                     else jsonb_build_object('localId',
                            coalesce(p_local_id, public.edges.props ->> 'localId'))
                   end,
        updated_at = now()
  returning id into edge_id;

  return internal.ledger_record(p_client_mutation_id,'entities.commands.pull',
    internal.command_result(p_entity_id,edge_id,
      internal.record_activity(e.space_id,p_entity_id,actor,'pulled',edge_id,
        jsonb_build_object('pinnedVersion',p_pinned_version,'projectionHash',md5(projection::text))),array[p_entity_id]));
end
$$;

-- DROP discarded the ACL, and the blanket grant that originally covered this
-- function ran many migrations ago and cannot cover a function created here.
-- Restore it exactly: EXECUTE to tm8_app, PUBLIC none.
revoke all on function public.set_pull_state(uuid,integer,text,uuid,text,boolean) from public;
grant execute on function public.set_pull_state(uuid,integer,text,uuid,text,boolean) to tm8_app;

comment on function public.set_pull_state(uuid,integer,text,uuid,text,boolean) is
  'Pin an entity projection. ABSENT MEANS LEAVE ALONE: a re-pin that does not '
  'mention localId preserves the stored one rather than overwriting the whole '
  'props object. Pass p_clear_local_id => true to clear it deliberately. A '
  'cleared or never-supplied localId is represented by the KEY BEING ABSENT, '
  'not by a JSON null, because the registered edge props_schema types localId '
  'as string and the validator rejects a present key of the wrong type -- so '
  'this repair needs no schema change. pulledAt deliberately keeps its prior '
  'semantics and moves on every pull.';

reset role;
