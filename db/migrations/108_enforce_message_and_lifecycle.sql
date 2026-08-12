-- =============================================================================
-- 108 — enforce the second byte path, and session lifecycle (2026-08-12).
--
-- 107 closed the WebSocket path into a running agent. There are TWO, and this
-- closes the other: posting a message anchored on — or @-mentioning — a session
-- delivers it to that session's stdin, gated on space membership alone. It also
-- gates terminate/resume/rename, which any space member can do today.
--
-- ── CARVE-OUT ONE: REPLIES ARE NOT GATED ──────────────────────────────────
--
-- A REPLY route targets the session that authored the message being answered.
-- Gating it on `converse` would 403 anyone replying in a channel thread to
-- anything an agent said — a catastrophic break on the most-used surface in the
-- product.
--
-- The rule: a capability is required for CALLER-INITIATED delivery, not for
-- conversational reciprocity. A session that spoke into a conversation has
-- consented to be answered in that conversation, and the `authored_from` edge
-- is the durable evidence of that consent.
--
-- So anchor and mention targets are checked; reply targets are not.
--
-- ── CARVE-OUT TWO: THE TRANSITION IS SPLIT, NOT GATED ─────────────────────
--
-- `work_session_transition` has two caller classes. The PTY lifecycle sink runs
-- under the spawner's captured claims (that is the owner, fine). But
-- `reconcileNodeGhosts` runs under the NODE OWNER's identity, deliberately,
-- because that path has no node-admin bypass — and the node owner is generally
-- not the session owner.
--
-- A blanket `manage` gate would therefore strand ghost reconciliation and leave
-- sessions pinned at `running` forever, counting against the concurrency cap.
-- So:
--
--   running / idle    → require_space_member, as today. These are activity
--                       REPORTS; they cannot read or inject a single byte.
--   exited / failed   → require `manage`. These are the ones that matter,
--                       because once 072's liveness clause is restored they
--                       revoke the session's agent credential.
--
-- ── HOW THE ROUTE RECORDER IS EDITED ──────────────────────────────────────
--
-- `w2_record_session_message_routes` is ~150 lines with three CTEs and a
-- conflict-repair loop. Retyping it to insert one block is how a subtle
-- difference gets introduced into a function that every `messages.post` runs.
-- So, as in 103: read the current definition, assert the anchor text is
-- present, inject before it, execute. The rest is preserved byte-for-byte.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. THE ROUTE GATE IS A TRIGGER, NOT A PATCHED FUNCTION.
--
-- The first attempt injected a check into `w2_record_session_message_routes` by
-- text surgery, as 103 does. It does not work here, for a reason worth writing
-- down: `pg_get_functiondef` returns a NORMALISED definition, so an anchor
-- taken from the migration source ("  for route_row in") does not exist in the
-- text you get back. 103's anchors survived because they were single tokens.
--
-- A trigger is better anyway. It is declarative, it reads as the rule it is,
-- and — unlike a patched function — it also covers any FUTURE writer of this
-- table. A second route recorder that forgot the check is exactly the bug this
-- migration exists to prevent.
--
-- CARVE-OUT ONE lives here: a REPLY route is recognised structurally, by the
-- target session having authored the message this copy answers (the
-- `authored_from` edge), and is let through ungated.
-- -----------------------------------------------------------------------------
create or replace function internal.gate_session_message_route() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  -- RECIPROCITY, not caller-initiated delivery. The target session authored the
  -- message being answered, so it has already spoken into this conversation.
  -- Gating this would 403 anyone replying in a thread to anything an agent said.
  if exists (
    select 1
      from public.entities me
      join public.edges origin
        on origin.src_id = me.parent_id and origin.type = 'authored_from'
     where me.id = new.target_message_id
       and origin.dst_id = new.target_work_session_id
  ) then
    return new;
  end if;

  -- Everything else — anchored on the session, or @-mentioning it — is the
  -- caller putting bytes into somebody's agent, and needs `converse`.
  perform internal.require_session_capability(new.target_work_session_id, 'converse');
  return new;
