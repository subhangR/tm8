-- =============================================================================
-- 041  W2.SEC-1 STAGE 2 — the replay RESOURCE binding at
--                         public.record_execution_command, the class-D site the
--                         enumeration could not enumerate.
--
-- WHY THIS SITE IS ABSENT FROM TM8-SEC1-STAGE2-ENUMERATION.md
--
--   Every other ledger_replay caller names its operation label as a LITERAL.
--   This one takes it as a PARAMETER:
--
--       internal.ledger_replay(p_client_mutation_id, p_operation)
--
--   constrained to ('execution.prompt','execution.terminate'). The enumeration's
--   extraction reads literal second arguments, so it could not resolve this
--   caller's label and DROPPED IT rather than reporting it. The document's
--   98-caller total is therefore CORRECT while its 63-label table and its §7.2
--   class-D work list are each short by this site — internally consistent, and
--   unusable for anyone working the list to exhaustion. Two v1 contract
--   operations (contract/src/catalog.ts:134-135) appear nowhere in it.
--
--   ONE FUNCTION, TWO LABELS. It is a door onto BOTH. The labels do not leak into
--   each other — a cmid recorded under execution.prompt and replayed under
--   execution.terminate is refused by ledger_replay's own operation check,
--   measured — so this is two single-door labels sharing one body, not a
--   two-door label. No sibling door exists for either:
--   internal.w2g12_catalog_operation mentions both strings but does NOT call
--   ledger_replay, so it is not a door. Measured from pg_catalog, not grepped.
--
-- THE DEFECT, DRIVEN AT THE SQL LAYER ON THE APPLIED CHAIN
--
--   Same principal throughout, one identity owning two spaces:
--     record a cmid via record_execution_command naming SESSION A (space A)
--     replay the same cmid naming SESSION B (space B)
--       -> returned SESSION A's projection: entity id A, space_id A.
--   The caller named B and received A. `internal.live_entity` and
--   `internal.require_space_member` sit BELOW the replay return, so the replay
--   path never reaches them. 033's principal pin does not fire because the
--   principal is genuinely the same — that is what class D means.
--
--   NOT driven through HTTP. The site is HTTP-reachable —
--   facade/execution-handlers.ts:302 passes the caller's own sessionId and
--   clientMutationId straight into this RPC — but this migration's evidence is
--   at the SQL layer as tm8_app, and that boundary is stated rather than blurred.
--
-- THE SUBJECT EXPRESSION, read from this site's OWN ledger_record call
--
--   It stores internal.command_result(p_session_id, null, null, array[p_session_id]),
--   whose projection carries {entity,id} = the work session id. So the binding is
--   {entity,id} against p_session_id — the same shape as 038's eleven doors, NOT
--   036's {entity,space_id}-against-p_space_id. There is no p_space_id argument
--   here; the space is derived from the entity, below the replay branch.
--
-- ON THE DOUBLED PRINCIPAL PIN — same note as 038, kept deliberately
--
--   Both internal.require_replay_principal calls are REDUNDANT on this chain:
--   033 moved the principal comparison INSIDE internal.ledger_replay, under the
--   advisory lock, in a stronger fail-closed form. They are here because 031, 032,
--   036 and 038 all ship exactly this shape, and one idiom that a reviewer can
--   diff against its siblings is worth more than two lines saved.
--
-- LOWERCASE, DELIBERATELY, AND THIS IS A CORRECTION OF MY OWN PRIOR PRACTICE
--
--   038 and 040 were GENERATED from pg_get_functiondef and are therefore the only
--   files in a 37-file chain whose function definitions are UPPERCASE — 12 of 383
--   definitions, against 371 lowercase across 31 files. A case-sensitive keyword
--   sweep written in the chain's own dominant convention returns 371 and misses
--   exactly the eleven entities.patch doors 038 had just bound. THE CORPUS became
--   blind by authorial convention. 038 and 040 are applied and immutable and must
--   not be cosmetically rewritten to fix it — a hash that carries verification is
--   not rotated to tidy a convention. This file is short enough to hand-write and
--   verify by full-catalog diff, so it rejoins the corpus convention instead of
--   widening the anomaly. `-i` remains required on any SQL keyword sweep.
--
-- NO IN-BODY COMMENT DESCRIBES THE REMOVED CODE, AND THAT IS DELIBERATE
--
--   039 carries an in-body comment quoting the condition it deleted, and
--   pg_get_functiondef RETURNS COMMENTS — so a substring detector reads that
--   comment as the code and reports the tightening as not landed. My own
--   post-landing check did exactly that. The body below therefore states what the
--   guard DOES and never quotes the unbound form it replaces.
-- =============================================================================

set role tm8_graph_owner;

create or replace function public.record_execution_command(
  p_session_id uuid, p_operation text, p_payload jsonb default '{}'::jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
begin
  if p_operation not in ('execution.prompt','execution.terminate') then
    raise exception 'unsupported execution command: %', p_operation using errcode = '22023';
  end if;
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, p_operation);
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD. The
    -- subject binding needs the stored projection, so it can only live here.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_session_id::text, 'work session');
    return replay;
  end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  return internal.ledger_record(p_client_mutation_id, p_operation,
           internal.command_result(p_session_id, null, null, array[p_session_id]));
end
$$;

reset role;