end
$$;

-- Created as the TABLE's owner: 019 defines this table after its own
-- `reset role`, so it belongs to `tm8` and `tm8_graph_owner` cannot add a
-- trigger to it. Same class of finding as the function ownership below, and
-- surfaced the same way — by the migration refusing rather than by inspection.
do $trg$
declare table_owner text;
begin
  select tableowner into table_owner
    from pg_tables where schemaname = 'public' and tablename = 'session_message_reply_routes';
  execute format('set role %I', table_owner);
  execute 'create trigger session_message_routes_gate
           before insert on public.session_message_reply_routes
           for each row execute function internal.gate_session_message_route()';
  execute 'set role tm8_graph_owner';
end
$trg$;

-- -----------------------------------------------------------------------------
-- 2. Lifecycle. These three are guard swaps, and their anchor DOES survive
--    normalisation, so the 103 technique applies.
--
--    OWNERSHIP: they do not all belong to `tm8_graph_owner`. 099 does
--    `reset role` before defining some of its functions, and 062/085 likewise,
--    so `execution_resume` and `rename_work_session` are owned by `tm8`.
--    Recreating a SECURITY DEFINER function under a different owner silently
--    changes what it can do, so each is recreated as its own owner. Found by
--    the migration refusing outright ("must be owner of function").
-- -----------------------------------------------------------------------------
-- Each patch is a self-contained DO block. An earlier draft factored this
-- into a helper function, which `w2-sec1b` correctly rejected: the migration
-- DECLARED an object and then dropped it, and that suite verifies every object
-- a migration declares is present afterwards. Declaring nothing is simpler than
-- explaining an exception to it.

do $p_execution_resume$
declare src text; fn_owner text; args text;
  anchor constant text := 'perform internal.require_space_member(e.space_id);';
begin
  select pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner), pg_get_function_arguments(p.oid)
    into src, fn_owner, args
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'execution_resume' and p.prokind = 'f';
  if src is null then raise exception 'public.execution_resume not found'; end if;
  if position('require_session_capability' in src) > 0 then
    raise exception 'public.execution_resume is already gated — 108 has been applied';
  end if;
  if position(anchor in src) = 0 then
    raise exception 'public.execution_resume no longer contains its expected anchor — re-derive 108';
  end if;
  -- The injected text names a parameter, and they are NOT all `p_session_id`:
  -- `rename_work_session` takes `p_entity_id`. Assuming otherwise produced a
  -- function that COMPILED and then failed at call time with "column
  -- p_session_id does not exist" — a much worse way to find out.
  if position('p_session_id uuid' in args) = 0 then
    raise exception 'public.execution_resume does not take p_session_id — re-derive 108';
  end if;
  execute format('set role %I', fn_owner);
  execute replace(src, anchor, anchor || E'\n  perform internal.require_session_capability(p_session_id, ''manage'');');
  execute 'set role tm8_graph_owner';
end
$p_execution_resume$;

do $p_rename_work_session$
declare src text; fn_owner text; args text;
  anchor constant text := 'perform internal.require_space_member(e.space_id);';
begin
  select pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner), pg_get_function_arguments(p.oid)
    into src, fn_owner, args
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'rename_work_session' and p.prokind = 'f';
  if src is null then raise exception 'public.rename_work_session not found'; end if;
  if position('require_session_capability' in src) > 0 then
    raise exception 'public.rename_work_session is already gated — 108 has been applied';
  end if;
  if position(anchor in src) = 0 then
    raise exception 'public.rename_work_session no longer contains its expected anchor — re-derive 108';
  end if;
  -- The injected text names a parameter, and they are NOT all `p_session_id`:
  -- `rename_work_session` takes `p_entity_id`. Assuming otherwise produced a
  -- function that COMPILED and then failed at call time with "column
  -- p_session_id does not exist" — a much worse way to find out.
  if position('p_entity_id uuid' in args) = 0 then
    raise exception 'public.rename_work_session does not take p_entity_id — re-derive 108';
  end if;
  execute format('set role %I', fn_owner);
  execute replace(src, anchor, anchor || E'\n  perform internal.require_session_capability(p_entity_id, ''manage'');');
  execute 'set role tm8_graph_owner';
end
$p_rename_work_session$;

do $p_work_session_transition$
declare src text; fn_owner text; args text;
  anchor constant text := 'perform internal.require_space_member(e.space_id);';
begin
  select pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner), pg_get_function_arguments(p.oid)
    into src, fn_owner, args
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'work_session_transition' and p.prokind = 'f';
  if src is null then raise exception 'public.work_session_transition not found'; end if;
  if position('require_session_capability' in src) > 0 then
    raise exception 'public.work_session_transition is already gated — 108 has been applied';
  end if;
  if position(anchor in src) = 0 then
    raise exception 'public.work_session_transition no longer contains its expected anchor — re-derive 108';
  end if;
  -- The injected text names a parameter, and they are NOT all `p_session_id`:
  -- `rename_work_session` takes `p_entity_id`. Assuming otherwise produced a
  -- function that COMPILED and then failed at call time with "column
  -- p_session_id does not exist" — a much worse way to find out.
  if position('p_session_id uuid' in args) = 0 then
    raise exception 'public.work_session_transition does not take p_session_id — re-derive 108';
  end if;
  execute format('set role %I', fn_owner);
  execute replace(src, anchor, anchor || $inject$
  -- CARVE-OUT TWO. `running`/`idle` are activity REPORTS and stay member-gated:
  -- they cannot read or inject a byte, and `reconcileNodeGhosts` runs under the
  -- NODE OWNER's identity by design — a blanket gate there would strand ghost
  -- reconciliation and pin the concurrency cap forever. `exited`/`failed` end
  -- the session and revoke its credential, so those need `manage`.
  if p_status in ('exited','failed') then
    perform internal.require_session_capability(p_session_id, 'manage');
  end if;
$inject$);
  execute 'set role tm8_graph_owner';
end
$p_work_session_transition$;

-- -----------------------------------------------------------------------------
-- 3. terminate and prompt. Short enough to state in full, and both are byte
--    paths into a live agent that today need only space membership.
-- -----------------------------------------------------------------------------
create or replace function public.record_execution_command(
  p_session_id uuid, p_operation text, p_payload jsonb default '{}'::jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
begin
  if p_operation not in ('execution.prompt','execution.terminate') then
    raise exception 'unsupported execution command: %', p_operation using errcode = '22023';
  end if;
  replay := internal.ledger_replay(p_client_mutation_id, p_operation);
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if p_operation = 'execution.terminate' then
    perform internal.require_session_capability(p_session_id, 'manage');
  else
    perform internal.require_session_capability(p_session_id, 'converse');
  end if;
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  return internal.ledger_record(p_client_mutation_id, p_operation,
           internal.command_result(p_session_id, null, null, array[p_session_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- Guard: the four gated functions plus the trigger must all be in place.
--
-- NOT included: a belt-and-braces check inside
-- `reserve_session_message_delivery` that the route row exists. The trigger
-- above makes an unauthorised route IMPOSSIBLE TO CREATE, which is the stronger
-- guarantee (prevention rather than detection), so the reserve-side check is a
-- second layer rather than the layer. It is deferred deliberately, not missed:
-- its `require_delivery_principal(` call spans lines in the normalised
-- definition and needs an anchor this migration does not have a clean one for.
-- -----------------------------------------------------------------------------
do $verify$
declare ungated text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into ungated
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.prokind = 'f'
     and p.proname in ('execution_resume','rename_work_session',
                       'work_session_transition','record_execution_command')
     and pg_get_functiondef(p.oid) not like '%require_session_capability%';
  if ungated is not null then
    raise exception '108 left these ungated: %', ungated;
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'session_message_routes_gate' and not tgisinternal) then
    raise exception '108 did not install the route gate trigger';
  end if;
end
$verify$;

reset role;
